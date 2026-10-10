'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** Command Block: a readout with a $ prompt and a pill copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex w-full items-center gap-3 rounded-2xl border bg-fd-card py-2 ps-5 pe-2 text-left">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-[0.8125rem] sm:text-sm">
        <span aria-hidden="true" className="me-2 select-none text-(--color-caption)">
          $
        </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-fd-secondary px-3.5 py-2 font-mono text-xs font-medium transition-colors duration-150 hover:bg-fd-border"
      >
        {copied ? (
          <Check aria-hidden className="size-3.5 text-(--color-go)" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}
