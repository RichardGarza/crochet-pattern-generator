// The limits of the crochet-model schema (DESIGN.md §3.5.2), in a module of their own so that the geometry
// kernels can use them without loading the zod schema.

export const MODEL_LIMITS = {
  maxParts: 60,
  maxPalette: 16,
  maxRegionsPerPart: 24,
  maxFeatures: 60,
  minProfilePoints: 3,
  maxProfilePoints: 64,
  minPolygonPoints: 3,
  maxPolygonPoints: 64,
  /** Every linear dimension of a part, inches. */
  minDimIn: 0.05,
  maxDimIn: 48,
  /** `finishedSize.height`, inches. */
  maxHeightIn: 60,
  maxTextChars: 2000,
  /** The whole document as UTF-8 JSON. */
  maxBytes: 2 * 1024 * 1024,
  /** Objects and arrays nested inside one another, the model object itself being level 1. */
  maxDepth: 12,
} as const;
