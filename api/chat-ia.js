/**
 * Endpoint serverless de Vercel: /api/chat-ia
 *
 * Cerebro del "Chat de consulta" de la aplicación. El navegador nunca conoce
 * ninguna API key: le habla a este endpoint, y solo este endpoint (que corre en
 * el servidor de Vercel) conoce las keys de Gemini.
 *
 * El chat NO es un traductor de preguntas a filtros: es un asistente que razona
 * sobre el Maestro de Materiales y las Listas de Materiales. Para poder hacerlo
 * sin que el servidor guarde ni reciba la base entera, el trabajo se reparte en
 * DOS FASES, y el navegador es quien ejecuta las consultas contra los datos que
 * ya tiene cargados en memoria:
 *
 *   fase "planificar": recibe la pregunta + el contexto de la vista (nombres de
 *     columnas, qué archivos hay cargados, historial de la conversación) y
 *     devuelve qué HERRAMIENTAS hay que ejecutar en el navegador.
 *   fase "responder": recibe las OBSERVACIONES (el resultado real de esas
 *     herramientas, ya acotado por el navegador) y redacta la respuesta.
 *
 * Cuando la pregunta no necesita datos (un saludo, "¿qué puedes hacer?"), la
 * fase "planificar" devuelve cero acciones y su propio mensaje: ahí se acaba,
 * con una sola llamada al modelo.
 *
 * ROTACIÓN DE KEYS: se configuran hasta 5 keys (GEMINI_API_KEY_1 .. _5). Si una
 * llamada falla por cuota agotada (HTTP 429) o por key inválida/revocada (HTTP
 * 400/403), se reintenta automáticamente con la siguiente key de la lista,
 * hasta agotarlas todas. Un error de otro tipo (prompt inválido, respuesta mal
 * formada, etc.) NO dispara reintento, porque fallaría igual con cualquier key.
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Vocabulario fijo de operadores que el filtro del navegador sabe aplicar. Se le
// pasa esta lista al modelo explícitamente para que SOLO elija de aquí — así el
// cliente nunca recibe un operador que no sepa interpretar.
const OPERADORES_VALIDOS = [
  'igual', 'distinto', 'contiene', 'no_contiene',
  'mayor_que', 'menor_que', 'mayor_o_igual', 'menor_o_igual',
  'ultimos_dias', 'antes_de', 'despues_de',
  'filtro_existente'
];

/* Catálogo de herramientas: única fuente de verdad. De aquí sale tanto el texto
   que lee el modelo como la validación de lo que responde — si se agrega una
   herramienta nueva en el navegador, se agrega aquí y en ningún otro sitio del
   servidor. */
const HERRAMIENTAS = [
  {
    nombre: 'buscar_material',
    args: '{ "texto": "código o parte de la descripción" }',
    desc: 'Busca materiales por código o por descripción, en el Maestro y en las Listas. Es el primer paso obligatorio cuando la persona nombra un producto con palabras en vez de con su código.'
  },
  {
    nombre: 'ficha_material',
    args: '{ "material": "código exacto" }',
    desc: 'Ficha del Maestro de Materiales: descripción, tipo, unidad, estado de bloqueo (Z1/Z2/Z3), texto de inspección, Categoría 3, código antiguo, fechas y quién lo creó.'
  },
  {
    nombre: 'listas_de_material',
    args: '{ "material": "código exacto" }',
    desc: 'Las listas de materiales (alternativas) que tiene ese material: alternativa, etapa, estado Activo/Inactivo, centro, lista técnica, número de componentes y sus versiones de fabricación.'
  },
  {
    nombre: 'componentes_de_lista',
    args: '{ "material": "código exacto", "alt": "alternativa" }',
    desc: 'Las posiciones de una lista concreta: número de posición, componente, denominación, cantidad, unidad y si el componente está bloqueado en el Maestro.'
  },
  {
    nombre: 'donde_se_usa',
    args: '{ "material": "código exacto", "solo_activas": true }',
    desc: 'Listas que usan ese material COMO COMPONENTE (uso inverso). Es la herramienta de "en qué listas aparece este material"; con solo_activas en true descarta las listas inactivas.'
  },
  {
    nombre: 'versiones_fabricacion',
    args: '{ "material": "código exacto", "alt": "alternativa (opcional)" }',
    desc: 'Versiones de fabricación REALES registradas en SAP para ese material (opcionalmente de una sola alternativa), con su centro y si están bloqueadas.'
  },
  {
    nombre: 'arbol_producto',
    args: '{ "material": "código exacto", "alt": "alternativa (opcional)", "combinacion": 0 }',
    desc: 'Reconstruye la cadena Acondicionado -> Envase -> Fabricación de un producto y la dibuja en el chat. Si el material tiene varias alternativas y no se indica "alt", devuelve las opciones para que preguntes cuál.'
  },
  {
    nombre: 'filtrar_tabla',
    args: '{ "condiciones": [ { "columna": "...", "operador": "...", "valor": "..." } ] }',
    desc: 'Recorta la tabla que la persona tiene delante en la pestaña activa. Úsala cuando quiere VER un subconjunto en pantalla, no cuando quiere que le cuentes algo.'
  },
  {
    nombre: 'contar_filas',
    args: '{ "condiciones": [ ... ] }',
    desc: 'Cuenta cuántas filas de la tabla actual cumplen unas condiciones, sin tocar lo que se ve en pantalla.'
  }
];

