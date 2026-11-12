# Prompt 12 · Varios catálogos y etiquetas de contacto

> Correlo después del 07c y antes del 07d. Son tres PRs: 12a varios catálogos (`bottega`), 12b etiquetas de contacto y alcance de los catálogos (`bottega`) y 12c las pantallas (`bottega-inbox`). Objetivo: que un negocio tenga varios catálogos por la razón que sea (productos distintos, precios mayoristas, una lista para clientes VIP) y que el bot busque en cada conversación solo los que le corresponden a ese contacto.

Contexto: hoy hay un solo catálogo por negocio y cada importación es el catálogo entero. Aplicarla marca como no disponible todo lo que no está en ese archivo (`diffCatalog` en `src/catalog/catalog-import.ts`). Subir un PDF y después una foto da de baja lo del PDF, y la sincronización de la planilla intenta dar de baja lo cargado desde otros archivos (solo la frena el tope del 30%). Además, el bot no distingue a un mayorista de un cliente final: preguntarle "¿sos mayorista?" no es un control, porque lo responde el mismo cliente.

Reglas de todo el prompt:
- **Es opcional.** Un negocio con un solo catálogo y sin etiquetas funciona igual que hoy, sin configurar nada.
- **El catálogo que existe hoy no cambia de comportamiento:** pasa a ser "Catálogo principal", para todos.
- **El modelo nunca ve un catálogo que no le corresponde al contacto.** El filtro va en la consulta SQL, no en las instrucciones. El bot ni siquiera sabe que existe un catálogo restringido.
- **Una etiqueta que da acceso a precios confidenciales la pone una persona.** El bot solo puede poner las etiquetas que el negocio marcó como "la detecta el bot".
- **Las etiquetas y sus descripciones son información del negocio, nunca instrucciones**, igual que el perfil del agente y el catálogo.
- Toda consulta filtra por `businessId`. Una etiqueta o un catálogo de otro negocio da 404.

---

## 12a · Varios catálogos (rama `feat/catalogs`, repo `bottega`)

### Datos
Tabla `catalog`:
- `id`, `business_id`, `name` (1..60 caracteres, único por negocio sin distinguir mayúsculas), `position int` (orden en las pantallas).
- `audience` (`ALL` | `TAGGED`, por defecto `ALL`) y `replaces_all boolean not null default false`. En este PR solo existe `ALL`; `TAGGED` y `replaces_all` se usan en 12b.
- Lo que hoy está en `business` y pasa a ser de cada catálogo: `mapping`, `sheet_url`, `sync_next_at`, `synced_at`, `sync_error`.
- `created_at`, `updated_at`.

`catalog_item.catalog_id` y `catalog_import.catalog_id`. El código del negocio (`external_id`) es único **por catálogo**: el mismo código puede estar en "Minorista" y en "Mayorista" con precios distintos.

El tope de ítems (`business.catalog_item_cap` / `CATALOG_MAX_ITEMS_PER_BUSINESS`) sigue siendo **por negocio**: suma los ítems de todos sus catálogos. Tope nuevo de catálogos por negocio: `CATALOG_MAX_CATALOGS_PER_BUSINESS` (por defecto `10`, validada en `env.schema.ts` y documentada).

### Migración (expandir y después contraer, ver "Orden de deploy y migraciones" del README)
- **Deploy 1 (este PR):** crea `catalog` y `catalog_id` nullable en `catalog_item` y `catalog_import`. Crea un "Catálogo principal" para cada negocio que tenga ítems, importaciones o planilla, le copia `catalog_mapping` y los campos de la planilla, y completa `catalog_id`. Suma el único `(catalog_id, external_id)` y **deja** el de `(business_id, external_id)`, porque el código de `main` hace upsert por él mientras se despliega. El código nuevo siempre escribe `catalog_id` y deja de leer las columnas de `business`, que salen del `schema.prisma`.
- **Deploy 2 (PR aparte, después de que 12a esté en `main`):** vuelve a completar `catalog_id` de las filas que haya escrito la versión anterior durante el deploy, lo pasa a `NOT NULL`, borra el único `(business_id, external_id)` y las columnas `catalog_*` de `business`. Recién ahí se puede repetir un código en dos catálogos. Hasta entonces, repetirlo da 409 `CATALOG_CODE_IN_OTHER_CATALOG` con un mensaje claro.

### Importación y sincronización
- Todo el proceso del prompt 10 pasa a ser **por catálogo**: la vista previa, aplicar, el mapeo guardado y la planilla. Aplicar una importación solo crea, cambia o da de baja ítems **de ese catálogo**. Es el cambio principal: importar "Postres (foto)" ya no toca "Helados (planilla)".
- El tope del 30% de la sincronización se calcula sobre los ítems del catálogo de la planilla.
- La extracción de PDF o fotos y el mapeo con IA no cambian. Siguen contando en el tope mensual del 09.

