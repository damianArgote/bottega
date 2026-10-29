# Prompt 11 · Adjuntos y audios: que el bot escuche, mire y responda en texto

> Correlo después del 10 y antes del 07. Reemplaza la parte 6c del prompt 06 ("Adjuntos de entrada"). Son dos PRs: primero el backend (sesión sobre `bottega`) y después la bandeja (sesión sobre `bottega-inbox`). Objetivo: que un cliente pueda mandar un audio, una foto o un PDF y el bot lo entienda y le conteste **siempre en texto**; y que la persona que atiende vea y escuche esos adjuntos en la bandeja.

Contexto: hoy `src/whatsapp/payload.parser.ts` convierte todo lo que no es texto en `kind: 'unsupported'` y el bot contesta `UNSUPPORTED_REPLY` ("Por ahora solo puedo leer mensajes de texto. ¿Me lo escribís?"). En WhatsApp mucha gente manda audios: hoy se pierden. El proveedor ya acepta imágenes y PDF como partes del mensaje (`AiContentPart`, prompt 10b), pero no transcribe audio.

Reglas de todo el prompt:
- **El bot responde siempre en texto.** Responder con audio queda para más adelante.
- **No se guardan archivos propios.** El archivo queda en Meta, que lo borra a los 30 días. En la base se guardan el `mediaId`, el tipo, el nombre, el caption y la transcripción; la transcripción queda aunque Meta borre el audio (escribilo en el README).
- **Lo que hace el modelo con un adjunto cuenta en los topes del prompt 09.** Con un tope alcanzado, el adjunto no se baja ni se procesa y rige lo que ya hace el bot al llegar a ese tope.
- Nunca loguear en nivel `info` la transcripción, el caption, el nombre del archivo ni la URL temporal de Meta.

---

## Parte 1 · Backend (rama `feat/inbound-media`, repo `bottega`)

### Datos (solo expande)
- Columnas nuevas y nulas en `message`: `media_kind` (`image`, `audio`, `document`, `video`, `sticker`, `location`, `other`), `media_id`, `media_mime`, `media_size int`, `media_filename`, `media_voice boolean` (nota de voz), `transcript text` y `media_error text`.
- `media_error` es uno de: `too_long`, `too_large`, `daily_cap`, `ai_cap`, `unsupported_type`, `transcription_failed`, `empty_transcript`, `media_gone`.
- Columnas nuevas y nulas en `business`: `audio_max_seconds` y `media_daily_cap_per_conversation` (ver **Límites**).
- **No agregues valores a `MessageType`** en este PR: la versión en `main` no los conoce y la bandeja vieja fallaría al leerlos mientras Render migra. Imagen, audio, documento, video y sticker se guardan con `type = UNSUPPORTED` y las columnas nuevas completas; `content` es el caption si lo hay, o `[audio]`, `[image]`… como hoy. **Ubicación** se guarda como `TEXT` con `media_kind = location` y `content` = "Ubicación: <nombre>, <dirección> (lat, long)".
- Un `UNSUPPORTED` con `media_kind` nulo es una fila de la versión anterior (o un tipo desconocido): responde el texto fijo del resto, sin bajar nada.

### Recibir
- `payload.parser.ts` parsea `image`, `audio`, `document`, `video`, `sticker` y `location` además de `text`: `mediaId`, `mime_type`, `file_size` si viene, `caption`, `filename` (documento), `voice` (audio), y el `profileName` del contacto igual que para texto. Un tipo desconocido sigue como hoy.
- Varios mensajes en un mismo webhook (por ejemplo, un álbum de fotos) son varios mensajes y varios jobs, como hoy. La idempotencia por `wamid` no cambia.

### Preparar el adjunto (paso nuevo en `BotService`, antes de generar la respuesta)
El generador de respuestas no escribe datos y se vuelve a correr en cada reintento (`src/bot/reply-generator.ts`), así que la preparación es un paso propio de `BotService`, **antes** de llamar a `generate`:
1. Si el mensaje ya tiene `transcript` o `media_error`, se saltea (un reintento no vuelve a bajar ni a transcribir).
2. Aplica los **Límites** (sin bajar nada si no pasan) y los topes del 09.
3. Para un audio: pide `GET /{media_id}`, baja el archivo y lo transcribe. Para una imagen o un PDF: pide la URL y baja el archivo para mandárselo al modelo en este turno (no se guarda).
4. Guarda `transcript` o `media_error` y llama a `touchConversations` en la misma transacción, así la bandeja vuelve a pedir el hilo y ve la transcripción.

El generador recibe el mensaje con su `media` y decide por `media_kind`, no solo por `type`.

**Conversación pausada, atendida por una persona o agente apagado:** el audio **se transcribe igual** para que la persona lo lea en la bandeja (cuenta en los topes del 09), pero el bot no responde, como hoy. Las imágenes y los PDF no se procesan en ese caso.