const NOMBRES_HERRAMIENTAS = HERRAMIENTAS.map((h) => h.nombre);
const MAX_ACCIONES = 3;

/* Esquemas de salida (subconjunto de OpenAPI 3.0 que acepta Gemini vía
   generationConfig.responseSchema). Sin esto, "responseMimeType: application/json"
   por sí solo no impide que el modelo divague en el razonamiento hasta cortar el
   JSON a mitad, o que lo envuelva en texto/markdown — el error "la respuesta de
   Gemini no fue un JSON válido" viene casi siempre de ahí. Con el schema, la API
   fuerza la forma exacta antes de devolver nada.

   "argumentos" reúne TODOS los campos posibles de TODAS las herramientas en un
   único objeto opcional-por-campo (Gemini no soporta un objeto de forma libre) —
   cada herramienta usa solo los suyos, el resto los deja vacíos. */
const ARGUMENTOS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    texto: { type: 'STRING' },
    material: { type: 'STRING' },
    alt: { type: 'STRING' },
    combinacion: { type: 'INTEGER' },
    solo_activas: { type: 'BOOLEAN' },
    condiciones: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          columna: { type: 'STRING' },
          operador: { type: 'STRING', enum: OPERADORES_VALIDOS },
          valor: { type: 'STRING' }
        },
        required: ['operador', 'valor']
      }
    }
  }
};

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    razonamiento: { type: 'STRING' },
    acciones: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          herramienta: { type: 'STRING', enum: NOMBRES_HERRAMIENTAS },
          argumentos: ARGUMENTOS_SCHEMA
        },
        required: ['herramienta', 'argumentos']
      }
    },
    mensaje: { type: 'STRING' },
    sugerencias: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['razonamiento', 'acciones']
};

const RESPUESTA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mensaje: { type: 'STRING' },
    razonamiento: { type: 'STRING' },
    sugerencias: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['mensaje']
};

/* Conocimiento del dominio. Va en las dos fases porque es lo que le permite
   razonar de verdad (qué significa una alternativa 66, por qué una versión de
   fabricación "1204" no cuadra con una alternativa 1) en vez de limitarse a
   repetir celdas. Es la misma lógica que implementa la aplicación, resumida. */
