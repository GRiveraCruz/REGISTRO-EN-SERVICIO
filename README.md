# Persico México — Control de Asistencia en Campo

Sistema de registro de entrada/salida con geocercas para personal en servicio externo.

---

## 🚀 Deploy en Railway

### Opción 1: Desde GitHub (Recomendado)

1. Sube este proyecto a un repositorio GitHub (público o privado).
2. Ve a [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Selecciona el repositorio.
4. Railway detecta automáticamente Node.js y hace el deploy.
5. En **Settings → Networking**, genera un dominio público.

### Opción 2: Con Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

---

## 👥 Usuarios por defecto

| Usuario | Contraseña | Rol |
|---------|-----------|-----|
| `admin` | `admin123` | Administrador |
| `rrhh`  | `rrhh123`  | RRHH |

> ⚠️ **Cambia las contraseñas** editando `data/users.json` después del primer deploy.

---

## ✅ Funcionalidades

### Administrador
- Configurar puntos de registro con geocerca automática de 75 m
- Importar trabajadores via Excel (plantilla descargable)
- Crear/editar trabajadores y asignarles jornada y punto de registro
- Múltiples puntos de registro por ciudad/planta
- Descargar reportes en Excel y CSV

### RRHH
- Crear y editar trabajadores
- Descargar reportes generales o por trabajador

### Trabajador (usuario general)
- Selección de nombre desde lista
- Botones "Registrar Entrada" y "Registrar Salida"
- Verificación automática de geocerca cada 10 segundos
- Mensaje "Fuera de la región autorizada para el registro" si está fuera

### Reportes incluyen
- Nombre, puesto, fecha, día de semana, hora, tipo (entrada/salida)
- Total de horas de jornada
- Horas base (Lun-Jue: 10h, Vie: 8h)
- Horas extraordinarias (excedente de base + todas las horas de Sáb/Dom)
- Coordenadas GPS y confirmación de geocerca

---

## 📁 Estructura

```
persico-attendance/
├── server.js          # API Express
├── package.json
├── railway.toml       # Config Railway
├── public/
│   └── index.html     # App frontend completa
└── data/              # JSON persistentes (auto-generados)
    ├── users.json
    ├── workers.json
    ├── locations.json
    └── records.json
```

---

## 📝 Plantilla Excel de trabajadores

Descarga desde la app en **Trabajadores → Plantilla Excel**.  
Columnas: `Nombre`, `Puesto`, `Jornada`, `Ubicacion`

---

## ⚙️ Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `DATABASE_URL` | **Sí** | La **misma** base PostgreSQL de Persico Suite (en Railway: referencia `${{Postgres.DATABASE_URL}}`). |
| `SUITE_URL` | Sí | URL de Persico Suite (permisos, vacaciones, órdenes de servicio, tareas). |
| `SYNC_API_KEY` | Sí | Llave compartida con la Suite (`ATTENDANCE_SYNC_KEY` allá). |
| `KIOSCO_PIN_SECRET` | Recomendada | Secreto para guardar los PIN cifrados (si se cambia, los PIN existentes dejan de servir). |
| `PORT` | No | Puerto (3000). |

## 🗄 Datos (v2)

- Ya **no se usan archivos JSON**: todo vive en la base de datos de la Suite.
- **Trabajadores** = tabla `personal` de la Suite (Control de Personal). Ya no hay sincronización ni alta de trabajadores en el kiosco.
- Tablas propias del kiosco: `kiosco_registros`, `kiosco_trabajadores` (PIN, jornada, puntos de registro, jobs permitidos), `kiosco_ubicaciones`, `kiosco_usuarios`, `kiosco_firmas`, `kiosco_config`. Se crean solas al arrancar.
- **Migración automática**: en el primer arranque con base de datos, si existen los JSON anteriores en `data/`, se copian una sola vez (usuarios con contraseña cifrada, ubicaciones, configuración de trabajadores ligada por `externalId`, registros, firmas y notificaciones). Los registros de trabajadores que no estaban vinculados quedan como `KIOSCO-<id>` y se vinculan desde la Suite (Asistencia → vincular).
- `GET /api/estado` muestra el estado de la conexión y el resultado de la migración.
