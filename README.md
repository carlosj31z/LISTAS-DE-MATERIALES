# SAP MM & LM — Suite web de Maestro de Materiales y Listas de Materiales

Aplicación web monofichero (`index.html`) para el equipo de QA/DOC de Medifarma
(planta farmacéutica peruana, Ate y Lima), construida iterativamente con Claude
sobre muchas sesiones. Corre 100% en el navegador (sin backend propio, salvo la
función serverless nueva del chat con IA — ver más abajo) y persiste datos en
Supabase para no tener que recargar los Excel de SAP en cada sesión.

Este documento es el resumen de contexto para retomar el desarrollo en Claude
Code. El archivo `index.html` que se entrega junto a esto es el código fuente
completo y actualizado — este README explica CÓMO está armado y QUÉ falta.

---

## 1. Arquitectura general

Un único archivo HTML de ~8,300 líneas, con **9 bloques `<script>`** separados
por responsabilidad. Cada módulo grande es un IIFE con su propio scope, y se
comunican entre sí publicando funciones/datos puntuales en `window.*` (nunca
variables sueltas del scope interno).

```
<script>  Bloque 0-2: utilidades globales, cliente Supabase, selección de celdas
<script>  Bloque 3: coordinador de la ventana de carga inicial
<script>  APP 1 — Maestro de Materiales      (prefijo de ids: "mm")
<script>  APP 2 — Explorador BOM / Listas de Materiales  (prefijo: "bom")
<script>  APP 3 — Árbol del producto          (prefijo: "arbol")
<script>  APP 4 — Explosión masiva            (prefijo: "expl")
<script>  Chat con IA (Gemini vía endpoint propio)  (prefijo: "iaChat")
```

Localizar cada bloque en el HTML actual:
```bash
grep -n "APP [0-9] —" index.html
```

### Pestañas de la interfaz (4 + chat flotante)
1. **Maestro de Materiales** — ficha de materiales de SAP, filtros por columna,
   detección de Categoría 3, materias primas exclusivas ZMPR/ZMEE.
2. **Listas de Materiales** — el BOM (Bill of Materials): listas, componentes,
   Versiones de Fabricación (VFab), exportadores a Excel con formato, y el
   nuevo **botón flotante de Auditoría de incoherencias** (esquina inferior
   izquierda).
3. **Árbol del producto** — reconstruye la cadena Acondicionado → Envase →
   Recubrimiento/Inspección → Fabricación de un producto terminado,
   retrocediendo por los componentes de posición 0010 de cada lista. Soporta
   múltiples combinaciones cuando hay ambigüedad de Versión de Fabricación.
4. **Explosión masiva** — corre el mismo motor del Árbol del producto sobre
   varios materiales pegados desde Excel a la vez, exporta a Excel con formato
   "EXPLOSION" (una fila por componente, con comentarios y celdas amarillas en
   bloqueos).
5. **Chat con IA** (botón flotante, esquina inferior derecha, en MM y BOM) —
   filtrado de las tablas con preguntas en lenguaje natural, vía Gemini. Ver
   sección 5 — **tiene un bug pendiente sin resolver**.

---

## 2. Fuentes de datos y su relación

