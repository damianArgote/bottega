# Prompt 03 · Operadores y login

> Objetivo: que las personas de cada negocio entren a la bandeja con su usuario y vean solo lo suyo.

---

Tarea: agregar usuarios, pertenencia a negocios y login. Rama `feat/operators-auth`.

## Modelo
- `User`: `id`, `email` único (guardado en minúsculas), `passwordHash`, `name`, `active`, timestamps.
- `Membership`: `userId`, `businessId`, `role` (`OWNER` | `AGENT`), `@@unique([userId, businessId])`.

## Auth
- Hash con `argon2` (argon2id).
- `POST /auth/login` → setea una cookie `httpOnly`, `Secure`, `SameSite=Lax` con un JWT corto (15 min) y otra con un refresh (14 días) guardado como hash en una tabla `RefreshToken` (para poder revocarlo). `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` (usuario + negocios + rol).
- `JWT_SECRET` obligatorio, mínimo 32 caracteres, validado al arrancar. Sin valores por defecto.
- Límite de intentos de login: 5 por minuto por IP y por email (en memoria está bien para el MVP; dejalo detrás de una interfaz para cambiarlo después).
- CORS: solo el origen de `INBOX_ORIGIN` (variable nueva), con `credentials: true`.
- Guard `SessionGuard` + decorador `@CurrentUser()`. Guard `BusinessAccessGuard` que lee `:businessId` de la ruta y exige membresía activa. Todas las rutas de la bandeja van bajo `/inbox/businesses/:businessId/...`.
- Alta de usuarios: `POST /admin/businesses/:id/users` con la API key de admin (sin registro público).

## Fuera de alcance
Recuperar contraseña por email, 2FA, SSO. Anotalos como pendientes en el README.

## Criterio de aceptación
- e2e: login correcto e incorrecto, cookie con los flags correctos, refresh rota el token y el viejo deja de servir, logout revoca, un usuario del negocio A recibe 403 en una ruta del negocio B.
- Lint, unit, e2e e int en verde.
