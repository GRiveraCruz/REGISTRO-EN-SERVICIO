const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORKERS_FILE = path.join(DATA_DIR, 'workers.json');
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');

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

// ─── LOCATIONS ───────────────────────────────────────────────────────────────
app.get('/api/locations', (req, res) => res.json(readJSON(LOCATIONS_FILE)));

app.post('/api/locations', (req, res) => {
  const locations = readJSON(LOCATIONS_FILE);
  const location = { id: uuidv4(), radius: 120, ...req.body, createdAt: new Date().toISOString() };
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
