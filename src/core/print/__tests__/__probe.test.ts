import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectPdf } from './pdfInspect';
it('probe', () => {
  const info = inspectPdf(new Uint8Array(readFileSync('/private/tmp/claude-501/-Users-garzamacbookair/b4c6bc88-49ea-46c3-bc38-814bcd3190ae/scratchpad/t8/g9.pdf')));
  writeFileSync('/private/tmp/claude-501/-Users-garzamacbookair/b4c6bc88-49ea-46c3-bc38-814bcd3190ae/scratchpad/t8/probe.json', JSON.stringify({ header: info.header, count: info.count, outline: info.outline, pages: info.pages.map(p => ({ mb: p.mediaBox, links: p.links, text: p.text.slice(0, 400) })) }, null, 1));
});
