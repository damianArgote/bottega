# Feature: operators-auth (prompt 03)
Objective: people of each business log in to the inbox with their own user and only see their business. Source: `docs/prompts/03-operadores-login.md`.
Branches `feat/operators-auth-<n>-*`, one PR per task against `develop` (no stacking); released to `main` after T3, with `JWT_SECRET` and `INBOX_ORIGIN` set in Render first. Test runner: vitest (unit, e2e with mocks, int with Postgres; HTTP tests that need the database run in the int suite).

## Specs
Quoted verbatim from the prompt (Spanish). Assumptions are marked.

- **S1 Model.** "`User`: `id`, `email` único (guardado en minúsculas), `passwordHash`, `name`, `active`, timestamps." and "`Membership`: `userId`, `businessId`, `role` (`OWNER` | `AGENT`), `@@unique([userId, businessId])`."
- **S2 Hash.** "Hash con `argon2` (argon2id)."
- **S3 Login and tokens.** "`POST /auth/login` → setea una cookie `httpOnly`, `Secure`, `SameSite=Lax` con un JWT corto (15 min) y otra con un refresh (14 días) guardado como hash en una tabla `RefreshToken` (para poder revocarlo). `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` (usuario + negocios + rol)."
  - Assumption A4: cookies `bottega_session` (JWT, path `/`) and `bottega_refresh` (path `/auth`); JWT HS256 with `sub` = user id.
  - Assumption A6: an inactive user cannot log in or refresh; a user without memberships can log in and `me` lists no businesses.
  - Assumption A7: refresh rotates (the old token is revoked, a new one is issued); a revoked or expired refresh token answers 401.
- **S4 Secret.** "`JWT_SECRET` obligatorio, mínimo 32 caracteres, validado al arrancar. Sin valores por defecto."
- **S5 Rate limit.** "Límite de intentos de login: 5 por minuto por IP y por email (en memoria está bien para el MVP; dejalo detrás de una interfaz para cambiarlo después)."
  - Assumption A5: every attempt counts; the sixth within the minute answers 429 without checking the password.
- **S6 CORS.** "CORS: solo el origen de `INBOX_ORIGIN` (variable nueva), con `credentials: true`."
- **S7 Guards.** "Guard `SessionGuard` + decorador `@CurrentUser()`. Guard `BusinessAccessGuard` que lee `:businessId` de la ruta y exige membresía activa. Todas las rutas de la bandeja van bajo `/inbox/businesses/:businessId/...`."
  - Assumption A3: a first inbox route, `GET /inbox/businesses/:businessId` (the business and the user's role), so access can be tested; prompt 04 adds the rest.
- **S8 Users.** "Alta de usuarios: `POST /admin/businesses/:id/users` con la API key de admin (sin registro público)."
  - Assumption A1: body `{ email, name, password, role }`; an existing email gets the membership added (its password and name are not changed); an existing membership answers 409.
- **S9 Out of scope.** "Recuperar contraseña por email, 2FA, SSO. Anotalos como pendientes en el README."
- **S10 Acceptance.** "e2e: login correcto e incorrecto, cookie con los flags correctos, refresh rota el token y el viejo deja de servir, logout revoca, un usuario del negocio A recibe 403 en una ruta del negocio B." and "Lint, unit, e2e e int en verde."
  - Assumption A2: these HTTP tests need the database (refresh tokens, memberships), so they run in the int suite with supertest against the Nest app.
- **Dependencies (decision D1).** `argon2` (required by S2), `jose` (JWT, no dependencies of its own) and `cookie-parser` (reads the cookies in Express).

## Tasks
| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S2, S8, A1 | inline | done (RED→GREEN password-hasher spec, users int spec, admin e2e) | PR #36 |
| T2 | S3, S4, S5, S6, S7 (SessionGuard, @CurrentUser), A4-A7 | inline | done (RED→GREEN env, rate limiter, tokens specs + auth HTTP int spec) | |
| T3 | S7 (BusinessAccessGuard, inbox route), S9, S10, A2, A3 | inline | pending | |

Route evidence: each task builds on the previous one (users → sessions → business access), so there is no parallel writer reason. High-risk items: T1 new tables (1) and dependency (5); T2 credentials and session (2), new required env var (5: the app does not start without it); T3 access guard (2).

## Log
- L1 (2026-10-25, user): "pr 35 aprobado, arrancá el 03". The authoritative request text is `docs/prompts/03-operadores-login.md`.
- L2 (2026-10-25): existing code has no auth library; the admin API uses one `ADMIN_API_KEY` guard; HTTP tests against Postgres already exist in the int suite (`test/int/admin-businesses.int-spec.ts`). CLAUDE.md "Deuda conocida" item 1 ("Admin sin usuarios → 03 y 04") is closed partly by this prompt (users, login, BusinessAccessGuard) and partly by 04 (take and return).
- L3 (2026-10-25): T1. Migration 20261025100000_users_memberships (new tables `app_user`, `membership`, enum `membership_role`; "user" is reserved in Postgres). PasswordHasher (argon2id, verify never throws). UsersService.addToBusiness and `POST /admin/businesses/:id/users` per A1 (email trimmed and lowercased, password ≥ 10 characters, never returned; 404 unknown business, 409 existing membership). Dependency added: argon2 0.45. Verification plan: one independent verifier at the end of the feature, over T1-T3, before the release (items 2 and 5).
- L4 (2026-10-25, user): asked which values to use for JWT_SECRET and INBOX_ORIGIN; answered: `openssl rand -base64 48` per environment (never pasted in chat), and the inbox origin (`http://localhost:4200` locally; the published inbox URL in Render).
- L5 (2026-10-25): T2. Env: JWT_SECRET (required, ≥ 32) and INBOX_ORIGIN (required, an origin without path); also in render.yaml (sync: false), .env.example, README and the test configs. Migration 20261025110000_refresh_tokens (`refresh_token`: sha256 hash unique, expires_at, revoked_at). `configureHttp` (main.ts and HTTP tests): cookie-parser, CORS with exact INBOX_ORIGIN match and credentials (other origins get no CORS headers), trust proxy 1 so `req.ip` is the client behind Render. AuthService: login (limiter first, same 401 message for unknown email, wrong password and inactive user, a dummy argon2 verify for unknown emails), refresh (single-use rotation via conditional update), logout, me. SessionGuard + @CurrentUser. Dependencies added: jose 6, cookie-parser 1.4 (+ @types).
- Next: T3.
