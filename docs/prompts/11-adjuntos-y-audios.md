# Prompt 11 · Adjuntos y audios: que el bot escuche, mire y responda en texto

> Correlo después del 10 y antes del 07. Reemplaza la parte 6c del prompt 06 ("Adjuntos de entrada"). Son dos PRs: primero el backend (sesión sobre `bottega`) y después la bandeja (sesión sobre `bottega-inbox`). Objetivo: que un cliente pueda mandar un audio, una foto o un PDF y el bot lo entienda y le conteste **siempre en texto**; y que la persona que atiende vea y escuche esos adjuntos en la bandeja.

Contexto: hoy `src/whatsapp/payload.parser.ts` convierte todo lo que no es texto en `kind: 'unsupported'` y el bot contesta `UNSUPPORTED_REPLY` ("Por ahora solo puedo leer mensajes de texto. ¿Me lo escribís?"). En WhatsApp mucha gente manda audios: hoy se pierden. El proveedor ya acepta imágenes y PDF como partes del mensaje (`AiContentPart`, prompt 10b), pero no transcribe audio.

Reglas de todo el prompt:
- **El bot responde siempre en texto.** Responder con audio queda para más adelante.
- **No se guardan archivos propios.** El archivo queda en Meta (lo borra a los 30 días, dejalo escrito en el README); en la base se guarda solo el `mediaId`, el tipo, el nombre y la transcripción.
- **Todo lo que hace el modelo con un adjunto cuenta en los topes del prompt 09** (mensual del negocio y diario de la conversación). Con el tope alcanzado, el adjunto no se procesa y rige lo que ya hace el bot al llegar al tope.
- Nunca loguear en nivel `info` la transcripción, el caption, el nombre del archivo ni la URL temporal de Meta.

---

## Parte 1 · Backend (rama `feat/inbound-media`, repo `bottega`)

### Datos (solo expande)
- Columnas nuevas y nulas en `message`: `media_kind` (`image`, `audio`, `document`, `video`, `sticker`, `location`, `other`), `media_id`, `media_mime`, `media_filename`, `media_caption`, `media_voice boolean` (nota de voz), `transcript text` y `media_error text` (código corto, por ejemplo `too_large`, `transcription_failed`).
- Columnas nuevas y nulas en `business`: `audio_max_seconds` y `media_daily_cap_per_conversation` (ver **Límites**).
- **No agregues valores a `MessageType`** en este PR: la versión en `main` no los conoce y la bandeja vieja fallaría al leerlos mientras Render migra. Un adjunto se guarda con `type = UNSUPPORTED` (como hoy, la versión anterior lo sigue mostrando igual) y con las columnas nuevas completas. `content` queda como hoy (`[audio]`, `[image]`…) o con el caption si lo hay.

### Recibir
- `payload.parser.ts` parsea `image`, `audio`, `document`, `video`, `sticker` y `location` además de `text`: `mediaId`, `mime_type`, `caption`, `filename` (documento), `voice` (audio), y para `location` latitud, longitud, nombre y dirección (va al `content` como texto: "Ubicación: <nombre>, <dirección> (lat, long)"). Un tipo desconocido sigue como hoy.
- La idempotencia por `wamid` no cambia.

### Bajar el archivo de Meta (solo cuando hace falta)
- Con el token cifrado de la línea: `GET /{media_id}` devuelve `url`, `mime_type` y `file_size`; después `GET url` con el Bearer. Antes de bajarlo se aplican los límites de tamaño (ver **Límites**).
- Se baja dentro del job del bot (ya corre en la cola, con reintentos), nunca en el webhook. Un error de red de Meta es reintentable; un 404 no.

