import { VM } from './vm';
import { render } from './render';
import { flappy, W, H } from './flappy';
import { mergeSpec, compile, compileLocally, type Provider } from './compiler';
import type { GameSpec } from './types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d')!;

// proveedor + key + modelo, persistidos en localStorage (por proveedor)
const getProvider = (): Provider => (localStorage.getItem('flappy.provider') as Provider) || 'gemini';
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: 'gemini-2.5-flash-lite',
  groq: 'llama-3.3-70b-versatile',
};
const getKey = (p: Provider) => localStorage.getItem(`flappy.${p}Key`) ?? '';
const getModel = (p: Provider) => localStorage.getItem(`flappy.${p}Model`) || DEFAULT_MODEL[p];

let vm = new VM(flappy, Date.now() & 0xffff);

// ---- input: TODAS las teclas se reenvían a la VM con nombre normalizado ----
// (así cualquier regla on_input con cualquier tecla funciona, no solo 'space')
// Ignorar cuando se está escribiendo en un campo o el overlay de deseo está visible.
const typing = (e: Event) => {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || overlay?.style.display !== 'none';
};
// nombre canónico de tecla: e.key en minúscula; barra espaciadora -> 'space'
const normKey = (e: KeyboardEvent) => (e.code === 'Space' || e.key === ' ' ? 'space' : e.key.toLowerCase());
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  const k = normKey(e);
  if (k === 'space' || k.startsWith('arrow')) e.preventDefault(); // evitar scroll del navegador
  vm.keyDown(k);
});
addEventListener('keyup', (e) => { if (!typing(e)) vm.keyUp(normKey(e)); });
// puntero/touch -> 'space' (controlador por defecto, ej. aletear)
const press = (e: Event) => { e.preventDefault(); vm.keyDown('space'); };
const release = () => vm.keyUp('space');
canvas.addEventListener('pointerdown', press);
canvas.addEventListener('pointerup', release);

// debug: exponer estado para inspección manual (solo dev)
(window as unknown as Record<string, unknown>).__game = { get vm() { return vm; }, render: () => render(ctx, vm, W, H), start: (s: GameSpec) => startWith(s) };

// ---- loop con timestep fijo determinista (con control de parada) ----
const DT = 1 / 60;
let acc = 0;
let last = performance.now();
let loopRunning = true;
function frame(now: number) {
  if (!loopRunning) return;
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (acc >= DT) { vm.step(DT); acc -= DT; }
  render(ctx, vm, W, H);
  requestAnimationFrame(frame);
}
function stopGameLoop() { loopRunning = false; }
function startGameLoop() { if (!loopRunning) { loopRunning = true; last = performance.now(); requestAnimationFrame(frame); } }
requestAnimationFrame(frame);

// ---- pantalla de deseo (overlay) ----
const overlay = document.getElementById('wish') as HTMLElement;
const input = document.getElementById('wishInput') as HTMLTextAreaElement;
const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
const skipBtn = document.getElementById('skipBtn') as HTMLButtonElement;
const status = document.getElementById('wishStatus') as HTMLElement;

function startWith(spec: GameSpec) {
  vm = new VM(spec, Date.now() & 0xffff);
  overlay.style.display = 'none';
  startGameLoop();
  runBoot(spec);
}

// escape hatch máximo: corre spec.boot UNA vez con acceso total al DOM.
// Permite que el deseo transforme la experiencia en cualquier app (gestión, etc.).
const bootRoot = document.getElementById('app-root') as HTMLElement;
function runBoot(spec: GameSpec) {
  // sin boot: volver al estado de juego (canvas visible, container vacío)
  if (!spec.boot) {
    if (bootRoot) bootRoot.innerHTML = '';
    canvas.style.display = '';
    return;
  }
  const api = {
    root: bootRoot,
    canvas, ctx, vm, spec,
    stopGameLoop, startGameLoop,
    storage: localStorage,
    W, H,
  };
  try {
    const fn = new Function('api', '"use strict";\nconst {root,canvas,ctx,vm,spec,stopGameLoop,startGameLoop,storage,W,H}=api;\n' + spec.boot);
    fn(api);
  } catch (e) {
    console.error('[boot] error:', e);
    status.textContent = 'Error en boot: ' + (e as Error).message;
  }
}

async function onPlay() {
  const wish = input.value.trim();
  if (!wish) { startWith(flappy); return; }
  const provider = getProvider();
  const key = getKey(provider);
  playBtn.disabled = true;
  try {
    let spec: GameSpec;
    if (key) {
      status.textContent = `${provider === 'groq' ? 'Groq' : 'Gemini'} está reescribiendo el juego…`;
      spec = await compile(wish, flappy, { apiKey: key, model: getModel(provider), provider });
    } else {
      status.textContent = 'Sin API key: usando parser local de respaldo.';
      spec = mergeSpec(flappy, compileLocally(wish));
    }
    startWith(spec);
  } catch (err) {
    status.textContent = 'Error: ' + (err as Error).message;
    playBtn.disabled = false;
  }
}

playBtn.addEventListener('click', onPlay);
skipBtn.addEventListener('click', () => startWith(flappy));
