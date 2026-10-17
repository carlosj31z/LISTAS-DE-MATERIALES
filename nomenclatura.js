/* ============================================================
   NOMENCLATURA DE MATERIALES — reglas para armar los textos de un material nuevo

   Las reglas salen de cómo se vienen creando los materiales en el Maestro (revisadas sobre
   los últimos creados de cada tipo), para que un material nuevo siga la misma estructura:

     Texto Material (máx. 40)  FERROSIL 50mg/5mL SOL 100mL CJAx1
     Texto de datos básicos    FERROSIL 50mg/5mL SOL FCO100mL CJA x 1
     Texto de inspección       FERROSIL 50 mg/5 mL SOLUCION ORAL
     Texto de insp. VI         Caja con 1 Frasco x 100 mL

   - Granel / semielaborado (ZSEB): igual al producto sin la caja, y "BULK" en el VI.
   - Envase y empaque (ZMEE): tipo de componente + medida + producto + presentación + versión
     ("Hv.1" en el texto material, "H v.1" en datos básicos, sin versión en inspección).
   - Materia prima (ZMPR): nombre + calidad/proveedor; la inspección lleva solo el nombre
     genérico.

   crearNomenclatura() devuelve funciones puras (sin DOM): interpretar(texto) -> campos,
   generar(campos) -> { textoMaterial, datosBasicos, inspeccion, inspeccionVI, notas }.
   Al final, el bloque de UI arma la pestaña "Nomenclatura" si existe en la página.
   ============================================================ */
