/**
 * Endpoint serverless de Vercel: /api/chat-ia
 *
 * Recibe una pregunta en lenguaje natural del usuario más metadatos sobre la
 * vista actual (qué columnas y filtros existen — NUNCA los datos de SAP en sí),
 * arma un prompt para Gemini pidiendo una respuesta en JSON estructurado, y la
 * devuelve al navegador.
 *
 * Las API keys de Gemini viven ÚNICAMENTE en variables de entorno de este
 * proyecto en Vercel — nunca se envían al navegador ni aparecen en el código
 * del cliente. Esto es lo que hace seguro exponer un "chat con IA" desde un
 * HTML estático: el HTML le habla a ESTE endpoint, y solo este endpoint (que
 * corre en el servidor de Vercel, no en el navegador de nadie) conoce las keys.
 *
 * ROTACIÓN DE KEYS: se configuran hasta 5 keys (GEMINI_API_KEY_1 .. _5). Si una
 * llamada falla por cuota agotada (HTTP 429) o por key inválida/revocada (HTTP
 * 400/403), se reintenta automáticamente con la siguiente key de la lista,
 * hasta agotarlas todas. Un error de otro tipo (prompt inválido, respuesta mal
 * formada, etc.) NO dispara reintento, porque fallaría igual con cualquier key.
 */

