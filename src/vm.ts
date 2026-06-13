import type {
  GameSpec, Rule, Target, Effect, Entity, EntityTemplate,
  Value, Vec2, ExprOrValue, Expr, GameApi, DrawApi,
} from './types';
import { evalExpr, num, bool, type EvalCtx } from './expr';

const MAX_ENTITIES = 2000; // guarda determinista anti-explosión

export type GameState = 'playing' | 'win' | 'lose';

export class VM {
  world!: Entity;
  entities: Entity[] = [];
  state: GameState = 'playing';
  events: string[] = [];

  private spec: GameSpec;
  private nextId = 1;
  private rng: () => number;
  private timers = new Map<Rule, number>();      // acumulador para `every`
  private crossPrev = new Map<Rule, boolean>();   // flanco para `on_cross`
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();        // edge de este frame
  private keysReleased = new Set<string>();
  private collisionsThisFrame: Array<[Entity, Entity]> = [];

  constructor(spec: GameSpec, seed = 1) {
    this.spec = spec;
    this.rng = mulberry32(seed);
    this.reset();
  }

  reset() {
    this.nextId = 1;
    this.entities = [];
    this.state = 'playing';
    this.timers.clear();
    this.crossPrev.clear();
    const ctx = this.baseCtx(0);
    this.world = { id: 'world', tags: new Set(['world']), props: {} };
    this.world.props = this.evalProps(this.spec.world, ctx);
    ctx.world = this.world;
    for (const tpl of this.spec.entities) this.spawn(tpl, ctx);
  }

  // ---- input ----
  keyDown(k: string) { if (!this.keysDown.has(k)) this.keysPressed.add(k); this.keysDown.add(k); }
  keyUp(k: string) { this.keysDown.delete(k); this.keysReleased.add(k); }

  // ---- tick fijo (determinista) ----
  step(dt: number) {
    if (this.state !== 'playing') {
      // permitir reinicio con cualquier tecla
      if (this.keysPressed.size) this.reset();
      this.endFrameInput();
      return;
    }
    this.events = [];
    this.integrate(dt);
    this.detectCollisions();
    this.runRules(dt);
    this.endFrameInput();
  }

  private endFrameInput() {
    this.keysPressed.clear();
    this.keysReleased.clear();
  }

  // integrador genérico: cualquier entidad con pos+vel se mueve; acc = fuerzas
  private integrate(dt: number) {
    for (const e of this.entities) {
      const pos = e.props.pos as Vec2 | undefined;
      const vel = e.props.vel as Vec2 | undefined;
      if (!pos || !vel) continue;
      const acc = (e.props.acc as Vec2) ?? { x: 0, y: 0 };
      vel.x += acc.x * dt; vel.y += acc.y * dt;
      pos.x += vel.x * dt; pos.y += vel.y * dt;
      e.props.acc = { x: 0, y: 0 }; // se reaplica por reglas cada frame
    }
  }

  private detectCollisions() {
    this.collisionsThisFrame = [];
    const es = this.entities;
    for (let i = 0; i < es.length; i++) {
      for (let j = i + 1; j < es.length; j++) {
        if (aabb(es[i], es[j])) this.collisionsThisFrame.push([es[i], es[j]]);
      }
    }
  }

  private runRules(dt: number) {
    for (const rule of this.spec.rules) {
      this.runRule(rule, dt);
      if (this.state !== 'playing') return;
    }
  }

  private runRule(rule: Rule, dt: number) {
    // 1) recolectar disparos del trigger: cada uno aporta (self?, other?)
    const firings = this.collectFirings(rule, dt);
    // 2) por cada disparo: resolver targets, evaluar `if` POR target, aplicar efectos
    for (const f of firings) {
      const targets = rule.for
        ? this.selectTargets(rule.for, f.self, f.other)
        : f.self ? [f.self] : [undefined];
      for (const tgt of targets) {
        const ctx = this.baseCtx(dt, tgt, f.other);
        if (rule.if && !bool(evalExpr(rule.if, ctx))) continue;
        this.applyEffects(rule.do, ctx);
        if (this.state !== 'playing') return;
      }
    }
  }