(function(root){
  'use strict';

  var LIMITE_TEXTO_MATERIAL = 40;

  /* Formas farmacéuticas: abreviatura usada en Texto Material / Datos básicos, nombre en el
     Texto de inspección y, para formas sólidas, cómo se nombra la unidad en el VI. */
  var FORMAS = [
    { id:'TAB',      abrev:'TAB',       insp:'TABLETA',                             unidad:['Tableta','Tabletas'] },
    { id:'TAB REC',  abrev:'TAB REC',   insp:'TABLETA RECUBIERTA',                  unidad:['Tableta recubierta','Tabletas recubiertas'] },
    { id:'TAB MAST', abrev:'TAB',       insp:'TABLETA MASTICABLE',                  unidad:['Tableta masticable','Tabletas masticables'] },
    { id:'TAB EFER', abrev:'TAB EFER',  insp:'TABLETA EFERVESCENTE',                unidad:['Tableta efervescente','Tabletas efervescentes'] },
    { id:'TAB LP',   abrev:'TAB',       insp:'TABLETA DE LIBERACION PROLONGADA',    unidad:['Tableta de liberación prolongada','Tabletas de liberación prolongada'] },
    { id:'CAP',      abrev:'CAP',       insp:'CAPSULA',                             unidad:['Cápsula','Cápsulas'] },
    { id:'CAP BLA',  abrev:'CAP BLA',   insp:'CAPSULA BLANDA',                      unidad:['Cápsula blanda','Cápsulas blandas'] },
    { id:'OVU',      abrev:'OVU',       insp:'OVULO',                               unidad:['óvulo','óvulos'] },
    { id:'SUP',      abrev:'SUP',       insp:'SUPOSITORIO',                         unidad:['Supositorio','Supositorios'] },
    { id:'SOL',      abrev:'SOL',       insp:'SOLUCION ORAL' },
    { id:'SOL GTA',  abrev:'SOL GTA',   insp:'SOLUCION PARA GOTAS ORALES' },
    { id:'SOF',      abrev:'SOF',       insp:'SOLUCION OFTALMICA' },
    { id:'SOL TOP',  abrev:'SOL',       insp:'SOLUCION TOPICA' },
    { id:'INY',      abrev:'INY',       insp:'SOLUCION INYECTABLE' },
    { id:'INY PERF', abrev:'INY',       insp:'SOLUCION PARA PERFUSION' },
    { id:'SUS',      abrev:'SUS',       insp:'SUSPENSION ORAL' },
    { id:'SUS INY',  abrev:'SUS INY',   insp:'SUSPENSION INYECTABLE' },
    { id:'EMU INY',  abrev:'INY',       insp:'EMULSION INYECTABLE' },
    { id:'PVO SUS',  abrev:'PVO SUS',   insp:'POLVO PARA SUSPENSION ORAL' },
    { id:'PVO INY',  abrev:'INY',       insp:'POLVO PARA SOLUCION INYECTABLE' },
    { id:'PVO EFER', abrev:'PVO EFER',  insp:'POLVO EFERVESCENTE PARA SOLUCION ORAL' },
    { id:'JBE',      abrev:'JBE',       insp:'JARABE' },
    { id:'ELX',      abrev:'ELX',       insp:'ELIXIR' },
    { id:'CRM',      abrev:'CRM',       insp:'CREMA' },
    { id:'GEL',      abrev:'GEL',       insp:'GEL' },
    { id:'LOC',      abrev:'LOC',       insp:'LOCION' },
    { id:'LIQ INH',  abrev:'LIQ P/INH', insp:'LIQUIDO PARA INHALACION' }
  ];
  // Palabras con que se reconoce cada forma en un pedido escrito libremente (la más
  // específica primero).
  var FORMAS_PALABRAS = [
    ['TAB REC', /TABLETAS? RECUBIERTAS?|TAB\.? REC/], ['TAB MAST', /TABLETAS? MASTICABLES?|TAB\.? MAST/],
    ['TAB EFER', /TABLETAS? EFERVESCENTES?/], ['TAB LP', /LIBERACION PROLONGADA/],
    ['TAB', /\bTABLETAS?\b|\bTAB\b|\bCOMPRIMIDOS?\b/], ['CAP BLA', /CAPSULAS? BLANDAS?|\bPERLAS?\b|CAP\.? BLA/],
    ['CAP', /\bCAPSULAS?\b|\bCAP\b/], ['OVU', /\bOVULOS?\b/], ['SUP', /\bSUPOSITORIOS?\b/],
    ['SOL GTA', /GOTAS ORALES|\bGTAS?\b/], ['SOF', /OFTALMIC|\bSOF\b/], ['PVO SUS', /POLVO PARA SUSPENSION|PVO SUS/],
    ['PVO INY', /POLVO PARA SOLUCION INYECTABLE|POLVO (PARA )?INYECTABLE/], ['PVO EFER', /EFERVESCENTE/],
    ['SUS INY', /SUSPENSION INYECTABLE/], ['EMU INY', /EMULSION INYECTABLE/], ['INY PERF', /PERFUSION/],
    ['INY', /INYECTABLE|\bINY\b/], ['SUS', /SUSPENSION|\bSUS\b/], ['SOL TOP', /SOLUCION TOPICA|CUTANEA/],
    ['JBE', /JARABE|\bJBE\b/], ['ELX', /ELIXIR/], ['CRM', /\bCREMA\b|\bCRM\b/], ['GEL', /\bGEL\b/],
    ['LOC', /LOCION|\bLOC\b/], ['LIQ INH', /INHALACION|\bINH\b/], ['SOL', /\bSOLUCION\b|\bSOL\b/]
  ];

  /* Envase primario (productos líquidos / semisólidos) y cómo se nombra en el VI. */
  var ENVASES = [
    { id:'FCO',  nombre:['Frasco','Frascos'] },
    { id:'FCOG', abrev:'FCO', nombre:['Frasco gotero','Frascos goteros'] },
    { id:'AMP',  nombre:['Ampolla','Ampollas'] },
    { id:'VIA',  nombre:['Vial','Viales'] },
    { id:'SOB',  nombre:['Sobre','Sobres'] },
    { id:'TUB',  nombre:['Tubo','Tubos'] },
    { id:'POT',  nombre:['Pote','Potes'] },
    { id:'LATA', nombre:['Lata','Latas'] }
  ];
  var ENVASES_PALABRAS = [
    ['FCOG', /FRASCOS? GOTEROS?/], ['FCO', /\bFRASCOS?\b|\bFCO(?=\d|\b)/], ['AMP', /\bAMPOLLAS?\b|\bAMP(?=\d|\b)/],
    ['VIA', /\bVIAL(ES)?\b|\bVIA(?=\d|\b)/], ['SOB', /\bSOBRES?\b|\bSOB(?=\d|\b)/], ['TUB', /\bTUBOS?\b|\bTUB(?=\d|\b)/],
    ['POT', /\bPOTES?\b|\bPOT(?=\d|\b)/], ['LATA', /\bLATAS?\b|\bLAT(?=\d)/]
  ];

  /* Componentes de envase y empaque (ZMEE): prefijo en Texto Material / Datos básicos y
     nombre completo en el Texto de inspección. */
  var COMPONENTES = [
    { id:'CJA',      abrev:'CJA',      insp:'CAJA',              palabras:/\bCAJAS?\b(?! (DE )?EMB)|\bCJA\b(?! EMB)|ESTUCHE/, arte:true },
    { id:'FOLLETO',  abrev:'FOLLETO',  insp:'FOLLETO',           palabras:/FOLLETO|INSERTO|PROSPECTO/, arte:true },
    { id:'ALU',      abrev:'ALU',      insp:'ALUMINIO',          palabras:/ALUMINIO|\bALU\b/, medida:true, arte:true },
    { id:'ETIQ ADH', abrev:'ETIQ ADH', insp:'ETIQUETA ADHESIVA', palabras:/ETIQUETAS?(?: ADHESIVAS?)?|\bETIQ(?: ADH)?\b/, arte:true },
    { id:'CJA EMB',  abrev:'CJA EMB',  insp:'CAJA EMBALAJE',     palabras:/CAJA (DE )?EMBALAJE|CJA EMB/, medida:true },
    { id:'FCO',      abrev:'FCO',      insp:'FRASCO',            palabras:/\bFRASCO\b|\bFCO\b/, medida:true },
    { id:'TAPA',     abrev:'TAPA',     insp:'TAPA',              palabras:/\bTAPA\b/, medida:true },
    { id:'PVC',      abrev:'PVC',      abrevDB:'CINTA PVC', insp:'CINTA PVC', palabras:/\bPVC\b/, medida:true, medidaAlFinal:true }
  ];

  /* Abreviaturas de nombres que ya se usan en el Texto Material cuando no entra en 40
     caracteres (vistas en el Maestro: CLOR SOD, GLUCONATO Ca, SULFATO FERR…). */
  var ABREVIATURAS = [
    [/\bDE CALCIO\b/g, 'Ca'], [/\bCLORURO\b/g, 'CLOR'], [/\bSODIO\b/g, 'SOD'], [/\bSODICO\b/g, 'SOD'],
    [/\bPOTASIO\b/g, 'POT'], [/\bFERROSO\b/g, 'FERR'], [/\bCIPROFLOXACINO\b/g, 'CIPROFLOXAC'],
    [/\bBENZOATO\b/g, 'BENZ'], [/\bBENCILO\b/g, 'BENCI'], [/\bCLORHIDRATO\b/g, 'CLORH'],
    [/\bACETATO\b/g, 'ACET'], [/\bSULFATO\b/g, 'SULF'], [/\bFOSFATO\b/g, 'FOSF'], [/\bVITAMINA\b/g, 'VIT'],
    [/\bFORTE\b/g, 'FTE'], [/\bPEDIATRICO\b/g, 'PED'], [/\bMICRONIZADA?O?\b/g, 'MICRON']
  ];

  function limpiar(s){ return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim(); }
  function sinTildes(s){ return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function mayus(s){ return sinTildes(limpiar(s)).toUpperCase(); }
  function porId(lista, id){ for(var i = 0; i < lista.length; i++) if(lista[i].id === id) return lista[i]; return null; }

  /* ---------- Concentración ----------
     Entrada libre ("50 mg / 5 ml", "10mg+4mg", "20 %") -> forma compacta "50mg/5mL". */
  function normUnidad(u){
    var x = String(u || '').toLowerCase();
    if(x === 'ml') return 'mL';
    if(x === 'l') return 'L';
    if(x === 'ui') return 'UI';
    if(x === 'mcg' || x === 'µg' || x === 'ug') return 'mcg';
    return x;
  }
  function concCompacta(c){
    var s = limpiar(c).replace(/,/g, '.');
    s = s.replace(/(\d)\s+(mg|g|mcg|µg|ug|ui|UI|mL|ml|L|%|‰)\b/gi, '$1$2');
    s = s.replace(/(\d)(mg|g|mcg|µg|ug|ui|mL|ml|L)\b/gi, function(m, n, u){ return n + normUnidad(u); });
    s = s.replace(/\s*\/\s*/g, '/').replace(/\s*\+\s*/g, '+');
    return s;
  }
  // "50mg/5mL" -> "50 mg/5 mL"; "4mg+10mg" -> "4 mg + 10 mg" (como en el Texto de inspección).
  function concEspaciada(c){
    return concCompacta(c).replace(/(\d)(mg|g|mcg|UI|mL|L)\b/g, '$1 $2').replace(/\+/g, ' + ');
  }
  // Para el Texto Material: sin unidades en combinaciones ("10mg+4mg" -> "10+4") y, en sólidos,
  // sin "mg" en la dosis simple ("600mg" -> "600"), como GEMFIBROZILO 600 TAB.
  function concTextoMaterial(c, esSolido){
    var s = concCompacta(c);
    if(s.indexOf('+') !== -1) return s.split('+').map(function(p){ return p.replace(/^([\d.]+)\s*(mg|g|mcg|UI)\b.*$/i, '$1'); }).join('+');
    if(esSolido) return s.replace(/^([\d.]+)mg$/, '$1');
    return s;
  }
  function contenidoCompacto(c){ return concCompacta(c); }
  function contenidoEspaciado(c){ return concCompacta(c).replace(/(\d)(mL|L|g|mg)\b/, '$1 $2'); }

  /* ---------- Interpretar un pedido escrito libremente ---------- */
  var RE_CONC = /(\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|UI|%|‰)(?:\s*\/\s*\d*(?:[.,]\d+)?\s*(?:mL|ml|g))?(?:\s*\+\s*\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|UI|%)?(?:\s*\/\s*\d*(?:[.,]\d+)?\s*(?:mL|ml))?)*)/i;

  function interpretar(texto){
    var original = limpiar(texto);
    var u = mayus(original);
    var campos = { tipo:'ZTER', nombre:'', concentracion:'', forma:'', envase:'', material:'', contenido:'', blister:'',
                   cantidad:'', mm:false, sufijo:'', componente:'', medida:'', presentacion:'', version:'', humanova:false,
                   calidad:'', generico:'', extra:'' };
    if(!u) return campos;

    if(/\bGRANEL\b|\bBULK\b|SEMIELABORADO|PRODUCTO EN PROCESO/.test(u)) campos.tipo = 'ZSEB';
    else if(/MATERIA PRIMA|EXCIPIENTE|PRINCIPIO ACTIVO|\bAPI\b/.test(u)) campos.tipo = 'ZMPR';
    else {
      for(var k = 0; k < COMPONENTES.length; k++){
        if(COMPONENTES[k].palabras.test(u) && u.search(COMPONENTES[k].palabras) <= 8){ campos.tipo = 'ZMEE'; campos.componente = COMPONENTES[k].id; break; }
      }
    }

    campos.mm = /\bMM\b|MUESTRA MEDICA/.test(u);
    var mv = /\bH\s?V\.?\s?(\d+)\b|\bV\.\s?(\d+)\b|VERSION\s*(\d+)/.exec(u);
    if(mv){ campos.version = mv[1] || mv[2] || mv[3]; campos.humanova = !!mv[1] || /HUMANOVA/.test(u); }
    else if(/HUMANOVA/.test(u)) campos.humanova = true;

    var mc = RE_CONC.exec(original);
    if(mc) campos.concentracion = concCompacta(mc[1]);
    var resto = mc ? original.replace(mc[1], ' ') : original;
    var ur = mayus(resto);

    for(var f = 0; f < FORMAS_PALABRAS.length; f++){ if(FORMAS_PALABRAS[f][1].test(ur)){ campos.forma = FORMAS_PALABRAS[f][0]; break; } }
    for(var e = 0; e < ENVASES_PALABRAS.length; e++){ if(ENVASES_PALABRAS[e][1].test(ur)){ campos.envase = ENVASES_PALABRAS[e][0]; break; } }
    if(/\bPEBD\b|POLIETILENO/.test(ur)) campos.material = 'PEBD';
    else if(/\bVIDRIO\b/.test(ur)) campos.material = 'vidrio';

    var mcont = /(\d+(?:[.,]\d+)?)\s*(ML|L|G)\b/.exec(ur);
    if(mcont) campos.contenido = contenidoCompacto(mcont[1] + mcont[2]);
    var mcant = /(?:CAJA|CJA|CJ|PACK|ESTUCHE)\s*(?:X|POR|CON|DE)?\s*(\d+)/.exec(ur) || /\bX\s*(\d+)\s*(?:UND|UNIDADES|TAB|CAP|AMP|FCO|SOB|$)/.exec(ur);
    if(mcant){
      campos.cantidad = mcant[1];
      // Lo que va después de "CJA x N" es el mercado / cliente (EC, CDI, EEMM, LATAM BO…).
      var cola = ur.slice(mcant.index + mcant[0].length).replace(/\bMM\b/g, ' ').replace(/^[\s\-]+/, '');
      if(campos.tipo === 'ZTER' && /^[A-Z0-9 ()\-]{1,24}$/.test(limpiar(cola))) campos.sufijo = limpiar(cola);
    }
    var mbl = /\b(?:BLISTER|BLIS|B)\s?(\d{1,3})\b|\b([FT])\s?(\d{1,3})\b/.exec(ur);
    if(mbl) campos.blister = mbl[1] ? 'B' + mbl[1] : mbl[2] + mbl[3];
    var compDet = porId(COMPONENTES, campos.componente);
    if(campos.tipo === 'ZMEE' && compDet && compDet.medida){
      var mmed2 = /(\d+(?:[.,]\d+)?\s*(?:UM|MM)(?:\s*X\s*\d+(?:[.,]\d+)?\s*MM)?)/.exec(ur);
      if(mmed2){
        campos.medida = mmed2[1].replace(',', '.').replace(/\s*X\s*/, ' x ').replace(/\s*UM/g, 'um').replace(/\s*MM/g, 'mm');
        // El "MM" de una medida (234 MM) no es muestra médica.
        if(!/MUESTRA MEDICA/.test(u) && !/\bMM\b/.test(ur.replace(mmed2[1], ' '))) campos.mm = false;
      }
    }
    if(campos.tipo === 'ZMEE'){
      var mp = /((?:B|F|T)\d{1,3}\s*X\s*\d+|CJA\s*X\s*\d+|X\s*\d+(?!\s*(?:UM|MM)\s*X))/.exec(ur.replace(/\d+(?:[.,]\d+)?\s*(?:UM|MM)\s*X\s*\d+(?:[.,]\d+)?\s*MM\b/, ' '));
      if(mp) campos.presentacion = mp[1].replace(/\s*X\s*/, ' x ');
    }

    // Nombre: lo que va antes de la concentración / forma / envase, sin palabras de relleno.
    var corte = ur.length;
    [RE_CONC, /\d+(?:[.,]\d+)?\s*(?:ML|L|G)\b/, /\bX\s*\d/, /\bCJA\b/, /\bLIQ\b/].concat(FORMAS_PALABRAS.map(function(x){ return x[1]; })).concat(ENVASES_PALABRAS.map(function(x){ return x[1]; })).forEach(function(re){
      var i = mayus(original).search(re);
      if(i > 0 && i < corte) corte = i;
    });
    var nombre = mayus(original).slice(0, corte);
    COMPONENTES.forEach(function(c){ nombre = nombre.replace(new RegExp(c.palabras.source, 'g'), ' '); });
    nombre = nombre.replace(/\bESTUCHE\b/g, ' ');
    nombre = nombre.replace(/\bCINTA\b/g, ' ').replace(/\d+(?:[.,]\d+)?\s*(?:UM|MM)\b(\s*X\s*\d+(?:[.,]\d+)?\s*MM\b)?/g, ' ');
    nombre = nombre.replace(/\b(CREAR|CREACION|NUEVO|NUEVA|MATERIAL|PRODUCTO|TERMINADO|GRANEL|BULK|SEMIELABORADO|MATERIA PRIMA|EXCIPIENTE|PRINCIPIO ACTIVO|PARA|DEL|DE LA|EL|LA|UN|UNA|SE|SOLICITA|SOLICITAN|CODIGO|HUMANOVA|MUESTRA MEDICA|PEBD|\d+(?:[.,]\d+)?\s*MM)\b/g, ' ');
    campos.nombre = limpiar(nombre.replace(/[:;,]/g, ' '));
    // Códigos entre paréntesis (DM14959E, (HE)…) se conservan como detalle adicional.
    var parentesis = original.match(/\([^)]{2,20}\)/g);
    if(parentesis){ campos.extra = parentesis.join(' ').toUpperCase(); parentesis.forEach(function(p){ campos.nombre = limpiar(campos.nombre.replace(mayus(p), ' ')); }); }
    campos.generico = campos.nombre;
    if(campos.tipo === 'ZMPR'){
      // Calidad / grado / presentación del insumo: va en los textos, no en la inspección.
      var RE_CAL = /\b(MICRONIZAD[AO]|COMPRESION DIRECTA|GRANULAR|GRANULAD[AO]|ESTERIL|APIROGENO|MICRON(?:IZADO)?)\b|\s-\s?N\b|-N\b/g;
      var cal = (campos.nombre.match(RE_CAL) || []).map(limpiar);
      if(cal.length){
        campos.calidad = cal.join(' ');
        campos.nombre = limpiar(campos.nombre.replace(RE_CAL, ' '));
        campos.generico = campos.nombre;
      }
    }
    return campos;
  }

  /* ---------- Ajuste del Texto Material a 40 caracteres ----------
     Pasos en el orden en que se ven aplicados en el Maestro; se detiene en cuanto entra. */
  function ajustarA40(partes, notas){
    function unir(){ return limpiar(partes.filter(Boolean).join(' ')); }
    var t = unir();
    if(t.length <= LIMITE_TEXTO_MATERIAL) return t;
    var pasos = [
      ['sin espacio en la presentación ("CJAx30MM")', function(){ partes = partes.map(function(p){ return String(p || '').replace(/^CJA x (\d+)$/, 'CJAx$1').replace(/^(CJAx\d+) MM$/, '$1MM'); }); }],
      ['nombre abreviado', function(){ partes[0] = ABREVIATURAS.reduce(function(s, a){ return s.replace(a[0], a[1]); }, partes[0] || '').replace(/\s+DE\s+/g, ' '); }],
      ['dosis sin unidades', function(){ partes[1] = String(partes[1] || '').replace(/^([\d.]+)[a-zA-Z%‰]*(\/.*)?$/, '$1'); }],
      ['"CJ" en vez de "CJA"', function(){ partes = partes.map(function(p){ return String(p || '').replace(/^CJAx/, 'CJx'); }); }],
      ['sin la forma farmacéutica', function(){ partes[2] = ''; }]
    ];
    for(var i = 0; i < pasos.length && t.length > LIMITE_TEXTO_MATERIAL; i++){
      var antes = t;
      pasos[i][1]();
      t = unir();
      if(t !== antes) notas.push('Para entrar en 40 caracteres: ' + pasos[i][0] + '.');
    }
    if(t.length > LIMITE_TEXTO_MATERIAL){
      var exceso = t.length - LIMITE_TEXTO_MATERIAL;
      partes[0] = String(partes[0] || '').slice(0, Math.max(3, String(partes[0] || '').length - exceso)).trim();
      t = unir();
      notas.push('El nombre se recortó para entrar en 40 caracteres: revísalo.');
    }
    return t;
  }

  function versionTexto(c, compacto){
    if(!c.version) return '';
    return (c.humanova ? (compacto ? 'Hv.' : 'H v.') : 'v.') + c.version;
  }

  /* ---------- Generar los cuatro textos ---------- */
  function generar(c){
    c = c || {};
    var notas = [];
    var nombre = mayus(c.nombre);
    var forma = porId(FORMAS, c.forma);
    var esSolido = !!(forma && forma.unidad);
    var conc = c.concentracion ? concCompacta(c.concentracion) : '';
    var mm = c.mm ? 'MM' : '';
    var extra = mayus(c.extra);
    var sufijoTB = mayus(c.sufijo);
    // En el Texto Material el mercado va abreviado (EEMM -> EM, LATAM -> LTM).
    var sufijoTM = sufijoTB.replace(/\bEEMM\b/g, 'EM').replace(/\bLATAM\b/g, 'LTM');
    var envase = porId(ENVASES, c.envase);
    var envAbrev = envase ? (envase.abrev || envase.id) : '';
    var contenido = c.contenido ? contenidoCompacto(c.contenido) : '';
    var material = c.material === 'PEBD' ? 'PEBD' : '';
    var blister = mayus(c.blister).replace(/\s+/g, '');
    var cantidad = String(c.cantidad || '').trim();
    var r = { textoMaterial:'', datosBasicos:'', inspeccion:'', inspeccionVI:'', notas:notas };

    if(!nombre){ notas.push('Falta el nombre del producto o material.'); }

    if(c.tipo === 'ZMPR'){
      var calidad = mayus(c.calidad);
      r.datosBasicos = limpiar([nombre, calidad].join(' '));
      r.textoMaterial = ajustarA40([nombre, calidad], notas);
      r.inspeccion = mayus(c.generico) || nombre;
      return r;
    }

    if(c.tipo === 'ZMEE'){
      var comp = porId(COMPONENTES, c.componente) || COMPONENTES[0];
      var medida = limpiar(String(c.medida || '').replace(/(\d)\s*(mm|um)\b/gi, function(m0, d, u){ return d + u.toLowerCase(); }));
      var presentacion = limpiar(String(c.presentacion || '').replace(/\s*[xX]\s*/g, ' x '));
      // En envase y empaque la forma va con su calificativo (TAB REC, TAB MAST, CAP BLA).
      var ffEnvase = forma ? (/^(PVO INY|EMU INY|INY PERF|SOL TOP)$/.test(forma.id) ? forma.abrev : forma.id) : '';
      var vTB = versionTexto(c, false), vTM = versionTexto(c, true);
      // Datos básicos e inspección: igual estructura; la inspección con el tipo de componente
      // completo (CAJA, ALUMINIO…) y sin versión de arte.
      // En la cinta de PVC la medida va al final (CINTA PVC CRISTAL 300um x 234mm).
      var medAntes = comp.medidaAlFinal ? '' : medida, medDespues = comp.medidaAlFinal ? medida : '';
      r.datosBasicos = limpiar([comp.abrevDB || comp.abrev, medAntes, nombre, conc, ffEnvase, presentacion, medDespues, mm, extra, vTB].join(' '));
      r.inspeccion = limpiar([comp.insp, medAntes, nombre, conc, ffEnvase, presentacion, medDespues, mm].join(' '));
      // Texto material: dosis sin unidades, forma sin calificativo (TAB, CAP) y "x4MM" pegado.
      var presTM = presentacion.replace(/^CJA x /, 'CJAx').replace(/ x /g, ' x').replace(/^x /, 'x') + (mm && presentacion ? 'MM' : '');
      r.textoMaterial = ajustarA40([limpiar(comp.abrev + ' ' + medAntes + ' ' + nombre), concTextoMaterial(conc, true), ffEnvase.split(' ')[0], presTM, medDespues, (mm && !presentacion ? 'MM' : ''), extra, vTM], notas);
      if(!c.version && comp.arte) notas.push('Sin versión de arte: los envases y empaques nuevos llevan "v.N" (o "Hv.N" si es Humanova).');
      return r;
    }

    // Producto terminado (ZTER) y granel / semielaborado (ZSEB)
    var envaseTB = esSolido ? blister : (envAbrev ? envAbrev + contenido : contenido);
    var cajaTB = (c.tipo === 'ZTER' && cantidad) ? 'CJA x ' + cantidad : '';
    r.datosBasicos = limpiar([nombre, conc, forma ? forma.abrev : '', material, envaseTB, cajaTB, mm, extra, sufijoTB].join(' '));
    var envaseTM = esSolido ? blister : contenido;
    var cajaTM = (c.tipo === 'ZTER' && cantidad) ? 'CJAx' + cantidad + (mm ? 'MM' : '') : '';
    r.textoMaterial = ajustarA40([nombre, concTextoMaterial(conc, esSolido), forma ? forma.abrev : '', material, envaseTM, cajaTM || mm, extra, sufijoTM], notas);
    // En la inspección el nombre va completo ("CLORURO DE SODIO", "DICLOFENACO SODICO").
    r.inspeccion = limpiar([mayus(c.generico) || nombre, conc ? concEspaciada(conc) : '', forma ? forma.insp : ''].join(' '));
    if(c.tipo === 'ZSEB'){
      r.inspeccionVI = 'BULK';
    } else if(cantidad){
      var n = parseInt(cantidad, 10), plural = n !== 1;
      var cosa;
      if(esSolido) cosa = forma.unidad[plural ? 1 : 0];
      else if(envase){
        cosa = envase.nombre[plural ? 1 : 0] + (c.material ? ' de ' + c.material : '') + (contenido ? ' x ' + contenidoEspaciado(contenido) : '');
      } else cosa = (plural ? 'Unidades' : 'Unidad');
      r.inspeccionVI = (mm ? 'MM: ' : '') + 'Caja con ' + cantidad + ' ' + cosa;
    }
    if(!forma) notas.push('Elige la forma farmacéutica: define la abreviatura (SOL, TAB…) y el Texto de inspección.');
    if(c.tipo === 'ZTER' && !cantidad) notas.push('Falta la cantidad por caja (CJA x N).');
    if(!esSolido && c.tipo === 'ZTER' && !envase && forma && forma.id !== 'PVO INY') notas.push('Falta el envase primario (frasco, ampolla, vial…).');
    return r;
  }

  /* ---------- Materiales parecidos ya creados (para tomar como modelo) ---------- */
  function fechaMs(s){
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(s || ''));
    if(!m) return 0;
    var y = +m[3]; if(y < 100) y += 2000;
    return new Date(y, +m[2] - 1, +m[1]).getTime(); // ya normalizada a dd/mm/aaaa por la app
  }
  function parecidos(filas, campos, limite){
    var palabras = mayus(campos.nombre).split(' ').filter(function(w){ return w.length >= 3; });
    if(!palabras.length || !filas || !filas.length) return [];
    var tipo = campos.tipo;
    var out = [];
    for(var i = 0; i < filas.length; i++){
      var r = filas[i];
      var tm = mayus(r['Texto Material']), tb = mayus(r['Texto de datos básicos']);
      var hay = tm + ' ' + tb, puntos = 0;
      for(var j = 0; j < palabras.length; j++) if(hay.indexOf(palabras[j]) !== -1) puntos += 2;
      if(!puntos) continue;
      if(String(r['Tipo material'] || '').trim() === tipo) puntos += 3;
      if(campos.forma){ var f = porId(FORMAS, campos.forma); if(f && hay.indexOf(' ' + f.abrev + ' ') !== -1) puntos += 1; }
      out.push({ fila:r, puntos:puntos, fecha:fechaMs(r['Fecha creación material']) });
    }
    out.sort(function(a, b){ return b.puntos - a.puntos || b.fecha - a.fecha; });
    return out.slice(0, limite || 8);
  }
  function duplicados(filas, textos){
    var tm = mayus(textos.textoMaterial), tb = mayus(textos.datosBasicos);
    if(!tm || !filas) return [];
    return filas.filter(function(r){ return mayus(r['Texto Material']) === tm || (tb && mayus(r['Texto de datos básicos']) === tb); }).slice(0, 5);
  }

  root.NomenclaturaMateriales = {
    FORMAS: FORMAS, ENVASES: ENVASES, COMPONENTES: COMPONENTES, LIMITE_TEXTO_MATERIAL: LIMITE_TEXTO_MATERIAL,
    interpretar: interpretar, generar: generar, parecidos: parecidos, duplicados: duplicados,
    concCompacta: concCompacta, concEspaciada: concEspaciada
  };
  if(typeof module !== 'undefined' && module.exports) module.exports = root.NomenclaturaMateriales;
})(typeof self !== 'undefined' ? self : this);
