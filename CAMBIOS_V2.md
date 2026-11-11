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

---

# v2.8 — Un solo calendario para elegir el periodo del permiso

- En **Solicitar Permiso → Días completos** (vacaciones y cualquier permiso por días), los
  dos campos "Fecha inicio" y "Fecha fin" se reemplazaron por **un solo calendario**.
  - Se toca el **primer día** y luego el **último**; el periodo se resalta. Para un solo
    día, se toca dos veces.
  - Si se toca un día anterior al inicio, ese pasa a ser el nuevo inicio. Un tercer toque
    empieza otro periodo.
  - Navegación por meses (‹ ›), semana de lunes a domingo, el día de hoy marcado, fines de
    semana en ámbar y **días festivos de ley** con un punto.
  - Debajo se muestra el resumen: "Del mar 10 de nov al sáb 21 de nov · 12 días naturales
    · **8 hábiles** (lun–vie sin festivos)", con el enlace **Limpiar**.
  - **En Vacaciones**, si los días hábiles pasan del saldo disponible, aparece un aviso
    en rojo.
- El envío no cambia (`fecha_inicio` / `fecha_fin`). Si falta el último día, se pide
  tocarlo.
- **Por horas** sigue igual: un día con hora de inicio y fin.

---

# v2.9 — Pausa / comida

## Para el trabajador
- **Dos botones nuevos**, siempre visibles debajo de Entrada / Salida: **"☕ Iniciar pausa /
  comida"** y **"▶ Terminar pausa"**.
- **Cuándo se habilitan:**
  - **solo después de checar Entrada y antes de checar Salida**;
  - **se alternan**: sin pausa abierta solo "Iniciar pausa"; con pausa abierta solo
    "Terminar pausa";
  - con una pausa abierta, **"Registrar salida" queda deshabilitado** y se avisa: "☕ Pausa
    en curso desde las HH:MM — termínala antes de registrar tu salida";
  - igual que la entrada y la salida, requieren dispositivo autorizado y estar dentro de
    la geocerca.
- **Un movimiento por sesión:** las pausas no se marcan en la misma sesión en que se checó
  la entrada, y solo una (inicio o fin) por sesión. La espera de 5 minutos entre registros
  **no aplica** a las pausas.
- **Las horas de la jornada no cambian:** la pausa no se descuenta.

## Solo en el kiosco
- **Tabla nueva `kiosco_pausas`** (se crea sola), separada de `kiosco_registros`. **La
  Suite no la lee:** no aparece en Asistencia, KPIs, reportes ni en el cardex.
- **El servidor también valida:**
  - no hay pausa sin Entrada abierta;
  - no se inicia una pausa si ya hay una abierta, ni se termina si no hay;
  - no se checa Salida con una pausa abierta.
  - Usa el mismo candado por trabajador que la entrada/salida.

## Consulta (administrador y RRHH)
- **Pestaña nueva "☕ Pausas"**, solo para los roles **admin** y **rrhh**:
  - filtros por rango de fechas (por defecto, los últimos 7 días) y por trabajador;
  - tabla con trabajador y área, fecha, inicio, fin, duración, ubicación y dispositivo.
    Las pausas sin cerrar se marcan "en curso";
  - resumen: número de pausas, abiertas, tiempo total y promedio por pausa;
  - **"⬇ Excel"** con el mismo detalle.

## API
- `GET /api/pausas/estado?workerId=` · `POST /api/pausas` (`type`: inicio | fin)
- `GET /api/pausas?from&to&workerId` · `GET /api/pausas/export?from&to&workerId`

## Probado (PostgreSQL local)
- **Pausa sin entrada** → rechazada. **Terminar sin pausa abierta** → rechazado.
- **Iniciar dos veces** → rechazado. **Salida con pausa abierta** → rechazada.
- **Terminar pausa y luego salida** → aceptada. **Pausa después de la salida** → rechazada.
- **Los registros de asistencia** siguen teniendo solo entrada y salida.
- **En pantalla:**
  - sesión con entrada abierta → Salida e Iniciar pausa habilitados;
  - tras iniciar → todo bloqueado hasta la siguiente sesión;
  - siguiente sesión → solo "Terminar pausa", con Salida bloqueada;
  - siguiente sesión → Salida e Iniciar pausa de nuevo.
- **Nav de RRHH** con "Pausas", resumen y Excel correctos.

---

# v2.10 — Modo "Home office" por trabajador

- **Opción nueva en Trabajadores ▸ Editar:** casilla **"🏠 Home office"**.
  - Con la casilla marcada, **la ubicación no se toma en cuenta** para registrar entrada,
    salida o pausas: el trabajador puede registrar desde cualquier lugar.
  - Los puntos de registro asignados quedan atenuados, porque no aplican. Se conservan por
    si se quita el modo.
  - **El dispositivo autorizado sí se sigue validando**, igual que las demás reglas: un
    registro por sesión, espera entre registros y salida bloqueada con una pausa abierta.
- **Lista de trabajadores:** en lugar de sus ubicaciones muestra la etiqueta "🏠 Home
  office".
- **Pantalla del trabajador:**
  - en lugar de "Verificando ubicación…" aparece "🏠 Modo Home office: tu ubicación no se
    valida para el registro";
  - los botones se habilitan sin esperar al GPS;
  - si el teléfono da su ubicación se guarda como referencia, pero no es obligatoria.