const BRIEFING = `CONTEXTO DEL NEGOCIO (planta farmacéutica peruana, equipo de QA/DOC; datos exportados de SAP)

- La aplicación tiene cuatro pestañas: Maestro de Materiales (ficha de cada material), Listas de Materiales (las listas/BOM y sus componentes), Árbol del producto (la cadena de fabricación reconstruida) y Explosión masiva.
- Una LISTA DE MATERIALES se identifica por Material + Alternativa (columna "Lista mat.alternat.") + el id técnico de 8 dígitos (columna "Lista de materiales"). Cruzar solo por Material + Alternativa mezcla listas técnicas distintas.
- Solo cuentan las filas con Utilización LMat = 1; el mismo material puede tener otras utilizaciones (p. ej. fórmula cuali-cuantitativa) que no son la lista real de producción.
- ETAPAS de la cadena, de la más nueva a la más antigua: Acondicionado (el producto terminado) -> Envase -> a veces Recubrimiento/Inspección -> Fabricación. Se retrocede por el componente de la posición 0010 de cada lista.
- VERSIÓN DE FABRICACIÓN (VFab): código de 4 caracteres. Dígito 1 = la alternativa de Fabricación de la que desciende TODA la cadena, y debe ser el mismo en todas las etapas (si no, es una incoherencia real de SAP). Dígito 2 = la alternativa de la etapa previa (1-9 directas; C-Z son alternativas de conciliación 66-90, con C=66, D=67...; 0 = no hay etapa previa). Dígitos 3-4 = la alternativa propia de esa etapa, que debe coincidir con la alternativa registrada en su lista.
- Alternativas 66-90: listas de CONCILIACIÓN. Alternativas 95-99: REACONDICIONADO, con VFab del tipo 00 + alternativa (0099) y sin etapa previa real.
- ESTADOS DE MATERIAL en el Maestro: Z1/Z2 son bloqueos parciales y Z3 es bloqueo definitivo. Una lista con estado "Inactivo" sigue existiendo en SAP pero no debería usarse.
- CATEGORÍA 3: materiales cuyo texto de inspección los marca como categoría 3; la aplicación los señala pero nunca modifica SAP.
- La aplicación NUNCA inventa una versión de fabricación: si una VFab no viene del archivo real, se marca como estimada.`;

/* Reúne las keys configuradas, en orden: GEMINI_API_KEY_1 .. GEMINI_API_KEY_5.
   También se acepta GEMINI_API_KEY (sin número) como una key más al final de la
   lista, por si ya la tenías configurada así desde antes de la rotación — así
   no hace falta borrarla al agregar las nuevas. Se descartan huecos/duplicados. */
