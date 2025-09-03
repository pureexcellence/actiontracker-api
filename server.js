// server.js (ESM)

// —————————————————————————————————————————————————————————————
// 0) Boot-time hardening & DNS preferences
// —————————————————————————————————————————————————————————————
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first'); // prefer IPv4 on Render/Supabase

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { Pool } from 'pg';

// —————————————————————————————————————————————————————————————
// 1) Config & helpers
// —————————————————————————————————————————————————————————————
const PORT = Number(process.env.PORT || 3000);

// CORS: comma-separated list in FRONTEND_ORIGINS
const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:3002')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // Allow same-origin and tools without an Origin (curl, health checks)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
};

const mask = (s) =>
  typeof s === 'string'
    ? s.replace(/(postgres:\/\/[^:]+:)[^@]+(@)/, '$1***$2')
    : s;

// Ensure ?sslmode=require in DATABASE_URL; if missing, add it (does not harm locally)
function withSslmodeRequire(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require');
    return u.toString();
  } catch {
    return url; // if it's malformed, leave as-is; pg will throw a useful error
  }
}

const dbUrlRaw = process.env.DATABASE_URL || '';
const dbUrl = withSslmodeRequire(dbUrlRaw);

// —————————————————————————————————————————————————————————————
// 2) PostgreSQL Pool (TLS workaround for Render/Supabase)
//    - Force ssl.rejectUnauthorized=false (bypasses self-signed CA chain)
//    - Prefer IPv4 via custom lookup
// —————————————————————————————————————————————————————————————
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }, // <-- critical fix for "self-signed certificate in certificate chain"
  max: 8,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  // Make pg use IPv4 (Render containers sometimes default to IPv6 first)
  lookup: (host, opts, cb) => dns.lookup(host, { ...opts, family: 4 }, cb),
});

console.log('🟢 Booting ActionTracker API');
console.log('    PORT               =', PORT);
console.log('    DATABASE_URL       =', mask(dbUrl));
console.log('    CORS origins       =', allowedOrigins.join(', ') || '(none)');
console.log('    PG SSL options     =', pool.options?.ssl);

// Small query helper with structured error logging
async function query(sql, params = []) {
  try {
    const res = await pool.query(sql, params);
    return res;
  } catch (err) {
    console.error('DB ERROR:', err.message);
    console.error('SQL:\n', sql);
    console.error('PARAMS:', JSON.stringify(params));
    throw err;
  }
}

// —————————————————————————————————————————————————————————————
/** 3) Ensure database schema exists (idempotent) */
// —————————————————————————————————————————————————————————————
async function ensureSchema() {
  // trackers table
  await query(`
    CREATE TABLE IF NOT EXISTS public.trackers (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // actions table (with additional columns app expects)
  await query(`
    CREATE TABLE IF NOT EXISTS public.actions (
      id          BIGSERIAL PRIMARY KEY,
      tracker_id  BIGINT NOT NULL REFERENCES public.trackers(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      owner       TEXT,
      comments    TEXT,
      status      TEXT CHECK (status IN ('open','in_progress','completed')) DEFAULT 'open',
      priority    INTEGER DEFAULT 2,
      due_date    DATE,
      local_id    INTEGER,  -- per-tracker sequence number
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // updated_at trigger
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'set_actions_updated_at'
      ) THEN
        CREATE OR REPLACE FUNCTION public.set_actions_updated_at()
        RETURNS trigger AS $f$
        BEGIN
          NEW.updated_at := now();
          RETURN NEW;
        END;
        $f$ LANGUAGE plpgsql;
      END IF;
    END$$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_actions_set_updated_at'
      ) THEN
        CREATE TRIGGER trg_actions_set_updated_at
        BEFORE UPDATE ON public.actions
        FOR EACH ROW EXECUTE FUNCTION public.set_actions_updated_at();
      END IF;
    END$$;
  `);

  // local_id per tracker trigger
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'actions_local_id_next'
      ) THEN
        CREATE OR REPLACE FUNCTION public.actions_local_id_next()
        RETURNS trigger AS $f$
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
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_actions_set_local_id'
      ) THEN
        CREATE TRIGGER trg_actions_set_local_id
        BEFORE INSERT ON public.actions
        FOR EACH ROW EXECUTE FUNCTION public.actions_local_id_next();
      END IF;
    END$$;
  `);

  console.log('✅ Schema ensured');
}

