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
  {
    label: 'Benchmarks',
    href: '/docs/reference/benchmarks',
    title: 'Statistical evals, Pareto frontier and 80/20 root-cause analysis',
    readout: 'npm run eval',
  },
] as const;

const BENCHMARK_MATRIX = [
  {
    scenario: '16-Ticket DAG Throughput',
    id: 'perf-16-ticket-scale',
    naive: '732.0s (1.31/min)',
    bestPractices: '538.9s (1.78/min)',
    agb: '228.5s (4.20/min)',
    delta: '2.36x faster (-310.4s)',
    proof: 'p = 2.0e-18 · r_rb = 1.00',
  },
  {
    scenario: '8-Wide Burst Resilience',
    id: 'perf-8-wide-burst-collapse',
    naive: '68.5s (25.8% timeout)',
    bestPractices: '57.2s (4.2% timeout)',
    agb: '30.8s (0.0% timeout)',
    delta: '1.85x faster (0% drops)',
    proof: 'p = 2.0e-18 · r_rb = 1.00',
  },
  {
    scenario: 'Cross-Model Prosecution',
    id: 'acc-cross-model-prosecution',
    naive: '71.6% escape (28.4% recall)',
    bestPractices: '25.4% escape (74.6% recall)',
    agb: '5.4% escape (94.6% recall)',
    delta: '-20.0 pp escape (4.7x fewer)',
    proof: 'p = 1.2e-19 · OR = 6.22',
  },
  {
    scenario: 'Mechanical Safety Gates',
    id: 'acc-mechanical-safety-gates',
    naive: '31.0% contained (207 breaches)',
    bestPractices: '74.0% contained (78 breaches)',
    agb: '100.0% contained (0 breaches)',
    delta: '+26.0 pp containment',
    proof: 'p = 2.8e-26 · OR = ∞',
  },
] as const;

const PARETO_ARMS = [
  {
    arm: 'Straight agy (Naive)',
    sub: 'Serial / single-pool burst + self-review',
    throughput: '1.31 / min',
    throughputPct: 31,
    recall: '28.4%',
    recallPct: 28.4,
    escape: '71.6% escape',
    safety: '31.0% safety',
    optimal: false,
  },
  {
    arm: 'Raw agy (Best Practices)',
    sub: '/plan + /teamwork + Workspace: share + adversarial-reviewer',
    throughput: '1.78 / min',
    throughputPct: 42,
    recall: '74.6%',
    recallPct: 74.6,
    escape: '25.4% escape',
    safety: '74.0% safety',
    optimal: false,
  },
  {
    arm: 'Antigravity + Booster (agb)',
    sub: '4-pool token buckets + Node DAG scheduler + 4-lens refute + PreToolUse',
    throughput: '4.20 / min',
    throughputPct: 100,
    recall: '94.6%',
    recallPct: 94.6,
    escape: '5.4% escape',
    safety: '100.0% safety',
    optimal: true,
  },
] as const;

const PARETO_LATENCY_CAUSES = [
  {
    cause: 'Dual-bucket 4-pool semaphore routing (Gemini + Claude/GPT)',
    saved: '258.1s',
    share: 51.9,
    cumulative: '51.9%',
    vitalFew: true,
  },
  {
    cause: 'Zero-token Node.js DAG scheduler vs. LLM /teamwork turns',
    saved: '151.4s',
    share: 30.5,
    cumulative: '82.4%',
    vitalFew: true,
  },
  {
    cause: 'Sub-knee pool cap (width <= 4) preventing 120s print timeouts',
    saved: '55.2s',
    share: 11.1,
    cumulative: '93.5%',
    vitalFew: false,
  },
  {
    cause: 'Atomic mkdir merge lock + adlc flail-detector early halt',
    saved: '32.3s',
    share: 6.5,
    cumulative: '100.0%',
    vitalFew: false,
  },
] as const;

