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
