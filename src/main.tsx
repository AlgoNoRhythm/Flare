import { createRoot } from 'react-dom/client';
// the stylesheet first: everything below reads its colours out of the tokens,
// and in dev the sheet is injected by this import rather than linked in the
// head, so importing it later means reading a palette that is not there yet
import './styles.css';
import './monacoSetup';
import { App } from './App';
import { ConnectionGate } from './components/ConnectionState';
import { applyTheme, storedChoice, watchSystemTheme } from './theme';

/*
 * Tag the document with the host platform so the stylesheet can answer the few
 * questions that genuinely differ between them — how text is rasterised, how
 * much room the window controls need — without every component asking.
 */
const platform = navigator.platform.toUpperCase();
document.documentElement.dataset.os = platform.includes('MAC')
  ? 'mac'
  : platform.includes('WIN')
    ? 'windows'
    : 'linux';

/*
 * The inline script in index.html has already set the attribute, so nothing
 * flashes. This is the other half: pulling the palette into the modules that
 * draw outside CSS, before the first render rather than after it.
 */
applyTheme(storedChoice());
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <ConnectionGate>
    <App />
  </ConnectionGate>,
);
