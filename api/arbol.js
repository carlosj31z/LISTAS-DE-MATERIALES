/**
 * Endpoint serverless de Vercel: GET /api/arbol?codigo=<material>&alt=<alternativa>&combinacion=<n>
 *
 * Da el árbol de fabricación de un producto en JSON, para que OTRA página (un origen
 * distinto, no este mismo sitio) lo pueda consultar por HTTP sin tener que reimplementar
 * nada del versionamiento de SAP. Es el mismo cálculo que ya hace el navegador en la
 * pestaña "Árbol del producto" y en el Chat de consulta (herramienta arbol_producto) —
 * nunca una copia aparte: la lógica vive en arbol-motor.js (raíz del repo, servido también
 * como archivo estático para el navegador) y este archivo solo la alimenta con los datos
 * que trae de Supabase para ESTA petición.
 *
 * Parámetros:
 *   codigo       (obligatorio) — código de Material del producto terminado (PT), o de
 *                cualquier etapa intermedia: si no es Acondicionado, se avanza solo hasta
 *                el producto terminado del que cuelga (igual que hace el chat).
 *   alt          (opcional) — Alternativa de lista a usar. Si el material tiene varias y no
 *                se indica, la respuesta trae "estado":"ambiguo_alternativa" con las
 *                opciones reales, para que quien llama pida de nuevo con la que eligió.
 *   combinacion  (opcional, entero, por defecto 0) — índice de la combinación a devolver
 *                cuando una etapa tiene más de una Versión de Fabricación real candidata
 *                (ver "totalCombinaciones" en la respuesta).
 *
 * Respuesta: el mismo objeto "observacion" que ya arma toolArbolProducto en el navegador
 * (mismos campos "estado": ok | no_encontrado | alt_no_existe | ambiguo_alternativa |
 * multiples_productos | sin_producto_terminado | sin_arbol | sin_datos), como JSON plano.
 */

const crearMotorArbol = require('../arbol-motor.js');

const SUPABASE_URL = 'https://wjlryrqkcnvjlrdibzol.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2Qm4zOkdHeSMOYvatAyNiA_K5crlvFc';

// Mismo presupuesto conservador que api/chat-ia.js (ver el comentario largo ahí): el plan
// gratuito de Vercel corta a los ~10s pase lo que declare vercel.json, así que nunca se
// arranca un tramo más si ya no cabría completo dentro de este límite.
const LIMITE_MS = 9000;
const TIMEOUT_FETCH_MS = 4000;
const PAGE_SIZE = 1000;
const CONCURRENCIA = 4;

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

/* Reproduce exactamente la orquestación de toolArbolProducto (ver el módulo del Chat de
   consulta en index.html): resolver la Alternativa (o avisar si es ambigua), avanzar hasta
   el producto terminado si el código dado es de una etapa intermedia, construir el árbol
   con el motor compartido, y devolver la combinación pedida. Nunca duplica el CÁLCULO del
   árbol — solo decide con qué llamarlo, igual que ya hace el chat en el navegador. */
