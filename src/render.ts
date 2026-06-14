import type { Vec2 } from './types';
import type { VM } from './vm';

// cache de imágenes de fondo por URL (carga asíncrona, se dibuja cuando llega)
const imgCache = new Map<string, HTMLImageElement>();
function getImage(url: string): HTMLImageElement {
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    imgCache.set(url, img);
  }
  return img;
}

// Renderer genérico: dibuja cualquier entidad según sus props visuales.
// props usadas: pos (vec, centro), size (vec), color (string), shape ('rect'|'circle'), emoji (string)
export function render(ctx: CanvasRenderingContext2D, vm: VM, w: number, h: number) {
  const bg = (vm.world.props.background as string) ?? '#0b1020';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // capa de dibujo generativa: reglas on_draw pueden pintar CUALQUIER cosa en el canvas
  // (imágenes, gradientes, partículas...). Corre detrás de las entidades.
  vm.runDraw(ctx, w, h, getImage);

  for (const e of vm.entities) {
    const pos = e.props.pos as Vec2 | undefined;
    const size = e.props.size as Vec2 | undefined;
    if (!pos || !size) continue;
    const emoji = e.props.emoji as string | undefined;
    if (emoji) {
      const px = Math.max(size.x, size.y);
      ctx.font = `${px}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, pos.x, pos.y);
      ctx.textBaseline = 'alphabetic';
      continue;
    }
    ctx.fillStyle = (e.props.color as string) ?? '#fff';
    if (e.props.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, Math.max(size.x, size.y) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(pos.x - size.x / 2, pos.y - size.y / 2, size.x, size.y);
    }

    // efecto de aparición: anillo que se expande y se desvanece (~0.4s) sobre lo recién spawneado
    const born = e.props.__born as number | undefined;
    if (typeof born === 'number' && born > 0) {
      const age = vm.time - born;
      const DUR = 0.4;
      if (age >= 0 && age < DUR) {
        const t = age / DUR;
        const r0 = Math.max(size.x, size.y) / 2;
        const radius = r0 + t * 26;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 3 * (1 - t) + 1;
        ctx.strokeStyle = (e.props.color as string) ?? '#fff';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // HUD
  ctx.fillStyle = '#fff';
  ctx.font = '20px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Score: ${Math.floor(Number(vm.world.props.score) || 0)}`, 12, 28);

  if (vm.state !== 'playing') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText(vm.state === 'win' ? '¡Ganaste!' : 'Perdiste', w / 2, h / 2 - 10);
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillText('Tocá / tecla para reiniciar', w / 2, h / 2 + 24);
  }
}
