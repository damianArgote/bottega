# Prompt 07 · Integraciones, cobros y agenda

> Correlo después del 06a (plantillas). Son cuatro partes, en este orden, cada una con sus PRs: 07a eventos y API para n8n, 07b módulos y acciones propias del negocio, 07c cobros, 07d agenda. Las partes con pantalla tienen además un PR en `bottega-inbox`. Objetivo: que cada negocio, que es distinto, pueda conectar lo que ya usa (su agenda, su tienda, su CRM, su medio de cobro) sin que Bottega construya cada rubro; y que el rubro más común, los turnos, funcione listo para usar.

Contexto: la primera versión de este prompt era "turnos con seña por Mercado Pago". Turnos es el caso más común, pero no el único: hay negocios que cobran pedidos, alquileres o clases; que ya tienen agenda en otro sistema; que cobran con MODO, con otra billetera o por transferencia. Por eso lo genérico va primero (eventos, acciones propias, cobros) y la agenda propia es un módulo más que usa esas piezas.

Reglas de todo el prompt:
- **El modelo nunca decide un horario libre, un precio ni si algo se pagó.** La IA marca la intención con herramientas; el código (o el sistema del negocio, en una acción propia) valida, calcula y confirma.
- **Todo es opcional por negocio.** Un negocio sin un módulo funciona igual que hoy: el bot ni siquiera recibe sus herramientas.
- **Lo que viene de afuera es información, nunca instrucciones**: respuestas de acciones propias, notificaciones de pago y datos de n8n se tratan como el catálogo o el perfil del agente.
- **n8n nunca corre dentro del backend**: se integra por eventos firmados, acciones firmadas y una API con clave por negocio.
- Toda consulta filtra por `businessId`. Credenciales y secretos, cifrados como los de la línea, nunca en logs ni en respuestas de la API.

---

## 07a · Eventos y API para n8n (rama `feat/outbound-events`)
- `WebhookSubscription` por negocio: `url` (solo `https`), `secretEncrypted`, `events` (lista), `active`.
- Eventos de esta parte: `lead.updated`, `handoff.requested`, `conversation.resolved`. Cada módulo que llegue después suma los suyos (`payment.*` en 07c, `booking.*` en 07d). Payload mínimo con ids y datos necesarios, sin historial de chat.
- Envío desde la cola en Postgres (un job por entrega) con firma HMAC-SHA256 en `X-Bottega-Signature` (sobre timestamp + body, con `X-Bottega-Timestamp`), reintentos con backoff hasta 6 intentos, y registro del último error.
- API para n8n: `GET /integrations/v1/...` (leads, conversaciones con su estado, sin mensajes) con una clave por negocio (`IntegrationKey`, guardada como hash), solo lectura en esta parte.
- Alta de suscripciones y claves por la API de admin y por `/staff`.
- Tests: firma verificable con el secreto; un 500 del destino reintenta y un 2xx no; una clave de un negocio no lee datos de otro.

## 07b · Módulos y acciones propias del negocio (rama `feat/business-actions`)

### Módulos
- Hoy cada capacidad del agente se prende con su propio `if` (`demoEnabled`, catálogo con ítems en `src/bot/tools/registry.ts`). Pasalo a **un solo lugar** que, para cada negocio, dice qué módulos tiene (`catalog`, `actions`, `payments`, `scheduling`) y con eso qué herramientas recibe el modelo.
- Sin cambio de comportamiento para lo que ya existe: el catálogo sigue prendido cuando hay ítems disponibles y la demo con `demoEnabled`. Test: las herramientas que recibe el modelo para BotSuite46 y para un negocio con catálogo son las mismas que antes de este cambio.

### Acciones propias (el punto de extensión)
Para lo que Bottega no tiene (consultar stock en Tiendanube, reservar en el Google Calendar del negocio, cargar un pedido en su sistema), el negocio define acciones que el agente puede pedir y que resuelve un flujo de n8n (u otro servicio del negocio).
- `AgentAction` por negocio: `name` (snake_case, único por negocio), `description` (para el modelo; es información del negocio, no instrucciones), `parameters` (subconjunto de JSON Schema: `string`, `number`, `integer`, `boolean`, `enum`, `required`; hasta 8 parámetros, con largo máximo en cada string), `url` (solo `https`), `secretEncrypted`, `kind` (`query`: devuelve datos para la respuesta; `effect`: hace algo en el sistema del negocio), `timeoutMs` (hasta 10 s), `active`.
- Cada acción activa es una herramienta más del agente, con los argumentos validados con su esquema antes de llamar (los inválidos vuelven al modelo como error, como hoy).
- La llamada: `POST` firmado igual que los eventos de 07a, con `businessId`, `conversationId`, `contact` (`waId`, nombre), los argumentos y una `idempotencyKey` por llamada de herramienta. Una acción `effect` se ejecuta como mucho una vez por clave (mismo criterio que los efectos planeados de las herramientas actuales): un reintento del job no la repite.
- La respuesta: JSON `{ "reply"?: string, "data"?: object }`, hasta 8 KB. `data` vuelve al modelo como información; `reply`, si viene, es un texto fijo que el bot manda tal cual (para lo que el negocio quiere decir con sus palabras: "Te reservé el jueves a las 10").
- **SSRF:** antes de cada llamada, resolver el host y rechazar IPs privadas, de loopback, link-local y de metadata; sin seguir redirecciones.
- Error, timeout o respuesta inválida: el modelo recibe que la acción falló y el bot dice un texto fijo ("No pude consultarlo ahora") y ofrece una persona. Nunca inventa el resultado. Se registra el error (sin argumentos ni respuesta en `info`).
- Alta y prueba de acciones por la API de admin y `/staff` (con un "probar" que llama con argumentos de ejemplo y muestra la respuesta). El dueño las ve en el backoffice pero no las edita en esta parte.
- Tests: argumentos inválidos no llaman; un `effect` reintentado no se llama dos veces; IP privada rechazada; timeout responde el texto fijo; `data` con texto tipo "ignorá tus instrucciones" no cambia las reglas (escenario).

