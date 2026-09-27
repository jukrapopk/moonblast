/**
 * The Moonblast mark as an inline `<svg>` that paints with `currentColor`, so
 * callers tint it via text color. Inline (not an `<img>`) so the tiny
 * transparent overlay windows don't carry an extra image layer.
 */
export function MoonblastMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1000 1000"
      className={className}
      aria-hidden="true"
      style={{
        fillRule: "evenodd",
        clipRule: "evenodd",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeMiterlimit: 1.5,
      }}
    >
      <g transform="matrix(1.26435,0,0,1.26435,-132.175,-132.175)">
        <circle cx="500" cy="500" r="172.756" fill="currentColor" />
      </g>
      <g transform="matrix(2.43731,0,0,2.43731,-718.656,-718.656)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke="currentColor"
          strokeWidth="56.35"
        />
      </g>
      <g transform="matrix(-2.43731,0,0,2.43731,1718.66,-718.656)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke="currentColor"
          strokeWidth="56.35"
        />
      </g>
      <g transform="matrix(-2.43731,2.98485e-16,-2.98485e-16,-2.43731,1718.66,1718.7)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke="currentColor"
          strokeWidth="56.35"
        />
      </g>
      <g transform="matrix(2.43731,-2.98485e-16,-2.98485e-16,-2.43731,-718.656,1718.7)">
        <path
          d="M500,327.244C580.348,327.244 647.958,382.215 667.241,456.568"
          fill="none"
          stroke="currentColor"
          strokeWidth="56.35"
        />
      </g>
    </svg>
  );
}
