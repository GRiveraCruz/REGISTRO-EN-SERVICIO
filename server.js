// ═════════════════════════════════════════════════════════════════════════════
//  Persico — Kiosco de Asistencia (registro en servicio)
//  v2: los datos viven en la MISMA base de datos PostgreSQL de Persico Suite.
//  · Trabajadores = tabla `personal` de la Suite (ya no se sincronizan ni se duplican).
//  · El kiosco guarda su configuración propia por trabajador (PIN, jornada, puntos de
//    registro, jobs permitidos) y sus registros, ubicaciones, usuarios, firmas y
//    notificaciones en tablas `kiosco_*`.
//  · Permisos, vacaciones, órdenes de servicio y tareas se siguen pidiendo a la Suite por
//    HTTP (SUITE_URL + SYNC_API_KEY), porque ahí viven sus reglas de negocio.
// ═════════════════════════════════════════════════════════════════════════════
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_API_KEY = (process.env.SYNC_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();   // sin espacios/comillas pegados
// Se acepta con o sin protocolo: "beta-persico.up.railway.app" → "https://beta-persico.up.railway.app"
const SUITE_URL = (() => {
  let u = (process.env.SUITE_URL || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
})();
// Secreto para guardar los PIN como HMAC (no en texto plano). Si no se define, se usa la
// llave de sincronización; cambiarlo invalida los PIN existentes.
const PIN_SECRET = process.env.KIOSCO_PIN_SECRET || SYNC_API_KEY || 'persico-kiosco';
const DATA_DIR = path.join(__dirname, 'data');           // solo para migrar los JSON antiguos

app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// Envuelve handlers async para que un error de base de datos responda 500 en vez de tumbar el proceso
const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  console.error('[kiosco]', req.method, req.path, e);
  if (!res.headersSent) res.status(500).json({ error: 'Error del servidor: ' + e.message });
});

const hashPin = (pin) => crypto.createHmac('sha256', PIN_SECRET).update(String(pin)).digest('hex');
const DEFAULT_NOTIF = Array.from({ length: 5 }, () => ({ name: '', phone: '', apikey: '', active: false }));
async function leerNotificaciones() { return await db.getConfig('notificaciones', DEFAULT_NOTIF); }

// ─── TRABAJADORES (de Control de Personal de la Suite) ───────────────────────
// Forma de cada trabajador en la API (igual que antes, para no cambiar el frontend):
// { id: tid, externalId: tid, name, position, area, active, shiftStart, shiftEnd,
//   allowedJobs, locationIds, locationId, pin: true|undefined }
function filaATrabajador(r) {
  const d = r.data || {};
  const cfg = r.cfg || {};
  return {
    id: r.tid, externalId: r.tid,
    name: r.nombre || d.nombre || '',
    position: d.puesto || '',
    area: r.area || d.area || '',
    active: (d.estado || 'Activo') !== 'Baja',
    shiftStart: cfg.shiftStart || '07:00',
    shiftEnd: cfg.shiftEnd || '17:00',
    allowedJobs: cfg.allowedJobs || [],
    locationIds: cfg.locationIds || (cfg.locationId ? [cfg.locationId] : []),
    locationId: (cfg.locationIds || [])[0] || cfg.locationId || '',
    pin: r.pin_hash ? true : undefined,
  };
}
const SQL_TRABAJADORES = `SELECT p.tid, p.nombre, p.area, p.data, k.data AS cfg, k.pin_hash
  FROM personal p LEFT JOIN kiosco_trabajadores k ON k.tid = p.tid`;
async function listarTrabajadores() {
  const r = await db.q(SQL_TRABAJADORES + ' ORDER BY p.nombre');
  return r.rows.map(filaATrabajador);
}
async function trabajadorPorId(id) {
  const r = await db.q(SQL_TRABAJADORES + ' WHERE p.tid = $1', [String(id || '')]);
  return r.rows.length ? filaATrabajador(r.rows[0]) : null;
}
async function guardarCfgTrabajador(tid, cambios) {
  await db.q(`INSERT INTO kiosco_trabajadores (tid, data, updated_at) VALUES ($1, $2, now())
              ON CONFLICT (tid) DO UPDATE SET data = kiosco_trabajadores.data || EXCLUDED.data, updated_at = now()`,
             [tid, JSON.stringify(cambios)]);
}

// ─── AUTH (usuarios administrativos del kiosco) ──────────────────────────────
app.post('/api/login', aw(async (req, res) => {
  const { username, password } = req.body;
  const r = await db.q('SELECT * FROM kiosco_usuarios WHERE username = $1', [String(username || '')]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) return res.status(401).json({ error: 'Credenciales incorrectas' });
  res.json({ success: true, user: { id: u.id, username: u.username, role: u.role, name: u.name } });
}));

app.get('/api/users', aw(async (req, res) => {
  const r = await db.q('SELECT id, username, role, name, created_at AS "createdAt" FROM kiosco_usuarios ORDER BY name');
  res.json(r.rows);
}));

app.post('/api/users', aw(async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Nombre, usuario y contraseña son requeridos' });
  const id = uuidv4();
  try {
    await db.q('INSERT INTO kiosco_usuarios (id, username, password_hash, role, name) VALUES ($1,$2,$3,$4,$5)',
               [id, username, await bcrypt.hash(password, 10), role || 'worker', name]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    throw e;
  }
  res.json({ success: true, user: { id, name, username, role: role || 'worker' } });
}));

