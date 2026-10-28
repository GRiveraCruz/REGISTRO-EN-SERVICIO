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
    homeOffice: !!cfg.homeOffice,                     // v2.10: no se valida la ubicación
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
  if ('homeOffice' in b) cambios.homeOffice = !!b.homeOffice;          // v2.10
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
  const homeOffice = !!(w && w.homeOffice);                                   // v2.10
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
    ubicaciones: homeOffice ? ['🏠 Smart Work'] : ubicaciones, todas_las_ubicaciones: !ids.length && !homeOffice, home_office: homeOffice,
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
  // v2.11: en Smart Work solo se registra desde una computadora (y la regla "solo celular" no aplica)
  const wHO = await trabajadorPorId(workerId);
  if (wHO && wHO.homeOffice) {
    if (disp.tipo !== 'computadora')
      return { estado: 'rechazado', motivo: 'home_office_solo_computadora', dispositivo: disp, home_office: true,
               mensaje: `Estás en modo Smart Work: la asistencia solo se registra desde tu laptop o computadora (este dispositivo es ${NOMBRE_TIPO[disp.tipo].toLowerCase()}).` };
  } else if (cfg.solo_movil && disp.tipo === 'computadora')
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

// ─── VALIDACIÓN DE UBICACIÓN EN EL SERVIDOR (v2.17) ─────────────────────────────
// El servidor ya no confía en el "inGeofence" del navegador:
//  · recalcula la distancia a las ubicaciones permitidas del trabajador;
//  · rechaza ubicaciones con precisión mala o sospechosamente perfecta (0 m) y ubicaciones
//    viejas (posición tomada hace más de N segundos);
//  · marca (sin rechazar) "viajes imposibles" y coordenadas idénticas en días distintos.
// Rechazos y alertas quedan en kiosco_geo_eventos para revisión (pestaña 🛡 Ubicación).
const GEO_DEFAULT = { precision_max_m: 100, antiguedad_max_s: 30, rechazar_precision_cero: true,
                      precision_en_computadora: false, velocidad_max_kmh: 120, distancia_min_viaje_km: 5 };
