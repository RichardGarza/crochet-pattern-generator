// Small decorative illustrations: a stitched heart chart (2D) and a little amigurumi (3D). Drawn with the
// theme tokens, so they follow light and dark.

const HEART = ['..XX..XX..', '.XXXXXXXX.', '.XOOXXXXX.', '.XOXXXXXX.', '..XXXXXX..', '...XXXX...', '....XX....'];

export function HeartChartArt({ cell = 13, gap = 2 }: { cell?: number; gap?: number }) {
  const cols = HEART[0].length;
  const rows = HEART.length;
  const w = cols * (cell + gap) - gap;
  const h = rows * (cell + gap) - gap;
  return (
    <svg className="shell-art shell-art--chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {HEART.flatMap((row, r) =>
        [...row].map((c, k) => (
          <rect
            key={`${r}-${k}`}
            x={k * (cell + gap)}
            y={r * (cell + gap)}
            width={cell}
            height={cell}
            rx={2.5}
            className={c === 'X' ? 'shell-art__on' : 'shell-art__light'}
          />
        )).filter((_, k) => row[k] !== '.'),
      )}
    </svg>
  );
}

export function ToyArt({ size = 64 }: { size?: number }) {
  return (
    <svg className="shell-art shell-art--toy" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <ellipse cx="32" cy="58" rx="18" ry="3" className="shell-art__shadow" />
      <circle cx="18" cy="14" r="6.5" className="shell-art__on" />
      <circle cx="46" cy="14" r="6.5" className="shell-art__on" />
      <circle cx="18" cy="14" r="3" className="shell-art__light" />
      <circle cx="46" cy="14" r="3" className="shell-art__light" />
      <ellipse cx="32" cy="44" rx="15" ry="13" className="shell-art__on" />
      <circle cx="32" cy="25" r="14" className="shell-art__on" />
      <ellipse cx="32" cy="30" rx="6" ry="4.5" className="shell-art__light" />
      <circle cx="26.5" cy="23" r="1.8" className="shell-art__eye" />
      <circle cx="37.5" cy="23" r="1.8" className="shell-art__eye" />
      <path d="M17 26.5c5 1 25 1 30 0" className="shell-art__rows" />
      <path d="M18.5 31.5c4.5 1.2 22.5 1.2 27 0" className="shell-art__rows" />
      <path d="M18.5 18.5c4.5-1.2 22.5-1.2 27 0" className="shell-art__rows" />
    </svg>
  );
}
