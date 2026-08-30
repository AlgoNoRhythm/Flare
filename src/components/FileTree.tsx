import { forwardRef, useCallback, useImperativeHandle, useState } from 'react';
import type { FileTreeNode, GitFileState } from '../../shared/types';
import { UI_STATUS } from '../theme';
import { FileGlyph } from './icons';

/**
 * A file-manager glyph per extension family.
 *
 * Everything here is Basic-Multilingual-Plane and predates emoji, so it
 * resolves from an ordinary text face on Windows, macOS and Linux alike. The
 * script and Python marks were U+1D5E7/U+1D5E3 (Mathematical Sans-Serif Bold),
 * which ship in Segoe UI Symbol but are missing from most Linux installs —
 * a whole column of the tree rendered as tofu there. Plain letters now,
 * weighted by CSS.
 *
 * Deliberately monochrome and set in the UI font: the tree's colour budget
 * belongs to git state, not to a rainbow of file types.
 */
const FILE_ICONS: { re: RegExp; icon: string; kind: string }[] = [
  { re: /\.(test|spec)\.[jt]sx?$|_test\.py$|^test_/i, icon: '◉', kind: 'test' },
  { re: /\.(tsx|jsx)$/i, icon: '◇', kind: 'component' },
  { re: /\.(ts|js|mjs|cjs)$/i, icon: 'T', kind: 'script' },
  { re: /\.py$/i, icon: 'P', kind: 'python' },
  { re: /\.(json|ya?ml|toml|ini|env)$/i, icon: '⚙︎', kind: 'config' },
  { re: /\.(md|mdx|txt|rst)$/i, icon: '¶', kind: 'doc' },
  { re: /\.(css|scss|less)$/i, icon: '◧', kind: 'style' },
  { re: /\.(png|jpe?g|gif|svg|ico|webp)$/i, icon: '▨', kind: 'image' },
];

function fileIcon(name: string): { icon: string; kind: string } {
  for (const entry of FILE_ICONS) {
    if (entry.re.test(name)) return { icon: entry.icon, kind: entry.kind };
  }
  return { icon: '▪', kind: 'file' };
}

export const STATE_COLOR: Record<GitFileState, string> = {
  modified: UI_STATUS.warning,
  added: UI_STATUS.good,
  untracked: UI_STATUS.good,
  deleted: UI_STATUS.critical,
  renamed: UI_STATUS.serious,
  conflicted: UI_STATUS.critical,
};

interface Props {
  tree: FileTreeNode;
  gitFiles: Record<string, GitFileState>;
  selected: string | null;
  selectedPaths: ReadonlySet<string>;
  onOpenFile(path: string): void;
  onSelect(path: string): void;
  onToggleSelect(path: string): void;
  onRowContextMenu(payload: { x: number; y: number; path: string; isDir: boolean }): void;
  /** cluster -> colour, from the graph, so top-level folders echo the map */
  clusterColors?: Record<string, string>;
}

/** Lets the explorer header drive the tree without owning every folder's state. */
export interface FileTreeHandle {
  collapseAll(): void;
  expandAll(): void;
  /** open every ancestor of a path so a selection made elsewhere is visible */
  reveal(path: string): void;
}

type RowProps = { node: FileTreeNode; depth: number; openDirs: ReadonlySet<string>; onToggleDir(path: string): void } & Omit<
  Props,
  'tree'
>;

/** Every directory path in the tree, for expand-all. */
function allDirs(node: FileTreeNode, into: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.type === 'dir') {
      into.push(child.path);
      allDirs(child, into);
    }
  }
  return into;
}

/**
 * One fixed-width column per ancestor level, each drawing a hairline guide.
 *
 * Padding alone did not read: the step was smaller than the chevron+icon
 * cluster in front of the name, so a folder's label and its own children's
 * labels landed in nearly the same column. Real columns keep the chevron,
 * icon and name in fixed lanes at every depth, and the guides make the level
 * countable at a glance instead of inferred from a few pixels of offset.
 */
function Indent({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} className="indent" />
      ))}
    </>
  );
}

