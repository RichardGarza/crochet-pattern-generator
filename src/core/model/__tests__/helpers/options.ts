// Test helper: the options of the kernel tests that do real geometry work.

/**
 * For suites that do real geometry work (brute-force distances to meshes, overlap grids, whole-model kernels on
 * the teddy): their tests take 0.05–2 s on an idle machine, and other suites share the machine, so they get a
 * generous timeout instead of vitest's 5 s default — a timeout under load is a flake, not a pass. Timing
 * assertions are separate: those tests retry twice and use generous bounds (DESIGN.md §6.1 rule 5).
 */
export const HEAVY = { timeout: 60_000 } as const;
