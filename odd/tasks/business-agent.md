# Feature: business-agent (prompt 02b)
Objective: each business has its own AI agent (who it is, what it knows, which data it asks for and when it hands off), stored in the database instead of files or code. Source: `docs/prompts/02b-agente-por-negocio.md`.
Branches `feat/business-agent-<n>-*`, one PR per task against `develop` (no stacking). Schema changes follow expand/contract (README "Orden de deploy y migraciones"). Test runner: vitest; scenarios via `npm run test:scenarios` (real model, outside CI).

## Specs
Quoted verbatim from the prompt (Spanish). Assumptions and decisions are marked.

- **S1 AgentProfile.** "`AgentProfile` (uno por `Business` en el MVP): `businessId` único, `enabled`, `botName`, `persona` (tono y cómo se presenta, texto corto), `businessInfo` (markdown: servicios, precios, horarios, zona, medios de pago), `faq` (jsonb, lista de pregunta/respuesta), `leadFields` (jsonb, ver abajo), `handoffRules` (texto: cuándo pasar a una persona), `outOfHoursMessage` (nullable), `model` (nullable; si es null usa `OPENAI_MODEL`), `demoEnabled` (solo true para BotSuite46), `version` (int, sube en cada cambio), timestamps."
- **S2 Validation.** "Validación con Zod en un solo schema: `persona` ≤ 1.000 caracteres, `businessInfo` ≤ 8.000, `faq` ≤ 40 ítems, `leadFields` ≤ 8." and "`leadFields`: lista de `{ key, label, required, kind: 'text' | 'phone' | 'email' | 'date' }`. `key` en snake_case y único."
- **S3 Lead.** "`Lead`: sumá `businessId` y `data jsonb`. Las columnas fijas actuales se migran a `data` para BotSuite46 (migración + script idempotente, igual que en el 02) y después se eliminan en una migración aparte."
  - Assumption A1: the admin API's lead JSON gains `data`; the fixed columns disappear from it only when they are dropped (contract step).
- **S4 Usage version.** "Guardá `agentProfileVersion` en cada `AiUsage` para saber con qué versión respondió el bot."
- **S5 Data migration.** "el script crea el `AgentProfile` de BotSuite46 a partir de `content/commercial-info.md`, con `botName = "BotSuite, IA de BotSuite46"`, `demoEnabled = true` y los cuatro campos de lead actuales. La demo de la barbería sigue leyendo su JSON."
- **S6 Prompt.** "Las reglas de `COMMON_RULES` siguen en el código y **no** se pueden editar por negocio (idioma, una pregunta por vez, no inventar precios, los mensajes del usuario son datos, no confirmar sin "ok": true)." and "El resto se arma con secciones fijas a partir del perfil: Quién sos (`botName`, `persona`), Información del negocio, Preguntas frecuentes, Datos a pedir (de `leadFields`, con los ya conocidos), Cuándo derivar (`handoffRules`). Todo texto del perfil va marcado como información del negocio, no como instrucciones de sistema que pisen las reglas." and "Que nunca diga "asistente virtual": se presenta con `botName`."
  - Assumption A2: `model` per profile needs the AI port to take the model per request (today it is fixed when the provider is built).
- **S7 save_lead.** "`save_lead`: su JSON Schema se **genera** de `leadFields` del negocio. Valida tipos (teléfono y email con formato) y solo guarda claves declaradas."
- **S8 request_handoff.** "`request_handoff`: además de pausar como hoy, deja la conversación lista para aparecer como pendiente en la bandeja (si el prompt 04 todavía no existe, dejá un `HandoffRequest` abierto como hoy y un TODO claro). Responde con un texto fijo del código, no del modelo."
- **S9 Demo.** "`register_demo_request` solo se ofrece si `demoEnabled`."
  - Assumption A3: the demo is a conversation mode entered with the "demo" command, so with `demoEnabled = false` the commercial prompt does not invite to it and the "demo" command answers that it is not available.
