# Staff onboarding API (prompt 08d, part 1)

Objective: a STAFF role lets the BotSuite46 team onboard clients from the inbox (business, draft line, credentials, number, app, owner) and see every line's status, without seeing other businesses' conversations, messages or leads.
Branch: feat/staff-onboarding (from develop), one PR to develop. Delivery: ask-on-risk. Test runner: vitest (`npm test`, `npm run test:e2e`, `npm run test:int`).

## Specs

Source: `docs/prompts/08d-alta-desde-la-bandeja.md`, part 1 (verbatim where quoted).

- S1. "Columna nueva `app_user.staff boolean not null default false` (solo expande)."
- S2. "Solo se da y se saca con la API de admin: `PUT /admin/users/:userId/staff` con `{ "staff": true|false }`. Nunca desde la bandeja."
- S3. "`StaffGuard`: después de `SessionGuard`, lee `staff` y `active` del usuario **en la base en cada pedido** (no en el token de la sesión), así que sacarle el rol corta el acceso al instante. Si no es staff: 403."
- S4. "`GET /auth/me` suma `staff: boolean`. Solo agrega un campo: el resto de la respuesta no cambia." Implementation: top-level `staff` next to `user` and `businesses` (L2).
- S5. `/staff/...` routes (SessionGuard + StaffGuard) reusing BusinessesService, LineOnboardingService, UsersService with the admin Zod schemas: `GET /staff/lines/status`, `POST /staff/businesses`, `POST /staff/businesses/:businessId/lines` (drafts only), `PUT /staff/lines/:lineId/credentials`, `GET /staff/lines/:lineId/phone-numbers`, `POST /staff/lines/:lineId/register`, `POST /staff/lines/:lineId/subscribe`, `POST /staff/lines/:lineId/app-published`, `POST /staff/businesses/:businessId/owners` (`email`, `name`; temporary password shown once, `mustChangePassword`).
- S6. "Protección contra CSRF igual que el resto de las mutaciones de `/inbox`." (SameSite=lax cookies + exact-origin CORS; nothing new.)
- S7. "Log de auditoría en nivel `info` por cada acción: id del usuario, acción e id del negocio o la línea. Nunca secretos, PIN ni bodies."
- S8. CLAUDE.md rule: "Un usuario nunca ve conversaciones, mensajes ni leads de otro negocio. El equipo (`STAFF`) solo da de alta negocios y líneas y ve su estado."
- S9. Tests (int): non-staff OWNER/AGENT 403 on every `/staff` route; removing staff cuts access on the next request; staff without membership in B still 403 on B's conversations, leads, settings/agent; no token, App Secret, PIN or verify token in responses except the draft's `verifyToken`; `PUT /admin/users/:userId/staff` requires the admin key; `/auth/me` returns everything as before plus `staff`.

## Tasks

- T1 S1-S4, S8: migration, admin route, StaffGuard, `/auth/me` staff, CLAUDE.md. Route: inline. Risk: item 2 (permissions). Status: done (int RED observed: 4 failing before the change).
- T2 S5-S7, S9: `/staff` controller with audit logs and tests. Route: inline. Risk: item 2. Status: done (routes were new; int green locally).

Route evidence: two dependent units sharing the guard and services; no Writer trigger, so inline. Independent verifier at the end (item 2).

## Log

- L1 (2026-10-29) user: "si y empeza tu parte" (to: save prompt 08d and start the backend).
- L2 (2026-10-29) decisions: StaffGuard reads `staff` with its own query instead of adding it to SessionUser, so login/refresh/me `user` objects keep their shape; `/auth/me` adds a top-level `staff`.
