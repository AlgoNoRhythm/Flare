/** Shared data model used by main process, renderer and tests. */

export type Lang = 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'other';

export type SymbolKind = 'function' | 'class' | 'variable' | 'type';

export interface SymbolInfo {
  name: string;
  /** 1-based line of the declaration. */
  line: number;
  kind: SymbolKind;
  exported: boolean;
}

export interface ImportDecl {
  /** Raw specifier (unresolved). */
  spec: string;
  /** Imported binding name -> reference count in this file (outside the import itself). */
  bindings: Record<string, number>;
  /**
   * Python `from X import name` also emits a speculative `X.name` decl in case
   * `name` is a submodule; unresolved speculative decls are not "external".
   */
  speculative?: boolean;
}

export interface ParsedFile {
  /** Project-relative path, forward slashes. */
  path: string;
  lang: Lang;
  imports: ImportDecl[];
  /** Top-level symbols (functions, classes, consts) with location info. */
  symbols: SymbolInfo[];
  loc: number;
  /** Branch-keyword complexity approximation. */
  complexity: number;
  /** TODO/FIXME/HACK/XXX marker count. */
  todos: number;
}

export interface GraphNode {
  id: string; // project-relative path
  lang: Lang;
  loc: number;
  complexity: number;
  symbols: SymbolInfo[];
  /** Top-level directory used for cluster coloring ('' for root files). */
  cluster: string;
  inDegree: number;
  outDegree: number;
  /** Unresolved import specifiers — packages, not project files. Sorted. */
  externalModules: string[];
  /** Number of test files importing this file. */
  testedBy: number;
  /** Looks like a test file itself. */
  isTest: boolean;
  /** Non-test file that nothing imports and that isn't an obvious entry point. */
  orphan: boolean;
  /** Strongly-connected-component id when part of an import cycle, else null. */
  cycleId: number | null;
  /** TODO/FIXME/HACK/XXX marker count. */
  todos: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Coupling strength: referenced-binding count (min 1). */
  weight: number;
}

export interface CodeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: number;
}

export interface GraphPatch {
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodeIds: string[];
  addedEdges: GraphEdge[];
  /** Same endpoints, new weight. */
  updatedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
}

export interface FileTreeNode {
  name: string;
  path: string; // project-relative
  type: 'dir' | 'file';
  children?: FileTreeNode[];
}

export type GitFileState = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflicted';

export interface GitStatus {
  branch: string;
  /** Map of project-relative path -> state. */
  files: Record<string, GitFileState>;
  isRepo: boolean;
}

export interface ShadowSnapshot {
  hash: string;
  time: number; // epoch ms
  files: string[]; // files changed in this snapshot
  message: string;
}

export interface ChangeEvent {
  /** Paths changed on disk (project-relative). */
  changed: string[];
  removed: string[];
  time: number;
  /** Detected author of this change burst: agent name, 'you', or 'mixed'. */
  agent: string;
}

/** Per-file symbol-level structure for drill-down. */
export interface SymbolGraph {
  path: string;
  symbols: (SymbolInfo & { loc: number })[];
  /** References between top-level symbols of this file. */
  intraEdges: { from: string; to: string; weight: number }[];
  /** Other files referencing specific symbols of this file. */
  inbound: { importer: string; symbol: string; weight: number }[];
}

/** A shell command observed running inside one of the app's terminals. */
export interface CommandLogEntry {
  pid: number;
  terminalId: string;
  command: string;
  time: number;
  agent: string | null;
  /** What the command does — see shared/commands.ts. Absent on old log lines. */
  kind?: import('./commands').CommandKind;
  /** Epoch ms at which the process disappeared; absent while still running. */
  endedAt?: number;
  /** For verification commands: what its output said. */
  outcome?: import('./commands').CommandOutcome;
  /** The output line the outcome was read from, so the claim is checkable. */
  evidence?: string | null;
}

export interface AgentStatus {
  /** terminal id -> detected agent name (e.g. 'claude'), if any. */
  terminals: Record<string, string | null>;
}

export interface ReviewState {
  /** path -> epoch ms at which it was approved. */
  approvedAt: Record<string, number>;
  /** Time of last global checkpoint ("mark all reviewed"). */
  checkpointAt: number;
  /**
   * path -> epoch ms at which a human actually opened the file in the editor.
   * Approving is a claim; opening is evidence. Used for the comprehension-debt
   * lens: which of this code has any human ever laid eyes on?
   */
  readAt?: Record<string, number>;
}

export interface NodeDetails {
  node: GraphNode;
  dependents: string[]; // direct
  dependencies: string[]; // direct
  blastRadius: number; // transitive dependents count
}

export interface ProjectInfo {
  root: string;
  name: string;
  fileTree: FileTreeNode;
  graph: CodeGraph;
  git: GitStatus;
}
