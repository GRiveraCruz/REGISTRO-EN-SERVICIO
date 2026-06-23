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

## ⚙️ Variables de entorno (opcionales)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT`   | `3000`  | Puerto del servidor |

---

## 🔒 Notas de seguridad

- Los datos se almacenan en archivos JSON locales. Para producción prolongada, considera migrar a una base de datos (PostgreSQL addon de Railway).
- En Railway, los archivos en `/data` persisten entre deploys si usas un **Volume** (recomendado).

### Agregar Volume en Railway
1. En tu proyecto → **New** → **Volume**
2. Monta en `/app/data`
3. Los registros persistirán aunque se redeploy el servicio.
