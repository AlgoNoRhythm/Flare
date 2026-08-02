import { useEffect, useState } from 'react';
import { plural } from '../format';
import type { ShadowSnapshot } from '../../shared/types';
import { api } from '../api';

interface Props {
  /** bump to refetch */
  refreshKey: number;
  onOpenDiff(path: string, source: { hash: string }): void;
  onRestored(): void;
  onClose(): void;
}

export function Timeline({ refreshKey, onOpenDiff, onRestored, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<ShadowSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void api.shadowTimeline(100).then(setSnapshots);
  }, [refreshKey]);

  const sel = snapshots.find((s) => s.hash === selected);

  return (
    <div className="timeline" data-testid="timeline">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <strong style={{ fontSize: 12 }}>Local history</strong>
        <span className="muted">
          {plural(snapshots.length, 'snapshot')} this session — one is taken automatically on every burst of
          changes, and before any delete
        </span>
        <span className="spacer" />
        {sel && !confirming && (
          <button className="btn danger" onClick={() => setConfirming(true)} data-testid="btn-restore-all">
            Restore whole tree to {sel.hash.slice(0, 7)}
          </button>
        )}
        {sel && confirming && (
          <>
            <span style={{ color: '#e66767', fontSize: 12 }}>
              Revert every file to this snapshot? A new snapshot is taken first, so this is undoable.
            </span>
            <button
              className="btn danger"
              data-testid="btn-restore-confirm"
              onClick={() => {
                setConfirming(false);
                void api.shadowRestoreAll(sel.hash).then(() => onRestored());
              }}
            >
              Yes, restore
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        )}
        <button className="btn" onClick={onClose}>
          ✕
        </button>
      </div>
      {snapshots.length === 0 && <div className="muted">no snapshots yet — edit some files</div>}
      {snapshots.map((snap) => (
        <div
          key={snap.hash}
          className={`snap-row${selected === snap.hash ? ' selected' : ''}`}
          onClick={() => {
            setSelected(snap.hash === selected ? null : snap.hash);
            setConfirming(false);
          }}
          data-testid={`snap-${snap.hash.slice(0, 7)}`}
        >
          <span className="time">{new Date(snap.time).toLocaleTimeString()}</span>
          <span className="mono muted">{snap.hash.slice(0, 7)}</span>
          <span className="files">{snap.message}</span>
          <span className="muted" title="Files captured in this snapshot — the whole tracked tree, not just what changed">
            {plural(snap.files.length, 'file')} captured
          </span>
          {selected === snap.hash &&
            snap.files.slice(0, 6).map((f) => (
              <a
                key={f}
                className="deplink mono"
                style={{ display: 'inline', fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDiff(f, { hash: snap.hash });
                }}
              >
                {f.split('/').pop()}
              </a>
            ))}
        </div>
      ))}
    </div>
  );
}