### Audios
- Puerto nuevo en el proveedor: `transcribe({ audio, mimeType }) → { text, model }`. Adaptador de OpenAI con la API de transcripción, modelo `OPENAI_TRANSCRIBE_MODEL` (por defecto `gpt-4o-mini-transcribe`; validada en `env.schema.ts` y documentada), idioma `es`.
- Las notas de voz de WhatsApp son OGG/Opus: confirmá que el modelo las acepta tal cual; si no, convertí sin sumar dependencias nativas (si hace falta una, decilo antes).
- La transcripción se guarda en `message.transcript` y queda una fila en `ai_usage` (cuenta en los topes). Antes de transcribir se aplican los límites de abajo.
- El bot responde como si la persona hubiera escrito la transcripción. Para el modelo el mensaje va como `"[Audio transcrito] <texto>"`, así sabe que puede haber errores de transcripción y no cita palabra por palabra.
- Si la transcripción falla o sale vacía: texto fijo "No pude escuchar bien el audio. ¿Me lo escribís o me mandás otro?" (sin pasar a una persona).

### Límites
Nadie tiene que poder mandar un audio largo y gastar el tope del negocio (ni hacer esperar al resto).

| Límite | Variable (por defecto) | Por negocio | Al pasarlo |
|---|---|---|---|
| Duración de un audio | `MEDIA_AUDIO_MAX_SECONDS` (`120`) | `business.audio_max_seconds` | No se transcribe. Texto fijo: "Ese audio es muy largo para mí (hasta 2 minutos). ¿Me mandás uno más corto o me lo escribís?" (el número sale del límite). `media_error = 'too_long'`. |
| Tamaño de un audio | `MEDIA_AUDIO_MAX_BYTES` (`2000000`) | — | Igual que la duración, sin bajar el archivo (`file_size` de Meta). |
| Tamaño de imagen y PDF | `MEDIA_IMAGE_MAX_BYTES` (`5000000`), `MEDIA_DOCUMENT_MAX_BYTES` (`10000000`) | — | No se baja. Texto fijo: "El archivo es muy pesado para abrirlo. ¿Me contás por escrito qué necesitás?" `media_error = 'too_large'`. |
| Adjuntos procesados por conversación por día | `MEDIA_MAX_PER_CONVERSATION_PER_DAY` (`10`) | `business.media_daily_cap_per_conversation` | No se procesa. Texto fijo: "Por hoy no puedo abrir más archivos en esta charla. ¿Me lo escribís?" Cuenta audios, imágenes y PDF, día de Argentina como el prompt 09. |

- Las variables se validan en `env.schema.ts` y se documentan en `README.md` y `.env.example`. Las columnas por negocio son nulas (`null` usa la variable) y se cambian **solo** con `PUT /admin/businesses/:id/limits` (suma `audioMaxSeconds` y `mediaDailyCapPerConversation`, opcionales: si no se mandan, no cambian), igual que los topes del 09. `GET /admin/businesses/:id/limits` las devuelve.
- La duración se calcula **sin transcribir**: de una nota de voz OGG/Opus, con la posición del último bloque del archivo (función pura, con test); si el formato no la trae, se estima con el tamaño y se usa el límite de bytes. Primero se mira el `file_size` que da Meta, así un audio enorme ni se baja.
- Un adjunto rechazado por un límite **no** llama al modelo y no cuenta en los topes del 09.
- La bandeja muestra igual el adjunto (se puede escuchar o ver desde el proxy) con su motivo: "No se transcribió: dura más de 2 minutos".

### Imágenes y PDF
- Imagen: el modelo la recibe como `image` con el caption como texto en el mismo mensaje del usuario. PDF: como `file`. Responde en texto.
- En el **historial** de turnos siguientes no se reenvían imágenes ni PDF (cuestan tokens): van como texto `"[Imagen] <caption>"` o `"[PDF: <nombre>] <caption>"`. Los audios van con su transcripción.
- Una imagen o un PDF cuenta como una llamada más en los topes, igual que un mensaje de texto.

