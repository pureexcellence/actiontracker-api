// server.js (ESM)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { Pool } from 'pg';

const PORT = process.env.PORT || 3000;

// ====== CORS ======
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl / health etc.
    const ok = FRONTEND_ORIGINS.length === 0 || FRONTEND_ORIGINS.includes(origin);
    cb(ok ? null : new Error('CORS blocked'), ok);
  },
  credentials: true,
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(morgan('dev'));

// ====== PG POOL met SSL zonder verificatie ======
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL ontbreekt in ENV');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // HIER zit de fix voor de self-signed chain:
  ssl: { rejectUnauthorized: false },
});

console.log('🔐 Starting PG pool with SSL.rejectUnauthorized=false');

// Beetje extra logging als er ooit iets misgaat
pool.on('error', (err) => {
  console.error('PG POOL ERROR:', err);
});

// ====== DB helpers ======
async function query(sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error('DB ERROR:', err.message, '\nSQL:\n', sql, '\nPARAMS:', params);
    throw err;
  }
}

async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS public.trackers (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.actions (
      id           BIGSERIAL PRIMARY KEY,
      tracker_id   BIGINT NOT NULL REFERENCES public.trackers(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      priority     INTEGER NOT NULL DEFAULT 3,
      status       TEXT NOT NULL DEFAULT 'open',
      owner        TEXT,
      notes        TEXT,
      due_date     DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await query(sql);
  console.log('✅ Schema ensured');
}

// ====== Routes ======
app.get('/', (_req, res) => {
  res.type('text').send('Action Tracker API');
});

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1 as ok');
    res.json({ status: 'ok' });
  } catch (err) {
    // Laat health niet crashen; geef duidelijke melding
    res.status(500).json({ status: 'db_error', error: err.message });
  }
});

// Trackers
app.get('/trackers', async (_req, res) => {
  const { rows } = await query(
    'SELECT id::text, name, created_at FROM public.trackers ORDER BY id ASC'
  );
  res.json(rows);
});

app.post('/trackers', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    'INSERT INTO public.trackers(name) VALUES ($1) RETURNING id::text, name, created_at',
    [name]
  );
  res.status(201).json(rows[0]);
});

// Actions (enkel lijst op tracker)
app.get('/actions', async (req, res) => {
  const trackerId = req.query.tracker_id;
  if (!trackerId) return res.status(400).json({ error: 'tracker_id required' });
  const { rows } = await query(
    `SELECT id::text, tracker_id::text, title, priority, status, owner, notes, due_date, created_at
     FROM public.actions
     WHERE tracker_id = $1
     ORDER BY id ASC`,
    [trackerId]
  );
  res.json(rows);
});

// ====== Start server ======
app.listen(PORT, async () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  try {
    await ensureSchema();
  } catch (err) {
    // Niet hard falen; health zal 500 geven tot DB ok is
    console.error('❌ Failed to init schema:', err.message);
  }
});