app.put('/api/users/:id', aw(async (req, res) => {
  const { name, username, password, role } = req.body;
  const cur = (await db.q('SELECT * FROM kiosco_usuarios WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Usuario no encontrado' });
  try {
    await db.q('UPDATE kiosco_usuarios SET name=$2, username=$3, role=$4, password_hash=$5 WHERE id=$1',
               [cur.id, name || cur.name, username || cur.username, role || cur.role,
                password ? await bcrypt.hash(password, 10) : cur.password_hash]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
    throw e;
  }
  res.json({ success: true, user: { id: cur.id, name: name || cur.name, username: username || cur.username, role: role || cur.role } });
}));

app.delete('/api/users/:id', aw(async (req, res) => {
  const cur = (await db.q('SELECT * FROM kiosco_usuarios WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (cur.role === 'admin') {
    const n = (await db.q("SELECT count(*)::int AS n FROM kiosco_usuarios WHERE role = 'admin'")).rows[0].n;
    if (n <= 1) return res.status(400).json({ error: 'No puedes eliminar el único administrador del sistema' });
  }
  await db.q('DELETE FROM kiosco_usuarios WHERE id = $1', [cur.id]);
  res.json({ success: true });
}));

// ─── WORKERS ─────────────────────────────────────────────────────────────────
app.get('/api/workers', aw(async (req, res) => res.json(await listarTrabajadores())));

const MSG_ALTA_SUITE = 'Los trabajadores se dan de alta, se editan y se dan de baja en Persico Suite → Recursos Humanos → Control de Personal. El kiosco los toma de ahí automáticamente.';
app.post('/api/workers', (req, res) => res.status(400).json({ error: MSG_ALTA_SUITE }));
app.delete('/api/workers/:id', (req, res) => res.status(400).json({ error: MSG_ALTA_SUITE }));
app.post('/api/workers/upload', (req, res) => res.status(400).json({ error: MSG_ALTA_SUITE }));
app.get('/api/workers/template', (req, res) => res.status(400).json({ error: MSG_ALTA_SUITE }));

// Solo la configuración propia del kiosco (jornada, puntos de registro, jobs permitidos).
// Nombre, puesto y área vienen de la Suite y aquí no se modifican.
app.put('/api/workers/:id', aw(async (req, res) => {
  const w = await trabajadorPorId(req.params.id);
  if (!w) return res.status(404).json({ error: 'Trabajador no encontrado en Control de Personal' });
  const b = req.body || {};
  const cambios = {};
  for (const k of ['shiftStart', 'shiftEnd', 'allowedJobs', 'locationIds']) if (k in b) cambios[k] = b[k];
  if ('locationIds' in b) cambios.locationId = (b.locationIds || [])[0] || '';
  await guardarCfgTrabajador(w.id, cambios);
  res.json({ success: true, worker: await trabajadorPorId(w.id) });
}));

// Compatibilidad con versiones anteriores de la Suite: ya no hay nada que sincronizar.
app.post('/api/workers/sync', (req, res) => res.json({ success: true, created: 0, updated: 0, deactivated: 0,
  mensaje: 'El kiosco lee Control de Personal directamente desde la base de datos; no es necesario sincronizar.' }));

// ─── PIN personal ────────────────────────────────────────────────────────────
app.post('/api/workers/:id/set-pin', aw(async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'El PIN debe ser numérico, de 4 a 6 dígitos' });
  const w = await trabajadorPorId(req.params.id);
  if (!w) return res.status(404).json({ error: 'Trabajador no encontrado' });
  try {
    await db.q(`INSERT INTO kiosco_trabajadores (tid, pin_hash, updated_at) VALUES ($1, $2, now())
                ON CONFLICT (tid) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now()`, [w.id, hashPin(pin)]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese PIN ya está en uso por otro trabajador — elige uno diferente' });
    throw e;
  }
  res.json({ success: true });
}));

app.post('/api/workers/login-pin', aw(async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'Ingresa tu PIN' });
  const r = await db.q(SQL_TRABAJADORES + ' WHERE k.pin_hash = $1', [hashPin(pin)]);
  const w = r.rows.length ? filaATrabajador(r.rows[0]) : null;
  if (!w || !w.active) return res.status(404).json({ error: 'PIN incorrecto, o tu cuenta aún no tiene uno configurado' });
  res.json({ success: true, worker: w });
}));

app.delete('/api/workers/:id/pin', aw(async (req, res) => {
  const r = await db.q('UPDATE kiosco_trabajadores SET pin_hash = NULL, updated_at = now() WHERE tid = $1', [req.params.id]);
  if (!r.rowCount && !(await trabajadorPorId(req.params.id))) return res.status(404).json({ error: 'Trabajador no encontrado' });
  res.json({ success: true });
}));