function obtenerApiKeys() {
  const keys = [];
  for (let i = 1; i <= 5; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  const legacy = process.env.GEMINI_API_KEY;
  if (legacy && legacy.trim() && !keys.includes(legacy.trim())) keys.push(legacy.trim());
  return keys;
}

/* Códigos de error de Gemini que justifican probar la SIGUIENTE key: 429 (cuota
   agotada / rate limit) y 400/403 cuando el detalle menciona la key (inválida,
   expirada, sin permiso) — el resto de errores 4xx/5xx no se relacionan con
   cuál key se usó, así que no tiene sentido rotar por ellos. */
function debeRotarKey(status, detalleTexto) {
  if (status === 429) return true;
  if (status === 400 || status === 403) {
    const t = (detalleTexto || '').toLowerCase();
    return t.includes('api key') || t.includes('api_key') || t.includes('permission') || t.includes('invalid');
  }
  return false;
}

module.exports = async (req, res) => {
  // CORS básico: el HTML puede vivir en cualquier dominio/estático (incluso
  // abierto localmente), así que se permite cualquier origen para este endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido. Usa POST.' });
    return;
  }

  const apiKeys = obtenerApiKeys();
  if (apiKeys.length === 0) {
    res.status(500).json({
      error: 'El servidor no tiene configurada ninguna API key de Gemini. Agrega GEMINI_API_KEY_1 (y opcionalmente _2 a _5) en Vercel → Settings → Environment Variables y vuelve a desplegar.'
    });
    return;
  }

  const cuerpo = req.body || {};
  const fase = cuerpo.fase === 'responder' ? 'responder' : 'planificar';
  const { pregunta, vista, columnas, filtrosExistentes, historial, contexto, observaciones } = cuerpo;

  if (!pregunta || typeof pregunta !== 'string' || !pregunta.trim()) {
    res.status(400).json({ error: 'Falta el campo "pregunta" en el cuerpo de la solicitud.' });
    return;
  }
  // Las columnas solo hacen falta para PLANIFICAR (son las que puede nombrar un
  // filtro). Al redactar la respuesta ya no se arma ninguna condición, así que
  // exigirlas ahí solo serviría para romper la segunda llamada sin motivo.
  if (fase === 'planificar' && (!Array.isArray(columnas) || columnas.length === 0)) {
    res.status(400).json({ error: 'Falta el campo "columnas" (lista de columnas disponibles en la vista actual).' });
    return;
  }

  const prompt = fase === 'responder'
    ? construirPromptRespuesta({ pregunta, vista, historial, contexto, observaciones })
    : construirPromptPlan({ pregunta, vista, columnas, filtrosExistentes, historial, contexto });

  // Planificar es una decisión mecánica (qué herramienta y con qué argumentos):
  // temperatura casi nula. Redactar es lo contrario — algo de temperatura evita
  // que todas las respuestas suenen calcadas — y necesita más espacio de salida.
  const generationConfig = fase === 'responder'
    ? { temperature: 0.45, maxOutputTokens: 2048, responseMimeType: 'application/json', responseSchema: RESPUESTA_SCHEMA }
    : { temperature: 0.1, maxOutputTokens: 1536, responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA };

  let ultimoError = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    try {
      const respuestaGemini = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig
        })
      });

      if (!respuestaGemini.ok) {
        const detalle = await respuestaGemini.text().catch(() => '');
        if (debeRotarKey(respuestaGemini.status, detalle)) {
          // Se agota o falla esta key por cuota/validez: se guarda el detalle y se
          // prueba la siguiente — el error solo se reporta si TODAS las keys fallan
          // (ver el bloque final, después del for).
          ultimoError = { status: respuestaGemini.status, detalle };
          continue;
        }
        // Error que NO se relaciona con cuál key se usó (ej. prompt rechazado,
        // parámetros inválidos): fallaría igual con cualquier otra key, así que se
        // reporta de inmediato en vez de malgastar las keys restantes.
        res.status(502).json({
          error: `Gemini respondió con error (${respuestaGemini.status}).`,
          detalle,
          keysIntentadas: i + 1
        });
        return;
      }

      const data = await respuestaGemini.json();
      const candidato = data?.candidates?.[0];
      const textoJson = candidato?.content?.parts?.[0]?.text;
      if (!textoJson) {
        // Sin texto y finishReason lo explica (ej. bloqueado por el filtro de
        // seguridad de Gemini, "SAFETY"): se lo decimos a la persona en vez de un
        // "no devolvió contenido" genérico que no orienta a nada.
        const motivo = candidato?.finishReason;
        res.status(502).json({
          error: motivo && motivo !== 'STOP'
            ? `Gemini no generó respuesta (motivo: ${motivo}). Reformula la pregunta e inténtalo de nuevo.`
            : 'Gemini no devolvió contenido interpretable.'
        });
        return;
      }

      const interpretacion = extraerJSON(textoJson);
      if (!interpretacion) {
        // La causa más común es un corte por límite de longitud a mitad del JSON
        // (finishReason "MAX_TOKENS"): se distingue para que el mensaje oriente a
        // reformular más corto en vez de sonar a una falla aleatoria del servidor.
        const cortado = candidato?.finishReason === 'MAX_TOKENS';
        res.status(502).json({
          error: cortado
            ? 'La respuesta de Gemini se cortó por longitud antes de terminar. Prueba con una pregunta más acotada.'
            : 'La respuesta de Gemini no fue un JSON válido.',
          detalle: cortado ? undefined : textoJson.slice(0, 500)
        });
        return;
      }

      res.status(200).json(sanear(interpretacion, fase));
      return;
    } catch (err) {
      // Error de red/conexión (no de Gemini en sí): se guarda y se prueba la
      // siguiente key — el reporte final ocurre en el bloque después del bucle si
      // se agotan todas.
      ultimoError = { detalle: String((err && err.message) || err) };
      continue;
    }
  }

  // Si se llegó aquí, todas las keys configuradas fallaron (por cuota, validez, o
  // error de red en cada intento).
  res.status(503).json({
    error: `Se agotaron o fallaron las ${apiKeys.length} API key(s) de Gemini configuradas. Agrega una nueva key o espera a que se restablezca la cuota.`,
    detalle: ultimoError && ultimoError.detalle,
    keysIntentadas: apiKeys.length
  });
};


