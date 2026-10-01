// The app's entry (DESIGN.md §6.2 item 3): styles, the theme hint, the router, and <App />.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startRouter } from './app/router';
import { appStore } from './state/appStore';
import { readThemeHint } from './ui/shell/theme';
import './ui/common/tokens.css';
import './ui/common/components.css';
import './ui/shell/shell.css';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');

// The theme the user picked last time (until T8 restores the preferences, which then take over).
const theme = readThemeHint();
if (theme && !appStore.getState().prefsHydrated) appStore.getState().setPrefs({ theme });

startRouter();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
