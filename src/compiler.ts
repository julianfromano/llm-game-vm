// Compilador "deseos -> IR": toma el prompt en lenguaje natural del jugador y
// devuelve un PARCHE del GameSpec que la VM fusiona y corre. El LLM es el
// compilador (corre UNA vez, al inicio); la VM determinista es el runtime.
// Proveedor: Google Gemini (generativelanguage API, auth con API key).
import type { GameSpec, Rule, EntityTemplate, ExprOrValue } from './types';

// ---- Parche: todo opcional, se fusiona sobre el spec base ----
export interface GamePatch {
  // overrides de props globales (gravity, scroll, score, background, ...)
  world?: Record<string, ExprOrValue>;
  // entidades iniciales nuevas (se agregan a las del base)
  addEntities?: EntityTemplate[];
  // editar entidades existentes por tag (mergea props): recolorear/redimensionar
  // el pájaro, ponerle emoji, etc. Ej: { matchTag: 'bird', props: { emoji: '⚽' } }
  patchEntities?: { matchTag: string; props: Record<string, ExprOrValue> }[];
  // reglas nuevas (se agregan al final, corren después de las base)
  addRules?: Rule[];
  // reemplazar reglas base por índice (0..n-1 del spec base)
  replaceRules?: { index: number; rule: Rule }[];
  // quitar reglas base por índice
  removeRules?: number[];
}

// Fusiona un parche sobre una copia profunda del spec base.
export function mergeSpec(base: GameSpec, patch: GamePatch): GameSpec {
  const spec: GameSpec = structuredClone(base);
  if (patch.world) Object.assign(spec.world, patch.world);
  if (patch.removeRules?.length) {
    const drop = new Set(patch.removeRules);
    spec.rules = spec.rules.filter((_, i) => !drop.has(i));
  }
  if (patch.replaceRules) {
    for (const { index, rule } of patch.replaceRules) {
      if (index >= 0 && index < spec.rules.length) spec.rules[index] = rule;
    }
  }
  if (patch.patchEntities?.length) {
    for (const { matchTag, props } of patch.patchEntities) {
      for (const tpl of spec.entities) {
        if (tpl.tags.includes(matchTag)) Object.assign(tpl.props, props);
      }
    }
  }
  if (patch.addEntities?.length) spec.entities.push(...patch.addEntities);
  if (patch.addRules?.length) spec.rules.push(...patch.addRules);
  return spec;
}

