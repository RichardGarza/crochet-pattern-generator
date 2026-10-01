// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).

/** One validation finding (§2.13). `code` is an `E_*` / `W_*` rule id; exports are blocked on errors. */
export interface Issue {
  code: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  /** `view` = `PhotoView.id` (photo masks and alignment, §2.9.1–2.9.2). */
  where?: { piece?: string; line?: number; row?: number; col?: number; part?: string; view?: string };
}