### Bajar el archivo de Meta
- Con el token cifrado de la línea: `GET /{media_id}` devuelve `url`, `mime_type` y `file_size`. La `url` se acepta **solo** si es `https` y su host es de Meta (lista cerrada, por ejemplo `lookaside.fbsbx.com`); se pide con `redirect: 'manual'` y el Bearer **nunca** viaja a otro host.
- La URL temporal de Meta vence en minutos: no se guarda. Cada intento, y cada pedido al proxy, vuelve a pedir `GET /{media_id}`.
- Antes de bajarlo se aplican los límites de tamaño con el `file_size`. Un error de red o un 5xx de Meta es reintentable (`JobError` reintentable); un 404 es definitivo: `media_error = 'media_gone'` y el bot responde "No pude abrir el archivo. ¿Me lo mandás de nuevo?".
- La cola tiene que alcanzar: `worstCaseAiJobMs` (`src/ai/ai-limits.ts`) suma 2 × `WHATSAPP_HTTP_TIMEOUT_MS` (metadata y descarga) + `OPENAI_TRANSCRIBE_TIMEOUT_MS`, y la validación de `QUEUE_LEASE_MS` del arranque lo incluye, con test. Si no, otro worker toma el job mientras transcribe y el audio se cobra dos veces.

### Audios
- Puerto nuevo en el proveedor: `transcribe({ audio, mimeType }) → { text, model }`. Adaptador de OpenAI con la API de transcripción, modelo `OPENAI_TRANSCRIBE_MODEL` (por defecto `gpt-4o-mini-transcribe`) y `OPENAI_TRANSCRIBE_TIMEOUT_MS` (por defecto `30000`), idioma `es`. Las dos se validan en `env.schema.ts` y se documentan.
- Se transcriben solo `audio/ogg` (notas de voz de WhatsApp, Opus), `audio/mpeg`, `audio/mp4`, `audio/wav` y `audio/webm`. Otros (`audio/amr`, `audio/aac`…): `media_error = 'unsupported_type'` y el texto fijo del resto. Confirmá con un audio real que el modelo acepta la nota de voz OGG tal cual; si no, decilo antes de sumar una conversión.
- La transcripción se guarda en `message.transcript` y deja una fila en `ai_usage` con el modelo de transcripción, tokens `0/0` si el proveedor no los informa, su `latencyMs` y el `agentProfileVersion` del turno: cuenta como una llamada en los dos topes del 09. Un audio cuesta entonces la transcripción más las vueltas del modelo para responder; los topes se miran una vez, antes de transcribir.
- El bot responde como si la persona hubiera escrito la transcripción. Para el modelo el mensaje va como `"[Audio transcrito] <texto>"`, así sabe que puede haber errores y no cita palabra por palabra. **Una transcripción nunca dispara comandos** ("humano", "demo"…): solo el texto escrito.
- Errores: uno reintentable del proveedor con intentos disponibles lanza un `JobError` reintentable, igual que las llamadas al modelo; en el último intento o con un error definitivo, `media_error = 'transcription_failed'` y texto fijo: "No pude escuchar bien el audio. ¿Me lo escribís o me mandás otro?". Una transcripción vacía: `empty_transcript`, mismo texto. En ningún caso pasa a una persona por eso.

### Límites
Nadie tiene que poder mandar un audio largo y gastar el tope del negocio.

| Límite | Variable (por defecto) | Por negocio | Al pasarlo |
|---|---|---|---|
| Duración de un audio | `MEDIA_AUDIO_MAX_SECONDS` (`120`) | `business.audio_max_seconds` | No se transcribe. "Ese audio es muy largo para mí (hasta 2 minutos). ¿Me mandás uno más corto o me lo escribís?" `media_error = 'too_long'`. |
| Tamaño de un audio | `MEDIA_AUDIO_MAX_BYTES` (`1000000`) | — | No se baja. "Ese audio es muy pesado para mí. ¿Me mandás uno más corto o me lo escribís?" `media_error = 'too_large'`. |
| Tamaño de imagen y PDF | `MEDIA_IMAGE_MAX_BYTES` (`5000000`), `MEDIA_DOCUMENT_MAX_BYTES` (`10000000`) | — | No se baja. "El archivo es muy pesado para abrirlo. ¿Me contás por escrito qué necesitás?" `media_error = 'too_large'`. |
| Adjuntos por conversación por día | `MEDIA_MAX_PER_CONVERSATION_PER_DAY` (`10`) | `business.media_daily_cap_per_conversation` | No se procesa. "Por hoy no puedo abrir más archivos en esta charla. ¿Me lo escribís?" `media_error = 'daily_cap'`. |