  private collectFirings(rule: Rule, dt: number): Array<{ self?: Entity; other?: Entity }> {
    switch (rule.when.t) {
      case 'every_frame':
        return [{}];
      case 'every': {
        const acc = (this.timers.get(rule) ?? 0) + dt;
        if (acc >= rule.when.seconds) { this.timers.set(rule, acc - rule.when.seconds); return [{}]; }
        this.timers.set(rule, acc);
        return [];
      }
      case 'on_input': {
        const k = rule.when.key;
        const hit = rule.when.phase === 'down' ? this.keysPressed.has(k)
          : rule.when.phase === 'up' ? this.keysReleased.has(k)
          : this.keysDown.has(k);
        return hit ? [{}] : [];
      }
      case 'on_collision': {
        const { a, b } = rule.when;
        const out: Array<{ self: Entity; other: Entity }> = [];
        for (const [x, y] of this.collisionsThisFrame) {
          if (x.tags.has(a) && y.tags.has(b)) out.push({ self: x, other: y });
          else if (y.tags.has(a) && x.tags.has(b)) out.push({ self: y, other: x });
        }
        return out;
      }
      case 'on_cross': {
        const now = bool(evalExpr(rule.when.expr, this.baseCtx(dt)));
        const prev = this.crossPrev.get(rule) ?? false;
        this.crossPrev.set(rule, now);
        return now && !prev ? [{}] : [];
      }
      default:
        return [];
    }
  }

  private selectTargets(t: Target | undefined, self?: Entity, other?: Entity): Entity[] {
    if (!t) return self ? [self] : [];
    switch (t.s) {
      case 'all': return [...this.entities];
      case 'with_tag': return this.entities.filter((e) => e.tags.has(t.tag));
      case 'id': return this.entities.filter((e) => e.id === t.id);
      case 'self': return self ? [self] : [];
      case 'the_collider': return other ? [other] : [];
      case 'nearest_to': {
        const ref = this.selectTargets(t.ref, self, other)[0];
        if (!ref) return [];
        const refPos = ref.props.pos as Vec2;
        const cands = this.entities.filter((e) => e.tags.has(t.tag));
        let best: Entity | undefined, bd = Infinity;
        for (const c of cands) {
          const p = c.props.pos as Vec2;
          const d = Math.hypot(p.x - refPos.x, p.y - refPos.y);
          if (d < bd) { bd = d; best = c; }
        }
        return best ? [best] : [];
      }
    }
  }

  private applyEffects(effects: Effect[], ctx: EvalCtx) {
    for (const fx of effects) {
      switch (fx.e) {
        case 'set': this.writePath(fx.path, evalExpr(fx.value, ctx), ctx, false); break;
        case 'add': this.writePath(fx.path, evalExpr(fx.value, ctx), ctx, true); break;
        case 'add_force': {
          if (!ctx.self) break;
          const f = evalExpr(fx.value, ctx) as Vec2;
          const acc = (ctx.self.props.acc as Vec2) ?? { x: 0, y: 0 };
          ctx.self.props.acc = { x: acc.x + f.x, y: acc.y + f.y };
          break;
        }
        case 'spawn': this.spawn(fx.template, ctx); break;
        case 'destroy': {
          // target opcional (ej. the_collider para destruir al otro de una colisión).
          // Aceptamos también `for` por robustez (el LLM a veces lo emite así).
          const tgt = fx.target ?? (fx as { for?: Target }).for;
          if (tgt) { for (const e of this.selectTargets(tgt, ctx.self, ctx.other)) this.destroy(e); }
          else if (ctx.self) this.destroy(ctx.self);
          break;
        }
        case 'emit': this.events.push(fx.event); break;
        case 'end_game': this.state = fx.result; return;
        case 'js': this.runJs(fx.code, ctx); if (this.state !== 'playing') return; break;
      }
    }
  }

  // ---- escape hatch: JS arbitrario (compilado una vez, cacheado por código) ----
  private jsCache = new Map<string, (api: GameApi) => void>();

  private runJs(code: string, ctx: EvalCtx) {
    const api = this.makeApi(ctx);
    let fn = this.jsCache.get(code);
    if (!fn) {
      try {
        // el scope se deriva de las claves reales de la API: nunca se desincroniza
        const names = Object.keys(api).join(',');
        fn = new Function('api', `"use strict";\nconst {${names}}=api;\n` + code) as (api: GameApi) => void;
      } catch (e) {
        console.error('[js] error compilando regla:', e);
        fn = () => {};
      }
      this.jsCache.set(code, fn);
    }
    try {
      fn(api);
    } catch (e) {
      console.error('[js] error ejecutando regla:', e);
    }
  }

  private makeApi(ctx: EvalCtx): GameApi {
    return {
      self: ctx.self?.props ?? null,
      other: ctx.other?.props ?? null,
      selfEntity: ctx.self ?? null,
      otherEntity: ctx.other ?? null,
      world: this.world.props,
      entities: this.entities,
      dt: ctx.dt,
      rng: this.rng,
      Math,
      spawn: (tpl) => this.spawn(tpl as EntityTemplate, ctx),
      destroy: (e) => { const t = e ?? ctx.self; if (t) this.destroy(t); },
      emit: (ev) => this.events.push(ev),
      win: () => { this.state = 'win'; },
      lose: () => { this.state = 'lose'; },
      find: (tag) => this.entities.filter((e) => e.tags.has(tag)),
      nearest: (tag, from) => {
        let best: Entity | undefined, bd = Infinity;
        for (const e of this.entities) {
          if (!e.tags.has(tag)) continue;
          const p = e.props.pos as Vec2; if (!p) continue;
          const d = Math.hypot(p.x - from.x, p.y - from.y);
          if (d < bd) { bd = d; best = e; }
        }
        return best ?? null;
      },
    };
  }

