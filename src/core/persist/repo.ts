// Track T8 — the project repository on IndexedDB: compare-and-swap saves, one writer per project, snapshots,
// .crochet.json export/import (DESIGN.md §5.5; §5.2.1). Unit tests pass in-memory fakes for the lock manager
// and the channel (src/test/fakes.ts); the app uses navigator.locks and BroadcastChannel.
//
// Step 0 stub. T8 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { CreateProjectRepositoryFn } from '../../types/entryPoints';
import { stub } from '../stub';

export type { ChannelLike, LockManagerLike, ProjectRepository } from '../../types/entryPoints';

export const createProjectRepository = stub<CreateProjectRepositoryFn>('createProjectRepository');