// ─── CARDEX del trabajador (pantalla de inicio) ──────────────────────────────
// Datos de Control de Personal (puesto, fecha de ingreso, antigüedad), horario del
// Tipo de Puesto de su perfil (Suite) —o la jornada configurada en el kiosco—, saldo
// de vacaciones (Suite), horas de esta semana y de la anterior (registros del kiosco,
// semana lunes–domingo en hora de México) y ubicaciones permitidas.
const TZ_LOCAL = process.env.KIOSCO_TZ || 'America/Mexico_City';
const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
function aniosMeses(fecha) {
  if (!fecha) return null;
  const d = new Date(String(fecha).slice(0, 10) + 'T12:00:00'); if (isNaN(d)) return null;
  const h = new Date();
  let m = (h.getFullYear() - d.getFullYear()) * 12 + (h.getMonth() - d.getMonth());
  if (h.getDate() < d.getDate()) m--;
  m = Math.max(0, m);
  return { anios: Math.floor(m / 12), meses: m % 12 };
}
app.get('/api/workers/:id/cardex', aw(async (req, res) => {
  const tid = String(req.params.id || '');
  const p = (await db.q('SELECT tid, nombre, area, data FROM personal WHERE tid = $1', [tid])).rows[0];
  if (!p) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const d = p.data || {};
  const w = await trabajadorPorId(tid);
  // Horario: Tipo de Puesto del perfil (Suite) → jornada del kiosco
  let horario = null;
  try {
    const t = (await db.q(`SELECT tp.data FROM perfiles pf JOIN tipos_puesto tp ON tp.tpid = pf.data->>'tipo_puesto'
                           WHERE lower(pf.data->>'nombre') = lower($1) LIMIT 1`, [d.puesto || ''])).rows[0];
    if (t && t.data && t.data.jornada) {
      const j = t.data.jornada, dias = [];
      for (let i = 0; i < 7; i++) { const x = j[String(i)] || {}; if (x.entrada) dias.push({ dia: DIAS_CORTOS[i], entrada: x.entrada, salida: x.salida }); }
      // agrupa días consecutivos con el mismo horario: "Lun–Jue 07:00–17:00 · Vie 07:00–15:00"
      const grupos = [];
      for (const x of dias) {
        const g = grupos[grupos.length - 1];
        if (g && g.entrada === x.entrada && g.salida === x.salida && DIAS_CORTOS.indexOf(x.dia) === DIAS_CORTOS.indexOf(g.hasta) + 1) g.hasta = x.dia;
        else grupos.push({ desde: x.dia, hasta: x.dia, entrada: x.entrada, salida: x.salida });
      }
      horario = { tipo: t.data.nombre, texto: grupos.map(g => `${g.desde}${g.hasta !== g.desde ? '–' + g.hasta : ''} ${g.entrada}–${g.salida}`).join(' · ') };
    }
  } catch (e) { /* la Suite aún no tiene tipos de puesto: se usa la jornada del kiosco */ }
  if (!horario && w) horario = { tipo: null, texto: `${w.shiftStart} – ${w.shiftEnd}` };
  // Horas por semana (lunes–domingo, hora local) a partir de las salidas registradas
  const h = (await db.q(`
    WITH r AS (SELECT (ts::timestamptz AT TIME ZONE $2) AS loc, (data->>'totalHours')::numeric AS horas
               FROM kiosco_registros WHERE worker_tid = $1 AND tipo = 'salida' AND ts >= $3)
    SELECT to_char(date_trunc('week', loc), 'YYYY-MM-DD') AS semana, COALESCE(sum(horas), 0)::float AS horas, count(*)::int AS jornadas
    FROM r GROUP BY 1`, [tid, TZ_LOCAL, new Date(Date.now() - 16 * 86400000).toISOString()])).rows;
  // (como texto: pg convierte DATE a objeto Date con zona del servidor y el día puede recorrerse)
  const lunes = (await db.q(`SELECT to_char(date_trunc('week', now() AT TIME ZONE $1), 'YYYY-MM-DD') AS esta,
                                    to_char(date_trunc('week', now() AT TIME ZONE $1) - interval '7 days', 'YYYY-MM-DD') AS pasada`, [TZ_LOCAL])).rows[0];
  const semana = (f) => { const x = h.find(r => String(r.semana) === String(f)); return { horas: x ? Math.round(x.horas * 100) / 100 : 0, jornadas: x ? x.jornadas : 0 }; };
  const iso = (v) => String(v).slice(0, 10);
  // Jornada en curso (entrada sin salida): horas transcurridas, solo informativo
  const ult = (await db.q('SELECT tipo, ts FROM kiosco_registros WHERE worker_tid = $1 ORDER BY ts DESC LIMIT 1', [tid])).rows[0];
  const enCurso = ult && ult.tipo === 'entrada' ? Math.round(Math.max(0, (Date.now() - Date.parse(ult.ts)) / 36e5) * 100) / 100 : null;
  // Ubicaciones permitidas
  const locs = (await db.q('SELECT id, data FROM kiosco_ubicaciones ORDER BY created_at')).rows;
  const ids = (w && w.locationIds) || [];
  const ubicaciones = (ids.length ? locs.filter(l => ids.includes(l.id)) : locs).map(l => l.data.name || l.id);
  // v2.5: jefe directo y subordinados (Control de Personal: campo jefe_directo = tid del jefe)
  let jefe = null;
  if (d.jefe_directo) {
    const j = (await db.q('SELECT nombre, data FROM personal WHERE tid = $1', [d.jefe_directo])).rows[0];
    if (j) jefe = { nombre: j.nombre || (j.data || {}).nombre, puesto: (j.data || {}).puesto || '' };
  }
  const subs = (await db.q(`SELECT nombre FROM personal WHERE data->>'jefe_directo' = $1
                            AND COALESCE(data->>'estado', 'Activo') <> 'Baja' ORDER BY nombre`, [tid])).rows.map(r => r.nombre);
  // Vacaciones (Suite)
  let vacaciones = null;
  if (SUITE_URL) {
    try {
      const r = await fetch(`${SUITE_URL}/api/vacaciones/externo/${encodeURIComponent(tid)}`, { headers: { 'X-Sync-Key': SYNC_API_KEY } });
      const v = await r.json();
      vacaciones = r.ok ? { saldo: v.saldo, ganados: v.ganados, gozados: v.gozados, pendientes: v.pendientes } : { error: v.error || 'No disponible' };
    } catch (e) { vacaciones = { error: 'Sin conexión con Recursos Humanos' }; }
  }
  res.json({
    tid, nombre: p.nombre || d.nombre, puesto: d.puesto || '', area: p.area || d.area || '',
    fecha_ingreso: d.fecha_ingreso || null, antiguedad: aniosMeses(d.fecha_ingreso),
    horario, vacaciones, jefe_directo: jefe, subordinados: subs.length, subordinados_nombres: subs.slice(0, 30),
    semana_actual: { desde: iso(lunes.esta), ...semana(iso(lunes.esta)), en_curso: enCurso },
    semana_pasada: { desde: iso(lunes.pasada), ...semana(iso(lunes.pasada)) },
    ubicaciones, todas_las_ubicaciones: !ids.length,
  });
}));

// ─── DISPOSITIVOS (v2.6) ─────────────────────────────────────────────────────
// Cada navegador genera un identificador propio (se guarda en el teléfono). El primer
// dispositivo con el que entra un trabajador queda autorizado; desde otro dispositivo
// no puede registrar asistencia hasta que RH lo autorice. Un dispositivo autorizado
// para un trabajador no sirve para otro, salvo que RH lo marque como "compartido"
// (por ejemplo una tablet fija en planta). Además se detecta si es celular o computadora.
const DEF_DISP = { control_activo: true, solo_movil: false, auto_primer_dispositivo: true };
async function cfgDispositivos() { return { ...DEF_DISP, ...(await db.getConfig('dispositivos', {})) }; }
const hashDispositivo = (id) => crypto.createHmac('sha256', PIN_SECRET).update('disp:' + String(id)).digest('hex');

// Tipo de dispositivo a partir del User-Agent (lo que dice el navegador al servidor)
function tipoPorUA(ua) {
  ua = String(ua || '');
  const os = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
           : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Otro';
  const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Otro';
  let tipo = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet'
           : /Mobi|iPhone|iPod|Android/.test(ua) ? 'movil' : 'computadora';
  return { tipo, os, navegador: nav };
}
// Combina lo que reporta la página (pantalla táctil, Client Hints) con el User-Agent.
// Un iPad moderno se presenta como Mac: si es táctil, se toma como tablet.
function clasificar(req, info) {
  const s = tipoPorUA(req.headers['user-agent']);
  const i = info || {};
  let tipo = s.tipo;
  if (tipo === 'computadora' && s.os === 'Mac' && (i.maxTouchPoints || 0) > 1) tipo = 'tablet';
  if (i.uaMobile === true && tipo === 'computadora') tipo = 'movil';
  return { tipo, os: s.os, navegador: s.navegador, pantalla: i.pantalla || '', tactil: (i.maxTouchPoints || 0) > 0,
           plataforma: i.plataforma || '', modelo: i.modelo || '', ua: String(req.headers['user-agent'] || '').slice(0, 300) };
}
const NOMBRE_TIPO = { movil: 'Celular', tablet: 'Tablet', computadora: 'Computadora' };
// v2.7: cada trabajador puede tener autorizado UN celular (tablet cuenta como celular) y
// UNA computadora. La categoría se fija con el tipo detectado al dar de alta el dispositivo.
const categoriaDe = (tipo) => (tipo === 'computadora' ? 'computadora' : 'movil');
const NOMBRE_CAT = { movil: 'celular', computadora: 'computadora' };
const SQL_CAT = `COALESCE(data->>'categoria', CASE WHEN data->'primero'->>'tipo' = 'computadora' THEN 'computadora' ELSE 'movil' END)`;

