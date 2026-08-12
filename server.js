const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';
const SUITE_URL = (process.env.SUITE_URL || '').replace(/\/$/, '');

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORKERS_FILE = path.join(DATA_DIR, 'workers.json');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const SIGNATURES_FILE = path.join(DATA_DIR, 'signatures.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Initialize data files with defaults
function initFile(filePath, defaultData) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
}

initFile(USERS_FILE, [
  { id: '1', username: 'admin', password: 'admin123', role: 'admin', name: 'Administrador' },
  { id: '2', username: 'rrhh', password: 'rrhh123', role: 'rrhh', name: 'Recursos Humanos' }
]);
initFile(WORKERS_FILE, []);
initFile(LOCATIONS_FILE, []);
initFile(RECORDS_FILE, []);
initFile(SIGNATURES_FILE, []);
initFile(NOTIFICATIONS_FILE, [
  { name: '', phone: '', apikey: '', active: false },
  { name: '', phone: '', apikey: '', active: false },
  { name: '', phone: '', apikey: '', active: false },
  { name: '', phone: '', apikey: '', active: false },
  { name: '', phone: '', apikey: '', active: false },
]);

// Helpers
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
  const { password: _, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

// ─── USERS CRUD ───────────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const users = readJSON(USERS_FILE).map(({ password: _, ...u }) => u);
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const users = readJSON(USERS_FILE);
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Nombre, usuario y contraseña son requeridos' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'El nombre de usuario ya existe' });
  const user = { id: uuidv4(), name, username, password, role: role || 'worker', createdAt: new Date().toISOString() };
  users.push(user);
  writeJSON(USERS_FILE, users);
  const { password: _, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

app.put('/api/users/:id', (req, res) => {
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { name, username, password, role } = req.body;
  // Check username collision with other users
  if (username && users.find(u => u.username === username && u.id !== req.params.id)) {
    return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
  }
  users[idx] = {
    ...users[idx],
    ...(name && { name }),
    ...(username && { username }),
    ...(password && { password }),  // only update if provided
    ...(role && { role })
  };
  writeJSON(USERS_FILE, users);
  const { password: _, ...safeUser } = users[idx];
  res.json({ success: true, user: safeUser });
});

app.delete('/api/users/:id', (req, res) => {
  let users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  // Prevent deleting the last admin
  const admins = users.filter(u => u.role === 'admin');
  if (user.role === 'admin' && admins.length <= 1) {
    return res.status(400).json({ error: 'No puedes eliminar el único administrador del sistema' });
  }
  users = users.filter(u => u.id !== req.params.id);
  writeJSON(USERS_FILE, users);
  res.json({ success: true });
});

// ─── WORKERS ─────────────────────────────────────────────────────────────────
app.get('/api/workers', (req, res) => res.json(readJSON(WORKERS_FILE)));

app.post('/api/workers', (req, res) => {
  const workers = readJSON(WORKERS_FILE);
  const worker = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString() };
  workers.push(worker);
  writeJSON(WORKERS_FILE, workers);
  res.json({ success: true, worker });
});

app.put('/api/workers/:id', (req, res) => {
  const workers = readJSON(WORKERS_FILE);
  const idx = workers.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Trabajador no encontrado' });
  workers[idx] = { ...workers[idx], ...req.body };
  writeJSON(WORKERS_FILE, workers);
  res.json({ success: true, worker: workers[idx] });
});

app.delete('/api/workers/:id', (req, res) => {
  let workers = readJSON(WORKERS_FILE);
  workers = workers.filter(w => w.id !== req.params.id);
  writeJSON(WORKERS_FILE, workers);
  res.json({ success: true });
});

// Upload workers via Excel
app.post('/api/workers/upload', upload.single('file'), (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const workers = readJSON(WORKERS_FILE);
    const added = [];
    rows.forEach(row => {
      const locRaw = row['Ubicaciones'] || row['ubicaciones'] || row['Ubicacion'] || row['ubicacion'] || '';
      const locationIds = String(locRaw).split(',').map(s => s.trim()).filter(Boolean);
      const worker = {
        id: uuidv4(),
        name: row['Nombre'] || row['nombre'] || '',
        position: row['Puesto'] || row['puesto'] || '',
        shift: row['Jornada'] || row['jornada'] || '07:00-17:00',
        locationIds,
        locationId: locationIds[0] || '',
        createdAt: new Date().toISOString()
      };
      if (worker.name) { workers.push(worker); added.push(worker); }
    });
    writeJSON(WORKERS_FILE, workers);
    res.json({ success: true, added: added.length, workers: added });
  } catch (e) {
    res.status(400).json({ error: 'Error al procesar el archivo: ' + e.message });
  }
});