async function geoCfg() { return { ...GEO_DEFAULT, ...((await db.getConfig('geo_validacion', {})) || {}) }; }
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function geoEvento(w, accion, motivo, data, registroId) {
  try {
    await db.q('INSERT INTO kiosco_geo_eventos (id, worker_tid, worker_name, ts, accion, motivo, registro_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
               [uuidv4(), w.id, w.name, new Date().toISOString(), accion, motivo, registroId || null, JSON.stringify(data || {})]);
  } catch (e) { console.warn('[GEO] evento:', e.message); }
}
async function validarUbicacion(workerId, b, tipoDisp) {
  const w = await trabajadorPorId(workerId);
  if (!w) return { ok: false, error: 'Trabajador no encontrado' };
  if (w.homeOffice) return { ok: true, homeOffice: true, alertas: [] };          // Smart Work: la ubicación no se valida
  const cfg = await geoCfg();
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng), acc = (b.accuracy == null || b.accuracy === '') ? null : parseFloat(b.accuracy);
  const datos = { lat, lng, accuracy: acc, dispositivo: tipoDisp };
  const rechazo = async (motivo) => { await geoEvento(w, 'rechazado', motivo, datos); return { ok: false, error: motivo, geo_rechazo: true }; };
  if (isNaN(lat) || isNaN(lng)) return rechazo('No se recibió tu ubicación. Activa la ubicación del dispositivo e inténtalo de nuevo.');
  const esCompu = tipoDisp === 'computadora';
  if (!esCompu || cfg.precision_en_computadora) {
    if (acc == null || isNaN(acc)) return rechazo('No se recibió la precisión de tu ubicación. Actualiza la página e inténtalo de nuevo.');
    if (cfg.rechazar_precision_cero && acc <= 0) return rechazo('La ubicación recibida no es válida (precisión de 0 m). Desactiva cualquier aplicación de ubicación simulada.');
    if (acc > cfg.precision_max_m) return rechazo(`Tu ubicación no es lo bastante precisa (±${Math.round(acc)} m; máximo ±${cfg.precision_max_m} m). Activa el GPS o la "ubicación precisa" y vuelve a intentar al aire libre o cerca de una ventana.`);
  }
  // antigüedad: se mide con el reloj del propio dispositivo (geoTs vs clientNow): no influye su desfase
  const gts = parseFloat(b.geoTs), cnow = parseFloat(b.clientNow);
  if (!isNaN(gts) && !isNaN(cnow)) {
    const edad = (cnow - gts) / 1000;
    if (edad > cfg.antiguedad_max_s) return rechazo(`La ubicación tiene ${Math.round(edad)} s de antigüedad (máximo ${cfg.antiguedad_max_s} s). Vuelve a intentar.`);
  } else if (!esCompu) return rechazo('No se pudo verificar que tu ubicación sea actual. Actualiza la página e inténtalo de nuevo.');
  const locs = (await db.q('SELECT id, data FROM kiosco_ubicaciones')).rows.map(r => ({ id: r.id, ...r.data }));
  const permitidas = (w.locationIds && w.locationIds.length) ? locs.filter(l => w.locationIds.includes(l.id)) : locs;
  if (!permitidas.length) return rechazo('No tienes un punto de registro asignado. Contacta a tu supervisor.');
  let mejor = null;
  for (const l of permitidas) {
    const d = distanciaM(lat, lng, parseFloat(l.lat), parseFloat(l.lng));
    if (!mejor || d < mejor.d) mejor = { l, d };
  }
  const radio = parseFloat(mejor.l.radius || 150);
  const tolerancia = Math.min(acc == null || isNaN(acc) ? 0 : acc, 30);          // se toleran hasta 30 m de imprecisión
  if (mejor.d > radio + tolerancia)
    return rechazo(`Estás fuera del punto de registro "${mejor.l.name || ''}" (${Math.round(mejor.d)} m del centro; radio ${Math.round(radio)} m).`);
  const alertas = [];
  const ant = (await db.q(`SELECT ts, data FROM kiosco_registros WHERE worker_tid = $1 AND (data->>'lat') IS NOT NULL ORDER BY ts DESC LIMIT 1`, [workerId])).rows[0];
  if (ant && ant.data && ant.data.lat != null) {
    const dkm = distanciaM(lat, lng, parseFloat(ant.data.lat), parseFloat(ant.data.lng)) / 1000;
    const horas = Math.max((Date.now() - Date.parse(ant.ts)) / 3600000, 1 / 60);
    if (dkm >= cfg.distancia_min_viaje_km && dkm / horas > cfg.velocidad_max_kmh)
      alertas.push(`Viaje imposible: ${dkm.toFixed(1)} km desde el registro anterior en ${Math.round(horas * 60)} min (${Math.round(dkm / horas)} km/h)`);
  }
  const lat6 = lat.toFixed(6), lng6 = lng.toFixed(6), hoy = new Date().toISOString().slice(0, 10);
  // en computadoras (ubicación por Wi-Fi) es normal repetir el mismo punto: no se revisa
  const igual = esCompu ? null : (await db.q(`SELECT ts FROM kiosco_registros WHERE worker_tid = $1 AND data->>'lat' IS NOT NULL AND data->>'lat' <> ''
                              AND round((data->>'lat')::numeric, 6) = $2::numeric AND round((data->>'lng')::numeric, 6) = $3::numeric
                              AND substr(ts, 1, 10) <> $4 LIMIT 1`, [workerId, lat6, lng6, hoy])).rows[0];
  if (igual) alertas.push(`Coordenadas idénticas a un registro del ${igual.ts.slice(0, 10)} (${lat6}, ${lng6}): posible ubicación simulada`);
  return { ok: true, inGeofence: true, location: mejor.l, distancia_m: Math.round(mejor.d), alertas, w, datos };
}

// eventos de ubicación (rechazos y alertas) y configuración
app.get('/api/geo/eventos', aw(async (req, res) => {
  const params = [], cond = [];
  if (req.query.from) { params.push(new Date(req.query.from + 'T00:00:00-06:00').toISOString()); cond.push(`ts >= $${params.length}`); }
  if (req.query.to) { params.push(new Date(req.query.to + 'T23:59:59.999-06:00').toISOString()); cond.push(`ts <= $${params.length}`); }
  if (req.query.accion) { params.push(req.query.accion); cond.push(`accion = $${params.length}`); }
  const r = await db.q(`SELECT * FROM kiosco_geo_eventos ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY ts DESC LIMIT 1000`, params);
  res.json(r.rows);
}));
app.get('/api/geo/config', aw(async (req, res) => res.json(await geoCfg())));
app.put('/api/geo/config', aw(async (req, res) => {
  const b = req.body || {}, cfg = await geoCfg();
  for (const k of ['precision_max_m', 'antiguedad_max_s', 'velocidad_max_kmh', 'distancia_min_viaje_km'])
    if (k in b) { const v = parseFloat(b[k]); if (isNaN(v) || v <= 0) return res.status(400).json({ error: `Valor inválido: ${k}` }); cfg[k] = v; }
  for (const k of ['rechazar_precision_cero', 'precision_en_computadora']) if (k in b) cfg[k] = !!b[k];
  await db.setConfig('geo_validacion', cfg);
  res.json({ success: true, config: cfg });
}));