// —————————————————————————————————————————————————————————————
// 4) Express app & middleware
// —————————————————————————————————————————————————————————————
const app = express();
app.disable('x-powered-by');

app.use(morgan('tiny'));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// —————————————————————————————————————————————————————————————
// 5) Health & root
// —————————————————————————————————————————————————————————————
app.get('/', (_req, res) => {
  // Don’t expose internals; minimal text to avoid “Cannot GET /”
  res.type('text/plain').send('ActionTracker API is alive. Try /health or /trackers');
});

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1 as ok');
    res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'down', error: err.message });
  }
});

// —————————————————————————————————————————————————————————————
// 6) Trackers endpoints
// —————————————————————————————————————————————————————————————
app.get('/trackers', async (_req, res) => {
  try {
    const { rows } = await query(`SELECT id::text, name, created_at FROM public.trackers ORDER BY id`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/trackers', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const { rows } = await query(
      `INSERT INTO public.trackers (name) VALUES ($1) RETURNING id::text, name, created_at`,
      [String(name).trim()],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/trackers/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    const { rowCount, rows } = await query(
      `UPDATE public.trackers SET name = $1 WHERE id = $2 RETURNING id::text, name, created_at`,
      [String(name).trim(), id],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/trackers/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { rowCount } = await query(`DELETE FROM public.trackers WHERE id = $1`, [id]);
    res.json({ ok: rowCount > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// —————————————————————————————————————————————————————————————
// 7) Actions endpoints
// —————————————————————————————————————————————————————————————
app.get('/actions', async (req, res) => {
  try {
    const trackerId = Number(req.query.tracker_id);
    if (!trackerId) return res.status(400).json({ error: 'tracker_id is required' });
    const { rows } = await query(
      `SELECT
         id::text, tracker_id::text, local_id, title, owner, comments, status, priority, due_date, created_at, updated_at
       FROM public.actions
       WHERE tracker_id = $1
       ORDER BY local_id ASC, id ASC`,
      [trackerId],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/actions', async (req, res) => {
  try {
    const {
      tracker_id,
      title,
      owner = null,
      comments = null,
      status = 'open',
      priority = 2,
      due_date = null,
    } = req.body || {};

    const trackerId = Number(tracker_id);
    if (!trackerId || !title) return res.status(400).json({ error: 'tracker_id and title are required' });

    const { rows } = await query(
      `INSERT INTO public.actions
       (tracker_id, title, owner, comments, status, priority, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id::text, tracker_id::text, local_id, title, owner, comments, status, priority, due_date, created_at, updated_at`,
      [trackerId, String(title).trim(), owner, comments, status, Number(priority), due_date],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/actions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });

    const fields = ['title', 'owner', 'comments', 'status', 'priority', 'due_date'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (f in (req.body || {})) {
        sets.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

    params.push(id);
    const sql = `
      UPDATE public.actions SET ${sets.join(', ')}
      WHERE id = $${idx}
      RETURNING id::text, tracker_id::text, local_id, title, owner, comments, status, priority, due_date, created_at, updated_at
    `;
    const { rowCount, rows } = await query(sql, params);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/actions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { rowCount } = await query(`DELETE FROM public.actions WHERE id = $1`, [id]);
    res.json({ ok: rowCount > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// —————————————————————————————————————————————————————————————
// 8) Start server
// —————————————————————————————————————————————————————————————
const server = app.listen(PORT, async () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  try {
    await ensureSchema();
  } catch (err) {
    console.error('❌ Failed to init schema:', err);
  }
});

// graceful shutdown (Render sends SIGTERM on redeploy)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
  process.on(sig, async () => {
    try {
      await pool.end();
    } finally {
      server.close(() => process.exit(0));
    }
  });
}