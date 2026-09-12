/**
 * Helpers COMPARTIDOS entre los endpoints de /api que leen datos de Supabase (arbol.js,
 * primer-componente.js, y cualquier otro que se agregue después) — nunca copiar este
 * código de nuevo en un endpoint nuevo, importar de aquí.
 *
 * Vive bajo api/_lib/ (con guion bajo) a propósito: Vercel NO convierte en función
 * pública ningún archivo dentro de una carpeta que empiece con "_" — es la forma
 * documentada de tener módulos de soporte junto a los endpoints sin exponerlos como ruta.
 */

const SUPABASE_URL = 'https://wjlryrqkcnvjlrdibzol.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2Qm4zOkdHeSMOYvatAyNiA_K5crlvFc';

// Mismo presupuesto conservador que api/chat-ia.js (ver el comentario largo ahí): el plan
// gratuito de Vercel corta a los ~10s pase lo que declare vercel.json, así que nunca se
// arranca un tramo más si ya no cabría completo dentro de este límite.
const LIMITE_MS = 9000;
const TIMEOUT_FETCH_MS = 4000;
const PAGE_SIZE = 1000;
// 8 en vez de 4: con tablas grandes (mm_bom_componentes en particular), más
// páginas a la vez reduce el tiempo total de traída — visto en producción
// como la causa real de 503 por "sin tiempo suficiente" en /api/arbol.
const CONCURRENCIA = 8;

function sbHeaders(extra) {
  return Object.assign({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }, extra || {});
}

async function fetchConTimeout(url, opciones) {
  const controlador = new AbortController();
  const corte = setTimeout(() => controlador.abort(), TIMEOUT_FETCH_MS);
  try {
    return await fetch(url, Object.assign({}, opciones, { signal: controlador.signal }));
  } finally {
    clearTimeout(corte);
  }
}

/* Trae TODAS las filas de una tabla (columna "data" jsonb, como guardan todas las cargas de
   esta app), pidiendo varias páginas a la vez — mismo criterio que window.__sbFetchAll del
   navegador, para no encadenar decenas de viajes de ida y vuelta uno detrás de otro. Si el
   conteo o alguna página falla, cae a un recorrido secuencial (más lento, pero nunca deja
   de intentarlo ni devuelve datos incompletos sin avisar). */
async function sbFetchAll(tabla) {
  let total = null;
  try {
    const resConteo = await fetchConTimeout(
      `${SUPABASE_URL}/rest/v1/${tabla}?select=id&limit=1`,
      { headers: sbHeaders({ Prefer: 'count=exact' }) }
    );
    const rango = resConteo.headers.get('content-range'); // "0-0/12345"
    if (rango) {
      const m = rango.match(/\/(\d+)$/);
      if (m) total = parseInt(m[1], 10);
    }
  } catch (e) { /* sin conteo se usa el camino secuencial de abajo */ }

  if (total === 0) return [];

  if (total !== null) {
    const totalPaginas = Math.ceil(total / PAGE_SIZE);
    const porPagina = new Array(totalPaginas);
    let siguiente = 0;
    let fallo = null;
    async function trabajador() {
      while (siguiente < totalPaginas && !fallo) {
        const idx = siguiente++;
        const desde = idx * PAGE_SIZE;
        try {
          const r = await fetchConTimeout(
            `${SUPABASE_URL}/rest/v1/${tabla}?select=data&order=id.asc&limit=${PAGE_SIZE}&offset=${desde}`,
            { headers: sbHeaders() }
          );
          if (!r.ok) { fallo = new Error('Supabase respondió ' + r.status + ' al leer ' + tabla); return; }
          porPagina[idx] = await r.json();
        } catch (e) { fallo = e; return; }
      }
    }
    const hilos = [];
    for (let h = 0; h < Math.min(CONCURRENCIA, totalPaginas); h++) hilos.push(trabajador());
    await Promise.all(hilos);
    if (!fallo) {
      let todas = [];
      for (let p = 0; p < totalPaginas; p++) todas = todas.concat(porPagina[p] || []);
      return todas.map((r) => r.data);
    }
    // sigue abajo con el camino secuencial si el paralelo falló
  }

  let desde = 0;
  let todas = [];
  while (true) {
    const r = await fetchConTimeout(
      `${SUPABASE_URL}/rest/v1/${tabla}?select=data&order=id.asc&limit=${PAGE_SIZE}&offset=${desde}`,
      { headers: sbHeaders() }
    );
    if (!r.ok) throw new Error('Supabase respondió ' + r.status + ' al leer ' + tabla);
    const lote = await r.json();
    todas = todas.concat(lote.map((row) => row.data));
    if (lote.length < PAGE_SIZE) break;
    desde += PAGE_SIZE;
  }
  return todas;
}

/* Deduplica un array de filas crudas (objetos {columna: valor}) por una combinación de
   columnas, quedándose con la ÚLTIMA aparición — misma salvaguarda que ya aplican
   loadBomFromSupabase / loadComponentesFromSupabase / loadVfabFromSupabase en el navegador,
   por si quedaron cargas superpuestas de antes de la corrección del orden borrar->insertar. */
function deduplicar(filas, columnasClave) {
  const vistos = new Map();
  const resultado = [];
  filas.forEach((fila) => {
    const clave = columnasClave.map((c) => String(fila[c] ?? '')).join('||');
    if (vistos.has(clave)) resultado[vistos.get(clave)] = fila;
    else { vistos.set(clave, resultado.length); resultado.push(fila); }
  });
  return resultado;
}

function aColumnasYFilas(filasObjeto) {
  if (!filasObjeto.length) return { columnas: [], filas: [] };
  const columnas = Object.keys(filasObjeto[0]);
  const filas = filasObjeto.map((row) => columnas.map((c) => row[c] ?? ''));
  return { columnas, filas };
}

/* No depende solo de req.query (helper de Vercel para Funciones Node.js): se parsea
   también directo de req.url, que es la única vía que este mismo proyecto ya tiene
   CONFIRMADA en producción (ver el chequeo de "?diagnostico=1" en api/chat-ia.js, que lee
   req.url directamente). Si req.query no viniera poblado por algún motivo del entorno,
   esta vía igual encuentra los parámetros — y si sí viene poblado, ambas coinciden.
   (Bug real que motivó esto: un consumidor externo de /api/arbol recibía 400 incluso con
   "codigo" presente en la URL — ver el commit que corrigió ese endpoint.) */
function leerQuery(req) {
  let queryDeUrl = {};
  try {
    queryDeUrl = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  } catch (e) { /* req.url ausente o no parseable: se sigue solo con req.query */ }
  return Object.assign({}, queryDeUrl, req.query || {});
}

/* CORS abierto (estos endpoints son para que otras páginas, de otro origen, los consulten)
   + manejo de OPTIONS/método. Devuelve true si ya se respondió (OPTIONS o método inválido)
   y el handler que llama debe cortar ahí mismo sin seguir. */
function manejarCorsYMetodo(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido. Usa GET.' });
    return true;
  }
  return false;
}

module.exports = {
  SUPABASE_URL, SUPABASE_ANON_KEY, LIMITE_MS, TIMEOUT_FETCH_MS, PAGE_SIZE, CONCURRENCIA,
  sbHeaders, fetchConTimeout, sbFetchAll, deduplicar, aColumnasYFilas, leerQuery, manejarCorsYMetodo
};
