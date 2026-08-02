import { useEffect, useState } from 'react';
import { api, type ConnectionState as State } from '../api';
import { FlareMark } from './FlareMark';
import { Spinner } from './Spinner';

/**
 * Whether there is a backend, said out loud.
 *
 * Every call resolves empty while the socket is down, so without this the app
 * renders a perfectly convincing lie: no project, no recents, and "that folder
 * could not be opened" for a path that exists. Open the Vite dev server in a
 * browser and there is no Flare behind it at all — which is worth saying
 * plainly rather than leaving someone to conclude the app hangs.
 *
 * Before the first connection it blocks, because nothing on screen is real
 * yet. After one, it is a banner: the backend kept running, the page just lost
 * touch with it, and everything already loaded is still worth looking at.
 */

/** How long to wait before assuming this is not a slow connection but a wrong one. */
const DIAGNOSE_AFTER_MS = 3500;

export function ConnectionGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(() => api.connection());
  const [everOpen, setEverOpen] = useState(() => api.connection() === 'open');
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const off = api.onConnection(setState);
    // The socket can open between this component's first render and this
    // effect, and a transition that happened before we were listening is one
    // we never hear — which left the gate spinning over a working backend.
    setState(api.connection());
    return off;
  }, []);

  useEffect(() => {
    if (state === 'open') {
      setEverOpen(true);
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), DIAGNOSE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === 'open') return <>{children}</>;

  if (everOpen) {
    return (
      <>
        <div className="conn-banner" role="status" data-testid="connection-banner">
          <Spinner /> Lost the connection to Flare — reconnecting. Your work is on the server and
          is not affected.
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="conn-gate" data-testid="connection-gate">
      <FlareMark size={52} />
      <h1>
        <Spinner size={15} /> Connecting to Flare…
      </h1>
      {slow && (
        <div className="conn-detail" data-testid="connection-detail">
          <p>
            Nothing is answering at <code>{new URL('ws', window.location.href).pathname}</code> on
            this page's origin.
          </p>
          <p>
            If this is the Vite dev server, it serves the interface but has no backend behind it —
            that lives in <code>npm run serve</code>, which prints its own url to open instead.
          </p>
          <p className="conn-quiet">Still retrying, so this clears itself the moment one appears.</p>
        </div>
      )}
    </div>
  );
}