/* Intenta interpretar el texto del modelo como JSON, tolerando lo que
   "responseMimeType: application/json" debería evitar pero no siempre evita:
   fences de markdown (```json ... ```) alrededor, o texto colgando antes/después
   del objeto. Devuelve null si de verdad no hay un JSON recuperable — nunca
   lanza, para que el llamador decida cómo reportarlo. */
function extraerJSON(texto) {
  try { return JSON.parse(texto); } catch (e) { /* sigue con los respaldos */ }

  const sinFences = texto.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  if (sinFences !== texto) {
    try { return JSON.parse(sinFences); } catch (e) { /* sigue con el último respaldo */ }
  }

  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio !== -1 && fin > inicio) {
    try { return JSON.parse(texto.slice(inicio, fin + 1)); } catch (e) { /* no hay más que intentar */ }
  }
  return null;
}

/* ============================================================
   Saneamiento de la respuesta del modelo

   El navegador ejecuta lo que salga de aquí contra los datos reales, así que
   nada llega al cliente sin pasar por esta puerta: herramientas fuera del
   catálogo, operadores inventados o campos con el tipo equivocado se descartan
   aquí, no allá.
   ============================================================ */
function textoLimpio(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max) : t;
}

function sanear(bruto, fase) {
  const out = {};

  const mensaje = textoLimpio(bruto && bruto.mensaje, 2500);
  if (mensaje) out.mensaje = mensaje;

  const razonamiento = textoLimpio(bruto && bruto.razonamiento, 1200);
  if (razonamiento) out.razonamiento = razonamiento;

  if (Array.isArray(bruto && bruto.sugerencias)) {
    const sugerencias = bruto.sugerencias
      .map((s) => textoLimpio(s, 110))
      .filter(Boolean)
      .slice(0, 3);
    if (sugerencias.length) out.sugerencias = sugerencias;
  }

  if (fase === 'planificar') {
    out.acciones = saneaAcciones(bruto && bruto.acciones);
  }
  return out;
}

function saneaAcciones(acciones) {
  if (!Array.isArray(acciones)) return [];
  const limpias = [];
  for (const accion of acciones) {
    if (!accion || !NOMBRES_HERRAMIENTAS.includes(accion.herramienta)) continue;
    const argumentos = (accion.argumentos && typeof accion.argumentos === 'object' && !Array.isArray(accion.argumentos))
      ? accion.argumentos
      : {};

    // Las dos herramientas que arman condiciones son las únicas que el navegador
    // traduce a un predicado ejecutable: una condición con un operador inventado
    // se descarta aquí en vez de dejar que el cliente la ignore en silencio.
    if (accion.herramienta === 'filtrar_tabla' || accion.herramienta === 'contar_filas') {
      const condiciones = Array.isArray(argumentos.condiciones)
        ? argumentos.condiciones.filter((c) => c && OPERADORES_VALIDOS.includes(c.operador))
        : [];
      if (!condiciones.length) continue; // sin condiciones válidas la acción no hace nada
      argumentos.condiciones = condiciones;
    }

    limpias.push({ herramienta: accion.herramienta, argumentos });
    if (limpias.length >= MAX_ACCIONES) break;
  }
  return limpias;
}


/* ============================================================
   Prompts
   ============================================================ */
function bloqueHistorial(historial) {
  if (!Array.isArray(historial) || !historial.length) return '(esta es la primera pregunta de la conversación)';
  return historial
    .slice(-8)
    .map((t) => `${t && t.rol === 'asistente' ? 'TÚ' : 'PERSONA'}: ${textoLimpio(t && t.texto, 500)}`)
    .filter((l) => l.length > 8)
    .join('\n');
}

