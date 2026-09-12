/* ============================================================
   MOTOR DEL ÁRBOL DE FABRICACIÓN — módulo compartido entre el navegador
   (index.html, pestaña "Árbol del producto", Explosión masiva y el Chat de
   consulta) y el endpoint serverless GET /api/arbol.

   Es la parte más delicada de todo el proyecto (versionamiento de
   fabricación, retroceso de etapas, detección de incoherencias — validada
   contra datos reales de SAP en muchas iteraciones), así que existe UNA
   sola copia: nunca se reimplementa por separado en el servidor.

   Recibe los datos ya cargados (BOM, Componentes, Versiones de Fabricación,
   estado del Maestro) como un objeto plano — nunca lee window.* ni ninguna
   variable global directamente — para poder correr igual en el navegador
   (con getters que reflejan lo que la persona tenga cargado en cada
   momento, ver el bloque de wiring en index.html) y en el servidor (con
   los datos que se acaban de traer de Supabase para ESA petición
   únicamente, sin ningún estado compartido entre peticiones concurrentes).

   crearMotorArbol(datos) espera datos = {
     BOM_ROWS, BOM_COLUMNS,           -- export de Listas de Materiales
     BOM_COMP_ROWS, BOM_COMP_COLUMNS, -- export de Componentes
     BOM_VFAB_ROWS, BOM_VFAB_COLUMNS, -- export de Versiones de Fabricación
     MM_ESTADO_MAP                    -- { Material: "Estado mat.todos ce" }
   }
   ============================================================ */