// Download workers template
app.get('/api/workers/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Nombre', 'Puesto', 'Jornada', 'Ubicaciones (separar con coma si son varias)'],
    ['Juan Pérez', 'Técnico', '07:00-17:00', 'Planta Norte'],
    ['María López', 'Supervisor', '08:00-18:00', 'Planta Norte, Planta Sur']
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 15 }, { wch: 45 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Trabajadores');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_trabajadores.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// ─── SYNC WITH PERSICO SUITE ─────────────────────────────────────────────────
// Persico Suite (Control de Personal) es la fuente de verdad de trabajadores.
// Este endpoint recibe la lista completa de trabajadores activos y hace upsert
// por "externalId" (el tid de la Suite), SIN tocar shift/locationId (config
// propia de esta app), y SIN borrar históricos: a los que ya no vienen en la
// lista los marca inactive=true en vez de eliminarlos (sus records se conservan).
function requireSyncKey(req, res, next) {
  if (!SYNC_API_KEY) return res.status(500).json({ error: 'SYNC_API_KEY no configurada en el servidor' });
  const key = req.headers['x-sync-key'];
  if (key !== SYNC_API_KEY) return res.status(401).json({ error: 'Clave de sincronización inválida' });
  next();
}

app.post('/api/workers/sync', requireSyncKey, (req, res) => {
  const incoming = Array.isArray(req.body.workers) ? req.body.workers : [];
  const workers = readJSON(WORKERS_FILE);
  const incomingIds = new Set(incoming.map(w => w.externalId).filter(Boolean));

  let created = 0, updated = 0, deactivated = 0;

  incoming.forEach(src => {
    if (!src.externalId || !src.name) return;
    const idx = workers.findIndex(w => w.externalId === src.externalId);
    if (idx === -1) {
      workers.push({
        id: uuidv4(),
        externalId: src.externalId,
        name: src.name,
        position: src.position || '',
        area: src.area || '',
        shift: '07:00-17:00',
        locationIds: [],
        locationId: '',
        active: true,
        createdAt: new Date().toISOString(),
      });
      created++;
    } else {
      workers[idx].name = src.name;
      workers[idx].position = src.position || workers[idx].position;
      workers[idx].area = src.area || workers[idx].area;
      workers[idx].active = true;
      updated++;
    }
  });

  // Trabajadores con externalId que ya no vienen en la lista de la Suite (dados de baja / eliminados) → inactive
  workers.forEach(w => {
    if (w.externalId && !incomingIds.has(w.externalId) && w.active !== false) {
      w.active = false;
      deactivated++;
    }
  });

  writeJSON(WORKERS_FILE, workers);
  res.json({ success: true, created, updated, deactivated, total: workers.length });
});

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
  try { destinos = readJSON(NOTIFICATIONS_FILE); } catch (e) { destinos = []; }
  const activos = destinos.filter(d => d.active && d.phone && d.apikey);
  if (!activos.length) return;

  const texto = `🔔 Persico Suite\nNueva solicitud de permiso:\n👤 ${worker.name}\n📋 Tipo: ${body.tipo}\n📅 Periodo: ${periodoTexto(body)}\n\nRevisa y autoriza en la Suite → Recursos Humanos → Permisos.`;
  const encoded = encodeURIComponent(texto);

  for (const d of activos) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(d.phone)}&text=${encoded}&apikey=${encodeURIComponent(d.apikey)}`;
    fetch(url).catch(e => console.error(`[WhatsApp] Error notificando a ${d.name || d.phone}:`, e.message));
  }
}

app.get('/api/notifications', (req, res) => res.json(readJSON(NOTIFICATIONS_FILE)));

app.put('/api/notifications', (req, res) => {
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
  writeJSON(NOTIFICATIONS_FILE, clean);
  res.json({ success: true });
});

app.post('/api/notifications/test/:index', async (req, res) => {
  const destinos = readJSON(NOTIFICATIONS_FILE);
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
});

app.post('/api/permisos', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const { workerId, tipo, modalidad, fecha_inicio, fecha_fin, fecha, hora_inicio, hora_fin, motivo } = req.body;
  if (!workerId) return res.status(400).json({ error: 'Falta identificar al trabajador' });

  const workers = readJSON(WORKERS_FILE);
  const worker = workers.find(w => w.id === workerId);
  if (!worker) return res.status(404).json({ error: 'Trabajador no encontrado' });
  if (!worker.externalId) return res.status(400).json({ error: 'Tu usuario aún no está vinculado con Recursos Humanos. Contacta a RRHH.' });

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
});

app.get('/api/permisos/:workerId', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const workers = readJSON(WORKERS_FILE);
  const worker = workers.find(w => w.id === req.params.workerId);
  if (!worker) return res.status(404).json({ error: 'Trabajador no encontrado' });
  if (!worker.externalId) return res.json([]); // aún sin vincular: no hay historial que mostrar

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
});

// ─── ÓRDENES DE SERVICIO (solo lectura + avance, hacia Persico Suite) ────────
function _osWorkerOrError(req, res) {
  const workerId = req.query.workerId || (req.body && req.body.workerId);
  if (!workerId) { res.status(400).json({ error: 'Falta identificar al trabajador' }); return null; }
  const workers = readJSON(WORKERS_FILE);
  const worker = workers.find(w => w.id === workerId);
  if (!worker) { res.status(404).json({ error: 'Trabajador no encontrado' }); return null; }
  if (!worker.externalId) { res.status(400).json({ error: 'Tu usuario aún no está vinculado con Recursos Humanos. Contacta a RRHH.' }); return null; }
  return worker;
}

app.get('/api/ordenes-servicio', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

app.get('/api/ordenes-servicio/:id', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

app.put('/api/ordenes-servicio/:id', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

app.get('/api/ordenes-servicio/:id/pdf', async (req, res) => {
  if (!SUITE_URL) return res.status(500).send('SUITE_URL no está configurada en el servidor');
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

// ─── TAREAS ASIGNADAS (solo lectura + avance, hacia Persico Suite) ───────────
app.get('/api/tareas', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

app.get('/api/tareas/:id', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

app.put('/api/tareas/:id', async (req, res) => {
  if (!SUITE_URL) return res.status(500).json({ error: 'SUITE_URL no está configurada en el servidor' });
  const worker = _osWorkerOrError(req, res); if (!worker) return;
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
});

// ─── LOCATIONS ───────────────────────────────────────────────────────────────
app.get('/api/locations', (req, res) => res.json(readJSON(LOCATIONS_FILE)));

app.post('/api/locations', (req, res) => {
  const locations = readJSON(LOCATIONS_FILE);
  const location = { id: uuidv4(), radius: 150, ...req.body, createdAt: new Date().toISOString() };
  locations.push(location);
  writeJSON(LOCATIONS_FILE, locations);
  res.json({ success: true, location });
});

app.put('/api/locations/:id', (req, res) => {
  const locations = readJSON(LOCATIONS_FILE);
  const idx = locations.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Ubicación no encontrada' });
  locations[idx] = { ...locations[idx], ...req.body };
  writeJSON(LOCATIONS_FILE, locations);
  res.json({ success: true, location: locations[idx] });
});

app.delete('/api/locations/:id', (req, res) => {
  let locations = readJSON(LOCATIONS_FILE);
  locations = locations.filter(l => l.id !== req.params.id);
  writeJSON(LOCATIONS_FILE, locations);
  res.json({ success: true });
});

// ─── SIGNATURES ──────────────────────────────────────────────────────────────
// A signature is keyed by: { reportKey, type }
// reportKey = e.g. "ctrl:2026-W25" or "ctrl:2026-06" — built by the client
app.get('/api/signatures', (req, res) => {
  const sigs = readJSON(SIGNATURES_FILE);
  const { reportKey } = req.query;
  const result = reportKey ? sigs.filter(s => s.reportKey === reportKey) : sigs;
  res.json(result);
});

app.post('/api/signatures', (req, res) => {
  const { reportKey, type, signerName, signerUsername, password } = req.body;
  if (!reportKey || !type || !password) return res.status(400).json({ error: 'Datos incompletos' });

  // Verify password
  const users = readJSON(USERS_FILE);
  const user  = users.find(u => u.username === signerUsername && u.password === password);
  if (!user) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const sigs = readJSON(SIGNATURES_FILE);
  // Upsert: one signature per reportKey+type
  const existing = sigs.findIndex(s => s.reportKey === reportKey && s.type === type);
  const sig = { id: uuidv4(), reportKey, type, signerName, signerUsername, signedAt: new Date().toISOString() };
  if (existing >= 0) sigs[existing] = sig; else sigs.push(sig);
  writeJSON(SIGNATURES_FILE, sigs);
  res.json({ success: true, signature: sig });
});

app.delete('/api/signatures/:id', (req, res) => {
  let sigs = readJSON(SIGNATURES_FILE);
  sigs = sigs.filter(s => s.id !== req.params.id);
  writeJSON(SIGNATURES_FILE, sigs);
  res.json({ success: true });
});

// ─── RECORDS ─────────────────────────────────────────────────────────────────
app.get('/api/records', (req, res) => {
  let records = readJSON(RECORDS_FILE);
  const { workerId, from, to } = req.query;
  if (workerId) records = records.filter(r => r.workerId === workerId);
  if (from) records = records.filter(r => r.timestamp >= from);
  if (to) records = records.filter(r => r.timestamp <= to);
  res.json(records);
});

app.post('/api/records', (req, res) => {
  const records = readJSON(RECORDS_FILE);
  const record = { id: uuidv4(), ...req.body, timestamp: new Date().toISOString() };
  records.push(record);
  writeJSON(RECORDS_FILE, records);
  res.json({ success: true, record });
});

// Patch a record (used to add jobHours after salida, or admin edit)
app.patch('/api/records/:id', (req, res) => {
  const records = readJSON(RECORDS_FILE);
  const idx = records.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Registro no encontrado' });
  records[idx] = { ...records[idx], ...req.body };
  writeJSON(RECORDS_FILE, records);
  res.json({ success: true, record: records[idx] });
});

// Delete a record (admin only)
app.delete('/api/records/:id', (req, res) => {
  let records = readJSON(RECORDS_FILE);
  const exists = records.find(r => r.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'Registro no encontrado' });
  records = records.filter(r => r.id !== req.params.id);
  writeJSON(RECORDS_FILE, records);
  res.json({ success: true });
});

// Download records as Excel
app.get('/api/records/export', (req, res) => {
  let records = readJSON(RECORDS_FILE);
  const workers = readJSON(WORKERS_FILE);
  const { workerId, from, to, format } = req.query;

  if (workerId) records = records.filter(r => r.workerId === workerId);
  if (from) records = records.filter(r => r.timestamp >= from);
  if (to) records = records.filter(r => r.timestamp <= to + 'T23:59:59');

  const workerMap = {};
  workers.forEach(w => { workerMap[w.id] = w; });

  const rows = records.map(r => {
    const worker = workerMap[r.workerId] || {};
    const dt = new Date(r.timestamp);
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const dayOfWeek = dt.getDay();
    const dayName = dayNames[dayOfWeek];

    return {
      'Nombre': worker.name || r.workerName || '',
      'Puesto': worker.position || '',
      'Fecha': dt.toLocaleDateString('es-MX'),
      'Día': dayName,
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
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${r[h]}"`).join(','))].join('\n');
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
});

// Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Persico Attendance running on port ${PORT}`));