function bloqueContexto(contexto) {
  const c = (contexto && typeof contexto === 'object') ? contexto : {};
  const lineas = [
    `- Maestro de Materiales cargado: ${c.mmCargado ? `sí (${c.mmFilas || 0} materiales)` : 'NO'}`,
    `- Listas de Materiales cargadas: ${c.bomCargado ? `sí (${c.bomFilas || 0} listas)` : 'NO'}`,
    `- Componentes cargados: ${c.compCargados ? 'sí' : 'NO'}`,
    `- Versiones de fabricación cargadas: ${c.vfabCargadas ? 'sí' : 'NO'}`
  ];
  if (c.filasVisibles !== undefined) {
    lineas.push(`- Filas visibles ahora mismo en la tabla de la pestaña activa: ${c.filasVisibles}${c.filtroIaActivo ? ' (hay un filtro puesto por ti en una respuesta anterior)' : ''}`);
  }
  return lineas.join('\n');
}

const VOZ = `CÓMO HABLAS
- En español, tuteando, con la naturalidad de un colega que conoce la planta y los datos. Nada de lenguaje comercial ni de fórmulas de manual.
- Vas al grano: primero la respuesta, después el detalle que la sostiene. Si la pregunta es simple, dos frases bastan; si es de análisis, puedes usar viñetas cortas.
- Puedes dar formato: **negrita** para lo importante, viñetas que empiezan con "- ", y \`código\` para códigos de material, alternativas y versiones de fabricación.
- Nunca adulas ("¡excelente pregunta!") ni te disculpas de más. Si algo no se puede saber con los datos cargados, lo dices claro y ofreces el camino más cercano.
- Nunca inventas un dato. Todo número, código o estado que menciones tiene que venir de las observaciones que te pasa la aplicación.
- Cuando la persona te pide algo que necesita precisar (un producto con varias listas, una descripción que casa con varios materiales), haces UNA pregunta concreta con las opciones reales delante, no una pregunta abierta.`;

/* FASE 1 — decide qué consultar. */
function construirPromptPlan({ pregunta, vista, columnas, filtrosExistentes, historial, contexto }) {
  const listaColumnas = (columnas || []).map((c) => `- "${c}"`).join('\n');
  const listaFiltros = (Array.isArray(filtrosExistentes) ? filtrosExistentes : [])
    .map((f) => `- "${f.nombre}": ${f.descripcion}`)
    .join('\n') || '(ninguno para esta vista)';
  const catalogo = HERRAMIENTAS
    .map((h) => `- ${h.nombre} ${h.args}\n  ${h.desc}`)
    .join('\n');

  return `Eres el asistente de consulta de una aplicación interna que trabaja sobre datos de SAP: Maestro de Materiales y Listas de Materiales. Tu trabajo no es filtrar tablas: es entender lo que la persona necesita saber y averiguarlo.

${BRIEFING}

${VOZ}

ESTADO DE LOS DATOS EN EL NAVEGADOR
${bloqueContexto(contexto)}

PESTAÑA ABIERTA AHORA: ${vista || '(desconocida)'}

COLUMNAS DE LA TABLA DE ESA PESTAÑA (nombres EXACTOS, solo válidos para filtrar_tabla y contar_filas):
${listaColumnas}

FILTROS ESPECIALES QUE YA EXISTEN EN LA APLICACIÓN (para el operador "filtro_existente", con "valor" = el nombre exacto):
${listaFiltros}

CONVERSACIÓN HASTA AHORA
${bloqueHistorial(historial)}

MENSAJE NUEVO DE LA PERSONA:
"${pregunta}"

TU TAREA AHORA: decidir qué hace falta CONSULTAR para poder responder. El navegador ejecutará las herramientas que pidas contra los datos reales que tiene cargados y te devolverá los resultados para que redactes la respuesta en un segundo paso.

HERRAMIENTAS DISPONIBLES
${catalogo}

REGLAS PARA ELEGIR
1. Como máximo ${MAX_ACCIONES} acciones, y solo las que de verdad hagan falta. Si con una basta, pide una.
2. Nunca inventes un código de material. Si la persona nombra el producto con palabras, la primera acción es buscar_material con esas palabras. Si el código ya salió antes en la conversación, reutilízalo.
3. Para "en qué listas está este material" usa donde_se_usa, NO filtrar_tabla: la tabla de listas no busca por componente.
4. Para el árbol de fabricación usa arbol_producto. Si no sabes la alternativa, llámala igual sin "alt": te devolverá las opciones reales para que preguntes cuál.
5. Usa filtrar_tabla solo cuando la persona quiere VER un subconjunto en la tabla de la pestaña abierta, y únicamente con columnas de la lista de arriba.
6. Si el mensaje no necesita datos (un saludo, "¿qué puedes hacer?", una pregunta sobre cómo funciona algo que ya sabes por el contexto de negocio), devuelve "acciones": [] y escribe tú la respuesta completa en "mensaje".
7. Si hace falta algo que no está cargado (te piden componentes y no hay componentes cargados), devuelve "acciones": [] y dilo en "mensaje".

Responde ÚNICAMENTE con un objeto JSON, sin markdown y sin texto alrededor:
{
  "razonamiento": "una o dos frases, en primera persona, sobre qué vas a mirar y por qué (esto se le muestra a la persona mientras espera)",
  "acciones": [ { "herramienta": "nombre exacto del catálogo", "argumentos": { } } ],
  "mensaje": "SOLO si acciones está vacío: tu respuesta completa",
  "sugerencias": ["solo si acciones está vacío: 2 o 3 continuaciones, escritas como las teclearía la persona"]
}`;
}

