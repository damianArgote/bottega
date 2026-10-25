# Feature: inbox-api (prompt 04)
Objective: everything the inbox web app needs to list, read, answer and hand conversations between the bot and a person. Source: `docs/prompts/04-api-bandeja.md`.
Branches `feat/inbox-api-<n>-*`, one PR per task against `develop` (no stacking); one release to `main` after T4. Schema changes are expand-only. Test runner: vitest (unit for the pure state rules, int with Postgres for SQL, triggers, concurrency and HTTP, e2e with mocks).

## Specs
Quoted verbatim from the prompt (Spanish). Assumptions are marked.

- **S1 State.** "Agregá a `Conversation`: `status` (`OPEN` | `PENDING` | `RESOLVED`, default `OPEN`), `assignedToId` (nullable, FK a `User`), `unreadCount`, `lastMessageAt`, `lastMessagePreview` (máx. 120 caracteres), `windowExpiresAt`. Índices: `(lineId, status, lastMessageAt desc)`, `(assignedToId, status)`." and "Reglas (en un servicio de dominio puro, con tests unitarios):"
- **S2 Inbound.** "Entrante: `unreadCount + 1`, actualiza preview y `lastMessageAt`, `windowExpiresAt = max(actual, occurredAt + 24 h)` (nunca retrocede). Si estaba `RESOLVED`, vuelve a `OPEN` y queda sin asignar."
  - Assumption A10: an inbound message on a `PENDING` conversation keeps it `PENDING`.
- **S3 Who attends.** "**Quién atiende:** si `assignedToId` no es null o `paused` es true, el bot no responde (el job termina como "skipped"). El `paused` actual y el handoff existente se integran con esto: un handoff del bot deja la conversación `PENDING` y sin asignar, para que aparezca en "Pendientes"."
  - Assumption A2: a new `JobStatus` value `SKIPPED`.
- **S4 Take.** "Tomar: falla con 409 si ya la tiene otro, salvo `force=true` (solo `OWNER`). Responder una conversación sin asignar la toma sola."
  - Assumption A8: taking sets `status = OPEN`.
- **S5 Release.** "Soltar: `assignedToId = null`; el bot sigue callado hasta que alguien elija "Devolver al bot"."
  - Assumption A11: release also sets `paused = true`, so the bot stays quiet.
- **S6 Hand back.** "Devolver al bot: `assignedToId = null`, `paused = false`, `status = OPEN`."
- **S7 Resolve.** "Resolver: `status = RESOLVED`, `assignedToId = null`, `paused = false`."
- **S8 Change tracking.** "Toda escritura que deba verse en la bandeja (incluidos los ticks de entregado/leído) actualiza la conversación, así el trigger le asigna un `changeTxid` nuevo y sube `version`."
- **S9 System messages.** "Cada acción deja un `Message` de tipo `SYSTEM` en el hilo ("Damián tomó la conversación")."
  - Assumption A3: SYSTEM messages are never sent to WhatsApp and never reach the model's history.
- **S10 List.** "`GET /conversations?view=mine|unassigned|pending|resolved&lineId=&q=&cursor=` → paginado por `(lastMessageAt, id)` descendente, 30 por página."
  - Assumption A7: `mine` = assigned to me and not resolved; `unassigned` = no assignee and `OPEN`; `pending` = `PENDING`; `resolved` = `RESOLVED`.
  - Assumption A5: `q` matches the contact's name or number.
  - Assumption A6: `lineId` must be a line of the business.
- **S11 Changes.** "`GET /changes?cursor=` → conversaciones que cambiaron desde el cursor, máx. 200, más el nuevo cursor **del servidor** y `hasMore`. Si `hasMore`, la web vuelve a pedir enseguida. El cursor es opaco."
  - "**No uses `updatedAt` ni `createdAt` como cursor:** una transacción que empezó antes y confirma después deja filas con fecha vieja que el cursor ya pasó, y esos cambios se pierden."
  - "Agregá a `Conversation` una columna `changeTxid bigint` que un trigger (`BEFORE INSERT OR UPDATE`, escrito a mano en la migración) completa con `pg_current_xact_id()::text::bigint`. Índice `(lineId, changeTxid)`."
  - "La consulta devuelve las filas con `changeTxid >= cursor` y, en la misma sentencia, calcula el cursor nuevo como `pg_snapshot_xmin(pg_current_snapshot())::text::bigint`. Todo lo que tenga un txid menor ya está confirmado y visible, así que nada se pierde. Puede repetir alguna fila: la web descarta por `(id, version)`, con un `version int` que sube en cada cambio."
  - "Paginación con `hasMore`: ordená por `(changeTxid, id)` y, si cortás en 200, el cursor es el de la última fila devuelta (no el xmin)."
  - "Funciona detrás del pooler de Neon en modo transacción (no usa estado de sesión). Test int: dos transacciones concurrentes, la que empezó primero confirma después, y `/changes` igual la devuelve."