// Revisa (y si corresponde, registra) el dispositivo del trabajador.
// → { estado: 'autorizado'|'pendiente'|'rechazado'|'sin_control', mensaje, dispositivo }
async function verificarDispositivo(req, workerId, deviceId, info) {
  const cfg = await cfgDispositivos();
  const disp = clasificar(req, info);
  if (cfg.solo_movil && disp.tipo === 'computadora')
    return { estado: 'rechazado', motivo: 'solo_movil', dispositivo: disp,
             mensaje: 'Los registros de asistencia solo se pueden hacer desde un celular o tablet.' };
  if (!cfg.control_activo) return { estado: 'sin_control', dispositivo: disp };
  if (!deviceId || String(deviceId).length < 16)
    return { estado: 'rechazado', dispositivo: disp, mensaje: 'No se pudo identificar este dispositivo. Actualiza la página e inténtalo de nuevo.' };
  const h = hashDispositivo(deviceId);
  return await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kiosco-disp:' + workerId]);
    const propio = (await c.query('SELECT * FROM kiosco_dispositivos WHERE worker_tid = $1 AND device_hash = $2', [workerId, h])).rows[0];
    const ahora = new Date().toISOString();
    if (propio) {
      await c.query(`UPDATE kiosco_dispositivos SET data = data || $2, updated_at = now() WHERE id = $1`,
                    [propio.id, JSON.stringify({ ultimo_uso: ahora, ultimo: disp })]);
      if (propio.estado === 'autorizado') return { estado: 'autorizado', dispositivo: disp };
      if (propio.estado === 'rechazado')
        return { estado: 'rechazado', dispositivo: disp, mensaje: 'Recursos Humanos rechazó este dispositivo. Usa tu dispositivo autorizado o habla con RH.' };
      return { estado: 'pendiente', dispositivo: disp, mensaje: 'Este dispositivo está pendiente de autorización de Recursos Humanos.' };
    }
    // ¿El dispositivo ya está autorizado para otro trabajador? (salvo que sea compartido)
    const otro = (await c.query(`SELECT d.*, p.nombre FROM kiosco_dispositivos d LEFT JOIN personal p ON p.tid = d.worker_tid
                                 WHERE d.device_hash = $1 AND d.worker_tid <> $2 AND d.estado = 'autorizado'`, [h, workerId])).rows;
    const compartido = otro.some(o => (o.data || {}).compartido);
    const cat = categoriaDe(disp.tipo);
    const propiosAut = (await c.query(`SELECT count(*)::int AS n FROM kiosco_dispositivos WHERE worker_tid = $1 AND estado = 'autorizado' AND ${SQL_CAT} = $2`, [workerId, cat])).rows[0].n;
    let estado = 'pendiente', motivo;
    if (compartido) { estado = 'autorizado'; motivo = 'dispositivo compartido'; }
    else if (otro.length) motivo = `el dispositivo ya está autorizado para ${otro.map(o => o.nombre || o.worker_tid).join(', ')}`;
    else if (!propiosAut && cfg.auto_primer_dispositivo) { estado = 'autorizado'; motivo = `primer ${NOMBRE_CAT[cat]} del trabajador`; }
    else motivo = `ya tienes ${cat === 'movil' ? 'un celular autorizado' : 'una computadora autorizada'}; solo se permite uno de cada tipo`;
    await c.query(`INSERT INTO kiosco_dispositivos (id, worker_tid, device_hash, estado, data) VALUES ($1,$2,$3,$4,$5)`,
                  [uuidv4(), workerId, h, estado, JSON.stringify({ alta: ahora, ultimo_uso: ahora, primero: disp, ultimo: disp, motivo, categoria: cat,
                    autorizado_por: estado === 'autorizado' ? 'automático' : null, autorizado_at: estado === 'autorizado' ? ahora : null })]);
    if (estado === 'autorizado') return { estado, dispositivo: disp, nuevo: true, mensaje: compartido ? '' : `Este ${NOMBRE_TIPO[disp.tipo].toLowerCase()} quedó registrado como tu ${NOMBRE_CAT[cat]} para registrar asistencia.` };
    return { estado, dispositivo: disp, nuevo: true,
             mensaje: `Este dispositivo no está autorizado (${motivo}). Se envió la solicitud a Recursos Humanos; mientras tanto no puedes registrar entrada o salida desde aquí.` };
  });
}

app.post('/api/dispositivos/verificar', aw(async (req, res) => {
  const { workerId, deviceId, info } = req.body || {};
  const w = await trabajadorPorId(workerId);
  if (!w) return res.status(404).json({ error: 'Trabajador no encontrado' });
  res.json(await verificarDispositivo(req, w.id, deviceId, info));
}));