- **Registros:**
  - el servidor marca el registro como Home office según la configuración del trabajador,
    sin confiar en lo que mande el navegador: ubicación "Home office" y `homeOffice: true`;
  - en **Reportes**, la columna Geocerca muestra 🏠;
  - en el Excel/CSV aparece "Home office" en "Dentro de Geocerca";
  - también aplica a las pausas.
- **Cardex del trabajador:** "Ubicaciones permitidas" muestra "🏠 Home office".

## Probado
- **Trabajador con Home office** y el GPS lejos de cualquier geocerca:
  - aparece el aviso de Home office y se habilitan Salida e Iniciar pausa;
  - su registro quedó con ubicación "Home office" y `inGeofence` en falso, aunque el
    navegador mandó "Planta".
- **Trabajador sin Home office** en el mismo lugar → bloqueado como siempre.
- **Cardex** → "🏠 Home office".

---

# v2.11 — Home office: solo desde laptop o computadora

- Un trabajador en **modo Home office** solo puede registrar entrada, salida y pausas desde
  una **laptop o computadora**. Desde celular o tablet se rechaza.
  - Se valida en el **servidor**, no solo en pantalla.
  - En la pantalla del trabajador aparece "⛔ Dispositivo no permitido · Estás en modo Home
    office: la asistencia solo se registra desde tu laptop o computadora (este dispositivo
    es celular)" y los botones se bloquean.
- La regla general **"Solo desde celular o tablet"** (Dispositivos ▸ Reglas) **no aplica** a
  quien está en Home office: para ellos manda la regla de computadora.
- **Se sigue aplicando el control de dispositivos:** la computadora debe estar autorizada.
  Puede ser la primera computadora del trabajador (se autoriza sola, si esa regla está
  activa) o una que autorice RH.
- El texto de la casilla "🏠 Home office" en la ficha del trabajador y el aviso de la
  pantalla mencionan la regla.

## Probado
- **Trabajador en Home office:**
  - desde celular, la entrada y la pausa se rechazan con el mensaje;
  - desde su computadora autorizada, la entrada se acepta con ubicación "Home office";
  - con "solo celular" activo, su computadora sigue aceptada.
- **Trabajador sin Home office** con "solo celular" activo → computadora rechazada, como
  antes.

---

# v2.12 — Importar registros del kiosco de contingencia

- **Pestaña nueva "📥 Contingencia"** (admin y RRHH): importa el CSV descargado del **kiosco
  de contingencia**, la aplicación aparte para registrar desde casa cuando este kiosco no
  está disponible.
- **Vista previa antes de importar:**
  - cada nombre del archivo se relaciona **automáticamente** con un trabajador de Control
    de Personal, sin importar acentos ni el orden de los nombres;
  - si no se encuentra, se elige de una lista. Los que se dejan sin relacionar no se
    importan;
  - el estado de cada renglón: se importará, ya importado, sin trabajador o inválido.
- **Al importar:**
  - las salidas calculan **horas de jornada, base y extra** contra la entrada anterior,
    con la misma regla del kiosco;
  - los registros quedan con ubicación **"Contingencia (desde casa)"**, marcados como Home
    office y con `origen: contingencia`;
  - **sin duplicados**: cada renglón guarda su id de contingencia, así que importar el mismo
    archivo otra vez no repite nada.
- `POST /api/contingencia/importar` (`csv`, `mapeo`, `aplicar`).

## Probado
- **Kiosco de contingencia:**
  - con código incorrecto se rechaza; una salida sin entrada también; una doble entrada,
    también;
  - el CSV salió con 4 renglones.
- **Importación:**
  - "MUÑOZ RODRIGUEZ LUZ AILED" y "HERNANDEZ DELFINO" se relacionaron solos con su
    trabajador; "JUAN INEXISTENTE" quedó sin relacionar;
  - se importaron 3 y se omitió 1;
  - al reimportar: 0 nuevos y 3 duplicados detectados.

---

# v2.13 — Corrección: el modo Home office no se aplicaba al iniciar sesión

