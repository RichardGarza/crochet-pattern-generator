import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Step 0a placeholder. Step 0b replaces this file with the real entry (App.tsx, hash router, tab registry).
const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');

createRoot(container).render(
  <StrictMode>
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Crochet Pattern Generator</h1>
      <p>The toolchain, shared types and base kernels are in place. The app shell is not built yet.</p>
    </main>
  </StrictMode>,
);
