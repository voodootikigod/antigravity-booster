import type { SVGProps } from 'react';

/** agb mark: a booster stage (stacked chevrons) inside a guidance ring. Own glyph, not a Google mark. */
export function AgbMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="10.25" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
      <path
        d="M7.5 13.25 12 8.75l4.5 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 17 12 12.5l4.5 4.5"
        stroke="var(--color-go)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <AgbMark className="size-6" />
      <span className="font-medium tracking-[-0.01em]">antigravity-booster</span>
    </span>
  );
}

/** Telemetry strip: the release readout above every page. check-site (e) asserts its text. */
export function TelemetryStrip({ version }: { version: string }) {
  return (
    <div className="bg-(--color-telemetry) text-(--color-telemetry-ink)">
      <p className="mx-auto flex min-h-8 max-w-(--fd-layout-width) items-center justify-center gap-2 px-4 py-1.5 text-center font-mono text-[0.625rem] font-medium tracking-[0.04em] text-balance sm:text-[0.6875rem] sm:tracking-[0.06em]">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-(--color-go)" />
        {`These docs track main. Latest release: v${version}.`}
      </p>
    </div>
  );
}
