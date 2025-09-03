// server.js
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
console.log('DNS result order: ipv4first');
import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
import { Pool } from 'pg';
import dns from 'node:dns';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // moet sslmode=require hebben op Render
  ssl: { rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  // Forceer IPv4:
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { ...opts, family: 4 }, cb),
});

const app = express();
const port = process.env.PORT || 3000;

// ====== Middleware ======
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = process.env.FRONTEND_ORIGINS
      ? process.env.FRONTEND_ORIGINS.split(',')
      : [];
    if (allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

// ====== Database config ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // belangrijk voor Supabase + Render
});

// Helper om queries uit te voeren
async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ====== Init schema ======
async function ensureSchema() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.trackers (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS public.actions (
        id          BIGSERIAL PRIMARY KEY,
        tracker_id  BIGINT REFERENCES public.trackers(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        assignee    TEXT,
        description TEXT,
        due_date    DATE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    console.log('✅ Schema ensured');
  } catch (err) {
    console.error('❌ Failed to init schema:', err);
  }
}

// ====== Routes ======

// Healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Root
app.get('/', (req, res) => {
  res.type('text/plain').send('ActionTracker API is up. Try /trackers or /health');
});

// Trackers
app.get('/trackers', async (req, res) => {
  try {
    const result = await query('SELECT * FROM public.trackers ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/trackers', async (req, res) => {
  const { name } = req.body;
  try {
    const result = await query(
      'INSERT INTO public.trackers (name) VALUES ($1) RETURNING *',
      [name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Actions
app.get('/actions', async (req, res) => {
  const { tracker_id } = req.query;
  try {
    const result = await query(
      'SELECT * FROM public.actions WHERE tracker_id = $1 ORDER BY id ASC',
      [tracker_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/actions', async (req, res) => {
  const { tracker_id, title, status, assignee, description, due_date } = req.body;
  try {
    const result = await query(
      `INSERT INTO public.actions
        (tracker_id, title, status, assignee, description, due_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tracker_id, title, status, assignee, description, due_date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ====== Start ======
app.listen(port, async () => {
  console.log(`✅ API running on http://localhost:${port}`);
  await ensureSchema();
});