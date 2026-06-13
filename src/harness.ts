// Arnés headless: corre la VM sin DOM y verifica la física/reglas de Flappy.
import { VM } from './vm';
import { flappy } from './flappy';
import type { Vec2 } from './types';

const DT = 1 / 60;
const bird = (vm: VM) => vm.entities.find((e) => e.tags.has('bird'))!;
const log = (...a: unknown[]) => console.log(...a);

// 1) Sin input: el pájaro cae y pierde.
{
  const vm = new VM(flappy, 42);
  const y0 = (bird(vm).props.pos as Vec2).y;
  let frames = 0;
  while (vm.state === 'playing' && frames < 600) { vm.step(DT); frames++; }
  log(`[caida] y0=${y0.toFixed(0)} -> perdio=${vm.state === 'lose'} en ${frames} frames`);
  console.assert(vm.state === 'lose', 'deberia perder por gravedad/suelo');
}

// 2) Hover: aletear solo al caer por debajo de una linea -> sobrevive mucho mas.
{
  const vm = new VM(flappy, 42);
  let frames = 0;
  while (vm.state === 'playing' && frames < 1200) {
    const b = bird(vm);
    const y = (b.props.pos as Vec2).y;
    const vy = (b.props.vel as Vec2).y;
    if (y > 300 && vy > 0) vm.keyDown('space'); else vm.keyUp('space');
    vm.step(DT);
    frames++;
  }
  log(`[hover] sobrevivio ${frames} frames (estado=${vm.state})`);
  console.assert(frames > 180, 'con hover deberia durar bastante mas');
}

// 3) Determinismo: misma semilla -> mismo resultado.
{
  const run = () => { const vm = new VM(flappy, 7); let f = 0; while (vm.state === 'playing' && f < 300) { vm.step(DT); f++; } return f + ':' + vm.state; };
  const a = run(), b = run();
  log(`[determinismo] a=${a} b=${b} iguales=${a === b}`);
  console.assert(a === b, 'misma semilla debe dar mismo resultado');
}

// 4) Se generan tubos (con hover para no perder antes del primer spawn).
{
  const vm = new VM(flappy, 3);
  for (let i = 0; i < 200 && vm.state === 'playing'; i++) {
    const b = bird(vm);
    const y = (b.props.pos as Vec2).y;
    const vy = (b.props.vel as Vec2).y;
    if (y > 300 && vy > 0) vm.keyDown('space'); else vm.keyUp('space');
    vm.step(DT);
  }
  const pipes = vm.entities.filter((e) => e.tags.has('pipe')).length;
  log(`[tubos] activos=${pipes} estado=${vm.state}`);
  console.assert(pipes > 0, 'deberian existir tubos');
}

log('OK: arnes completado');
