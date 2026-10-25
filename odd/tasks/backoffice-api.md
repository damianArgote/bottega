# Feature: backoffice-api (prompt 05b, part 1)
Objective: the business owner changes and tests the agent, sees the leads and adds the team without the admin API. Source: `docs/prompts/05b-backoffice.md` (part 1, backend). Part 2 (web) runs in `bottega-inbox`.
Branches `feat/backoffice-api-<n>-*`, one PR per task against `develop`; one release after T4. Schema changes expand-only. Test runner: vitest; the prompt's "e2e" checks need the database, so they run as HTTP tests in the int suite (as in 03 and 04).

## Specs
Quoted verbatim from the prompt (Spanish). Assumptions are marked.

- **S1 Routes and role.** "Todas las rutas bajo `/inbox/businesses/:businessId/settings/...` con `SessionGuard` + `BusinessAccessGuard`, y un guard nuevo `RoleGuard('OWNER')`: un `AGENT` recibe 403."
  - Assumption A5: the leads routes in S6 are `/inbox/businesses/:businessId/leads...` (as written), also OWNER only.
- **S2 Agent.** "`GET /settings/agent` y `PUT /settings/agent`: reusan el servicio y el schema Zod del prompt 02b (mismos límites). Cada `PUT` sube `version` y guarda quién lo cambió (`updatedById`)." and "Los campos `model` y `demoEnabled` **no** se editan desde acá: siguen siendo solo de la API de admin."
  - Assumption A3: the settings PUT body is the 02b schema without `model` and `demoEnabled` (strict: sending them is 400); the stored values are kept.
- **S3 Versions.** "`GET /settings/agent/versions`: las últimas 20 versiones con fecha, autor y un diff de texto por campo. Guardá cada versión en una tabla `AgentProfileVersion` (snapshot jsonb) para poder volver atrás." and "`POST /settings/agent/versions/:version/restore`: restaura un snapshot como versión nueva."
  - Assumption A1: every write of the profile (settings PUT, restore, admin PUT, seed) stores its snapshot; the migration stores the current profile as its current version (author unknown).
  - Assumption A2: the diff lists, per changed field against the previous version, its text before and after (JSON text for lists).
- **S4 Preview.** "`POST /settings/agent/preview`: el mismo preview del 02b (no envía nada por WhatsApp), con un límite de 20 por hora por negocio para no gastar OpenAI de más."
  - Assumption A4: in memory, behind an interface (like the login limit); the 21st in an hour answers 429.
- **S5 Leads.** "`GET /leads?from=&to=&q=&cursor=`: paginado por `(createdAt, id)` descendente, 50 por página, con el contacto y la conversación." and "`GET /leads/export.csv?from=&to=`: CSV con las columnas de `leadFields` del negocio más fecha, nombre de perfil y teléfono. Escapá comillas y celdas que empiezan con `=`, `+`, `-` o `@` (inyección de fórmulas en Excel)."
  - Assumption A7: `from`/`to` are dates (YYYY-MM-DD, `to` inclusive) in the business timezone; `q` matches the contact's name or number or any lead value.
- **S6 Users.** "`GET /settings/users`, `POST /settings/users` (`email`, `name`, `role`): crea el usuario con una contraseña temporal aleatoria que se muestra **una sola vez** en la respuesta, y lo marca `mustChangePassword`." and "`PATCH /settings/users/:userId` (`role`, `active`). Un negocio nunca se queda sin al menos un `OWNER` activo (409)."
  - Assumption A6: `active` is per business (new `Membership.active`, checked by BusinessAccessGuard), so deactivating someone in one business does not lock them out of another; an existing email only gets the membership (no temporary password).
- **S7 Change password.** "`POST /auth/change-password` para cualquier usuario logueado; si `mustChangePassword`, la web lo obliga antes de entrar a la bandeja."
  - Assumption A8: body `{ currentPassword, newPassword }` (new ≥ 10 characters, different); it clears `mustChangePassword`, revokes every refresh token of the user and sets new session cookies; `/auth/me` and the login response carry `mustChangePassword`.
- **S8 Acceptance.** "e2e: `AGENT` recibe 403 en todo `/settings`; un `OWNER` del negocio A no ve leads del B; `PUT` inválido da 400 con los errores de Zod; restaurar una versión crea una nueva; el CSV neutraliza `=SUM(A1)`; no se puede desactivar al último `OWNER`." and "Lint, unit, e2e e int en verde."
- **Out of scope.** "Editar el modelo de IA, facturación, métricas y reportes (van cuando haya clientes), recuperar contraseña por email."

## Tasks
| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1 (RoleGuard), S7, A8 | inline | done (RED→GREEN role guard spec + auth HTTP int) | |
| T2 | S2, S3, S4, A1-A4 | inline | pending | |
| T3 | S5, A5, A7 | inline | pending | |
| T4 | S6, A6, S8 | inline | pending | |

Route evidence: the tasks share the guards and the settings module, one after the other; no parallel writer reason. High-risk items: T1 credentials and sessions (2); T2 migration with a backfill (1); T3 data export (2: another business's data, formula injection); T4 permissions and the access guard (2).

## Log
- L1 (2026-10-25, user): "si" to "¿Arranco la Parte 1 acá?" (prompt 05b, part 1).
- L2 (2026-10-25): context. The 05 web is live at https://bottega-inbox.onrender.com, proxying `/auth/*` and `/inbox/*` to the API (same origin, until the botsuite46.com subdomains exist). Partners Emmanuel and Tomas exist as OWNER (created through the admin API); there is no way to change a password yet, which S7 solves.
- L3 (2026-10-25): T1. `RoleGuard(role)` (Nest mixin, after BusinessAccessGuard, 403 for another role). Migration 20261025160000_user_must_change_password (expand). `mustChangePassword` in the session user (login, refresh, me) and in the admin user view. POST /auth/change-password (SessionGuard): 401 for a wrong current password, 400 for a short or unchanged new one; saves the argon2id hash, clears the flag, revokes every refresh token of the user and sets new cookies. The flag is enforced by the web (S7), not by the API.
- Next: T2.