// ─── JOBS EN WIP DEL ERP (v2.15) ──────────────────────────────────────────────
// El kiosco lee la tabla `jobs` de la Suite (misma base de datos) y solo ofrece los Jobs
// con estatus WIP. "ADMIN" siempre está disponible para horas administrativas.
async function jobsWip() {
  const r = await db.q(`SELECT job_number, customer, data->>'description' AS descripcion, data->>'pm' AS pm
                        FROM jobs WHERE upper(trim(COALESCE(status, data->>'status', ''))) = 'WIP' ORDER BY job_number`);
  return r.rows.map(x => ({ job: String(x.job_number || '').trim().toUpperCase(), cliente: x.customer || '', descripcion: x.descripcion || '', pm: x.pm || '' }));
}
app.get('/api/jobs-wip', aw(async (req, res) => {
  try { res.json(await jobsWip()); }
  catch (e) { res.status(500).json({ error: 'No se pudo leer la lista de Jobs de la Suite: ' + e.message }); }
}));
async function validarJobHours(lista, total) {
  if (!Array.isArray(lista) || !lista.length)
    return { error: 'Antes de registrar tu salida debes repartir tus horas en ADMIN o en los Jobs que trabajaste.' };
  let wip = null;
  try { wip = new Set((await jobsWip()).map(j => j.job)); } catch (e) { wip = null; }   // si no se puede leer, no se bloquea
  const out = {}; let suma = 0;
  for (const it of lista) {
    const job = String((it && it.job) || '').trim().toUpperCase();
    const h = Math.round((parseFloat(it && it.hours) || 0) * 100) / 100;
    if (!job || h <= 0) continue;
    if (h > 24) return { error: `Horas inválidas en ${job}` };
    if (job !== 'ADMIN' && wip && !wip.has(job)) return { error: `El Job ${job} no está en WIP en la Suite. Elige un Job de la lista o usa ADMIN.` };
    out[job] = Math.round(((out[job] || 0) + h) * 100) / 100; suma += h;
  }
  suma = Math.round(suma * 100) / 100;
  if (suma <= 0) return { error: 'Las horas no pueden quedar en cero: asígnalas a ADMIN o a algún Job.' };
  const t = parseFloat(total);
  if (!isNaN(t) && t > 0 && suma > t + 0.01) return { error: `Las horas asignadas (${suma} h) exceden la jornada (${t} h).` };
  return { jobHours: Object.entries(out).map(([job, hours]) => ({ job, hours })) };
}

