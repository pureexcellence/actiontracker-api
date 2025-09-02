// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

/* ---------- Env & SSL handling ---------- */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("❌ Missing DATABASE_URL in .env");
  process.exit(1);
}

const url = new URL(connectionString);
const host = url.hostname || "";
const pgsslmode = (process.env.PGSSLMODE || "").toLowerCase(); // e.g. "no-verify"

/**
 * Supabase Postgres uses a managed cert chain. If your local machine doesn't
 * trust it, you can use:
 *   PGSSLMODE=no-verify
 * or let this code auto-detect supabase hosts and disable cert verification.
 */
const forceNoVerify =
  host.endsWith(".supabase.co") ||
  pgsslmode === "no-verify" ||
  url.searchParams.get("sslmode") === "no-verify";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // <-- hard force
});

const DEBUG_SQL = process.env.DEBUG_SQL === "1";

/* ---------- Helpers ---------- */
async function query(text, params = []) {
  if (DEBUG_SQL) {
    console.log("SQL:\n", text, "\nPARAMS:", params);
  }
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    console.error("DB ERROR:", err?.message, "\nSQL:\n", text, "\nPARAMS:", params);
    throw err;
  }
}

/* ---------- Schema bootstrap (idempotent) ---------- */
async function ensureSchema() {
  // trackers
  await query(
    `
    CREATE TABLE IF NOT EXISTS public.trackers (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `
  );

  // actions
  await query(
    `
    CREATE TABLE IF NOT EXISTS public.actions (
      id          BIGSERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      owner       TEXT,
      comments    TEXT,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','completed')),
      priority    INTEGER NOT NULL DEFAULT 2,
      due_date    DATE,
      tracker_id  BIGINT NOT NULL REFERENCES public.trackers(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      local_id    INTEGER
    );
    `
  );

  // updated_at trigger
  await query(
    `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'set_actions_updated_at'
      ) THEN
        CREATE OR REPLACE FUNCTION public.set_actions_updated_at()
        RETURNS TRIGGER AS $f$
        BEGIN
          NEW.updated_at := now();
          RETURN NEW;
        END;
        $f$ LANGUAGE plpgsql;
      END IF;
    END$$;
    `
  );

  await query(
    `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'actions_set_updated_at'
      ) THEN
        CREATE TRIGGER actions_set_updated_at
        BEFORE UPDATE ON public.actions
        FOR EACH ROW
        EXECUTE FUNCTION public.set_actions_updated_at();
      END IF;
    END$$;
    `
  );

  // local_id per tracker
  await query(
    `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'actions_local_id_next'
      ) THEN
        CREATE OR REPLACE FUNCTION public.actions_local_id_next()
        RETURNS TRIGGER AS $f$
        DECLARE nxt INT;
        BEGIN
          IF NEW.local_id IS NULL THEN
            SELECT COALESCE(MAX(local_id),0)+1 INTO nxt
            FROM public.actions
            WHERE tracker_id = NEW.tracker_id;
            NEW.local_id := nxt;
          END IF;
          RETURN NEW;
        END;
        $f$ LANGUAGE plpgsql;
      END IF;
    END$$;
    `
  );

  await query(
    `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'set_actions_local_id'
      ) THEN
        CREATE TRIGGER set_actions_local_id
        BEFORE INSERT ON public.actions
        FOR EACH ROW
        EXECUTE FUNCTION public.actions_local_id_next();
      END IF;
    END$$;
    `
  );
}

/* ---------- App ---------- */
const app = express();
app.use(cors());
app.use(express.json());

/* tiny request logger */
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

/* Health */
let schemaInitError = null;
app.get("/health", async (_req, res) => {
  try {
    const r = await query("SELECT 1 as ok");
    res.json({
      status: "ok",
      db: r.rows[0]?.ok === 1,
      schema: schemaInitError ? { ok: false, error: schemaInitError?.message } : { ok: true },
      host,
      ssl_rejectUnauthorized: !forceNoVerify,
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

/* ---------- Trackers ---------- */
app.get("/trackers", async (_req, res) => {
  try {
    const r = await query(`SELECT id, name, created_at FROM public.trackers ORDER BY id ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/trackers", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const r = await query(
      `INSERT INTO public.trackers (name) VALUES ($1) RETURNING id, name, created_at`,
      [String(name).trim()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/trackers/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid tracker id" });
    }
    await query(`DELETE FROM public.trackers WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Actions ---------- */
app.get("/actions", async (req, res) => {
  try {
    const trackerId = Number(req.query.tracker_id);
    if (!Number.isFinite(trackerId)) {
      return res.status(400).json({ error: "tracker_id is required (number)" });
    }

    const rows = await query(
      `
      SELECT id, title, owner, comments, status, priority, due_date,
             tracker_id, created_at, updated_at, local_id
      FROM public.actions
      WHERE tracker_id = $1
      ORDER BY id ASC
      `,
      [trackerId]
    );

    res.json(rows.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/actions", async (req, res) => {
  try {
    const { tracker_id, title, owner, comments, status, priority, due_date } = req.body || {};
    if (!Number.isFinite(Number(tracker_id))) {
      return res.status(400).json({ error: "tracker_id is required (number)" });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const r = await query(
      `
      INSERT INTO public.actions (tracker_id, title, owner, comments, status, priority, due_date)
      VALUES ($1,$2,$3,$4,COALESCE($5,'open'),COALESCE($6,2),$7)
      RETURNING id, title, owner, comments, status, priority, due_date, tracker_id, created_at, updated_at, local_id
      `,
      [
        Number(tracker_id),
        String(title).trim(),
        owner ?? null,
        comments ?? null,
        status ?? null,
        Number.isFinite(Number(priority)) ? Number(priority) : null,
        due_date || null,
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/actions/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid action id" });
    }

    const fields = [];
    const values = [];
    let idx = 1;

    const allow = ["title", "owner", "comments", "status", "priority", "due_date"];
    for (const k of allow) {
      if (k in req.body) {
        fields.push(`${k}=$${idx++}`);
        if (k === "priority") values.push(Number.isFinite(Number(req.body[k])) ? Number(req.body[k]) : null);
        else values.push(req.body[k] ?? null);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "no updatable fields provided" });
    }

    values.push(id);
    const r = await query(
      `
      UPDATE public.actions
      SET ${fields.join(", ")}, updated_at=now()
      WHERE id=$${idx}
      RETURNING id, title, owner, comments, status, priority, due_date, tracker_id, created_at, updated_at, local_id
      `,
      values
    );

    if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Start ---------- */
const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`✅ API running on http://localhost:${port}`);

  try {
    await ensureSchema();
    console.log("✅ Schema ready");
  } catch (e) {
    schemaInitError = e;
    console.error("❌ Failed to init schema:", e);
    // Note: we DO NOT exit; the server stays up so you can hit /health and see the error
  }
});