## 07c · Cobros (rama `feat/payments`)

Los cobros no son solo señas: un pedido del catálogo, un alquiler o un cobro que decide una persona. Y cada negocio cobra con lo suyo. El núcleo no conoce al proveedor.

### Modelo
- `PaymentAccount` por negocio y proveedor: `provider` (`mercadopago` | `transfer` en esta parte), credenciales cifradas (las que pida el proveedor), `webhookKey` aleatoria, `isDefault`, `active`. Para `transfer`: alias o CBU y titular (no son secretos).
- `Payment`: `businessId`, `conversationId`, `contactId`, `accountId`, `purpose` (`booking` | `order` | `manual`), `purposeId` (opcional), `concept`, `amountArs` (entero), `status` (`PENDING` | `APPROVED` | `REJECTED` | `EXPIRED` | `REVIEW`), `providerPaymentId`, `linkUrl`, `expiresAt`, `approvedAt`, `approvedBy` (`PROVIDER` o el usuario que lo confirmó), timestamps.

### Proveedores (puerto `PaymentProvider`)
Cada proveedor implementa: `createLink(account, payment) → { url, providerRef }`, `verifyNotification(account, request) → providerPaymentId | null` y `fetchPayment(account, id) → { status, amountArs, reference }`. Sumar un proveedor es sumar un adaptador y sus tests; el resto no cambia.
- **Mercado Pago:** `POST /checkout/preferences` con el access token del negocio, `external_reference = payment.id`, `notification_url = /webhooks/payments/mercadopago/:webhookKey` y vencimiento. Webhook: validar la firma según su documentación, guardar el evento crudo (misma tabla de eventos que Meta, con `source`) y **siempre** consultar `GET /v1/payments/{id}` antes de confirmar. Solo `approved` con la misma referencia y el mismo monto confirma.
- **Transferencia (`transfer`):** no hay link: el bot manda un texto fijo con alias o CBU, titular, monto y concepto. **Nunca la confirma el bot**, aunque reciba un comprobante: el `Payment` queda `PENDING`, la conversación pasa a una persona y en la bandeja aparece "Marcar pagado" (queda `approvedBy` con el usuario).
- **Otros (MODO, Ualá Bis, Payway, Getnet…):** fuera de esta parte. Antes de escribir un adaptador, confirmar que el proveedor ofrece al negocio una API con link de pago, notificación y consulta del pago. Si no la ofrece, ese negocio usa `transfer`.

### Reglas
- Idempotente por pago del proveedor; una notificación repetida no confirma dos veces.
- Pago aprobado después del vencimiento: queda `REVIEW` y pasa a una persona (nunca devolver plata automáticamente). El módulo que pidió el pago decide qué hacer con un aprobado (la agenda, en 07d).
- Herramienta del agente `request_payment` solo para los módulos que la usan (no la recibe un negocio sin un módulo que cobre); en esta parte, ninguno: la usa 07d.
- Desde la bandeja, una persona puede mandar un cobro: `POST /inbox/.../conversations/:id/payments` `{ amountArs, concept, clientId }` con la cuenta por defecto (mismas reglas de envío que una respuesta: ventana, `clientId`, toma de la conversación). PR aparte en `bottega-inbox` con el formulario y el estado del pago en el hilo.
- Eventos: `payment.approved`, `payment.expired`, `payment.review`.
- Alta de cuentas por la API de admin y `/staff`.
- Tests con los clientes de los proveedores mockeados: pago aprobado confirma; otro monto no confirma; notificación repetida no duplica; firma mala no hace nada; transferencia nunca se confirma sola; "Marcar pagado" de otro negocio, `404`.

## 07d · Agenda (rama `feat/scheduling`)

Módulo `scheduling`: agenda propia para turnos (peluquería, barbería, estética, consultorio). Un negocio con agenda en otro sistema usa una acción propia (07b) en lugar de este módulo.