// ---- Vocabulario del IR (prefijo estable -> se cachea en el prompt) ----
const IR_VOCABULARY = `Sos el COMPILADOR de un motor de juegos determinista. El jugador escribe deseos en lenguaje natural y vos devolvés un PARCHE JSON del juego. NO escribís código: emitís datos (IR) que una VM segura ejecuta a 60fps.

## Entidades del programa
- El protagonista tiene tag "bird" (props: pos, vel, size, color, shape:'circle'). Para cambiar su apariencia (color, emoji, tamaño) editá DIRECTAMENTE su objeto dentro del array "entities" del GameSpec que devolvés.
- El piso tiene tag "ground". Los tubos se generan con tags "pipe"/"obstacle".

## Modelo
- El mundo (world) tiene props globales arbitrarias: gravity, scroll, score, background, y cualquiera que inventes.
- Las entidades tienen tags (string[]) y props arbitrarias. Props con significado físico:
  - pos {x,y}, vel {x,y}, acc {x,y}: cualquier entidad con pos+vel se mueve (pos += vel*dt; vel += acc*dt). acc se resetea cada frame.
  - size {x,y}: caja AABB para colisiones y dibujo.
  - color (hex string), shape ('rect'|'circle').
  - emoji (string): si una entidad tiene prop "emoji", se dibuja ESE emoji en vez de la forma/color. Ideal para personajes/objetos: pelota -> "⚽", cohete -> "🚀", etc. El tamaño usa size.
  - Inventá props nuevas libremente (hp, fuel, scored, etc.): son ciudadanas de primera clase.
- La gravedad NO es un opcode: es una regla que suma fuerza vertical a las entidades con cierto tag.

## Expresiones (Expr) — JSON
- Literal: {"k":"lit","v": 42 | true | "txt"}
- Vector: {"k":"vec","x":Expr,"y":Expr}
- Referencia: {"k":"ref","path":"self.pos.y"} (paths: self.*, other.*, world.*, dt)
- Negación: {"k":"neg","a":Expr}
- Binaria: {"k":"bin","op":"+|-|*|/|<|>|<=|>=|==|!=|&&|||","a":Expr,"b":Expr}
- Llamada: {"k":"call","fn":"random|distance|count|toward|abs|min|max|nearest","args":[Expr...]}

## Reglas (Rule) — los 4 ejes ortogonales
- when (Trigger): {"t":"every_frame"} | {"t":"every","seconds":N} | {"t":"on_input","key":"space","phase":"down|up|held"} | {"t":"on_collision","a":"tagA","b":"tagB"} | {"t":"on_spawn","tag":T} | {"t":"on_destroy","tag":T} | {"t":"on_cross","expr":Expr} | {"t":"on_draw"}
- if (opcional, Expr booleano): condición evaluada POR target.
- for (opcional, Target): {"s":"all"} | {"s":"with_tag","tag":T} | {"s":"id","id":I} | {"s":"self"} | {"s":"the_collider"} | {"s":"nearest_to","tag":T,"ref":Target}
- do (Effect[]): {"e":"set","path":P,"value":Expr} | {"e":"add","path":P,"value":Expr} | {"e":"spawn","template":EntityTemplate} | {"e":"destroy","target"?:Target} | {"e":"add_force","value":Expr(vec)} | {"e":"emit","event":S} | {"e":"end_game","result":"win|lose"} | {"e":"js","code":"<JS>"}
- path en set/add: "self.vel.y", "world.score", "other.pos.x", etc.
- on_input "key": nombre de tecla = e.key del navegador en minúscula. Ej: "space" (barra), "control", "shift", "alt", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright", "a".."z", "0".."9". El click/touch en pantalla equivale a "space".
- destroy: sin "target" destruye a self; con "target" destruye a esas entidades. En una regla on_collision, self = entidad del tag "a", y {"s":"the_collider"} = entidad del tag "b". Para que una bala (tag a) rompa un tubo (tag b) Y se elimine la bala: do=[{"e":"destroy"},{"e":"destroy","target":{"s":"the_collider"}}].

## REGLA DE ORO: el set de primitivas es CERRADO
Los triggers, targets y effects listados arriba son TODOS los que existen. NO inventes campos, efectos, targets ni triggers nuevos (ej: no agregues "for" dentro de un effect, no inventes {"e":"shoot"} ni {"e":"damage"}). Si la VM recibe algo que no está en esta lista, lo IGNORA en silencio y la mecánica no funciona.
Por eso: si una mecánica NO se expresa LIMPIAMENTE con las primitivas exactas de arriba, NO improvises con primitivas dudosas — implementá la regla COMPLETA con un único efecto {"e":"js","code":"..."}. El efecto js es Turing-completo y nunca falla por falta de vocabulario. Ante la duda, usá js.

## Escape hatch: efecto "js" (PODER TOTAL)
Cuando un deseo NO se pueda expresar con los efectos de arriba, usá {"e":"js","code":"..."}. El código es JavaScript que corre cada vez que dispara la regla, con esta API en scope (no uses import/require/DOM):
- self, other: props mutables de la entidad (ej: self.vel.y = -440; self.pos.x += 1). null si no aplica.
- selfEntity / otherEntity: las entidades COMPLETAS (con .tags Set, .id, .props). Usalas para destroy(otherEntity) o leer tags. (self/other son solo las props; selfEntity/otherEntity son las entidades.)
- world: props globales mutables (ej: world.score += 1; world.gravity = 0).
- entities: array de todas las entidades vivas (cada una {id, tags:Set, props}).
- dt (segundos del frame), rng() -> [0,1) determinista (USALO en vez de Math.random), Math.
- spawn(template), destroy(entity?), emit(evento), win(), lose(), find(tag)->Entity[], nearest(tag, {x,y})->Entity.
- Los vectores son {x,y}. Las props inventadas persisten entre frames.
Ejemplo (todas las entidades 'bird' rebotan en los bordes): {"when":{"t":"every_frame"},"for":{"s":"with_tag","tag":"bird"},"do":[{"e":"js","code":"if(self.pos.y<0||self.pos.y>560){self.vel.y*=-1;}"}]}
Preferí los efectos primitivos cuando alcanzan; usá "js" para mecánicas que ninguno cubre. Sé audaz: con "js" podés implementar CUALQUIER regla.

## Dibujo libre: trigger "on_draw" (renderizado generativo)
Para CUALQUIER cosa visual que el render base no haga (imágenes de fondo, gradientes, partículas, rastros, formas raras), creá una regla {"when":{"t":"on_draw"},"do":[{"e":"js","code":"..."}]}. Corre en cada frame al renderizar, DETRÁS de las entidades, con esta API:
- ctx: el CanvasRenderingContext2D del juego — dibujá lo que quieras (ctx.fillRect, ctx.arc, ctx.createLinearGradient, ctx.drawImage, etc.).
- w, h: ancho/alto del canvas (480x560).
- world, entities: para leer estado (posición del jugador, score...).
- image(url): carga y cachea una imagen desde una URL https pública; devuelve algo dibujable con ctx.drawImage. Si la imagen aún no cargó, no dibuja nada ese frame (no rompe).
- Math, rng(), find(tag), nearest(tag,{x,y}).
Ejemplo (fondo de imagen): {"when":{"t":"on_draw"},"do":[{"e":"js","code":"ctx.drawImage(image('https://ejemplo.com/foto.jpg'),0,0,w,h);"}]}
Ejemplo (rastro de partículas detrás del jugador): {"when":{"t":"on_draw"},"do":[{"e":"js","code":"const p=find('dog')[0]; if(p){ctx.fillStyle='gold';ctx.beginPath();ctx.arc(p.props.pos.x-10,p.props.pos.y,4+rng()*4,0,7);ctx.fill();}"}]}
IMPORTANTE para imágenes: image() necesita una URL pública real y válida; si no conocés una URL fiable, mejor representá la idea con dibujo (gradientes, formas, emoji) en vez de inventar URLs que no existen.

## Reglas BASE del juego (qué hace cada una, para que entiendas el programa que vas a reescribir)
0: publicar world.birdx = pos.x del bird
1: gravedad (suma world.gravity*dt a vel.y de tag 'gravity')
2: aletear (on_input space down -> bird.vel.y = -440)
3: spawn de tubos cada 1.5s
4: limpiar tubos fuera de pantalla
5: sumar score al pasar el tubo
6: perder al chocar obstacle o ground
7: perder si bird.pos.y < 0

## Tu tarea
Te paso el PROGRAMA ACTUAL completo (un GameSpec JSON: {world, entities, rules}). Es el código del juego. Modificalo según el deseo del jugador y devolvé el GameSpec COMPLETO modificado.
- Trabajás sobre el programa entero: podés reescribir cualquier prop de world, cualquier entidad (su tags y props), y cualquier regla (agregar, borrar, reescribir).
- Mantené intacto lo que el deseo no pide cambiar (no rompas el juego base salvo que el deseo lo requiera).
- Cuando una mecánica no se exprese con los efectos primitivos, usá el efecto {"e":"js","code":"..."} con poder total.

## Transformación total: campo "boot" (PODER ABSOLUTO sobre el DOM)
El GameSpec admite un campo opcional "boot": un string de JS que corre UNA vez al iniciar, con acceso TOTAL al DOM (document, window) y a esta API en scope: root (un <div> contenedor donde construir UI), canvas, ctx, vm, spec, stopGameLoop(), startGameLoop(), storage (localStorage para persistir), W, H.
Usalo cuando el deseo pida algo que NO es el juego de pajaritos: transformar la experiencia en CUALQUIER aplicación (un sistema de gestión con tablas y formularios, una calculadora, un editor, un CRUD con persistencia en storage, etc.).
Para reemplazar el juego por otra app: llamá stopGameLoop(), ocultá el canvas (canvas.style.display='none'), y construí tu UI dentro de root con document.createElement / innerHTML, agregando event listeners y guardando datos en storage. Tenés libertad total: es entorno local, sin restricciones de seguridad.
Si el deseo es solo modificar el juego, NO uses boot (dejalo afuera) y trabajá con world/entities/rules.

## Formato de salida
IMPORTANTE: el resultado debe ser JSON 100% válido. En los strings de "code" (js/boot) NO uses saltos de línea reales ni comentarios //; escribí el JS en UNA sola línea, separando sentencias con ";", y escapá bien las comillas. Nada de texto fuera del JSON.
Devolvé SOLO el GameSpec JSON completo, sin markdown ni explicaciones:
{ "world": {...}, "entities": [...], "rules": [...], "boot"?: "<JS opcional para transformar todo>" }
Sé audaz: inventá entidades, props, tags, reglas y, si hace falta, una app entera en boot — cosas que el desarrollador nunca anticipó.`;