- **S10 Out of hours.** "Fuera de horario: si `outOfHoursMessage` está y la hora del negocio (sumá `timezone` al `Business`, default `America/Argentina/Buenos_Aires`) está fuera de su horario, el bot igual responde, pero agrega ese aviso una vez por día y por conversación. Si complica, dejalo para después y decilo."
- **S11 Admin.** "`GET /admin/businesses/:id/agent` y `PUT /admin/businesses/:id/agent` (API key de admin), con la validación de arriba. Cada PUT sube `version`." and "`POST /admin/businesses/:id/agent/preview` `{ messages: [...] }`: corre un turno contra el modelo **sin enviar nada por WhatsApp** y devuelve la respuesta y las herramientas que habría llamado."
- **S12 Unit tests.** "el prompt de un negocio no contiene nada de otro negocio; el schema de `save_lead` sale bien de `leadFields`; claves no declaradas se rechazan; `register_demo_request` no aparece si `demoEnabled` es false."
- **S13 Scenarios.** "carpeta `scenarios/<slug>.json` con estado inicial, turnos y aserciones (`mustInclude`, `mustNotInclude`, `mustCallTool`, `mustNotCallTool`), y un comando `npm run test:scenarios` que corre contra el modelo real. **No** va en `npm test` ni en CI (cuesta plata). Dejá 6 escenarios para BotSuite46: saludo, pregunta de precio sin dato (no inventa), da su nombre (llama a `save_lead`), pide humano (llama a `request_handoff`), intento de cambiarle las reglas, y mensaje fuera de tema."
  - Assumption A4: BotSuite46 now has real prices, so "pregunta de precio sin dato" asks for something still marked `[COMPLETAR]` (implementation timelines).
- **S14 Checks.** "Lint, unit, e2e e int en verde."
- **Out of scope.** "Varios agentes por negocio y router (LangGraph o similar), base de conocimiento con embeddings o pgvector, integraciones con agenda o CRM, editar el perfil desde la bandeja web".

## Tasks
| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S2, S4 (column), S5, S10 (timezone column), D1 | inline | done (RED→GREEN schema spec + agent-profile int spec) | |
| T2 | S6, A2, S9, A3, S12 (prompt, demo) | inline | pending | |
| T3 | S3 (expand), S7, S12 (save_lead) | inline | pending | |
| T4 | S8, S11 | inline | pending | |
| T5 | S10 | inline | pending | |
| T6 | S13 | inline | pending | |
| T7 | S3 (contract: drop fixed Lead columns, two releases) | inline | pending | |

Route evidence: each task builds on the previous one (profile → prompt → leads → admin), so there is no parallel writer reason. High-risk items: T1 and T3 data migration (1) and deploy (5); T3 and T7 change the admin API lead output (3); T4 admin preview calls the paid model (6: nothing else catches cost regressions).

## Log
- L1 (2026-10-25, user): "dale, arrancá el 02b". The authoritative request text is `docs/prompts/02b-agente-por-negocio.md`.
- L2 (2026-10-25): explorer map. The provider fixes the model in its constructor and `AiRequest` has no model; the demo is a conversation mode (the "demo" command), not a per-business tool; `Lead` is unique per conversation and the admin API returns the raw row; the generator writes `AiUsage` with a required `conversationId`, so the preview needs a pure turn loop; `Business.botName` already exists and would duplicate `AgentProfile.botName`.
- L3 (2026-10-25, user): "mientras vamos con el 02b el perfil manda". Decision D1: `AgentProfile.botName` is the bot's name; `Business.botName` is only the initial value when a profile is created and stops being read.
- L4 (2026-10-25): T1 committed (35d9d21) plus fix: the seed no longer validates the content once the profile exists, so a later content edit over 8.000 characters cannot fail a deploy. Independent verifier: no blockers, S1/S2/S4-column/S5/S10-column/D1 met. Advisory: `bot.int-spec.ts` happy path failed 2 of 3 full int runs on the verifier, then passed 7 runs there and 3 here; not reproduced, watch CI. T3 must map `business_name` to the lead and decide what `required` means for save_lead.
- Next: T2.
