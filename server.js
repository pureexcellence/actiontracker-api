import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import morgan from 'morgan';
import dotenv from 'dotenv';

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_ORIGINS?.split(',') || '*',
}));
app.use(express.json());
app.use(morgan('dev'));

// 🚨 Globale fix: zelf-ondertekende certificaten negeren
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
console.log('🔐 NODE_TLS_REJECT_UNAUTHORIZED =', process.env.NODE_TLS_REJECT_UNAUTHORIZED);

// Database pool met SSL fix
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
console.log('🔐 Starting PG pool with SSL.rejectUnauthorized=false');

// Test schema
async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS public.trackers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  try {
    await pool.query(sql);
    console.log('✅ Schema ensured');
  } catch (err) {
    console.error('❌ Failed to init schema:', err);
  }
}

// Routes
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1 as ok');
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/trackers', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.trackers ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/trackers', async (req, res) => {
  const { name } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO public.trackers(name) VALUES($1) RETURNING *',
      [name]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  await ensureSchema();
});