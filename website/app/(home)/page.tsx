import Link from 'next/link';
import { CopyCommand } from '@/components/copy-command';
import { installCommand } from '@/lib/shared';

/** The run lifecycle as agb executes it (bin/agb.mjs `run`: build → gate → prosecute → merge). */
const SEQUENCE = [
  {
    n: '01',
    stage: 'Plan',
    readout: 'agb plan',
    detail: 'Compile a spec into a ticket DAG, then gate it for overlap and executability.',
  },
  {
    n: '02',
    stage: 'Dispatch',
    readout: 'quota pools',
    detail: 'Schedule tickets deterministically across model pools, inside the caps.',
  },
  {
    n: '03',
    stage: 'Build',
    readout: 'agb/<ticket>',
    detail: 'Each ticket builds in its own worktree, with frozen rails enforced live.',
  },
  {
    n: '04',
    stage: 'Gate',
    readout: 'sandboxed',
    detail: 'Tests and checks run in a network-denied sandbox. Failure stops the ticket.',
  },
  {
    n: '05',
    stage: 'Prosecute',
    readout: 'cross-model',
    detail: 'A different model family tries to break the change before it can merge.',
  },
  {
    n: '06',
    stage: 'Merge',
    readout: 'rebase-first',
    detail: 'Survivors land one at a time, gated again in an integration worktree.',
  },
] as const;

const ROUTES = [
  {
    label: 'Get started',
    href: '/docs/getting-started/installation',
    title: 'Install the plugin and run a first plan',
    readout: 'agy plugin install',
  },
  {
    label: 'Concepts',
    href: '/docs/concepts/overview',
    title: 'How agb keeps a fleet of agents in line',
    readout: 'ADLC P0–P7',
  },
  {
    label: 'Reference',
    href: '/docs/reference/cli',
    title: 'Every command, flag, env var and exit code',
    readout: 'agb --help',
  },
] as const;

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-5xl flex-col items-start gap-8 px-6 pt-20 pb-16 sm:pt-28">
        <p className="font-mono text-xs font-medium tracking-[0.08em] text-(--color-caption) uppercase">
          ADLC orchestration for Google Antigravity
        </p>
        <h1 className="max-w-[16ch] text-[2.5rem] leading-[1.02] font-[450] tracking-[-0.035em] text-balance sm:text-[3.5rem]">
          Mission control for your agent fleet.
        </h1>
        <p className="max-w-[56ch] text-lg leading-relaxed text-fd-muted-foreground">
          agb runs large parallel build-outs on Antigravity without losing control: a deterministic scheduler, frozen
          rails, sandboxed gates and cross-model prosecution between every agent and your main branch.
        </p>
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <CopyCommand command={installCommand} />
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/docs"
              className="rounded-full bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors duration-150 hover:opacity-90"
            >
              Read the docs
            </Link>
            <Link
              href="/docs/getting-started/quickstart"
              className="rounded-full bg-fd-secondary px-5 py-2.5 text-sm font-medium transition-colors duration-150 hover:bg-fd-border"
            >
              Quickstart
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="sequence" className="border-y bg-fd-card">
        <div className="mx-auto w-full max-w-5xl px-6 py-16">
          <h2
            id="sequence"
            className="mb-10 font-mono text-xs font-medium tracking-[0.08em] text-(--color-caption) uppercase"
          >
            Flight sequence · one ticket, start to merge
          </h2>
          <ol className="relative grid gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-6">
            {SEQUENCE.map((s) => (
              <li key={s.n} className="relative flex flex-col gap-3 border-t pt-5">
                <span
                  aria-hidden="true"
                  className={`absolute -top-[5px] left-0 size-[9px] rounded-full border-2 border-fd-card ${s.n === '06' ? 'bg-(--color-go)' : 'bg-fd-foreground'}`}
                />
                <span className="font-mono text-[0.6875rem] text-(--color-caption)">{s.n}</span>
                <span className="text-lg font-medium tracking-[-0.01em]">{s.stage}</span>
                <code className="w-fit rounded-md border bg-fd-background px-1.5 py-0.5 font-mono text-[0.75rem]">
                  {s.readout}
                </code>
                <p className="text-sm leading-relaxed text-fd-muted-foreground">{s.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-label="Where to go next" className="mx-auto w-full max-w-5xl px-6 py-16">
        <ul className="divide-y border-y">
          {ROUTES.map((r) => (
            <li key={r.href}>
              <Link
                href={r.href}
                className="group grid grid-cols-1 items-baseline gap-1 py-6 sm:grid-cols-[10rem_1fr_auto] sm:gap-6"
              >
                <span className="font-mono text-xs font-medium tracking-[0.08em] text-(--color-caption) uppercase">
                  {r.label}
                </span>
                <span className="text-xl font-medium tracking-[-0.012em] transition-colors duration-150 group-hover:text-(--color-link)">
                  {r.title}
                </span>
                <code className="font-mono text-xs text-fd-muted-foreground">{r.readout}</code>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