// Administración (panel "Dispositivos" del kiosco: admin y RRHH)
app.get('/api/dispositivos', aw(async (req, res) => {
  const r = await db.q(`SELECT d.id, d.worker_tid, d.estado, d.data, d.created_at, d.updated_at, p.nombre, p.area
                        FROM kiosco_dispositivos d LEFT JOIN personal p ON p.tid = d.worker_tid
                        ORDER BY (d.estado = 'pendiente') DESC, d.updated_at DESC`);
  res.json({ config: await cfgDispositivos(), dispositivos: r.rows.map(x => ({ id: x.id, workerId: x.worker_tid, nombre: x.nombre || x.worker_tid,
    area: x.area || '', estado: x.estado, ...x.data, categoria: (x.data || {}).categoria || categoriaDe(((x.data || {}).primero || {}).tipo),
    created_at: x.created_at, updated_at: x.updated_at })) });
}));
app.put('/api/dispositivos/config', aw(async (req, res) => {
  const b = req.body || {}, cfg = await cfgDispositivos();
  for (const k of Object.keys(DEF_DISP)) if (k in b) cfg[k] = !!b[k];
  await db.setConfig('dispositivos', cfg);
  res.json({ success: true, config: cfg });
}));
// accion: autorizar | rechazar | revocar | compartido (on/off) | eliminar
app.post('/api/dispositivos/:id/accion', aw(async (req, res) => {
  const { accion, usuario, reemplazar, compartido } = req.body || {};
  const d = (await db.q('SELECT * FROM kiosco_dispositivos WHERE id = $1', [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  const ahora = new Date().toISOString();
  if (accion === 'eliminar') { await db.q('DELETE FROM kiosco_dispositivos WHERE id = $1', [d.id]); return res.json({ success: true }); }
  if (accion === 'compartido') {
    await db.q('UPDATE kiosco_dispositivos SET data = data || $2, updated_at = now() WHERE id = $1', [d.id, JSON.stringify({ compartido: !!compartido })]);
    return res.json({ success: true });
  }
  const estado = { autorizar: 'autorizado', rechazar: 'rechazado', revocar: 'rechazado' }[accion];
  if (!estado) return res.status(400).json({ error: 'Acción inválida' });
  await db.tx(async (c) => {
    if (estado === 'autorizado') {
      // v2.7: máximo uno por categoría → el nuevo reemplaza al anterior DE LA MISMA categoría
      // (cambio de celular o de computadora); el de la otra categoría no se toca
      const cat = (d.data || {}).categoria || categoriaDe(((d.data || {}).primero || {}).tipo);
      await c.query(`UPDATE kiosco_dispositivos SET estado = 'rechazado', data = data || $4, updated_at = now()
                     WHERE worker_tid = $1 AND id <> $2 AND estado = 'autorizado' AND ${SQL_CAT} = $3`,
                    [d.worker_tid, d.id, cat, JSON.stringify({ revocado_por: usuario || '', revocado_at: ahora, motivo_revocacion: `reemplazado por otro ${NOMBRE_CAT[cat]}` })]);
      await c.query(`UPDATE kiosco_dispositivos SET data = data || $2 WHERE id = $1`, [d.id, JSON.stringify({ categoria: cat })]);
    }
    const extra = estado === 'autorizado' ? { autorizado_por: usuario || '', autorizado_at: ahora } : { revocado_por: usuario || '', revocado_at: ahora };
    await c.query('UPDATE kiosco_dispositivos SET estado = $2, data = data || $3, updated_at = now() WHERE id = $1', [d.id, estado, JSON.stringify(extra)]);
  });
  res.json({ success: true });
}));

// ─── VACACIONES (saldo, desde la Suite) ──────────────────────────────────────
app.get('/api/vacaciones/:workerId', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const w = await trabajadorPorId(req.params.workerId);
  if (!w) return res.status(404).json({ error: 'Trabajador no encontrado' });
  try {
    const r = await fetch(`${SUITE_URL}/api/vacaciones/externo/${encodeURIComponent(w.id)}`, { headers: { 'X-Sync-Key': SYNC_API_KEY } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con Recursos Humanos: ' + e.message });
  }
}));

// ─── PERMISOS (solicitud y estatus, hacia Persico Suite) ─────────────────────
// El trabajador ya está identificado en el kiosco por su selección de nombre.
// Aquí solo reenviamos la solicitud a la Suite (dueña del flujo de aprobación),
// autenticados con la misma llave compartida que usa la sincronización de trabajadores.
// ─── NOTIFICACIONES WHATSAPP (CallMeBot) ──────────────────────────────────────
// Cada número debe autorizar el bot UNA VEZ: agregar +34 644 51 95 23 a sus
// contactos, enviarle por WhatsApp "I allow callmebot to send me messages", y
// guardar el apikey que responde. Sin ese apikey por número, no se puede enviar.
function periodoTexto({ modalidad, fecha_inicio, fecha_fin, fecha, hora_inicio, hora_fin }) {
  if (modalidad === 'horas') return `${fecha} de ${hora_inicio} a ${hora_fin}`;
  return `${fecha_inicio} al ${fecha_fin}`;
}

async function notificarNuevoPermisoWhatsApp(worker, body) {
  let destinos;
  try { destinos = await leerNotificaciones(); } catch (e) { destinos = []; }
  const activos = destinos.filter(d => d.active && d.phone && d.apikey);
  if (!activos.length) return;

  const texto = `🔔 Persico Suite\nNueva solicitud de permiso:\n👤 ${worker.name}\n📋 Tipo: ${body.tipo}\n📅 Periodo: ${periodoTexto(body)}\n\nRevisa y autoriza en la Suite → Recursos Humanos → Permisos.`;
  const encoded = encodeURIComponent(texto);

  for (const d of activos) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(d.phone)}&text=${encoded}&apikey=${encodeURIComponent(d.apikey)}`;
    fetch(url).catch(e => console.error(`[WhatsApp] Error notificando a ${d.name || d.phone}:`, e.message));
  }
}

app.get('/api/notifications', aw(async (req, res) => res.json(await leerNotificaciones())));

app.put('/api/notifications', aw(async (req, res) => {
  const incoming = Array.isArray(req.body.notifications) ? req.body.notifications : [];
  const clean = [];
  for (let i = 0; i < 5; i++) {
    const n = incoming[i] || {};
    clean.push({
      name: (n.name || '').trim(),
      phone: (n.phone || '').trim(),
      apikey: (n.apikey || '').trim(),
      active: !!n.active,
    });
  }
  await db.setConfig('notificaciones', clean);
  res.json({ success: true });
}));

app.post('/api/notifications/test/:index', aw(async (req, res) => {
  const destinos = await leerNotificaciones();
  const d = destinos[req.params.index];
  if (!d || !d.phone || !d.apikey) return res.status(400).json({ error: 'Completa teléfono y apikey primero' });
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(d.phone)}&text=${encodeURIComponent('✅ Prueba de notificación — Persico Suite')}&apikey=${encodeURIComponent(d.apikey)}`;
    const r = await fetch(url);
    const txt = await r.text();
    if (!r.ok) return res.status(502).json({ error: txt || 'CallMeBot respondió con error' });
    res.json({ success: true, respuesta: txt });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo contactar a CallMeBot: ' + e.message });
  }
}));

