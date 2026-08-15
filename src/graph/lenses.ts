import type { GraphNode } from '../../shared/types';
import { CATEGORICAL, INK, STATUS, mixHex, neutralSeries, surface } from '../theme';

export type Lens =
  | 'clusters'
  | 'activity'
  | 'hotspot'
  | 'risk'
  | 'tests'
  | 'coverage'
  | 'instability'
  | 'reuse'
  | 'cycles'
  | 'unread';

/**
 * A lens answers one question about the repo by recolouring it. `reading` is
 * shown under the toolbar so the colours never need to be guessed, and `scale`
 * drives the legend: a single-hue ramp, a set of fixed swatches, or the
 * per-directory chips.
 */
export interface LensDef {
  id: Lens;
  label: string;
  /** tooltip: the question this lens answers */
  hint: string;
  /** one line under the toolbar: how to read the colours right now */
  reading: string;
  scale:
    | { kind: 'clusters' }
    | { kind: 'ramp'; low: string; high: string }
    | { kind: 'swatches'; items: { color: () => string; label: string }[] };
}

export const LENSES: LensDef[] = [
  {
    id: 'clusters',
    label: 'Clusters',
    hint: 'Which directory does each file belong to?',
    reading: 'One colour per top-level directory. Click a folder chip below to fold it into a single card.',
    scale: { kind: 'clusters' },
  },
  {
    id: 'activity',
    label: 'Activity',
    hint: 'What has been touched, and in what order?',
    reading:
      'The session’s changes in order — the brightest file was written last. It stays put once the edits stop, so you can still see what happened an hour later.',
    scale: { kind: 'ramp', low: 'earlier', high: 'latest' },
  },
  {
    id: 'hotspot',
    label: 'Hotspots',
    hint: 'Which files change often AND are hard to change?',
    reading: 'Churn × complexity. Bright files are rewritten constantly and are complex — refactor these first.',
    scale: { kind: 'ramp', low: 'stable', high: 'hotspot' },
  },
  {
    id: 'risk',
    label: 'Risk',
    hint: 'What breaks the most if an agent edits it?',
    reading: 'Dependents × complexity × untested. Bright files carry the most blast radius — review their diffs closely.',
    scale: { kind: 'ramp', low: 'safe', high: 'risky' },
  },
  {
    id: 'tests',
    label: 'Tests',
    hint: 'Which files does a test actually import?',
    reading: 'Green files are reached by a test file; red ones are not covered by any test at all.',
    scale: {
      kind: 'swatches',
      items: [
        { color: () => STATUS.good, label: 'reached by a test' },
        { color: () => STATUS.critical, label: 'no test imports it' },
        { color: () => neutralSeries(), label: 'is a test' },
      ],
    },
  },
  {
    id: 'coverage',
    label: 'Coverage',
    hint: 'How many lines does the test suite execute?',
    reading: 'Line coverage from lcov.info. Dim means most lines never run under the suite.',
    scale: { kind: 'ramp', low: '0%', high: '100%' },
  },
  {
    id: 'instability',
    label: 'Instability',
    hint: 'Is this a leaf or a foundation?',
    reading:
      'fan-out ÷ (fan-in + fan-out). Bright files mostly consume others and are cheap to change; dim ones are foundations everything rests on.',
    scale: { kind: 'ramp', low: 'foundation', high: 'leaf' },
  },
  {
    id: 'reuse',
    label: 'Reuse',
    hint: 'What could be lifted out of here and reused?',
    reading:
      'How cleanly each file would come out as a package. Bright is self-contained logic; dim is welded to the disk, a framework, or the rest of the repo. Unlike Risk and Hotspots this is an absolute scale, not a ranking within this project.',
    scale: { kind: 'ramp', low: 'welded in', high: 'liftable' },
  },
  {
    id: 'unread',
    label: 'Unread',
    hint: 'Which of this code has a human actually looked at?',
    reading:
      'Red files changed this session and no human has opened them since — written by an agent, read by nobody. This is comprehension debt: it compounds quietly and surfaces during an incident.',
    scale: {
      kind: 'swatches',
      items: [
        { color: () => STATUS.critical, label: 'changed, not read' },
        { color: () => STATUS.good, label: 'changed and read' },
        { color: () => mixHex(neutralSeries(), surface(), 0.6), label: 'unchanged this session' },
      ],
    },
  },
  {
    id: 'cycles',
    label: 'Cycles',
    hint: 'Which files import each other in a loop?',
    reading: 'Each import cycle gets its own colour; grey files are cycle-free. Cycles make edits ripple unpredictably.',
    scale: {
      kind: 'swatches',
      items: [
        { color: () => STATUS.critical, label: 'in an import cycle' },
        { color: () => mixHex(neutralSeries(), surface(), 0.6), label: 'acyclic' },
      ],
    },
  },
];

/**
 * Single-hue sequential ramp for the dark surface: near-zero sinks into the
 * surface, high values lift well clear of it.
 *
 * The endpoints are deliberately far apart. Callers feed this a *ranked*
 * value for skewed metrics, so the ramp is spent evenly across the repo and
 * the difference between the top and the middle has to be visible at a
 * glance, on a 4px rail, from across the room.
 */
export function ramp(baseHue: string, value: number): string {
  const v = Math.max(0, Math.min(1, value));
  const low = mixHex(baseHue, surface(), 0.88);
  const high = mixHex(baseHue, INK.primary, 0.2);
  return mixHex(low, high, Math.pow(v, 0.8));
}

/**
 * Which categorical slot each ramp lens borrows.
 *
 * A slot rather than a hex: the colour is whatever the current theme puts in
 * that slot, so a lens keeps its identity across a theme change without the
 * same value being written down twice.
 */
const HUE_SLOT: Partial<Record<Lens, number>> = {
  activity: 1,
  hotspot: 7,
  risk: 3,
  instability: 0,
  coverage: 0,
  reuse: 2,
};

export function lensHue(lens: Lens): string {
  const slot = HUE_SLOT[lens];
  return slot === undefined ? neutralSeries() : CATEGORICAL[slot];
}

/**
 * Review-priority score: how dangerous is an unreviewed change to this file?
 * Load-bearing (many dependents), complex, untested and cycle-entangled files
 * rank first. When real line coverage is known it replaces the test-linkage
 * heuristic.
 */
export function riskScore(node: GraphNode, coveragePct?: number): number {
  const dependents = 1 + Math.log2(1 + node.inDegree);
  const complexity = 1 + node.complexity / 25;
  const untested =
    coveragePct !== undefined
      ? 1 + (1 - Math.min(coveragePct, 100) / 100) * 0.9
      : !node.isTest && node.testedBy === 0
        ? 1.8
        : 1;
  const cycle = node.cycleId !== null ? 1.5 : 1;
  return dependents * complexity * untested * cycle;
}

/** Stable accent per agent for rings/trails; 'you' stays neutral. */
/**
 * Which categorical slot each agent gets, in the order they first appear.
 *
 * The *slot* is what has to be stable, not the hex — an agent that was
 * violet before a theme change should still be the violet one after it.
 */
const AGENT_SLOTS = [6, 2, 4, 0, 3];
const agentAssignments = new Map<string, number>();

export function agentColor(agent: string): string {
  if (agent === 'you' || agent === 'mixed') return neutralSeries();
  let slot = agentAssignments.get(agent);
  if (slot === undefined) {
    slot = AGENT_SLOTS[agentAssignments.size % AGENT_SLOTS.length];
    agentAssignments.set(agent, slot);
  }
  return CATEGORICAL[slot];
}

export { CATEGORICAL, neutralSeries, STATUS };
