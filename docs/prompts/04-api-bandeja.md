# Prompt 04 · API de la bandeja y el bot como participante

> Objetivo: todo lo que la web necesita para listar, leer, responder y pasar conversaciones entre el bot y una persona.

---

Tarea: módulo `inbox` con su API. Rama `feat/inbox-api`. Todas las rutas bajo `/inbox/businesses/:businessId` con `SessionGuard` + `BusinessAccessGuard`.

## Estado de la conversación
Agregá a `Conversation`: `status` (`OPEN` | `PENDING` | `RESOLVED`, default `OPEN`), `assignedToId` (nullable, FK a `User`), `unreadCount`, `lastMessageAt`, `lastMessagePreview` (máx. 120 caracteres), `windowExpiresAt`. Índices: `(lineId, status, lastMessageAt desc)`, `(assignedToId, status)`.

Reglas (en un servicio de dominio puro, con tests unitarios):
- Entrante: `unreadCount + 1`, actualiza preview y `lastMessageAt`, `windowExpiresAt = max(actual, occurredAt + 24 h)` (nunca retrocede). Si estaba `RESOLVED`, vuelve a `OPEN` y queda sin asignar.
- **Quién atiende:** si `assignedToId` no es null o `paused` es true, el bot no responde (el job termina como "skipped"). El `paused` actual y el handoff existente se integran con esto: un handoff del bot deja la conversación `PENDING` y sin asignar, para que aparezca en "Pendientes".
- Tomar: falla con 409 si ya la tiene otro, salvo `force=true` (solo `OWNER`). Responder una conversación sin asignar la toma sola.
- Soltar: `assignedToId = null`; el bot sigue callado hasta que alguien elija "Devolver al bot".
- Devolver al bot: `assignedToId = null`, `paused = false`, `status = OPEN`.
- Resolver: `status = RESOLVED`, `assignedToId = null`, `paused = false`.
- Toda escritura que deba verse en la bandeja (incluidos los ticks de entregado/leído) actualiza la conversación, así el trigger le asigna un `changeTxid` nuevo y sube `version`.
- Cada acción deja un `Message` de tipo `SYSTEM` en el hilo ("Damián tomó la conversación").

## Rutas
- `GET /conversations?view=mine|unassigned|pending|resolved&lineId=&q=&cursor=` → paginado por `(lastMessageAt, id)` descendente, 30 por página.
- `GET /changes?cursor=` → conversaciones que cambiaron desde el cursor, máx. 200, más el nuevo cursor **del servidor** y `hasMore`. Si `hasMore`, la web vuelve a pedir enseguida. El cursor es opaco.
  - **No uses `updatedAt` ni `createdAt` como cursor:** una transacción que empezó antes y confirma después deja filas con fecha vieja que el cursor ya pasó, y esos cambios se pierden.
  - Agregá a `Conversation` una columna `changeTxid bigint` que un trigger (`BEFORE INSERT OR UPDATE`, escrito a mano en la migración) completa con `pg_current_xact_id()::text::bigint`. Índice `(lineId, changeTxid)`.
  - La consulta devuelve las filas con `changeTxid >= cursor` y, en la misma sentencia, calcula el cursor nuevo como `pg_snapshot_xmin(pg_current_snapshot())::text::bigint`. Todo lo que tenga un txid menor ya está confirmado y visible, así que nada se pierde. Puede repetir alguna fila: la web descarta por `(id, version)`, con un `version int` que sube en cada cambio.
  - Paginación con `hasMore`: ordená por `(changeTxid, id)` y, si cortás en 200, el cursor es el de la última fila devuelta (no el xmin).
  - Funciona detrás del pooler de Neon en modo transacción (no usa estado de sesión). Test int: dos transacciones concurrentes, la que empezó primero confirma después, y `/changes` igual la devuelve.
- `GET /conversations/:id/messages?before=&after=` → 50 por página, paginado por el `id` autoincremental del mensaje (no por fecha). `after` es lo que usa la web para traer los nuevos de la conversación abierta.
- `POST /conversations/:id/read` → `unreadCount = 0` y marca leído en Meta el último entrante (si falla, se ignora).
- `POST /conversations/:id/messages` `{ body, clientId }` → valida ventana **antes** de llamar a Meta (si está cerrada: 409 con `code: "WINDOW_CLOSED"`), guarda `QUEUED` con `idempotencyKey = clientId`, envía y pasa a `SENT` con `wamid` o `FAILED` con el código. Reusá el envío que ya usa `AdminService` para respuestas humanas. Un mismo `clientId` no envía dos veces.
- `POST /conversations/:id/take | release | handback | resolve`.
- `GET /lines` (líneas del negocio).

## Errores de Meta
Mapeá en un solo lugar: `131047` → ventana cerrada (actualizá `windowExpiresAt` a ahora); `131026` → no entregable; `130429`, `131056`, `131048`, `131049`, `80007`, `4` → límite de tasa; timeout o 5xx → `UNCERTAIN` y **no** reintentar.

## Fuera de alcance
Plantillas y media (prompt 06), notas internas, Web Push, etiquetas.

## Criterio de aceptación
- int: dos operadores toman la misma conversación en paralelo y solo uno gana; con una conversación asignada, un entrante no genera respuesta del bot; "devolver al bot" hace que el siguiente entrante sí la genere; un tick de leído aparece en `/changes`; 250 cambios seguidos se leen completos en dos llamadas a `/changes`.
- e2e: enviar con ventana vencida da 409 sin llamar a Meta (cliente de Graph mockeado).
- Lint, unit, e2e e int en verde.
