import { useCallback, useRef, useState } from 'react';

interface Props {
  direction: 'horizontal' | 'vertical';
  /** Called with the pointer's client coordinate along the drag axis. */
  onDrag(clientPos: number): void;
}

/** Thin draggable divider; parent owns the sizes. */
export function Splitter({ direction, onDrag }: Props) {
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const move = (ev: PointerEvent) => {
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          onDrag(direction === 'horizontal' ? ev.clientX : ev.clientY);
        });
      };
      const up = () => {
        setDragging(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [direction, onDrag],
  );

  return (
    <div
      className={`${direction === 'horizontal' ? 'splitter-h' : 'splitter-v'}${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
    />
  );
}