- **S12 Messages.** "`GET /conversations/:id/messages?before=&after=` → 50 por página, paginado por el `id` autoincremental del mensaje (no por fecha). `after` es lo que usa la web para traer los nuevos de la conversación abierta."
  - Assumption A1: `Message.id` is a uuid, so a new autoincrement `Message.seq` (bigint) is the paging key, numbered for existing rows by `(created_at, id)`.
- **S13 Read.** "`POST /conversations/:id/read` → `unreadCount = 0` y marca leído en Meta el último entrante (si falla, se ignora)."
- **S14 Send.** "`POST /conversations/:id/messages` `{ body, clientId }` → valida ventana **antes** de llamar a Meta (si está cerrada: 409 con `code: "WINDOW_CLOSED"`), guarda `QUEUED` con `idempotencyKey = clientId`, envía y pasa a `SENT` con `wamid` o `FAILED` con el código. Reusá el envío que ya usa `AdminService` para respuestas humanas. Un mismo `clientId` no envía dos veces."
  - Assumption A4: `windowExpiresAt` becomes the only window rule (admin replies too); `lastInboundAt` is still written.
- **S15 Actions.** "`POST /conversations/:id/take | release | handback | resolve`."
- **S16 Lines.** "`GET /lines` (líneas del negocio)."
- **S17 Meta errors.** "Mapeá en un solo lugar: `131047` → ventana cerrada (actualizá `windowExpiresAt` a ahora); `131026` → no entregable; `130429`, `131056`, `131048`, `131049`, `80007`, `4` → límite de tasa; timeout o 5xx → `UNCERTAIN` y **no** reintentar."
- **S18 Out of scope.** "Plantillas y media (prompt 06), notas internas, Web Push, etiquetas."
- **S19 Acceptance.** "int: dos operadores toman la misma conversación en paralelo y solo uno gana; con una conversación asignada, un entrante no genera respuesta del bot; "devolver al bot" hace que el siguiente entrante sí la genere; un tick de leído aparece en `/changes`; 250 cambios seguidos se leen completos en dos llamadas a `/changes`." and "e2e: enviar con ventana vencida da 409 sin llamar a Meta (cliente de Graph mockeado)." and "Lint, unit, e2e e int en verde."

## Tasks
| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S2, S8 (trigger, version, writes that touch the row), S12 column (A1) | inline | pending | |
| T2 | S3, S4, S5, S6, S7, S9, S15, S19 (take race, assigned/handback) | inline | pending | |
| T3 | S10, S11, S12, S16, S19 (/changes tests) | inline | pending | |
| T4 | S13, S14, S17, S19 (e2e window) | inline | pending | |

Route evidence: each task builds on the previous (state → actions → reads → writes), so there is no parallel writer reason. High-risk items: T1 trigger and backfill migration (1), concurrency of the cursor (4); T2 take race (4) and the bot's reply decision (6); T3 cursor correctness (4); T4 sending to Meta (6) and the shared admin send path (3).

## Log
- L1 (2026-10-25, user): "listo, el bot respondió. arrancá el 04". The authoritative request text is `docs/prompts/04-api-bandeja.md`.
- L2 (2026-10-25): explorer map. `Message.id` is a uuid (A1); `MessageType.SYSTEM` exists but nothing writes it, and the model history takes every non-failed outbound row (must exclude SYSTEM); `JobStatus` has no skipped value and a paused job ends COMPLETED (A2); status ticks only update message rows; the admin send already checks the window before Meta (`serviceWindow(lastInboundAt)`), with a plain 409; the Graph client has no mark-read and only treats 4/80007/130429/131056 and HTTP 429 as retryable; conversation rows are written by the inbound upsert (raw SQL), context changes, pause/resume/requestHuman and the out-of-hours notice; no triggers exist yet.
- Next: T1.
