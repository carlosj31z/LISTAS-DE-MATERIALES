/**
 * Endpoint serverless de Vercel: /api/chat-ia
 *
 * Recibe una pregunta en lenguaje natural del usuario más metadatos sobre la
 * vista actual (qué columnas y filtros existen — NUNCA los datos de SAP en sí),
 * arma un prompt para Gemini pidiendo una respuesta en JSON estructurado, y la
 * devuelve al navegador.
 *
 * La API key de Gemini vive únicamente en la variable de entorno GEMINI_API_KEY
 * de este proyecto en Vercel — nunca se envía al navegador ni aparece en el
 * código del cliente. Esto es lo que hace seguro exponer un "chat con IA" desde
 * un HTML estático: el HTML le habla a ESTE endpoint, y solo este endpoint (que
 * corre en el servidor de Vercel, no en el navegador de nadie) conoce la key.
 */

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Vocabulario fijo de operadores que el filtro del HTML sabe aplicar. Se le pasa
// esta lista a Gemini explícitamente para que SOLO elija de aquí — así el HTML
// nunca recibe un operador que no sepa interpretar.
const OPERADORES_VALIDOS = [
  'igual', 'distinto', 'contiene', 'no_contiene',
  'mayor_que', 'menor_que', 'mayor_o_igual', 'menor_o_igual',
  'ultimos_dias', 'antes_de', 'despues_de',
  'filtro_existente' // ver "filtrosExistentes" más abajo
];

module.exports = async (req, res) => {
  // CORS básico: el HTML puede vivir en cualquier dominio/estático (incluso
  // abierto localmente), así que se permite cualquier origen para este endpoint
  // de solo-lectura de intención (no de datos sensibles).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido. Usa POST.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'El servidor no tiene configurada la variable de entorno GEMINI_API_KEY. Agrégala en Vercel → Settings → Environment Variables y vuelve a desplegar.'
    });
    return;
  }

  const { pregunta, vista, columnas, filtrosExistentes } = req.body || {};

  if (!pregunta || typeof pregunta !== 'string' || !pregunta.trim()) {
    res.status(400).json({ error: 'Falta el campo "pregunta" en el cuerpo de la solicitud.' });
    return;
  }
  if (!Array.isArray(columnas) || columnas.length === 0) {
    res.status(400).json({ error: 'Falta el campo "columnas" (lista de columnas disponibles en la vista actual).' });
    return;
  }

  const prompt = construirPrompt({ pregunta, vista, columnas, filtrosExistentes });

  try {
    const respuestaGemini = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1, // baja: queremos interpretación consistente, no creatividad
          responseMimeType: 'application/json'
        }
      })
    });

    if (!respuestaGemini.ok) {
      const detalle = await respuestaGemini.text().catch(() => '');
      res.status(502).json({ error: `Gemini respondió con error (${respuestaGemini.status}).`, detalle });
      return;
    }

    const data = await respuestaGemini.json();
    const textoJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textoJson) {
      res.status(502).json({ error: 'Gemini no devolvió contenido interpretable.' });
      return;
    }

    let interpretacion;
    try {
      interpretacion = JSON.parse(textoJson);
    } catch (e) {
      res.status(502).json({ error: 'La respuesta de Gemini no fue un JSON válido.', crudo: textoJson });
      return;
    }

    // Validación defensiva: nunca se reenvía al HTML una condición con un
    // operador fuera del vocabulario permitido, aunque Gemini lo hubiera
    // inventado — se descarta esa condición puntual en vez de fallar todo.
    if (Array.isArray(interpretacion.condiciones)) {
      interpretacion.condiciones = interpretacion.condiciones.filter(
        (c) => c && OPERADORES_VALIDOS.includes(c.operador)
      );
    }

    res.status(200).json(interpretacion);
  } catch (err) {
    res.status(500).json({ error: 'Error al contactar a Gemini.', detalle: String(err && err.message || err) });
  }
};