const PARETO_DEFECT_CAUSES = [
  {
    cause: 'Cross-family refute prosecutor + 4-lens specialist review fleet',
    caught: '421 / 450',
    share: 52.6,
    cumulative: '52.6%',
    vitalFew: true,
  },
  {
    cause: 'Mechanical PreToolUse hook + adlc rails-guard + scope check',
    caught: '234 / 234',
    share: 29.2,
    cumulative: '81.8%',
    vitalFew: true,
  },
  {
    cause: 'adlc hollow-test AST mutation gate + sandboxed test execution',
    caught: '145 / 216',
    share: 18.2,
    cumulative: '100.0%',
    vitalFew: false,
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
            <Link
              href="/docs/reference/benchmarks"
              className="rounded-full bg-fd-secondary px-5 py-2.5 text-sm font-medium transition-colors duration-150 hover:bg-fd-border"
            >
              Benchmarks &amp; evals
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

      <section aria-labelledby="benchmarks" className="border-b bg-fd-background">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-16">
          <div className="flex flex-col gap-3">
            <p
              id="benchmarks"
              className="font-mono text-xs font-medium tracking-[0.08em] text-(--color-caption) uppercase"
            >
              Empirical telemetry · N = 100 paired Monte Carlo trials (seed 20261030)
            </p>
            <h2 className="text-2xl font-medium tracking-[-0.02em] sm:text-3xl">
              Measured against both Naive agy and Raw agy with Best Practices.
            </h2>
            <p className="max-w-[68ch] text-sm leading-relaxed text-fd-muted-foreground">
              Calibrated against live <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">agy</code>{' '}
              CLI concurrency probes and quota-family buckets. Even when an engineer applies Antigravity&apos;s built-in
              best practices (<code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">/plan</code>,{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">/teamwork</code>,{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">Workspace: &apos;share&apos;</code>,
              and <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">adversarial-reviewer</code>),{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">agb</code> shifts the Pareto
              frontier across throughput, defect escape, and mechanical containment.
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border bg-fd-card">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b bg-fd-muted/60 font-mono text-[0.6875rem] font-medium tracking-[0.06em] text-(--color-caption) uppercase">
                  <th className="px-4 py-3">Scenario</th>
                  <th className="px-4 py-3">Straight agy (Naive)</th>
                  <th className="px-4 py-3">Raw agy (Best Practices)</th>
                  <th className="px-4 py-3">Antigravity + Booster (agb)</th>
                  <th className="px-4 py-3">agb vs. Best Practices</th>
                </tr>
              </thead>
              <tbody className="divide-y font-mono text-xs">
                {BENCHMARK_MATRIX.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="px-4 py-3.5 font-sans text-sm font-medium text-fd-foreground">
                      <div>{row.scenario}</div>
                      <div className="mt-0.5 font-mono text-[0.6875rem] font-normal text-(--color-caption)">
                        {row.id}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-fd-muted-foreground">{row.naive}</td>
                    <td className="px-4 py-3.5 text-fd-muted-foreground">{row.bestPractices}</td>
                    <td className="px-4 py-3.5 font-medium text-fd-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-(--color-go)" />
                        {row.agb}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-fd-foreground">{row.delta}</div>
                      <div className="mt-0.5 text-[0.6875rem] text-(--color-caption)">{row.proof}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col justify-between gap-6 rounded-2xl border bg-fd-card p-6">
              <div className="flex flex-col gap-2">
                <span className="font-mono text-xs font-medium tracking-[0.08em] text-(--color-caption) uppercase">
                  Pareto Frontier · Throughput vs. Defect Recall
                </span>
                <p className="text-xs leading-relaxed text-fd-muted-foreground">
                  Operating on the non-dominated frontier: higher throughput (<code className="font-mono">tickets/min</code>)
                  simultaneously paired with higher pre-merge defect recall and zero rate-limit drops.
                </p>
              </div>
              <div className="flex flex-col gap-5">
                {PARETO_ARMS.map((item) => (
                  <div key={item.arm} className="flex flex-col gap-2 border-t pt-3.5 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`size-2 rounded-full ${item.optimal ? 'bg-(--color-go)' : 'bg-fd-border'}`}
                        />
                        <span className="text-sm font-medium">{item.arm}</span>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <span className="rounded border bg-fd-background px-1.5 py-0.5">{item.throughput}</span>
                        <span className="rounded border bg-fd-background px-1.5 py-0.5">{item.recall} recall</span>
                        <span className="text-(--color-caption)">{item.escape}</span>
                      </div>
                    </div>
                    <p className="font-mono text-[0.6875rem] text-(--color-caption)">{item.sub}</p>
                    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-3 font-mono text-[0.6875rem]">
                      <span className="text-(--color-caption)">Throughput</span>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-fd-muted">
                        <div
                          className={`h-full rounded-full ${item.optimal ? 'bg-(--color-go)' : 'bg-fd-foreground/45'}`}
                          style={{ width: `${item.throughputPct}%` }}
                        />
                      </div>
                      <span className="text-(--color-caption)">Recall</span>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-fd-muted">
                        <div
                          className={`h-full rounded-full ${item.optimal ? 'bg-(--color-go)' : 'bg-fd-foreground/45'}`}
                          style={{ width: `${item.recallPct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col justify-between gap-6 rounded-2xl border bg-fd-card p-6">
              <div className="flex flex-col gap-2">
                <span className="font-mono text-xs font-medium tracking-[0.08em] text-(--color-caption) uppercase">
                  80/20 Root-Cause Pareto · Vital Few Drivers
                </span>
                <p className="text-xs leading-relaxed text-fd-muted-foreground">
                  Two architectural mechanisms account for <code className="font-mono">82.4%</code> of the{' '}
                  <code className="font-mono">497.0s</code> latency reduction and{' '}
                  <code className="font-mono">81.8%</code> of all prevented defects and safety hazards.
                </p>
              </div>

              <div className="flex flex-col gap-4">
                <div className="font-mono text-[0.6875rem] font-medium tracking-[0.06em] text-(--color-caption) uppercase">
                  Latency Savings Attribution (497.0s / 72.4% saved)
                </div>
                <div className="flex flex-col gap-3">
                  {PARETO_LATENCY_CAUSES.map((c) => (
                    <div key={c.cause} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-fd-foreground">{c.cause}</span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-(--color-caption)">
                          {c.saved} · {c.share}% (cum {c.cumulative})
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fd-muted">
                        <div
                          className={`h-full rounded-full ${c.vitalFew ? 'bg-(--color-go)' : 'bg-fd-foreground/45'}`}
                          style={{ width: `${c.share}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-1 border-t pt-3 font-mono text-[0.6875rem] font-medium tracking-[0.06em] text-(--color-caption) uppercase">
                  Defect &amp; Hazard Containment Attribution (800 / 900 caught)
                </div>
                <div className="flex flex-col gap-3">
                  {PARETO_DEFECT_CAUSES.map((c) => (
                    <div key={c.cause} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-fd-foreground">{c.cause}</span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-(--color-caption)">
                          {c.caught} · {c.share}% (cum {c.cumulative})
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fd-muted">
                        <div
                          className={`h-full rounded-full ${c.vitalFew ? 'bg-(--color-go)' : 'bg-fd-foreground/45'}`}
                          style={{ width: `${c.share}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-fd-card px-5 py-3.5 text-xs">
            <div className="flex flex-wrap items-center gap-2 text-fd-muted-foreground">
              <span>Reproduce every distribution, Wilcoxon &amp; Fisher test locally:</span>
              <code className="rounded border bg-fd-muted px-2 py-0.5 font-mono text-fd-foreground">npm run eval</code>
              <code className="rounded border bg-fd-muted px-2 py-0.5 font-mono text-fd-foreground">
                node evals/runner.mjs --json
              </code>
            </div>
            <div className="flex flex-wrap items-center gap-4 font-medium">
              <Link href="/docs/reference/benchmarks" className="text-(--color-link) hover:underline">
                Full statistical evals &amp; Pareto charts →
              </Link>
              <Link href="/docs/reference/calibration" className="text-(--color-link) hover:underline">
                Live CLI calibration probes →
              </Link>
            </div>
          </div>
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