// ---- Compilación con Google Gemini (generativelanguage API, API key) ----
// Endpoint: .../v1beta/models/{model}:generateContent?key=<API_KEY>
// La key se obtiene gratis en https://aistudio.google.com/app/apikey
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface CompileOptions {
  apiKey: string;         // Google AI Studio API key
  model?: string;         // ej. "gemini-2.0-flash", "gemini-1.5-flash"
}

// Una llamada a Gemini: manda systemInstruction + texto de usuario, devuelve el texto.
async function callGemini(systemText: string, userText: string, opts: CompileOptions): Promise<string> {
  const model = opts.model ?? 'gemini-2.0-flash';
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
  });

  // reintento con backoff ante 503/429/500 (picos de demanda transitorios)
  const delays = [800, 2000, 4000];
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) break;
    const retryable = res.status === 503 || res.status === 429 || res.status === 500;
    if (!retryable || attempt >= delays.length) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
  if (!text) throw new Error('Respuesta vacía del modelo');
  return text;
}

export async function compileWithGemini(prompt: string, base: GameSpec, opts: CompileOptions): Promise<GameSpec> {
  const programa = JSON.stringify(base);
  const text = await callGemini(
    IR_VOCABULARY,
    `PROGRAMA ACTUAL (GameSpec):\n${programa}\n\nDeseo del jugador: """${prompt}"""\n\nDevolvé SOLO el GameSpec completo modificado.`,
    opts,
  );

  let spec: GameSpec;
  try {
    spec = parseSpecJson(text);
  } catch (err) {
    // JSON malformado del modelo: una pasada de REPARACIÓN devolviendo el texto roto
    console.warn('[gemini] JSON inválido, intentando reparar:', (err as Error).message);
    console.log('[gemini] texto crudo (roto):', text);
    const fixed = await callGemini(
      'Sos un reparador de JSON. Recibís un texto que DEBÍA ser JSON válido pero falló al parsear. Devolvé SOLO el JSON corregido (mismo contenido, escapando bien strings y comillas, sin comentarios ni texto extra).',
      `Error al parsear: ${(err as Error).message}\n\nTexto a corregir:\n${text}`,
      opts,
    );
    spec = parseSpecJson(fixed); // si esto también falla, propaga el error
  }

  logSpecChanges(base, spec);
  logExecutionModel(spec);
  return spec;
}

