# Prompt 08 · Alta de clientes sin consola ni tokens en el navegador

> Correlo después del 05b y **antes del 07**: hay clientes esperando para conectarse. Son tres PRs: 08a (backend, repo `bottega`), 08b (web, repo `bottega-inbox`) y 08c (landing, repo `botsuite46-landing`). Objetivo: que el alta de un cliente se haga en una sola llamada siguiendo la guía de conexión, sin la "Consola de alta" (una página que manda el token permanente a Meta desde el navegador), y que el cliente vea en su bandeja en qué estado está su conexión.

Regla de todo el prompt: **el token permanente y el App Secret entran una sola vez a la API y nunca vuelven a salir**, ni en respuestas, ni en logs, ni en el navegador. Todo lo que hoy hace la consola contra Meta lo hace el backend con las credenciales cifradas de la `Line`.

Fuente: la guía de conexión (vistas "Para el cliente" y "Para el equipo") y la Consola de alta, cuyos pasos se reemplazan así:

| Consola | Reemplazo |
|---|---|
| 1 · Probar el webhook | La línea en borrador ya tiene URL y verify token; `GET /webhooks/whatsapp/:webhookKey` ya existe. |
| 2 · `GET /{WABA_ID}/phone_numbers` | `GET .../phone-numbers` de la línea; el número se elige a mano (la consola tomaba el primero). |
| 3 · `POST /{PHONE_NUMBER_ID}/register` | `POST .../register` con el PIN. |
| 4 y 5 · `subscribed_apps` | `POST .../subscribe`: suscribe y comprueba en el mismo pedido. |

---

## 08a · Backend (rama `feat/line-onboarding`, repo `bottega`)

### Línea en borrador (expandir, sin romper `main`)
- Hoy `POST /admin/businesses/:id/lines` exige `phoneNumberId` y el token de entrada, pero la guía carga el webhook **antes** de que exista el número. Hacé `phoneNumberId` nullable (sigue `@unique`: Postgres permite varios null) y agregá `onboardingStatus` (`DRAFT` | `CREDENTIALS` | `REGISTERED` | `LIVE`, default `LIVE` para que las filas existentes queden como están).
- `POST /admin/businesses/:id/lines` con body vacío crea un borrador: devuelve `webhookUrl` y `verifyToken` para pegar en la app de Meta. El body completo de hoy sigue funcionando igual (mismo resultado, mismo `subscribeApp`).
- Un borrador sin App Secret responde el `GET` de verificación, pero **todo `POST` al webhook da 403** (no hay con qué validar la firma). Un borrador nunca rutea entrantes ni manda mensajes.

### Credenciales
- `PUT /admin/lines/:lineId/credentials` (`wabaId`, `appId`, `appSecret`, `accessToken`): antes de guardar, validá contra Meta que el token ve ese WABA (`GET /{WABA_ID}?fields=id,name`). Si falla, 400 con el error explicado y no se guarda nada. Si pasa, se cifran con el `credentials-cipher` existente y la línea pasa a `CREDENTIALS`.
- Tiene que ser reutilizable para el camino B (el cliente carga sus credenciales desde la bandeja, ver 08b).

### Acciones contra Meta (con el token cifrado de la línea)
- `GET /admin/lines/:lineId/phone-numbers`: `GET /{WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,status,quality_rating`.
- `POST /admin/lines/:lineId/register` (`phoneNumberId`, `pin` de 6 dígitos): comprueba que el número es del WABA de la línea, llama a `POST /{PHONE_NUMBER_ID}/register`, guarda `phoneNumberId` y `displayPhone`, y pasa la línea a `REGISTERED`. El PIN **no se guarda** ni se loguea.
- `POST /admin/lines/:lineId/subscribe`: `POST /{WABA_ID}/subscribed_apps` y después el `GET` del mismo recurso. Devuelve las apps suscriptas y avisa si hay otra además de la nuestra (caso B: dos bots responderían).
- La línea pasa a `LIVE` cuando llega el primer webhook firmado de ese número.

### App de Meta publicada
- La app de cada cliente se publica (modo **Live**) en la misma llamada: Meta avisa que en modo desarrollo "some webhooks will not be sent". Para publicarla pide la URL de la política de privacidad (la de BotSuite46, ver 08c), la categoría y el ícono.
- No hay un campo de Graph confiable para leer el modo de la app, así que lo confirma el equipo: `POST /admin/lines/:lineId/app-published` guarda `appPublishedAt` (columna nullable nueva). El estado de la conexión lo muestra como un paso más y, mientras sea null, avisa "Falta publicar la app en Meta".
- La app de BotSuite46 (la línea por defecto) también se publica; es el primer uso de la URL de privacidad.

### Estado de la conexión
- `GET /admin/lines/:lineId/status` y `GET /inbox/businesses/:businessId/settings/whatsapp` (`OWNER`): `onboardingStatus`, número, nombre visible y su aprobación (`name_status`), `code_verification_status`, `quality_rating`, si la app está suscripta y la fecha del último `WebhookEvent` de la línea. Sin tokens, sin secretos, sin `verifyToken` en la ruta de la bandeja.
- Las consultas a Meta del estado se cachean 60 s por línea para no gastar el rate limit con el polling de la web.

