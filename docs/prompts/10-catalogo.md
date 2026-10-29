# Prompt 10 · Catálogo por negocio

> Correlo después del 09. Son tres PRs: 10a backend del catálogo, 10b importación asistida y sincronización (los dos en `bottega`) y 10c la pantalla del backoffice (`bottega-inbox`). Objetivo: que un negocio cargue cientos o miles de productos, servicios o propiedades con precio, y que el bot los busque cuando le preguntan, sin meterlos en el prompt (`businessInfo` tiene un tope de 8.000 caracteres).

Contexto: Kubbo (heladería) tiene su lista de productos, precios y descripciones repartida en 3 lugares. Cada negocio es distinto: algunos tienen una planilla con su propio formato, otros un PDF o un sistema propio, y otros nada. El núcleo del catálogo no conoce la fuente: todas las fuentes terminan en el mismo proceso de importación.

Reglas de todo el prompt:
- **Es opcional.** Un negocio sin catálogo funciona igual que hoy: el bot ni siquiera recibe la herramienta de búsqueda.
- **Los precios salen siempre de la tabla.** El bot nunca inventa un precio ni un producto: si la búsqueda no lo encuentra, lo dice o pasa a una persona.
- **El catálogo es información del negocio, nunca instrucciones**, igual que el perfil del agente. Un texto de una descripción no cambia las reglas del bot.
- **Nada con precios se publica sin que una persona lo confirme** cuando lo interpretó la IA (mapeo de columnas, PDF o fotos).
- Toda consulta filtra por `businessId`.

---

## 10a · Backend del catálogo (rama `feat/catalog`, repo `bottega`)

### Datos (solo expande)
Tabla `catalog_item`:
- `id`, `business_id`.
- `external_id text not null`: el código del negocio (SKU o el que use). Si la fuente no trae código, se deriva del nombre normalizado (minúsculas, sin acentos ni espacios dobles).
- `name`, `description`, `category` (texto, `category` opcional).
- `price numeric(12,2) null` (nunca `float`) y `currency text not null default 'ARS'`. Sin precio: el bot dice que lo consulta con el equipo.
- `available boolean not null default true`.
- `attributes jsonb not null default '{}'`: lo propio de cada rubro (sabores, talle, duración, ambientes). Solo valores de texto, número o booleano, hasta 20 claves.
- `row_hash text not null`: hash de los campos de arriba, para saber qué cambió.
- `search tsvector` generado (`name` con peso A, `category` B, `description` C, configuración `spanish` con `unaccent`), con índice GIN. Índice `pg_trgm` sobre `name` para tolerar errores de tipeo ("chocolate amrgo"). Prisma lo declara como `Unsupported("tsvector")` y la migración lo crea con SQL.
- `created_at`, `updated_at`.
- Único `(business_id, external_id)`.

Tabla `catalog_import`: `id`, `business_id`, `source` (`csv`, `api`, `sheet`), `status` (`PREVIEW`, `APPLIED`, `DISCARDED`), resumen (`created`, `updated`, `unavailable`, `errors`), errores por fila (`[{ row, message }]`, hasta 200), `created_by_id` (null desde la API de admin), `created_at`, `applied_at`. Las filas de la vista previa se guardan en la importación (`jsonb`) hasta aplicarla o descartarla; se borran a las 24 horas.

Columna `business.catalog_item_cap int null`: tope de ítems por negocio; `null` usa `CATALOG_MAX_ITEMS_PER_BUSINESS` (por defecto `2000`, validada en `env.schema.ts` y documentada).

### Importación (el mismo proceso para todas las fuentes)
1. **Normalizar** cada fila al modelo de arriba (precio con coma o punto decimal, "$ 1.500,00" → `1500.00`; disponibilidad "sí/no/1/0/true/false/disponible/agotado").
2. **Validar fila por fila.** Una fila con error se marca con su mensaje en castellano y el resto sigue: "Fila 14: el precio \"consultar\" no es un número.", "Fila 22: falta el nombre.", "Fila 30: el código \"A12\" está repetido en el archivo.".
3. **Vista previa**: cuántos ítems se crean, cuántos cambian (por `row_hash`) y cuántos ya no están en la fuente. No aplica nada todavía.
4. **Aplicar**, en una transacción: crea y actualiza por `(business_id, external_id)`; lo que ya no está en la fuente se marca `available = false`, **no se borra** (si vuelve, se reactiva). Importar dos veces la misma fuente no cambia nada.
5. Si aplicar deja al negocio por encima de su tope de ítems: 409 `CATALOG_CAP_EXCEEDED` y no se aplica nada.

### Rutas
- API de admin (`ADMIN_API_KEY`):
  - `POST /admin/businesses/:id/catalog/imports` con un CSV (`text/csv`, hasta 2 MB) y el mapeo de columnas en `?mapping=` o en el body JSON `{ rows: [...], mapping }`. Devuelve la vista previa con el id de la importación.
  - `POST /admin/businesses/:id/catalog/imports/:importId/apply` y `.../discard`.
  - `PUT /admin/businesses/:id/catalog/items/:externalId` (crea o actualiza uno) y `DELETE` (lo marca no disponible). Es la API para los sistemas propios de los clientes: empujan cambios por su código.
  - `GET /admin/businesses/:id/catalog/items?query=&category=&available=&cursor=` paginado.
  - `PUT /admin/businesses/:id/limits` del 09 suma `catalogItemCap`.