- **Qué cuenta el tope diario de adjuntos:** los mensajes entrantes del día (Argentina, `usageDay`, como el 09) de esa conversación con `media_kind` en audio, imagen o documento PDF y `media_error` nulo, es decir, los que de verdad se procesaron.
- **Duración de una nota de voz OGG/Opus**, sin transcribir: `granule_position` de la última página menos el `pre-skip` del encabezado `OpusHead`, dividido 48.000 (función pura, con test sobre un audio real chico). Los otros formatos se controlan solo con el límite de bytes.
- **El texto con el límite** muestra los minutos así: 60 → "1 minuto", 90 → "1 minuto y medio", 120 → "2 minutos"; otros valores en segundos ("45 segundos").
- Las variables se validan en `env.schema.ts` y se documentan en `README.md` y `.env.example`. Las columnas por negocio son nulas (`null` usa la variable) y se cambian **solo** con `PUT /admin/businesses/:id/limits`, que suma `audioMaxSeconds` (5 a 600) y `mediaDailyCapPerConversation` (1 a 1.000), **opcionales como `catalogItemCap`**: si no se mandan no cambian, `null` vuelve a la variable. `GET /admin/businesses/:id/limits` las devuelve.
- Un adjunto rechazado por un límite **no** llama al modelo y no cuenta en los topes del 09.
- La bandeja muestra igual el adjunto (se puede escuchar o ver desde el proxy) con su motivo, por ejemplo "No se transcribió: dura más de 2 minutos".

### Imágenes y PDF
- Imagen: el modelo la recibe como `image`, con el caption como texto en el mismo mensaje del usuario. PDF: como `file`. Responde en texto. Una imagen con solo caption tiene `content` = caption.
- En el **historial** de turnos siguientes no se reenvían imágenes ni PDF (cuestan tokens): van como texto `"[Imagen] <caption>"` o `"[PDF: <nombre>] <caption>"`. Los audios van con su transcripción (`"[Audio transcrito] <texto>"`), no con `content`. El historial lee las columnas `media_*` y `transcript` además de `content`.
- En la demo, una imagen va a la demo (al negocio ficticio) y cuenta en los topes del negocio real, como cualquier respuesta de la demo.

### El resto
- `video`, `sticker`, documentos que no son PDF (Word, Excel…), audios en formatos no soportados y `other`: texto fijo "Todavía no puedo abrir ese tipo de archivo. ¿Me contás por escrito qué necesitás?". El bot no hace handoff por eso.
- `location`: el bot recibe el texto de la ubicación y responde normal.
- Modo `echo` (sin IA): audios, imágenes y PDF responden el texto fijo del resto.
- Un audio y un texto seguidos son dos mensajes y dos respuestas, en orden (la cola ya los procesa de a uno por conversación). Agruparlos es la parte 6b del prompt 06, fuera de este alcance. Un álbum de N fotos son N respuestas y N llamadas.

### Bandeja (API)
- Los mensajes de `GET /inbox/.../conversations/:id/messages` suman `media`: `{ kind, mime, filename, caption, voice, transcript, error, url }`, donde `url` es un link firmado al proxy (nulo para `location`).
- **Proxy**: `GET /inbox/businesses/:businessId/media/:messageId?exp=&sig=`, en un controlador aparte **sin** `SessionGuard` (un `<audio src>` o `<img src>` no siempre manda la cookie): el control es la firma.
  - Firma HMAC-SHA256 sobre `businessId:messageId:exp`, comparada en tiempo constante. `MEDIA_URL_SECRET` es obligatorio, sin valor por defecto, de al menos 32 caracteres (como `JWT_SECRET`).
  - `exp` se redondea a ventanas fijas (el fin de la media hora siguiente más 30 minutos), así la URL no cambia en cada refresco de la bandeja y no se corta un audio que se está escuchando.
  - Orden: firma mala o vencida → 403; mensaje que no es de ese negocio o sin `media_id` → 404; Meta ya lo borró → 410 con "El archivo ya no está disponible en WhatsApp".
  - El backend pide `GET /{media_id}` y hace stream del archivo. Reenvía el header `Range` a Meta y responde 206 con `Content-Range` y `Accept-Ranges` (Safari en iPhone lo necesita para reproducir audio).
  - Solo se sirven en línea los tipos de una lista cerrada: `audio/*`, `image/jpeg`, `image/png`, `image/webp`, `application/pdf` y `video/mp4`. Cualquier otro va como `application/octet-stream` con `Content-Disposition: attachment`. Siempre `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` y `Cache-Control: private, no-store`. Así un archivo `text/html` o `image/svg+xml` que mande un cliente no se ejecuta en el dominio de la API.

### Deploy
- Cargá `MEDIA_URL_SECRET` en Render (y en el entorno de los tests e2e e int) **antes** de mergear a `main`: sin él la versión nueva no arranca.
- Mientras Render migra, la versión anterior sigue guardando adjuntos como hoy (sin `media_id`); la nueva los responde con el texto fijo del resto.