### El resto
- `video`, `sticker`, documentos que no son PDF (Word, Excel…) y `other`: texto fijo "Todavía no puedo abrir ese tipo de archivo. ¿Me contás por escrito qué necesitás?". No pasa a una persona salvo que la persona lo pida.
- `location`: el bot recibe el texto de la ubicación y responde normal.
- Modo `echo` (sin IA): audios, imágenes y PDF responden el texto fijo del resto.

### Bandeja (API)
- Los mensajes de `GET /inbox/.../conversations/:id/messages` suman `media`: `{ kind, mime, filename, caption, voice, transcript, error, url }`, donde `url` es un link firmado al proxy.
- Proxy: `GET /inbox/businesses/:businessId/media/:messageId?exp=&sig=`, firmado con HMAC (`MEDIA_URL_SECRET`, obligatorio, sin valor por defecto) y vencimiento de 60 minutos. El backend pide la URL temporal a Meta y hace stream del archivo con el Bearer, con el `Content-Type` de Meta. Link vencido o firma mala: 403. Mensaje de otro negocio: 404. Media que Meta ya borró: 410 con un texto para mostrar ("El archivo ya no está disponible en WhatsApp").
- El proxy no exige la cookie de sesión (un `<audio src>` o `<img src>` no siempre la manda): la firma, que incluye el `messageId` y el vencimiento, es el control.

### Pruebas
- Unit: parseo de cada tipo (con un payload real de Meta por tipo en `test/fixtures`); duración de una nota de voz OGG/Opus real (fixture chico); firma y vencimiento del proxy; armado del historial con adjuntos.
- Int (Meta y OpenAI mockeados):
  - Un audio se baja, se transcribe una vez, se guarda la transcripción, el bot recibe `"[Audio transcrito] …"` y responde en texto; queda la fila en `ai_usage`.
  - Un reintento del job no vuelve a transcribir si `transcript` ya está guardado.
  - Transcripción fallida: texto fijo, sin pasar a una persona.
  - Imagen con caption: el modelo recibe la imagen; en el turno siguiente el historial lleva `"[Imagen] <caption>"` y no la imagen.
  - Con el tope mensual alcanzado no se baja ni se transcribe nada.
  - Un audio de más de `MEDIA_AUDIO_MAX_SECONDS` (o con `file_size` sobre el límite) no se baja ni se transcribe, responde el texto con el límite y no suma en `ai_usage`; `business.audio_max_seconds` pisa a la variable.
  - El adjunto número 11 del día en una conversación responde el texto fijo sin llamar al modelo.
  - `PUT /admin/businesses/:id/limits` cambia `audioMaxSeconds` y `mediaDailyCapPerConversation`; sin mandarlos, no cambian.
  - Video o sticker: texto fijo.
  - Proxy: link válido hace stream; vencido o con firma mala, 403; mensaje de otro negocio, 404.
  - Ningún log de nivel `info` incluye la transcripción ni el caption.
- Lint, unit, e2e e int en verde. Toca una migración, el webhook y lo que el bot le dice a los clientes: lleva verificador independiente antes del PR.

## Parte 2 · Bandeja (rama `feat/inbound-media`, repo `bottega-inbox`)
- En el hilo: audio con reproductor y su transcripción debajo (con la marca "transcripción automática"); imagen en miniatura que se abre grande; documento con nombre e ícono para abrirlo; ubicación como texto con link a Google Maps; video y sticker como etiqueta ("Video", "Sticker") con link para abrirlo.
- Si el archivo ya no está (410) o falló (`media.error`), un texto claro en lugar del reproductor o la imagen.
- El link firmado vence a los 60 minutos: si la vista lleva más tiempo abierta, se vuelve a pedir el mensaje para tener uno nuevo.
- Usable en el celular.
- Tests con la API mockeada: cada tipo se muestra como corresponde; un error muestra el texto y no un reproductor roto.

## Fuera de alcance
Responder con audio, entender videos, leer Word o Excel, guardar los archivos en un storage propio más allá de los 30 días de Meta, mandar adjuntos desde la bandeja, y agrupar mensajes seguidos (6b del prompt 06).
