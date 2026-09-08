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
    nombre: 'cambiar_pestana',
    args: '{ "pestana": "mm | bom | arbol | explosion" }',
    desc: 'Cambia la pestaña que se ve en pantalla (mm = Maestro de Materiales, bom = Listas de Materiales, arbol = Árbol del producto, explosion = Explosión masiva). Úsala ANTES de filtrar_tabla cuando lo que piden vive en otra pestaña: filtrar_tabla siempre actúa sobre la que esté abierta.'
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
// Último escalón de exigencia: sin ningún parámetro opcional, el JSON se pide solo en el
// texto del prompt. Es el modo con el que funcionaba antes y sirve de red para cualquier
// modelo que no admita responseSchema ni thinkingConfig.
const NIVEL_MINIMO_TEXTO = 3;

/* Escalón desde el que arrancar. Vive fuera del handler a propósito: Vercel reutiliza la
   instancia entre peticiones, así que una vez descubierto que este modelo rechaza, por
   ejemplo, thinkingConfig, las siguientes preguntas ya no vuelven a gastar una llamada
   para que Google lo repita. Se queda en 0 mientras el modelo lo admita todo, y si el
   despliegue se enfría simplemente se vuelve a aprender en la primera pregunta. */
let nivelAprendido = 0;

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
    pestana: { type: 'STRING', enum: ['mm', 'bom', 'arbol', 'explosion'] },
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
  // Se leen hasta 10 numeradas (antes solo 5): una GEMINI_API_KEY_6 configurada en Vercel
  // se quedaba sin usar sin que nada lo dijera.
  for (let i = 1; i <= 10; i++) {
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
/* Solo se cambia de key cuando el fallo es DE LA KEY. Antes bastaba con que el detalle
   contuviera "invalid" y eso barría demasiado: un "Invalid JSON payload" o un nombre de
   modelo mal escrito son errores de configuración que fallan igual con las seis keys, pero
   se contaban como keys quemadas y acababan reportados como "se agotaron tus API keys" —
   mandando a revisar la cuota por un problema que no estaba ahí. */
function debeRotarKey(status, detalleTexto) {
  if (status === 429) return true;
  if (status === 400 || status === 403) {
    const t = (detalleTexto || '').toLowerCase();
    if (esErrorDePensamiento(status, detalleTexto)) return false; // no es la key, es el parámetro
    return t.includes('api key') || t.includes('api_key') ||
           t.includes('api key not valid') || t.includes('permission denied') ||
           t.includes('permission_denied') || t.includes('unauthenticated');
  }
  return false;
}

/* Sobrecarga o fallo pasajero del servicio (el 503 "model is overloaded" que
   devuelve Gemini en horas punta). No tiene que ver con la key: cambiarla no
   ayuda, lo que ayuda es reintentar un momento después. */
function esErrorTransitorio(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/* El modelo rechaza thinkingConfig (no todos admiten desactivar el razonamiento
   interno, y alguno exige un presupuesto mínimo). Se reconoce para reintentar sin
   ese campo en vez de tratarlo como una key inválida. */
function esErrorDePensamiento(status, detalleTexto) {
  if (status !== 400) return false;
  const t = (detalleTexto || '').toLowerCase();
  return t.includes('thinking') || t.includes('thinking_budget') || t.includes('thinkingbudget');
}

module.exports = async (req, res) => {
  // CORS básico: el HTML puede vivir en cualquier dominio/estático (incluso
  // abierto localmente), así que se permite cualquier origen para este endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKeys = obtenerApiKeys();

  /* Diagnóstico: abrir /api/chat-ia?diagnostico=1 en el navegador contesta si el modelo
     configurado existe de verdad para estas keys, y qué modelos sí están disponibles. Es
     la forma rápida de distinguir "se acabó la cuota" de "el nombre del modelo está mal",
     que desde el mensaje de error del chat se confunden con facilidad.
     No devuelve ninguna key: solo cuántas hay configuradas. */
  if (req.method === 'GET' && req.url && req.url.indexOf('diagnostico') !== -1) {
    if (apiKeys.length === 0) {
      res.status(500).json({ error: 'No hay ninguna API key de Gemini configurada en este despliegue.' });
      return;
    }
    // Presupuesto propio del diagnóstico: encadena bastantes llamadas (listar modelos +
    // hasta 4 niveles × varias keys + un barrido de todas las keys), y sin un tope
    // explícito eso es justo lo que lo hacía correr hasta que Vercel mataba la función de
    // golpe con un 504 en vez de devolver el informe parcial que ya tenía reunido. Mismo
    // margen que el flujo principal: solo se autoriza un intento más si incluso colgándose
    // entero seguiría cabiendo (ver el comentario largo junto a quedaTiempo, más abajo).
    const LIMITE_DIAG_MS = 9000;
    const inicioDiag = Date.now();
    const quedaTiempoDiag = () => (Date.now() - inicioDiag + TIMEOUT_LLAMADA_MS) <= LIMITE_DIAG_MS;

    try {
      const controladorLista = new AbortController();
      const corteLista = setTimeout(() => controladorLista.abort(), TIMEOUT_LLAMADA_MS);
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKeys[0]}&pageSize=200`, { signal: controladorLista.signal });
      } finally {
        clearTimeout(corteLista);
      }
      const cuerpoLista = await r.json().catch(() => null);
      if (!r.ok) {
        res.status(502).json({
          modeloConfigurado: GEMINI_MODEL,
          keysConfiguradas: apiKeys.length,
          error: `Google respondió con error (${r.status}) al listar los modelos.`,
          detalle: cuerpoLista && cuerpoLista.error ? cuerpoLista.error.message : null
        });
        return;
      }
      const disponibles = (cuerpoLista && cuerpoLista.models ? cuerpoLista.models : [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''));
      const existe = disponibles.includes(GEMINI_MODEL);

      /* Que el modelo exista no basta: hay que saber QUÉ parámetros admite. Se prueba una
         generación mínima en cada escalón y se informa del primero que responde, que es
         justo lo que el chat acabará usando. */
      const NOMBRES_NIVEL = [
        'sin razonamiento interno + esquema estricto + salida JSON',
        'esquema estricto + salida JSON',
        'salida JSON',
        'solo texto (el JSON se pide en el prompt)'
      ];
      const base = { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json', responseSchema: RESPUESTA_SCHEMA };
      const pruebaMinima = (apiKey, n) => llamarGemini({
        apiKey, prompt: 'Responde solo con este JSON: {"mensaje":"ok"}', config: base, nivel: n
      });

      /* Cada modo se prueba rotando de key mientras salga "cuota agotada". El primer
         intento de esto se quedaba en las primeras 3 keys nada más — un límite arbitrario
         que, con exactamente esas 3 agotadas y las operativas más adelante en la lista,
         hacía concluir "no funciona en ningún modo" siendo falso: nunca llegaba a
         probar las que sí respondían.

         Ahora recorre TODAS las keys configuradas, pero empieza por la última que dio
         señales de vida (keyViva) en vez de reiniciar en la 1 en cada nivel — así el
         propio diagnóstico no quema de más la cuota que está intentando diagnosticar. */
      let keyViva = 0;
      async function probarNivel(n) {
        let ultima = await pruebaMinima(apiKeys[keyViva], n);
        if (ultima.status !== 429) return ultima;   // 429 = es la key, no el modo
        for (let k = 0; k < apiKeys.length; k++) {
          if (k === keyViva) continue;
          if (!quedaTiempoDiag()) return ultima;   // se acaba el presupuesto: se corta aquí, no se cuelga
          ultima = await pruebaMinima(apiKeys[k], n);
          if (ultima.status !== 429) { keyViva = k; return ultima; }
        }
        return ultima;
      }

      const pruebas = [];
      let nivelQueFunciona = null;
      let seAcabóElTiempo = false;
      if (existe) {
        for (let n = 0; n <= NIVEL_MINIMO_TEXTO; n++) {
          if (!quedaTiempoDiag()) { seAcabóElTiempo = true; break; }
          const prueba = await probarNivel(n);
          pruebas.push({ nivel: n, modo: NOMBRES_NIVEL[n], resultado: prueba.tipo, status: prueba.status || null,
            detalle: prueba.detalle ? String(prueba.detalle).slice(0, 200) : null });
          if (prueba.tipo === 'ok') { nivelQueFunciona = n; break; }
        }
      }

      /* Estado de CADA key, no solo de la primera. Probar solo la primera lleva a
         conclusiones falsas: si esa tiene la cuota agotada, todo el diagnóstico sale en
         429 aunque las otras cinco estén perfectamente vivas. Nunca se devuelve una key,
         solo su posición y el veredicto. Si el presupuesto se acaba a mitad del barrido,
         las que faltan quedan marcadas como "no probada" en vez de desaparecer sin
         explicación del informe. */
      const nivelParaProbar = nivelQueFunciona === null ? NIVEL_MINIMO_TEXTO : nivelQueFunciona;
      const estadoKeys = [];
      let vivas = 0;
      for (let k = 0; k < apiKeys.length; k++) {
        if (!quedaTiempoDiag()) {
          seAcabóElTiempo = true;
          estadoKeys.push({ key: 'GEMINI_API_KEY_' + (k + 1), estado: 'no probada (se acabó el tiempo del diagnóstico)' });
          continue;
        }
        const p = await pruebaMinima(apiKeys[k], nivelParaProbar);
        let estado;
        if (p.tipo === 'ok' || p.tipo === 'truncado') { estado = 'operativa'; vivas++; }
        else if (p.status === 429) estado = 'cuota agotada';
        else if (p.status === 400 || p.status === 403) estado = 'rechazada (key inválida o sin permiso)';
        else estado = 'error (' + (p.status || p.tipo) + ')';
        estadoKeys.push({ key: 'GEMINI_API_KEY_' + (k + 1), estado });
      }

      res.status(200).json({
        modeloConfigurado: GEMINI_MODEL,
        elModeloExiste: existe,
        veredicto: !existe
          ? `El modelo "${GEMINI_MODEL}" NO está en la lista que ve esta key. Cambia GEMINI_MODEL en Vercel por uno de "modelosDisponibles".`
          : (nivelQueFunciona === null
              ? (seAcabóElTiempo
                  ? 'Se acabó el tiempo del diagnóstico antes de terminar de probar. Vuelve a intentarlo — con las respuestas más lentas de esta vez ya descartadas, suele bastar.'
                  : 'El modelo existe pero no respondió en ninguno de los modos probados. Mira "pruebas" para ver qué contestó Google en cada uno.')
              : `El modelo funciona en el modo "${NOMBRES_NIVEL[nivelQueFunciona]}". El chat usará ese automáticamente.`),
        modoQueFunciona: nivelQueFunciona === null ? null : NOMBRES_NIVEL[nivelQueFunciona],
        seAcabóElTiempo,
        pruebas,
        keysConfiguradas: apiKeys.length,
        keysOperativas: vivas,
        estadoDeCadaKey: estadoKeys,
        diagnosticoDeCuota: vivas === 0
          ? 'Ninguna key puede generar ahora mismo. Si todas dicen "cuota agotada", el chat no funcionará hasta que se restablezca (suele ser cada 24 h) o hasta que cambies a un modelo con más cuota gratuita.'
          : `${vivas} de ${apiKeys.length} key(s) pueden generar. El chat rota automáticamente hasta dar con una que responda.`,
        consumoPorPregunta: 'Cada pregunta del chat gasta 2 llamadas (una para decidir qué consultar y otra para redactar la respuesta).',
        modelosDisponibles: disponibles
      });
      return;
    } catch (e) {
      const esTimeout = e && e.name === 'AbortError';
      res.status(502).json({
        error: esTimeout
          ? `Google no respondió al listar los modelos en ${TIMEOUT_LLAMADA_MS/1000}s. Puede ser un problema pasajero de red — inténtalo de nuevo.`
          : 'No se pudo contactar con la API de Gemini para el diagnóstico.',
        detalle: String((e && e.message) || e)
      });
      return;
    }
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido. Usa POST.' });
    return;
  }

  if (apiKeys.length === 0) {
    res.status(500).json({
      error: 'El servidor no tiene configurada ninguna API key de Gemini. Agrega GEMINI_API_KEY_1 (y opcionalmente _2 a _5) en Vercel → Settings → Environment Variables y vuelve a desplegar.'
    });
    return;
  }

  const cuerpo = req.body || {};
  const fase = cuerpo.fase === 'responder' ? 'responder' : 'planificar';
  const { pregunta, vista, columnas, columnasPorVista, filtrosExistentes, historial, contexto, observaciones } = cuerpo;

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
    : construirPromptPlan({ pregunta, vista, columnas, columnasPorVista, filtrosExistentes, historial, contexto });

  // Planificar es una decisión mecánica (qué herramienta y con qué argumentos):
  // temperatura casi nula. Redactar es lo contrario — algo de temperatura evita
  // que todas las respuestas suenen calcadas.
  let config = fase === 'responder'
    ? { temperature: 0.45, maxOutputTokens: 4096, responseMimeType: 'application/json', responseSchema: RESPUESTA_SCHEMA }
    : { temperature: 0.1, maxOutputTokens: 3072, responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA };

  /* Bucle de intentos. Tres cosas distintas pueden salir mal y cada una se corrige
     de una forma diferente, por eso no basta con "probar la siguiente key":

     - key agotada/inválida (429, 400/403 de key)  -> se pasa a la SIGUIENTE key.
     - Gemini sobrecargado (500/502/503/504)       -> se REINTENTA tras una pausa;
       es transitorio y cambiar de key no ayuda (es el modelo, no la cuenta).
     - respuesta cortada a mitad (MAX_TOKENS)      -> se REINTENTA con el DOBLE de
       presupuesto de salida.
     - parámetro que el modelo no admite (400)     -> se REINTENTA con menos exigencias
       (ver NIVELES abajo).

     El corte es por TIEMPO, no por un número fijo de llamadas: con seis keys, un tope de
     tres intentos dejaba la mitad sin probar y aun así el mensaje final decía que habían
     fallado las seis. Un fallo de cuota se resuelve en milisegundos, así que dentro del
     presupuesto caben todas las keys; lo que hay que evitar es pasarse del límite real de
     la función.

     vercel.json declara maxDuration:20, pero ESO SOLO SE RESPETA en un plan de pago de
     Vercel — en el plan gratuito (Hobby) el límite real es 10 s pase lo que declare la
     config, y no hay forma de saber desde aquí en qué plan corre este despliegue. Se deja
     margen bajo el peor caso, no bajo el mejor.

     "Queda tiempo" NO basta con mirar el reloj sin más: cada llamada individual puede
     tardar hasta TIMEOUT_LLAMADA_MS en colgarse antes de que el propio timeout la corte
     (ver llamarGemini), así que solo se autoriza un intento MÁS si incluso en el peor caso
     — que esa llamada se cuelgue entera — el total seguiría cabiendo dentro de LIMITE_MS.
     Sin ese margen, dos llamadas colgadas seguidas sumaban 2×TIMEOUT_LLAMADA_MS y volvían
     a pasarse del límite real (se midió: 12 s con solo el reloj, contra el suelo de 10 s
     del plan gratuito) — el propio mecanismo pensado para evitar el 504 lo seguía
     provocando. Con esta cuenta, el peor caso real queda en un único TIMEOUT_LLAMADA_MS. */
  const LIMITE_MS = 9000;
  const arranque = Date.now();
  const MAX_LLAMADAS = apiKeys.length + NIVEL_MINIMO_TEXTO + 2;
  const quedaTiempo = () => (Date.now() - arranque + TIMEOUT_LLAMADA_MS) <= LIMITE_MS;
  let llamadas = 0;
  let idxKey = 0;
  let keysProbadas = 0;
  /* NIVELES de exigencia. Google responde a un parámetro que su modelo no admite con un
     400 "Request contains an invalid argument" a secas, sin decir CUÁL: no hay forma de
     saber por el texto si sobra thinkingConfig, responseSchema o los dos. Así que en vez
     de adivinar se van soltando de uno en uno, de más a menos exigente, y se reintenta:

       0 - sin razonamiento interno + esquema estricto + salida JSON
       1 - esquema estricto + salida JSON        (el modelo no admite thinkingConfig)
       2 - salida JSON                           (tampoco admite responseSchema)
       3 - nada: el JSON se pide solo en el texto del prompt

     El nivel 3 es el que funcionaba antes de añadir estas mejoras, así que siempre queda
     un camino que responde; extraerJSON ya tolera que ahí venga envuelto en markdown. */
  let nivel = nivelAprendido;
  let ultimoError = null;

  while (llamadas < MAX_LLAMADAS && idxKey < apiKeys.length && quedaTiempo()) {
    llamadas++;
    if (idxKey + 1 > keysProbadas) keysProbadas = idxKey + 1;
    const r = await llamarGemini({ apiKey: apiKeys[idxKey], prompt, config, nivel });

    if (r.tipo === 'ok') {
      nivelAprendido = nivel;   // este modelo responde aquí: las próximas preguntas empiezan ya en este escalón
      res.status(200).json(sanear(r.interpretacion, fase));
      return;
    }

    if (r.tipo === 'truncado') {
      // Se quedó sin espacio de salida: se duplica el presupuesto y se reintenta.
      ultimoError = { detalle: 'La respuesta se cortó por longitud (MAX_TOKENS).' };
      config = { ...config, maxOutputTokens: config.maxOutputTokens * 2 };
      continue;
    }

    if (r.tipo === 'red') {
      ultimoError = { detalle: r.detalle };
      idxKey++;
      continue;
    }

    // r.tipo === 'http'
    // Un 400 que no señala a la key es casi siempre un parámetro que este modelo no
    // admite: se baja un escalón de exigencia y se reintenta con la misma key, en vez de
    // dar el error por definitivo (que es lo que dejaba el chat inutilizable entero).
    if (r.status === 400 && !debeRotarKey(r.status, r.detalle) && nivel < NIVEL_MINIMO_TEXTO) {
      nivel++;
      ultimoError = { status: r.status, detalle: r.detalle };
      continue;
    }
    if (debeRotarKey(r.status, r.detalle)) {
      ultimoError = { status: r.status, detalle: r.detalle };
      idxKey++;
      continue;
    }
    if (esErrorTransitorio(r.status)) {
      ultimoError = { status: r.status, detalle: r.detalle, transitorio: true };
      await esperar(700);
      continue;
    }
    // El modelo configurado no existe (o esa key no tiene acceso a él). Cambiar de key no
    // arregla nada, y decirlo con el nombre delante ahorra buscar el problema en la cuota.
    if (r.status === 404) {
      res.status(502).json({
        error: `El modelo "${GEMINI_MODEL}" no existe o no está disponible para esta API key. Revisa el nombre del modelo (variable de entorno GEMINI_MODEL en Vercel).`,
        detalle: r.detalle,
        modelo: GEMINI_MODEL,
        llamadas
      });
      return;
    }
    // Error definitivo (prompt rechazado, parámetros inválidos): fallaría igual
    // con cualquier otra key, así que se reporta ya en vez de gastar intentos.
    res.status(502).json({
      error: `Gemini respondió con error (${r.status}).`,
      detalle: r.detalle,
      modelo: GEMINI_MODEL,
      llamadas
    });
    return;
  }

  // Se agotaron los intentos. El mensaje distingue el caso transitorio (vale la
  // pena reintentar tal cual) del de cuota agotada (hay que tocar las keys).
  if (ultimoError && ultimoError.transitorio) {
    res.status(503).json({
      error: 'Gemini está sobrecargado ahora mismo y no respondió tras varios intentos. Vuelve a enviar la pregunta en unos segundos.',
      detalle: ultimoError.detalle,
      llamadas
    });
    return;
  }
  // El mensaje dice cuántas keys se probaron DE VERDAD. Antes afirmaba que habían fallado
  // todas las configuradas aunque el tope de intentos hubiera dejado la mitad sin tocar,
  // y eso mandaba a comprar cuota por un problema que podía ser otro.
  const seProbaronTodas = keysProbadas >= apiKeys.length;
  res.status(503).json({
    error: seProbaronTodas
      ? `Fallaron las ${apiKeys.length} API key(s) de Gemini configuradas. Si el detalle habla de cuota, espera a que se restablezca o agrega otra key; si habla de otra cosa, el problema no son las keys.`
      : `Se probaron ${keysProbadas} de las ${apiKeys.length} API key(s) configuradas y ninguna respondió a tiempo. Vuelve a intentarlo; si se repite, revisa el detalle.`,
    detalle: ultimoError && ultimoError.detalle,
    modelo: GEMINI_MODEL,
    keysProbadas,
    keysConfiguradas: apiKeys.length,
    llamadas
  });
};


function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Quita del generationConfig lo que el modelo haya rechazado, según el escalón en el que
   vaya el bucle de intentos (ver NIVELES). El prompt siempre pide el JSON por escrito, así
   que incluso en el último escalón la respuesta sigue siendo interpretable. */
function configDeNivel(config, nivel) {
  const c = { ...config };
  if (nivel <= 0) c.thinkingConfig = { thinkingBudget: 0 };
  if (nivel >= 2) delete c.responseSchema;
  if (nivel >= 3) delete c.responseMimeType;
  return c;
}

// Tope por LLAMADA INDIVIDUAL a Gemini. Sin esto, una sola respuesta lenta (o que se
// cuelga) se comía todo el presupuesto de la función sin que el bucle de reintentos
// llegara siquiera a enterarse — Vercel terminaba matando la función entera de golpe
// (504, sin ningún JSON de error propio) en vez de que este código reaccionara a tiempo.
//
// El valor importa tanto como su existencia: quedaTiempo() (más abajo) solo autoriza
// una llamada más si incluso colgándose entera seguiría cabiendo en LIMITE_MS, así que
// el número de keys que se llegan a probar en el peor caso (todas cuelgan el máximo) es
// floor(LIMITE_MS / TIMEOUT_LLAMADA_MS). Con 5000 eso daba EXACTAMENTE 1 — la primera
// key que se cuelga agota el presupuesto entero y el chat reporta "se probó 1 de 6" sin
// haber tenido oportunidad real de rotar. Bajarlo a 3000 (de sobra para un modelo flash
// generando unos pocos cientos de tokens en condiciones normales) deja margen para 3
// intentos completos incluso en ese peor caso (con aire de sobra frente a 9000/3=3000:
// justo en ese borde, cualquier milisegundo real de más entre llamadas — el propio
// setTimeout, JSON.stringify, la vuelta del event loop — tira el tercer intento fuera y
// se queda en 2), sin tocar LIMITE_MS ni el margen de seguridad ya validado contra el
// 504 de Vercel.
const TIMEOUT_LLAMADA_MS = 2500;

/* Una sola llamada a Gemini, con el resultado ya clasificado para que el bucle de
   arriba decida qué hacer sin volver a mirar el cuerpo de la respuesta. */
async function llamarGemini({ apiKey, prompt, config, nivel }) {
  const generationConfig = configDeNivel(config, nivel || 0);

  let respuesta;
  const controlador = new AbortController();
  const corte = setTimeout(() => controlador.abort(), TIMEOUT_LLAMADA_MS);
  try {
    respuesta = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig
      }),
      signal: controlador.signal
    });
  } catch (err) {
    // Un abort por timeout llega aquí como cualquier otro fallo de red: se trata igual
    // (se reintenta con la siguiente key o se reintenta el nivel), sin lógica aparte.
    const esTimeout = err && err.name === 'AbortError';
    return { tipo: 'red', detalle: esTimeout ? `Sin respuesta de Gemini en ${TIMEOUT_LLAMADA_MS/1000}s.` : String((err && err.message) || err) };
  } finally {
    clearTimeout(corte);
  }

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => '');
    return { tipo: 'http', status: respuesta.status, detalle };
  }

  const data = await respuesta.json().catch(() => null);
  const candidato = data?.candidates?.[0];
  const texto = candidato?.content?.parts?.[0]?.text;
  const motivo = candidato?.finishReason;

  if (!texto) {
    // Sin texto por haberse quedado sin presupuesto (el modelo gastó la salida
    // razonando): es recuperable subiendo el límite, igual que un JSON cortado.
    if (motivo === 'MAX_TOKENS') return { tipo: 'truncado' };
    return { tipo: 'http', status: 502, detalle: motivo && motivo !== 'STOP'
      ? `Gemini no generó respuesta (motivo: ${motivo}).`
      : 'Gemini no devolvió contenido interpretable.' };
  }

  const interpretacion = extraerJSON(texto);
  if (!interpretacion) {
    if (motivo === 'MAX_TOKENS') return { tipo: 'truncado' };
    return { tipo: 'http', status: 502, detalle: 'La respuesta de Gemini no fue un JSON válido: ' + texto.slice(0, 300) };
  }
  return { tipo: 'ok', interpretacion };
}


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
function construirPromptPlan({ pregunta, vista, columnas, columnasPorVista, filtrosExistentes, historial, contexto }) {
  // Se listan las columnas de LAS DOS pestañas con tabla, no solo la abierta: sin
  // esto el modelo no puede proponer un filtro en la otra pestaña (que es justo lo
  // que hace falta cuando preguntan por listas estando en el Maestro) y termina
  // filtrando la tabla equivocada o inventando nombres de columna.
  const porVista = (columnasPorVista && typeof columnasPorVista === 'object') ? columnasPorVista : {};
  const bloqueDeColumnas = (etiqueta, clave, cols) => {
    const lista = (cols || []).map((c) => `  - "${c}"`).join('\n') || '  (no hay datos cargados en esta pestaña)';
    return `Pestaña "${etiqueta}" (pestana: "${clave}")${vista === etiqueta ? '  <- ABIERTA AHORA' : ''}:\n${lista}`;
  };
  const listaColumnas = [
    bloqueDeColumnas('Maestro de Materiales', 'mm', porVista['Maestro de Materiales'] || (vista === 'Maestro de Materiales' ? columnas : [])),
    bloqueDeColumnas('Listas de Materiales', 'bom', porVista['Listas de Materiales'] || (vista === 'Listas de Materiales' ? columnas : []))
  ].join('\n\n');
  const listaFiltros = (Array.isArray(filtrosExistentes) ? filtrosExistentes : [])
    .map((f) => `- "${f.nombre}": ${f.descripcion}`)
    .join('\n') || '(ninguno)';
  const catalogo = HERRAMIENTAS
    .map((h) => `- ${h.nombre} ${h.args}\n  ${h.desc}`)
    .join('\n');

  return `Eres el asistente de consulta de una aplicación interna que trabaja sobre datos de SAP: Maestro de Materiales y Listas de Materiales. Tu trabajo no es filtrar tablas: es entender lo que la persona necesita saber y averiguarlo.

${BRIEFING}

${VOZ}

ESTADO DE LOS DATOS EN EL NAVEGADOR
${bloqueContexto(contexto)}

PESTAÑA ABIERTA AHORA: ${vista || '(desconocida)'}

COLUMNAS DE CADA PESTAÑA (nombres EXACTOS; filtrar_tabla y contar_filas solo pueden usar las de la pestaña que esté ABIERTA en ese momento):
${listaColumnas}

FILTROS ESPECIALES QUE YA EXISTEN EN LA APLICACIÓN — solo en la pestaña "Listas de Materiales" (para el operador "filtro_existente", con "valor" = el nombre exacto):
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
5. Usa filtrar_tabla cuando la persona quiere VER un subconjunto en pantalla, con las columnas EXACTAS de la pestaña donde va a caer el filtro.
6. LA PESTAÑA IMPORTA. filtrar_tabla y contar_filas actúan sobre la que esté abierta. Si lo que piden vive en la otra, tú la cambias: primero cambiar_pestana y después filtrar_tabla, en la misma respuesta y en ese orden. Nunca le pidas a la persona que se cambie de pestaña ella misma, y nunca filtres en la pestaña equivocada "porque es la que está abierta".
   - Hablan de LISTAS, listas de materiales, BOM, alternativas, versiones de fabricación, componentes, utilización -> pestaña "bom".
   - Hablan de MATERIALES sueltos, su ficha, tipo de material, estado/bloqueo Z, texto de inspección, categoría 3 -> pestaña "mm".
   - Ejemplo: están en el Maestro y piden "las listas creadas los últimos 7 días" -> cambiar_pestana a "bom" y filtrar_tabla con "Creado el" y ultimos_dias 7. Filtrar eso en el Maestro sería responder otra cosa.
7. Si el mensaje no necesita datos (un saludo, "¿qué puedes hacer?", una pregunta sobre cómo funciona algo que ya sabes por el contexto de negocio), devuelve "acciones": [] y escribe tú la respuesta completa en "mensaje".
8. Si hace falta algo que no está cargado (te piden componentes y no hay componentes cargados), devuelve "acciones": [] y dilo en "mensaje".

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
