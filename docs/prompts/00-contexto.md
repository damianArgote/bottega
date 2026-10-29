# Prompt 00 · Contexto (pegar primero, en una sesión nueva de Claude Code sobre el repo `bottega`)

> Pegalo como primer mensaje. Le pide a Claude Code que lo guarde como `CLAUDE.md` para que todas las sesiones siguientes lo lean solas.

---

Vas a trabajar en `bottega-api` (NestJS 12 + Prisma 7 + PostgreSQL + WhatsApp Cloud API de Meta + OpenAI). Antes de tocar código, leé `README.md`, `prisma/schema.prisma`, `src/whatsapp`, `src/queue`, `src/bot` y `src/admin`, y después creá un `CLAUDE.md` en la raíz con este contenido (adaptá rutas si algo no coincide con lo que ves en el repo):

## Qué es y hacia dónde va
- Hoy: bot comercial propio de BotSuite46 sobre un solo número. Ya resuelve webhook firmado, idempotencia por `wamid`, cola en Postgres con `FOR UPDATE SKIP LOCKED`, IA con herramientas validadas, pausa "humano" y respuesta humana por la API de admin.
- Objetivo de la primera etapa: (1) desplegarlo fuera de ngrok con la base en Neon, (2) que soporte varios negocios y números, cada uno con su propia app de Meta y credenciales cifradas, (3) que el agente de cada negocio se configure desde la base, (4) sumar una bandeja web donde una persona ve las conversaciones, responde y toma o devuelve el control al bot, y (5) un backoffice chico para editar el agente y ver los leads. El único negocio cargado al principio es BotSuite46; el bot se presenta como "BotSuite, IA de BotSuite46", nunca como "asistente virtual".
- Orden de los prompts: 00, 01, 02, 02b, 03, 04, 05 (repo `bottega-inbox`), 05b. Después: 08 (alta de clientes; va antes porque hay clientes esperando), 08d (alta desde la bandeja), 09 (límites de IA por negocio), 10 (catálogo por negocio), 07 (turnos con seña y eventos), 06.
- El bot es **un participante más de la bandeja**: mismo número, mismas conversaciones, misma tabla de mensajes. Nada de un sistema paralelo.

## Decisiones que no se discuten en cada tarea
- Canal: **Meta Cloud API directo** con `fetch`. No usar Twilio, ni SDKs de WhatsApp de terceros, ni librerías por QR.
- IA: el cliente de OpenAI que ya existe. **No** sumar LangChain ni LangGraph en el MVP.
- Cola y jobs: la cola en Postgres que ya existe. **No** sumar Redis ni BullMQ. n8n nunca corre dentro del backend: más adelante (prompt 07) se integra solo por eventos firmados y una API de lectura.
- Tiempo real de la bandeja: polling con cursor del servidor. WebSockets/SSE quedan para después.
- Base: PostgreSQL en Neon. Migraciones siempre con `prisma migrate`; nunca `db push` ni `synchronize`.
- Configuración: todo variable nueva se valida en `src/config/env.schema.ts` y se documenta en `README.md` y `.env.example`. Si falta un secreto obligatorio, la app no arranca. Nunca hay valores por defecto para secretos.
- Arquitectura: monolito modular. Cada módulo expone servicios; los controladores solo validan (Zod) y delegan. Lógica de dominio sin dependencias de Nest cuando se pueda testear pura.
- Todo dato de negocio lleva `businessId` y toda consulta de la bandeja filtra por el negocio del usuario. Un usuario nunca ve datos de otro negocio.

## Cómo trabajar
- Una tarea = una rama = un PR chico. Commits en inglés, convencionales (`feat:`, `fix:`, `chore:`).
- Antes de terminar: `npm run lint`, `npm test`, `npm run test:e2e` y, si tocaste SQL o la cola, `npm run test:int`. Si algo falla, decilo; no desactives ni saltees tests.
- Cada regla nueva lleva su test (unitario si es pura, e2e si es HTTP, int si depende de Postgres).
- Comentarios y logs en inglés; textos al usuario final en español rioplatense.
- Nunca loguear tokens, el body completo de webhooks con datos personales, ni el contenido de mensajes en nivel `info`.
- El número y la WABA de producción que usa BotPenguin **no se tocan**. Para desarrollo se usa el número de prueba de una app de Meta aparte.

---

Cuando termines el `CLAUDE.md`, mostrámelo y listá en 5–10 líneas lo que viste en el código que contradice o complica este plan. No escribas código todavía.