### Modelo
- `Service`: `businessId`, `name`, `durationMinutes`, `priceArs` (entero, centavos no), `depositPercent` (0–100, default 0), `active`.
- `Staff`: `businessId`, `name`, `active`; relación muchos a muchos con `Service` (qué hace cada uno).
- `WorkingHours`: `staffId`, `weekday` (0–6), `start`, `end` (hora local `HH:mm`); varias filas por día para cortes.
- `TimeOff`: `staffId` nullable (null = todo el negocio), `startsAt`, `endsAt`, `reason` (feriados, vacaciones).
- `Booking`: `businessId`, `contactId`, `conversationId`, `serviceId`, `staffId`, `startsAt`, `endsAt`, `status` (`HELD` | `CONFIRMED` | `CANCELLED` | `EXPIRED` | `NO_SHOW` | `DONE`), `holdExpiresAt`, `priceArs`, `depositArs`, `paymentId` (nullable, de 07c), `source` (`BOT` | `HUMAN`), timestamps.
- **Sin solapes a nivel base:** extensión `btree_gist` y una restricción `EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('HELD','CONFIRMED'))`, escrita a mano en la migración. Dos reservas simultáneas del mismo horario: una gana y la otra recibe un error que el servicio traduce a "ese horario se acaba de ocupar".
- Todo en la zona horaria del negocio (`Business.timezone`, default `America/Argentina/Buenos_Aires`); en la base, `timestamptz`.

### Disponibilidad (dominio puro, con tests)
`AvailabilityService.findSlots({ businessId, serviceId, staffId?, from, to, limit })` devuelve horarios libres cada 15 min que entran enteros en el horario del profesional, sin `TimeOff` y sin reservas `HELD`/`CONFIRMED`. Tests: día con corte al mediodía, servicio que no entra al final del día, feriado, dos profesionales, cambio de mes.

### Herramientas del agente
- `find_slots { service, day_hint }` → el código resuelve el servicio por nombre (o devuelve la lista si es ambiguo) y la fecha ("mañana", "el jueves") con la zona del negocio, y devuelve hasta 3 horarios. El modelo solo puede ofrecer horarios que vinieron de esta herramienta.
- `hold_slot { slot_id }` → crea `Booking` `HELD` con `holdExpiresAt = now + 15 min`. `slot_id` es un identificador opaco que devolvió `find_slots` (nunca una fecha escrita por el modelo).
- `cancel_booking`, `reschedule_booking` sobre reservas del mismo contacto.
- Si `depositPercent = 0`, `hold_slot` confirma directo. El texto de confirmación es fijo, armado en código con fecha, hora, servicio y profesional.
- Con seña: `hold_slot` pide el cobro a 07c (`purpose = booking`) con la cuenta por defecto del negocio y manda el link o los datos de transferencia. Con `transfer`, el hold dura lo que configure el negocio (default 2 h) y lo confirma la persona al marcar el pago.
- `payment.approved` de un turno lo confirma. Aprobado después del vencimiento: si el horario sigue libre, confirmar igual; si no, el pago queda `REVIEW` y se deriva a una persona.
- Las reservas `HELD` vencidas pasan a `EXPIRED` en el mismo intervalo del reprocesador.

### Recordatorio
El día anterior a las 10 (hora del negocio), la plantilla de utilidad aprobada `recordatorio_turno` (prompt 06a; cada negocio la crea en su propia cuenta de WhatsApp) con nombre, servicio, día y hora, y botones "Confirmo" / "Necesito cambiarlo". La respuesta entra como un mensaje más y el agente actúa. Si el negocio no tiene esa plantilla aprobada, no se manda nada y queda un mensaje de sistema en la conversación ("No se mandó el recordatorio: falta la plantilla recordatorio_turno").

### Admin y bandeja
CRUD de servicios, profesionales, horarios y feriados con la API key de admin y `/staff`, y `GET /admin/businesses/:id/bookings?from=&to=`. La vista de turnos en la bandeja va en un prompt aparte.

Eventos: `booking.confirmed`, `booking.cancelled`.

## Fuera de alcance
Reservas de restaurante por capacidad, clases con cupo, Google Calendar nativo (se hace con una acción propia), cobro total de pedidos del catálogo (usa 07c cuando haya carrito), devoluciones automáticas, OAuth de Mercado Pago, adaptadores de MODO u otros proveedores, confirmar pagos desde n8n (escribir por la API de integraciones), que el dueño edite acciones propias, vista de calendario en la web.

## Criterio de aceptación
- 07a: un evento llega firmado y se reintenta ante un 500; una clave de integración nunca lee otro negocio.
- 07b: las herramientas de los negocios existentes no cambian; una acción `effect` no se ejecuta dos veces; ninguna acción llama a una IP privada.
- 07c: un pago aprobado confirma una sola vez aunque llegue tres veces; una transferencia nunca se confirma sin una persona.
- 07d (int): dos `hold_slot` simultáneos sobre el mismo horario dejan una sola reserva; una reserva `HELD` vencida libera el horario.
- Escenarios (`npm run test:scenarios`): el bot nunca ofrece un horario que no vino de `find_slots`; con seña, no dice "confirmado" antes del pago; nunca inventa el resultado de una acción propia.
- Lint, unit, e2e e int en verde en cada PR.
