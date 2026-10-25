# Feature: web-push (prompt 05c)
Objective: an inbox person gets a system notification (with sound) when a contact needs someone, even with the inbox closed. Source: `~/projects/bottega-inbox` commit deabfdf `docs/prompts/05c-web-push.md` (web part: P4 of `odd/tasks/pwa-notificaciones.md` there).
Branch `feat/web-push`, one PR against `develop` (user: "rama feat/web-push, PR contra develop"), work-unit commits. Schema changes expand-only. Test runner: vitest (unit, e2e, int).

## Specs
Quoted from the prompt (Spanish). Assumptions are marked.

- **S1 Recipients (pure rule).** "Mensaje entrante (`direction: INBOUND`, `author: USER`) en una conversación: asignada a alguien → solo a esa persona; sin asignar y `PENDING`, o sin asignar y con el bot pausado (la soltaron) → a todas las personas activas del negocio; atendida por el bot (sin asignar, no pausada, `OPEN`) → a nadie". "El bot la pasa a una persona (`onHandoff`, queda `PENDING`) → a todas las personas activas del negocio." "Nunca se avisa a quien escribió el mensaje ni a usuarios inactivos o sin pertenencia al negocio."
  - A1: "active" = active membership in the business AND an enabled account (`User.active`), as the last-OWNER rule.
  - A2: an assignee who is no longer an active member gets nothing (nobody else either).
- **S2 Data.** "Tabla `PushSubscription`: `id`, `userId`, `endpoint` (único), `p256dh`, `auth`, `userAgent?`, `createdAt`, `lastSuccessAt?`." "`JobType` suma `PUSH_NOTIFICATION` (migración de expansión: el código de `main` tiene que seguir funcionando)." "El job lleva `conversationId`, el motivo (`inbound` | `handoff`) y el `messageId` si corresponde; los destinatarios se calculan al procesarlo, con el estado de ese momento."
  - A3 (queue): push jobs share `processing_job` but run outside the per-conversation order: they neither wait for nor block the conversation's bot jobs (a retrying push must not delay bot replies). `message_id` becomes nullable and is unique only for `INBOUND_MESSAGE` (the inbound push shares its message). The single-PROCESSING-per-conversation index applies only to `INBOUND_MESSAGE`.
  - A4: during the deploy, the previous release's worker may claim a push job and fail it (no message to answer); the job is retried and the new release sends it. The handoff job has `messageId` null.
- **S3 Routes (SessionGuard).** "`GET /inbox/push/public-key` → `{ publicKey }` (VAPID, base64url). `404` si el push no está configurado." "`POST /inbox/push/subscriptions` Body `{ endpoint, keys: { p256dh, auth } }` (Zod, `endpoint` https). Guarda o actualiza por `endpoint` para el usuario de la sesión. `201`." "`DELETE /inbox/push/subscriptions` Body `{ endpoint }`. Borra la del usuario de la sesión (`204`, también si no existía)."
- **S4 Sending.** "Con `web-push` (MIT)." Enqueued "en la misma transacción que registra el entrante (`ConversationsService.recordInbound`) y donde se aplica `onHandoff` (`context.service.ts`). Nada de Redis ni BullMQ." "Respuesta `404` o `410` del servicio de push → borrar esa suscripción. Otros errores → reintento con el backoff de la cola." "`TTL` de 1 hora, `urgency: high`, y `topic` = id de la conversación".
  - A5: `topic` is the conversation id without hyphens (Web Push allows at most 32 URL-safe base64 characters; a UUID has 36).
  - A6: a retry skips subscriptions that already got this job's push (`lastSuccessAt` ≥ the job's creation).
  - A7: jobs are enqueued only when push is configured; a job processed while it is not configured ends SKIPPED.
- **S5 Payload.** The JSON of the prompt (`notification` with title, body, icon `/icons/icon-192.png`, badge `/icons/maskable-192.png`, tag = conversationId, renotify true, `data.onActionClick.default` = `navigateLastFocusedOrOpen` to `/b/<businessId>/inbox/<conversationId>`). "`title`: nombre del contacto o `+<waId>`; en un handoff, `"<nombre> quiere hablar con una persona"`." "`body`: el texto del mensaje cortado a 100 caracteres (`[audio]` y similares como "Audio"). El contenido viaja cifrado de punta a punta (estándar Web Push), pero queda en la pantalla bloqueada del teléfono: documentalo."
  - A8: contact name = operator-set `name`, else `profileName`, else `+<waId>`. A handoff's body is the conversation's latest inbound message.
- **S6 Config.** "`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:...`) en `src/config/env.schema.ts`, `README.md` y `.env.example`. Las tres o ninguna: sin ninguna, el push queda apagado (rutas de suscripción `404`, el job termina `SKIPPED`); con algunas, la app no arranca. Documentá cómo generarlas (`npx web-push generate-vapid-keys`)." "Nunca loguear `endpoint`, `p256dh`, `auth` ni el contenido del mensaje en nivel `info`."
- **S7 Quality.** "Unitarios de la regla de destinatarios (cada caso de arriba) y del armado del payload." "e2e de las tres rutas (sin sesión `401`, validación `400`, alta, actualización por `endpoint`, borrado)." "int del job: encolado en la misma transacción del entrante, `410` borra la suscripción, un error transitorio reintenta."
- **S8 Optional.** "Sumar `windowClosesAt` (el cálculo de `windowClosesAt()` de `conversation-state.ts`) a cada conversación de la bandeja".
- **Out of scope.** "Preferencias por usuario (silenciar, horarios) y avisos por mensajes que atiende el bot."

## Tasks
| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S2 (queue part), A3, A4 | inline | done (RED→GREEN queue int + worker spec; lane mutation caught) | |
| T2 | S1-S7, A1, A2, A5-A8 | inline | pending | |
| T3 | S8 | inline | pending | |

Route evidence: one feature in one repo, units depend on each other (T2 needs T1's queue lane); no parallel writer reason. High-risk items: T1 concurrency and a migration on the queue (1, 4); T2 a new dependency and secrets (2, 5).

## Log
- L1 (2026-10-25, user): "Leé ~/projects/bottega-inbox/docs/prompts/05c-web-push.md y ejecutalo en este repo (rama feat/web-push, PR contra develop). Antes leé el CLAUDE.md de este repo y respetá sus reglas: migraciones de expansión, variables en env.schema.ts, README y .env.example, y tests unit, e2e e int."
- L2 (2026-10-25): the file is not in the inbox working tree (that session is on another branch); read from commit deabfdf (branches origin/develop, docs/web-push-prompt). Exploration: `processing_job.message_id` is NOT NULL and unique; the claim runs one job per conversation in `seq` order and a partial unique index allows one PROCESSING per conversation. A push job there would collide with the inbound job's message and, while retrying, hold the bot's replies back; hence A3/A4.
- L3 (2026-10-25): T1. Migrations 20261025190000_job_type_push_notification (enum value alone) and 20261025190100_push_jobs: push_reason enum and column, message_id nullable, CHECKs (inbound has a message, push has a reason), the message unique index and the one-PROCESSING index become partial on INBOUND_MESSAGE (hand-written, like the existing one). Claim: push jobs skip the per-conversation order and only INBOUND_MESSAGE jobs count as "older". ClaimedJob is a union (InboundJob for the bot, PushJob) with createdAt and pushReason. `enqueuePushJob` (shared insert) and the PushJobProcessor port; BotWorker takes it optionally and skips push jobs without it. Mutation: the old claim fails 3 lane tests.
- Next: T2.
