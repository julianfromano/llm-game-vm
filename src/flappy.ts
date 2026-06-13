import type { GameSpec, Expr, ExprOrValue, BinOp, Fn } from './types';

// ---- builders mínimos para escribir el IR legible ----
const toE = (v: ExprOrValue): Expr =>
  v != null && typeof v === 'object' && 'k' in (v as any) ? (v as Expr) : { k: 'lit', v: v as any };
const L = (v: number | boolean | string): Expr => ({ k: 'lit', v });
const R = (path: string): Expr => ({ k: 'ref', path });
const V = (x: ExprOrValue, y: ExprOrValue): Expr => ({ k: 'vec', x: toE(x), y: toE(y) });
const op = (o: BinOp, a: ExprOrValue, b: ExprOrValue): Expr => ({ k: 'bin', op: o, a: toE(a), b: toE(b) });
const call = (fn: Fn, ...args: ExprOrValue[]): Expr => ({ k: 'call', fn, args: args.map(toE) });

export const W = 480;
export const H = 560;
const GAP_HALF = 80;

const gapCenter = R('world.gap');

export const flappy: GameSpec = {
  world: {
    gravity: 1500,
    scroll: 170,
    score: 0,
    gap: 280,
    birdx: 110,
    background: '#0b1020',
  },

  entities: [
    {
      tags: ['bird', 'gravity'],
      props: { pos: { x: 110, y: 260 }, vel: { x: 0, y: 0 }, size: { x: 30, y: 24 }, color: '#ffd166', shape: 'circle' },
    },
    {
      tags: ['ground'],
      props: { pos: { x: W / 2, y: H - 20 }, size: { x: W, y: 40 }, color: '#2a9d8f' },
    },
  ],

  rules: [
    // R0: publicar la x del pájaro al mundo (para que las reglas de tubos la lean)
    { when: { t: 'every_frame' }, for: { s: 'with_tag', tag: 'bird' },
      do: [{ e: 'set', path: 'world.birdx', value: R('self.pos.x') }] },

    // R1: gravedad = fuerza genérica sobre lo etiquetado 'gravity'
    { when: { t: 'every_frame' }, for: { s: 'with_tag', tag: 'gravity' },
      do: [{ e: 'add', path: 'self.vel.y', value: op('*', R('world.gravity'), R('dt')) }] },

    // R2: aletear
    { when: { t: 'on_input', key: 'space', phase: 'down' }, for: { s: 'with_tag', tag: 'bird' },
      do: [{ e: 'set', path: 'self.vel.y', value: L(-440) }] },

    // R3: generar par de tubos (gap aleatorio, mismo valor para arriba y abajo)
    { when: { t: 'every', seconds: 1.5 },
      do: [
        { e: 'set', path: 'world.gap', value: call('random', 150, H - 130) },
        // tubo superior (también marca el punto de puntaje)
        { e: 'spawn', template: {
          tags: ['pipe', 'obstacle', 'scorer'],
          props: {
            pos: V(W + 40, op('/', op('-', gapCenter, GAP_HALF), 2)),
            vel: V(op('*', R('world.scroll'), -1), 0),
            size: V(60, op('-', gapCenter, GAP_HALF)),
            color: '#e76f51', scored: false,
          } } },
        // tubo inferior
        { e: 'spawn', template: {
          tags: ['pipe', 'obstacle'],
          props: {
            pos: V(W + 40, op('/', op('+', op('+', gapCenter, GAP_HALF), H), 2)),
            vel: V(op('*', R('world.scroll'), -1), 0),
            size: V(60, op('-', H, op('+', gapCenter, GAP_HALF))),
            color: '#e76f51',
          } } },
      ] },

    // R4: limpiar tubos fuera de pantalla
    { when: { t: 'every_frame' }, for: { s: 'with_tag', tag: 'pipe' }, if: op('<', R('self.pos.x'), -40),
      do: [{ e: 'destroy' }] },

    // R5: puntaje al pasar el tubo marcador
    { when: { t: 'every_frame' }, for: { s: 'with_tag', tag: 'scorer' },
      if: op('&&', op('<', R('self.pos.x'), R('world.birdx')), op('==', R('self.scored'), false)),
      do: [{ e: 'set', path: 'self.scored', value: L(true) }, { e: 'add', path: 'world.score', value: L(1) }] },

    // R6: perder por chocar obstáculo o suelo
    { when: { t: 'on_collision', a: 'bird', b: 'obstacle' }, do: [{ e: 'end_game', result: 'lose' }] },
    { when: { t: 'on_collision', a: 'bird', b: 'ground' }, do: [{ e: 'end_game', result: 'lose' }] },

    // R7: perder por salir por arriba
    { when: { t: 'every_frame' }, for: { s: 'with_tag', tag: 'bird' }, if: op('<', R('self.pos.y'), 0),
      do: [{ e: 'end_game', result: 'lose' }] },
  ],
};
