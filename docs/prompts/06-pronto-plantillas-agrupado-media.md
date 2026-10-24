# Prompt 06 · Segunda iteración: plantillas, agrupar mensajes y adjuntos

> Correlo recién cuando el piloto use la bandeja. Son tres PRs separados; podés pegarlos de a uno.

---

## 6a · Plantillas (rama `feat/templates`)
- Tabla `Template`: `wabaId`, `name`, `language`, `category`, `status`, `components` jsonb, `deletedAt`; `@@unique([wabaId, name, language])`.
- Sync: `GET /{waba_id}/message_templates?fields=id,name,language,category,status,components&limit=100` siguiendo `paging.next`. Upsert; las que Meta ya no devuelve se marcan `deletedAt`, no se borran. Endpoint `POST /inbox/businesses/:id/templates/sync` y una corrida diaria.
- Envío: `POST /inbox/.../conversations/:id/templates` `{ templateId, values[] }`. Solo `APPROVED` y de la misma WABA que la línea. Renderizá el cuerpo localmente (para guardarlo en el hilo) y rechazá con 400 si falta algún valor.
- Web: cuando la ventana está cerrada, el composer ofrece elegir plantilla y completar sus variables con vista previa.

## 6b · Agrupar mensajes seguidos para el bot (rama `feat/inbound-debounce`)
La gente escribe "hola", "quiero precio", "para 2 personas" en tres mensajes y hoy el bot contesta tres veces.
- `INBOUND_DEBOUNCE_MS` (default `6000`). Al encolar un entrante, `runAfter = now + debounce`. Si ya hay un job `PENDING` de esa conversación, se le corre el `runAfter` en vez de crear otro, y el mensaje nuevo queda asociado a ese job.
- El worker, al procesar, toma todos los entrantes sin procesar de la conversación en orden y genera **una** respuesta. Mantené el orden estricto por conversación que ya garantiza la cola.
- Test int: tres entrantes con 1 s de diferencia producen una sola llamada a la IA y una sola respuesta.

## 6c · Adjuntos de entrada (rama `feat/inbound-media`)
- Parsear `image`, `audio`, `document`, `video`, `sticker`, `location`, `reaction`, `interactive`/`button`: guardar `mediaId`, `mime`, caption o título. Lo desconocido: "(mensaje de tipo X)" y el payload crudo.
- Proxy: `GET /inbox/.../media/:messageId?exp=&sig=` firmado con HMAC (`MEDIA_URL_SECRET`, obligatorio, sin fallback) y vencimiento de 60 min. El backend pide la URL temporal a Meta (`GET /{media_id}`) y hace stream del archivo con el Bearer. Link vencido o firma mala: 403.
- Meta borra la media a los 30 días: dejalo escrito en el README; copiar a storage propio queda para cuando un cliente lo pida.
- Para el bot: si el entrante no es texto, responde con un mensaje fijo ("Por ahora leo solo texto; ya le aviso a una persona") y pasa la conversación a `PENDING`.