// Muestra CÓMO se ejecuta finalmente cada regla: IR interpretado (datos, tipo
// bytecode) vs JS crudo compilado con new Function. Esto es lo que corre la VM.
export function logExecutionModel(spec: GameSpec): void {
  console.log('%c[exec] modelo de ejecución (cómo corre cada regla)', 'font-weight:bold');
  spec.rules.forEach((r, i) => {
    const jsEffects = r.do.filter((d) => d.e === 'js') as { e: 'js'; code: string }[];
    if (jsEffects.length === 0) {
      // IR puro: datos que la VM interpreta (no es JS ni TS)
      console.log(`[exec] regla ${i}: IR INTERPRETADO (datos, no-JS). when=${r.when.t}, efectos=[${r.do.map((d) => d.e).join(',')}]`);
      console.log('        AST:', JSON.stringify(r));
    } else {
      // JS: string que la VM convierte en función real con new Function
      jsEffects.forEach((fx) => {
        const compiledSource =
          r.when.t === 'on_draw'
            ? 'function(d){"use strict";\nconst {ctx,w,h,world,entities,Math,rng,find,nearest,image}=d;\n' + fx.code + '\n}'
            : 'function(api){"use strict";\nconst {self,other,selfEntity,otherEntity,world,entities,dt,rng,Math,spawn,destroy,emit,win,lose,find,nearest}=api;\n' + fx.code + '\n}';
        console.log(`[exec] regla ${i}: JS CRUDO compilado con new Function (when=${r.when.t}). Fuente ejecutable real:`);
        console.log(compiledSource);
      });
    }
  });
  if (spec.boot) {
    console.log('[exec] boot: JS CRUDO compilado con new Function. Fuente ejecutable real:');
    console.log('function(api){"use strict";\nconst {root,canvas,ctx,vm,spec,stopGameLoop,startGameLoop,storage,W,H}=api;\n' + spec.boot + '\n}');
  }
}