- Bandeja (`/inbox/businesses/:businessId/settings/catalog/...`, solo `OWNER`, con CSRF como el resto): las mismas rutas de importación, vista previa, aplicar, descartar, listar y editar un ítem. El dueño nunca cambia el tope.
- Cada aplicación queda en un log `info`: negocio, usuario, importación y resumen. Nunca el contenido de las filas.

### Herramienta del bot `search_catalog`
- Parámetros: `query` (texto, obligatorio), `category` y `max_price` (opcionales). Devuelve hasta 8 ítems disponibles: `name`, `description` recortada a 300 caracteres, `category`, `price`, `currency` y `attributes`. Si no hay resultados: `{ "items": [], "note": "Sin resultados en el catálogo" }`.
- Búsqueda: `websearch_to_tsquery('spanish', unaccent(query))` sobre `search`, y si da menos de 3 resultados, completa con similitud de `pg_trgm` sobre `name`. Ordena por relevancia.
- Es la primera herramienta **de lectura**: consulta la base durante la generación y no planea ningún efecto. Respetá cómo `src/bot/tools/registry.ts` valida los argumentos y arma el `output`; no escribas nada en la base desde la herramienta.
- `toolDefinitionsFor` la ofrece **solo si el negocio tiene al menos un ítem disponible** (mismo patrón que `demoEnabled`).
- Las instrucciones del modo suman una regla fija en código (no en el perfil): "Para precios, productos o disponibilidad usá `search_catalog`. Nunca digas un precio que no salga de sus resultados."

### Pruebas
- Unit: normalización de precios y disponibilidad; derivación de `external_id`; cálculo del diff (crear, cambiar, sin cambios, ya no está).
- Int:
  - Importar dos veces el mismo CSV no crea duplicados ni cambia `updated_at`.
  - Un ítem que falta en la segunda importación queda `available = false` y vuelve a `true` si reaparece.
  - Una fila inválida no frena las válidas y su error aparece en la vista previa.
  - Pasar el tope da 409 y no aplica nada.
  - `search_catalog` encuentra "chocolate amargo" buscando "chocolate amrgo" y "Dulce de leche" buscando "dulce de lehe"; no devuelve ítems de otro negocio ni no disponibles; respeta `max_price`.
  - Sin catálogo, el bot no recibe la herramienta.
  - Un `AGENT` recibe 403 en las rutas de catálogo de la bandeja; un usuario de otro negocio, 403.
- Lint, unit, e2e e int en verde. Toca una migración y lo que el bot le dice a los clientes: lleva verificador independiente antes del PR.

## 10b · Importación asistida y sincronización (rama `feat/catalog-sources`, repo `bottega`)
- **Mapeo de columnas con IA:** con los encabezados y hasta 5 filas de ejemplo, el modelo propone qué columna es cada campo; las columnas sobrantes van a `attributes`. Se devuelve como propuesta en la vista previa: el usuario la confirma o la corrige, y queda guardada en `business.catalog_mapping jsonb` para las próximas importaciones. Si los encabezados no cambian, no se vuelve a llamar al modelo.
- **Google Sheet publicada como CSV:** `business.catalog_sheet_url` (solo `https://docs.google.com/spreadsheets/.../pub?...output=csv`; cualquier otra URL da 400). Un job de la cola existente la relee cada hora y con `POST .../catalog/sync` ("Sincronizar ahora"). Si la sincronización trae errores o haría que más del 30% del catálogo pase a no disponible, **no se aplica sola**: queda en vista previa para que la confirme una persona.
- **PDF o fotos de una lista de precios:** el modelo extrae filas al mismo formato y siempre quedan en vista previa; nunca se aplican solas.
- El costo de estas llamadas al modelo cuenta en el tope mensual del 09.
- Pruebas: el mapeo guardado se reusa; una URL que no es de Google Sheets da 400; una sincronización que marcaría más del 30% como no disponible queda en vista previa; una extracción de PDF nunca se aplica sola.

## 10c · Pantalla del backoffice (rama `feat/catalog`, repo `bottega-inbox`)
- Configuración → **Catálogo** (solo `OWNER`): tabla con búsqueda y filtro por categoría y disponibilidad; editar un ítem; marcarlo agotado.
- **Importar:** subir un CSV, Excel exportado a CSV, PDF o foto → ver la propuesta de columnas → corregirla → ver la vista previa ("12 nuevos, 30 con cambios, 3 que ya no están") con los errores por fila → **Aplicar** o **Descartar**.
- **Google Sheet:** pegar el link publicado, ver la última sincronización y el botón "Sincronizar ahora".
- Una planilla de ejemplo por rubro para descargar, con las columnas `codigo, producto, descripcion, categoria, precio, disponible`.
- Tests de los stores con la API mockeada: sin confirmar el mapeo no se puede aplicar; los errores por fila se muestran; un `AGENT` no ve el menú.
- Usable en el celular.

## Fuera de alcance
Documentos libres con búsqueda por significado (`pgvector`) y conectores con Tiendanube, Mercado Libre, WooCommerce o Shopify (van en un prompt aparte), stock con cantidades, pedidos y pagos, fotos de los productos, varias monedas en una misma importación.