app.post('/api/permisos', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const { workerId, tipo, modalidad, fecha_inicio, fecha_fin, fecha, hora_inicio, hora_fin, motivo } = req.body;
  if (!workerId) return res.status(400).json({ error: 'Falta identificar al trabajador' });

  const worker = await trabajadorPorId(workerId);
  if (!worker) return res.status(404).json({ error: 'Trabajador no encontrado' });
  if (!worker.active) return res.status(400).json({ error: 'Este trabajador no está activo en Recursos Humanos.' });

  try {
    const r = await fetch(`${SUITE_URL}/api/permisos/externo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_API_KEY },
      body: JSON.stringify({ externalId: worker.externalId, tipo, modalidad, fecha_inicio, fecha_fin, fecha, hora_inicio, hora_fin, motivo }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    notificarNuevoPermisoWhatsApp(worker, { tipo, modalidad, fecha_inicio, fecha_fin, fecha, hora_inicio, hora_fin });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con Recursos Humanos: ' + e.message });
  }
}));

app.get('/api/permisos/:workerId', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await trabajadorPorId(req.params.workerId);
  if (!worker) return res.status(404).json({ error: 'Trabajador no encontrado' });

  try {
    const r = await fetch(`${SUITE_URL}/api/permisos/externo/${encodeURIComponent(worker.externalId)}`, {
      headers: { 'X-Sync-Key': SYNC_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con Recursos Humanos: ' + e.message });
  }
}));

// ─── ÓRDENES DE SERVICIO (solo lectura + avance, hacia Persico Suite) ────────
async function _osWorkerOrError(req, res) {
  const workerId = req.query.workerId || (req.body && req.body.workerId);
  if (!workerId) { res.status(400).json({ error: 'Falta identificar al trabajador' }); return null; }
  const worker = await trabajadorPorId(workerId);
  if (!worker) { res.status(404).json({ error: 'Trabajador no encontrado' }); return null; }
  return worker;
}

app.get('/api/ordenes-servicio', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  try {
    const r = await fetch(`${SUITE_URL}/api/ordenes-servicio/externo/${encodeURIComponent(worker.externalId)}`, {
      headers: { 'X-Sync-Key': SYNC_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la Suite: ' + e.message });
  }
}));

app.get('/api/ordenes-servicio/:id', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  try {
    const r = await fetch(`${SUITE_URL}/api/ordenes-servicio/externo/${encodeURIComponent(req.params.id)}/detalle?tid=${encodeURIComponent(worker.externalId)}`, {
      headers: { 'X-Sync-Key': SYNC_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la Suite: ' + e.message });
  }
}));

app.put('/api/ordenes-servicio/:id', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  const { alcances, nuevo_punto_abierto, notas_kiosco } = req.body;
  try {
    const r = await fetch(`${SUITE_URL}/api/ordenes-servicio/externo/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_API_KEY },
      body: JSON.stringify({ tid: worker.externalId, alcances, nuevo_punto_abierto, notas_kiosco }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la Suite: ' + e.message });
  }
}));

app.get('/api/ordenes-servicio/:id/pdf', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).send('SUITE_URL no está configurada en el servidor');
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  try {
    const r = await fetch(`${SUITE_URL}/api/ordenes-servicio/externo/${encodeURIComponent(req.params.id)}/pdf?tid=${encodeURIComponent(worker.externalId)}`, {
      headers: { 'X-Sync-Key': SYNC_API_KEY },
    });
    const html = await r.text();
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    res.status(502).send('No se pudo conectar con la Suite: ' + e.message);
  }
}));

