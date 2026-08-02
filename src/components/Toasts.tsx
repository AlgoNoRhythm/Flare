import { useEffect, useState } from 'react';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'warn';
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l([...toasts]);
}

export function toast(message: string, kind: Toast['kind'] = 'info'): void {
  const t: Toast = { id: nextId++, message, kind };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 3600);
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (list.length === 0) return null;
  return (
    <div className="toasts" data-testid="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
