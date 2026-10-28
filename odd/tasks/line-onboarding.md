# Line onboarding API (prompt 08a)

Objective: onboard a client's WhatsApp line from the API (draft → credentials → register → subscribe → published), so the browser "Consola de alta" and its token-in-the-browser are no longer needed.
Branch: feat/line-onboarding (from develop), PR to develop. Delivery: ask-on-risk (ask the chain strategy before opening the PR). Test runner: vitest (`npm test`, `npm run test:e2e`, `npm run test:int`).

## Specs

Source: `docs/prompts/08-alta-de-clientes.md`, section 08a (PR #62), quoted verbatim where marked.

- S1. Draft line: "Hoy `POST /admin/businesses/:id/lines` exige `phoneNumberId` y el token de entrada, pero la guía carga el webhook **antes** de que exista el número." `POST /admin/businesses/:id/lines` with an empty body creates a draft and returns `webhookUrl` and `verifyToken`. "El body completo de hoy sigue funcionando igual (mismo resultado, mismo `subscribeApp`)." `phoneNumberId` becomes nullable (expand only).
- S2. "Un borrador sin App Secret responde el `GET` de verificación, pero **todo `POST` al webhook da 403** (no hay con qué validar la firma). Un borrador nunca rutea entrantes ni manda mensajes." Implementation note (L2): the existing guard already rejects a line without App Secret with 401; that status is kept.
- S3. Credentials: "`PUT /admin/lines/:lineId/credentials` (`wabaId`, `appId`, `appSecret`, `accessToken`): antes de guardar, validá contra Meta que el token ve ese WABA (`GET /{WABA_ID}?fields=id,name`). Si falla, 400 con el error explicado y no se guarda nada." Reusable for camino B: `PUT /inbox/businesses/:businessId/settings/whatsapp/lines/:lineId/credentials` (`OWNER`, same validation).
- S4. Meta actions with the stored token: `GET /admin/lines/:lineId/phone-numbers`; `POST /admin/lines/:lineId/register` (`phoneNumberId`, `pin` of 6 digits) "comprueba que el número es del WABA de la línea", registers, stores `phoneNumberId` and `displayPhone`; "El PIN **no se guarda** ni se loguea."; `POST /admin/lines/:lineId/subscribe` subscribes then reads `subscribed_apps` and "avisa si hay otra además de la nuestra".
- S5. Published app: "`POST /admin/lines/:lineId/app-published` guarda `appPublishedAt` (columna nullable nueva)."
- S6. Meta onboarding errors in Spanish (190, 200/10, 100, 133005 or subcode 2388023, 133006, 133016) added to `src/whatsapp/meta-errors.ts`; existing send error kinds unchanged.
- S7. Status: `GET /admin/lines/:lineId/status` and `GET /inbox/businesses/:businessId/settings/whatsapp` (`OWNER`): step, number, display name and `name_status`, `code_verification_status`, `quality_rating`, app subscribed, `appPublishedAt`, last `WebhookEvent`. "Sin tokens, sin secretos, sin `verifyToken` en la ruta de la bandeja." Meta lookups cached 60 s per line.
- S8. Tests (from the prompt): draft returns URL and verify token; POST to a draft webhook is rejected; credentials rejected by Meta give 400 and are not stored; register with a number of another WABA gives 400; a 5-digit PIN gives 400; no response includes the token, App Secret or PIN; while `appPublishedAt` is null the status shows the pending step; OWNER of A does not see B; AGENT gets 403; the full-body create still returns what it did.

## Tasks

- T1 S1, S2: migration (nullable phone_number_id, app_published_at), draft create, null-safe routing/sending, inbox `/lines` hides drafts. Route: inline. Status: done (e2e RED observed on the old controller; int runs in CI, no local Postgres).
- T2 S3, S6: Graph onboarding client, Meta error texts, credentials endpoints (admin + inbox). Route: inline. Status: done (unit RED observed for the error texts; routes were new, int green locally on embedded Postgres).
- T3 S4, S5: phone-numbers, register, subscribe, app-published. Route: inline. Status: done (routes were new; int green locally on embedded Postgres).
- T4 S7: status endpoints with 60 s cache. Route: inline. Status: pending.

Route evidence: one behavior chain sharing the same service and files; no Writer trigger (no parallel independent units), so inline.

## Log

- L1 (2026-10-28) user: "arrancá con el 08a"
- L2 (2026-10-28) implementation decisions: the step is derived (draft = no token, credentials = token without number, registered = number) instead of an `onboardingStatus` column; "live" is derived from the last WebhookEvent, so no write on the webhook hot path. A draft POST keeps the guard's existing 401. The App Secret is also validated (`GET /{appId}` with the app token) because a wrong secret makes every webhook 401 silently.
