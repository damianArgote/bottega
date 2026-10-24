# bottega-api

NestJS 12 + Prisma 7 + PostgreSQL + WhatsApp Cloud API de Meta + OpenAI (Responses API).

## Qué es y hacia dónde va
- Hoy: bot comercial propio de BotSuite46 sobre un solo número. Ya resuelve webhook firmado (`src/whatsapp/signature.guard.ts`), idempotencia por `wamid` (`Message.waMessageId @unique`), cola en Postgres con `FOR UPDATE SKIP LOCKED` (`src/queue/queue.service.ts`), IA con herramientas validadas (`src/bot/tools`), pausa "humano" y respuesta humana por la API de admin (`src/admin`).
- Objetivo de la primera etapa: (1) desplegarlo fuera de ngrok con la base en Neon, (2) que soporte varios negocios y números, cada uno con su propia app de Meta y credenciales cifradas, (3) que el agente de cada negocio se configure desde la base, (4) sumar una bandeja web donde una persona ve las conversaciones, responde y toma o devuelve el control al bot, y (5) un backoffice chico para editar el agente y ver los leads. El único negocio cargado al principio es BotSuite46; el bot se presenta como "BotSuite, IA de BotSuite46", nunca como "asistente virtual".
- Orden de los prompts: 00, 01, 02, 02b, 03, 04, 05 (repo `bottega-inbox`), 05b. Después: 07 (turnos con seña y eventos), 06.
- El bot es **un participante más de la bandeja**: mismo número, mismas conversaciones, misma tabla de mensajes (`Message.author`: `BOT` | `HUMAN` | `USER`). Nada de un sistema paralelo.

## Decisiones que no se discuten en cada tarea
- Canal: **Meta Cloud API directo** con `fetch` (`src/whatsapp/graph-whatsapp.client.ts`). No usar Twilio, ni SDKs de WhatsApp de terceros, ni librerías por QR.
- IA: el cliente de OpenAI que ya existe (`src/ai/openai.provider.ts`). **No** sumar LangChain ni LangGraph en el MVP.
- Cola y jobs: la cola en Postgres que ya existe. **No** sumar Redis ni BullMQ. n8n nunca corre dentro del backend: más adelante (prompt 07) se integra solo por eventos firmados y una API de lectura.
- Tiempo real de la bandeja: polling con cursor del servidor. WebSockets/SSE quedan para después.
- Base: PostgreSQL en Neon. Migraciones siempre con `prisma migrate` (`prisma/migrations`); nunca `db push` ni `synchronize`.
- Configuración: toda variable nueva se valida en `src/config/env.schema.ts` y se documenta en `README.md` y `.env.example`. Si falta un secreto obligatorio, la app no arranca. Nunca hay valores por defecto para secretos.
- Arquitectura: monolito modular. Cada módulo expone servicios; los controladores solo validan (Zod) y delegan. Lógica de dominio sin dependencias de Nest cuando se pueda testear pura.
- Todo dato de negocio lleva `businessId` y toda consulta de la bandeja filtra por el negocio del usuario. Un usuario nunca ve datos de otro negocio.

## Cómo trabajar
- Una tarea = una rama = un PR chico. Commits en inglés, convencionales (`feat:`, `fix:`, `chore:`).
- Antes de terminar: `npm run lint`, `npm test`, `npm run test:e2e` y, si tocaste SQL o la cola, `npm run test:int` (necesita Postgres: `npm run db:up` y `DATABASE_URL` apuntando a esa base). Si algo falla, decilo; no desactives ni saltees tests.
- Cada regla nueva lleva su test (unitario si es pura, e2e si es HTTP, int si depende de Postgres).
- Comentarios y logs en inglés; textos al usuario final en español rioplatense.
- Nunca loguear tokens, el body completo de webhooks con datos personales, ni el contenido de mensajes en nivel `info`.
- El número y la WABA de producción que usa BotPenguin **no se tocan**. Para desarrollo se usa el número de prueba de una app de Meta aparte.

## Deuda conocida
Lo que el código actual contradice o complica del plan, y qué prompt lo resuelve. Al cerrar un punto, sacalo de esta lista en el mismo PR.

1. **Identidad del bot** → 02. `src/bot/prompts.ts` presenta al bot como "Bottega, el asistente virtual" (modo comercial) y la demo como "el asistente virtual de…"; `prompts.spec.ts` lo comprueba. Sacar "asistente virtual" del prompt y de la demo, y que el spec compruebe que no aparece.
2. **Schema de un solo negocio** → 02. No hay `businessId` en ninguna tabla y `Conversation.waId` es `@unique` global. Pasa a `Business`, `Line`, `Contact` y `Conversation` única por `(lineId, contactId)`, con script de migración de los datos existentes.
3. **Credenciales de Meta en el env** → 02. `META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_VERIFY_TOKEN` son variables obligatorias; `WhatsAppModule` crea un único `GraphWhatsAppClient` y el guard firma con un solo secreto. Pasa a credenciales cifradas por línea (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`), webhook `/webhooks/whatsapp/:webhookKey` que resuelve la línea antes de validar la firma, y cliente por línea.
4. **El parser filtra un solo número** → 02. `parseWebhookPayload` recibe un único `phoneNumberId` del config.
5. **Agente fijo en código y archivos** → 02b. `MODE_PROFILES` (`src/bot/mode-profiles.ts`) está hardcodeado con `COMMERCIAL`/`DEMO` y la barbería; `ContentService` lee `content/*.md` una vez al arrancar. Pasa a `AgentProfile` en la base.
6. **Admin sin usuarios** → 03 (usuarios, login, `BusinessAccessGuard`) y 04 (tomar y devolver, integrando la pausa actual). Hoy hay una sola `ADMIN_API_KEY`.
7. **Sin cursor seguro para el polling** → 04. `Message` solo se ordena por `createdAt` (resolución de ms). El cursor va sobre `Conversation`, con `pg_current_xact_id()` por trigger y `pg_snapshot_xmin` como cursor; los mensajes se paginan por `id`.
8. **Neon** → 01. `prisma.config.ts` solo lee `DATABASE_URL` y `prisma migrate` necesita la URL directa (sin pooler). El worker consulta cada `QUEUE_POLL_INTERVAL_MS` (1 s) y no deja suspender a Neon.
9. **Alcance del README** → 01. Dice "no hay frontend, editor de flujos, multi-cliente ni facturación", lo contrario del objetivo.
10. **Número de prueba baneado** → tarea manual antes del 01. La WABA de prueba quedó BANNED (11/10/2026). Confirmar un número de prueba sano en una app de Meta aparte antes de probar el deploy.