app.post('/api/records', aw(async (req, res) => {
  const b = { ...req.body };
  const id = uuidv4(), ts = new Date().toISOString();
  const workerId = String(b.workerId || ''), workerName = b.workerName || '', tipo = b.type || '';
  delete b.id; delete b.workerId; delete b.workerName; delete b.type; delete b.timestamp;
  if (!workerId) return res.status(400).json({ error: 'Falta identificar al trabajador' });
  if (!['entrada', 'salida'].includes(tipo)) return res.status(400).json({ error: 'Tipo de registro inválido' });
  // v2.15: la SALIDA solo se asienta junto con la distribución de horas por Job (ADMIN o Jobs en WIP del ERP)
  if (tipo === 'salida') {
    const v = await validarJobHours(b.jobHours, b.totalHours);
    if (v.error) return res.status(400).json({ error: v.error, requiere_horas: true });
    b.jobHours = v.jobHours;
  } else delete b.jobHours;
  // v2.6: dispositivo autorizado (y celular, si así se configuró) + tipo de dispositivo en el registro
  const ver = await verificarDispositivo(req, workerId, b.deviceId, b.deviceInfo);
  delete b.deviceId; delete b.deviceInfo;
  if (ver.estado === 'pendiente' || ver.estado === 'rechazado')
    return res.status(403).json({ error: ver.mensaje || 'Dispositivo no autorizado', dispositivo_estado: ver.estado });
  b.dispositivo = { tipo: ver.dispositivo.tipo, os: ver.dispositivo.os, navegador: ver.dispositivo.navegador, autorizado: ver.estado === 'autorizado' };
  // v2.17: la ubicación la valida el servidor (no se confía en el navegador)
  const geo = await validarUbicacion(workerId, b, ver.dispositivo.tipo);
  if (!geo.ok) return res.status(403).json({ error: geo.error, geo_rechazo: !!geo.geo_rechazo });
  if (!geo.homeOffice) {
    b.inGeofence = true; b.locationId = geo.location.id; b.locationName = geo.location.name || b.locationName;
    b.geo = { distancia_m: geo.distancia_m, accuracy: geo.datos.accuracy, validado_servidor: true, alertas: geo.alertas };
  }
  delete b.geoTs; delete b.clientNow;
  // v2.10: trabajador en Smart Work → el registro se marca así (la ubicación no se valida)
  { const wHO = await trabajadorPorId(workerId); b.homeOffice = !!(wHO && wHO.homeOffice); if (b.homeOffice) { b.inGeofence = false; b.locationName = 'Smart Work'; b.locationId = null; } }
  if (geo.alertas && geo.alertas.length) for (const a of geo.alertas) await geoEvento(geo.w, 'alerta', a, { ...geo.datos, tipo }, id);
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
    // v2.9: no se puede checar salida con una pausa abierta
    if (tipo === 'salida') {
      const ep = await estadoPausa(c, workerId);
      if (ep.abierta) return { status: 409, body: { error: 'Tienes una pausa/comida abierta: termínala antes de registrar tu salida.', pausa_abierta: true } };
    }
    await c.query('INSERT INTO kiosco_registros (id, worker_tid, worker_name, tipo, ts, data) VALUES ($1,$2,$3,$4,$5,$6)',
                  [id, workerId, workerName, tipo, ts, JSON.stringify(b)]);
    return { status: 200, body: { success: true, record: { ...b, id, workerId, workerName, type: tipo, timestamp: ts } } };
  });
  res.status(resultado.status).json(resultado.body);
}));

// ─── PAUSAS / COMIDA (v2.9) ──────────────────────────────────────────────────
// Solo viven en el kiosco (tabla kiosco_pausas); la Suite no las lee. Se pueden
// registrar únicamente entre una Entrada y su Salida; se alternan inicio → fin; con una
// pausa abierta no se puede checar Salida. No descuentan horas de la jornada.
async function estadoPausa(c, workerId) {
  const ent = (await c.query(`SELECT id, tipo, ts FROM kiosco_registros WHERE worker_tid = $1 ORDER BY ts DESC LIMIT 1`, [workerId])).rows[0];
  if (!ent || ent.tipo !== 'entrada') return { jornada_abierta: false, abierta: false };
  const ult = (await c.query(`SELECT * FROM kiosco_pausas WHERE worker_tid = $1 AND ts >= $2 ORDER BY ts DESC LIMIT 1`, [workerId, ent.ts])).rows[0];
  const n = (await c.query(`SELECT count(*)::int AS n FROM kiosco_pausas WHERE worker_tid = $1 AND ts >= $2 AND tipo = 'inicio'`, [workerId, ent.ts])).rows[0].n;
  return { jornada_abierta: true, entrada_id: ent.id, entrada_ts: ent.ts, abierta: !!(ult && ult.tipo === 'inicio'),
           inicio_ts: ult && ult.tipo === 'inicio' ? ult.ts : null, pausas_en_jornada: n };
}

app.get('/api/pausas/estado', aw(async (req, res) => {
  const workerId = String(req.query.workerId || '');
  if (!workerId) return res.status(400).json({ error: 'Falta el trabajador' });
  const c = await db.pool.connect();
  try { res.json(await estadoPausa(c, workerId)); } finally { c.release(); }
}));

