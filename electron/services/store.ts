import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewState } from '../../shared/types';
import { emptyBoard, normalizeBoard, type Board } from '../../shared/tasks';

export interface UiState {
  tabs?: { kind: 'file' | 'diff'; path: string }[];
  activeTab?: string;
  lens?: string;
  graphView?: string;
  sidebarWidth?: number;
  terminalHeight?: number;
  detailsWidth?: number;
  /** the pointer drags to select rather than to pan */
  selectMode?: boolean;
  /** the folder chips are put away */
  legendCollapsed?: boolean;
}

export interface ProjectState {
  positions: Record<string, { x: number; y: number }>;
  review: ReviewState;
  /** Collapsed top-level dirs; null = user never chose (default: all collapsed). */
  collapsedDirs: string[] | null;
  ui: UiState;
  /** the task board — lanes and the work queued against them */
  board: Board;
}

const EMPTY_STATE: ProjectState = {
  positions: {},
  review: { approvedAt: {}, checkpointAt: 0, readAt: {} },
  collapsedDirs: null,
  ui: {},
  board: emptyBoard(),
};

/** Per-project persisted UI state (node positions, review approvals). */
export class ProjectStore {
  private file: string;
  private state: ProjectState;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(projectRoot: string, storageRoot: string) {
    const hash = crypto.createHash('sha1').update(projectRoot.toLowerCase()).digest('hex').slice(0, 16);
    const dir = path.join(storageRoot, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${hash}.json`);
    this.state = this.load();
  }

  private load(): ProjectState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ProjectState>;
      return {
        positions: raw.positions ?? {},
        review: {
          approvedAt: raw.review?.approvedAt ?? {},
          checkpointAt: raw.review?.checkpointAt ?? 0,
          readAt: raw.review?.readAt ?? {},
        },
        collapsedDirs: raw.collapsedDirs ?? null,
        ui: raw.ui ?? {},
        // state files written before the board — or before decisions, questions
        // and the routine were part of it — are filled in rather than discarded
        board: normalizeBoard(raw.board),
      };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  get positions(): Record<string, { x: number; y: number }> {
    return this.state.positions;
  }

  get review(): ReviewState {
    return this.state.review;
  }

  setPositions(positions: Record<string, { x: number; y: number }>): void {
    this.state.positions = positions;
    this.scheduleSave();
  }

  mergePositions(positions: Record<string, { x: number; y: number }>): void {
    Object.assign(this.state.positions, positions);
    this.scheduleSave();
  }

  get collapsedDirs(): string[] | null {
    return this.state.collapsedDirs;
  }

  get ui(): UiState {
    return this.state.ui;
  }

  get board(): Board {
    return this.state.board;
  }

  setBoard(board: Board): void {
    this.state.board = board;
    this.scheduleSave();
  }

  setUi(ui: UiState): void {
    this.state.ui = ui;
    this.scheduleSave();
  }

  setCollapsedDirs(dirs: string[]): void {
    this.state.collapsedDirs = dirs;
    this.scheduleSave();
  }

  approve(paths: string[], at = Date.now()): void {
    for (const p of paths) this.state.review.approvedAt[p] = at;
    this.scheduleSave();
  }

  /** Record that a human actually opened these files. */
  markRead(paths: string[], at = Date.now()): void {
    if (!this.state.review.readAt) this.state.review.readAt = {};
    for (const p of paths) this.state.review.readAt[p] = at;
    this.scheduleSave();
  }

  checkpoint(at = Date.now()): void {
    this.state.review.checkpointAt = at;
    this.state.review.approvedAt = {};
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch {
      // best-effort persistence
    }
  }
}