/* FASE 2 — redacta con los datos reales delante. */
function construirPromptRespuesta({ pregunta, vista, historial, contexto, observaciones }) {
  let obsTexto;
  try {
    obsTexto = JSON.stringify(observaciones === undefined ? [] : observaciones, null, 1);
  } catch (e) {
    obsTexto = '[]';
  }
  // Guarda de tamaño: un resultado enorme no aporta más criterio y sí puede
  // reventar el límite de tokens de la llamada. El navegador ya acota cada
  // herramienta; esto es la red por si alguna se le escapa.
  if (obsTexto.length > 60000) obsTexto = obsTexto.slice(0, 60000) + '\n… (recortado)';

  return `Eres el asistente de consulta de una aplicación interna que trabaja sobre datos de SAP: Maestro de Materiales y Listas de Materiales.

${BRIEFING}

${VOZ}

ESTADO DE LOS DATOS EN EL NAVEGADOR
${bloqueContexto(contexto)}

PESTAÑA ABIERTA AHORA: ${vista || '(desconocida)'}

CONVERSACIÓN HASTA AHORA
${bloqueHistorial(historial)}

MENSAJE AL QUE RESPONDES:
"${pregunta}"

OBSERVACIONES — resultado real de las consultas que pediste, ejecutadas por la aplicación sobre los datos cargados. Esta es tu ÚNICA fuente de hechos:
${obsTexto}

CÓMO REDACTAR
- Responde exactamente lo que se preguntó, con los datos de las observaciones. Empieza por la conclusión.
- Interpreta, no recites: si ves una versión de fabricación cuyos dígitos 3-4 no coinciden con la alternativa de su lista, o una lista inactiva, o un material con Z3, dilo y explica qué implica. Ese análisis es la mitad de tu valor.
- La aplicación ya está dibujando debajo de tu mensaje las tarjetas con los resultados (tablas, árbol, conteos). No repitas fila por fila lo que ya se ve: resume, señala lo que importa y comenta las excepciones.
- Si una observación viene recortada ("truncado": true), dilo en una frase en vez de dar por hecho que eso es todo.
- Si las observaciones no alcanzan para responder, dilo con claridad y propón la consulta que sí lo resolvería.
- Si hay varias opciones posibles (varios materiales que casan, varias alternativas), pregunta cuál con las opciones reales listadas, y que las "sugerencias" sean justo esas opciones.
- Extensión: lo que pida la pregunta. Un dato puntual, dos frases. Un análisis, hasta unas seis líneas o viñetas.

Responde ÚNICAMENTE con un objeto JSON, sin markdown y sin texto alrededor:
{
  "mensaje": "tu respuesta para la persona",
  "razonamiento": "una o dos frases sobre cómo llegaste a ella (se muestra plegado, es opcional pero útil)",
  "sugerencias": ["2 o 3 continuaciones concretas, escritas en primera persona como las teclearía la persona"]
}`;
}
