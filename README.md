# bottega-api

Backend del bot comercial de WhatsApp de Bottega y de sus demos interactivas.
Atiende prospectos, toma sus datos, muestra una demo (una barbería ficticia) y
deriva a una persona del equipo cuando hace falta. Usa la **API oficial de
WhatsApp Cloud** (sin BuilderBot ni librerías por QR), OpenAI y PostgreSQL.

> **Alcance:** hoy es el bot comercial propio de BotSuite46 (un solo número)
> más una demo. Hacia dónde va: varios negocios y números, cada uno con su
> propia app de Meta; el agente de cada negocio configurado desde la base; una
> bandeja web para que una persona responda y tome o devuelva el control al
> bot; y un backoffice chico para el agente y los leads. Ver `CLAUDE.md` y
> `docs/prompts/`.

## Índice

| Paso | Sección |
| ---- | ------- |
| 1–7 | [Puesta en marcha local](#puesta-en-marcha-local) |
| — | [Deploy en Render + Neon](#deploy-en-render--neon) |
| 8–12 | [Conectar con WhatsApp (Meta)](#conectar-con-whatsapp-meta) |
| — | [Cómo se comporta el bot](#cómo-se-comporta-el-bot) |
| — | [API de administración](#api-de-administración) |
| — | [Editar contenido](#editar-contenido) |
| — | [Pruebas automáticas](#pruebas-automáticas) |
| — | [Solución de problemas](#solución-de-problemas) |
| — | [Arquitectura](#arquitectura) |
| — | [Antes de producción](#antes-de-producción) |

---

## Puesta en marcha local

Camino rápido (con todo instalado y el `.env` completo):

```bash
npm install
npm run db:up
npm run prisma:migrate
npm run start:dev
curl localhost:3000/health   # {"status":"ok","db":"up"}
```

Si es la primera vez, seguí los pasos de abajo.

### 1. Requisitos

| Herramienta | Versión / nota |
| ----------- | -------------- |
| WSL | Ubuntu. Todos los comandos se corren dentro de WSL. |
| Node.js | 24 LTS recomendado (funciona desde 22.22.3). Con nvm: `nvm use` lee `.nvmrc`. |
| npm | El que viene con Node. |
| Docker Desktop | Con **WSL integration** activada para tu distro (Settings → Resources → WSL integration). [Guía](https://docs.docker.com/desktop/features/wsl/). |
| ngrok | Opcional, solo para probar local contra Meta. Cuenta gratuita y el CLI instalado en WSL. [Guía](https://ngrok.com/docs/getting-started/). |
| Render y Neon | Para el deploy: una cuenta en [Render](https://render.com) y otra en [Neon](https://neon.tech). Ver [Deploy en Render + Neon](#deploy-en-render--neon). |
| Meta | Una app de Meta con el producto WhatsApp (en nuestro caso, la app **BotSuite**). |
| OpenAI | Solo para el modo IA. Ver [nota sobre ChatGPT Plus](#4-configurar-el-env). |

Verificá:

```bash
node -v && npm -v && docker compose version && ngrok version
```

### 2. Instalar dependencias

```bash
npm install
```

También genera el cliente de Prisma (`src/generated/prisma`).

### 3. Levantar PostgreSQL

```bash
npm run db:up     # levanta Postgres en Docker y espera a que esté sano
npm run db:down   # lo detiene (los datos NO se borran)
```

Los datos viven en un volumen de Docker (`bottega-db-data`), así que
sobreviven a reinicios. Las credenciales `bottega/bottega` son **solo para
desarrollo local**.

### 4. Configurar el `.env`

```bash
cp .env.example .env
```

Completá los valores. La app valida todo al arrancar: si falta algo o tiene
mal formato, no inicia y te dice **qué variable** falla (nunca muestra su valor).

> **Seguridad:** nunca subas el `.env` a git (ya está en `.gitignore`) y nunca
> pegues tokens ni claves en chats, issues o capturas.

**Base de datos y servidor**

| Variable | Obligatoria | Default | Qué es |
| -------- | ----------- | ------- | ------ |
| `DATABASE_URL` | Sí | — | Conexión a Postgres. Con Docker local: `postgresql://bottega:bottega@localhost:5432/bottega`. En Neon, la URL **con pooler** (host con `-pooler`). |
| `DATABASE_URL_UNPOOLED` | No | — | Conexión **directa** (sin pooler), solo para las migraciones (`prisma migrate`). Si no está, se usa `DATABASE_URL`. En Docker local no hace falta. |
| `PORT` | No | `3000` | Puerto HTTP. |
| `NODE_ENV` | No | `development` | `development`, `test` o `production`. |

**WhatsApp / Meta (línea por defecto)**

\* Estas cuatro describen la **línea por defecto** (BotSuite46): la ruta sin
clave `/webhooks/whatsapp` y el negocio que crea `npm run seed:default-line`.
Si faltan, la app arranca igual y esa ruta responde `404`. Cada línea guarda
sus propias credenciales (cifradas) en la base: la app manda los mensajes con
el token de la línea de cada conversación, no con el del entorno.

| Variable | Obligatoria | Default | Qué es y dónde se consigue |
| -------- | ----------- | ------- | -------------------------- |
| `META_APP_SECRET` | No* | — | Secreto de la app. Meta for Developers → tu app → **App settings → Basic → App secret**. Se usa para validar la firma de cada webhook. |
| `WHATSAPP_VERIFY_TOKEN` | No* | — | Un texto **que inventás vos** (por ejemplo `openssl rand -hex 16`). Lo vas a pegar también en Meta al configurar el webhook. **No es el access token.** |
| `WHATSAPP_ACCESS_TOKEN` | No* | — | Token para enviar mensajes. WhatsApp → **API Setup** → token temporal. **Vence en unas horas** y hay que regenerarlo. Para algo durable: token de un **System User** (Business Settings), con la expiración que elijas. |
| `WHATSAPP_PHONE_NUMBER_ID` | No* | — | El **ID** del número (WhatsApp → API Setup). **No es el número de teléfono.** |
| `WHATSAPP_GRAPH_API_VERSION` | Sí | — | Versión de la Graph API, con formato `v26.0`. Revisá la vigente en el [changelog](https://developers.facebook.com/docs/graph-api/changelog). |
| `WHATSAPP_HTTP_TIMEOUT_MS` | No | `10000` | Tiempo máximo de cada envío a Meta. Si se agota, el envío queda "incierto" y **no se reenvía**. |

**Bot e IA**

| Variable | Obligatoria | Default | Qué es |
| -------- | ----------- | ------- | ------ |
| `BOT_REPLY_MODE` | No | `echo` | `echo` (responde repitiendo el mensaje; para probar la conexión) o `ai`. |
| `OPENAI_API_KEY` | Si `BOT_REPLY_MODE=ai` | — | Clave de la API de OpenAI (platform.openai.com → API keys). |
| `OPENAI_MODEL` | Si `BOT_REPLY_MODE=ai` | — | ID del modelo. Elegilo de la [lista de modelos](https://developers.openai.com/api/docs/models). |
| `OPENAI_TIMEOUT_MS` | No | `20000` | Tiempo máximo de cada llamada a OpenAI. |
| `OPENAI_MAX_OUTPUT_TOKENS` | No | `300` | Tope de tokens por respuesta. |
| `AI_MAX_INTERACTIONS_PER_USER_PER_DAY` | No | `30` | Tope diario de respuestas con IA por usuario. |
| `AI_HISTORY_LIMIT` | No | `12` | Mensajes del historial que recibe el modelo. |

> **ChatGPT Plus no da acceso a la API.** La API se paga aparte: necesitás
> cargar crédito o un medio de pago en platform.openai.com (Billing).

**Cola de trabajos**

| Variable | Obligatoria | Default | Qué es |
| -------- | ----------- | ------- | ------ |
| `JOB_MAX_ATTEMPTS` | No | `4` | Intentos por mensaje entrante antes de darlo por fallido. |
| `WORKER_ENABLED` | No | `true` | `false` para levantar solo la API, sin procesar mensajes. |
| `QUEUE_POLL_INTERVAL_MS` | No | `1000` | Cada cuánto busca trabajos mientras hay trabajo. |
| `QUEUE_IDLE_POLL_INTERVAL_MS` | No | `600000` | Cuánto espera cuando la última vuelta no encontró trabajo (10 min), para que Neon pueda apagarse. Un mensaje nuevo despierta al worker enseguida, y un reintento pendiente lo despierta a su hora. |
| `QUEUE_CONCURRENCY` | No | `2` | Trabajos en paralelo (de conversaciones distintas). |
| `QUEUE_LEASE_MS` | No | `120000` | Tiempo que un trabajo queda reservado. Con `ai` debe superar el peor caso (la app lo valida al arrancar). |

**Administración**

| Variable | Obligatoria | Default | Qué es |
| -------- | ----------- | ------- | ------ |
| `ADMIN_API_KEY` | Sí | — | Clave de la [API de administración](#api-de-administración). Mínimo 32 caracteres. Generala con `openssl rand -hex 32`. |
| `PUBLIC_BASE_URL` | No | — | URL pública de esta API (por ejemplo `https://bottega-api.onrender.com`). Con ella el alta de una línea devuelve la URL completa del webhook. En Render no hace falta: se usa `RENDER_EXTERNAL_URL`, que Render define solo. |
| `TOKEN_ENCRYPTION_KEY` | Sí | — | Cifra las credenciales de Meta de cada línea guardadas en la base (AES-256-GCM). 32 bytes en base64: generala con `openssl rand -base64 32`. Usá una distinta por entorno y guardala bien: si se pierde o se cambia, las credenciales guardadas no se pueden leer. |

### 5. Migraciones

```bash
npm run prisma:migrate        # desarrollo: aplica las migraciones pendientes
npm run prisma:deploy         # producción: solo aplica, nunca crea
npx prisma migrate status     # estado (lee DATABASE_URL del .env)
```

Después de migrar, creá el negocio y la línea por defecto (BotSuite46, con el
número de `WHATSAPP_PHONE_NUMBER_ID`). El script es idempotente: se puede
correr las veces que quieras, y también asigna a esa línea las conversaciones
que todavía no tienen una.

```bash
npm run build
npm run seed:default-line
```

En Render corre solo en cada deploy, después de las migraciones.

### 6. Arrancar

```bash
npm run start:dev
curl localhost:3000/health        # {"status":"ok","db":"up"}
curl localhost:3000/health/live   # {"status":"ok"} (no consulta la base)
```

Si la base no responde (o tarda más de 3 s), `/health` devuelve `503`.
`/health/live` solo dice que el proceso está vivo: es el que usa Render.

### 7. Exponer con ngrok (alternativa para desarrollo local)

El camino principal es el [deploy en Render](#deploy-en-render--neon). Para
probar cambios locales contra Meta, ngrok da una URL **HTTPS pública**. En otra
terminal de WSL:

```bash
ngrok http 3000
```

Copiá la URL `https://….ngrok-free.app` (o similar) que muestra ngrok.

> En el plan gratuito **la URL cambia cada vez que reiniciás ngrok**. Cuando
> cambie, actualizala en Meta (paso 8).
> Alternativa: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## Deploy en Render + Neon

Un solo **Web Service** de Render corre la API y el worker de la cola. La base
es PostgreSQL en **Neon**. La configuración está en `render.yaml` (Blueprint).

### 1. Crear la base en Neon

1. En [console.neon.tech](https://console.neon.tech) creá un proyecto en la
   región **AWS US East 1 (N. Virginia)** (`aws-us-east-1`), la misma que el
   servicio de Render.
2. En **Connect**, copiá las dos URLs de la rama principal:
   - **Con pooler** (el host tiene `-pooler`) → `DATABASE_URL`. La usa la app.
   - **Directa** (sin `-pooler`) → `DATABASE_URL_UNPOOLED`. La usan las
     migraciones.
3. A las dos agregales `sslmode=require&connect_timeout=15`, por ejemplo
   `postgresql://usuario:clave@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&connect_timeout=15`.
   La compute de Neon se apaga sola cuando no hay tráfico y tarda unos segundos
   en despertar; sin `connect_timeout`, Prisma corta antes y da `P1001`.

> La app funciona detrás del pooler (PgBouncer en modo transacción): no usa
> `LISTEN/NOTIFY`, `SET` de sesión ni advisory locks, y la cola toma trabajos
> con una sola sentencia (`FOR UPDATE SKIP LOCKED`).

### 2. Crear el servicio en Render

1. En [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**,
   elegí este repositorio. Render lee `render.yaml`.
2. Completá las variables que pide (son las de `sync: false`): `DATABASE_URL`,
   `DATABASE_URL_UNPOOLED`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
   `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ADMIN_API_KEY`,
   `TOKEN_ENCRYPTION_KEY` y, solo
   para el modo IA, `OPENAI_API_KEY` y `OPENAI_MODEL`. Ver [tabla de
   variables](#4-configurar-el-env).
   - Usá un token de **System User** para `WHATSAPP_ACCESS_TOKEN`: el temporal
     de API Setup vence en horas.
   - El Blueprint arranca con `BOT_REPLY_MODE=echo`. Cambialo a `ai` desde
     **Environment** cuando el echo funcione.
3. **Primer deploy:** Render instala y compila (`npm ci --include=dev && npm
   run build`), aplica las migraciones (`npm run prisma:deploy`, con la URL
   directa), crea el negocio y la línea por defecto (`npm run
   seed:default-line`) y arranca (`npm run start:prod`). El health check es
   `/health/live`.
4. Probá: `curl https://<servicio>.onrender.com/health` →
   `{"status":"ok","db":"up"}`.

### 3. Apuntar el webhook de Meta a Render

En la app de Meta → **WhatsApp → Configuración**, poné como URL
`https://<servicio>.onrender.com/webhooks/whatsapp` y el mismo
`WHATSAPP_VERIFY_TOKEN` (ver [paso 8](#8-configurar-el-webhook)).

### Cómo se comporta en Render

- **Neon se apaga cuando no hay tráfico.** El worker no consulta la cola cada
  segundo: cuando no hay trabajo espera `QUEUE_IDLE_POLL_INTERVAL_MS`; un
  mensaje que entra lo despierta enseguida y un reintento lo despierta a su
  hora. El health check de Render (`/health/live`) no toca la base.
- **Deploys sin cortar respuestas.** En cada deploy Render manda `SIGTERM`: el
  worker deja de tomar trabajos y termina los que tiene en curso (hasta 120 s,
  `maxShutdownDelaySeconds`).
- **Solo se despliega lo que pasó el CI.** Render despliega cada commit de
  `main`, pero espera a que pasen los checks de GitHub (`autoDeployTrigger:
  checksPass`).
- **Las migraciones corren antes de arrancar.** Si fallan, el deploy se corta
  y queda andando la versión anterior.

---

## Conectar con WhatsApp (Meta)

Guía oficial: [Cloud API – Get started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
y [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks).

### 8. Configurar el webhook

En Meta for Developers → app **BotSuite** → **WhatsApp → Configuration**:

| Campo | Valor |
| ----- | ----- |
| Callback URL | `https://<servicio>.onrender.com/webhooks/whatsapp` (o `https://<tu-url-de-ngrok>/webhooks/whatsapp` en local) |
| Verify token | El mismo valor de `WHATSAPP_VERIFY_TOKEN` |

Tocá **Verify and save**. La app tiene que estar corriendo (en Render, o local
con ngrok activo).
En los logs vas a ver `Webhook verification accepted`.

**Una URL por línea.** Cada línea (un número de un negocio, con su propia app
de Meta) tiene su ruta: `https://<servicio>/webhooks/whatsapp/<webhookKey>`,
con su propio *verify token*. Bottega valida la firma con el *app secret* de
esa línea antes de guardar nada: una firma de otra app da `401` y una clave
desconocida da `404`. La ruta sin clave (`/webhooks/whatsapp`) queda para la
línea por defecto, con las variables de entorno de arriba. Un evento de otro
número que llega por la ruta de una línea se descarta con un aviso en los logs.

**Nada se pierde si falla el procesamiento.** Cada entrega firmada se guarda
tal cual llegó (`webhook_event`) antes de responder `200`, y se procesa en el
momento. Si el procesamiento falla (por ejemplo, la base no responde a mitad
de camino), el evento queda pendiente y se reintenta solo cada 30 s, hasta 10
intentos. Los reintentos corren en la instancia que tiene el worker
(`WORKER_ENABLED=true`). Solo si no se puede guardar el evento se responde `5xx` y Meta lo
reenvía.

### 9. Suscribir el campo `messages`

En la misma pantalla, en **Webhook fields**, suscribí **`messages`**. Sin esto
no llega ningún mensaje.

### 10. Probar con el número de prueba

1. En **WhatsApp → API Setup**, agregá tu número personal como destinatario
   (**To** → *Manage phone number list*) y verificalo con el código que te llega.
2. Desde ese WhatsApp, **escribile primero al número de prueba**. Eso abre la
   ventana de atención de 24 horas.
3. Fuera de esa ventana el bot no puede responder con texto libre (solo con
   plantillas aprobadas, que este proyecto no envía).

### 11. Validar primero el modo echo

Con `BOT_REPLY_MODE=echo`, mandá "hola". Respuesta esperada:

```text
Hola! Soy Bottega 🤖 Recibí tu mensaje: "hola"
```

Si llega, Meta → webhook → base → cola → envío funcionan.

### 12. Pasar al modo IA

En el `.env`: `BOT_REPLY_MODE=ai`, `OPENAI_API_KEY` y `OPENAI_MODEL`.
Reiniciá la app (`Ctrl+C` y `npm run start:dev`).

Guion de prueba:

| # | Escribís | Esperado |
| - | -------- | -------- |
| 1 | `hola` | Saludo del asistente de Bottega. |
| 2 | `demo` | Entra a la demo de la barbería ficticia, con aviso de que es ficticia. |
| 3 | `¿cuánto sale un corte?` | Precio tomado de `content/demos/barbershop.json`. |
| 4 | Pedí un turno (nombre, servicio, día, hora) | Resumen de la solicitud, marcada como **ficticia**. |
| 5 | `salir` | Vuelve al asistente de Bottega. |
| 6 | `reiniciar` | Empieza la charla de cero (los datos del lead se conservan). |
| 7 | `humano` | Aviso de que una persona va a responder; el bot queda en pausa. |
| 8 | Cualquier mensaje | Sin respuesta (pausado). |
| 9 | `POST /admin/conversations/<id>/resume` | El siguiente mensaje vuelve a tener respuesta. |

---

## Cómo se comporta el bot

### Comandos

El mensaje tiene que ser **solo** el comando (no importan mayúsculas, tildes
ni signos alrededor).

| Comando | Efecto |
| ------- | ------ |
| `demo` / `probar demo` | Entra a la demo (contexto nuevo). |
| `salir` / `salir de la demo` | Sale de la demo y vuelve al modo comercial. |
| `reiniciar` | Empieza de cero en el modo actual. No borra nada: cierra el contexto y abre otro. Los datos del lead se conservan. |
| `humano` / `hablar con una persona` | Pausa el bot y abre un pedido de atención (*handoff*). |

### Modos y contextos

- **Comercial:** habla de Bottega usando `content/commercial-info.md` y puede
  guardar datos del prospecto (lead).
- **Demo:** atiende como la barbería ficticia. Lo que se registra ahí es
  ficticio y nunca se mezcla con el lead.
- Cada modo tiene su propio historial: lo dicho en la demo no aparece en el
  comercial, y viceversa.

### Pausa

Mientras una conversación está pausada (por `humano` o por un admin):

- Los mensajes se **guardan pero no se responden**, incluidos los comandos.
- Al reanudar, esos mensajes **no** se responden retroactivamente; el bot
  contesta desde el siguiente mensaje.
- Una persona puede responder con la API de administración.

---

## API de administración

Todas las rutas requieren la clave en `X-Admin-Api-Key: <clave>` o
`Authorization: Bearer <clave>`. Sin clave o con una incorrecta: `401`.

Preparación (la clave se lee del `.env`, no se escribe en la terminal):

```bash
export ADMIN_API_KEY="$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2-)"
API=http://localhost:3000
H="X-Admin-Api-Key: $ADMIN_API_KEY"
```

| Método y ruta | Qué hace |
| ------------- | -------- |
| `GET /admin/leads?status=&limit=` | Leads, más nuevos primero. `status`: `NEW`, `CONTACTED`, `QUALIFIED`, `DISCARDED`. |
| `GET /admin/handoffs?status=&limit=` | Pedidos de atención. `status`: `OPEN` o `RESOLVED`. |
| `GET /admin/conversations/<id>?limit=` | Conversación, ventana de 24 h, lead, handoffs abiertos y últimos mensajes. |
| `GET /admin/conversations/by-wa/<wa-id>?limit=` | Lo mismo, buscando por número (solo dígitos, ej. `5491112345678`). |
| `GET /admin/messages?status=&limit=` | Envíos que necesitan revisión: `UNCERTAIN` o `FAILED` (ambos si no se indica). |
| `POST /admin/conversations/<id>/pause` | Pausa el bot. Abre un handoff (motivo `admin`) solo si no hay uno abierto. Repetirlo no cambia nada. |
| `POST /admin/conversations/<id>/resume` | Reanuda el bot. Por defecto resuelve los handoffs abiertos. Repetirlo no cambia nada. |
| `POST /admin/conversations/<id>/messages` | Envía una respuesta escrita por una persona. |

`limit` va de 1 a 200 (default 50). Errores: `400` parámetros inválidos,
`404` conversación inexistente.

**Ejemplos**

```bash
curl -s -H "$H" "$API/admin/leads?status=NEW&limit=20"
curl -s -H "$H" "$API/admin/handoffs?status=OPEN"
curl -s -H "$H" "$API/admin/conversations/<conversation-id>?limit=100"
curl -s -H "$H" "$API/admin/conversations/by-wa/<wa-id>"
curl -s -H "$H" "$API/admin/messages?status=UNCERTAIN"

curl -s -X POST -H "$H" "$API/admin/conversations/<conversation-id>/pause"

# Reanudar resolviendo handoffs (default) o dejándolos abiertos
curl -s -X POST -H "$H" "$API/admin/conversations/<conversation-id>/resume"
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"resolveHandoffs": false}' \
  "$API/admin/conversations/<conversation-id>/resume"
```

### Responder como persona

```bash
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"text": "Hola, soy del equipo de Bottega. ¿En qué te ayudo?"}' \
  "$API/admin/conversations/<conversation-id>/messages"
```

- Solo funciona **dentro de la ventana de 24 h** (el usuario escribió en las
  últimas 24 horas). Si no, responde `409`: fuera de la ventana WhatsApp exige
  plantillas aprobadas y esta API no las envía.
- Texto de 1 a 4096 caracteres. **No reanuda el bot**: para eso, usá `resume`.
- `Idempotency-Key` (opcional): si repetís el mismo pedido con la misma clave,
  no se envía de nuevo y la respuesta es `"outcome": "replayed"`.

| Resultado (`outcome`) | HTTP | Significado |
| --------------------- | ---- | ----------- |
| `sent` | 200 | Meta lo aceptó (`waMessageId`). |
| `replayed` | 200 | Ya se había procesado con esa `Idempotency-Key`. |
| `uncertain` | 202 | No se sabe si Meta lo recibió. **No se reenvía automáticamente**: revisá el chat antes de mandarlo de nuevo. |
| `rejected` | 502 | Meta lo rechazó (`code`, `detail`). Queda como `FAILED`. |

### Dar de alta un negocio y su línea

Cada negocio tiene **su propia app de Meta**, dentro de su propio portfolio.
Primero se crea el negocio y después su línea, con los datos de esa app:

```bash
curl -X POST "$API/admin/businesses" -H "X-Admin-Api-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Peluquería Ana","slug":"peluqueria-ana","botName":"Ana, IA de Peluquería Ana"}'
# → 201 {"id":"<businessId>", ...}

curl -X POST "$API/admin/businesses/<businessId>/lines" -H "X-Admin-Api-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumberId":"...","wabaId":"...","appId":"...","appSecret":"...","accessToken":"..."}'
```

| Campo | De dónde sale |
| ----- | ------------- |
| `phoneNumberId` | WhatsApp → API Setup: el **ID** del número. |
| `wabaId` | El ID de la cuenta de WhatsApp Business (en API Setup). |
| `appId` / `appSecret` | App settings → Basic de la app de Meta del negocio. |
| `accessToken` | Token del **System User** del negocio, con `whatsapp_business_messaging` y `whatsapp_business_management`. |
| `displayPhone` | Opcional: el número para mostrar. |

La respuesta (`201`) trae lo que hay que pegar en la app de Meta del negocio
(WhatsApp → Configuración): `webhookUrl` y `verifyToken`. Además, Bottega
suscribe la app a la cuenta de WhatsApp (`subscription.subscribed`). Si la
suscripción falla, la línea queda creada igual y el motivo viene en
`subscription`; se puede suscribir a mano desde el dashboard de la app.

El `appSecret` y el `accessToken` se guardan cifrados y **nunca** se devuelven.
Un slug o un `phoneNumberId` repetidos dan `409`; un negocio que no existe, `404`.

---

## Editar contenido

| Archivo | Para qué |
| ------- | -------- |
| `content/commercial-info.md` | Lo que el bot sabe de Bottega (modo comercial). Donde dice `[COMPLETAR]`, el bot responde que el equipo lo confirma. |
| `content/demos/barbershop.json` | Datos de la barbería ficticia: servicios, precios, horarios, preguntas frecuentes. |

- Después de editar, **reiniciá la app**.
- Los archivos se validan al arrancar: si hay un error, la app no inicia y
  dice qué archivo y qué campo falla. Detalle en `content/README.md`.
- No pongas secretos, datos personales ni datos comerciales inventados.

---

## Pruebas automáticas

Las pruebas usan **simulaciones (mocks) de Meta y OpenAI**: no envían
mensajes reales ni consumen créditos.

| Comando | Qué prueba | Necesita |
| ------- | ---------- | -------- |
| `npm test` | Unitarias | Nada |
| `npm run test:e2e` | HTTP (webhook, admin, health) | Nada |
| `npm run test:int` | Integración con Postgres real | `npm run db:up`. Usa la base `bottega_test` (la crea sola y la vacía en cada test). |
| `npm run lint` | ESLint | — |
| `npm run build` | Compila a `dist/` | — |

En GitHub, el workflow `.github/workflows/ci.yml` corre lint, las tres suites
(con un Postgres propio) y el build en cada PR a `develop` o `main` y en cada
push a esas ramas.

---

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
| ------- | -------------- | --------- |
| Webhook responde `401` | `META_APP_SECRET` incorrecto, un proxy modifica el cuerpo, o los eventos vienen de otra app. | Copiá de nuevo el App secret (App settings → Basic) de **BotSuite** y reiniciá. |
| "Verify and save" falla | Token distinto, URL sin HTTPS o inaccesible, ruta incorrecta. | Mismo valor que `WHATSAPP_VERIFY_TOKEN`; URL terminada en `/webhooks/whatsapp`; app y ngrok corriendo. |
| Envíos fallan con código `190` | Access token vencido o inválido. | Regenerá el token en API Setup (o usá uno de System User) y reiniciá. |
| Envíos fallan con "recipient not in allowed list" | El destinatario no está autorizado en el número de prueba. Suele reportarse como `131030` (verificalo en la [doc de códigos de error](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)). | Agregá y verificá el número en API Setup. |
| Envíos fallan con `131047` | Fuera de la ventana de 24 h. | El usuario tiene que escribir primero. |
| No llegan eventos | Campo `messages` sin suscribir; la URL de ngrok cambió; la app no está suscripta a la cuenta de WhatsApp Business; límites de la app en modo desarrollo. | Revisá Configuration en Meta. |
| Llegan eventos pero se ignoran | `WHATSAPP_PHONE_NUMBER_ID` no coincide con el número que recibe. | Copiá el ID correcto de API Setup. |
| El usuario no recibió una respuesta | Envío `UNCERTAIN` o `FAILED`. | `GET /admin/messages?status=UNCERTAIN` (o `FAILED`). Los inciertos nunca se reenvían solos. |
| El bot responde "Tuve un problema para responderte" | Error de OpenAI: sin crédito/cuota (`429`), modelo inválido, timeout. | Revisá Billing en platform.openai.com, `OPENAI_MODEL` y los logs. |
| El bot responde "llegamos al límite" | Se alcanzó `AI_MAX_INTERACTIONS_PER_USER_PER_DAY`. | Esperá al día siguiente o subí el tope. |
| `prisma migrate status` falla | Falta `DATABASE_URL`. | Corré desde la raíz del proyecto, con el `.env` completo. |
| Prisma da `P1001` con Neon | La compute estaba apagada y tardó en despertar. | Agregá `connect_timeout=15` (y `sslmode=require`) a las dos URLs. |
| El deploy en Render falla al migrar | Falta `DATABASE_URL_UNPOOLED` o apunta al pooler. | Usá la URL **directa** de Neon (sin `-pooler`). |
| `docker` no existe en WSL | Falta la integración con WSL. | Docker Desktop → Settings → Resources → WSL integration → activá tu distro. |
| La app no arranca | Variable faltante o inválida, o contenido inválido. | El error dice qué variable o archivo falla. |

---

## Arquitectura

Monolito modular en NestJS: `whatsapp`, `conversations`, `queue`, `bot`, `ai`,
`leads`, `demos`, `content`, `admin`, `health`.

```text
Meta ──POST──▶ /webhooks/whatsapp[/<webhookKey>] ──▶ valida firma de la línea ──▶ guarda evento crudo ──▶ 200
                                                  └─▶ procesa: contacto + conversación por línea + mensaje + trabajo
                                                      (si falla, queda pendiente y se reintenta)
                                                              │
                         (cola en PostgreSQL, en orden por conversación)
                                                              ▼
                                   worker ──▶ ¿pausada? ── sí ──▶ solo guarda
                                      │
                                      ├─ comando ──▶ transición (modo / contexto / pausa)
                                      └─ texto ────▶ IA (o echo) + herramientas validadas
                                      ▼
                         respuestas guardadas como QUEUED ──▶ envío a Meta
```

| Decisión | Por qué |
| -------- | ------- |
| Se responde a Meta después de guardar, y se contesta desde un worker. | Meta no reintenta de más y una caída no pierde mensajes. Los duplicados se descartan por id. |
| Envío "como máximo una vez". | Si no se sabe si Meta recibió un mensaje (`UNCERTAIN`), no se reenvía: mejor uno perdido y visible que uno duplicado. |
| Contextos por modo. | El historial de la demo y el comercial nunca se mezclan; nada se borra. |
| Solo los comandos cambian modo o pausa. | El texto del modelo nunca dispara transiciones. |

---

## Antes de producción

Este proyecto está listo para probar con el número de prueba de Meta. Para
atender clientes reales falta:

**WhatsApp y Meta**

- [ ] Número propio registrado y nombre visible (*display name*) aprobado.
- [ ] Verificación del negocio (Business verification).
- [ ] Token durable de System User y manejo de secretos (no en archivos sueltos).
- [ ] Revisión de la app y permisos; pasar la app a modo Live.
- [ ] Plantillas aprobadas para escribir fuera de la ventana de 24 h.
- [ ] Opt-in de los usuarios y política de privacidad publicada.

**Infraestructura**

- [x] Hosting con HTTPS estable (Render) y Postgres administrado (Neon), ver
      [Deploy en Render + Neon](#deploy-en-render--neon).
- [ ] Dominio propio.
- [ ] Revisar la retención de backups de Neon para el plan elegido.
- [ ] Monitoreo y alertas (handoffs abiertos, envíos `UNCERTAIN`/`FAILED`, errores de IA).
- [ ] Límites de tasa en la API pública y en la de administración.

**Costos y operación**

- [ ] Costos de Meta: ver [precios oficiales](https://developers.facebook.com/docs/whatsapp/pricing).
- [ ] Costos de OpenAI por uso, y de hosting.
- [ ] Quién responde los handoffs y en qué horario.

**Riesgo conocido**

- [ ] El ciclo de herramientas de la IA no se probó todavía con un modelo de
      razonamiento real (los *reasoning items* de la Responses API). Probarlo
      antes de elegir uno de esos modelos.

---

## Referencias

- WhatsApp Cloud API: [Get started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started) · [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks) · [Códigos de error](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes) · [Precios](https://developers.facebook.com/docs/whatsapp/pricing)
- [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog)
- [Modelos de OpenAI](https://developers.openai.com/api/docs/models)
- [Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate) · [NestJS](https://docs.nestjs.com)