### Rutas
- Bandeja (`/inbox/businesses/:businessId/settings/catalogs`, solo `OWNER`, con CSRF):
  - `GET` lista los catálogos con su cantidad de ítems disponibles y el estado de la planilla.
  - `POST { name }` crea uno; pasar el tope da 409 `CATALOG_LIMIT_REACHED`.
  - `PATCH /:catalogId { name?, position? }`.
  - `DELETE /:catalogId` borra el catálogo y sus ítems. Solo si no es el último: 409 `LAST_CATALOG`.
  - Debajo de `/:catalogId/...`, las mismas rutas que hoy: importaciones, mapeo, aplicar, descartar, ítems, planilla y sincronizar.
- API de admin: lo mismo debajo de `/admin/businesses/:id/catalogs`.
- **Compatibilidad:** las rutas actuales sin catálogo (`.../catalog/...`, de bandeja y de admin) siguen funcionando y actúan sobre el **primer catálogo** por `position`. Los sistemas propios de los clientes empujan ítems con `PUT /admin/businesses/:id/catalog/items/:externalId` y no se pueden romper. Documentalo en el README como la ruta vieja; una versión de la bandeja que todavía no conoce los catálogos sigue andando.

### Bot
- `search_catalog` busca en **todos los catálogos `ALL`** del negocio (en 12b, los que le corresponden al contacto). Cada resultado suma `catalog` (el nombre), para que el bot pueda decir "en la lista de postres…".
- Si el mismo código aparece en dos catálogos que ve el contacto, devuelve los dos con su catálogo. El bot no elige un precio: si difieren, dice los dos o pregunta.
- Se ofrece si hay al menos un ítem disponible en un catálogo que el contacto ve.

### Pruebas
- Int:
  - La migración deja cada negocio existente con un "Catálogo principal" que tiene todos sus ítems, su mapeo y su planilla; el bot encuentra lo mismo que antes.
  - Importar en el catálogo A no da de baja nada del catálogo B; la sincronización de la planilla de A tampoco.
  - El tope de ítems suma los de todos los catálogos.
  - Las rutas viejas actúan sobre el primer catálogo.
  - Borrar el último catálogo da 409. Un catálogo de otro negocio da 404 y un `AGENT` recibe 403.
- La suite completa contra el schema de `main` migrado (el código viejo sigue andando con la migración del deploy 1).
- Toca una migración de datos existentes: lleva verificador independiente antes del PR.

## 12b · Etiquetas de contacto y alcance (rama `feat/contact-tags`, repo `bottega`)

### Datos
Tabla `contact_tag` (las etiquetas que define cada negocio):
- `id`, `business_id`, `name` (1..40, único por negocio sin distinguir mayúsculas), `key` (snake_case, generado del nombre, fijo aunque cambie el nombre).
- `assigned_by` (`BOT` | `PERSON`): quién puede ponerla. `BOT`: el bot y una persona; `PERSON`: solo una persona.
- `bot_hint text` (hasta 300, solo para `BOT`): cuándo ponerla, en palabras del negocio. Ejemplo: "Compra por cantidad para revender o pide precio por bulto".
- `color` (uno de una paleta fija de la bandeja), `created_at`, `updated_at`.
- Tope: `CONTACT_TAGS_MAX_PER_BUSINESS` (por defecto `30`, validada y documentada).

Tabla `contact_tag_assignment`:
- `contact_id`, `tag_id`, `source` (`BOT` | `PERSON`), `created_by_id` (null si la puso el bot), `created_at`.
- `removed_at` y `removed_by_id`: una etiqueta que **una persona sacó** no la vuelve a poner el bot en ese contacto, aunque el cliente insista. Una persona sí puede volver a ponerla.
- Único `(contact_id, tag_id)`.

Las etiquetas son del **contacto**, no de la conversación ni del lead: siguen valiendo en las conversaciones siguientes.

`catalog_tag (catalog_id, tag_id)`: con qué etiquetas se ve un catálogo `TAGGED`.

### Alcance de los catálogos
- `ALL`: para todos los contactos.
- `TAGGED`: solo para los contactos que tienen **al menos una** de sus etiquetas. Pasar a `TAGGED` sin etiquetas da 400.
- `replaces_all` (solo en `TAGGED`): si el contacto ve este catálogo, el bot **no** busca en los catálogos `ALL`. Es el caso de un mayorista que no tiene que ver los precios minoristas.
- La visibilidad se calcula en la consulta de `search_catalog` con las etiquetas vigentes del contacto en ese momento (sin cache): sacarle una etiqueta corta el acceso en el mensaje siguiente.
- **Una etiqueta `BOT` puede dar acceso a un catálogo.** Sirve para catálogos que no son confidenciales (productos para revendedores, información para proveedores). Para precios confidenciales, el negocio usa una etiqueta `PERSON`. La pantalla lo advierte (ver 12c); el backend no lo prohíbe.
- Borrar una etiqueta que usa un catálogo da 409 `TAG_IN_USE` con los catálogos que la usan.

