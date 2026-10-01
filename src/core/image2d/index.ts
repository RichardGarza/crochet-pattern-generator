// core/image2d — 2D image ingest, image kind, background and sampling (DESIGN.md §2.3). Track T1.
// `runChart` (run.ts) is the §5.2.1 entry point; it stays a stub until T1.4 wires the stages together.
export * from './background';
export * from './crop';
export * from './kind';
export * from './labels';
export * from './linear';
export * from './sample';
export type * from './types';