  // ---- capa de dibujo: corre las reglas on_draw con acceso al canvas ----
  private jsDrawCache = new Map<string, (d: DrawApi) => void>();

  runDraw(ctx: CanvasRenderingContext2D, w: number, h: number, image: (url: string) => CanvasImageSource) {
    for (const rule of this.spec.rules) {
      if (rule.when.t !== 'on_draw') continue;
      for (const fx of rule.do) {
        if (fx.e !== 'js') continue;
        const d: DrawApi = {
          ctx, w, h, image, Math, rng: this.rng,
          world: this.world.props, entities: this.entities,
          find: (tag) => this.entities.filter((e) => e.tags.has(tag)),
          nearest: (tag, from) => {
            let best: Entity | undefined, bd = Infinity;
            for (const e of this.entities) {
              if (!e.tags.has(tag)) continue;
              const p = e.props.pos as Vec2; if (!p) continue;
              const dd = Math.hypot(p.x - from.x, p.y - from.y);
              if (dd < bd) { bd = dd; best = e; }
            }
            return best ?? null;
          },
        };
        let fn = this.jsDrawCache.get(fx.code);
        if (!fn) {
          try {
            const names = Object.keys(d).join(',');
            fn = new Function('d', `"use strict";\nconst {${names}}=d;\n` + fx.code) as (d: DrawApi) => void;
          } catch (e) {
            console.error('[on_draw] error compilando:', e);
            fn = () => {};
          }
          this.jsDrawCache.set(fx.code, fn);
        }
        try {
          fn(d);
        } catch (e) {
          console.error('[on_draw] error ejecutando:', e);
        }
      }
    }
  }

  // path: "self.vel.y" | "world.score" | "other.pos.x"
  private writePath(path: string, value: Value, ctx: EvalCtx, add: boolean) {
    const parts = path.split('.');
    const base = parts[0] === 'world' ? ctx.world
      : parts[0] === 'other' ? ctx.other
      : ctx.self;
    if (!base) return;
    if (parts.length === 2) {
      const key = parts[1];
      base.props[key] = add ? num(base.props[key] as Value) + num(value) : value;
    } else {
      // anidado: self.pos.y
      let obj: any = base.props[parts[1]];
      if (obj == null) { obj = {}; base.props[parts[1]] = obj; }
      for (let i = 2; i < parts.length - 1; i++) obj = obj[parts[i]];
      const last = parts[parts.length - 1];
      obj[last] = add ? num(obj[last]) + num(value) : value;
    }
  }

  private spawn(tpl: EntityTemplate, ctx: EvalCtx): Entity | null {
    if (this.entities.length >= MAX_ENTITIES) return null;
    const props = this.evalProps(tpl.props, ctx);
    if (!props.acc && props.pos && props.vel) props.acc = { x: 0, y: 0 };
    const e: Entity = { id: `e${this.nextId++}`, tags: new Set(tpl.tags), props };
    this.entities.push(e);
    return e;
  }

  private destroy(e: Entity) {
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities.splice(i, 1);
  }

  private evalProps(src: Record<string, ExprOrValue>, ctx: EvalCtx): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const [k, v] of Object.entries(src)) {
      out[k] = isExpr(v) ? evalExpr(v, ctx) : structuredValue(v);
    }
    return out;
  }

  private baseCtx(dt: number, self?: Entity, other?: Entity): EvalCtx {
    return { self, other, world: this.world, entities: this.entities, dt, rng: this.rng };
  }
}

// ---- helpers ----
function isExpr(v: ExprOrValue): v is Expr {
  return v != null && typeof v === 'object' && 'k' in (v as any);
}
function structuredValue(v: Value): Value {
  // clonar vecs para no compartir referencia entre entidades
  if (v && typeof v === 'object' && 'x' in v) return { x: v.x, y: v.y };
  return v;
}

function aabb(a: Entity, b: Entity): boolean {
  const pa = a.props.pos as Vec2, sa = a.props.size as Vec2;
  const pb = b.props.pos as Vec2, sb = b.props.size as Vec2;
  if (!pa || !sa || !pb || !sb) return false;
  return (
    Math.abs(pa.x - pb.x) * 2 < sa.x + sb.x &&
    Math.abs(pa.y - pb.y) * 2 < sa.y + sb.y
  );
}

// PRNG determinista
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