const GEMINI_MODEL = 'gemini-3.6-flash';
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

  const apiKeys = obtenerApiKeys();
  if (apiKeys.length === 0) {
    res.status(500).json({
      error: 'El servidor no tiene configurada ninguna API key de Gemini. Agrega GEMINI_API_KEY_1 (y opcionalmente _2 a _5) en Vercel → Settings → Environment Variables y vuelve a desplegar.'
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

  let ultimoError = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
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

      // "mensaje" es lo que la persona lee. Si el modelo lo omite o manda algo que
      // no es texto, se descarta y el HTML cae a su redacción por defecto en vez de
      // pintar un "undefined" o un objeto.
      if (typeof interpretacion.mensaje !== 'string' || !interpretacion.mensaje.trim()) {
        delete interpretacion.mensaje;
      }

      res.status(200).json(interpretacion);
      return;
    } catch (err) {
      // Error de red/conexión (no de Gemini en sí): se guarda y se prueba la
      // siguiente key — el reporte final ocurre en el bloque después del bucle si
      // se agotan todas.
      ultimoError = { detalle: String(err && err.message || err) };
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


/* Aquí vive la personalidad del asistente.

   El campo "mensaje" es lo que la persona lee como respuesta principal en el
   panel; "razonamiento" quedó como la nota técnica breve de cómo se interpretó
   la pregunta. Antes el HTML escribía textos fijos ("Filtro aplicado sobre la
   tabla.") y el modelo solo llenaba el razonamiento — por eso el chat se sentía
   plano y un simple "hola" caía en "no_entendido". */
function construirPrompt({ pregunta, vista, columnas, filtrosExistentes }) {
  const listaColumnas = columnas.map((c) => `- "${c}"`).join('\n');
  const listaFiltros = (Array.isArray(filtrosExistentes) ? filtrosExistentes : [])
    .map((f) => `- "${f.nombre}": ${f.descripcion}`)
    .join('\n') || '(ninguno para esta vista)';

  return `Eres el asistente del chat de una aplicación interna de SAP (Maestro de Materiales y Listas de Materiales) que usa el equipo de QA/DOC de una planta farmacéutica peruana. Tu trabajo es doble: conversar de forma cercana y útil, y traducir lo que te piden a un filtro sobre la tabla que la persona tiene delante.

CÓMO HABLAS
- En español, tuteando. Cálido y cercano, como un colega que conoce bien la aplicación y tiene ganas de ayudar.
- Breve: el panel es angosto. Entre 1 y 3 frases en "mensaje", nunca párrafos largos.
- Siempre dejas la puerta abierta a seguir ayudando, pero con una oferta CONCRETA y relevante ("¿Le quito también los suspendidos?"), nunca con una fórmula vacía tipo "¿en qué más puedo ayudarte?".
- Sin adulación ni disculpas excesivas. Si algo no se puede, lo dices claro y ofreces la alternativa más cercana.
- Puedes enfatizar una palabra clave rodeándola de asteriscos: *así*. Como mucho una o dos veces por mensaje.
- NUNCA inventas datos: no ves las filas, solo los NOMBRES de las columnas y los filtros disponibles. Si te preguntan por un valor concreto, filtra para que lo vea en la tabla en vez de afirmar nada.
- Cuando apliques un filtro, NO digas cuántas filas salieron: la aplicación muestra el conteo real por su cuenta y quedarías desmentido.

VISTA ACTUAL: ${vista}

COLUMNAS DISPONIBLES EN ESTA VISTA (usa estos nombres EXACTOS, no traduzcas ni abrevies):
${listaColumnas}

FILTROS ESPECIALES YA EXISTENTES EN LA APLICACIÓN (si la pregunta calza con uno, en vez de armar una condición sobre una columna usa el operador "filtro_existente" con "valor" = el nombre exacto del filtro):
${listaFiltros}

MENSAJE DE LA PERSONA:
"${pregunta}"

ELIGE UN "tipo":

1. "filtro" — pide un subconjunto de filas (ej. "las creadas en las últimas 2 semanas", "las que tienen alternativa 66"). Llena "condiciones". En "mensaje" cuenta con naturalidad qué acabas de filtrar y ofrece el siguiente paso lógico.

2. "pregunta_sobre_resultados" — pregunta de sí/no o de conteo sobre lo que YA está en pantalla (ej. "¿hay alguna con alternativa de conciliación?"). En "condiciones" pon la MISMA condición que usarías para detectar ese caso; el navegador hace el conteo real. En "mensaje" introduce el dato sin adelantar el número.

3. "conversacion" — saludos, agradecimientos, "¿qué puedes hacer?", "¿quién eres?", o cualquier cosa que no sea filtrar. Responde con calidez y orienta con 1-2 ejemplos REALES de esta vista, usando nombres de columnas de la lista de arriba. Deja "condiciones" vacío. Un "hola" merece un saludo de vuelta y una invitación concreta, jamás un "no entendí".

4. "no_entendido" — quiere filtrar pero no puedes traducirlo con confianza (pide columnas que no existen, o es ambiguo de verdad). Dilo sin dramatismo y apóyate en "sugerencias".

REGLAS DE LAS CONDICIONES
- Cada condición es { "columna": "<nombre exacto, o vacío si usas filtro_existente>", "operador": "<uno de: igual|distinto|contiene|no_contiene|mayor_que|menor_que|mayor_o_igual|menor_o_igual|ultimos_dias|antes_de|despues_de|filtro_existente>", "valor": <string o número> }.
- Para fechas relativas usa "ultimos_dias" con el número de días (2 semanas = 14).
- Si preguntan por un componente concreto dentro de las listas, usa la columna "Componente" si existe en esta vista; si no existe, dilo en "mensaje" e indica que esa búsqueda va en la pestaña de Componentes. Nunca inventes una columna que no esté arriba.
- Nunca inventes un valor que la persona no haya mencionado y que no sea deducible de su mensaje.

SOBRE "sugerencias"
Se pintan como BOTONES y, al hacer clic, se envían TAL CUAL como el siguiente mensaje. Así que escríbelas en primera persona, como las tecleraría la persona ("muéstrame las creadas este mes"), nunca como descripciones en infinitivo ("Filtrar por fecha de creación"). De 2 a 3, o lista vacía si no aportan.

Responde ÚNICAMENTE con un objeto JSON con esta forma exacta (sin texto adicional, sin markdown):
{
  "tipo": "filtro" | "pregunta_sobre_resultados" | "conversacion" | "no_entendido",
  "mensaje": "lo que la persona lee, con tu voz (1-3 frases)",
  "razonamiento": "nota técnica breve de cómo interpretaste el pedido",
  "condiciones": [ { "columna": "string", "operador": "string", "valor": "string o número" } ],
  "sugerencias": ["string", "..."]
}`;
}
