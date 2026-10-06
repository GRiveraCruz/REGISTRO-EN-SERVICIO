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

---

# v2.6 — Control de dispositivos y tipo de dispositivo en cada registro

## Por qué no la MAC
Ningún navegador permite a una página leer la dirección MAC, y los celulares actuales usan
una MAC aleatoria por red. En su lugar, cada navegador recibe un **identificador de
dispositivo propio**. Se guarda en el teléfono (almacenamiento local, con una cookie de
respaldo) y en el servidor solo como huella cifrada.

## Cómo funciona
- **Al entrar como trabajador**, el kiosco revisa el dispositivo:
  - **El primer dispositivo** con el que entra queda **autorizado automáticamente** (se
    puede desactivar) y se le avisa: "Este celular quedó registrado como tu dispositivo".
  - **Desde otro dispositivo** queda **pendiente de autorización de RH**: aparece un aviso
    y los botones de Entrada/Salida se bloquean. Permisos, órdenes de servicio y tareas
    siguen disponibles.
  - **Un dispositivo autorizado para un trabajador no sirve para otro**, para evitar
    registros "prestados": queda pendiente, con el motivo "el dispositivo ya está
    autorizado para X". La excepción es un dispositivo marcado como **compartido**, por
    ejemplo una tablet fija en planta.
- **El servidor también lo valida al registrar.** Un dispositivo pendiente o rechazado
  recibe 403, aunque se manipule la página.
- **Tipo de dispositivo:** cada registro guarda si fue **celular, tablet o computadora**,
  junto con el sistema y el navegador. Se calcula con el User-Agent, la pantalla táctil y
  Client Hints; un iPad que se presenta como Mac se reconoce como tablet. En **Reportes**
  hay una columna nueva, "Dispositivo".

## Panel "Dispositivos" (administrador y RRHH)
- **Reglas:**
  - control de dispositivos (encendido / apagado);
  - autorizar automáticamente el primer dispositivo;
  - **solo desde celular o tablet** (bloquea registros desde computadora).
- **Lista:** trabajador, dispositivo (tipo, sistema, navegador, pantalla), estado, alta,
  último uso y motivo. Filtros: pendientes, autorizados, rechazados.
- **Acciones:**
  - **Autorizar**: por defecto reemplaza al dispositivo anterior del trabajador, como en un
    cambio de celular, y pide confirmación;
  - **Rechazar**, **Revocar** y **Compartido**;
  - **Eliminar**, para los rechazados.
- La pestaña muestra cuántos dispositivos hay pendientes.

## Límites conocidos
- Si el trabajador borra los datos del navegador, usa modo incógnito o cambia de navegador,
  se presenta como un dispositivo nuevo y RH tiene que autorizarlo de nuevo.
- La detección celular / computadora la puede falsear un usuario técnico. Con el control de
  dispositivos activo, ese equipo de todas formas queda pendiente de RH.
- El siguiente paso sería **passkey** (huella o rostro del celular), que liga el registro al
  dispositivo y a la persona.

## Datos
- Tabla nueva `kiosco_dispositivos`; se crea sola.
- Reglas en `kiosco_config.dispositivos`.
- Cada registro de asistencia guarda `data.dispositivo = {tipo, os, navegador, autorizado}`.

## Probado
- **Primer celular** → autorizado.
- **Segundo dispositivo** → pendiente: el registro se rechaza con 403 y los botones se
  bloquean con aviso.
- **Autorizar el segundo** → el primero queda revocado.
- **Celular de otro trabajador** → pendiente; marcado como compartido → autorizado.
- **"Solo celular":** computadora rechazada, celular aceptado.
- **Registro aceptado:** guarda celular · Android · Chrome.

---

# v2.7 — Un celular y una computadora por trabajador

- **Regla:** cada trabajador puede tener autorizado **un celular** (una tablet cuenta como
  celular) **y una computadora**, no más de uno de cada tipo.
- **Primer dispositivo de cada tipo:** el primer celular y la primera computadora con que
  entra quedan autorizados automáticamente, si esa regla está activa.
- **Un segundo dispositivo del mismo tipo** queda **pendiente**, con el motivo "ya tienes un
  celular autorizado; solo se permite uno de cada tipo" (o una computadora).
- **Al autorizarlo,** RH reemplaza **solo al anterior del mismo tipo**, como en un cambio
  de celular. El dispositivo del otro tipo no se toca.
- **Categoría:** se fija con el tipo detectado al dar de alta el dispositivo. El panel la
  muestra ("cuenta como: celular / computadora") y la confirmación de autorizar lo
  explica.
- Los dispositivos registrados con la v2.6 toman su categoría del tipo con que se dieron de
  alta.
- **Probado:** celular 1 y computadora 1 autorizados; celular 2 y computadora 2
  pendientes. Al autorizar el celular 2: celular 1 revocado, computadora 1 sigue
  autorizada y computadora 2 sigue pendiente.