// ─── TAREAS ASIGNADAS (solo lectura + avance, hacia Persico Suite) ───────────
app.get('/api/tareas', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  try {
    const r = await fetch(`${SUITE_URL}/api/tareas/externo/${encodeURIComponent(worker.externalId)}`, {
      headers: { 'X-Sync-Key': SYNC_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la Suite: ' + e.message });
  }
}));

app.get('/api/tareas/:id', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  try {
    const r = await fetch(`${SUITE_URL}/api/tareas/externo/${encodeURIComponent(req.params.id)}/detalle?tid=${encodeURIComponent(worker.externalId)}`, {
      headers: { 'X-Sync-Key': SYNC_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la Suite: ' + e.message });
  }
}));

app.put('/api/tareas/:id', aw(async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = await _osWorkerOrError(req, res); if (!worker) return;
  const { alcances, entregables, nuevo_punto_abierto, notas_kiosco } = req.body;
  try {
    const r = await fetch(`${SUITE_URL}/api/tareas/externo/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_API_KEY },
      body: JSON.stringify({ tid: worker.externalId, alcances, entregables, nuevo_punto_abierto, notas_kiosco }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la Suite: ' + e.message });
  }
}));

// ─── LOCATIONS ───────────────────────────────────────────────────────────────
const ubicacion = (r) => ({ ...r.data, id: r.id, createdAt: r.data.createdAt || r.created_at });
app.get('/api/locations', aw(async (req, res) => {
  const r = await db.q('SELECT * FROM kiosco_ubicaciones ORDER BY created_at');
  res.json(r.rows.map(ubicacion));
}));
app.post('/api/locations', aw(async (req, res) => {
  const id = uuidv4();
  const data = { radius: 150, ...req.body, createdAt: new Date().toISOString() };
  delete data.id;
  await db.q('INSERT INTO kiosco_ubicaciones (id, data) VALUES ($1, $2)', [id, JSON.stringify(data)]);
  res.json({ success: true, location: { ...data, id } });
}));
app.put('/api/locations/:id', aw(async (req, res) => {
  const b = { ...req.body }; delete b.id;
  const r = await db.q('UPDATE kiosco_ubicaciones SET data = data || $2 WHERE id = $1 RETURNING *', [req.params.id, JSON.stringify(b)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Ubicación no encontrada' });
  res.json({ success: true, location: ubicacion(r.rows[0]) });
}));
app.delete('/api/locations/:id', aw(async (req, res) => {
  await db.q('DELETE FROM kiosco_ubicaciones WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

// ─── SIGNATURES ──────────────────────────────────────────────────────────────
const firma = (r) => ({ ...r.data, id: r.id, reportKey: r.report_key, type: r.tipo });
app.get('/api/signatures', aw(async (req, res) => {
  const { reportKey } = req.query;
  const r = reportKey ? await db.q('SELECT * FROM kiosco_firmas WHERE report_key = $1', [reportKey])
                      : await db.q('SELECT * FROM kiosco_firmas');
  res.json(r.rows.map(firma));
}));
app.post('/api/signatures', aw(async (req, res) => {
  const { reportKey, type, signerName, signerUsername, password } = req.body;
  if (!reportKey || !type || !password) return res.status(400).json({ error: 'Datos incompletos' });
  const u = (await db.q('SELECT * FROM kiosco_usuarios WHERE username = $1', [String(signerUsername || '')])).rows[0];
  if (!u || !(await bcrypt.compare(String(password), u.password_hash))) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const sig = { id: uuidv4(), reportKey, type, signerName, signerUsername, signedAt: new Date().toISOString() };
  await db.q(`INSERT INTO kiosco_firmas (id, report_key, tipo, data) VALUES ($1,$2,$3,$4)
              ON CONFLICT (report_key, tipo) DO UPDATE SET id = EXCLUDED.id, data = EXCLUDED.data`,
             [sig.id, reportKey, type, JSON.stringify({ signerName, signerUsername, signedAt: sig.signedAt })]);
  res.json({ success: true, signature: sig });
}));
app.delete('/api/signatures/:id', aw(async (req, res) => {
  await db.q('DELETE FROM kiosco_firmas WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

// ─── RECORDS ─────────────────────────────────────────────────────────────────
// timestamp se guarda como texto ISO (UTC), igual que antes, para que los filtros
// "from/to" funcionen exactamente como funcionaban con los JSON.
const registro = (r) => ({ ...r.data, id: r.id, workerId: r.worker_tid, workerName: r.worker_name, type: r.tipo, timestamp: r.ts });
async function buscarRegistros({ workerId, from, to }) {
  const cond = [], params = [];
  if (workerId) { params.push(workerId); cond.push(`worker_tid = $${params.length}`); }
  if (from) { params.push(from); cond.push(`ts >= $${params.length}`); }
  if (to) { params.push(to); cond.push(`ts <= $${params.length}`); }
  const r = await db.q(`SELECT * FROM kiosco_registros ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY ts`, params);
  return r.rows.map(registro);
}
app.get('/api/records', aw(async (req, res) => res.json(await buscarRegistros(req.query))));

// v2.3: entre un registro y el siguiente del mismo trabajador deben pasar al menos
// KIOSCO_ESPERA_MIN minutos (5 por defecto), y se alterna Entrada / Salida. Se valida
// aquí también —no solo en la pantalla— y con un candado por trabajador, para que dos
// toques seguidos (o dos dispositivos) no generen dos registros.
const ESPERA_MIN = Math.max(0, parseFloat(process.env.KIOSCO_ESPERA_MIN || '5') || 0);
app.get('/api/config/registro', (req, res) => res.json({ espera_minutos: ESPERA_MIN }));

app.post('/api/records', aw(async (req, res) => {
  const b = { ...req.body };
  const id = uuidv4(), ts = new Date().toISOString();
  const workerId = String(b.workerId || ''), workerName = b.workerName || '', tipo = b.type || '';
  delete b.id; delete b.workerId; delete b.workerName; delete b.type; delete b.timestamp;
  if (!workerId) return res.status(400).json({ error: 'Falta identificar al trabajador' });
  if (!['entrada', 'salida'].includes(tipo)) return res.status(400).json({ error: 'Tipo de registro inválido' });
  // v2.6: dispositivo autorizado (y celular, si así se configuró) + tipo de dispositivo en el registro
  const ver = await verificarDispositivo(req, workerId, b.deviceId, b.deviceInfo);
  delete b.deviceId; delete b.deviceInfo;
  if (ver.estado === 'pendiente' || ver.estado === 'rechazado')
    return res.status(403).json({ error: ver.mensaje || 'Dispositivo no autorizado', dispositivo_estado: ver.estado });
  b.dispositivo = { tipo: ver.dispositivo.tipo, os: ver.dispositivo.os, navegador: ver.dispositivo.navegador, autorizado: ver.estado === 'autorizado' };
  const resultado = await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kiosco-registro:' + workerId]);
    const ult = (await c.query('SELECT tipo, ts FROM kiosco_registros WHERE worker_tid = $1 ORDER BY ts DESC LIMIT 1', [workerId])).rows[0];
    if (ult) {
      const transcurrido = (Date.parse(ts) - Date.parse(ult.ts)) / 1000;
      const espera = ESPERA_MIN * 60;
      if (transcurrido >= 0 && transcurrido < espera) {
        const faltan = Math.ceil(espera - transcurrido);
        return { status: 429, body: { error: `Debes esperar ${Math.floor(faltan / 60)}:${String(faltan % 60).padStart(2, '0')} min para tu siguiente registro.`,
                                      segundos_restantes: faltan, ultimo: { type: ult.tipo, timestamp: ult.ts } } };
      }
      if (ult.tipo === tipo) {
        return { status: 409, body: { error: `Tu último registro ya fue ${tipo === 'entrada' ? 'Entrada' : 'Salida'}; ahora corresponde ${tipo === 'entrada' ? 'Salida' : 'Entrada'}.`,
                                      ultimo: { type: ult.tipo, timestamp: ult.ts } } };
      }
    }
    await c.query('INSERT INTO kiosco_registros (id, worker_tid, worker_name, tipo, ts, data) VALUES ($1,$2,$3,$4,$5,$6)',
                  [id, workerId, workerName, tipo, ts, JSON.stringify(b)]);
    return { status: 200, body: { success: true, record: { ...b, id, workerId, workerName, type: tipo, timestamp: ts } } };
  });
  res.status(resultado.status).json(resultado.body);
}));

// Completar un registro (horas por Job al salir) o edición del administrador
app.patch('/api/records/:id', aw(async (req, res) => {
  const b = { ...req.body };
  const sets = ['data = data || $2'], params = [req.params.id];
  const extra = {};
  if ('workerId' in b) { extra.worker_tid = b.workerId; }
  if ('workerName' in b) { extra.worker_name = b.workerName; }
  if ('type' in b) { extra.tipo = b.type; }
  if ('timestamp' in b) { extra.ts = b.timestamp; }
  delete b.id; delete b.workerId; delete b.workerName; delete b.type; delete b.timestamp;
  params.push(JSON.stringify(b));
  for (const [col, v] of Object.entries(extra)) { params.push(v); sets.push(`${col} = $${params.length}`); }
  const r = await db.q(`UPDATE kiosco_registros SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
  res.json({ success: true, record: registro(r.rows[0]) });
}));

app.delete('/api/records/:id', aw(async (req, res) => {
  const r = await db.q('DELETE FROM kiosco_registros WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
  res.json({ success: true });
}));

app.get('/api/records/export', aw(async (req, res) => {
  const { workerId, from, to, format } = req.query;
  const records = await buscarRegistros({ workerId, from, to: to ? to + 'T23:59:59' : undefined });
  const workerMap = {};
  (await listarTrabajadores()).forEach(w => { workerMap[w.id] = w; });
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const rows = records.map(r => {
    const worker = workerMap[r.workerId] || {};
    const dt = new Date(r.timestamp);
    return {
      'Nombre': worker.name || r.workerName || '',
      'Puesto': worker.position || '',
      'Fecha': dt.toLocaleDateString('es-MX'),
      'Día': dayNames[dt.getDay()],
      'Hora': dt.toLocaleTimeString('es-MX'),
      'Tipo': r.type === 'entrada' ? 'Entrada' : 'Salida',
      'Horas Jornada': r.totalHours || '',
      'Horas Base': r.baseHours || '',
      'Horas Extra': r.extraHours || '',
      'Ubicación': r.locationName || '',
      'Lat': r.lat || '',
      'Lng': r.lng || '',
      'Dentro de Geocerca': r.inGeofence ? 'Sí' : 'No'
    };
  });
  if (format === 'csv') {
    if (rows.length === 0) return res.send('Sin registros');
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))].join('\n');
    res.setHeader('Content-Disposition', 'attachment; filename="registros_persico.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send('\uFEFF' + csv);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Registros');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="registros_persico.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
}));

// Estado de la conexión (para soporte)
app.get('/api/estado', aw(async (req, res) => {
  const n = async (t) => (await db.q(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  // Prueba real de la conexión con la Suite (URL + llave), sin mostrar la llave
  let suite = { ok: false, error: 'SUITE_URL no configurada' };
  if (SUITE_URL) {
    try {
      const r = await fetch(`${SUITE_URL}/api/kiosco/ping`, { headers: { 'X-Sync-Key': SYNC_API_KEY } });
      const t = await r.text();
      try { suite = JSON.parse(t); } catch (e) { suite = { ok: false, error: `La Suite respondió ${r.status} sin JSON (¿versión anterior a rev81 o URL equivocada?)` }; }
    } catch (e) { suite = { ok: false, error: 'No se pudo conectar: ' + e.message }; }
  }
  res.json({ ok: true, base_de_datos: 'PostgreSQL (compartida con Persico Suite)', conexion_suite: suite, largo_sync_key: SYNC_API_KEY.length, trabajadores: await n('personal'),
             registros: await n('kiosco_registros'), ubicaciones: await n('kiosco_ubicaciones'),
             migracion_json: await db.getConfig('migracion_json', null), suite_url: SUITE_URL || null, sync_key: !!SYNC_API_KEY });
}));

// Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ARRANQUE: tablas, usuarios por defecto y migración única de los JSON antiguos ───
const leer = (f) => { try { const t = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim(); return t ? JSON.parse(t) : []; } catch (e) { return []; } };

async function migrarJSON() {
  if (await db.getConfig('migracion_json', null)) return;               // ya se hizo una vez
  const users = leer('users.json'), workers = leer('workers.json'), locations = leer('locations.json');
  const records = leer('records.json'), sigs = leer('signatures.json'), notif = leer('notifications.json');
  const res = { usuarios: 0, ubicaciones: 0, trabajadores_cfg: 0, registros: 0, registros_sin_vincular: 0, firmas: 0, fecha: new Date().toISOString() };
  await db.tx(async (c) => {
    for (const u of users) {
      if (!u.username || !u.password) continue;
      const r = await c.query('INSERT INTO kiosco_usuarios (id, username, password_hash, role, name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [u.id || uuidv4(), u.username, await bcrypt.hash(String(u.password), 10), u.role || 'worker', u.name || u.username]);
      res.usuarios += r.rowCount;
    }
    for (const l of locations) {
      const { id, ...data } = l;
      const r = await c.query('INSERT INTO kiosco_ubicaciones (id, data) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id || uuidv4(), JSON.stringify(data)]);
      res.ubicaciones += r.rowCount;
    }
    // Trabajadores del JSON → su configuración, ligada por externalId (tid de la Suite)
    const tidDe = {};
    const tidsSuite = new Set((await c.query('SELECT tid FROM personal')).rows.map(r => r.tid));
    for (const w of workers) {
      if (w.externalId && tidsSuite.has(w.externalId)) {
        tidDe[w.id] = w.externalId;
        const cfg = { shiftStart: w.shiftStart, shiftEnd: w.shiftEnd, allowedJobs: w.allowedJobs || [],
                      locationIds: w.locationIds || (w.locationId ? [w.locationId] : []) };
        await c.query(`INSERT INTO kiosco_trabajadores (tid, pin_hash, data) VALUES ($1,$2,$3) ON CONFLICT (tid) DO NOTHING`,
          [w.externalId, w.pin ? hashPin(w.pin) : null, JSON.stringify(cfg)]).catch(() => null);
        res.trabajadores_cfg++;
      }
    }
    const nombreDe = Object.fromEntries(workers.map(w => [w.id, w.name]));
    for (const r0 of records) {
      const { id, workerId, workerName, type, timestamp, ...data } = r0;
      let tid = tidDe[workerId];
      if (!tid) { tid = 'KIOSCO-' + workerId; res.registros_sin_vincular++; }        // se puede vincular desde la Suite
      const r = await c.query('INSERT INTO kiosco_registros (id, worker_tid, worker_name, tipo, ts, data) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [id || uuidv4(), tid, workerName || nombreDe[workerId] || '', type || '', timestamp || new Date().toISOString(), JSON.stringify(data)]);
      res.registros += r.rowCount;
    }
    for (const s of sigs) {
      if (!s.reportKey || !s.type) continue;
      const r = await c.query('INSERT INTO kiosco_firmas (id, report_key, tipo, data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [s.id || uuidv4(), s.reportKey, s.type, JSON.stringify({ signerName: s.signerName, signerUsername: s.signerUsername, signedAt: s.signedAt })]);
      res.firmas += r.rowCount;
    }
    if (Array.isArray(notif) && notif.length) await c.query(`INSERT INTO kiosco_config (clave, data) VALUES ('notificaciones', $1) ON CONFLICT DO NOTHING`, [JSON.stringify(notif)]);
    await c.query(`INSERT INTO kiosco_config (clave, data) VALUES ('migracion_json', $1) ON CONFLICT (clave) DO UPDATE SET data = EXCLUDED.data`, [JSON.stringify(res)]);
  });
  console.log('[kiosco] Migración de JSON a la base de datos:', res);
}

async function arrancar() {
  await db.init();
  await db.q('SELECT 1 FROM personal LIMIT 1').catch(() => { throw new Error('No existe la tabla "personal": DATABASE_URL debe apuntar a la base de datos de Persico Suite.'); });
  await migrarJSON();
  const n = (await db.q('SELECT count(*)::int AS n FROM kiosco_usuarios')).rows[0].n;
  if (!n) {
    await db.q('INSERT INTO kiosco_usuarios (id, username, password_hash, role, name) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
      ['1', 'admin', await bcrypt.hash('admin123', 10), 'admin', 'Administrador', '2', 'rrhh', await bcrypt.hash('rrhh123', 10), 'rrhh', 'Recursos Humanos']);
    console.log('[kiosco] Usuarios por defecto creados (admin / rrhh). Cambia sus contraseñas.');
  }
  // Marca para la Suite: el kiosco ya trabaja sobre la base compartida
  await db.setConfig('kiosco_bd', { version: 2, arranque: new Date().toISOString() });
  app.listen(PORT, () => console.log(`Persico Attendance (PostgreSQL compartida) running on port ${PORT}`));
}

arrancar().catch(e => { console.error('[kiosco] No se pudo arrancar:', e.message); process.exit(1); });
