/**
 * The app's brand mark: an amber cog with an "F" in negative space. Original artwork
 * (also served as /favicon.svg). Inlined as SVG so it stays crisp at any size and needs
 * no extra request.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Factorio Stack Manager">
      <path
        fill="#f4a338"
        fillRule="evenodd"
        d="M86.66,42.11L96.67,44.48L96.67,55.52L86.66,57.89L81.50,70.34L86.91,79.10L79.10,86.91L70.34,81.50L57.89,86.66L55.52,96.67L44.48,96.67L42.11,86.66L29.66,81.50L20.90,86.91L13.09,79.10L18.50,70.34L13.34,57.89L3.33,55.52L3.33,44.48L13.34,42.11L18.50,29.66L13.09,20.90L20.90,13.09L29.66,18.50L42.11,13.34L44.48,3.33L55.52,3.33L57.89,13.34L70.34,18.50L79.10,13.09L86.91,20.90L81.50,29.66ZM36.00,30.00L65.00,30.00L65.00,39.00L48.00,39.00L48.00,47.00L59.00,47.00L59.00,56.00L48.00,56.00L48.00,70.00L36.00,70.00Z"
      />
    </svg>
  );
}
