// IR del juego: base generativa (ortogonalidad + propiedades genéricas).
// Todo es JSON-serializable a propósito: este mismo formato lo emitirá Claude.

export type Vec2 = { x: number; y: number };
export type Value = number | boolean | string | Vec2;

// ---- Expresiones (gramática chica, generativa) ----
export type Expr =
  | { k: 'lit'; v: number | boolean | string }
  | { k: 'vec'; x: Expr; y: Expr }
  | { k: 'ref'; path: string } // "self.pos.y" | "other.vel.y" | "world.score" | "dt"
  | { k: 'neg'; a: Expr }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { k: 'call'; fn: Fn; args: Expr[] };

export type BinOp =
  | '+' | '-' | '*' | '/'
  | '<' | '>' | '<=' | '>=' | '==' | '!='
  | '&&' | '||';

export type Fn =
  | 'nearest'   // nearest(tag) -> entity ref via props (returns vec pos)
  | 'distance'  // distance(vecA, vecB)
  | 'random'    // random(min, max)
  | 'count'     // count(tag)
  | 'toward'    // toward(vecFrom, vecTo) -> unit vec
  | 'abs' | 'min' | 'max';

// ---- Los 4 ejes ortogonales ----
export type Trigger =
  | { t: 'every_frame' }
  | { t: 'every'; seconds: number }
  | { t: 'on_input'; key: string; phase: 'down' | 'up' | 'held' }
  | { t: 'on_collision'; a: string; b: string } // tags
  | { t: 'on_spawn'; tag: string }
  | { t: 'on_destroy'; tag: string }
  | { t: 'on_cross'; expr: Expr } // flanco global false->true
  | { t: 'on_draw' };            // se ejecuta en el render (efectos js con acceso al canvas)

export type Target =
  | { s: 'all' }
  | { s: 'with_tag'; tag: string }
  | { s: 'id'; id: string }
  | { s: 'self' }          // entidad del contexto del trigger
  | { s: 'the_collider' }  // 'other' en una colisión
  | { s: 'nearest_to'; tag: string; ref: Target };

export type Effect =
  | { e: 'set'; path: string; value: Expr }
  | { e: 'add'; path: string; value: Expr }
  | { e: 'spawn'; template: EntityTemplate }
  | { e: 'destroy' }
  | { e: 'add_force'; value: Expr } // vec, se acumula en self.acc
  | { e: 'emit'; event: string }
  | { e: 'end_game'; result: 'win' | 'lose' }
  | { e: 'js'; code: string }; // escape hatch: JS arbitrario sobre la API del juego

export interface Rule {
  when: Trigger;
  if?: Expr;          // condición booleana opcional
  for?: Target;       // sobre qué entidades corre `do` (default: self)
  do: Effect[];
}

export interface EntityTemplate {
  tags: string[];
  props: Record<string, ExprOrValue>;
}
export type ExprOrValue = Value | Expr;

// ---- Estado en runtime ----
export interface Entity {
  id: string;
  tags: Set<string>;
  props: Record<string, Value>;
}

// ---- API expuesta al código JS de las reglas { e: 'js' } ----
export interface GameApi {
  self: Record<string, Value> | null;   // props de la entidad self (mutables)
  other: Record<string, Value> | null;  // props del colisionado, si aplica
  selfEntity: Entity | null;            // la entidad self completa (tags, id)
  world: Record<string, Value>;         // props globales (mutables)
  entities: Entity[];                   // todas las entidades vivas
  dt: number;
  rng: () => number;                    // PRNG seedeado (usar para determinismo)
  Math: Math;
  spawn: (template: EntityTemplate) => Entity | null;
  destroy: (e?: Entity | null) => void; // sin arg destruye self
  emit: (event: string) => void;
  win: () => void;
  lose: () => void;
  find: (tag: string) => Entity[];
  nearest: (tag: string, from: Vec2) => Entity | null;
}

// ---- API expuesta al código JS de las reglas { t:'on_draw' } (capa de dibujo) ----
export interface DrawApi {
  ctx: CanvasRenderingContext2D; // contexto 2D del canvas — dibujá lo que quieras
  w: number;
  h: number;
  world: Record<string, Value>;
  entities: Entity[];
  Math: Math;
  rng: () => number;
  find: (tag: string) => Entity[];
  nearest: (tag: string, from: Vec2) => Entity | null;
  image: (url: string) => CanvasImageSource; // carga/cachea una imagen por URL
}

export interface GameSpec {
  world: Record<string, ExprOrValue>; // props globales: gravity, score, background...
  entities: EntityTemplate[];          // entidades iniciales
  rules: Rule[];
  // escape hatch máximo: JS que corre UNA vez al inicio con acceso total al DOM.
  // Permite transformar la experiencia en cualquier cosa (incluso algo que no es
  // un juego: un sistema de gestión, una calculadora, etc.). Solo uso local.
  boot?: string;
}