function DirRow(props: RowProps) {
  const { node, depth, gitFiles, selectedPaths, onToggleSelect, onRowContextMenu, openDirs, onToggleDir, clusterColors } = props;
  const open = openDirs.has(node.path);
  const hasChangedChild = Object.keys(gitFiles).some((p) => p.startsWith(`${node.path}/`));
  /* top-level folders wear their cluster's colour off the graph — the tree
     and the map answering to one vocabulary */
  const clusterColor = depth === 0 ? clusterColors?.[node.name] : undefined;
  return (
    <>
      <div
        className={`row dir-row${selectedPaths.has(node.path) ? ' multi-selected' : ''}`}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) onToggleSelect(node.path);
          else onToggleDir(node.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onRowContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isDir: true });
        }}
        data-testid={`tree-dir-${node.path}`}
      >
        <Indent depth={depth} />
        <span className="chev">{open ? '⌄' : '›'}</span>
        {/* drawn rather than a glyph: a second triangle next to the chevron
            read as two arrows, and emoji folders render differently per OS */}
        <span
          className={`folder${open ? ' open' : ''}`}
          aria-hidden="true"
          style={clusterColor ? ({ '--folder-c': clusterColor } as React.CSSProperties) : undefined}
        />
        <span className="fname">{node.name}</span>
        {!open && hasChangedChild && (
          <span className="dot" style={{ background: UI_STATUS.warning, opacity: 0.7 }} />
        )}
      </div>
      {open &&
        node.children?.map((child) =>
          child.type === 'dir' ? (
            <DirRow key={child.path} {...props} node={child} depth={depth + 1} />
          ) : (
            <FileRow key={child.path} {...props} node={child} depth={depth + 1} />
          ),
        )}
    </>
  );
}

function FileRow(props: RowProps) {
  const { node, depth, gitFiles, selected, selectedPaths, onOpenFile, onSelect, onToggleSelect, onRowContextMenu } = props;
  const state = gitFiles[node.path];
  const icon = fileIcon(node.name);
  const classes = [
    'row',
    selected === node.path ? 'selected' : '',
    selectedPaths.has(node.path) ? 'multi-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) onToggleSelect(node.path);
        else onSelect(node.path);
      }}
      onDoubleClick={() => onOpenFile(node.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onRowContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isDir: false });
      }}
      data-testid={`tree-file-${node.path}`}
      title={node.path}
    >
      <Indent depth={depth} />
      {/* files have no chevron, but they keep its lane so the icons line up */}
      <span className="chev" />
      <span className={`ficon ${icon.kind}`} title={icon.kind}>
        <FileGlyph kind={icon.kind} />
      </span>
      <span className="fname">{node.name}</span>
      {state && <span className="dot" style={{ background: STATE_COLOR[state] }} title={state} />}
    </div>
  );
}

export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(props, ref) {
  const { tree } = props;
  // Owned here rather than per-row: "collapse all" and "reveal this file" are
  // whole-tree operations, and a row cannot answer them from its own state.
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(
    () => new Set((tree.children ?? []).filter((c) => c.type === 'dir').map((c) => c.path)),
  );

  const onToggleDir = useCallback((path: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      collapseAll: () => setOpenDirs(new Set()),
      expandAll: () => setOpenDirs(new Set(allDirs(tree))),
      reveal: (path: string) => {
        const parts = path.split('/').slice(0, -1);
        if (parts.length === 0) return;
        setOpenDirs((prev) => {
          const next = new Set(prev);
          for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/'));
          return next;
        });
      },
    }),
    [tree],
  );

  return (
    <div
      className="filetree"
      data-testid="filetree"
      onContextMenu={(e) => {
        // right-click on empty area: root-level menu
        if (e.target === e.currentTarget) {
          e.preventDefault();
          props.onRowContextMenu({ x: e.clientX, y: e.clientY, path: '', isDir: true });
        }
      }}
    >
      {tree.children?.map((child) =>
        child.type === 'dir' ? (
          <DirRow key={child.path} {...props} node={child} depth={0} openDirs={openDirs} onToggleDir={onToggleDir} />
        ) : (
          <FileRow key={child.path} {...props} node={child} depth={0} openDirs={openDirs} onToggleDir={onToggleDir} />
        ),
      )}
    </div>
  );
});