function calcularArbol(motor, codigo, altPedida, combinacionPedida) {
  const mat = motor.normMat(codigo);
  if (!mat) return { estado: 'no_encontrado', material: '' };

  const bomIdx = motor.buildBomIndex();
  const altsCandidatas = bomIdx.altsByMaterial[mat] || [];
  if (!altsCandidatas.length) return { estado: 'no_encontrado', material: mat };

  const altArg = (altPedida !== undefined && altPedida !== null && String(altPedida).trim() !== '') ? motor.normAlt(altPedida) : null;
  let altN, entryAlt;
  if (altArg) {
    entryAlt = altsCandidatas.filter((a) => a.alt === altArg)[0];
    if (!entryAlt) {
      const opcionesNoExiste = altsCandidatas.map((a) => ({ alt: a.alt, etapa: a.etapa, estado: a.estado }));
      return { estado: 'alt_no_existe', material: mat, altPedida: altArg, opciones: opcionesNoExiste };
    }
    altN = altArg;
  } else {
    const altsUnicas = {};
    altsCandidatas.forEach((a) => { altsUnicas[a.alt] = a; });
    const listaAlts = Object.keys(altsUnicas).map((k) => altsUnicas[k]);
    if (listaAlts.length === 1) {
      entryAlt = listaAlts[0]; altN = entryAlt.alt;
    } else {
      const opciones = listaAlts.map((a) => ({ alt: a.alt, etapa: a.etapa, estado: a.estado, centro: a.centro }));
      return { estado: 'ambiguo_alternativa', material: mat, opciones: opciones };
    }
  }

  let materialFinal = mat, altFinal = altN;
  if (!motor.esEtapaAcondicionado(entryAlt.etapa)) {
    const destinos = motor.encontrarProductosTerminados(mat, altN);
    if (!destinos.length) {
      return { estado: 'sin_producto_terminado', material: mat, alt: altN, etapa: entryAlt.etapa };
    }
    if (destinos.length > 1) {
      const opcionesDestino = destinos.map((d) => {
        const desc = (bomIdx.byKey[motor.keyOf(d.materialFinal, d.altFinal)] || {}).descripcion || '';
        return { materialFinal: d.materialFinal, altFinal: d.altFinal, descripcion: desc };
      });
      return { estado: 'multiples_productos', material: mat, alt: altN, opciones: opcionesDestino };
    }
    materialFinal = destinos[0].materialFinal;
    altFinal = destinos[0].altFinal;
  }

  const resultado = motor.construirTodosLosArboles(materialFinal, altFinal, {});
  const arboles = resultado.arboles || [];
  if (!arboles.length) return { estado: 'sin_arbol', material: materialFinal, alt: altFinal };

  const idxComb = (Number.isInteger(combinacionPedida) && combinacionPedida >= 0 && combinacionPedida < arboles.length) ? combinacionPedida : 0;
  const nodos = arboles[idxComb].map((n) => ({
    etapa: n.etapa, material: n.material, alt: n.alt, version: n.version, versionEsReal: n.versionEsReal,
    vfabBloqueada: n.vfabBloqueada, estado: n.estado, esFabricacion: n.esFabricacion, advertencias: n.advertencias || []
  }));
  return {
    estado: 'ok', materialFinal: materialFinal, altFinal: altFinal,
    combinacion: idxComb, totalCombinaciones: arboles.length, seRecorto: !!resultado.seRecorto, nodos: nodos
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido. Usa GET.' });
    return;
  }

  const query = req.query || {};
  const codigo = String(query.codigo || '').trim();
  if (!codigo) {
    res.status(400).json({ error: 'Falta el parámetro "codigo" (código de Material del producto).' });
    return;
  }
  const alt = query.alt !== undefined ? String(query.alt).trim() : null;
  const combinacionRaw = query.combinacion !== undefined ? parseInt(query.combinacion, 10) : 0;
  const combinacion = Number.isNaN(combinacionRaw) ? 0 : combinacionRaw;

  const arranque = Date.now();
  const quedaTiempo = () => (Date.now() - arranque + TIMEOUT_FETCH_MS) <= LIMITE_MS;

  try {
    if (!quedaTiempo()) {
      res.status(503).json({ error: 'Sin tiempo suficiente para empezar a traer los datos.' });
      return;
    }
    const [bomRaw, compRaw, vfabRaw] = await Promise.all([
      sbFetchAll('mm_bom'),
      sbFetchAll('mm_bom_componentes'),
      sbFetchAll('mm_vfab')
    ]);

    if (!bomRaw.length || !compRaw.length) {
      res.status(200).json({ tipo: 'arbol_producto', estado: 'sin_datos' });
      return;
    }

    if (!quedaTiempo()) {
      res.status(503).json({ error: 'Se agotó el tiempo trayendo Listas de Materiales/Componentes/Versiones de fabricación — el catálogo es demasiado grande para este límite. Vuelve a intentarlo.' });
      return;
    }
    const mmRaw = await sbFetchAll('mm_materiales').catch(() => []);

    const bomDedup = deduplicar(bomRaw, ['Material', 'Lista mat.alternat.', 'Centro-instalación']);
    const compDedup = deduplicar(compRaw, ['Material', 'Lista mat.alternat.', 'Núm.posición', 'Posición alternativa', 'Componente']);
    const vfabDedup = deduplicar(vfabRaw, ['Material', 'Lista mat.alternat.', 'Centro', 'Versión fabricación']);

    const bom = aColumnasYFilas(bomDedup);
    const comp = aColumnasYFilas(compDedup);
    const vfab = aColumnasYFilas(vfabDedup);

    const mmEstadoMap = {};
    mmRaw.forEach((row) => { if (row && row['Material']) mmEstadoMap[String(row['Material'])] = row['Estado mat.todos ce']; });

    const motor = crearMotorArbol({
      BOM_ROWS: bom.filas, BOM_COLUMNS: bom.columnas,
      BOM_COMP_ROWS: comp.filas, BOM_COMP_COLUMNS: comp.columnas,
      BOM_VFAB_ROWS: vfab.filas, BOM_VFAB_COLUMNS: vfab.columnas,
      MM_ESTADO_MAP: mmEstadoMap
    });

    const observacion = calcularArbol(motor, codigo, alt, combinacion);
    observacion.tipo = 'arbol_producto';
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.status(200).json(observacion);
  } catch (e) {
    const esTimeout = e && e.name === 'AbortError';
    res.status(502).json({
      error: esTimeout ? 'Supabase no respondió a tiempo.' : 'No se pudo traer los datos desde Supabase.',
      detalle: String((e && e.message) || e)
    });
  }
};
