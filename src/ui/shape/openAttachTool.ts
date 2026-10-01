// Track T6 — opens the Attach tool for one part from outside the Shape tab: the importer's `attach-inferred` chips
// (T7, §3.7.6, §4.2 Attach). Selects the part, opens the Attach tool for it and shows the Shape tab of the open
// project (DESIGN.md §5.2.1, design v1.5).
//
// Stub added by the Sprint 2 integration (S0 amendment lane). T6 replaces it with the real function and keeps the
// frozen signature (src/types/entryPoints.ts); T7 checks `isImplemented(openAttachTool)` until then.
import { stub } from '../../core/stub';
import type { OpenAttachToolFn } from '../../types/entryPoints';

export const openAttachTool = stub<OpenAttachToolFn>('openAttachTool');