app.post('/api/pausas', aw(async (req, res) => {
  const b = { ...req.body };
  const workerId = String(b.workerId || ''), workerName = b.workerName || '', tipo = b.type || '';
  if (!workerId) return res.status(400).json({ error: 'Falta identificar al trabajador' });
  if (!['inicio', 'fin'].includes(tipo)) return res.status(400).json({ error: 'Tipo de pausa inválido' });
  const ver = await verificarDispositivo(req, workerId, b.deviceId, b.deviceInfo);
  if (ver.estado === 'pendiente' || ver.estado === 'rechazado')
    return res.status(403).json({ error: ver.mensaje || 'Dispositivo no autorizado', dispositivo_estado: ver.estado });
  const geo = await validarUbicacion(workerId, b, ver.dispositivo.tipo);                 // v2.17
  if (!geo.ok) return res.status(403).json({ error: geo.error, geo_rechazo: !!geo.geo_rechazo });
  if (!geo.homeOffice) { b.inGeofence = true; b.locationId = geo.location.id; b.locationName = geo.location.name || b.locationName; }
  const id = uuidv4(), ts = new Date().toISOString();
  if (geo.alertas && geo.alertas.length) for (const a of geo.alertas) await geoEvento(geo.w, 'alerta', a, { ...geo.datos, tipo: 'pausa ' + tipo }, id);
  const resultado = await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kiosco-registro:' + workerId]);   // mismo candado que entrada/salida
    const ep = await estadoPausa(c, workerId);
    if (!ep.jornada_abierta) return { status: 409, body: { error: 'Primero registra tu Entrada: la pausa solo se puede marcar dentro de la jornada.' } };
    if (tipo === 'inicio' && ep.abierta) return { status: 409, body: { error: 'Ya tienes una pausa abierta: termínala primero.', estado: ep } };
    if (tipo === 'fin' && !ep.abierta) return { status: 409, body: { error: 'No tienes una pausa abierta.', estado: ep } };
    const data = { lat: b.lat ?? null, lng: b.lng ?? null, locationId: b.locationId || null, locationName: b.locationName || null,
                   inGeofence: !!b.inGeofence, dispositivo: { tipo: ver.dispositivo.tipo, os: ver.dispositivo.os, navegador: ver.dispositivo.navegador } };
    { const wHO = await trabajadorPorId(workerId); if (wHO && wHO.homeOffice) { data.homeOffice = true; data.inGeofence = false; data.locationName = 'Smart Work'; data.locationId = null; } }   // v2.10
    if (tipo === 'fin') data.inicio_ts = ep.inicio_ts;
    await c.query('INSERT INTO kiosco_pausas (id, worker_tid, worker_name, tipo, ts, entrada_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                  [id, workerId, workerName, tipo, ts, ep.entrada_id, JSON.stringify(data)]);
    return { status: 200, body: { success: true, pausa: { id, tipo, ts }, estado: await estadoPausa(c, workerId) } };
  });
  res.status(resultado.status).json(resultado.body);
}));

// Consulta (administrador / RRHH): pausas emparejadas inicio → fin, con duración
async function listarPausas({ from, to, workerId }) {
  const params = [], cond = [];
  if (workerId) { params.push(workerId); cond.push(`p.worker_tid = $${params.length}`); }
  if (from) { params.push(new Date(from + 'T00:00:00-06:00').toISOString()); cond.push(`p.ts >= $${params.length}`); }
  if (to) { params.push(new Date(to + 'T23:59:59.999-06:00').toISOString()); cond.push(`p.ts <= $${params.length}`); }
  const r = await db.q(`SELECT p.*, COALESCE(per.nombre, p.worker_name) AS nombre, per.area
                        FROM kiosco_pausas p LEFT JOIN personal per ON per.tid = p.worker_tid
                        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY p.worker_tid, p.ts`, params);
  const out = [], abiertas = {};
  for (const x of r.rows) {
    if (x.tipo === 'inicio') {
      const fila = { worker_tid: x.worker_tid, nombre: x.nombre, area: x.area || '', inicio: x.ts, fin: null, minutos: null,
                     ubicacion: (x.data || {}).locationName || '', dispositivo: ((x.data || {}).dispositivo || {}).tipo || '', inicio_id: x.id };
      out.push(fila); abiertas[x.worker_tid] = fila;
    } else {
      const f = abiertas[x.worker_tid];
      if (f && !f.fin) { f.fin = x.ts; f.minutos = Math.round((Date.parse(x.ts) - Date.parse(f.inicio)) / 60000); f.fin_id = x.id; delete abiertas[x.worker_tid]; }
      else out.push({ worker_tid: x.worker_tid, nombre: x.nombre, area: x.area || '', inicio: (x.data || {}).inicio_ts || null, fin: x.ts,
                      minutos: (x.data || {}).inicio_ts ? Math.round((Date.parse(x.ts) - Date.parse(x.data.inicio_ts)) / 60000) : null,
                      ubicacion: (x.data || {}).locationName || '', dispositivo: ((x.data || {}).dispositivo || {}).tipo || '', fin_id: x.id });
    }
  }
  return out.sort((a, b) => String(b.inicio || b.fin).localeCompare(String(a.inicio || a.fin)));
}

