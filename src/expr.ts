import type { Expr, Value, Vec2, Entity } from './types';

export interface EvalCtx {
  self?: Entity;
  other?: Entity;
  world: Entity;
  entities: Entity[];
  dt: number;
  rng: () => number;
}

const isVec = (v: any): v is Vec2 =>
  v != null && typeof v === 'object' && 'x' in v && 'y' in v;

export function evalExpr(e: Expr, ctx: EvalCtx): Value {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'vec':
      return { x: num(evalExpr(e.x, ctx)), y: num(evalExpr(e.y, ctx)) };
    case 'ref':
      return resolveRef(e.path, ctx);
    case 'neg':
      return -num(evalExpr(e.a, ctx));
    case 'bin':
      return evalBin(e.op, e.a, e.b, ctx);
    case 'call':
      return evalCall(e.fn, e.args, ctx);
  }
}

function resolveRef(path: string, ctx: EvalCtx): Value {
  const parts = path.split('.');
  const head = parts[0];
  if (head === 'dt') return ctx.dt;

  let base: Entity | undefined;
  if (head === 'self') base = ctx.self;
  else if (head === 'other') base = ctx.other;
  else if (head === 'world') base = ctx.world;
  if (!base) return 0;

  // self.pos.y  ->  props.pos (vec) .y
  let cur: any = base.props[parts[1]];
  for (let i = 2; i < parts.length; i++) {
    if (cur == null) return 0;
    cur = cur[parts[i]];
  }
  return cur ?? 0;
}

function evalBin(op: string, ae: Expr, be: Expr, ctx: EvalCtx): Value {
  if (op === '&&') return bool(evalExpr(ae, ctx)) && bool(evalExpr(be, ctx));
  if (op === '||') return bool(evalExpr(ae, ctx)) || bool(evalExpr(be, ctx));
  const a = evalExpr(ae, ctx);
  const b = evalExpr(be, ctx);
  // soporte vectorial para + - * (escalar)
  if (isVec(a) || isVec(b)) return vecBin(op, a, b);
  const x = num(a), y = num(b);
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? 0 : x / y;
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    case '==': return x === y;
    case '!=': return x !== y;
  }
  return 0;
}

function vecBin(op: string, a: Value, b: Value): Value {
  const av = isVec(a) ? a : { x: num(a), y: num(a) };
  const bv = isVec(b) ? b : { x: num(b), y: num(b) };
  switch (op) {
    case '+': return { x: av.x + bv.x, y: av.y + bv.y };
    case '-': return { x: av.x - bv.x, y: av.y - bv.y };
    case '*': return { x: av.x * bv.x, y: av.y * bv.y };
    case '/': return { x: bv.x ? av.x / bv.x : 0, y: bv.y ? av.y / bv.y : 0 };
  }
  return av;
}

function evalCall(fn: string, args: Expr[], ctx: EvalCtx): Value {
  const a = (i: number) => evalExpr(args[i], ctx);
  switch (fn) {
    case 'random': {
      const lo = num(a(0)), hi = num(a(1));
      return lo + ctx.rng() * (hi - lo);
    }
    case 'abs': return Math.abs(num(a(0)));
    case 'min': return Math.min(num(a(0)), num(a(1)));
    case 'max': return Math.max(num(a(0)), num(a(1)));
    case 'count': {
      const tag = String(a(0));
      return ctx.entities.filter((e) => e.tags.has(tag)).length;
    }
    case 'distance': {
      const p = a(0) as Vec2, q = a(1) as Vec2;
      return Math.hypot(p.x - q.x, p.y - q.y);
    }
    case 'toward': {
      const from = a(0) as Vec2, to = a(1) as Vec2;
      const dx = to.x - from.x, dy = to.y - from.y;
      const m = Math.hypot(dx, dy) || 1;
      return { x: dx / m, y: dy / m };
    }
    case 'nearest': {
      const tag = String(a(0));
      const ref = ctx.self?.props.pos as Vec2 | undefined;
      const cands = ctx.entities.filter((e) => e.tags.has(tag) && e !== ctx.self);
      if (!ref || cands.length === 0) return { x: 0, y: 0 };
      let best = cands[0], bd = Infinity;
      for (const c of cands) {
        const p = c.props.pos as Vec2;
        const d = Math.hypot(p.x - ref.x, p.y - ref.y);
        if (d < bd) { bd = d; best = c; }
      }
      return best.props.pos as Vec2;
    }
  }
  return 0;
}

export const num = (v: Value): number =>
  typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
export const bool = (v: Value): boolean =>
  typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !!v;
