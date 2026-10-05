# Kiosco de Asistencia v2 — misma base de datos que Persico Suite

## Por qué
- El kiosco guardaba todo en archivos JSON. Al dejar de usarlos se perdía la información
  (en Railway, sin volumen, los JSON se borran con cada redeploy).
- Con ellos se perdía el vínculo `externalId` entre cada trabajador del kiosco y su
  registro en la Suite.
- Por eso fallaban permisos, vacaciones, tareas y la asistencia en la Suite ("Tu usuario
  aún no está vinculado con Recursos Humanos").

## Qué cambia
- **Base de datos:** el kiosco usa la **misma base PostgreSQL de la Suite**
  (`DATABASE_URL`). Ya no hay archivos JSON.
- **Trabajadores = Control de Personal de la Suite** (tabla `personal`).
  - Ya no hay sincronización ni vínculo manual: el id del trabajador en el kiosco es su
    `tid` de la Suite.
  - Altas, bajas, nombre, puesto y área se manejan en la Suite.
  - En el kiosco solo se configura lo propio: jornada, puntos de registro, jobs
    permitidos y PIN.
  - Los trabajadores dados de baja aparecen marcados y no pueden entrar con PIN.
- **Tablas del kiosco** (se crean solas): `kiosco_registros`, `kiosco_trabajadores`,
  `kiosco_ubicaciones`, `kiosco_usuarios`, `kiosco_firmas`, `kiosco_config`.
- **Seguridad:**
  - contraseñas de usuarios con **bcrypt** (antes en texto plano);
  - PIN guardado como **HMAC**, con uniqueness en la base.
- **Permisos, órdenes de servicio y tareas:** se siguen pidiendo a la Suite por HTTP
  (`SUITE_URL` + `SYNC_API_KEY`), donde están sus reglas de aprobación.
- **Vacaciones (nuevo):** al elegir "Vacaciones" en Solicitar Permiso se muestra el
  **saldo de días**, calculado por la Suite: ganados por antigüedad, gozados y días en
  solicitudes por aprobar. Se actualiza al enviar una solicitud.
- **Migración automática, una sola vez:** si en el primer arranque existen los JSON
  anteriores en `data/`, se copian a la base:
  - usuarios, con la contraseña cifrada;
  - ubicaciones;
  - configuración y PIN de cada trabajador, ligados por `externalId`;
  - registros, firmas y notificaciones.
  Los registros de trabajadores que nunca se vincularon quedan como `KIOSCO-<id>` y se
  vinculan desde la Suite (Asistencia → vincular trabajador).
- `GET /api/estado` muestra el estado de la conexión y el resultado de la migración.
- **Sin cambios:** las rutas de la API conservan la misma forma de respuesta, así que la
  pantalla del kiosco funciona igual.

## Variables de entorno (Railway)
| Variable | Valor |
|---|---|
| `DATABASE_URL` | La misma de la Suite (`${{Postgres.DATABASE_URL}}`) |
| `SUITE_URL` | URL de la Suite |
| `SYNC_API_KEY` | Igual a `ATTENDANCE_SYNC_KEY` de la Suite |
| `KIOSCO_PIN_SECRET` | Un secreto propio. Si no se define, se usa `SYNC_API_KEY`. Si después se cambia, hay que volver a crear los PIN. |

## Dependencias nuevas
`pg`, `bcryptjs`. Railway las instala con `npm install`.

---

# v2.3 — Un registro por sesión y espera mínima de 5 minutos

- **Un solo registro por sesión:** al registrar Entrada (o Salida), los dos botones quedan
  bloqueados hasta cerrar sesión. El mensaje dice "Ya registraste tu Entrada en esta
  sesión. Para el siguiente registro cierra sesión y vuelve a entrar a partir de las HH:MM".
  Al registrar la Salida se sigue abriendo la captura de horas por Job, como antes.
- **Espera mínima:** entre un registro y el siguiente del mismo trabajador deben pasar al
  menos **5 minutos**, aunque entre en otra sesión o en otro dispositivo. Mientras tanto,
  los botones están bloqueados con cuenta regresiva ("Podrás hacer el siguiente en 4:56 min,
  a las HH:MM"). Al cumplirse el tiempo, se habilita el botón que corresponde, siempre que
  esté dentro de la geocerca.
- **Se conserva el registro previo memorizado:** después de una Entrada solo se habilita
  Salida, y al revés, igual que antes.
- **El servidor también lo valida** (no solo la pantalla):
  - registro antes de 5 minutos → 429 "Debes esperar m:ss min…";
  - mismo tipo que el último registro → 409 "Tu último registro ya fue Entrada; ahora
    corresponde Salida";
  - candado por trabajador, para que un doble toque o dos dispositivos al mismo tiempo no
    generen dos registros. Si el servidor tiene un registro más reciente, la pantalla lo
    memoriza.
- La espera se configura con la variable `KIOSCO_ESPERA_MIN` (5 por defecto).
- **Probado:**
  - Entrada → bloqueo de sesión; intentar Salida en la misma sesión no registra nada;
  - nueva sesión a los pocos segundos → cuenta regresiva 4:56;
  - API antes de 5 min → 429;
  - después de 6 min, Entrada repetida → 409;
  - dos Salidas simultáneas → solo una se guarda y la otra recibe 429.

---

# v2.4 — Pantalla de acceso simplificada y cardex del trabajador

## 1. Pantalla de acceso
- Ya no aparecen de entrada los campos de usuario y contraseña, que confundían a la
  mayoría.
- Ahora se ve un botón grande **"👷 Entrar como trabajador"** y, debajo, el enlace
  **"Ingresar como administrador"**. El enlace muestra los campos de usuario y contraseña
  (Enter pasa a la contraseña y entra), con un enlace para regresar.
- Al cerrar sesión siempre se vuelve al acceso de trabajador.

## 2. Cardex del trabajador (pantalla de inicio)
- **Orden de la pantalla:**
  - arriba, la ubicación (geocerca) y los botones de Entrada / Salida con su aviso;
  - debajo, la tarjeta oscura con el reloj, la fecha, el nombre y el **cardex**;
  - al final, "Mis últimos registros".
- **Datos del cardex:**
  - **Puesto actual** y área (Control de Personal de la Suite);
  - **Fecha de ingreso** y **antigüedad** en años y meses;
  - **Horario:** la jornada del **Tipo de Puesto** asignado al perfil en la Suite, agrupada
    por días (ej. "Lun–Jue 07:00–17:00 · Vie 07:00–15:00"). Si el perfil no tiene tipo de
    puesto, se usa la jornada configurada en el kiosco;
  - **Días de vacaciones disponibles** (calculados por la Suite), con ganados, gozados y
    por aprobar;
  - **Total de horas esta semana** y **semana pasada** (lunes a domingo, hora de México):
    suma de las jornadas registradas, con el rango de fechas, el número de jornadas y, si
    hay una entrada sin salida, las horas en curso;
  - **Ubicaciones permitidas** (o todas, si no tiene restricción).
- El cardex se actualiza después de registrar.
- Nuevo endpoint `GET /api/workers/:id/cardex`. La fecha de ingreso solo se entrega aquí,
  para el trabajador que inició sesión, y no en la lista general de trabajadores.
- La zona horaria para separar las semanas se puede cambiar con `KIOSCO_TZ`
  (America/Mexico_City por defecto).

## Cómo se probó
- **Acceso:** el enlace muestra y oculta los campos de administrador.
- **Cardex con datos de prueba:** Diseñador mecánico, ingreso 01/03/2020 (6 años, 7
  meses), horario del tipo "Nocturno" (Lun–Vie 22:00–06:00), 102 días de vacaciones, 10 h
  esta semana (1 jornada), 19.75 h la semana pasada (2 jornadas), Planta Norte.
- Un trabajador sin tipo de puesto muestra la jornada del kiosco (07:00 – 17:00).

---

# v2.5 — Jefe directo y subordinados en el cardex

- **Jefe directo:** nombre y puesto, del campo "Jefe Directo" de Control de Personal en la
  Suite. Si no tiene, dice "Sin jefe directo asignado".
- **Subordinados:** cuántas personas activas lo tienen como jefe directo, con los primeros
  nombres. Al pasar el mouse se ve la lista completa.
- Probado: un trabajador con jefe GARCIA RUIZ ANA y 3 subordinados; otro sin jefe y sin
  subordinados.
