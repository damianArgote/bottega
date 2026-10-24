# Prompt 01 · Deploy con Neon y Render

> Objetivo: sacar Bottega de ngrok. Al terminar, el webhook de Meta apunta a una URL HTTPS fija y la base está en Neon.

---

Tarea: preparar `bottega-api` para correr en Render (un solo Web Service que incluye el worker) con PostgreSQL en Neon. Rama `chore/deploy-neon-render`.

## 1. Conexión a Neon
- La app usa la **conexión con pooler** (host con `-pooler`) en `DATABASE_URL`. Las migraciones usan la **directa** en una variable nueva `DATABASE_URL_UNPOOLED`. Esto es lo que indica la guía de Neon para Prisma 7: `prisma.config.ts` apunta la CLI a la URL directa y el adapter usa la pooled.
- Cambiá `prisma.config.ts` para que use `DATABASE_URL_UNPOOLED` si existe y, si no, `DATABASE_URL` (así el Docker local sigue funcionando con una sola variable).
- Documentá en `.env.example` que en Neon las dos URLs llevan `sslmode=require` y `connect_timeout=15` (la compute de Neon se apaga sola y tarda en despertar; sin timeout Prisma da `P1001`).
- Verificá que la consulta de `QueueService.claimNext` y cualquier `$transaction` funcionen detrás de PgBouncer en modo transacción: no usar `LISTEN/NOTIFY`, `SET` de sesión ni advisory locks de sesión. Si encontrás alguno, reemplazalo por la variante `_xact` o explicá por qué no hace falta.

## 2. Dejar que Neon se apague cuando no hay tráfico
El worker hoy consulta la cola cada `QUEUE_POLL_INTERVAL_MS` (1 s). Eso mantiene la compute de Neon prendida las 24 h y, en el plan Free (100 CU-horas por mes y por proyecto), se agota a mitad de mes.
- Cuando `ConversationsService.ingest` encola un trabajo, despertá al worker en proceso (un `EventEmitter` o un `Subject` de RxJS) para que lo tome enseguida.
- Agregá `QUEUE_IDLE_POLL_INTERVAL_MS` (default `600000`, 10 min): si la última vuelta no encontró trabajo, el worker espera ese intervalo o el aviso en proceso, lo que llegue primero. Con trabajo pendiente sigue al ritmo de `QUEUE_POLL_INTERVAL_MS`.
- Los reintentos con `runAfter` en el futuro tienen que seguir funcionando: el worker calcula cuándo vence el próximo `runAfter` pendiente y se despierta a esa hora si es antes que el intervalo ocioso.
- Tests: unitario del cálculo de espera; int que demuestre que un job encolado se procesa en menos de 2 s sin esperar el intervalo ocioso.

## 3. Render
- Agregá `render.yaml` (Blueprint) con un Web Service Node: `buildCommand: npm ci && npm run build`, `preDeployCommand: npm run prisma:deploy`, `startCommand: npm run start:prod`, `healthCheckPath: /health`, región `virginia`, plan `starter`. Variables con `sync: false` para todos los secretos.
- El `/health` tiene que responder rápido aunque Neon esté dormida: si hoy hace una consulta a la base, que tenga un timeout corto y que Render use un endpoint liviano (`/health/live`) sin base, y dejá `/health` con base para monitoreo.
- `main.ts`: `app.enableShutdownHooks()` ya está; confirmá que el worker termina el job en curso antes de salir (Render manda SIGTERM en cada deploy).
- Confiá en el proxy (`app.set('trust proxy', 1)`) solo si algo lo necesita; no lo agregues por las dudas.

## 4. README
Reemplazá la sección de ngrok como camino principal por "Deploy en Render + Neon" con: crear proyecto en Neon (región `aws-us-east-1`), copiar las dos URLs, crear el Blueprint en Render, cargar variables, primer deploy, y configurar la URL del webhook en Meta (`https://<servicio>.onrender.com/webhooks/whatsapp`). Dejá ngrok como alternativa para desarrollo local.
- Reescribí también la sección de alcance del README: hoy dice que no hay frontend ni multi-cliente, y el objetivo es justo ese. Dejala alineada con el `CLAUDE.md` (bot propio de BotSuite46 primero, multi-negocio, bandeja y backoffice).

## Fuera de alcance
Multi-negocio, bandeja, dominio propio, Sentry.

## Criterio de aceptación
- `npm run lint`, `npm test`, `npm run test:e2e`, `npm run test:int` en verde.
- Con la base vacía de Neon, `npm run prisma:deploy` usando `DATABASE_URL_UNPOOLED` aplica las 3 migraciones.
- En modo `echo`, un mensaje al número de prueba recibe respuesta desde Render.