Todo se carga desde exports de SAP en Excel (botones en la pestaña "Listas de
Materiales"), se guarda en Supabase, y se publica en `window.*` para que otros
módulos lo consuman sin recargar:

| Dato | Variable interna | Publicado en | Usado por |
|---|---|---|---|
| Maestro de Materiales | `ROWS`/`COLUMNS` (módulo MM) | `window.MM_ESTADO_MAP`, `window.MM_TEXTO_MAP`, `window.MM_OLDCODE_MAP`, `window.MM_CAT3_MAP` | Árbol, BOM |
| Listas de Materiales (BOM) | `ROWS`/`COLUMNS` (módulo BOM) | `window.BOM_ROWS` / `window.BOM_COLUMNS` | Árbol, Explosión masiva |
| Componentes | `COMP_ROWS`/`COMP_COLUMNS` | `window.BOM_COMP_ROWS` / `window.BOM_COMP_COLUMNS` | Árbol, Explosión masiva, Auditoría |
| Versiones de Fabricación (VFab) | `VFAB_ROWS`/`VFAB_COLUMNS` | `window.BOM_VFAB_ROWS` / `window.BOM_VFAB_COLUMNS` | Árbol, Explosión masiva, Auditoría |

**Filtro universal importante**: todas las cargas descartan filas con
`Utilización LMat != 1` — un mismo Material+Alternativa puede tener varias
filas en el export con distinta Utilización (ej. "ACONDICIONADO" con
Utilización=1 y "FORMULA CUALI-CUANTITATIVA" con Utilización=8), y solo la de
Utilización=1 es la real para efectos de esta app.

**Clave de cruce correcta**: Material + Alternativa **+ "Lista de materiales"**
(el ID técnico de 8 dígitos). Cruzar solo por Material+Alternativa mezcla
listas técnicas distintas del mismo material — bug real encontrado y corregido
varias veces en el desarrollo (ver `buildAllCompsIndex`, `buildBomIndex`).

### Formato "SAPUI5" de Versiones de Fabricación (parser especial)

Hay un segundo formato de export de VFab (columnas con texto descriptivo +
código entre paréntesis, ej. `"PLANTA ATE (1020)"`, `"Bloqueado para cada
utilización (1)"`) que la app detecta automáticamente (`esFormatoVfabSapui5`) y
transforma (`transformarVfabSapui5`) al formato interno clásico antes de
guardarlo. Ojo: ese export repite el nombre de columna "Fecha fin validez" DOS
VECES con significados distintos (columnas J y T) — por eso el parser lee por
POSICIÓN de columna (array, `header:1`), nunca por nombre con
`sheet_to_json` normal, que perdería una de las dos por colisión de claves.
Solo se aceptan Centros 1020 y 1021 (se descarta explícitamente "1030").

---

## 3. Lógica de negocio central — Versionamiento de Fabricación

Esta es la parte más delicada del proyecto, validada en muchas iteraciones
contra datos reales de SAP. La Versión de Fabricación (VFab) es un código de 4
caracteres cuyos dígitos codifican la cadena de producción:

- **Dígito 1**: identifica la alternativa de la etapa **Fabricación** de la
  que desciende TODA la cadena — debe ser el MISMO en todas las etapas
  (Acondicionado, Envase, Fabricación). Si no coincide entre etapas, es una
  **incoherencia real de datos en SAP** (`INCOHERENCIA: ... empieza con...`).
- **Dígito 2**: indica la alternativa de la etapa PREVIA (más antigua). Se
  traduce con `letraParaAltPrevia`/`altPreviaDesdeDigito2`: 1-9 son
  alternativas directas, C-Z son alternativas de conciliación 66-90 (C=66,
  D=67…), 0 significa "sin etapa previa" (es la propia Fabricación).
- **Dígitos 3-4**: la alternativa PROPIA de esa etapa. Debe coincidir con la
  Alternativa real registrada en la Lista de Materiales para esa VFab — si no
  coincide (ej. VFab "1166" registrada contra Alternativa "1" en vez de "66"),
  es otra incoherencia real (`verificarCoherenciaDigitos34`).
- **Reacondicionado** (alternativas 95-99): formato fijo `00` + alternativa
  (ej. "0099"). Solo existen en Acondicionado, nunca tienen etapa previa real
  — el árbol NO debe intentar retroceder desde ahí.

**Selección automática de VFab coherente**: cuando una etapa tiene varias VFab
reales candidatas, el algoritmo (`construirNodoIndividual`,
`construirTodosLosArboles`) PREFIERE automáticamente la que comparte el dígito
1 con la cadena ya construida, propagando ese dígito objetivo en la recursión
(parámetro `digito1Objetivo`, nunca una variable compartida del closure, para
no mezclar el dígito 1 de una combinación de árbol con otra en paralelo).
Cuando hay ambigüedad real sin ninguna opción claramente coherente, se generan
TODAS las combinaciones posibles (límite `MAX_ARBOLES_COMBINACIONES = 24`) y
se ordenan con las coherentes primero.

**Bug de mutación compartida ya corregido**: los nodos previos a un punto de
ramificación son el MISMO objeto en memoria entre combinaciones — sin clonar
antes de que `completarArbol` les añada advertencias, una advertencia de una
combinación "se filtraba" a las demás. Se corrigió clonando cada nodo
(`Object.assign` + `.slice()` del array de advertencias) antes de procesar
cada combinación por separado.

**El motor del árbol NUNCA inventa una Versión de Fabricación** para
construir la cadena — solo la calcula con la fórmula (`calcularVersionFabricacion`)
como ÚLTIMO RECURSO cuando no hay ningún registro real, marcándolo siempre
como "(estimada)" en la UI y en advertencias. Esto fue motivo de una discusión
explícita con el usuario: cualquier VFab mostrada como real debe venir
literalmente de `window.BOM_VFAB_ROWS`.

---

## 4. Auditoría de incoherencias (Excel de 3 hojas)

Botón flotante semitransparente, esquina inferior izquierda de "Listas de
Materiales" (`#bomExportAuditoria`, clase `.audit-fab`). Genera un Excel con:

1. **Hoja "Listas de Materiales"**: recorre TODO el archivo de Componentes
   (sin construir ningún árbol) y detecta problemas de SECUENCIA DE
   POSICIONES: saltos indebidos (0010, 0020, 0050 → falta 0030/0040),
   posiciones alternativas sin su base (existe 0021 pero no 0020), y formato
   de posición no numérico. Enriquecida con Descripción, Creado el, Creado
   por (cruzado desde el BOM principal).
2. **Hoja "Versiones de Fabricación"**: reconstruye TODOS los árboles posibles
   desde cada Acondicionado con VFab real cargada (reutiliza
   `window.__arbolAPI.construirTodosLosArboles`, nunca una copia de la
   lógica) y recopila las 3 incoherencias de la sección 3.
3. **Hoja "Resumen"**: conteo y explicación de cada tipo.

**Rendimiento — cuidado si se toca `buildAllCompsIndex`**: esta función tenía
un bug real de rendimiento (sin caché, recorría 47k filas en cada uno de miles
de árboles → ~12.5 minutos). Se agregó caché (`__allCompsIndexCache`, mismo
patrón que los otros índices) y bajó a <1 segundo para ~4,500 productos. Si se
agregan más índices sin caché en un bucle de miles de iteraciones, va a volver
a pasar.

---

## 5. Chat con IA (Gemini) — **BUG PENDIENTE, sin resolver**

### Arquitectura
El HTML nunca conoce ninguna API key. Le habla a un endpoint propio desplegado
en Vercel (`api/chat-ia.js`, entregado junto a este README, carpeta `api/` en
la raíz del proyecto de Vercel), que sí conoce las keys de Gemini vía
variables de entorno (`GEMINI_API_KEY_1` a `_5`, con rotación automática si
una falla por cuota/validez — ver comentarios en el propio archivo).

El HTML solo manda `{ pregunta, vista, columnas, filtrosExistentes }` — NUNCA
los datos de SAP. El endpoint arma un prompt para Gemini pidiendo JSON
estructurado `{ tipo, razonamiento, condiciones, sugerencias }`, valida que
los operadores sean del vocabulario fijo (`OPERADORES_VALIDOS`), y lo devuelve.
El HTML traduce esas condiciones a un predicado real
(`evaluarCondicion`/`activarFiltroIA`) que se engancha en los sistemas de
filtro YA EXISTENTES de MM y BOM vía `window.__iaChatExtraFilter` (revisar
`applyFiltersCore` en MM y `matchesFilters` en BOM para ver el hook).

Endpoint desplegado por el usuario:
`https://listas-de-materiales.vercel.app/api/chat-ia` (ya viene precargado
por defecto en el HTML, variable `ENDPOINT_POR_DEFECTO` dentro del módulo del
chat — configurable desde el ícono de engranaje del panel si cambia).

### El bug sin resolver

El usuario reporta **error 405 ("Método no permitido")** al usar el chat desde
la app real. Diagnóstico hecho hasta ahora:

- El endpoint (`api/chat-ia.js`) en sí mismo, probado localmente con Node
  simulando `req`/`res`, funciona correctamente en todos los escenarios
  (sin key, rotación de keys, todas las keys agotadas, error no rotable) — no
  hay evidencia de que la LÓGICA del archivo esté mal.
- La estructura de carpetas en GitHub/Vercel es correcta:
  `api/chat-ia.js` está en la raíz del repo, junto a `index.html`,
  `package.json`, `vercel.json` (confirmado con capturas de pantalla del
  usuario).
- **No se pudo probar el endpoint real en vivo** — el entorno de Claude (este
  entorno de trabajo) no tiene salida de red hacia dominios externos
  arbitrarios (bloqueado por allowlist de su sandbox), así que cualquier
  `curl`/`fetch` de prueba hacia `listas-de-materiales.vercel.app` falla con
  403 del PROPIO sandbox, no del servidor real — ese resultado no sirve como
  diagnóstico.
- Se actualizó `vercel.json` para declarar el runtime explícitamente
  (`"runtime": "nodejs20.x"`) por si la ambigüedad de runtime estaba causando
  que Vercel no reconociera bien la función — sin confirmar todavía si esto
  resolvió el problema real.

**Siguiente paso sugerido para Claude Code** (con acceso real a la red o al
propio panel de Vercel del usuario):
1. Pedir al usuario que abra `https://listas-de-materiales.vercel.app/api/chat-ia`
   directamente en el navegador (GET simple). Si devuelve
   `{"error":"Método no permitido. Usa POST."}` en JSON, la función SÍ está
   desplegada y el problema es de cómo el HTML arma el POST (revisar CORS,
   mixed content, la consola de red del navegador). Si en cambio devuelve el
   propio `index.html` de la app, o un 404 de Vercel, la función NUNCA se
   desplegó como API — hay que revisar el panel de Vercel
   (Deployments → Functions) para confirmar si `api/chat-ia` aparece listada.
2. Revisar si el proyecto de Vercel tiene alguna protección de despliegue
   (Vercel Deployment Protection / SSO) activada, que devolvería 401/403 en
   vez de ejecutar la función.
3. Confirmar que las 5 variables de entorno `GEMINI_API_KEY_1`..`_5` (o al
   menos la 1) estén realmente configuradas en Vercel → Settings →
   Environment Variables, y que se haya hecho un REDEPLOY después de
   agregarlas (Vercel no las aplica a deployments ya hechos antes de
   guardarlas).

### Seguridad — nota importante
El usuario pegó 3 API keys reales de Gemini directamente en el chat de
Claude en un mensaje anterior de esta conversación. Se le recomendó
explícitamente **revocarlas y generar nuevas** en Google AI Studio, ya que
quedaron en el historial de la conversación. Confirmar si ya lo hizo antes de
usar cualquier key vieja.

---

## 6. Convenciones de código a respetar

- **Nunca duplicar lógica de cálculo del árbol.** Todo lo que necesite
  construir/leer un árbol de producto debe usar `window.__arbolAPI` (objeto
  expuesto al final del módulo APP 3) — Explosión masiva y la Auditoría de
  incoherencias ya lo hacen así, es el patrón a seguir.
- **Todas las funciones de índice sobre datos grandes deben tener caché**
  (mismo patrón `__xxxIndexCache = { rowsRef, index }`, invalidado solo si
  cambia la referencia del array de origen). Ver `buildBomIndex`,
  `buildVfabIndex`, `buildCompFirstPosIndex`, `buildAllCompsIndex`.
- **Nunca inventar una Versión de Fabricación** cuando exista un dato real
  disponible — es una regla de producto explícita, no solo de estilo.
- **Cruces de listas de materiales siempre por Material + Alternativa + Lista
  de materiales (ID técnico)**, nunca solo por Material + Alternativa.
- Los exportadores a Excel usan `xlsx-js-style` (cargado por CDN, variable
  global `XLSX`) para poder aplicar `fill`, `font`, `border` y comentarios de
  celda (`ws[addr].c = [{ a: autor, t: texto }]`) — la librería base `xlsx`
  (SheetJS) no soporta estilos.
- El proyecto no tiene build step ni bundler — es un solo `.html` con
  `<script>` inline y CDNs. Si se decide modularizar/migrar a un framework,
  es un cambio de arquitectura grande a discutir con el usuario primero, no
  algo a hacer de forma incremental sin avisar.

---

## 7. Archivos entregados junto a este README

- `index.html` — la app completa (se entrega aparte, este README la referencia).
- `api/chat-ia.js` — función serverless del chat con IA, con rotación de keys.
- `package.json`, `vercel.json` — configuración mínima de despliegue en Vercel.
