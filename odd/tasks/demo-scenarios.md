# Demo scenarios: car insurance and aesthetics (replace the barbershop)

Objective: two fictitious demos chosen with buttons; insurance first, then aesthetics replaces the barbershop.
Branch: feat/insurance-demo (from develop), PR to develop. Delivery: ask-on-risk. Test runner: jest (`npm test`, `npm run test:e2e`, `npm run test:int`).

## Specs

- S1. "preparemos 2 demos una de seguros y otra de estetica, reemplacemos la demo de barberia. Primero la del seguro" (L1).
- S2. Choosing the demo: "Probar la demo" no longer enters a fixed demo; it asks which one with one reply button per scenario. Tapping a scenario enters (or switches to) that demo. The active context keeps its scenario (reset keeps it). Assumption: picker by buttons (the user did not specify how to choose).
- S3. Insurance demo flow (from the pasted brief, L1):
  1. "Entender lo que busca. “¿Querés asegurar un auto o comparar lo que estás pagando?”"
  2. "Completar los datos. Marca, modelo, año, versión, localidad/código postal, uso y GNC."
  3. "Identificar la prioridad. “¿Buscás pagar menos, mejorar la cobertura o comparar ambas?”"
  4. "Mostrar hasta tres alternativas. Con precio mensual, principales coberturas, franquicia cuando corresponda y condiciones relevantes."
  5. "Resolver preguntas. Por ejemplo: “¿Qué es la franquicia?”, “¿Cuál incluye granizo?” o “¿Qué cambia con la más económica?”. Siempre según los datos de cada plan."
  6. "Cerrar con una acción. Elegir una opción y pedir contacto para que un asesor continúe."
- S4. "entender datos mezclados y preguntar solamente lo que falta. Si alguien escribe “Tengo un Gol Trend 2018, soy de Caballito y quiero pagar menos”, el bot debería reconocer auto, año, ubicación y objetivo; después confirmar la versión y completar lo pendiente."
- S5. "la IA conversa y explica; una tabla de demostración o un cotizador conectado devuelve los importes y las condiciones. El modelo no debería inventarlos. Sin integración, cada resultado debe decir “Cotización simulada para demostración”." Prices come from a backend tool over the demo table, never from the model.
- S6. "limitaría el alcance a autos particulares, algunos vehículos de ejemplo y tres planes ficticios bien definidos." "una prueba donde el usuario cambie de auto a mitad de la conversación y otra donde pregunte algo que el bot no pueda confirmar: ahí debe pedir el dato o derivar al asesor."
- S7. Producer side (user decision L2): when the client picks a plan and leaves contact, the request is stored (fictitious) and the conversation is handed off to the inbox with the summary (vehicle, priority, plan, contact) visible in the chat.
- S8. Aesthetics demo replaces the barbershop (after S2-S7 are approved): "mientras que la demo de la estetica es seria una recepcionista virtual" with the Zentara brief (L4, verbatim there).
- S9. The insurance business is named "VAL-RAM Seguros" (L3). Plans and prices stay labeled as examples/simulated.

## Tasks

- [x] T1 S2: demo scenario on the context + picker (inline). PR #59 merged, CI green (int included).
- [x] T2 S3-S7, S9: insurance scenario: content, quote tool, register + handoff (inline). PR #59.
- [x] T3 S8: aesthetics (Zentara receptionist) replaces barbershop (inline). Branch feat/aesthetics-demo.

## Log

- L1 (2026-10-28) user: "preparemos 2 demos una de seguros y otra de estetica, reemplacemos la demo de barberia. Primero la del seguro" + pasted brief for the insurance demo (quoted in S3-S6).
- L2 (2026-10-28) user: "si" to: on close, the bot hands off to the inbox with the summary instead of a new two-panel web.
- L3 (2026-10-28) user: "el negocio de seguros se llama VAL-RAM Seguros"
- L4 (2026-10-28) user: "mientras que la demo de la estetica es seria una recepcionista virtual" + pasted prompt:
  > Sos el asistente virtual de Zentara, un centro de estética y bienestar. Ayudás a las personas a consultar servicios y avanzar hacia una reserva.
  > PERSONALIDAD: Hablá en español argentino, usando “vos”. Sé amable, claro y breve. Usá como máximo un emoji por mensaje y hacé una sola pregunta por vez cuando necesites aclarar algo.
  > CÓMO ATENDER: Respondé primero lo que la persona preguntó. Usá exclusivamente la información de la base de conocimiento para servicios, precios, duración, horarios y políticas. Si pregunta por un servicio, informá su precio y duración cuando estén disponibles. Si el pedido es ambiguo, preguntá lo necesario. Por ejemplo, ante “quiero hacerme las uñas”, consultá qué tipo de servicio busca. Si ya dio información, recordala y no vuelvas a pedirla. Ofrecé el enlace de reservas cuando la persona quiera avanzar. Compartí la ubicación o Instagram cuando los solicite.
  > RESERVAS: Esta demo no tiene acceso a disponibilidad en tiempo real. No inventes turnos ni confirmes reservas. Indicá que puede consultar los horarios disponibles y completar la reserva en la agenda online.
  > LÍMITES: No inventes promociones, medios de pago, servicios ni condiciones. Si falta información, decilo y ofrecé consultar con el equipo. No diagnostiques ni garantices resultados. Las consultas sobre contraindicaciones, embarazo, lesiones o condiciones de la piel deben revisarse con el profesional antes de elegir un tratamiento.
  > INICIO: Si la persona solo saluda, presentate brevemente y preguntá en qué podés ayudar. Si ya hizo una consulta, respondela directamente.
- L5 (2026-10-28) T1+T2 done: lint ok, unit 440/440, e2e 86/86. test:int NOT run: no Docker in WSL and no Postgres on :5432. Next: user tries insurance demo; then T3.
- L6 (2026-10-28) user: "empeza con la demo zentara". T3: content/demos/aesthetics.json (Zentara, 11 services in 4 categories, hours, policies, example address/Instagram, bookingUrl https://example.com/zentara/reservas as placeholder); receptionist prompt from the L4 brief; no booking tool (sends the booking link; request_handoff + offer_options only); barbershop content, booking tool and summary removed; legacy/null DEMO contexts continue in aesthetics. Lint ok, unit 440/440, e2e 86/86; test:int pending (CI).
