import { useEffect, useRef } from 'react';

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  color: string;
  shape: 0 | 1;
}

const COLORS = ['#FF3E86', '#8B5CFF', '#35E4FF', '#C8FF4D', '#FFC64B', '#FFFFFF'];

/**
 * Hand-rolled canvas confetti - a few dozen lines beats pulling a library
 * into an app that has to run off a conference-room projector.
 *
 * `run` starts a burst; `continuous` keeps topping it up for the winner
 * screen. Honours prefers-reduced-motion by drawing nothing at all.
 */
export function Confetti({
  run,
  continuous = false,
  count = 160,
}: {
  run: boolean;
  continuous?: boolean;
  count?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!run) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const spawn = (n: number): Piece[] =>
      Array.from({ length: n }, () => ({
        x: Math.random() * width,
        y: -20 - Math.random() * height * 0.45,
        vx: (Math.random() - 0.5) * 2.4,
        vy: 2 + Math.random() * 3.6,
        size: 6 + Math.random() * 8,
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.24,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        shape: Math.random() > 0.45 ? 1 : 0,
      }));

    let pieces = spawn(count);
    let frame = 0;
    let raf = 0;

    const tick = () => {
      frame += 1;
      ctx.clearRect(0, 0, width, height);

      for (const p of pieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.045; // gravity
        p.vx += Math.sin((frame + p.size) * 0.02) * 0.02; // drift
        p.rotation += p.spin;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.shape === 1) {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      pieces = pieces.filter((p) => p.y < height + 40);
      if (continuous && pieces.length < count * 0.55) {
        pieces = pieces.concat(spawn(Math.ceil(count * 0.3)));
      }

      if (pieces.length > 0) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, width, height);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      ctx.clearRect(0, 0, width, height);
    };
  }, [run, continuous, count]);

  if (!run) return null;
  return <canvas ref={canvasRef} className="confetti-canvas" aria-hidden="true" />;
}
