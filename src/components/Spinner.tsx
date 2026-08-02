/**
 * A spinner, for the waits that are genuinely open-ended: reaching a backend
 * over the network, scanning a repository someone just picked. Static text
 * alone reads as a hang, which is how a working app gets closed.
 *
 * It honours `prefers-reduced-motion` by pulsing opacity instead of spinning.
 */
export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <span
      className="spinner"
      role="progressbar"
      aria-label="working"
      data-testid="spinner"
      style={{ width: size, height: size }}
    />
  );
}
