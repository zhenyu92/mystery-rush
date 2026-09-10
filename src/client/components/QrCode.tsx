import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * The join link as a scannable code, rendered as inline SVG.
 *
 * Typing `play.mystery-rush.workers.dev` on a phone in a dim function room,
 * then typing a five-character code, is two chances to get it wrong before
 * anyone has played anything. Pointing a camera at the wall is none.
 *
 * SVG rather than canvas so it stays crisp when a projector scales it up,
 * and so it prints. Error correction is set to M (~15% recoverable), which
 * survives a camera at an angle across a room without inflating the module
 * count the way H would.
 */
export function QrCode({
  value,
  size = 200,
  label,
}: {
  value: string;
  /** Rendered width in px. The SVG scales, so this is a hint, not a raster size. */
  size?: number;
  label?: string;
}) {
  const { path, dimension } = useMemo(() => {
    const qr = qrcode(0, 'M'); // 0 = pick the smallest version that fits
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    // One path for the whole symbol: far fewer DOM nodes than a rect per
    // module, which matters when the projector view re-renders on every tick.
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path: d, dimension: count };
  }, [value]);

  // A quiet zone of 4 modules is required by the spec for reliable scanning.
  const quiet = 4;
  const viewBox = dimension + quiet * 2;

  return (
    <div className="qr">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${viewBox} ${viewBox}`}
        role="img"
        aria-label={label ?? `QR code linking to ${value}`}
        shapeRendering="crispEdges"
      >
        {/* The quiet zone has to be light, so the code carries its own
            background rather than relying on the dark page behind it. */}
        <rect width={viewBox} height={viewBox} fill="#ffffff" rx="1" />
        <g transform={`translate(${quiet} ${quiet})`} fill="#0b0618">
          <path d={path} />
        </g>
      </svg>
      {label ? <div className="qr__label">{label}</div> : null}
    </div>
  );
}