function construirPrompt({ pregunta, vista, columnas, filtrosExistentes }) {
  const listaColumnas = columnas.map((c) => `- "${c}"`).join('\n');
  const listaFiltros = (filtrosExistentes || [])
    .map((f) => `- "${f.nombre}": ${f.descripcion}`)
    .join('\n') || '(ninguno para esta vista)';

  return `Eres el intérprete de un chat de filtrado para una aplicación interna de SAP (Maestro de Materiales / Listas de Materiales, planta farmacéutica). Tu única tarea es traducir una pregunta en lenguaje natural del usuario a una estructura JSON de filtro — NUNCA respondes la pregunta directamente ni inventas datos, porque no tienes acceso a los datos reales, solo a los NOMBRES de columnas y filtros disponibles.

VISTA ACTUAL: ${vista}

COLUMNAS DISPONIBLES EN ESTA VISTA (usa estos nombres EXACTOS, no traduzcas ni abrevies):
${listaColumnas}

FILTROS ESPECIALES YA EXISTENTES EN LA APLICACIÓN (si la pregunta calza con uno de estos, en vez de armar una condición sobre una columna, usa el operador "filtro_existente" con "valor" = el nombre exacto del filtro):
${listaFiltros}

PREGUNTA DEL USUARIO:
"${pregunta}"

INSTRUCCIONES:
1. Si la pregunta pide un subconjunto de filas (ej. "las creadas en las últimas 2 semanas", "las que tienen alternativa 66"), responde con "tipo":"filtro" y una lista de "condiciones". Cada condición es { "columna": "<nombre exacto de columna o vacío si usas filtro_existente>", "operador": "<uno de: igual|distinto|contiene|no_contiene|mayor_que|menor_que|mayor_o_igual|menor_o_igual|ultimos_dias|antes_de|despues_de|filtro_existente>", "valor": <string o número> }.
2. Si la pregunta es sobre un componente específico dentro de las listas de materiales (ej. "qué listas tienen la cinta de embalaje X"), usa la columna "Componente" (si existe en las columnas disponibles) o indica en "sugerencias" que esa búsqueda debe hacerse en la pestaña de Componentes si esta vista no tiene esa columna — nunca inventes una columna que no esté en la lista de arriba.
3. Si la pregunta es una pregunta de sí/no sobre el estado de los datos YA filtrados en pantalla (ej. "¿tiene todos los materiales actualizados?", "¿hay alguna con alternativa de conciliación?"), responde con "tipo":"pregunta_sobre_resultados" y en "condiciones" la MISMA condición que usarías para contar/detectar ese caso (ej. usar el filtro existente correspondiente) — el motor del navegador hará el conteo real sobre los datos, tú solo indicas qué mirar.
4. Si la pregunta es ambigua, usa columnas que no existen, o no puedes traducirla con confianza, responde "tipo":"no_entendido" y llena "sugerencias" con 2-3 reformulaciones concretas que el usuario podría intentar, usando nombres reales de columnas o filtros de la lista de arriba.
5. SIEMPRE completa "razonamiento": una explicación breve (1-2 frases, en español, tono directo) de cómo interpretaste la pregunta, para que el usuario pueda confirmar o corregir.
6. Para fechas relativas ("últimas 2 semanas", "este mes"), usa el operador "ultimos_dias" con el número de días equivalente como "valor" (2 semanas = 14).
7. Nunca inventes un valor de columna que no te haya mencionado el usuario o que no sea deducible de su pregunta.

Responde ÚNICAMENTE con un objeto JSON con esta forma exacta (sin texto adicional, sin markdown):
{
  "tipo": "filtro" | "pregunta_sobre_resultados" | "no_entendido",
  "razonamiento": "string",
  "condiciones": [ { "columna": "string", "operador": "string", "valor": "string o número" } ],
  "sugerencias": ["string", "..."]
}`;
}
