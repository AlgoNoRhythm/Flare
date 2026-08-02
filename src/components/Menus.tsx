import { useEffect, useRef, useState } from 'react';
import { FlareMark } from './FlareMark';

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  separator?: boolean;
  run?(): void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, window.innerHeight - items.length * 30 - 20);
  return (
    <div className="ctx-menu" style={{ left, top }} ref={ref} data-testid="context-menu">
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} className="ctx-sep" />
        ) : (
          <div
            key={item.id}
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            data-testid={`ctx-${item.id}`}
            onClick={() => {
              item.run?.();
              onClose();
            }}
          >
            {item.label}
          </div>
        ),
      )}
    </div>
  );
}

export interface ModalRequest {
  title: string;
  /** show the app mark beside the title — for dialogs that are the app speaking */
  branded?: boolean;
  /** optional pre-formatted body text (rendered pre-wrap, muted) */
  body?: string;
  /** when set, show a text input prefilled with this value */
  input?: { placeholder?: string; initial?: string };
  confirmLabel: string;
  danger?: boolean;
  onConfirm(value: string): void;
}

export function Modal({ request, onClose }: { request: ModalRequest; onClose(): void }) {
  const [value, setValue] = useState(request.input?.initial ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const confirm = () => {
    request.onConfirm(value);
    onClose();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose} data-testid="modal">
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {request.branded && <FlareMark size={22} />}
          {request.title}
        </div>
        {request.body && (
          <div className="muted mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginBottom: 12 }}>
            {request.body}
          </div>
        )}
        {request.input && (
          <input
            ref={inputRef}
            className="modal-input"
            placeholder={request.input.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim() !== '') confirm();
              if (e.key === 'Escape') onClose();
            }}
            data-testid="modal-input"
          />
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${request.danger ? 'danger' : 'primary'}`}
            data-testid="modal-confirm"
            disabled={Boolean(request.input) && value.trim() === ''}
            onClick={confirm}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
