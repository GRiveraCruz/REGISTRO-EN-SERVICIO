// ═════════════════════════════════════════════════════════════════════════════
//  Base de datos del kiosco — la MISMA base PostgreSQL de Persico Suite.
//  · Trabajadores: se leen directo de la tabla `personal` de la Suite (fuente de
//    verdad); el kiosco solo guarda su configuración propia (PIN, jornada, puntos de
//    registro, jobs permitidos) en `kiosco_trabajadores`, ligada por tid.
//  · Registros, puntos de registro, usuarios, firmas y notificaciones: tablas `kiosco_*`.
//  Las tablas se crean solas al arrancar (CREATE TABLE IF NOT EXISTS). La Suite declara
//  los mismos modelos en db.py, con las mismas columnas.
// ═════════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

function urlBD() {
  const u = process.env.DATABASE_URL || '';
  if (!u) return '';
  return u.replace(/^postgres:\/\//, 'postgresql://');
}

const DATABASE_URL = urlBD();
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '5', 10),
  ssl: /sslmode=require/.test(DATABASE_URL) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
}) : null;

// Un cliente inactivo que la base cierra (reinicio, mantenimiento) no debe tumbar el proceso
if (pool) pool.on('error', (e) => console.error('[kiosco] conexión inactiva cerrada por la base de datos:', e.message));

const DDL = `
CREATE TABLE IF NOT EXISTS kiosco_registros (
  id          VARCHAR PRIMARY KEY,
  worker_tid  VARCHAR,
  worker_name VARCHAR,
  tipo        VARCHAR,
  ts          VARCHAR,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kiosco_registros_ts ON kiosco_registros (ts);
CREATE INDEX IF NOT EXISTS ix_kiosco_registros_worker_tid ON kiosco_registros (worker_tid);
CREATE TABLE IF NOT EXISTS kiosco_trabajadores (
  tid        VARCHAR PRIMARY KEY,
  pin_hash   VARCHAR UNIQUE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kiosco_ubicaciones (
  id         VARCHAR PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kiosco_usuarios (
  id            VARCHAR PRIMARY KEY,
  username      VARCHAR UNIQUE NOT NULL,
  password_hash VARCHAR NOT NULL,
  role          VARCHAR,
  name          VARCHAR,
  created_at    TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kiosco_firmas (
  id         VARCHAR PRIMARY KEY,
  report_key VARCHAR,
  tipo       VARCHAR,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_kiosco_firmas_key_tipo UNIQUE (report_key, tipo)
);
CREATE TABLE IF NOT EXISTS kiosco_config (
  clave      VARCHAR PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kiosco_dispositivos (
  id            VARCHAR PRIMARY KEY,
  worker_tid    VARCHAR NOT NULL,
  device_hash   VARCHAR NOT NULL,
  estado        VARCHAR NOT NULL DEFAULT 'pendiente',
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP DEFAULT now(),
  updated_at    TIMESTAMP DEFAULT now(),
  CONSTRAINT uq_kiosco_dispositivos UNIQUE (worker_tid, device_hash)
);
CREATE INDEX IF NOT EXISTS ix_kiosco_dispositivos_hash ON kiosco_dispositivos (device_hash);
-- Si la Suite creó las tablas primero (SQLAlchemy no pone defaults en la base), se agregan:
ALTER TABLE kiosco_registros    ALTER COLUMN data SET DEFAULT '{}'::jsonb, ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE kiosco_trabajadores ALTER COLUMN data SET DEFAULT '{}'::jsonb, ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE kiosco_ubicaciones  ALTER COLUMN data SET DEFAULT '{}'::jsonb, ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE kiosco_usuarios     ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE kiosco_firmas       ALTER COLUMN data SET DEFAULT '{}'::jsonb;
ALTER TABLE kiosco_config       ALTER COLUMN data SET DEFAULT '{}'::jsonb, ALTER COLUMN updated_at SET DEFAULT now();
`;

async function q(text, params) {
  if (!pool) throw new Error('DATABASE_URL no está configurada');
  return pool.query(text, params);
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function init() {
  if (!pool) throw new Error('DATABASE_URL no está configurada. El kiosco usa la misma base de datos que Persico Suite.');
  await q('SELECT pg_advisory_lock(hashtext($1))', ['kiosco-ddl']);
  try { await q(DDL); } finally { await q('SELECT pg_advisory_unlock(hashtext($1))', ['kiosco-ddl']); }
}

async function getConfig(clave, def) {
  const r = await q('SELECT data FROM kiosco_config WHERE clave = $1', [clave]);
  return r.rows.length ? r.rows[0].data : def;
}
async function setConfig(clave, data) {
  await q(`INSERT INTO kiosco_config (clave, data, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (clave) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [clave, JSON.stringify(data)]);
}

module.exports = { pool, q, tx, init, getConfig, setConfig, DATABASE_URL };
