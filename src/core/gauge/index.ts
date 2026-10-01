// Gauge and sizing kernels (DESIGN.md §2.2, §2.3.3, §2.8). Step 0 kernel: pure TypeScript, no DOM.
//
//   tables         Tables A, B, E, the CYC ranges and the hook tables, with their uncertainty bands
//   resolve        GaugeSpec → ResolvedGauge, and the sanity warnings on a measured gauge
//   grid           finished size → columns × rows (independent axes), border rounds, snapping
//   sphere         amigurumi ball: diameter ↔ stitches of the widest round
//   yarnPerStitch  Table D model: yarn per stitch, carried strands, tails, buffer, band, skeins
//   round          the rounding rule all of them share
export * from './grid';
export * from './resolve';
export * from './round';
export * from './sphere';
export * from './tables';
export * from './yarnPerStitch';
