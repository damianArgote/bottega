# bottega-api

Backend del bot comercial de WhatsApp de Bottega y de sus demos interactivas.
Atiende prospectos, toma sus datos, muestra una demo (una barbería ficticia) y
deriva a una persona del equipo cuando hace falta. Usa la **API oficial de
WhatsApp Cloud** (sin BuilderBot ni librerías por QR), OpenAI y PostgreSQL.

> **Alcance:** es un bot propio + una demo. No es una plataforma: no hay
> frontend, editor de flujos, multi-cliente ni facturación.

## Índice

| Paso | Sección |
| ---- | ------- |
| 1–7 | [Puesta en marcha local](#puesta-en-marcha-local) |
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
| ngrok | Cuenta gratuita y el CLI instalado en WSL. [Guía](https://ngrok.com/docs/getting-started/). |
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
| `DATABASE_URL` | Sí | — | Conexión a Postgres. Con Docker local: `postgresql://bottega:bottega@localhost:5432/bottega` |
| `PORT` | No | `3000` | Puerto HTTP. |
| `NODE_ENV` | No | `development` | `development`, `test` o `production`. |

**WhatsApp / Meta**

| Variable | Obligatoria | Default | Qué es y dónde se consigue |
| -------- | ----------- | ------- | -------------------------- |
| `META_APP_SECRET` | Sí | — | Secreto de la app. Meta for Developers → tu app → **App settings → Basic → App secret**. Se usa para validar la firma de cada webhook. |
| `WHATSAPP_VERIFY_TOKEN` | Sí | — | Un texto **que inventás vos** (por ejemplo `openssl rand -hex 16`). Lo vas a pegar también en Meta al configurar el webhook. **No es el access token.** |
| `WHATSAPP_ACCESS_TOKEN` | Sí | — | Token para enviar mensajes. WhatsApp → **API Setup** → token temporal. **Vence en unas horas** y hay que regenerarlo. Para algo durable: token de un **System User** (Business Settings), con la expiración que elijas. |
| `WHATSAPP_PHONE_NUMBER_ID` | Sí | — | El **ID** del número (WhatsApp → API Setup). **No es el número de teléfono.** |
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
| `QUEUE_POLL_INTERVAL_MS` | No | `1000` | Cada cuánto busca trabajos nuevos. |
| `QUEUE_CONCURRENCY` | No | `2` | Trabajos en paralelo (de conversaciones distintas). |
| `QUEUE_LEASE_MS` | No | `120000` | Tiempo que un trabajo queda reservado. Con `ai` debe superar el peor caso (la app lo valida al arrancar). |

**Administración**

| Variable | Obligatoria | Default | Qué es |
| -------- | ----------- | ------- | ------ |
| `ADMIN_API_KEY` | Sí | — | Clave de la [API de administración](#api-de-administración). Mínimo 32 caracteres. Generala con `openssl rand -hex 32`. |

### 5. Migraciones

```bash
npm run prisma:migrate        # desarrollo: aplica las migraciones pendientes
npm run prisma:deploy         # producción: solo aplica, nunca crea
npx prisma migrate status     # estado (lee DATABASE_URL del .env)
```

### 6. Arrancar

```bash
npm run start:dev
curl localhost:3000/health    # {"status":"ok","db":"up"}
```

Si la base no responde, `/health` devuelve `503`.

### 7. Exponer con ngrok

Meta necesita una URL **HTTPS pública**. En otra terminal de WSL:

```bash
ngrok http 3000
```

Copiá la URL `https://….ngrok-free.app` (o similar) que muestra ngrok.

> En el plan gratuito **la URL cambia cada vez que reiniciás ngrok**. Cuando
> cambie, actualizala en Meta (paso 8).
> Alternativa: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## Conectar con WhatsApp (Meta)

Guía oficial: [Cloud API – Get started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
y [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks).

### 8. Configurar el webhook

En Meta for Developers → app **BotSuite** → **WhatsApp → Configuration**:

| Campo | Valor |
| ----- | ----- |
| Callback URL | `https://<tu-url-de-ngrok>/webhooks/whatsapp` |
| Verify token | El mismo valor de `WHATSAPP_VERIFY_TOKEN` |

Tocá **Verify and save**. La app tiene que estar corriendo y ngrok activo.
En los logs vas a ver `Webhook verification accepted`.

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
| `docker` no existe en WSL | Falta la integración con WSL. | Docker Desktop → Settings → Resources → WSL integration → activá tu distro. |
| La app no arranca | Variable faltante o inválida, o contenido inválido. | El error dice qué variable o archivo falla. |

---

## Arquitectura

Monolito modular en NestJS: `whatsapp`, `conversations`, `queue`, `bot`, `ai`,
`leads`, `demos`, `content`, `admin`, `health`.

```text
Meta ──POST──▶ /webhooks/whatsapp ──▶ valida firma ──▶ guarda mensaje + trabajo ──▶ 200
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

- [ ] Dominio HTTPS estable y hosting (en lugar de ngrok).
- [ ] Postgres administrado con backups.
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
