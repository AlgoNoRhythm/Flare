import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * VS Code-style application menu. Click a title to open it, then hover across
 * the bar to switch menus; arrow keys walk the entries, Escape closes. One
 * level of submenus (recent projects, lenses) opens as a flyout.
 */

export interface MenuEntry {
  id: string;
  label?: string;
  /** right-aligned shortcut or note */
  hint?: string;
  separator?: boolean;
  /** shows a ✓ — use for toggles and radio groups */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  submenu?: MenuEntry[];
  run?(): void;
}

export interface MenuDef {
  id: string;
  label: string;
  entries: MenuEntry[];
}

interface Props {
  menus: MenuDef[];
}

function isSelectable(entry: MenuEntry): boolean {
  return !entry.separator && !entry.disabled;
}

/**
 * Drop separators left stranded by a removed entry.
 *
 * Menus are written as one list and then filtered — a browser tab has no
 * window buttons and no file manager to reveal into — which otherwise leaves
 * a rule at the top, at the bottom, or two in a row.
 */
export function tidySeparators(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}

export function MenuBar({ menus }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpenId(null);
    setActiveIdx(-1);
    setOpenSub(null);
  }, []);

  useEffect(() => {
    if (openId === null) return;
    const down = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [openId, close]);

  const current = menus.find((m) => m.id === openId) ?? null;

  const step = (dir: 1 | -1) => {
    if (!current) return;
    const n = current.entries.length;
    let idx = activeIdx;
    for (let i = 0; i < n; i++) {
      idx = (idx + dir + n) % n;
      if (isSelectable(current.entries[idx])) break;
    }
    setActiveIdx(idx);
    setOpenSub(null);
  };

  const switchMenu = (dir: 1 | -1) => {
    if (!current) return;
    const i = menus.findIndex((m) => m.id === current.id);
    const next = menus[(i + dir + menus.length) % menus.length];
    setOpenId(next.id);
    setActiveIdx(-1);
    setOpenSub(null);
  };

  const activate = (entry: MenuEntry) => {
    if (entry.disabled || entry.separator) return;
    if (entry.submenu) {
      setOpenSub((s) => (s === entry.id ? null : entry.id));
      return;
    }
    entry.run?.();
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!current) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const entry = current.entries[activeIdx];
      if (entry?.submenu) setOpenSub(entry.id);
      else switchMenu(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (openSub) setOpenSub(null);
      else switchMenu(-1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      const entry = current.entries[activeIdx];
      if (entry) {
        e.preventDefault();
        activate(entry);
      }
    }
  };

  const renderEntries = (entries: MenuEntry[], depth: number) =>
    entries.map((entry, i) =>
      entry.separator ? (
        <div key={entry.id} className="ctx-sep" />
      ) : (
        <div
          key={entry.id}
          className={[
            'menu-item',
            entry.disabled ? 'disabled' : '',
            entry.danger ? 'danger' : '',
            depth === 0 && i === activeIdx ? 'active' : '',
            entry.submenu ? 'has-sub' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid={`menu-item-${entry.id}`}
          onMouseEnter={() => {
            if (depth === 0) {
              setActiveIdx(i);
              setOpenSub(entry.submenu ? entry.id : null);
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            activate(entry);
          }}
        >
          <span className="menu-check">{entry.checked ? '✓' : ''}</span>
          <span className="menu-label">{entry.label}</span>
          {entry.hint && <span className="menu-hint">{entry.hint}</span>}
          {entry.submenu && <span className="menu-arrow">›</span>}
          {entry.submenu && openSub === entry.id && depth === 0 && (
            <div className="menu-dropdown submenu">{renderEntries(entry.submenu, 1)}</div>
          )}
        </div>
      ),
    );

  return (
    <div className="menubar" ref={rootRef} onKeyDown={onKeyDown} tabIndex={-1} data-testid="menubar">
      {menus.map((menu) => (
        <div key={menu.id} className="menubar-slot">
          <button
            className={`menubar-title${openId === menu.id ? ' open' : ''}`}
            data-testid={`menu-${menu.id}`}
            onClick={() => {
              setOpenId((cur) => (cur === menu.id ? null : menu.id));
              setActiveIdx(-1);
              setOpenSub(null);
              rootRef.current?.focus();
            }}
            onMouseEnter={() => {
              // once one menu is open, hovering the bar switches between them
              if (openId !== null && openId !== menu.id) {
                setOpenId(menu.id);
                setActiveIdx(-1);
                setOpenSub(null);
              }
            }}
          >
            {menu.label}
          </button>
          {openId === menu.id && (
            <div className="menu-dropdown" data-testid={`menu-panel-${menu.id}`}>
              {renderEntries(menu.entries, 0)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
