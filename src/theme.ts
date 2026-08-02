/**
 * Dark-surface palette. Categorical slots (validated for the dark surface,
 * fixed order, never cycled — clusters past 8 fold into neutral) color
 * directory clusters; status colors are reserved for change states.
 */
export const SURFACE = '#16181d';
export const PANEL = '#101216';

export const CATEGORICAL = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
];
export const NEUTRAL_SERIES = '#8a8f98';

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

/**
 * The same four meanings, a step down in saturation, for panels and tables.
 *
 * On the graph a colour *is* the datum — one red card among ninety has to
 * carry across the board. In a details panel or a metrics table the same
 * values arrive dozens at a time next to running text, and full-strength
 * status colours turn a calm surface into a warning light. These match the
 * stylesheet's --good / --warn / --crit tokens exactly, so a value rendered
 * from JS and one styled in CSS are the same colour.
 */
export const UI_STATUS = {
  good: '#63ab7a',
  warning: '#d3a44e',
  serious: '#cf8f68',
  critical: '#d97b7b',
};

export const INK = {
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
};

export const EDGE_COLOR = '#2f3440';
export const EDGE_HIGHLIGHT = '#7b849a';

/** Stable cluster -> color assignment in first-seen order; overflow is neutral. */
export function makeClusterColors(): (cluster: string) => string {
  const assigned = new Map<string, string>();
  return (cluster: string) => {
    let color = assigned.get(cluster);
    if (!color) {
      color = assigned.size < CATEGORICAL.length ? CATEGORICAL[assigned.size] : NEUTRAL_SERIES;
      assigned.set(cluster, color);
    }
    return color;
  };
}

/** Mix two hex colors; t in [0,1] toward `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