- **Qué pasaba:** al entrar como trabajador, por nombre o con PIN, la sesión se armaba sin
  el dato `homeOffice`. Por eso el kiosco seguía validando la ubicación ("Fuera de la región
  autorizada…") aunque el trabajador tuviera activado Home office. En las pruebas de la
  v2.10 la sesión se había armado directo con la ficha completa del trabajador, y por eso
  no se detectó.
- **Corrección:**
  - los dos accesos (por nombre y con PIN) incluyen ahora `homeOffice` en la sesión;
  - como respaldo, si la sesión no lo trae, el kiosco lo toma de la ficha del trabajador.
- **El servidor ya marcaba los registros** como Home office según la ficha del trabajador;
  ese comportamiento no cambia.
- **Probado** con el flujo real, con el GPS lejos de cualquier geocerca:
  - entrada por nombre → "🏠 Modo Home office: tu ubicación no se valida…";
  - entrada con PIN → igual.

---

# v2.14 — "Home office" ahora se llama "Smart Work"

- Todos los textos del kiosco cambian de **"Home office"** a **"Smart Work"**:
  - la casilla en la ficha del trabajador ("🏠 Smart Work");
  - la etiqueta en la lista de trabajadores;
  - el aviso en la pantalla del trabajador ("Modo Smart Work: tu ubicación no se valida…");
  - el mensaje cuando intenta registrar desde celular;
  - la ubicación de los registros y pausas;
  - el cardex;
  - la columna "Dentro de Geocerca" del Excel/CSV.
- **Registros anteriores:** al arrancar, los que decían "Home office" como ubicación se
  renombran a "Smart Work" (registros y pausas), para que los reportes queden uniformes.
- **El funcionamiento no cambia:** la ubicación no se valida y solo se registra desde
  laptop o computadora.
- Internamente el dato sigue llamándose `homeOffice`, así que la configuración de cada
  trabajador se conserva sin hacer nada.
- **Probado:** un registro anterior con "Home office" quedó como "Smart Work". El mensaje
  desde celular, la ubicación de un registro nuevo y el cardex dicen "Smart Work".

---

# v2.15 — Horas por Job: lista de Jobs en WIP del ERP y horas antes de la salida

## 1. ADMIN se mantiene
- **"ADMIN"** sigue apareciendo siempre, para las horas administrativas.

## 2. Jobs tomados del ERP (solo en WIP)
- **El kiosco lee los Jobs de la Suite** (tabla `jobs` de la misma base de datos) y solo
  ofrece los que tienen estatus **WIP**. Ya no hay que capturar los Jobs a mano por
  trabajador.
- **Endpoint nuevo:** `GET /api/jobs-wip` (número, cliente, descripción y PM).

## 3. El trabajador agrega los Jobs de su día
- **En la distribución de horas**, campo **"Agregar Job trabajado hoy"**:
  - se escribe el número, el cliente o la descripción y se elige de la **lista de Jobs en
    WIP**;
  - "+ Agregar" añade el renglón para capturar sus horas;
  - se pueden agregar **uno o varios** y quitar los que no apliquen (ADMIN no se quita).
- **Validación:** si se escribe un Job que no está en WIP, se rechaza.
- **"Tus Jobs":** los Jobs que el administrador ya tenía asignados al trabajador aparecen
  como **botones de acceso rápido**, solo si siguen en WIP. El campo "Jobs permitidos" de
  la ficha queda como lista de sugeridos.

## 4. Las horas se capturan ANTES de que la salida quede registrada
- **Al presionar "Registrar Salida"** ya no se envía la salida: se abre primero la
  **distribución de horas**.
- **La salida se registra solo al confirmar** ("🔴 Registrar salida con estas horas"),
  **junto con** su distribución.
- **"Cancelar" no registra la salida.** El trabajador puede volver a presionar "Registrar
  Salida" cuando termine.
- **El servidor también lo exige.** Una salida se rechaza si:
  - no trae horas, o suman 0;
  - algún Job no está en WIP en la Suite;
  - la suma excede la jornada (cuando la jornada es mayor a 0 h).
  - Los Jobs repetidos se suman y "admin" se normaliza a ADMIN.
- **Así ya no quedan salidas sin horas** (registros vacíos o en falso).
- **La edición de horas** de un día ya registrado (administrador, Reportes ▸ Jobs por día)
  funciona igual que antes.

## Probado (PostgreSQL local)
- **Lista de Jobs:** con 2 Jobs WIP y 1 Done → la lista muestra solo los 2 WIP.
- **Validaciones del servidor:**
  - salida sin horas → rechazada;
  - Job 559-99 (Done) → rechazado;
  - 9 h en una jornada de 8 → rechazado;
  - 652-50: 5 + 1 y admin: 2 → aceptada como 652-50: 6 h y ADMIN: 2 h.
- **En pantalla:**
  - "Registrar Salida" abre la distribución **sin** registrar nada (0 salidas en la base);
  - agregar 559-99 → rechazado; agregar 652-50 → agregado;
  - "Cancelar" → sigue sin salida;
  - con 0 horas → no se registra;
  - con ADMIN 2 h + 652-50 6 h → **salida registrada con sus horas** y la ventana se
    cierra.

---

# v2.16 — Registros manuales (solo administrador, con contraseña)

## Botón "➕ Registro manual" (Reportes)
- **Solo lo ve el usuario con rol de administrador.** El servidor también rechaza a
  cualquier otro rol, incluido RRHH.
- **En la ventana se captura:**
  - **trabajador**, **tipo** (Entrada / Salida) y **fecha y hora** (no se aceptan fechas
    futuras);
  - **motivo**, obligatorio;
  - **la contraseña del administrador**, obligatoria en cada registro. Si es incorrecta,
    no se guarda y queda en el log.
- **Salida manual:**
  - muestra la **jornada calculada** desde la entrada anterior (total, base y extra);
  - pide la **distribución de horas** (ADMIN + Jobs en WIP de la Suite), con las mismas
    reglas de la v2.15: no puede quedar en 0, no puede exceder la jornada y solo admite
    Jobs en WIP.

## Validaciones de la secuencia
- **No se acepta una Entrada** si antes de esa hora hay otra Entrada sin salida.
- **No se acepta una Salida** sin una Entrada anterior.
- **No se acepta** si justo después ya existe un registro del mismo tipo (quedaría
  duplicado).
- Usa el mismo candado por trabajador que los registros normales.

## Cómo queda el registro
- **Ubicación "Registro manual"**, con `origen: manual` y quién lo registró, su nombre, el
  motivo y la fecha de captura.
- **La salida** guarda sus horas calculadas y su distribución por Job, igual que una normal.
- **Se ve en Reportes** como cualquier registro. La Suite lo toma igual para asistencia y
  horas.

## API
- `POST /api/records/manual` (adminUser, password, workerId, type, timestamp, motivo,
  jobHours).
- `GET /api/records/manual/horas` (jornada calculada para una salida).

## Probado (PostgreSQL local)
- **Usuario RRHH** → rechazado. **Contraseña incorrecta** → rechazada.
- **Sin motivo** → rechazado. **Fecha futura** → rechazada.
- **Salida sin entrada** → rechazada.
- **Entrada manual** hace 30 h → guardada como "Registro manual". **Otra entrada** sin salida
  intermedia → rechazada.
- **Salida manual** 9 h después: jornada 9 h. Sin horas → rechazada. Con 652-50 7 h + ADMIN
  2 h → guardada, con su distribución y "por: admin".
- **En pantalla:** el botón solo aparece al administrador, y la ventana avisa cuando falta
  la entrada.

---

# v2.17 — La ubicación la valida el servidor

## Antes
- El navegador calculaba si el trabajador estaba dentro de la geocerca y avisaba
  `inGeofence: true`, y el servidor **le creía**. Un registro "dentro" se podía enviar sin
  estar en la planta.

## Ahora (cada entrada, salida y pausa)
1. **Ubicación del momento:** al registrar, el kiosco pide una **ubicación nueva**, sin
   reutilizar la de cuando se abrió la página. Envía coordenadas, **precisión** y la
   **hora en que se tomó**.
2. **El servidor recalcula la distancia** a los puntos de registro permitidos del trabajador.
   Si está fuera del radio (con una tolerancia máxima de 30 m por imprecisión), **rechaza**
   el registro e indica a cuántos metros está.
3. **Precisión** (celulares y tablets):
   - sin dato de precisión → rechazado;
   - **0 m** (típico de las apps de ubicación falsa) → rechazado;
   - **más de 100 m** → rechazado, con la indicación de activar el GPS o la "ubicación
     precisa".
4. **Antigüedad:** si la ubicación se tomó hace **más de 30 s** → rechazado. Se mide con el
   reloj del propio dispositivo, así que su desfase de hora no influye.
5. **Alertas (no rechazan; quedan para revisión):**
   - **Viaje imposible:** más de 5 km desde el registro anterior a más de 120 km/h (por
     ejemplo, 50 km en 1 minuto);
   - **Coordenadas idénticas** al sexto decimal a un registro de **otro día**: un GPS real
     no repite el punto exacto, una app falsa sí.
- **El registro guarda:** el punto validado por el servidor, la distancia al centro, la
  precisión y las alertas (`geo.validado_servidor: true`).
- **Excepciones:**
  - **Smart Work:** la ubicación no se valida (como antes);
  - **computadoras:** se valida la **distancia**, pero no la precisión ni las coordenadas
    repetidas, porque ubican por Wi-Fi o red y su precisión suele ser baja. Se puede
    exigir también a ellas.

## Pestaña nueva "🛡 Ubicación" (admin y RRHH)
- **Lista de registros rechazados y alertas:** fecha, trabajador, motivo, precisión,
  dispositivo y enlace al mapa. Filtros por fechas y tipo.
- **Parámetros** (solo admin): precisión máxima, antigüedad máxima, velocidad máxima,
  rechazar precisión 0 m y exigir precisión también en computadoras.

## Al publicar
- Pide al personal **recargar la página del kiosco**. La versión anterior en caché no envía la
  precisión y el servidor la rechazará con el mensaje "Actualiza la página".
- En celulares, la **"ubicación precisa"** del navegador debe estar activada (en Android:
  Ajustes ▸ Ubicación ▸ Precisión de ubicación de Google).

## Probado (PostgreSQL local)
- **Celular, rechazados:** sin precisión, precisión 0 m, precisión ±500 m, ubicación de hace
  60 s, a 2 km del punto y sin coordenadas.
- **Celular, aceptado:** precisión ±15 m a 61 m del centro.
- **Salida 1 minuto después a 50 km** (en otro punto permitido) → aceptada con alerta "Viaje
  imposible (3001 km/h)".
- **Entrada con las coordenadas exactas de un registro de hace 3 días** → alerta
  "Coordenadas idénticas".
- **Computadora sin precisión, dentro del radio** → aceptada.
- **Desde la pantalla:** una entrada con ±12 m quedó en "Planta"; una pausa con precisión
  0 m fue rechazada y apareció en la pestaña de Ubicación.

---

# v2.18 — Integración del checador ZKTeco (BioTime)

## Cómo funciona
```
Checador ZKTeco ──(red local)──► BioTime (PC de planta, PostgreSQL :7496)
                                      │  puente_biotime.py (cada 5 min, solo lectura)
                                      ▼
                     Kiosco (Railway) ── POST /api/checador/marcas (HTTPS + CHECADOR_KEY)
```
- **El puente** (carpeta `puente-biotime`, entregada aparte) se instala en la **PC donde corre
  BioTime**.
  - Lee las checadas nuevas de la tabla `iclock_transaction` y los nombres de
    `personnel_employee`.
  - Las envía al kiosco cada 5 minutos.
  - No abre puertos ni expone la base de BioTime.
- **El kiosco** guarda cada checada (sin duplicados: empleado + fecha y hora) y la convierte en
  **Entrada o Salida** del trabajador relacionado:
  - alterna con su último registro: si lo anterior es una entrada de hace menos de 16 h, es
    salida; si no, entrada;
  - **dos checadas a menos de 3 minutos** cuentan como **repetidas** y se ignoran
    (`CHECADOR_DOBLE_MIN`);
  - ubicación **"Checador planta"**, con el método (huella, rostro, tarjeta) y el número de
    serie del equipo;
  - **las salidas** calculan horas base y extra, y quedan con **horas pendientes de
    repartir**.

## Horas por Job de las salidas del checador
- **Cuando el trabajador abre el kiosco en su celular**, se le pide repartir las horas de cada
  salida pendiente ("Tu salida del lunes 12 de octubre se registró en el checador de
  planta…"), un día tras otro, con ADMIN y los Jobs en WIP.

## Pestaña nueva "⏱ Checador" (admin y RRHH)
- **Estado del puente:** último envío (en rojo si pasó más de 30 min), y checadas
  registradas, repetidas, sin trabajador y pendientes.
- **Relación de empleados** (número del checador → trabajador de Control de Personal):
  - **se propone sola por nombre** la primera vez;
  - las que falten se eligen de la lista;
  - al relacionar, sus checadas en espera se registran de inmediato.
- **Para revisar:**
  - **días con checadas impares** de los últimos 14 días, contados en hora local (faltó
    entrada o salida). Se completan con "➕ Registro manual";
  - **trabajadores con horas por repartir.**

## Configuración en Railway (servicio del kiosco)
- `CHECADOR_KEY`: clave larga y secreta. La misma va en el `config.ini` del puente.
- Opcional: `CHECADOR_DOBLE_MIN` (por defecto 3).

## API
- `POST /api/checador/marcas` (puente, con `X-Checador-Key`)
- `GET /api/checador/estado`
- `PUT /api/checador/map`
- `GET /api/records/horas-pendientes`

## Probado (PostgreSQL local, con las 269 checadas de la Semana 42 en una base tipo BioTime)
- **Puente:** detectó la tabla, envió las 269 checadas en 3 lotes y la segunda ejecución
  ya no reenvió nada. Clave incorrecta → 401.
- **Relación automática por nombre:** 3 personas (Delfino Hernandez, Luz Muñoz, Elias Mata).
  Las demás quedaron en espera ("sin trabajador").
- **Delfino:** 07:05 → 17:04 del 12-oct como entrada y salida (9.97 h, horas pendientes) y así
  cada día. Hora local correcta (−06:00).
- **Al abrir el kiosco,** Delfino vio "Tu salida del lunes 12 de octubre… (5 días
  pendientes)". Al guardar pasó al martes 13 (4 pendientes).

---

# v2.19 — Coordenadas idénticas a otro día: registro rechazado

- **Si la ubicación es idéntica** (al sexto decimal) a la de un registro del mismo trabajador
  en **otro día**, el registro ahora se **rechaza**. Antes solo quedaba como alerta.
  - **Motivo:** un GPS real no repite el punto exacto en días distintos; una app de ubicación
    simulada sí.
- **El trabajador ve:** "Coordenadas idénticas a un registro del AAAA-MM-DD (…): posible
  ubicación simulada. Desactiva cualquier aplicación de ubicación simulada y vuelve a
  intentar; si el problema sigue, avisa a RRHH."
- **En 🛡 Ubicación** aparece como **Rechazado**.
- **Parámetro nuevo** (solo admin): "Rechazar coordenadas idénticas a otro día", activado por
  defecto. Si se desactiva, vuelve a ser solo una alerta.
- **Excepciones (sin cambio):**
  - **computadoras:** ubican por Wi-Fi y es normal que repitan el punto;
  - **Smart Work:** no valida ubicación.
- **Si alguien queda bloqueado por un falso positivo,** el administrador puede capturar su
  registro con "➕ Registro manual".

## Probado
- **Coordenadas exactas** de un registro de hace 3 días → **403 rechazado** y evento
  "Rechazado".
- **Coordenadas ligeramente distintas** → aceptado.
- **Parámetro desactivado** → guardado.

---

# v2.20 — El trabajador ya no ve el motivo de los rechazos por sospecha de GPS simulado

- **Rechazos por sospecha de ubicación simulada** (coordenadas idénticas a otro día y precisión
  de 0 m):
  - el trabajador solo ve un **mensaje genérico**: *"No se pudo completar el registro.
    Inténtalo de nuevo en unos minutos; si el problema continúa, contacta a tu
    supervisor."*;
  - ya no se menciona la ubicación simulada, las coordenadas ni las apps.
- **El motivo completo queda para RRHH y el administrador** en **🛡 Ubicación**, con la marca
  **"Sospecha de GPS simulado"** (`data.sospecha = true`).
- **Los rechazos por mala señal o ubicación** siguen mostrando su motivo al trabajador, porque
  necesita saber qué corregir: precisión baja, ubicación vieja, fuera del punto de
  registro o sin ubicación.
- **El registro sigue rechazado** igual que antes. Solo cambia lo que ve el trabajador.

## Probado
- **Coordenadas idénticas y precisión 0 m** → el trabajador ve el mensaje genérico; el evento
  queda con el motivo completo y "Sospecha de GPS simulado".
- **Precisión ±500 m** → el trabajador ve el motivo normal.

---

# v2.21 — Fase de medición: 3 lecturas GPS por registro (con altitud)

## Qué hace el kiosco al registrar
- **En cada entrada, salida y pausa** (excepto Smart Work), el kiosco toma **3 lecturas de GPS con 3
  segundos de separación**.
  - Mientras tanto muestra "📡 Verificando ubicación… (1/3)". El registro tarda unos 6–9 segundos
    más.
- **Cada lectura guarda:** coordenada, **precisión**, **altitud**, precisión de la altitud,
  **velocidad**, **rumbo** y hora.
- **La última lectura** es la que valida el servidor, con las mismas reglas de siempre: geocerca,
  precisión, antigüedad, coordenadas idénticas a otro día y precisión de 0 m.
- **Esta fase NO agrega rechazos nuevos:** solo mide.

## Qué se guarda en el registro (`geo.medicion`)
- **Las lecturas** (`muestras`).
- **Métricas:** número de lecturas, distancia máxima entre ellas, si las 3 coordenadas fueron
  idénticas, si la precisión fue idéntica, cuántas trajeron altitud, altitud media, variación de
  altitud y cuántas trajeron velocidad y rumbo.
- **En los rechazos,** las métricas también quedan en el evento de 🛡 Ubicación.

## Reporte nuevo en 🛡 Ubicación: "📏 Medición de lecturas GPS"
- **Por trabajador** (mismo periodo del filtro):
  - registros;
  - **% con coordenadas idénticas** en las 3 lecturas;
  - **% con precisión idéntica**;
  - **% con ambas a la vez**;
  - **% sin altitud** y lecturas con altitud de 0 m;
  - **altitud mediana y rango**;
  - **altitudes repetidas exactas en días distintos**;
  - variación mediana entre lecturas y precisión mediana;
  - **altitud por sitio**, para revisar la coherencia: Puebla ≈ 2,100–2,200 m, Michigan ≈ 180–200 m.
- **"Patrón sospechoso"** (solo indicador): con 3 o más registros, la mitad o más con coordenada y
  precisión idénticas, o coordenadas idénticas junto con altitud repetida en días distintos.

## Siguiente paso
- Con 2–3 semanas de datos se define la regla de rechazo combinada.

## Probado (PostgreSQL local)
- **Lecturas "reales"** (coordenada, precisión y altitud variando alrededor de 2,150 m) →
  guardadas. Métricas: variación 3.45 m, altitud media 2,150.6 m, variación de altitud 1.2 m.
  Sin patrón sospechoso.
- **Lecturas "falsas"** (3 iguales, ±1 m, sin altitud) en 3 registros → coordenadas idénticas
  100 %, precisión idéntica 100 %, sin altitud 100 % → **Patrón sospechoso**.
- **Desde la pantalla:** el aviso "Verificando ubicación… (1/3)" y la entrada guardada con sus 3
  lecturas.

---

# v2.22 — Corrección: horas asignadas al día equivocado (día en UTC)

## Qué pasaba
- El kiosco guarda la hora en UTC. Una salida a las **19:00 en México** queda como **01:00 del día
  siguiente** en UTC.
- **Reportes ▸ Distribución de horas por Job** y el reporte semanal tomaban el día del texto UTC:
  - la salida del lunes 26 (manual, 19:00) aparecía el **martes 27**;
  - la del martes 27 (19:30) aparecía el **miércoles 28**, donde ya estaba la salida real del 28.
  - El lunes quedaba "Sin salida", el miércoles parecía duplicado y la tabla solo mostraba una de
    las dos salidas.
- **Los filtros de fecha** (de–a) también se comparaban contra la hora UTC, y se perdían o se
  colaban registros de la noche.

## Corrección
- **El día de cada registro se calcula en hora de la planta** (America/Mexico_City), en:
  - Distribución de horas por Job;
  - reporte semanal por trabajador;
  - resumen de Jobs por día;
  - fechas predeterminadas de los filtros.
- **El servidor interpreta los filtros de fecha en hora local** y los convierte a UTC antes de
  comparar: `2026-10-26` = desde las 00:00 de México; `…T23:59:59` = hasta el final de ese día en
  México.
- **Varias salidas el mismo día:** si un día tiene más de una salida, sus horas y su distribución
  por Job se **suman**. Antes solo se mostraba la primera.
- **Horas extra redondeadas a 2 decimales:** ya no aparecen valores como `3.5999999999999996 h`.
- **Los datos no cambian:** ningún registro estaba duplicado; solo se mostraban en el día
  equivocado.

## Probado
- **Semana 44 de 2026** con las salidas del caso (26-oct 19:00 manual, 27-oct 19:30 manual,
  28-oct 17:36 y 1-nov 21:00):
  - Lunes 26 → 13 h (676-61);
  - Martes 27 → 13.5 h (676-61);
  - Miércoles 28 → 13.6 h (ADMIN 11.5 + 676-61 2.1);
  - Domingo 1 → 13 h.
  - Ningún día queda "duplicado" ni "sin salida".
- **El filtro 26-oct a 1-nov** incluye la salida del domingo a las 21:00 (02-nov en UTC) y la
  semana siguiente ya no la incluye.

---

# v2.23 — Registro manual: días olvidados completos y validación por fecha

## Qué pasaba
- **El registro manual validaba solo contra el registro inmediato anterior o siguiente.**
- **Para capturar un día olvidado en el pasado,** la Entrada se rechazaba siempre: el siguiente
  registro era la Entrada del día posterior ("la secuencia quedaría duplicada"), y sin esa Entrada
  tampoco se podía capturar la Salida.

## Tipo nuevo "📅 Día completo (entrada y salida)"
Es el tipo predeterminado al abrir "➕ Registro manual".
- **Se captura:** **fecha**, **hora de entrada** y **hora de salida**.
  - Si la salida es menor que la entrada, se toma como del **día siguiente** (turno nocturno).
- **Muestra la jornada calculada** y pide la **distribución de horas por Job**, igual que una
  salida normal.
- **Validación por FECHA** (día local de la planta):
  - si **ese día ya tiene registros**, no se duplica. Se indica qué tiene:
    - con solo Entrada → "usa Solo Salida";
    - con solo Salida → "usa Solo Entrada";
    - con ambas → "el día ya está completo";
  - **no puede haber registros entre** la entrada y la salida nuevas;
  - **la secuencia con los demás días se mantiene:** antes del día no puede quedar una Entrada sin
    salida, ni después una Salida sin entrada;
  - **no se aceptan** fechas u horas futuras ni jornadas de más de 20 h.
- **Se guardan las dos marcas** (Entrada y Salida) en una sola operación, marcadas como "Registro
  manual", con el motivo, el administrador que las capturó y `dia_completo`.
- **En la ventana,** al elegir trabajador y fecha se avisa si ese día ya tiene registros.

## "Solo Entrada" / "Solo Salida" (para completar un día a medias)
- **Mensajes con fecha:** si una Entrada se rechaza porque lo siguiente es la Entrada de otro día,
  el mensaje sugiere usar "Día completo".
- **Salida a más de 20 h de su Entrada:** se rechaza, porque esa entrada es de otro día.

## Probado
- **Días registrados:** 19 y 21-oct completos, 22-oct solo con Entrada.
  - Solo Entrada el 20 → rechazada, con la sugerencia de "Día completo".
  - **Día completo el 20 (07:00–17:00)** → guardado, 10 h.
- **Rechazos:**
  - repetir el 20 → "el día ya está completo";
  - día completo el 22 → "le falta solo la Salida";
  - sin horas → pide repartirlas;
  - fecha futura → rechazado;
  - el 21 → "ya está completo".
- **Aceptados:**
  - **Solo Salida el 22** → 10 h;
  - **nocturno el 23 (22:00–06:00)** → salida del 24, 8 h.
- **Secuencia final:** Entrada → Salida alternadas del 19 al 24, sin huecos.

---

# v2.24 — Día de viaje

## Para el trabajador
- **Botón nuevo "✈ Día de viaje"** debajo del estado de ubicación, cuando no tiene una entrada
  abierta.
  - Al elegirlo se pide el **destino o motivo** (obligatorio, ej. "Visita a cliente Inteva,
    Bluffton").
  - Se puede quitar antes de registrar ("✕ Quitar").
- **Con el día de viaje elegido:**
  - la **ubicación no es requisito** para registrar la **entrada**: no se valida la geocerca, la
    precisión, la antigüedad ni las coordenadas repetidas;
  - **si el celular da su ubicación, se guarda el punto** (coordenadas y precisión). Si no la da,
    se registra igual.
- **Vale para un solo periodo de trabajo:**
  - mientras la entrada de viaje está abierta, se muestra "✈ Periodo de viaje activo · destino —
    termina al registrar tu salida";
  - la **salida** de ese periodo (y las pausas) tampoco exige ubicación;
  - **al registrar la salida, el día de viaje se desactiva.** La siguiente entrada vuelve a validar
    ubicación, salvo que se elija otra vez.

## En el servidor
- **El servidor decide el periodo de viaje,** no el navegador: la salida y las pausas heredan el
  viaje solo si la última marca del trabajador es una **entrada de viaje**.
- **El registro queda con** `locationName: "Día de viaje"` y `viaje: {activo, motivo, entrada_id,
  punto}`.
- **Opción para RRHH:** la configuración `viaje.habilitado = false` deshabilita los días de viaje
  para todos.

## Para RRHH / administrador
- **Reportes:** la columna Geocerca muestra **✈**, con el motivo al pasar el mouse y un enlace al
  **punto** en el mapa. En el Excel aparece "Día de viaje: destino".
- **🛡 Ubicación ▸ "✈ Días de viaje":** lista de entradas y salidas de viaje del periodo, con
  trabajador, destino/motivo y punto (mapa y precisión). `GET /api/viajes`.

## Probado (PostgreSQL local)
- **Entrada a 578 km sin día de viaje** → rechazada. **Con viaje sin motivo** → pide el motivo.
- **Con viaje y motivo** → aceptada como "Día de viaje", con el punto guardado.
- **Pausa y salida del periodo, sin ubicación** → aceptadas como viaje.
- **Siguiente entrada lejos, sin viaje** → rechazada otra vez.
- **En pantalla:** "✈ Día de viaje" pidió el destino, habilitó los botones fuera de la geocerca y,
  tras la entrada, mostró "Periodo de viaje activo".

---

# v2.25 — Salida automática cuando el trabajador no registra su salida

## Regla
- **Si una Entrada sigue sin Salida a la hora de corte del día siguiente** (por defecto **03:00**,
  hora de la planta), el sistema registra la **Salida automáticamente** con la **jornada normal de
  ese día**:
  - **lunes a jueves:** entrada + **10 h**;
  - **viernes:** entrada + **8 h**;
  - **sábado y domingo:** entrada + las horas configuradas (por defecto **0 h**, porque no hay
    jornada normal). Se cierra el periodo y queda para revisión.
- **Protección para turnos nocturnos:** nunca se cierra antes de **16 h** después de la entrada.
  Así quien entra a las 22:00 no se cierra a las 03:00.
- **Revisión periódica:** cada **10 minutos**, y al iniciar el servidor. Usa un candado en la base
  para que no corra dos veces, y vuelve a verificar por trabajador que la última marca siga siendo
  esa entrada.

## Cómo queda la salida
- **Ubicación** "Salida automática" y `origen: 'auto'`, con `auto_cierre` (regla, horas, hora de
  corte, cuándo se ejecutó y `revisar: true`).
- **Horas base y extra** calculadas igual que una salida normal.
- **Horas por Job pendientes:** al entrar al kiosco, el trabajador ve "El lunes 5 de noviembre no
  registraste tu salida. Se registró automáticamente a las 17:00 con tu jornada normal (10 h).
  Reparte las horas…; si la hora no es correcta, avisa a RRHH".
  - Con 0 h (fin de semana) no se piden horas.
- **Periodo de viaje:** si la entrada era de viaje, la salida automática conserva el viaje.
- **Corrección:** si la hora real fue otra, RRHH puede corregirla con la edición de registros o
  con "Registro manual".

## Reportes ▸ "⏰ Salidas automáticas" (admin y RRHH)
- **Configuración** (solo admin): **hora de corte**, **horas en sábado/domingo** y
  **habilitado/deshabilitado**.
- **Aviso** de las entradas ya vencidas que se cerrarán en el siguiente ciclo, y botón **"Ejecutar
  ahora"**.
- **Lista de salidas automáticas** de los últimos 30 días, con trabajador, entrada, salida, horas y
  si las horas por Job siguen pendientes.

## API
- `GET/PUT /api/autocierre/config`
- `GET /api/autocierre` (salidas automáticas y por cerrar)
- `POST /api/autocierre/ejecutar`

## Probado (PostgreSQL local)
- **Entradas sin salida:**
  - jueves 07:00 → salida **17:00** (10 h base, horas pendientes);
  - viernes 07:00 → **15:00** (8 h);
  - sábado → salida en 0 h, sin horas pendientes.
- **No se tocaron:** una entrada nocturna de hace 10 h (protección de 16 h) ni un trabajador con
  salida.
- **Segunda ejecución:** 0 cierres (no duplica).
- **Configuración:** el cambio de hora de corte y de horas de fin de semana se guarda.

---

# v2.26 — Permiso por trabajador para registrar horas en ADMIN

- **Casilla nueva** en la configuración de cada trabajador (Trabajadores ▸ Editar): **"🗂 Puede
  registrar horas en ADMIN"**.
  - Viene **activada** para todos, así que nadie cambia hasta que se desactive.
- **Si se desactiva:**
  - en la **distribución de horas** (salida, salidas del checador y salidas automáticas) **ya no
    aparece ADMIN**;
  - se avisa "No tienes permitido registrar horas en ADMIN: agrega los Jobs que trabajaste";
  - todas las horas deben ir a Jobs en WIP.
- **El servidor también lo valida.** Rechaza ADMIN para ese trabajador en:
  - la salida;
  - el registro manual (día completo o solo salida);
  - la edición o el reparto posterior de horas (`PATCH` de jobHours).
- **El dato** se guarda en la configuración del trabajador (`permitirAdmin`).

## Probado (PostgreSQL local)
- **ADMIN desactivado para un trabajador:**
  - salida con ADMIN → **rechazada**;
  - salida con el Job 652-50 → aceptada;
  - editar sus horas poniendo ADMIN → **rechazado**.
- **Reactivado** → la edición con ADMIN se acepta.
- **En pantalla:** la ventana de distribución no muestra ADMIN y avisa. La casilla aparece en la
  edición del trabajador con su valor.

---

# v2.27 — Comparación contra todos los puntos registrados y administración delegada a RRHH

## Comparación contra los puntos registrados
- **Si el trabajador está fuera de sus puntos asignados,** el servidor revisa si está **dentro de
  otro punto de registro existente** (con la misma tolerancia de hasta 30 m por imprecisión).
  - **Si lo está:** el registro **se acepta** en ese punto, marcado como **punto no asignado**
    (`punto_no_asignado: {id, name}`), y se genera una **alerta** para RRHH.
  - **Si no está dentro de ningún punto registrado:** se rechaza, como antes.
- **No se aceptan ubicaciones fuera de los puntos registrados** (no hay solicitudes de puntos
  nuevos), y siguen aplicando todas las validaciones contra GPS falso.
- **En el kiosco,** el trabajador ve: "Estás en **PERSICO USA**, un punto registrado que no tienes
  asignado. Puedes registrar; se avisará a RRHH".
  - Si tiene varios puntos asignados y no eligió uno, se usa automáticamente el punto donde está.
- **Aplica a** entradas, salidas y pausas.

## 🛡 Ubicación ▸ "📍 Registros en puntos no asignados"
- **Lista** de los registros aceptados en puntos no asignados: fecha, trabajador, punto y tipo.
- **Botón "Asignar punto"**: agrega ese punto a los puntos del trabajador, conservando los que ya
  tenía (`POST /api/locations/:id/asignar`).

## Administración delegada
- **RRHH ve la pestaña 📍 Ubicaciones** y puede crear y editar puntos de registro y asignarlos a
  trabajadores. Así no depende solo del administrador cuando está de vacaciones o ausente.
- **Bitácora en cada punto** (`historial`): quién lo creó o modificó, cuándo y qué campos cambió.

## Probado (PostgreSQL local)
- **Trabajador con el punto "Planta" asignado:**
  - registro lejos de todo → **rechazado**;
  - registro dentro de "PERSICO USA" (no asignado) → **aceptado** en PERSICO USA, con
    `punto_no_asignado` y la alerta "Registro en punto no asignado: PERSICO USA (28 m)".
- **"Asignar punto"** → el trabajador queda con Planta y PERSICO USA. La siguiente salida ya no se
  marca como no asignada.
- **Bitácora:** el alta y la edición del radio por "rrhh" quedan registradas.
- **En pantalla:** el mensaje del punto no asignado aparece y el botón de entrada queda
  habilitado.
