# Prompt 05 · Bandeja web en Angular (repo nuevo `bottega-inbox`)

> Correlo en una sesión de Claude Code sobre un repo vacío `bottega-inbox`. Pegale también la lista de rutas del prompt 04 (o el `README` del backend con esa sección) para que tenga el contrato.

---

Creá una SPA en **Angular (última versión estable, standalone components, signals, nuevo control flow)** con **PrimeNG** y **Tailwind CSS** (usando el preset de PrimeNG para Tailwind si corresponde a la versión). Es la bandeja de WhatsApp de `bottega-api`. Textos en español rioplatense.

## Arquitectura
- `core/`: `ApiClient` (HttpClient con `withCredentials: true`, base URL desde `environment`), interceptor que ante 401 llama a `/auth/refresh` una vez y reintenta, `AuthStore` (signals) con usuario, negocios y negocio activo.
- `features/auth`: login.
- `features/inbox`: `ConversationsStore` (signals) que guarda el mapa de conversaciones y el cursor, `MessagesStore` por conversación, componentes de presentación sin lógica de red.
- Tipos del contrato en `shared/api-types.ts`. Nada de `any`.
- Rutas: `/login`, `/b/:businessId/inbox`, `/b/:businessId/inbox/:conversationId`. Guard que exige sesión.

## Pantallas
- **Layout de tres zonas** en escritorio (vistas a la izquierda, lista al medio, hilo a la derecha); en celular, lista y hilo en pantallas separadas. Tiene que ser usable a 400 px: el dueño del negocio va a contestar desde el teléfono.
- **Vistas:** Mías, Sin asignar, Pendientes, Resueltas, con contador de no leídos. Selector de línea si el negocio tiene más de una.
- **Lista:** nombre o número, preview, hora relativa, badge de no leídos, chip de quién atiende (Bot / nombre / Pendiente).
- **Hilo:** burbujas por dirección; las del bot con una marca distinta de las de una persona; mensajes de sistema centrados; ticks de enviado/entregado/leído/fallido; separador por día.
- **Barra superior del hilo:** Tomar, Soltar, Devolver al bot, Resolver, según el estado. Banner "La ventana de 24 h está cerrada: solo se puede escribir con una plantilla" cuando `windowExpiresAt` pasó (deshabilita el composer).
- **Composer:** Enter envía, Shift+Enter salto de línea. Envío optimista con `clientId` (UUID); si falla, la burbuja queda en rojo con "Reintentar" que reusa el mismo `clientId`.

## Tiempo real
- Polling a `/changes` cada 5 s con el cursor que devuelve el servidor; si `hasMore`, pedir de nuevo enseguida. El servidor puede repetir conversaciones: aplicá un cambio solo si su `version` es mayor que la guardada. Cuando la pestaña está oculta (`visibilitychange`), parar el polling y retomarlo al volver (así la base de Neon puede apagarse fuera de horario).
- Al abrir una conversación, `POST /read`. Si llega un cambio de la conversación abierta, pedir los últimos 50 mensajes y mezclarlos por `id` con los que ya están (no alcanza con pedir solo los posteriores al último `id`: uno con `id` menor puede confirmarse después).

## Deploy
- Build estático en **Cloudflare Pages** (o Vercel). Documentá en el README la variable de la URL del backend y que el backend tiene que tener `INBOX_ORIGIN` con el dominio de Pages.
- Si el backend y la web quedan en dominios distintos, las cookies `SameSite=Lax` no viajan en `fetch` cross-site: proponé servir la API en un subdominio del mismo dominio (`api.tudominio` y `inbox.tudominio`) y explicá el cambio necesario, o usá `SameSite=None; Secure` y decime cuál elegiste y por qué.

## Calidad
- ESLint + Prettier. Tests de los stores (Vitest o el runner que traiga la versión de Angular) con el API mockeado: aplicar `/changes`, envío optimista y reintento, reglas de botones según estado.
- Accesible: foco visible, botones con texto, contraste AA en tema claro y oscuro.

## Fuera de alcance
Plantillas, adjuntos, notas internas, Web Push, administración de usuarios (se hace con la API de admin).
