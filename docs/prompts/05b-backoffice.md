# Prompt 05b · Backoffice: agente, leads y usuarios

> Correlo después del 05. Son dos PRs: primero el backend (sesión sobre `bottega`), después la web (sesión sobre `bottega-inbox`). Objetivo: que el dueño del negocio (hoy BotSuite46) cambie el agente, lo pruebe, vea sus leads y sume a su equipo sin usar la API de admin.

---

## Parte 1 · Backend (rama `feat/backoffice-api`, repo `bottega`)

Todas las rutas bajo `/inbox/businesses/:businessId/settings/...` con `SessionGuard` + `BusinessAccessGuard`, y un guard nuevo `RoleGuard('OWNER')`: un `AGENT` recibe 403.

### Agente
- `GET /settings/agent` y `PUT /settings/agent`: reusan el servicio y el schema Zod del prompt 02b (mismos límites). Cada `PUT` sube `version` y guarda quién lo cambió (`updatedById`).
- `GET /settings/agent/versions`: las últimas 20 versiones con fecha, autor y un diff de texto por campo. Guardá cada versión en una tabla `AgentProfileVersion` (snapshot jsonb) para poder volver atrás.
- `POST /settings/agent/versions/:version/restore`: restaura un snapshot como versión nueva.
- `POST /settings/agent/preview`: el mismo preview del 02b (no envía nada por WhatsApp), con un límite de 20 por hora por negocio para no gastar OpenAI de más.
- Los campos `model` y `demoEnabled` **no** se editan desde acá: siguen siendo solo de la API de admin.

### Leads
- `GET /leads?from=&to=&q=&cursor=`: paginado por `(createdAt, id)` descendente, 50 por página, con el contacto y la conversación.
- `GET /leads/export.csv?from=&to=`: CSV con las columnas de `leadFields` del negocio más fecha, nombre de perfil y teléfono. Escapá comillas y celdas que empiezan con `=`, `+`, `-` o `@` (inyección de fórmulas en Excel).

### Usuarios
- `GET /settings/users`, `POST /settings/users` (`email`, `name`, `role`): crea el usuario con una contraseña temporal aleatoria que se muestra **una sola vez** en la respuesta, y lo marca `mustChangePassword`.
- `PATCH /settings/users/:userId` (`role`, `active`). Un negocio nunca se queda sin al menos un `OWNER` activo (409).
- `POST /auth/change-password` para cualquier usuario logueado; si `mustChangePassword`, la web lo obliga antes de entrar a la bandeja.

### Pruebas
- e2e: `AGENT` recibe 403 en todo `/settings`; un `OWNER` del negocio A no ve leads del B; `PUT` inválido da 400 con los errores de Zod; restaurar una versión crea una nueva; el CSV neutraliza `=SUM(A1)`; no se puede desactivar al último `OWNER`.
- Lint, unit, e2e e int en verde.

## Parte 2 · Web (rama `feat/backoffice`, repo `bottega-inbox`)

- Menú "Configuración" visible solo para `OWNER`, con tres pantallas en PrimeNG:
  - **Agente:** formulario por secciones (Quién es, Información del negocio, Preguntas frecuentes como lista editable, Datos a pedir como tabla con `key`, etiqueta, tipo y obligatorio, Cuándo derivar, Mensaje fuera de horario). Contador de caracteres contra los límites del backend. Botón "Probar" que abre un chat de prueba contra `/preview` y muestra las herramientas que el bot habría llamado. Historial de versiones con "Restaurar".
  - **Leads:** tabla con filtros por fecha y búsqueda, link a la conversación en la bandeja y botón "Exportar CSV".
  - **Equipo:** lista de usuarios, alta con la contraseña temporal mostrada una vez (con botón copiar), cambio de rol y desactivar.
- Pantalla de cambio de contraseña obligatoria cuando `mustChangePassword`.
- Tests de los stores con el API mockeado: guardar el agente muestra errores de validación por campo; el preview no bloquea la bandeja; el CSV se descarga.
- Usable en el celular, igual que la bandeja.

## Fuera de alcance
Editar el modelo de IA, facturación, métricas y reportes (van cuando haya clientes), recuperar contraseña por email.