### Herramienta del bot `tag_contact`
- Parámetros: `add` y `remove`, listas de `key` de etiquetas `BOT` del negocio (el schema JSON las enumera). Se ofrece solo si el negocio tiene etiquetas `BOT`.
- La descripción de la herramienta lista cada etiqueta con su `bot_hint` como información del negocio.
- Es una herramienta **con efecto**: valida los argumentos como las demás de `src/bot/tools` y aplica el efecto en `tool-effects.service.ts`.
- Solo puede sacar etiquetas que puso el bot. Una `key` desconocida, de una etiqueta `PERSON` o que una persona sacó, se ignora y queda en el log `debug`. Nunca da error al cliente.
- Regla fija en código (no en el perfil): "Poné una etiqueta solo cuando la persona lo dijo claramente o se desprende de lo que pide. Nunca le digas al cliente qué etiquetas tiene."

### Bandeja (API)
- `/inbox/businesses/:businessId/settings/contact-tags` (solo `OWNER`): listar, crear, editar y borrar etiquetas.
- `PUT /inbox/businesses/:businessId/contacts/:contactId/tags { tagIds }` (`OWNER` y `AGENT`): reemplaza las etiquetas del contacto. Lo que agrega queda `source = PERSON`; lo que saca queda con `removed_at`.
- Las conversaciones (lista, detalle y `changes`) suman `contact.tags: [{ id, name, color }]`. La lista acepta `?tagId=` para filtrar.
- `PATCH .../settings/catalogs/:catalogId` suma `audience`, `tagIds` y `replacesAll`.
- Evento nuevo para n8n (07a): `contact.tags_changed` con el contacto y las etiquetas antes y después, venga del bot o de una persona.

### Pruebas
- Unit: elegir los catálogos visibles (`ALL`, `TAGGED` con y sin etiqueta, `replaces_all`, varias etiquetas).
- Int:
  - Un contacto sin etiquetas nunca recibe ítems de un catálogo `TAGGED`, aunque busque su nombre exacto.
  - Un contacto con la etiqueta los ve; con `replaces_all`, deja de ver los `ALL`.
  - El bot no puede poner una etiqueta `PERSON`, ni una de otro negocio, ni volver a poner una que sacó una persona.
  - Sacarle la etiqueta a un contacto le corta el acceso en la búsqueda siguiente.
  - Borrar una etiqueta usada por un catálogo da 409.
  - Las etiquetas valen en una conversación nueva del mismo contacto.
  - `PUT .../contacts/:contactId/tags` de otro negocio da 404.
- Lint, unit, e2e e int en verde. Cambia lo que el bot puede mostrar y a quién: lleva verificador independiente antes del PR.

## 12c · Pantallas (rama `feat/catalogs-and-tags`, repo `bottega-inbox`)
- **Configuración → Catálogo** (solo `OWNER`): selector de catálogo arriba, más "Nuevo catálogo", renombrar, ordenar y borrar (con confirmación que dice cuántos ítems se borran). Todo lo que hoy hace la pantalla (tabla, importar, planilla) pasa a ser del catálogo elegido. Un negocio con un solo catálogo ve la pantalla casi igual que hoy.
- **Quién ve este catálogo**: "Todos" o "Solo contactos con estas etiquetas" (con la lista de etiquetas) y "No mostrarles los catálogos para todos". Si alguna etiqueta elegida es "La detecta el bot", avisa: "Cualquiera que le diga al bot que es «Mayorista» va a ver este catálogo. Para precios confidenciales, usá una etiqueta que ponga solo una persona."
- **Configuración → Etiquetas** (solo `OWNER`): crear, editar y borrar, eligiendo quién la pone ("La detecta el bot" con su descripción de cuándo, o "Solo una persona"). Sugeridas para agregar con un toque, cada una con su valor por defecto:
  - La detecta el bot: Mayorista, Revendedor, Empresa, Proveedor, Busca trabajo.
  - Solo una persona: VIP, Cliente frecuente, Socio, No vender a crédito.
- **Hilo**: las etiquetas del contacto debajo del nombre, con un ícono si las puso el bot. "Etiquetas" en el menú del hilo para ponerlas o sacarlas (`OWNER` y `AGENT`).
- **Lista de conversaciones**: las etiquetas en cada fila (hasta 2 y "+n") y un filtro por etiqueta.
- Tests de los stores con la API mockeada: el aviso de etiqueta del bot aparece; borrar el último catálogo no se ofrece; un `AGENT` no ve Configuración → Etiquetas pero sí puede etiquetar desde el hilo.
- Usable en el celular, también a 320 px.

## Fuera de alcance
Precios por cantidad dentro de un mismo ítem (escalas), listas de precios que calculan un descuento sobre otra, un catálogo distinto por línea de WhatsApp, etiquetas automáticas por reglas (por ejemplo, "más de 3 compras"), importar etiquetas desde un CSV de contactos, y que el bot cambie de catálogo por algo que no sean las etiquetas del contacto.