app.get('/api/pausas', aw(async (req, res) => {
  res.json({ pausas: await listarPausas(req.query) });
}));

app.get('/api/pausas/export', aw(async (req, res) => {
  const filas = await listarPausas(req.query);
  const loc = (iso) => iso ? new Date(iso).toLocaleString('es-MX', { timeZone: TZ_LOCAL }) : '';
  const ws = XLSX.utils.json_to_sheet(filas.map(f => ({
    'Trabajador': f.nombre, 'ID': f.worker_tid, 'Área': f.area, 'Fecha': f.inicio ? new Date(f.inicio).toLocaleDateString('es-MX', { timeZone: TZ_LOCAL }) : '',
    'Inicio': loc(f.inicio), 'Fin': f.fin ? loc(f.fin) : '(abierta)', 'Minutos': f.minutos ?? '', 'Ubicación': f.ubicacion, 'Dispositivo': f.dispositivo })));
  ws['!cols'] = [{ wch: 34 }, { wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 22 }, { wch: 22 }, { wch: 9 }, { wch: 22 }, { wch: 12 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Pausas');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="pausas_${req.query.from || ''}_${req.query.to || ''}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

// ─── IMPORTAR REGISTROS DEL KIOSCO DE CONTINGENCIA (v2.12) ───────────────────
// CSV descargado del kiosco de contingencia (id, nombre, tipo, fecha_hora_utc, …).
// Se relaciona cada nombre con un trabajador de Control de Personal; las salidas calculan
// sus horas contra la entrada anterior (como el kiosco). No se duplica: cada renglón guarda
// su id de contingencia.
function csvParse(txt) {
  const filas = []; let fila = [], campo = '', q = false;
  txt = String(txt || '').replace(/^\ufeff/, '');
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  const enc = (filas.shift() || []).map(h => h.trim().toLowerCase());
  return filas.filter(f => f.some(v => v.trim())).map(f => Object.fromEntries(enc.map((h, i) => [h, (f[i] || '').trim()])));
}
const normNombre = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
function horasSalida(entradaIso, salidaIso) {
  const diff = Date.parse(salidaIso) - Date.parse(entradaIso);
  if (!(diff > 0 && diff < 36 * 3600000)) return { totalHours: diff <= 0 ? 0 : null, baseHours: diff <= 0 ? 0 : null, extraHours: diff <= 0 ? 0 : null };
  const total = Math.round(diff / 36000) / 100;
  const dow = new Date(new Date(entradaIso).toLocaleString('en-US', { timeZone: TZ_LOCAL })).getDay();
  const lim = dow >= 1 && dow <= 4 ? 10 : dow === 5 ? 8 : 0;
  return dow === 0 || dow === 6 ? { totalHours: total, baseHours: 0, extraHours: total }
                                : { totalHours: total, baseHours: Math.min(total, lim), extraHours: Math.max(0, Math.round((total - lim) * 100) / 100) };
}

app.post('/api/contingencia/importar', aw(async (req, res) => {
  const { csv, aplicar, mapeo } = req.body || {};
  const filas = csvParse(csv);
  if (!filas.length) return res.status(400).json({ error: 'El archivo no tiene registros' });
  if (!('nombre' in filas[0]) || !('tipo' in filas[0]) || !('fecha_hora_utc' in filas[0]))
    return res.status(400).json({ error: 'No es el CSV del kiosco de contingencia (faltan las columnas nombre, tipo, fecha_hora_utc)' });
  const trab = await listarTrabajadores();
  const porNombre = {};
  for (const n of [...new Set(filas.map(f => f.nombre.toUpperCase()))]) {
    if (mapeo && mapeo[n]) { porNombre[n] = trab.find(w => w.id === mapeo[n]) || null; continue; }
    const t = normNombre(n), tk = t.join(' ');
    let w = trab.find(x => normNombre(x.name).join(' ') === tk)
         || trab.find(x => { const xs = new Set(normNombre(x.name)); return t.length >= 2 && t.every(p => xs.has(p)); });
    porNombre[n] = w || null;
  }
  const ya = new Set((await db.q(`SELECT data->>'contingencia_id' AS cid FROM kiosco_registros WHERE data ? 'contingencia_id'`)).rows.map(r => r.cid));
  const vista = filas.map(f => ({ id: f.id, nombre: f.nombre.toUpperCase(), tipo: f.tipo, ts: f.fecha_hora_utc, lat: f.lat, lng: f.lng, dispositivo: f.dispositivo,
                                  trabajador: porNombre[f.nombre.toUpperCase()] ? { id: porNombre[f.nombre.toUpperCase()].id, name: porNombre[f.nombre.toUpperCase()].name } : null,
                                  duplicado: ya.has(f.id), valido: ['entrada', 'salida'].includes(f.tipo) && !isNaN(Date.parse(f.fecha_hora_utc)) }));
  if (!aplicar) return res.json({ vista, nombres: Object.fromEntries(Object.entries(porNombre).map(([k, w]) => [k, w ? { id: w.id, name: w.name } : null])),
                                  trabajadores: trab.map(w => ({ id: w.id, name: w.name })) });
  const aInsertar = vista.filter(v => v.valido && v.trabajador && !v.duplicado).sort((a, b) => a.ts.localeCompare(b.ts));
  let n = 0;
  await db.tx(async (c) => {
    for (const v of aInsertar) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kiosco-registro:' + v.trabajador.id]);
      let horas = {};
      if (v.tipo === 'salida') {
        const ent = (await c.query(`SELECT ts FROM kiosco_registros WHERE worker_tid = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1`, [v.trabajador.id, v.ts])).rows[0];
        const entTipo = ent ? (await c.query(`SELECT tipo FROM kiosco_registros WHERE worker_tid = $1 AND ts = $2 LIMIT 1`, [v.trabajador.id, ent.ts])).rows[0].tipo : null;
        if (ent && entTipo === 'entrada') horas = horasSalida(ent.ts, v.ts);
      }
      const data = { workerId: v.trabajador.id, workerName: v.trabajador.name, type: v.tipo, timestamp: v.ts,
                     lat: v.lat ? Number(v.lat) : null, lng: v.lng ? Number(v.lng) : null, locationId: null, locationName: 'Contingencia (desde casa)',
                     inGeofence: false, homeOffice: true, origen: 'contingencia', contingencia_id: v.id,
                     dispositivo: { tipo: v.dispositivo || '', os: '', navegador: '', autorizado: false }, ...horas };
      await c.query('INSERT INTO kiosco_registros (id, worker_tid, worker_name, tipo, ts, data) VALUES ($1,$2,$3,$4,$5,$6)',
                    [uuidv4(), v.trabajador.id, v.trabajador.name, v.tipo, v.ts, JSON.stringify(data)]);
      n++;
    }
  });
  res.json({ ok: true, importados: n, omitidos: vista.length - n,
             sin_trabajador: vista.filter(v => !v.trabajador).length, duplicados: vista.filter(v => v.duplicado).length });
}));

// ─── REGISTRO MANUAL (v2.16) — solo el administrador, con su contraseña ─────────
// Para entradas/salidas que no se registraron (olvido, falla de red o dispositivo). Se
// valida que la secuencia quede Entrada → Salida alrededor de la fecha elegida; la salida
// calcula sus horas contra la entrada anterior y exige la distribución por Job.
app.post('/api/records/manual', aw(async (req, res) => {
  const b = req.body || {};
  const r = await db.q('SELECT * FROM kiosco_usuarios WHERE username = $1', [String(b.adminUser || '')]);
  const u = r.rows[0];
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador del sistema puede agregar registros manuales.' });
  if (!(await bcrypt.compare(String(b.password || ''), u.password_hash))) {
    console.warn(`[MANUAL] contraseña incorrecta de ${u.username}`);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const workerId = String(b.workerId || ''), tipo = b.type;
  if (!workerId) return res.status(400).json({ error: 'Elige el trabajador' });
  if (!['entrada', 'salida'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  const motivo = String(b.motivo || '').trim();
  if (motivo.length < 5) return res.status(400).json({ error: 'Escribe el motivo del registro manual' });
  const f = new Date(b.timestamp || '');
  if (isNaN(f)) return res.status(400).json({ error: 'Fecha y hora inválidas' });
  if (f.getTime() > Date.now() + 60000) return res.status(400).json({ error: 'No se pueden registrar fechas futuras' });
  const ts = f.toISOString();
  const w = await trabajadorPorId(workerId);
  if (!w) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const resultado = await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['kiosco-registro:' + workerId]);
    const ant = (await c.query('SELECT id, tipo, ts FROM kiosco_registros WHERE worker_tid = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1', [workerId, ts])).rows[0];
    const sig = (await c.query('SELECT id, tipo, ts FROM kiosco_registros WHERE worker_tid = $1 AND ts > $2 ORDER BY ts ASC LIMIT 1', [workerId, ts])).rows[0];
    const fmt = (x) => new Date(x.ts).toLocaleString('es-MX', { timeZone: TZ_LOCAL });
    if (tipo === 'entrada' && ant && ant.tipo === 'entrada')
      return { status: 409, body: { error: `Antes de esa hora ya hay una Entrada (${fmt(ant)}) sin salida. Registra primero esa salida.` } };
    if (tipo === 'salida' && (!ant || ant.tipo !== 'entrada'))
      return { status: 409, body: { error: ant ? `El registro anterior (${fmt(ant)}) es una Salida: falta su Entrada.` : 'No hay una Entrada anterior para esta Salida.' } };
    if (sig && sig.tipo === tipo)
      return { status: 409, body: { error: `Después de esa hora ya hay una ${tipo === 'entrada' ? 'Entrada' : 'Salida'} (${fmt(sig)}). La secuencia quedaría duplicada.` } };
    const data = { lat: null, lng: null, locationId: null, locationName: 'Registro manual', inGeofence: false,
                   origen: 'manual', manual: { por: u.username, nombre: u.name, motivo, registrado: new Date().toISOString() },
                   dispositivo: { tipo: 'manual', os: '', navegador: '', autorizado: true } };
    if (tipo === 'salida') {
      const horas = horasSalida(ant.ts, ts);
      Object.assign(data, horas);
      const v = await validarJobHours(b.jobHours, horas.totalHours);
      if (v.error) return { status: 400, body: { error: v.error, requiere_horas: true, totalHours: horas.totalHours } };
      data.jobHours = v.jobHours;
    }
    const id = uuidv4();
    await c.query('INSERT INTO kiosco_registros (id, worker_tid, worker_name, tipo, ts, data) VALUES ($1,$2,$3,$4,$5,$6)',
                  [id, workerId, w.name, tipo, ts, JSON.stringify(data)]);
    console.log(`[MANUAL] ${u.username} agregó ${tipo} de ${w.name} (${ts}): ${motivo}`);
    return { status: 200, body: { success: true, record: { id, workerId, workerName: w.name, type: tipo, timestamp: ts, ...data } } };
  });
  res.status(resultado.status).json(resultado.body);
}));

// horas de la jornada para una salida manual (para mostrarlas antes de guardar)
app.get('/api/records/manual/horas', aw(async (req, res) => {
  const { workerId, timestamp } = req.query;
  const f = new Date(timestamp || ''); if (!workerId || isNaN(f)) return res.json({ totalHours: null });
  const ant = (await db.q("SELECT tipo, ts FROM kiosco_registros WHERE worker_tid = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1", [workerId, f.toISOString()])).rows[0];
  if (!ant || ant.tipo !== 'entrada') return res.json({ totalHours: null, sin_entrada: true });
  res.json({ ...horasSalida(ant.ts, f.toISOString()), entrada: ant.ts });
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
      'Dentro de Geocerca': r.homeOffice ? 'Smart Work' : (r.inGeofence ? 'Sí' : 'No')
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
  // v2.14: "Home office" ahora se llama "Smart Work" — se actualiza la ubicación de los registros anteriores
  try {
    const a = await db.q(`UPDATE kiosco_registros SET data = jsonb_set(data, '{locationName}', '"Smart Work"') WHERE data->>'locationName' = 'Home office'`);
    const b = await db.q(`UPDATE kiosco_pausas SET data = jsonb_set(data, '{locationName}', '"Smart Work"') WHERE data->>'locationName' = 'Home office'`);
    if (a.rowCount || b.rowCount) console.log(`Smart Work: ${a.rowCount} registro(s) y ${b.rowCount} pausa(s) renombrados`);
  } catch (e) { console.warn('Renombrar Home office → Smart Work:', e.message); }
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
