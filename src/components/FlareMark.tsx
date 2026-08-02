/**
 * The app mark: a node with edges departing, curved so the graph reads as a
 * flare.
 *
 * The geometry is the same curves the installer icon is drawn from — derived
 * from the parameters in scripts/make-icon.mjs rather than redrawn by eye, so
 * the thing in the window and the thing in the taskbar cannot drift apart.
 */
export function FlareMark({ size = 46 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className="flare-mark"
    >
      <defs>
        <linearGradient id="flare-ray" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffd9a0" />
          <stop offset="55%" stopColor="#e8a33f" />
          <stop offset="100%" stopColor="#c2603a" />
        </linearGradient>
        <radialGradient id="flare-bloom" cx="0.295" cy="0.575" r="0.55">
          <stop offset="0%" stopColor="#e8a33f" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#e8a33f" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0.5" y="0.5" width="47" height="47" rx="11.5" fill="#161b26" stroke="#2d3543" />
      <rect x="1" y="1" width="46" height="46" rx="11" fill="url(#flare-bloom)" />

      <g stroke="url(#flare-ray)" strokeLinecap="round" fill="none">
        <path d="M14.9 25.32 C19.22 20.57 24.14 15.67 19.32 11.71" strokeWidth="1.11" />
        <path d="M15.94 25.99 C23.78 22.17 32.29 18.38 31.95 11.58" strokeWidth="1.28" />
        <path d="M16.49 27.02 C26.08 26.81 36.28 26.87 40.09 21.13" strokeWidth="1.17" />
        <path d="M16.49 28.18 C22.85 31.65 29.52 35.57 33.61 32.45" strokeWidth="0.95" />
      </g>

      <circle cx="19.32" cy="11.71" r="1.05" fill="#f2c877" />
      <circle cx="40.09" cy="21.13" r="1.05" fill="#f2c877" />

      <circle cx="14.16" cy="27.6" r="2.78" fill="#e09434" />
      <circle cx="14.16" cy="27.6" r="1.67" fill="#fffaf0" />
    </svg>
  );
}
