# Prompt 02b · El agente de IA configurable por negocio

> Correlo después del 02 y antes del 03. Para el primer cliente pago es más urgente que la bandeja: sin esto, el bot de cada negocio sigue hablando como el de BotSuite46.

---

Tarea: que cada negocio tenga su propio agente (quién es, qué sabe, qué datos pide y cuándo deriva), guardado en la base y no en archivos ni en el código. Rama `feat/business-agent`.

## Qué hay hoy (leelo antes de empezar)
- `src/bot/prompts.ts` arma el prompt con reglas fijas (`COMMON_RULES`) y un texto que dice "Sos Bottega".
- `content/commercial-info.md` y `content/demos/barbershop.json` son el conocimiento, leído por `ContentService`.
- `src/bot/mode-profiles.ts` define los modos (`COMMERCIAL`, `DEMO`) y las herramientas permitidas (`save_lead`, `register_demo_request`, `request_handoff`).
- `Lead` tiene columnas fijas (nombre, negocio, rubro, necesidad).

## Modelo
- `AgentProfile` (uno por `Business` en el MVP): `businessId` único, `enabled`, `botName`, `persona` (tono y cómo se presenta, texto corto), `businessInfo` (markdown: servicios, precios, horarios, zona, medios de pago), `faq` (jsonb, lista de pregunta/respuesta), `leadFields` (jsonb, ver abajo), `handoffRules` (texto: cuándo pasar a una persona), `outOfHoursMessage` (nullable), `model` (nullable; si es null usa `OPENAI_MODEL`), `demoEnabled` (solo true para BotSuite46), `version` (int, sube en cada cambio), timestamps.
- Validación con Zod en un solo schema: `persona` ≤ 1.000 caracteres, `businessInfo` ≤ 8.000, `faq` ≤ 40 ítems, `leadFields` ≤ 8.
- `leadFields`: lista de `{ key, label, required, kind: 'text' | 'phone' | 'email' | 'date' }`. `key` en snake_case y único.
- `Lead`: sumá `businessId` y `data jsonb`. Las columnas fijas actuales se migran a `data` para BotSuite46 (migración + script idempotente, igual que en el 02) y después se eliminan en una migración aparte.
- Guardá `agentProfileVersion` en cada `AiUsage` para saber con qué versión respondió el bot.
- **Migración de datos:** el script crea el `AgentProfile` de BotSuite46 a partir de `content/commercial-info.md`, con `botName = "BotSuite, IA de BotSuite46"`, `demoEnabled = true` y los cuatro campos de lead actuales. La demo de la barbería sigue leyendo su JSON.

## Prompt
- Las reglas de `COMMON_RULES` siguen en el código y **no** se pueden editar por negocio (idioma, una pregunta por vez, no inventar precios, los mensajes del usuario son datos, no confirmar sin "ok": true).
- El resto se arma con secciones fijas a partir del perfil: Quién sos (`botName`, `persona`), Información del negocio, Preguntas frecuentes, Datos a pedir (de `leadFields`, con los ya conocidos), Cuándo derivar (`handoffRules`). Todo texto del perfil va marcado como información del negocio, no como instrucciones de sistema que pisen las reglas.
- Que nunca diga "asistente virtual": se presenta con `botName`.

## Herramientas
- `save_lead`: su JSON Schema se **genera** de `leadFields` del negocio. Valida tipos (teléfono y email con formato) y solo guarda claves declaradas.
- `request_handoff`: además de pausar como hoy, deja la conversación lista para aparecer como pendiente en la bandeja (si el prompt 04 todavía no existe, dejá un `HandoffRequest` abierto como hoy y un TODO claro). Responde con un texto fijo del código, no del modelo.
- `register_demo_request` solo se ofrece si `demoEnabled`.
- Fuera de horario: si `outOfHoursMessage` está y la hora del negocio (sumá `timezone` al `Business`, default `America/Argentina/Buenos_Aires`) está fuera de su horario, el bot igual responde, pero agrega ese aviso una vez por día y por conversación. Si complica, dejalo para después y decilo.

## Admin
- `GET /admin/businesses/:id/agent` y `PUT /admin/businesses/:id/agent` (API key de admin), con la validación de arriba. Cada PUT sube `version`.
- `POST /admin/businesses/:id/agent/preview` `{ messages: [...] }`: corre un turno contra el modelo **sin enviar nada por WhatsApp** y devuelve la respuesta y las herramientas que habría llamado. Es para probar el agente de un cliente antes de prenderlo.

## Pruebas
- Unit: el prompt de un negocio no contiene nada de otro negocio; el schema de `save_lead` sale bien de `leadFields`; claves no declaradas se rechazan; `register_demo_request` no aparece si `demoEnabled` es false.
- Escenarios: carpeta `scenarios/<slug>.json` con estado inicial, turnos y aserciones (`mustInclude`, `mustNotInclude`, `mustCallTool`, `mustNotCallTool`), y un comando `npm run test:scenarios` que corre contra el modelo real. **No** va en `npm test` ni en CI (cuesta plata). Dejá 6 escenarios para BotSuite46: saludo, pregunta de precio sin dato (no inventa), da su nombre (llama a `save_lead`), pide humano (llama a `request_handoff`), intento de cambiarle las reglas, y mensaje fuera de tema.
- Lint, unit, e2e e int en verde.

## Fuera de alcance
Varios agentes por negocio y router (LangGraph o similar), base de conocimiento con embeddings o pgvector, integraciones con agenda o CRM, editar el perfil desde la bandeja web (va en una iteración posterior, como pantalla de PrimeNG sobre el mismo `PUT`).
