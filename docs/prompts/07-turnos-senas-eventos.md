# Prompt 07 · Turnos con seña por Mercado Pago y eventos para n8n

> Correlo después de la primera etapa (00 a 05b), salvo que un cliente pague turnos antes: en ese caso puede ir después del 02b. Objetivo: que el agente agende turnos (peluquería, barbería, estética, consultorio) y cobre una seña, y que Bottega avise a n8n de cada evento. Son tres PRs: 07a, 07b y 07c.

Regla de todo el prompt: **el modelo nunca decide un horario libre, un precio ni si algo se pagó.** La IA marca la intención con herramientas; el código valida, calcula y confirma.

---

## 07a · Agenda propia (rama `feat/scheduling`)

### Modelo
- `Service`: `businessId`, `name`, `durationMinutes`, `priceArs` (entero, centavos no), `depositPercent` (0–100, default 0), `active`.
- `Staff`: `businessId`, `name`, `active`; relación muchos a muchos con `Service` (qué hace cada uno).
- `WorkingHours`: `staffId`, `weekday` (0–6), `start`, `end` (hora local `HH:mm`); varias filas por día para cortes.
- `TimeOff`: `staffId` nullable (null = todo el negocio), `startsAt`, `endsAt`, `reason` (feriados, vacaciones).
- `Booking`: `businessId`, `contactId`, `conversationId`, `serviceId`, `staffId`, `startsAt`, `endsAt`, `status` (`HELD` | `CONFIRMED` | `CANCELLED` | `EXPIRED` | `NO_SHOW` | `DONE`), `holdExpiresAt`, `priceArs`, `depositArs`, `source` (`BOT` | `HUMAN`), timestamps.
- **Sin solapes a nivel base:** extensión `btree_gist` y una restricción `EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('HELD','CONFIRMED'))`, escrita a mano en la migración. Dos reservas simultáneas del mismo horario: una gana y la otra recibe un error que el servicio traduce a "ese horario se acaba de ocupar".
- Todo en la zona horaria del negocio (`Business.timezone`, default `America/Argentina/Buenos_Aires`); en la base, `timestamptz`.

### Disponibilidad (dominio puro, con tests)
`AvailabilityService.findSlots({ businessId, serviceId, staffId?, from, to, limit })` devuelve horarios libres cada 15 min que entran enteros en el horario del profesional, sin `TimeOff` y sin reservas `HELD`/`CONFIRMED`. Tests: día con corte al mediodía, servicio que no entra al final del día, feriado, dos profesionales, cambio de mes.

### Herramientas del agente
- `find_slots { service, day_hint }` → el código resuelve el servicio por nombre (o devuelve la lista si es ambiguo) y la fecha ("mañana", "el jueves") con la zona del negocio, y devuelve hasta 3 horarios. El modelo solo puede ofrecer horarios que vinieron de esta herramienta.
- `hold_slot { slot_id }` → crea `Booking` `HELD` con `holdExpiresAt = now + 15 min`. `slot_id` es un identificador opaco que devolvió `find_slots` (nunca una fecha escrita por el modelo).
- `cancel_booking`, `reschedule_booking` sobre reservas del mismo contacto.
- Si `depositPercent = 0`, `hold_slot` confirma directo. El texto de confirmación es fijo, armado en código con fecha, hora, servicio y profesional.
- Las reservas `HELD` vencidas pasan a `EXPIRED` en el mismo intervalo del reprocesador.
- Solo se ofrecen estas herramientas si el negocio tiene `schedulingEnabled` en su `AgentProfile`.

### Recordatorio
El día anterior a las 10 (hora del negocio), plantilla de utilidad aprobada `recordatorio_turno` con nombre, servicio, día y hora, y botones "Confirmo" / "Necesito cambiarlo". La respuesta entra como un mensaje más y el agente actúa.

### Admin
CRUD de servicios, profesionales, horarios y feriados con la API key de admin, y `GET /admin/businesses/:id/bookings?from=&to=`.

## 07b · Seña con Mercado Pago (rama `feat/mercadopago-deposit`)
- Credenciales por negocio: `mpAccessTokenEncrypted` (mismo cifrado que la línea) y `mpWebhookSecretEncrypted`. Alta por la API de admin.
- Al hacer `hold_slot` con seña: `POST https://api.mercadopago.com/checkout/preferences` con el access token del negocio, un ítem con título "Seña: <servicio> <día> <hora>" y `unit_price = depositArs`, `external_reference = booking.id`, `notification_url` = `https://<api>/webhooks/mercadopago/:businessKey`, y vencimiento igual a `holdExpiresAt`. Mandar el `init_point` por WhatsApp con un texto fijo.
- Webhook de Mercado Pago: validar la firma según su documentación, guardar el evento crudo (misma tabla de eventos que Meta, con `source`), y **siempre** consultar `GET /v1/payments/{id}` con el token del negocio antes de confirmar. Solo `status = approved`, `external_reference` igual al `Booking` y monto igual a `depositArs` confirman.
- Pago aprobado después del vencimiento: si el horario sigue libre, confirmar igual; si no, marcar para devolución y derivar a una persona (nunca devolver plata automáticamente).
- Idempotente por id de pago.
- Tests con el cliente de Mercado Pago mockeado: pago aprobado confirma; pago con otro monto no confirma; notificación repetida no duplica; vencido y ocupado deriva.

## 07c · Eventos para n8n (rama `feat/outbound-events`)
- `WebhookSubscription` por negocio: `url`, `secretEncrypted`, `events` (lista), `active`.
- Eventos: `lead.updated`, `handoff.requested`, `booking.confirmed`, `booking.cancelled`, `payment.approved`. Payload mínimo con ids y datos necesarios, sin historial de chat.
- Envío desde la cola en Postgres (un job por entrega) con firma HMAC-SHA256 en `X-Bottega-Signature`, reintentos con backoff hasta 6 intentos, y registro del último error.
- API para n8n: `GET /integrations/v1/...` (leads, bookings) con una clave por negocio (`IntegrationKey`, guardada como hash), solo lectura en esta etapa.

## Fuera de alcance
Reservas de restaurante por capacidad, Google Calendar, cobro total de pedidos con catálogo, devoluciones automáticas, OAuth de Mercado Pago, vista de calendario en la web (va con el prompt 05).

## Criterio de aceptación
- int: dos `hold_slot` simultáneos sobre el mismo horario dejan una sola reserva; una reserva `HELD` vencida libera el horario; un pago aprobado confirma una sola vez aunque llegue tres veces.
- Escenarios (`npm run test:scenarios`): el bot nunca ofrece un horario que no vino de `find_slots`; con seña, no dice "confirmado" antes del pago.
- Lint, unit, e2e e int en verde.
