# LLM Game VM

Un juego (base: Flappy) donde, antes de jugar, escribís un **deseo en lenguaje natural** y un LLM (Gemini) **reescribe el programa del juego** para cumplirlo: física, reglas, diseño, controles — incluso transformarlo en algo que no es un juego.

## Arquitectura (analogía JVM)

- **Deseo** (lenguaje natural) → lo escribe el jugador.
- **Compilador** = el LLM. Corre **una vez** al inicio. Recibe el programa actual (`GameSpec` en JSON) y devuelve el programa modificado.
- **IR** = `GameSpec` (datos JSON: `world`, `entities`, `rules`). Es el "bytecode".
- **VM determinista** = el runtime que interpreta el IR a 60fps (timestep fijo, PRNG seedeado).

### Tres niveles de apertura

1. **IR interpretado** (`world`/`entities`/`rules`): datos que la VM evalúa. No es JS ni TS. Reglas con 4 ejes ortogonales: Trigger × Condición × Target × Effect.
2. **Efecto `js`** y trigger **`on_draw`**: JavaScript crudo compilado con `new Function`. Lógica/dibujo arbitrario con acceso al estado del juego y al canvas.
3. **`boot`**: JS que corre una vez con acceso TOTAL al DOM — puede transformar la experiencia en cualquier app (ej. un sistema de gestión).

> Los hatches de JS no están sandboxeados (uso local, sin restricciones de seguridad).

## Uso

```bash
npm install
npm run dev      # http://localhost:5173/
```

Pegá una **API key de Gemini** (gratis en https://aistudio.google.com/app/apikey) en el campo del overlay y escribí tu deseo. Sin key, hay un parser local de respaldo para deseos simples.

La consola (F12) muestra:
- `[gemini] cambios finales`: diff legible de lo que cambió.
- `[exec] modelo de ejecución`: cómo se ejecuta cada regla (IR interpretado vs JS compilado).

## Test headless

```bash
npm run harness   # corre la VM sin DOM y verifica física/reglas
```

## Archivos

- `src/types.ts` — el IR (instruction set) + tipos de las APIs JS.
- `src/expr.ts` — evaluador de expresiones del IR.
- `src/vm.ts` — la VM determinista (integrador, colisiones, reglas, hatches JS).
- `src/render.ts` — renderer de canvas (formas, emoji, capa `on_draw`).
- `src/flappy.ts` — el juego base expresado como IR.
- `src/compiler.ts` — deseo → Gemini → `GameSpec`, con loggers y fallback local.
- `src/main.ts` — bootstrap, loop, overlay de deseo, runner de `boot`.
- `src/harness.ts` — test headless en Node.
