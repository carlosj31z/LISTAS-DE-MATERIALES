/**
 * Endpoint serverless de Vercel: GET /api/arbol?codigo=<material>&alt=<alternativa>&combinacion=<n>
 *
 * Da el árbol de fabricación de un producto en JSON, para que OTRA página (un origen
 * distinto, no este mismo sitio) lo pueda consultar por HTTP sin tener que reimplementar
 * nada del versionamiento de SAP. Es el mismo cálculo que ya hace el navegador en la
 * pestaña "Árbol del producto" y en el Chat de consulta (herramienta arbol_producto) —
 * nunca una copia aparte: la lógica vive en arbol-motor.js (raíz del repo, servido también
 * como archivo estático para el navegador) y este archivo solo la alimenta con los datos
 * que trae de Supabase para ESTA petición. Las funciones para hablar con Supabase
 * (paginado, deduplicado, CORS, parseo de query) viven en ./_lib/supabase-datos.js,
 * compartidas con cualquier otro endpoint de /api que las necesite.
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
 *
 * Rendimiento: un consumidor externo real (otra página, fuera de este repo) reportó 503
 * por "sin tiempo suficiente" — el presupuesto de Vercel Hobby (~10s) no alcanzaba para
 * traer las 4 tablas necesarias (mm_bom, mm_bom_componentes, mm_vfab, mm_materiales) desde
 * Supabase. Dos cambios lo atacan directamente: (1) las 4 tablas se traen SIEMPRE las 4 en
 * paralelo, nunca una después de otra (antes mm_materiales se pedía recién después de que
 * las otras tres terminaran); (2) el resultado ya deduplicado y con columnas armadas se
 * guarda un rato corto en memoria (CACHE_TTL_MS), porque el uso real de este endpoint es un
 * botón que alguien pulsa de vez en cuando en la otra página — no tráfico en ráfaga — así
 * que mientras la función siga "tibia" en Vercel, la siguiente consulta no repite el viaje
 * completo a Supabase. La frescura de esa caché es la MISMA que ya se anuncia en el header
 * Cache-Control de la respuesta (30s) — no es una promesa nueva sobre qué tan al día están
 * los datos, solo se aplica también del lado del servidor.
 */

const crearMotorArbol = require('../arbol-motor.js');
const { LIMITE_MS, TIMEOUT_FETCH_MS, sbFetchAll, deduplicar, aColumnasYFilas, leerQuery, manejarCorsYMetodo } = require('./_lib/supabase-datos.js');

const CACHE_TTL_MS = 30000;
let cacheDatos = null; // { expira, bom, comp, vfab, mmEstadoMap } | null — vive mientras la instancia de la función siga tibia

/* Trae (o reusa de la caché en memoria) las 4 tablas ya deduplicadas y con columnas
   armadas, listas para alimentar crearMotorArbol. Devuelve { sinDatos: true } si el BOM o
   los Componentes vienen vacíos — ese caso nunca se cachea, porque probablemente signifique
   que Supabase todavía no tiene datos cargados y vale la pena revisar de nuevo la próxima
   vez, no repetir un "no hay nada" guardado por 30 segundos. */
async function traerDatos() {
  if (cacheDatos && cacheDatos.expira > Date.now()) {
    return cacheDatos;
  }

  const [bomRaw, compRaw, vfabRaw, mmRaw] = await Promise.all([
    sbFetchAll('mm_bom'),
    sbFetchAll('mm_bom_componentes'),
    sbFetchAll('mm_vfab'),
    sbFetchAll('mm_materiales').catch(() => [])
  ]);

  if (!bomRaw.length || !compRaw.length) {
    return { sinDatos: true };
  }

  const bomDedup = deduplicar(bomRaw, ['Material', 'Lista mat.alternat.', 'Centro-instalación']);
  const compDedup = deduplicar(compRaw, ['Material', 'Lista mat.alternat.', 'Núm.posición', 'Posición alternativa', 'Componente']);
  const vfabDedup = deduplicar(vfabRaw, ['Material', 'Lista mat.alternat.', 'Centro', 'Versión fabricación']);

  const bom = aColumnasYFilas(bomDedup);
  const comp = aColumnasYFilas(compDedup);
  const vfab = aColumnasYFilas(vfabDedup);

  const mmEstadoMap = {};
  mmRaw.forEach((row) => { if (row && row['Material']) mmEstadoMap[String(row['Material'])] = row['Estado mat.todos ce']; });

  cacheDatos = { expira: Date.now() + CACHE_TTL_MS, bom, comp, vfab, mmEstadoMap };
  return cacheDatos;
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
  if (manejarCorsYMetodo(req, res)) return;

  const query = leerQuery(req);
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

    const datos = await traerDatos();

    if (datos.sinDatos) {
      res.status(200).json({ tipo: 'arbol_producto', estado: 'sin_datos' });
      return;
    }

    if (!quedaTiempo()) {
      res.status(503).json({ error: 'Se agotó el tiempo trayendo Listas de Materiales/Componentes/Versiones de fabricación — el catálogo es demasiado grande para este límite. Vuelve a intentarlo.' });
      return;
    }

    const { bom, comp, vfab, mmEstadoMap } = datos;
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
