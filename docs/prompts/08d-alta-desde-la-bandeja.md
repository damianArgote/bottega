# Prompt 08d · Alta de clientes desde la bandeja (rol de equipo)

> Correlo después del 08a (ya en producción). Son dos PRs: primero el backend (sesión sobre `bottega`) y después la web (sesión sobre `bottega-inbox`). Objetivo: que el equipo de BotSuite46 dé de alta un cliente desde la bandeja (negocio, línea, credenciales, número, app y dueño) sin usar `curl` ni la `ADMIN_API_KEY`, y vea el estado y la calidad de todas las líneas.

Regla de todo el prompt: **el rol de equipo solo da de alta y ve el estado de las líneas.** No ve conversaciones, mensajes, leads ni el agente de otros negocios: eso sigue filtrado por `BusinessAccessGuard` como hoy. Actualizá la regla de `CLAUDE.md` en el mismo PR: "Un usuario nunca ve conversaciones, mensajes ni leads de otro negocio. El equipo (`STAFF`) solo da de alta negocios y líneas y ve su estado."

---

## Parte 1 · Backend (rama `feat/staff-onboarding`, repo `bottega`)

### Rol de equipo
- Columna nueva `app_user.staff boolean not null default false` (solo expande).
- Solo se da y se saca con la API de admin: `PUT /admin/users/:userId/staff` con `{ "staff": true|false }`. Nunca desde la bandeja.
- `StaffGuard`: después de `SessionGuard`, lee `staff` y `active` del usuario **en la base en cada pedido** (no en el token de la sesión), así que sacarle el rol corta el acceso al instante. Si no es staff: 403.
- `GET /auth/me` suma `staff: boolean`. Solo agrega un campo: el resto de la respuesta no cambia.

### Rutas `/staff/...` (SessionGuard + StaffGuard)
Reusan los servicios que ya existen (`BusinessesService`, `LineOnboardingService`, `UsersService`), con las mismas validaciones Zod que la API de admin. No reimplementes nada:
- `GET /staff/lines/status`: lo mismo que `GET /admin/lines/status`.
- `POST /staff/businesses` (`name`, `slug`, `botName`).
- `POST /staff/businesses/:businessId/lines`: solo crea borradores (body vacío). Devuelve `webhookUrl` y `verifyToken`.
- `PUT /staff/lines/:lineId/credentials`, `GET /staff/lines/:lineId/phone-numbers`, `POST /staff/lines/:lineId/register`, `POST /staff/lines/:lineId/subscribe`, `POST /staff/lines/:lineId/app-published`.
- `POST /staff/businesses/:businessId/owners` (`email`, `name`): crea el dueño (`OWNER`) con una contraseña temporal que se muestra **una sola vez** y `mustChangePassword`. Es el mismo flujo de alta de usuarios que ya existe.
- Protección contra CSRF igual que el resto de las mutaciones de `/inbox` (revisá `configureHttp`).
- Log de auditoría en nivel `info` por cada acción: id del usuario, acción e id del negocio o la línea. Nunca secretos, PIN ni bodies.

### Pruebas (int)
- Un `OWNER` o un `AGENT` sin `staff` recibe 403 en **todas** las rutas `/staff`.
- Sacar `staff` corta el acceso en el pedido siguiente, sin cerrar la sesión.
- Un usuario `staff` sin membresía en el negocio B sigue recibiendo 403 en `/inbox/businesses/B/conversations`, `/leads` y `/settings/agent`.
- Ninguna respuesta incluye el token, el App Secret, el PIN ni el verify token, salvo el `verifyToken` del alta del borrador.
- `PUT /admin/users/:userId/staff` exige la `ADMIN_API_KEY`.
- `GET /auth/me` devuelve todo lo de antes y además `staff`.
- Lint, unit, e2e e int en verde. Es un cambio de permisos (riesgo alto): lleva verificador independiente antes del PR.

## Parte 2 · Web (rama `feat/staff-onboarding`, repo `bottega-inbox`)

- Menú **"Equipo BotSuite46"** visible solo si `GET /auth/me` devuelve `staff: true`.
- **Clientes:** tabla con todas las líneas de `GET /staff/lines/status`: negocio, número, calidad (verde "Buena", amarilla "Media", roja "Baja", sin datos "Sin datos") y lo que falta (`pending`). Avisa si `otherApps` es true.
- **Nuevo cliente:** asistente paso a paso, que se puede retomar desde la tabla si quedó a mitad:
  1. Negocio: nombre, slug y nombre del bot.
  2. Borrador: muestra `webhookUrl` y `verifyToken` con botón copiar y el texto "Pegalos en la app de Meta → WhatsApp → Configuración → Webhooks y verificá".
  3. Credenciales: WABA ID, App ID, App Secret y token. Los secretos son `type="password"`, se limpian al guardar y nunca se vuelven a mostrar. Ayuda: "El WABA ID está en la app de Meta → WhatsApp → Configuración de la API (no el de Cuentas de WhatsApp)".
  4. Número: elegir de la lista de `phone-numbers` (nunca escribir el id) y cargar el PIN de 6 dígitos.
  5. Suscribir la app: si `otherApps` es true, avisar que hay otra app en el número.
  6. App publicada: botón "Ya la pasé a Live", con el recordatorio de la URL de privacidad `https://botsuite46.com/privacidad`.
  7. Dueño: email y nombre; muestra la contraseña temporal una sola vez, con botón copiar.
- Cada error muestra el `message` de la API, que ya viene en castellano, no el código.
- Tests de los stores con la API mockeada: sin `staff` no aparece el menú; los secretos se borran después de guardar; la contraseña temporal no se puede volver a ver; un 400 muestra su `message`.
- Usable en el celular, igual que la bandeja.

## Fuera de alcance
Ver conversaciones de otros negocios, editar el agente de un cliente desde el rol de equipo, borrar negocios o líneas, Embedded Signup.
