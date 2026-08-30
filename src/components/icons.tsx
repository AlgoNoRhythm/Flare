import type { ReactNode } from 'react';

/**
 * The app's own icons, drawn instead of borrowed.
 *
 * These replace a mixed bag of unicode glyphs (⚙︎ ⧉ ⤢ ▣ ↺ …) that rendered
 * as whatever the OS symbol fallback happened to ship — three different
 * weights on three platforms, and none of them matching the UI's stroke.
 * One 16px grid, one 1.5px stroke, currentColor throughout, so an icon
 * inherits exactly the ink of the label it sits beside.
 *
 * Deliberately not here: the brand ◆, which is a mark rather than an icon,
 * and the legend's ▣/▾ fold-state characters, which are text-sized state
 * markers inside running labels (and pinned by tests as text).
 */
function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {children}
    </svg>
  );
}

/** nodes and the edges between them — the graph */
export const IconGraph = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="4" cy="4.5" r="2" />
    <circle cx="12.5" cy="6" r="2" />
    <circle cx="7.5" cy="12.5" r="2" />
    <path d="M5.8 5.6 L10.7 6.7 M6.6 10.7 L4.6 6.4 M9 11.4 L11.5 7.8" />
  </Icon>
);

/** three lanes of a board */
export const IconBoard = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="1.8" y="2.5" width="3.4" height="11" rx="1" />
    <rect x="6.3" y="2.5" width="3.4" height="8" rx="1" />
    <rect x="10.8" y="2.5" width="3.4" height="5.5" rx="1" />
  </Icon>
);

/** the check of a review */
export const IconReview = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M2.8 8.6 L6.4 12.2 L13.2 4.2" />
  </Icon>
);

/** ranked bars — insights */
export const IconInsights = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3.2 13.2 V9.5 M8 13.2 V3.5 M12.8 13.2 V7" />
  </Icon>
);

/** a speech bubble — the channel */
export const IconChannel = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M13.5 9.8 a2 2 0 0 1 -2 2 H7.2 L4 14.5 v-2.7 H4.5 a2 2 0 0 1 -2 -2 V4.5 a2 2 0 0 1 2 -2 h7 a2 2 0 0 1 2 2 Z" />
  </Icon>
);

/** the routine's cog */
export const IconGear = ({ size }: { size?: number }) => (
  <Icon size={size}>
    {/* a large hub and short teeth — long spokes read as an asterisk at 14px */}
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.6 V3.3 M8 12.7 V14.4 M1.6 8 H3.3 M12.7 8 H14.4 M3.5 3.5 L4.7 4.7 M11.3 11.3 L12.5 12.5 M12.5 3.5 L11.3 4.7 M4.7 11.3 L3.5 12.5" />
  </Icon>
);

/** two sheets — copy */
export const IconCopy = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5 V3.3 a1.8 1.8 0 0 0 -1.8 -1.8 H4.3 a1.8 1.8 0 0 0 -1.8 1.8 v4.4 a1.8 1.8 0 0 0 1.8 1.8 H4.5" />
  </Icon>
);

/** out to full size */
export const IconExpand = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M9.5 2.5 H13.5 V6.5 M13.2 2.8 L9 7 M6.5 13.5 H2.5 V9.5 M2.8 13.2 L7 9" />
  </Icon>
);

/** back through time — history */
export const IconHistory = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M2.6 3.2 V6.4 H5.8" />
    <path d="M2.9 6.3 a5.6 5.6 0 1 1 -0.4 2.6" />
    <path d="M8 5.4 V8.3 L10.2 9.8" />
  </Icon>
);

/** run the layout again */
export const IconRelayout = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M13.4 3.2 V6.4 H10.2" />
    <path d="M13.1 6.3 a5.6 5.6 0 1 0 0.4 2.6" />
  </Icon>
);

/** every folder into one card */
export const IconFoldAll = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <rect x="6" y="6" width="4" height="4" rx="0.5" fill="currentColor" stroke="none" />
  </Icon>
);

/** every file its own card */
export const IconUnfoldAll = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M8 5.5 V10.5 M5.5 8 H10.5" />
  </Icon>
);

/**
 * The file-type marks for the explorer tree, replacing a row of unicode
 * letters ('T', 'P', '¶') that carried the type in typography the OS chose.
 * Colour still comes from the .ficon classes — these inherit currentColor.
 */
export function FileGlyph({ kind }: { kind: string }) {
  const size = 11;
  switch (kind) {
    case 'component': // a node on the graph — jsx/tsx renders into the app
      return (
        <Icon size={size}>
          <path d="M8 2.5 L13.5 8 L8 13.5 L2.5 8 Z" />
        </Icon>
      );
    case 'script':
      return (
        <Icon size={size}>
          <path d="M6 4.8 L2.8 8 L6 11.2 M10 4.8 L13.2 8 L10 11.2" />
        </Icon>
      );
    case 'python':
      return (
        <Icon size={size}>
          <circle cx="8" cy="8" r="4.6" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
        </Icon>
      );
    case 'test': // a beaker: something gets checked in here
      return (
        <Icon size={size}>
          <path d="M6.2 2.5 h3.6 M6.8 2.5 V6.2 L3.8 11.9 a1.1 1.1 0 0 0 1 1.6 h6.4 a1.1 1.1 0 0 0 1 -1.6 L9.2 6.2 V2.5" />
        </Icon>
      );
    case 'config': // sliders
      return (
        <Icon size={size}>
          <path d="M2.8 5.2 H13.2 M2.8 10.8 H13.2" />
          <circle cx="6" cy="5.2" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="10" cy="10.8" r="1.5" fill="currentColor" stroke="none" />
        </Icon>
      );
    case 'doc':
      return (
        <Icon size={size}>
          <path d="M3.5 4.4 H12.5 M3.5 8 H12.5 M3.5 11.6 H8.8" />
        </Icon>
      );
    case 'style': // a droplet
      return (
        <Icon size={size}>
          <path d="M8 2.6 C8 2.6 12.2 7.3 12.2 10 a4.2 4.2 0 1 1 -8.4 0 C3.8 7.3 8 2.6 8 2.6 Z" />
        </Icon>
      );
    case 'image':
      return (
        <Icon size={size}>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
          <path d="M4.3 10.6 L7 7.4 L9 9.6 L10.4 8.2 L11.8 10" />
        </Icon>
      );
    default: // a plain page with a folded corner
      return (
        <Icon size={size}>
          <path d="M4.2 2.5 H9 L11.8 5.3 V13.5 H4.2 Z M9 2.5 V5.3 H11.8" />
        </Icon>
      );
  }
}
