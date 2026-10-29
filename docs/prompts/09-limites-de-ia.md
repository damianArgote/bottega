# Prompt 09 · Límites de IA por negocio

> Correlo después del 08d. Son dos PRs: primero el backend (sesión sobre `bottega`) y después el aviso en la web (sesión sobre `bottega-inbox`). Objetivo: que cada negocio tenga un tope mensual de respuestas con IA y su propio tope diario por conversación, para que el costo de OpenAI de un cliente tenga un máximo conocido y no dependa de cuánta gente le escriba.

Contexto: hoy el único límite es `AI_MAX_INTERACTIONS_PER_USER_PER_DAY`, que es global y por **conversación** (`src/bot/ai-reply-generator.ts`, `AiUsageService.countToday`). Un negocio con muchas conversaciones no tiene techo: 200 números por día × 100 respuestas × 30 días son 600.000 respuestas por mes.

Regla de todo el prompt: **los límites solo los cambia el equipo** con la API de admin. Un dueño ve su consumo, pero nunca se sube el tope.

---

## Parte 1 · Backend (rama `feat/ai-limits`, repo `bottega`)

### Datos (solo expande)
- `business.ai_monthly_cap int null`: respuestas con IA por mes calendario para todo el negocio. `null` usa la variable nueva `AI_MAX_INTERACTIONS_PER_BUSINESS_PER_MONTH` (por defecto `5000`; se valida en `env.schema.ts` y se documenta en `README.md` y `.env.example`).
- `business.ai_daily_cap_per_conversation int null`: reemplaza por negocio a `AI_MAX_INTERACTIONS_PER_USER_PER_DAY`. `null` usa la variable, como hoy.
- Índice en `ai_usage(day)` para contar el mes sin recorrer la tabla. La cuenta se hace con un join `ai_usage → conversation → line → business`; no sumes `business_id` a `ai_usage`.

### Reglas
- Cuentan las llamadas `OK` y `ERROR`, igual que el tope diario. El mes es el calendario de `America/Argentina/Buenos_Aires` (reusá `USAGE_TIME_ZONE` y `usageDay`).
- Orden en `AiReplyGenerator`: agente apagado → tope mensual del negocio → tope diario de la conversación → modelo. Ninguno de los dos topes llama a OpenAI.
- Al llegar al tope **mensual**: no se corta la atención. Se registra una fila `LIMITED` en `ai_usage`, se responde un texto fijo y la conversación pasa a una persona con el mismo efecto que la herramienta `request_handoff` (motivo `ai_monthly_cap`), una sola vez por conversación mientras el tope siga alcanzado. Texto: "En un momento te responde una persona del equipo."
- El tope diario por conversación sigue respondiendo `AI_LIMIT_REPLY` como hoy; solo cambia de dónde sale el número.
- Log en nivel `info` cuando un negocio pasa el 80% y el 100% del tope del mes (una vez por mes cada uno): id del negocio, uso y tope. Nunca contenido de mensajes.

### Rutas
- `GET /admin/businesses/:id/limits` y `PUT /admin/businesses/:id/limits` con `{ "aiMonthlyCap": number|null, "aiDailyCapPerConversation": number|null }` (enteros de 1 a 1.000.000; `null` vuelve al valor por defecto). 404 si el negocio no existe.
- `GET /admin/businesses/:id/usage` y `GET /inbox/businesses/:businessId/settings/usage` (cualquier rol del negocio, `BusinessAccessGuard`): `{ "month": "2026-11", "used": 1234, "cap": 5000, "percent": 25, "capReached": false }`. El dueño la ve; no hay ninguna ruta de `/inbox` ni de `/staff` que cambie los topes.

### Pruebas
- Unit: cálculo del mes en hora de Argentina (el 1/11 a las 00:30 de Argentina ya es noviembre, aunque en UTC sea 03:30 del 1/11; el 31/10 a las 22:00 de Argentina sigue siendo octubre).
- Int:
  - Con el tope mensual alcanzado no se llama al modelo, se guarda `LIMITED`, se manda el texto fijo y se abre un pedido de humano; el segundo mensaje no abre otro.
  - El consumo de un negocio no cuenta para otro.
  - `ai_daily_cap_per_conversation` del negocio pisa a la variable; `null` usa la variable.
  - El cambio de mes reinicia la cuenta.
  - `PUT /admin/businesses/:id/limits` exige la `ADMIN_API_KEY`; un `OWNER` no tiene ninguna ruta para cambiarlos; `GET .../settings/usage` da 403 a un usuario de otro negocio.
- Lint, unit, e2e e int en verde. Toca una migración y el costo de todos los negocios: lleva verificador independiente antes del PR.

## Parte 2 · Web (rama `feat/ai-usage`, repo `bottega-inbox`)
- En Configuración, una tarjeta **"Uso de IA del mes"**: "1.234 de 5.000 respuestas (25%)" con una barra.
- Aviso arriba de la bandeja, visible para todos los usuarios del negocio:
  - Desde el 80%: "Usaste el 80% de las respuestas con IA de este mes. Escribinos para ampliar tu plan."
  - Al 100%: "Llegaste al tope de respuestas con IA de este mes: las conversaciones nuevas las atiende una persona."
- Se consulta con el mismo polling de la bandeja, sin pedidos extra por cada conversación.
- Tests de los stores con la API mockeada: sin aviso por debajo del 80%; el texto correcto al 80% y al 100%.

## Fuera de alcance
Planes y cobros, topes en tokens o en dinero, límites del catálogo (van en el prompt 10), cambiar los topes desde la bandeja.
