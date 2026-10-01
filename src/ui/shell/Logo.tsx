// The app mark: a ball of yarn in the accent color, with the wordmark.
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="shell-logo__mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="15" cy="15" r="12" fill="var(--color-accent)" />
      <g fill="none" stroke="var(--color-on-accent)" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round">
        <path d="M6.2 7.6c4.6 2.6 8.6 8.5 8.6 19.3" />
        <path d="M3.4 13.6c6.2.2 13.8 4.1 17.2 11.9" />
        <path d="M11 3.6c5.9 1.7 12.4 7.3 14.7 14.4" />
      </g>
      <path d="M24 22.5c2 2.6 3.6 4.4 5.6 5.4" fill="none" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="shell-logo">
      <LogoMark size={compact ? 26 : 30} />
      <span className="shell-logo__text">
        Crochet <span className="shell-logo__text-light">Pattern Generator</span>
      </span>
    </span>
  );
}
