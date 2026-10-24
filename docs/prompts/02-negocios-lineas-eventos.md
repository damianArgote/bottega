# Prompt 02 · Varios negocios y números, y eventos crudos de Meta

> Objetivo: que el mismo backend atienda varios números (líneas) de varios negocios, sin mezclar datos. Es la base de la bandeja.

---

Tarea: agregar negocios (`Business`) y líneas de WhatsApp (`Line`) al modelo y enrutar cada webhook por `phone_number_id`. Rama `feat/business-lines`.

## Modelo (Prisma, con migración)
- `Business`: `id`, `name`, `slug` único, `botName` (cómo se presenta el bot), `createdAt`, `updatedAt`.
- `Line`: `id`, `businessId`, `phoneNumberId` **único**, `wabaId`, `displayPhone`, `accessTokenEncrypted` (nullable), `active`, timestamps.
- `Contact`: `id`, `businessId`, `waId`, `profileName` (lo que manda Meta), `name` (lo que pone el operador), `optOut`; `@@unique([businessId, waId])`.
- `Conversation`: reemplazá el `waId @unique` global por `lineId` + `contactId` con `@@unique([lineId, contactId])`. Un hilo por par línea-contacto: se reabre, no se parte.
- `WebhookEvent`: `id` (bigint autoincrement), `payload` jsonb, `receivedAt`, `processedAt` nullable, `attempts`, `error`. Índice parcial sobre `receivedAt` donde `processed_at IS NULL` (a mano en el SQL de la migración).
- **Migración de datos:** la migración crea un `Business` "BotSuite46" y una `Line` con el `phone_number_id` que hoy está en `WHATSAPP_PHONE_NUMBER_ID`. Como el SQL no lee el `.env`, hacelo con un script idempotente `npm run seed:default-line` que se corre una vez después del deploy; la migración deja `lineId` nullable, el script lo completa, y una segunda migración lo vuelve `NOT NULL`. Documentá el orden en el README.

## Credenciales por línea (una app de Meta por cliente)
Cada cliente tiene **su propia app de Meta dentro de su propio portfolio**, así no hace falta la revisión de Meta. Por eso cada línea trae sus propias credenciales.
- Sumá a `Line`: `appId`, `appSecretEncrypted`, `accessTokenEncrypted` (token del System User del cliente), `verifyToken` (generado por Bottega al dar de alta la línea) y `webhookKey` (aleatorio, único, de 24 caracteres URL-safe).
- Cifrado AES-256-GCM con `TOKEN_ENCRYPTION_KEY` (32 bytes en base64, obligatoria, validada en `env.schema.ts`). `LineCredentialsService` con `encrypt/decrypt` y tests. Nunca se devuelven los secretos por la API ni se loguean.
- **Webhook por línea:** `GET/POST /webhooks/whatsapp/:webhookKey`. El GET compara contra el `verifyToken` de esa línea; el POST valida la firma con el `appSecret` de esa línea **antes** de guardar nada. Un `webhookKey` desconocido responde 404 sin tocar la base más que para buscarlo.
- Mantené `/webhooks/whatsapp` (sin clave) para la línea por defecto que usa las variables de entorno actuales, así lo que ya funciona no se rompe.
- Un payload firmado por la app de la línea A que trae un `phone_number_id` de la línea B se descarta con un warning.
- `GraphWhatsAppClient` recibe `phoneNumberId` y token por llamada en vez de leerlos de la config global. Dejá de crearlo una sola vez en `whatsapp.module.ts`: un `WhatsAppClientFactory` lo arma por línea con las credenciales descifradas.
- `parseWebhookPayload` deja de filtrar por el `phoneNumberId` del config: devuelve el `phone_number_id` de cada cambio y el servicio busca la `Line`. Un `phone_number_id` sin línea se registra como warning y no crea nada.
- La firma se valida con el secreto de la línea que identifica la ruta (`webhookKey`) **antes** de parsear. El guard actual de secreto único queda solo para la ruta sin clave de la línea por defecto.
- `META_APP_SECRET`, el token y `WHATSAPP_PHONE_NUMBER_ID` pasan a opcionales en `env.schema.ts`: si están, alimentan la línea por defecto y el seed; si no están, la app arranca igual y la ruta sin clave responde 404.

## Bot
- El prompt del bot usa `business.botName` en lugar del nombre fijo. Para el negocio por defecto, `botName = "BotSuite, IA de BotSuite46"`.
- Sacá "Sos Bottega, el asistente virtual…" de `src/bot/prompts.ts` y "asistente virtual" también del prompt de la demo. Actualizá `prompts.spec.ts` para que compruebe que el prompt usa `botName` y que **no** contiene "asistente virtual".
- El historial y el contexto se cargan por `conversationId` como hoy; revisá que ninguna consulta dependa del `waId` global.

## Admin
- La API de admin existente sigue funcionando para el negocio por defecto. Agregá `POST /admin/businesses` y `POST /admin/businesses/:id/lines` (con API key de admin) para dar de alta un negocio y su línea. El alta de la línea recibe `phoneNumberId`, `wabaId`, `appId`, `appSecret` y `accessToken`, y devuelve la URL del webhook y el `verifyToken` para pegar en la app de Meta del cliente. Después del alta, el endpoint llama a `POST /{waba_id}/subscribed_apps` con el token de la línea y devuelve si quedó suscripta.

## Fuera de alcance
Usuarios y login (prompt 03), bandeja (prompt 04), plantillas, media.

## Criterio de aceptación
- Tests: una firma hecha con el secreto de otra línea da 401; dos líneas de dos negocios reciben un mensaje del mismo `wa_id` y quedan dos contactos y dos conversaciones separadas; el mismo payload dos veces deja un solo mensaje; un procesamiento que falla queda pendiente y el reprocesador lo termina; un `phone_number_id` desconocido no crea nada.
- Lint, unit, e2e e int en verde.