### Pruebas
- Unit: parseo de cada tipo (con un payload real de Meta por tipo en `test/fixtures`); duración de una nota de voz OGG/Opus real (fixture chico); el texto con el límite (60, 90, 120, 45 segundos); firma, ventana de `exp` y vencimiento del proxy; lista de hosts de Meta aceptados; armado del historial con adjuntos; `worstCaseAiJobMs` con los tiempos nuevos.
- Int (Meta y OpenAI mockeados):
  - Un audio se baja, se transcribe una vez, se guarda la transcripción, el bot recibe `"[Audio transcrito] …"` y responde en texto; queda la fila en `ai_usage`; la conversación aparece en `/changes`.
  - Un reintento del job no vuelve a transcribir si `transcript` ya está guardado.
  - Un error reintentable de la transcripción reintenta; en el último intento, texto fijo y `transcription_failed`, sin pasar a una persona.
  - Una transcripción que dice "humano" no dispara el comando.
  - Con la conversación pausada, el audio se transcribe y el bot no responde.
  - Imagen con caption: el modelo recibe la imagen; en el turno siguiente el historial lleva `"[Imagen] <caption>"` y no la imagen.
  - Con el tope mensual alcanzado no se baja ni se transcribe nada.
  - Un audio de más de `MEDIA_AUDIO_MAX_SECONDS` no se transcribe, responde el texto con el límite y no suma en `ai_usage`; `business.audio_max_seconds` pisa a la variable. Uno con `file_size` sobre `MEDIA_AUDIO_MAX_BYTES` ni se baja.
  - El adjunto número 11 del día en una conversación responde el texto fijo sin llamar al modelo; uno rechazado por tamaño no cuenta para ese tope.
  - Un audio `audio/amr`: texto fijo del resto, sin transcribir.
  - Un 404 de Meta al bajar: `media_gone` y su texto.
  - Una `url` de Meta con otro host no se pide y el Bearer no sale.
  - Una fila `UNSUPPORTED` sin `media_kind` responde el texto fijo del resto.
  - `PUT /admin/businesses/:id/limits` cambia `audioMaxSeconds` y `mediaDailyCapPerConversation`; sin mandarlos, no cambian.
  - Video o sticker: texto fijo.
  - Proxy: link válido hace stream con el tipo correcto; con `Range` responde 206; un `text/html` sale como descarga con `nosniff`; vencido o con firma mala, 403; mensaje de otro negocio, 404; Meta lo borró, 410.
  - Ningún log de nivel `info` incluye la transcripción, el caption ni la URL de Meta.
- Lint, unit, e2e e int en verde. Toca una migración, el webhook, la cola y lo que el bot le dice a los clientes: lleva verificador independiente antes del PR.

## Parte 2 · Bandeja (rama `feat/inbound-media`, repo `bottega-inbox`)
- En el hilo: audio con reproductor y su transcripción debajo (con la marca "transcripción automática"); imagen en miniatura que se abre grande; documento con nombre e ícono para abrirlo; ubicación como texto con link a Google Maps; video y sticker como etiqueta ("Video", "Sticker") con link para abrirlo.
- Si el archivo ya no está (410) o falló (`media.error`), un texto claro en lugar del reproductor o la imagen, por ejemplo "No se transcribió: dura más de 2 minutos".
- **Aviso de que los archivos son temporales:** si la conversación tiene al menos un adjunto con archivo (audio, imagen, documento, video o sticker), arriba del hilo se muestra un aviso fijo: "Los archivos de WhatsApp (audios, fotos y documentos) se borran a los 30 días de recibidos. Si necesitás guardar alguno, descargalo antes. Las transcripciones de los audios quedan." Además, cada adjunto muestra hasta cuándo está disponible ("Disponible hasta el 28/11"), calculado con la fecha del mensaje más 30 días en la zona horaria del negocio; pasada esa fecha, el texto del 410. Una conversación sin adjuntos no muestra el aviso.
- La URL firmada es estable durante su ventana; cuando vence, se vuelve a pedir el mensaje para tener una nueva.
- Usable en el celular, con el audio reproducible en Safari de iPhone.
- Tests con la API mockeada: cada tipo se muestra como corresponde; un error muestra el texto y no un reproductor roto; una transcripción que llega después (por `/changes`) aparece sin recargar; el aviso de archivos temporales aparece solo en una conversación con adjuntos, y la fecha "Disponible hasta" es la del mensaje más 30 días.

## Fuera de alcance
Responder con audio, entender videos, leer Word o Excel, guardar los archivos en un storage propio más allá de los 30 días de Meta, mandar adjuntos desde la bandeja, y agrupar mensajes seguidos (6b del prompt 06).