// Loguea de forma legible QUÉ cambió Gemini respecto del juego base.
export function logSpecChanges(base: GameSpec, spec: GameSpec): void {
  const lines: string[] = [];

  // world: props nuevas o con valor distinto
  const baseW = base.world as Record<string, unknown>;
  const specW = spec.world as Record<string, unknown>;
  for (const k of Object.keys(specW)) {
    const a = JSON.stringify(baseW[k]); const b = JSON.stringify(specW[k]);
    if (a !== b) lines.push(`world.${k}: ${a ?? '(nuevo)'} -> ${b}`);
  }
  for (const k of Object.keys(baseW)) if (!(k in specW)) lines.push(`world.${k}: eliminado`);

  // entidades: tags + props visuales destacadas
  lines.push(`entities: ${base.entities.length} -> ${spec.entities.length}`);
  spec.entities.forEach((e, i) => {
    const vis = ['emoji', 'color', 'shape'].filter((p) => p in e.props).map((p) => `${p}=${JSON.stringify(e.props[p])}`).join(' ');
    lines.push(`  [${i}] tags=[${e.tags.join(',')}] ${vis}`);
  });

  // reglas: total + triggers, marcando js / on_draw
  lines.push(`rules: ${base.rules.length} -> ${spec.rules.length}`);
  spec.rules.forEach((r, i) => {
    const effs = r.do.map((d) => d.e);
    const tags: string[] = [];
    if (r.when.t === 'on_draw') tags.push('DIBUJO');
    if (effs.includes('js')) tags.push('JS');
    lines.push(`  [${i}] when=${r.when.t}${r.for ? ` for=${(r.for as { tag?: string }).tag ?? r.for.s}` : ''} do=[${effs.join(',')}]${tags.length ? ` <${tags.join('+')}>` : ''}`);
  });

  // boot: transformación total
  if (spec.boot) lines.push(`boot: SÍ (${spec.boot.length} chars de JS) -> transforma la app`);

  console.log('%c[gemini] cambios finales:', 'font-weight:bold');
  console.log(lines.join('\n'));
  console.log('[gemini] spec completo:', JSON.stringify(spec));
}

// Extrae y valida un GameSpec completo (tolera fences/texto alrededor).
export function parseSpecJson(text: string): GameSpec {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Gemini no devolvió JSON de GameSpec');
  const spec = JSON.parse(raw.slice(start, end + 1)) as GameSpec;
  if (!spec.world || typeof spec.world !== 'object') throw new Error('GameSpec sin world');
  if (!Array.isArray(spec.entities)) throw new Error('GameSpec sin entities');
  if (!Array.isArray(spec.rules)) throw new Error('GameSpec sin rules');
  return spec;
}

// Extrae y valida el JSON del parche (tolera bloques ```json o texto alrededor).
export function parsePatchJson(text: string): GamePatch {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Claude no devolvió JSON de parche');
  const patch = JSON.parse(raw.slice(start, end + 1)) as GamePatch;
  validatePatch(patch);
  return patch;
}

// ---- Fallback local (sin API key): patrones simples para validar el flujo ----
export function compileLocally(prompt: string): GamePatch {
  const t = prompt.toLowerCase();
  const patch: GamePatch = {};
  const world: Record<string, ExprOrValue> = {};

  const num = (re: RegExp): number | null => {
    const m = t.match(re);
    return m ? parseFloat(m[1]) : null;
  };

  if (/(menos|baja|poca|sin).*gravedad|gravedad.*(baja|menos)/.test(t)) world.gravity = 500;
  if (/(mas|más|mucha|alta).*gravedad|gravedad.*(alta|mas|más)/.test(t)) world.gravity = 3000;
  const g = num(/gravedad\s*(?:de|a|=)?\s*(\d+(?:\.\d+)?)/);
  if (g != null) world.gravity = g;

  if (/(mas|más|rapido|rápido).*(scroll|velocidad)|velocidad.*(alta|mas|más)/.test(t)) world.scroll = 320;
  if (/(lento|despacio|menos).*(scroll|velocidad)/.test(t)) world.scroll = 90;
  const s = num(/(?:scroll|velocidad)\s*(?:de|a|=)?\s*(\d+(?:\.\d+)?)/);
  if (s != null) world.scroll = s;

  const colorMap: Record<string, string> = {
    rojo: '#e63946', azul: '#457b9d', verde: '#2a9d8f', amarillo: '#ffd166',
    rosa: '#ff70a6', violeta: '#9b5de5', naranja: '#f3722c', blanco: '#f8f9fa', negro: '#1b1b1b',
  };
  for (const [name, hex] of Object.entries(colorMap)) {
    if (new RegExp(`fondo\\s+\\w*\\s*${name}|${name}.*fondo`).test(t)) world.background = hex;
  }

  if (Object.keys(world).length) patch.world = world;
  return patch;
}

function validatePatch(p: GamePatch): void {
  const isArr = (v: unknown) => v === undefined || Array.isArray(v);
  if (p.world !== undefined && typeof p.world !== 'object') throw new Error('world debe ser objeto');
  if (!isArr(p.patchEntities)) throw new Error('patchEntities debe ser array');
  if (!isArr(p.addEntities)) throw new Error('addEntities debe ser array');
  if (!isArr(p.addRules)) throw new Error('addRules debe ser array');
  if (!isArr(p.replaceRules)) throw new Error('replaceRules debe ser array');
  if (!isArr(p.removeRules)) throw new Error('removeRules debe ser array');
}
