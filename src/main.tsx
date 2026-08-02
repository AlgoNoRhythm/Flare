import { createRoot } from 'react-dom/client';
import './monacoSetup';
import './styles.css';
import { App } from './App';
import { ConnectionGate } from './components/ConnectionState';

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

createRoot(document.getElementById('root')!).render(
  <ConnectionGate>
    <App />
  </ConnectionGate>,
);