### Errores de Meta en castellano
Sumá a `src/whatsapp/meta-errors.ts` los códigos del alta, con un texto para el usuario en rioplatense:
- 190: el token no es válido o venció.
- 200 y 10: el token no tiene permiso sobre esta cuenta (falta asignar la app o la cuenta de WhatsApp al usuario del sistema con control total).
- 100: algún ID está mal o no corresponde a esta cuenta.
- 133005 (o subcódigo 2388023): el PIN no coincide.
- 133006: el número todavía no está verificado con el código SMS.
- 133016: demasiados intentos de registro; esperar antes de reintentar.

Los errores de envío que ya están (131047, 131026, rate limit) no cambian.

### Pruebas
- unit: el mapeo de cada código nuevo.
- e2e (con el cliente de Graph mockeado): el borrador devuelve la URL y el verify token; el `POST` al webhook de un borrador da 403; credenciales con un token que Meta rechaza dan 400 y no se guardan; `register` con un número de otro WABA da 400; un PIN de 5 dígitos da 400; ninguna respuesta incluye el token, el App Secret ni el PIN; mientras `appPublishedAt` sea null el estado muestra el paso pendiente de publicar la app; un `OWNER` del negocio A no ve el estado del B; un `AGENT` recibe 403.
- El alta con el body completo de hoy sigue devolviendo lo mismo que antes.
- Lint, unit, e2e e int en verde.

## 08b · Web (rama `feat/whatsapp-connection`, repo `bottega-inbox`)
- Pantalla **Configuración → WhatsApp**, solo para `OWNER`: muestra el estado de `GET /settings/whatsapp` como una lista de pasos (cuenta, número verificado, registrado, app suscripta, app publicada, nombre visible aprobado, primer mensaje recibido), cada uno con un texto claro de qué falta y quién lo hace. Polling cada 30 s mientras no esté `LIVE`.
- Calidad de la línea siempre visible en esa pantalla (no solo durante el alta), con `number.qualityRating`: verde "Buena", amarilla "Media" y roja "Baja" (con el texto: "Meta puede limitar los envíos de este número si la calidad sigue baja"). Si no se pudo consultar, "Sin datos" y el `metaError`.
- Cuando la línea pasa a `LIVE`, aviso en la bandeja: "Tu WhatsApp ya está conectado. Escribile al bot desde tu celular para probarlo."
- Camino B (el cliente no nos da acceso): formulario para pegar WABA ID, App ID, App Secret y token contra un `PUT /inbox/businesses/:businessId/settings/whatsapp/credentials` (`OWNER`, misma validación que la de admin). Los campos secretos son `password`, se limpian al guardar y nunca se vuelven a mostrar.
- Tests de los stores con el API mockeado: cada estado muestra su paso pendiente; un error de Meta muestra su texto, no el código.

## 08c · Landing (repo `botsuite46-landing`)

### Política de privacidad (primero: sin ella no se publica ninguna app)
- Página estática `https://botsuite46.com/privacidad`, sin scripts (no toca la CSP de `netlify.toml`), enlazada desde el pie de `index.html` y sumada a `sitemap.xml`.
- Una sola política de BotSuite46 para todas las apps de clientes, en español. Tiene que decir: quién es el responsable y un contacto; qué datos se tratan (número y nombre de perfil de WhatsApp, contenido de los mensajes, datos que el negocio pide como lead); para qué (responder por el negocio, derivar a una persona, mostrar la conversación en la bandeja); con quién se comparten (Meta para WhatsApp, OpenAI para generar respuestas, y los proveedores de base de datos y hosting); que BotSuite46 trata los datos por cuenta de cada negocio cliente; cuánto tiempo se guardan; cómo pedir acceso, corrección o borrado (sección con ancla `#borrar-datos`, que también sirve si Meta pide una URL de instrucciones de eliminación de datos); y la referencia a la Ley 25.326 de Protección de Datos Personales.
- La redacción final la revisa el dueño de BotSuite46 antes de publicarla: el prompt arma el borrador, no es asesoramiento legal.

### Guía para el cliente
- Página pública con la vista "Para el cliente" de la guía: las tres preguntas (cuenta comercial, tipo de número, acceso), el checklist de antes de la llamada, los avisos según el número, los costos de Meta y "Qué no hacer".
- Al final, "Agendar la llamada" con las respuestas de las tres preguntas ya cargadas en el mensaje de WhatsApp a BotSuite46 (sin backend nuevo).
- La vista "Para el equipo" **no** se publica.

## Fuera de alcance
Embedded Signup de Meta (necesita ser Tech Provider), coexistencia de la app del celular con el bot, migrar números entre portfolios (caso C), alta de negocios desde la bandeja.

## Criterio de aceptación
- Un alta completa (borrador → webhook verificado en Meta → credenciales → registrar → suscribir → app publicada → primer mensaje) se hace sin abrir la Consola de alta, y el token no pasa por ningún navegador en el camino A.
- `https://botsuite46.com/privacidad` responde 200 y es la URL cargada en cada app publicada.
- El dueño ve en la bandeja qué paso falta sin preguntarle al equipo.