(function(root, factory){
  if(typeof module !== 'undefined' && module.exports){
    module.exports = factory();
  } else {
    root.crearMotorArbol = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){

  /* ---------- Utilidad homologada de códigos suspendidos (Z1/Z2/Z3…) ----------
     Copia exacta de isSuspendedCode/isZ3Code (ver index.html, bloque de utilidades
     globales) — se duplican aquí porque son 3 líneas cada una, sin ningún estado ni
     dependencia, y así este archivo no necesita cargarse después de ningún otro. */
  function isSuspendedCode(v){
    if(v===null || v===undefined) return false;
    return /^Z\d/i.test(String(v).trim());
  }
  function isZ3Code(v){
    if(v===null || v===undefined) return false;
    return /^Z3/i.test(String(v).trim());
  }

  return function crearMotorArbol(datos){
    datos = datos || {};

    var ETAPA_FABRICACION = 'FABRICACION';

    function normAlt(v){
      var s = (v===null||v===undefined) ? '' : String(v).trim();
      return s === '' ? '1' : s;
    }

    function normMat(v){
      return (v===null||v===undefined) ? '' : String(v).trim();
    }

    function keyOf(material, alt){
      return normMat(material) + '||' + normAlt(alt);
    }

    /* Normaliza el nombre de una etapa para comparar de forma tolerante a variantes como
       "FABRICACION - C. COG", "FABRICACION-R", etc. — cualquier etapa cuyo nombre normalizado
       contenga "FABRICACION" se considera la etapa de Fabricación (fin del retroceso).
       Se quitan tildes letra por letra (nunca normalize + rango de marcas combinantes: ese
       rango de puntos Unicode es demasiado fácil de escribir mal a ciegas). */
    function normEtapa(v){
      if(v===null||v===undefined) return '';
      var s = String(v).toUpperCase()
        .replace(/Á/g,'A').replace(/É/g,'E').replace(/Í/g,'I').replace(/Ó/g,'O').replace(/Ú/g,'U')
        .replace(/Ü/g,'U').replace(/Ñ/g,'N')
        .trim();
      return s;
    }
    function esEtapaFabricacion(etapaTexto){
      return normEtapa(etapaTexto).indexOf(ETAPA_FABRICACION) !== -1;
    }

    var ETAPA_ACONDICIONADO = 'ACONDICIONADO';
    /* Un "producto terminado" es un material cuya lista está en etapa Acondicionado — es el
       punto de entrada natural del árbol (última etapa del proceso). Se usa para limitar el
       buscador por descripción a solo estos materiales. */
    function esEtapaAcondicionado(etapaTexto){
      return normEtapa(etapaTexto).indexOf(ETAPA_ACONDICIONADO) !== -1;
    }

    /* Alternativas de conciliación (60-69) y reacondicionado (95-99), mismo criterio que ya
       usa el resto de la app (ver isConciliacionAltList / isReacondicionadoAltList en BOM). */
    function esConciliacion(altStr){
      return /^6\d$/.test(altStr);
    }
    function esReacondicionado(altStr){
      return /^9[5-9]$/.test(altStr);
    }

    /* Mapeo de alternativa de conciliación (66,67,68,69…) a una única letra para el dígito 2
       de la Versión de Fabricación: 66->C, 67->D, 68->E, 69->F… (empezando en C). Confirmado
       con los ejemplos del usuario: envase alt.66 -> acondicionado dígito2 = 'C'. */
    function letraParaAltPrevia(altStr){
      var n = parseInt(altStr, 10);
      if(isNaN(n)) return '0';
      if(n>=1 && n<=9) return String(n);
      if(n>=66 && n<=90){
        var letra = String.fromCharCode('C'.charCodeAt(0) + (n-66));
        return letra;
      }
      // Alternativas de reacondicionado (95-99) no deberían aparecer nunca como "etapa
      // previa" de otra (confirmado por el usuario: el reacondicionado solo existe en
      // Acondicionado, no es antecedido por nada) — se deja constancia con '?' si ocurriera,
      // en vez de fallar silenciosamente.
      return '?';
    }

    /* Inversa de letraParaAltPrevia: dado el dígito 2 de una Versión de Fabricación REAL ya
       registrada en SAP, devuelve la alternativa numérica de la ETAPA PREVIA que ese dígito
       representa. '0' -> sin etapa previa (es la propia Fabricación). '1'-'9' -> esa misma
       alternativa. 'C'-'Z' -> alternativa de conciliación 66-90 (C=66, D=67…). Devuelve null
       si el carácter no es reconocible (dato inesperado, no se debe adivinar). */
    function altPreviaDesdeDigito2(digito2){
      if(digito2===null || digito2===undefined || digito2==='') return null;
      var c = String(digito2).trim().toUpperCase();
      if(c === '0') return null; // sin etapa previa
      if(/^[1-9]$/.test(c)) return c;
      if(/^[A-Z]$/.test(c)){
        var n = c.charCodeAt(0) - 'C'.charCodeAt(0) + 66;
        if(n>=66 && n<=90) return String(n);
      }
      return null;
    }

    /* Calcula la Versión de Fabricación (4 dígitos) de una etapa, dada su propia alternativa
       y la alternativa de la etapa previa. digito1Raiz es el dígito 1 real de toda la
       cadena — la alternativa de la etapa FABRICACIÓN de la que desciende este árbol (o
       '1' si aún no se conoce, ej. al calcular Fabricación misma antes de saber su propia
       versión real). Confirmado por el usuario: el dígito 1 identifica qué alternativa de
       Fabricación se está usando, y por eso debe ser el MISMO en todas las etapas de una
       misma cadena — nunca se fija en '1' a ciegas. */
    function calcularVersionFabricacion(altPropiaStr, altPreviaStr, esFabricacion, digito1Raiz){
      // Caso reacondicionado: solo aplica a Acondicionado, formato fijo '00' + alternativa.
      if(esReacondicionado(altPropiaStr)){
        return '00' + altPropiaStr;
      }
      var digito1 = digito1Raiz || '1';
      var digito2;
      if(esFabricacion || altPreviaStr===null || altPreviaStr===undefined){
        digito2 = '0';
      } else {
        digito2 = letraParaAltPrevia(altPreviaStr);
      }
      var digitos34;
      if(esConciliacion(altPropiaStr)){
        digitos34 = altPropiaStr; // ya son 2 dígitos (66, 67...)
      } else {
        var n = parseInt(altPropiaStr, 10);
        digitos34 = isNaN(n) ? altPropiaStr : String(n).padStart(2, '0');
      }
      return digito1 + digito2 + digitos34;
    }

    /* Caché de los índices: se reconstruyen solo si la referencia de datos.BOM_ROWS /
       datos.BOM_COMP_ROWS cambió desde la última vez (es decir, se cargó un archivo nuevo).
       Evita recorrer miles de filas en cada árbol que se construya durante la misma sesión
       del navegador — en el servidor, como cada petición crea su propio motor con datos
       recién traídos, esta caché simplemente empieza vacía y se llena una vez por petición. */
    var __bomIndexCache = { rowsRef: null, index: null };
    var __compIndexCache = { rowsRef: null, index: null };

    /* Construye un índice Material||Alt -> fila cruda del BOM (datos.BOM_ROWS), agregando
       además un índice auxiliar Material -> [alternativas registradas] para poder listar
       "qué alternativas tiene este material" cuando hay que buscar cuál coincide. */
    function buildBomIndex(){
      var rows = datos.BOM_ROWS || [];
      if(__bomIndexCache.rowsRef === rows && __bomIndexCache.index){
        return __bomIndexCache.index;
      }
      var cols = datos.BOM_COLUMNS || [];
      var idx = {};
      cols.forEach(function(c,i){ idx[c]=i; });
      var iMaterial = idx['Material'];
      var iAlt = idx['Lista mat.alternat.'];
      var iDesc = idx['Descripción de LMat'];
      var iEstado = idx['Stat.txt.breve'];
      var iTexto = idx['Texto de alternativa'];
      var iCentro = idx['Centro-instalación'];
      var iUtil = idx['Utilización LMat'];
      var iListaTec = idx['Lista de materiales'];

      var byKey = {};
      var altsByMaterial = {};
      rows.forEach(function(row){
        // Igual que en el resto de la app (carga del BOM principal): solo se consideran
        // registros con Utilización LMat = 1. Un mismo Material puede tener varias filas en
        // el export con distinta Utilización (ej. "ACONDICIONADO" con Utilización=1 y
        // "FORMULA CUALI-CUANTITATIVA" con Utilización=8 para el mismo Material+Alt) — sin
        // este filtro se podría tomar por error la fila equivocada.
        if(iUtil!==undefined && String(row[iUtil]??'').trim() !== '1') return;
        var mat = normMat(iMaterial!==undefined ? row[iMaterial] : '');
        if(!mat) return;
        var alt = normAlt(iAlt!==undefined ? row[iAlt] : '');
        var key = mat + '||' + alt;
        var entry = {
          material: mat, alt: alt,
          descripcion: iDesc!==undefined ? row[iDesc] : '',
          estado: iEstado!==undefined ? row[iEstado] : '',
          etapa: iTexto!==undefined ? row[iTexto] : '',
          centro: iCentro!==undefined ? row[iCentro] : '',
          listaTecnica: iListaTec!==undefined ? String(row[iListaTec]||'').trim() : ''
        };
        byKey[key] = entry;
        if(!altsByMaterial[mat]) altsByMaterial[mat] = [];
        altsByMaterial[mat].push(entry);
      });
      var result = { byKey: byKey, altsByMaterial: altsByMaterial, iMaterial: iMaterial, iAlt: iAlt };
      __bomIndexCache = { rowsRef: rows, index: result };
      return result;
    }

    /* Devuelve el componente de la posición 0010 (posición mínima) de una lista
       (Material, Alt), leyendo datos.BOM_COMP_ROWS. Se usa SOLO para conocer el código del
       material de la etapa previa — nunca su alternativa (eso se lee del BOM real). */
    function buildCompFirstPosIndex(){
      var rows = datos.BOM_COMP_ROWS || [];
      if(__compIndexCache.rowsRef === rows && __compIndexCache.index){
        return __compIndexCache.index;
      }
      var cols = datos.BOM_COMP_COLUMNS || [];
      var idx = {};
      cols.forEach(function(c,i){ idx[c]=i; });
      var iMaterial = idx['Material'];
      var iAlt = idx['Lista mat.alternat.'];
      var iPos = idx['Núm.posición'];
      var iComponente = idx['Componente'];
      var iDenom = idx['Denominación de componente'];

      var firstByKey = {};
      rows.forEach(function(row){
        var mat = normMat(iMaterial!==undefined ? row[iMaterial] : '');
        if(!mat) return;
        var alt = normAlt(iAlt!==undefined ? row[iAlt] : '');
        var key = mat + '||' + alt;
        var pos = iPos!==undefined ? String(row[iPos]||'').trim() : '';
        var current = firstByKey[key];
        if(!current || (pos && pos < current.pos)){
          firstByKey[key] = {
            pos: pos,
            material: mat,
            alt: alt,
            componente: iComponente!==undefined ? normMat(row[iComponente]) : '',
            denominacion: iDenom!==undefined ? row[iDenom] : ''
          };
        }
      });
      // Índice INVERSO: código de componente -> lista de {material, alt} de las listas que
      // lo usan como su posición 0010 (es decir, las etapas POSTERIORES que parten de este
      // material). Se construye a partir de firstByKey ya resuelto, así solo se consideran
      // relaciones de "etapa previa" reales (posición 0010), no cualquier componente.
      var byComponentAsFirstPos = {};
      Object.keys(firstByKey).forEach(function(k){
        var entry = firstByKey[k];
        if(!entry.componente) return;
        if(!byComponentAsFirstPos[entry.componente]) byComponentAsFirstPos[entry.componente] = [];
        byComponentAsFirstPos[entry.componente].push({ material: entry.material, alt: entry.alt });
      });
      var result2 = { firstByKey: firstByKey, byComponentAsFirstPos: byComponentAsFirstPos };
      __compIndexCache = { rowsRef: rows, index: result2 };
      return result2;
    }

    /* Índice Material||Alt -> Versión de Fabricación REAL ya registrada en SAP (columna
       "Versión fabricación" del export de Versiones de Fabricación, datos.BOM_VFAB_ROWS).
       Cuando existe, esta es la fuente de verdad — la fórmula de 4 dígitos solo se usa como
       respaldo/estimación cuando no hay un dato real cargado para esa combinación. Si hay
       varias versiones para la misma combinación, se toma la primera (ya vienen ordenadas
       por VFAB_MAP en el módulo BOM, pero aquí se reconstruye directo del array para no
       depender de esa variable privada). */
    var __vfabIndexCache = { rowsRef: null, index: null };
    function buildVfabIndex(){
      var rows = datos.BOM_VFAB_ROWS || [];
      if(__vfabIndexCache.rowsRef === rows && __vfabIndexCache.index){
        return __vfabIndexCache.index;
      }
      var cols = datos.BOM_VFAB_COLUMNS || [];
      var idx = {};
      cols.forEach(function(c,i){ idx[c]=i; });
      var iMaterial = idx['Material'];
      var iAlt = idx['Lista mat.alternat.'];
      var iVersion = idx['Versión fabricación'];
      var iCentro = idx['Centro'];
      var iBloqueo = idx['Bloqueo de versión de fabricación'];

      var byKey = {};
      rows.forEach(function(row){
        var mat = normMat(iMaterial!==undefined ? row[iMaterial] : '');
        if(!mat) return;
        var alt = normAlt(iAlt!==undefined ? row[iAlt] : '');
        var key = mat + '||' + alt;
        var version = iVersion!==undefined ? String(row[iVersion]||'').trim() : '';
        if(!version) return;
        if(!byKey[key]) byKey[key] = [];
        byKey[key].push({
          version: version,
          centro: iCentro!==undefined ? row[iCentro] : '',
          bloqueada: iBloqueo!==undefined && String(row[iBloqueo]||'').trim() === '1'
        });
      });
      var result = { byKey: byKey };
      __vfabIndexCache = { rowsRef: rows, index: result };
      return result;
    }

    /* Estado de bloqueo Z de un material, consultando primero el Maestro de Materiales
       (datos.MM_ESTADO_MAP, si está cargado) y devolviendo el código tal cual (Z1, Z2, Z3…)
       o null si no está bloqueado / no se encontró información. */
    function estadoZDelMaterial(material){
      var mat = normMat(material);
      if(!mat) return null;
      var estado = datos.MM_ESTADO_MAP ? datos.MM_ESTADO_MAP[mat] : undefined;
      if(estado && isSuspendedCode(estado)) return String(estado).trim();
      return null;
    }

    /* Devuelve TODOS los componentes de una lista (Material, Alt) — no solo el de posición
       0010 — con su estado de bloqueo Z resuelto, para el desplegable "ojo" de cada etapa. */
    var __allCompsIndexCache = { rowsRef: null, index: null };
    function buildAllCompsIndex(){
      var rows = datos.BOM_COMP_ROWS || [];
      if(__allCompsIndexCache.rowsRef === rows && __allCompsIndexCache.index){
        return __allCompsIndexCache.index;
      }
      var cols = datos.BOM_COMP_COLUMNS || [];
      var idx = {};
      cols.forEach(function(c,i){ idx[c]=i; });
      var iMaterial = idx['Material'];
      var iAlt = idx['Lista mat.alternat.'];
      var iPos = idx['Núm.posición'];
      var iComponente = idx['Componente'];
      var iDenom = idx['Denominación de componente'];
      var iCantidad = idx['Cantidad componente'];
      var iUM = idx['Un.medida componente'];
      var iListaTec = idx['Lista de materiales'];

      // Índice por Material+Alt+ListaTecnica (clave completa, sin ambigüedad — evita mezclar
      // componentes de dos listas técnicas distintas que comparten el mismo Material+Alt,
      // como ACONDICIONADO vs FORMULA CUALI-CUANTITATIVA del mismo material) y, como
      // respaldo, también por Material+Alt solo (para archivos de Componentes que no traigan
      // la columna "Lista de materiales").
      var byKeyCompleta = {};
      var byKeySimple = {};
      rows.forEach(function(row){
        var mat = normMat(iMaterial!==undefined ? row[iMaterial] : '');
        if(!mat) return;
        var alt = normAlt(iAlt!==undefined ? row[iAlt] : '');
        var listaTec = iListaTec!==undefined ? String(row[iListaTec]||'').trim() : '';
        var keySimple = mat + '||' + alt;
        var entry = {
          pos: iPos!==undefined ? String(row[iPos]||'').trim() : '',
          componente: iComponente!==undefined ? normMat(row[iComponente]) : '',
          denominacion: iDenom!==undefined ? row[iDenom] : '',
          cantidad: iCantidad!==undefined ? row[iCantidad] : '',
          um: iUM!==undefined ? row[iUM] : ''
        };
        if(listaTec){
          var keyCompleta = keySimple + '||' + listaTec;
          if(!byKeyCompleta[keyCompleta]) byKeyCompleta[keyCompleta] = [];
          byKeyCompleta[keyCompleta].push(entry);
        }
        if(!byKeySimple[keySimple]) byKeySimple[keySimple] = [];
        byKeySimple[keySimple].push(entry);
      });
      [byKeyCompleta, byKeySimple].forEach(function(byKey){
        Object.keys(byKey).forEach(function(k){
          byKey[k].sort(function(a,b){ return a.pos < b.pos ? -1 : (a.pos > b.pos ? 1 : 0); });
        });
      });

      /* Devuelve los componentes de un nodo del árbol, usando la Lista técnica exacta
         (n.listaTecnica, ya resuelta por buildBomIndex) cuando el archivo de Componentes
         trae esa columna — si no la trae, o no hay coincidencia por esa vía, cae al índice
         simple por Material+Alt como respaldo (comportamiento anterior). */
      function componentesDe(material, alt, listaTecnica){
        var keySimple = material + '||' + alt;
        if(listaTecnica){
          var keyCompleta = keySimple + '||' + listaTecnica;
          if(byKeyCompleta[keyCompleta]) return byKeyCompleta[keyCompleta];
        }
        return byKeySimple[keySimple] || [];
      }

      var resultAllComps = { byKey: byKeySimple, componentesDe: componentesDe };
      __allCompsIndexCache = { rowsRef: rows, index: resultAllComps };
      return resultAllComps;
    }

    /* Algoritmo principal: reconstruye la cadena de etapas retrocediendo desde
       (materialInicial, altInicial) hasta llegar a una lista cuya Etapa sea Fabricación (o
       hasta que no se pueda seguir retrocediendo). Devuelve un array de nodos, del más
       reciente (Acondicionado, índice 0) al más antiguo (Fabricación, último índice), cada
       uno con su Versión de Fabricación calculada y advertencias si las hay.
       No lanza excepción: cualquier problema se refleja como advertencia en el nodo
       correspondiente y el retroceso se detiene ahí. */
    /* Construye UN paso de la cadena (un nodo) a partir de (material, alt), sin decidir
       todavía por cuál VFab candidata continuar si hay más de una — eso lo decide quien
       llama, pasando "vfabIndexElegido" (0 = primera, por defecto). Devuelve el nodo más la
       información necesaria para que el llamador siga retrocediendo. */
    function construirNodoIndividual(matActual, altActual, visitados, vfabIndexElegido, digito1Objetivo){
      var bomIdx = buildBomIndex();
      var compIdx = buildCompFirstPosIndex();
      var vfabIdx = buildVfabIndex();

      var key = keyOf(matActual, altActual);
      var bomEntry = bomIdx.byKey[key];
      var advertencias = [];
      if(!bomEntry){
        advertencias.push('No se encontró la combinación Material ' + matActual + ' + Alternativa ' + altActual + ' en las Listas de Materiales cargadas. No se puede confirmar esta etapa ni seguir retrocediendo desde aquí.');
      }
      var esFab = bomEntry ? esEtapaFabricacion(bomEntry.etapa) : false;

      var nodo = {
        material: matActual,
        alt: altActual,
        descripcion: bomEntry ? bomEntry.descripcion : '',
        etapa: bomEntry ? bomEntry.etapa : '(no encontrada)',
        estado: bomEntry ? bomEntry.estado : '',
        centro: bomEntry ? bomEntry.centro : '',
        listaTecnica: bomEntry ? bomEntry.listaTecnica : '',
        esFabricacion: esFab || !bomEntry,
        version: null,
        versionEsReal: false,
        vfabBloqueada: false,
        advertencias: advertencias
      };

      var vfabReales = vfabIdx.byKey[key];
      var digito2Real = null;
      var totalVfabCandidatas = vfabReales ? vfabReales.length : 0;
      if(vfabReales && vfabReales.length > 0){
        var indiceElegido;
        if(vfabIndexElegido !== null && vfabIndexElegido !== undefined){
          // Elección FORZADA (el usuario la fijó a mano en el selector de esta etapa, o viene
          // de "Explosión masiva"/"Ver en Árbol del producto") — se respeta tal cual, sin
          // aplicar ningún filtro por dígito 1.
          indiceElegido = Math.min(vfabIndexElegido, vfabReales.length-1);
        } else if(digito1Objetivo){
          // SIN elección forzada, pero ya se conoce el dígito 1 de la cadena (confirmado por
          // el usuario: el dígito 1 identifica la alternativa de Fabricación de toda la
          // cadena, y debe ser el MISMO en todas las etapas) — se prefiere automáticamente,
          // entre las VFab reales de esta combinación, la que comparta ese dígito 1. Si
          // ninguna coincide, se cae al comportamiento anterior (la primera de la lista), y
          // la incoherencia se sigue detectando y avisando más abajo como ya hacía.
          var idxCoincide = -1;
          for(var vi=0; vi<vfabReales.length; vi++){
            if(String(vfabReales[vi].version||'').charAt(0) === digito1Objetivo){ idxCoincide = vi; break; }
          }
          indiceElegido = idxCoincide !== -1 ? idxCoincide : 0;
        } else {
          // Primer nodo de la cadena (todavía no hay dígito 1 objetivo): comportamiento de
          // siempre, la primera VFab real de la lista.
          indiceElegido = 0;
        }
        var elegido = vfabReales[indiceElegido];
        nodo.version = elegido.version;
        nodo.versionEsReal = true;
        nodo.vfabBloqueada = elegido.bloqueada;
        nodo.vfabOpciones = vfabReales; // todas las candidatas, para el selector de UI
        nodo.vfabIndexElegido = indiceElegido;
        if(nodo.vfabBloqueada){
          nodo.advertencias.push('Esta Versión de Fabricación figura BLOQUEADA en el archivo de Versiones de Fabricación cargado.');
        }
        if(String(nodo.version).length >= 2){
          digito2Real = String(nodo.version).charAt(1);
        }
      }

      nodo.bloqueoZ = estadoZDelMaterial(nodo.material);
      if(nodo.bloqueoZ){
        nodo.advertencias.push('El material ' + nodo.material + ' figura con estado ' + nodo.bloqueoZ + ' en el Maestro de Materiales' + (isZ3Code(nodo.bloqueoZ) ? ' (bloqueo definitivo).' : '.'));
      }
      if(nodo.estado && String(nodo.estado).trim().toLowerCase()==='inactivo'){
        nodo.advertencias.push('Esta lista de materiales figura como INACTIVA en SAP. Se incluye igual en el árbol, tal como se indicó, marcado aquí como advertencia.');
      }

      var puedeRetroceder = !!bomEntry && !esFab;
      var infoRetroceso = null; // { codigoPrevio, altEsperada, altConfirmada, compEntry }

      if(puedeRetroceder){
        if(esReacondicionado(altActual)){
          nodo.finNatural = true;
          nodo.finNaturalInfo = 'Esta es una alternativa de reacondicionado (' + altActual + ') — no tiene una etapa previa de Fabricación/Envase asociada en este árbol, así que el retroceso se detiene aquí.';
          puedeRetroceder = false;
        } else {
          var compEntry = compIdx.firstByKey[key];
          if(!compEntry){
            nodo.advertencias.push('Esta lista no tiene componentes cargados (o ninguno en posición 0010), así que no se puede identificar la etapa previa. Verifica que el archivo de Componentes esté cargado y actualizado.');
            puedeRetroceder = false;
          } else if(!compEntry.componente){
            nodo.advertencias.push('El componente de la posición ' + (compEntry.pos||'0010') + ' no tiene código de Material válido.');
            puedeRetroceder = false;
          } else {
            var altEsperadaSiguiente, altEsperadaConfirmada;
            if(digito2Real !== null){
              var altDesdeDigito = altPreviaDesdeDigito2(digito2Real);
              if(altDesdeDigito === null){
                nodo.advertencias.push('La Versión de Fabricación real de esta etapa (' + nodo.version + ') indica que no debería tener etapa previa (dígito 2 = "0"), pero su componente de posición 0010 apunta a otro material (' + compEntry.componente + '). Se usa la misma alternativa (' + altActual + ') como respaldo, sin confirmar.');
                altEsperadaSiguiente = altActual;
                altEsperadaConfirmada = false;
              } else {
                altEsperadaSiguiente = altDesdeDigito;
                altEsperadaConfirmada = true;
              }
            } else {
              altEsperadaSiguiente = altActual;
              altEsperadaConfirmada = false;
            }
            infoRetroceso = {
              codigoPrevio: compEntry.componente,
              denominacionPrevio: compEntry.denominacion,
              altEsperada: altEsperadaSiguiente,
              altConfirmada: altEsperadaConfirmada
            };
          }
        }
      }

      return { nodo: nodo, infoRetroceso: infoRetroceso, totalVfabCandidatas: totalVfabCandidatas };
    }

    /* Continúa el retroceso a partir de infoRetroceso (calculado por
       construirNodoIndividual), resolviendo la alternativa esperada contra las listas
       registradas del material previo. Devuelve { siguiente:{material,alt} } o marca el nodo
       con finNatural / advertencia de inconsistencia y devuelve null si no se puede seguir. */
    function resolverEtapaPrevia(nodo, infoRetroceso){
      var bomIdx = buildBomIndex();
      var candidatas = bomIdx.altsByMaterial[infoRetroceso.codigoPrevio] || [];
      var coincide = candidatas.filter(function(c){ return c.alt === infoRetroceso.altEsperada; });

      if(candidatas.length === 0){
        nodo.finNatural = true;
        nodo.finNaturalInfo = 'La etapa previa (componente ' + infoRetroceso.codigoPrevio + (infoRetroceso.denominacionPrevio ? ' — ' + infoRetroceso.denominacionPrevio : '') + ') no tiene una lista de materiales propia en SAP — se usa directo como materia prima en esta etapa, sin una Fabricación separada. El árbol termina aquí.';
        return null;
      }
      if(coincide.length === 0){
        var altsDisponibles = candidatas.map(function(c){ return c.alt; }).join(', ');
        var origenAlt = infoRetroceso.altConfirmada ? ('según el dígito 2 de la Versión de Fabricación real ' + nodo.version) : ('supuesta, sin confirmar, igual a la de esta etapa');
        nodo.advertencias.push('INCONSISTENCIA: el componente de la etapa previa es el material ' + infoRetroceso.codigoPrevio + ', pero no tiene registrada la Alternativa ' + infoRetroceso.altEsperada + ' (' + origenAlt + ') en las Listas de Materiales (alternativas disponibles para ese material: ' + altsDisponibles + '). Se detiene el retroceso — revisar manualmente.');
        return null;
      }
      if(coincide.length > 1){
        nodo.advertencias.push('El material ' + infoRetroceso.codigoPrevio + ' tiene más de una fila registrada con Alternativa ' + infoRetroceso.altEsperada + ' (posiblemente distintos Centros). Se usó la primera encontrada.');
      }
      return { siguiente: coincide[0] };
    }

    /* Verifica que los dígitos 3-4 de una Versión de Fabricación REAL coincidan con la
       PROPIA Alternativa de esa lista — confirmado por el usuario: si la VFab es "1166"
       pero está registrada contra la Alternativa "1" de la lista, es un error real en SAP
       (debería estar contra la Alternativa "66"). Solo aplica a VFab puramente numéricas de
       4 dígitos (hay códigos especiales tipo "VF01", "3MO1" que no siguen este patrón y no
       se evalúan), y no aplica a reacondicionados (formato fijo "00XX", sin relación con la
       alternativa propia en ese sentido). Devuelve null si no aplica o si es coherente, o el
       texto de advertencia si detecta la incoherencia. */
    function verificarCoherenciaDigitos34(version, altPropia){
      var v = String(version||'').trim();
      if(!/^\d{4}$/.test(v)) return null; // no es una VFab numérica de 4 dígitos: no se evalúa
      if(esReacondicionado(altPropia)) return null;
      var d34 = v.slice(2);
      var altNorm = altPropia.length <= 2 ? altPropia.padStart(2, '0') : altPropia;
      if(d34 !== altNorm){
        return 'INCOHERENCIA: la Versión de Fabricación ' + v + ' está registrada contra la Alternativa ' + altPropia + ', pero sus dígitos 3-4 ("' + d34 + '") indican que debería corresponder a la Alternativa ' + parseInt(d34,10) + ' de la lista. Revisar en SAP con qué Alternativa se creó realmente esta versión.';
      }
      return null;
    }

    /* Completa cada nodo sin Versión de Fabricación real con la fórmula de 4 dígitos
       (respaldo), y anota sus componentes reales (para el botón "ojo"). Se aplica sobre un
       árbol YA completo (array de nodos, de Acondicionado hacia Fabricación). */
    function completarArbol(nodos){
      var allCompsIdx = buildAllCompsIndex();

      // El dígito 1 identifica la alternativa de la etapa FABRICACIÓN de la que desciende
      // toda la cadena — debe ser el MISMO en todas las etapas (confirmado por el usuario).
      // Se toma del nodo de Fabricación (el último del array, el más antiguo): si tiene una
      // Versión de Fabricación real, se lee su propio dígito 1 directamente de ahí; si no,
      // se usa su alternativa propia (que es lo que ese dígito 1 debería representar).
      var nodoFabricacion = nodos[nodos.length-1];
      var digito1Raiz = '1';
      if(nodoFabricacion){
        if(nodoFabricacion.versionEsReal && String(nodoFabricacion.version||'').length>=1){
          digito1Raiz = String(nodoFabricacion.version).charAt(0);
        } else if(nodoFabricacion.alt){
          var nFab = parseInt(nodoFabricacion.alt, 10);
          digito1Raiz = isNaN(nFab) ? '1' : String(nFab);
        }
      }

      nodos.forEach(function(n, i){
        if(!n.versionEsReal){
          var altPrevia = (i < nodos.length-1) ? nodos[i+1].alt : null;
          n.version = calcularVersionFabricacion(n.alt, altPrevia, n.esFabricacion, digito1Raiz);
          if(datos.BOM_VFAB_ROWS && datos.BOM_VFAB_ROWS.length > 0){
            n.advertencias.push('No se encontró una Versión de Fabricación registrada para este Material+Alternativa en el archivo cargado — se muestra un valor ESTIMADO con la fórmula (' + n.version + '), a confirmar en SAP.');
          }
        } else {
          if(!n.esFabricacion){
            // Validación de coherencia: la Versión de Fabricación REAL de esta etapa debería
            // empezar con el mismo dígito 1 que la etapa Fabricación de la cadena — si no
            // coincide, es una señal de que esta combinación de VFabs registradas en SAP no es
            // realmente consistente entre sí (aunque cada una exista por separado), y se
            // advierte para que se revise manualmente.
            var digito1Propio = String(n.version||'').charAt(0);
            if(digito1Propio && digito1Propio !== digito1Raiz){
              n.advertencias.push('INCOHERENCIA: la Versión de Fabricación de esta etapa (' + n.version + ') empieza con "' + digito1Propio + '", pero la etapa de Fabricación de esta cadena usa alternativa/dígito "' + digito1Raiz + '" — todas las etapas de una misma cadena deberían compartir el mismo primer dígito. Revisar en SAP si esta combinación de versiones es realmente correcta.');
            }
          }
          // Validación de coherencia dígitos 3-4 vs Alternativa propia — independiente de la
          // cadena, aplica a CUALQUIER etapa con VFab real (incluida Fabricación).
          var avisoD34 = verificarCoherenciaDigitos34(n.version, n.alt);
          if(avisoD34) n.advertencias.push(avisoD34);
        }
        n.componentes = allCompsIdx.componentesDe(n.material, n.alt, n.listaTecnica);
      });
      return nodos;
    }

    /* Límite de seguridad al explorar combinaciones: evita que un caso con muchas etapas con
       múltiples VFab genere una explosión combinatoria impráctica de mostrar (ej. 4 etapas
       con 3 VFab cada una ya son 81 árboles). Por encima de este límite se avisa y se
       recorta, priorizando siempre las primeras combinaciones (las que usan la VFab por
       defecto en más etapas). */
    var MAX_ARBOLES_COMBINACIONES = 24;

    /* Encuentra todos los productos terminados (Acondicionado) posibles a los que se llega
       AVANZANDO desde (material, alt) — es decir, el material puede ser de cualquier etapa
       (Fabricación, Recubrimiento, Envase, Inspección) y esta función recorre hacia adelante
       usando el índice inverso de componentes (byComponentAsFirstPos: qué listas usan este
       material en su posición 0010) hasta llegar a una etapa Acondicionado. Como un mismo
       material intermedio puede alimentar más de una lista distinta (raro, pero posible), se
       devuelven TODOS los caminos encontrados, cada uno como {materialFinal, altFinal,
       camino:[{material,alt,etapa}, ...]} yendo desde el material de entrada hasta el
       Acondicionado. Tiene su propio límite de seguridad para no explotar combinatoriamente
       ni entrar en bucles con datos inconsistentes. */
    var MAX_CAMINOS_AVANCE = 40;
    function encontrarProductosTerminados(material, alt){
      var bomIdx = buildBomIndex();
      var compIdx = buildCompFirstPosIndex();
      var mat0 = normMat(material);
      var alt0 = normAlt(alt);
      var key0 = keyOf(mat0, alt0);
      var bomEntry0 = bomIdx.byKey[key0];

      // Si el punto de partida YA es Acondicionado, el único "camino" es él mismo.
      if(bomEntry0 && esEtapaAcondicionado(bomEntry0.etapa)){
        return [{ materialFinal: mat0, altFinal: alt0, camino: [{material:mat0, alt:alt0, etapa:bomEntry0.etapa}] }];
      }

      var resultados = [];
      function avanzar(matActual, altActual, visitados, caminoAcumulado){
        if(resultados.length >= MAX_CAMINOS_AVANCE) return;
        var key = keyOf(matActual, altActual);
        if(visitados[key]) return; // ciclo — se corta esta rama sin reportar (dato inconsistente)
        var nuevosVisitados = Object.assign({}, visitados);
        nuevosVisitados[key] = true;

        var siguientes = compIdx.byComponentAsFirstPos[matActual] || [];
        // Solo interesan las listas siguientes cuya ALTERNATIVA coincide con la actual —
        // mismo criterio de "etapa alt.N -> etapa siguiente también resuelve a alt.N" que ya
        // usa el retroceso, ya que es la relación real registrada entre etapas.
        var candidatas = siguientes.filter(function(s){ return normAlt(s.alt) === altActual; });

        if(candidatas.length === 0){
          // No hay ninguna etapa posterior registrada que use este material -- puede que el
          // material de partida ya sea el final de la cadena hacia adelante sin llegar a
          // Acondicionado (dato incompleto), se ignora silenciosamente este camino.
          return;
        }

        candidatas.forEach(function(sig){
          var sigKey = keyOf(sig.material, sig.alt);
          var bomEntry = bomIdx.byKey[sigKey];
          var nuevoCamino = caminoAcumulado.concat([{ material: sig.material, alt: sig.alt, etapa: bomEntry?bomEntry.etapa:'(no encontrada)' }]);
          if(bomEntry && esEtapaAcondicionado(bomEntry.etapa)){
            resultados.push({ materialFinal: sig.material, altFinal: sig.alt, camino: nuevoCamino });
          } else {
            avanzar(sig.material, sig.alt, nuevosVisitados, nuevoCamino);
          }
        });
      }

      avanzar(mat0, alt0, {}, [{material:mat0, alt:alt0, etapa: bomEntry0?bomEntry0.etapa:'(no encontrada)'}]);
      return resultados;
    }

    /* Construye TODAS las combinaciones de árbol posibles a partir de (materialInicial,
       altInicial), ramificando cada vez que una etapa tiene más de una Versión de
       Fabricación real candidata (el usuario confirmó que en ese caso debe poder elegir cuál
       usar, y ver todas las combinaciones resultantes). eleccionesForzadas es un mapa
       opcional {"material||alt": indiceVfabElegido} para fijar una elección específica en un
       punto conocido de la cadena (usado por el selector de la UI al cambiar de versión en
       una etapa ya construida). */
    function construirTodosLosArboles(materialInicial, altInicial, eleccionesForzadas){
      eleccionesForzadas = eleccionesForzadas || {};
      var arbolesCompletos = [];
      var seRecorto = false;
      var vfabIdx = buildVfabIndex();

      function explorar(matActual, altActual, visitados, nodosAcumulados, digito1Objetivo){
        if(arbolesCompletos.length >= MAX_ARBOLES_COMBINACIONES){ seRecorto = true; return; }
        var key = keyOf(matActual, altActual);
        if(visitados[key]){
          var ultimoNodo = nodosAcumulados[nodosAcumulados.length-1];
          ultimoNodo.advertencias.push('Se detectó un ciclo (esta combinación Material+Alternativa ya apareció antes en la cadena) — se detiene el retroceso aquí para evitar un bucle infinito.');
          arbolesCompletos.push(nodosAcumulados.slice());
          return;
        }

        // Punto de ramificación: si ESTA combinación (Material+Alt actual, la que se está a
        // punto de convertir en nodo) tiene más de una Versión de Fabricación real
        // candidata, se genera una rama completa del árbol por cada una — salvo que ya haya
        // una elección forzada fijada para ella (entonces se respeta esa sola).
        var vfabAqui = vfabIdx.byKey[key];
        var totalCandidatas = vfabAqui ? vfabAqui.length : 1;
        if(totalCandidatas > 1 && !eleccionesForzadas.hasOwnProperty(key)){
          for(var i=0; i<totalCandidatas; i++){
            if(arbolesCompletos.length >= MAX_ARBOLES_COMBINACIONES){ seRecorto = true; break; }
            var eleccionesConEsta = Object.assign({}, eleccionesForzadas);
            eleccionesConEsta[key] = i;
            explorarConEleccion(matActual, altActual, visitados, nodosAcumulados, eleccionesConEsta, digito1Objetivo);
          }
          return;
        }

        var nuevosVisitados = Object.assign({}, visitados);
        nuevosVisitados[key] = true;

        // "forzado" solo lleva un valor cuando el usuario (o el punto de partida elegido
        // explícitamente) fijó una VFab concreta para ESTA combinación — en cualquier otro
        // caso se pasa null, para que construirNodoIndividual decida por sí mismo usando
        // digito1Objetivo (preferir la VFab coherente con el resto de la cadena) en vez de
        // forzar siempre la primera de la lista.
        var forzado = eleccionesForzadas.hasOwnProperty(key) ? eleccionesForzadas[key] : null;
        var paso = construirNodoIndividual(matActual, altActual, nuevosVisitados, forzado, digito1Objetivo);
        var nodo = paso.nodo;
        var nuevaCadena = nodosAcumulados.concat([nodo]);

        // Una vez construido este nodo, si todavía no había un dígito 1 objetivo para la
        // cadena (es el primer nodo, o los anteriores no tenían VFab real), se fija ahora a
        // partir de la VFab real recién obtenida — así todos los nodos SIGUIENTES (más
        // antiguos, hacia Fabricación) heredan la preferencia por ese mismo dígito 1. Cada
        // rama de la exploración lleva su propia copia de este valor (parámetro, no
        // variable compartida), para no mezclar el dígito 1 de una combinación con otra.
        var digito1ParaSiguientes = digito1Objetivo;
        if(!digito1ParaSiguientes && nodo.versionEsReal && String(nodo.version||'').length>=1){
          digito1ParaSiguientes = String(nodo.version).charAt(0);
        }

        if(!paso.infoRetroceso){
          // Fin de esta rama (Fabricación, fin natural, o no se puede seguir).
          arbolesCompletos.push(nuevaCadena);
          return;
        }

        var resuelto = resolverEtapaPrevia(nodo, paso.infoRetroceso);
        if(!resuelto){
          arbolesCompletos.push(nuevaCadena);
          return;
        }

        explorar(resuelto.siguiente.material, resuelto.siguiente.alt, nuevosVisitados, nuevaCadena, digito1ParaSiguientes);
      }

      // Variante de explorar() que respeta un mapa de elecciones ya fijadas para esta rama
      // específica (usado dentro de la ramificación, para no reventar combinatoriamente).
      function explorarConEleccion(matActual, altActual, visitados, nodosAcumulados, eleccionesRama, digito1Objetivo){
        var eleccionesOriginal = eleccionesForzadas;
        eleccionesForzadas = eleccionesRama;
        explorar(matActual, altActual, visitados, nodosAcumulados, digito1Objetivo);
        eleccionesForzadas = eleccionesOriginal;
      }

      explorar(normMat(materialInicial), normAlt(altInicial), {}, [], null);

      // Cada árbol recibe sus PROPIAS copias de los nodos antes de completarArbol (que
      // mutará advertencias, version, componentes de cada uno): cuando la ramificación
      // ocurre en una etapa intermedia (ej. Envase con varias VFab), los nodos previos a esa
      // ramificación (ej. Acondicionado) son el MISMO objeto compartido entre ramas — sin
      // este clonado, una advertencia añadida en un árbol "se filtraba" a los demás árboles
      // que comparten ese nodo, aunque no les correspondiera.
      var arboles = arbolesCompletos.map(function(nodos){
        var copia = nodos.map(function(n){
          var c = Object.assign({}, n);
          c.advertencias = n.advertencias.slice();
          return c;
        });
        return completarArbol(copia);
      });

      // Se reordenan las combinaciones para que la(s) COHERENTE(S) — sin ninguna advertencia
      // de INCOHERENCIA/INCONSISTENCIA de Versión de Fabricación — aparezcan primero, ya que
      // esa es la combinación real y correcta según la lógica de versionamiento (mismo
      // dígito 1 en toda la cadena). Así se ve de entrada la combinación correcta por
      // defecto, sin tener que navegar manualmente entre "Combinación X de N" para
      // encontrarla — las demás (con datos incoherentes en SAP) siguen disponibles ahí por
      // si se necesita revisarlas. Dentro de cada grupo se preserva el orden de generación.
      function esCombinacionCoherente(nodos){
        return !nodos.some(function(n){
          return n.advertencias.some(function(w){ return w.indexOf('INCOHERENCIA')!==-1 || w.indexOf('INCONSISTENCIA')!==-1; });
        });
      }
      var coherentes = arboles.filter(esCombinacionCoherente);
      var incoherentes = arboles.filter(function(a){ return !esCombinacionCoherente(a); });
      var arbolesOrdenados = coherentes.concat(incoherentes);

      return { arboles: arbolesOrdenados, seRecorto: seRecorto };
    }

    /* Mantiene compatibilidad con el resto del módulo: construye solo el PRIMER árbol
       (combinación por defecto — primera VFab en cada punto de ambigüedad). */
    function construirArbol(materialInicial, altInicial){
      var resultado = construirTodosLosArboles(materialInicial, altInicial, {});
      return resultado.arboles[0] || [];
    }

    /* Lista de productos terminados (etapa Acondicionado) disponibles para buscar, agrupada
       por Material -> [descripción, alternativas], construida sobre datos.BOM_ROWS. Solo se
       reconstruye si cambia la referencia del array (mismo patrón de caché que el resto del
       módulo). */
    var __productosTerminadosCache = { rowsRef: null, lista: null };
    function getProductosTerminados(){
      var rows = datos.BOM_ROWS;
      if(__productosTerminadosCache.rowsRef === rows && __productosTerminadosCache.lista){
        return __productosTerminadosCache.lista;
      }
      var bomIdx = buildBomIndex();
      var porMaterial = {};
      Object.keys(bomIdx.byKey).forEach(function(k){
        var entry = bomIdx.byKey[k];
        if(!esEtapaAcondicionado(entry.etapa)) return;
        if(!porMaterial[entry.material]){
          porMaterial[entry.material] = { material: entry.material, descripcion: entry.descripcion, alts: [] };
        }
        porMaterial[entry.material].alts.push(entry);
      });
      var lista = Object.values(porMaterial);
      __productosTerminadosCache = { rowsRef: rows, lista: lista };
      return lista;
    }
    /* Fuerza el recálculo de getProductosTerminados en la próxima llamada, aunque
       datos.BOM_ROWS no haya cambiado de referencia (usado por window.__refreshArbolView
       cuando se recarga Componentes, que no toca BOM_ROWS pero sí puede afectar qué cuenta
       como "producto terminado" disponible). */
    function invalidarProductosTerminados(){
      __productosTerminadosCache = { rowsRef: null, lista: null };
    }

    return {
      normMat: normMat,
      normAlt: normAlt,
      keyOf: keyOf,
      esEtapaAcondicionado: esEtapaAcondicionado,
      esEtapaFabricacion: esEtapaFabricacion,
      buildBomIndex: buildBomIndex,
      buildVfabIndex: buildVfabIndex,
      buildCompFirstPosIndex: buildCompFirstPosIndex,
      buildAllCompsIndex: buildAllCompsIndex,
      estadoZDelMaterial: estadoZDelMaterial,
      getProductosTerminados: getProductosTerminados,
      invalidarProductosTerminados: invalidarProductosTerminados,
      encontrarProductosTerminados: encontrarProductosTerminados,
      construirTodosLosArboles: construirTodosLosArboles,
      construirArbol: construirArbol,
      isSuspendedCode: isSuspendedCode,
      isZ3Code: isZ3Code,
      MAX_ARBOLES_COMBINACIONES: MAX_ARBOLES_COMBINACIONES
    };
  };
});
