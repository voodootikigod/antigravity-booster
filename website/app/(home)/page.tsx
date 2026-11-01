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
    title: 'How agb compares to default and best-practices Antigravity setups',
    readout: 'npm run eval',
  },
] as const;

const BENCHMARK_MATRIX = [
  {
    scenario: '16-ticket feature build',
    subtitle: 'Parallel DAG from spec to main',
    defaultAgy: '12m 12s (1.31/min)',
    bestPractices: '8m 59s (1.78/min)',
    agb: '3m 49s (4.20/min)',
    delta: '2.36x faster',
    detail: 'Saves ~5m 10s per run',
  },
  {
    scenario: '8-agent parallel burst',
    subtitle: 'Concurrent dispatch under quota limits',
    defaultAgy: '68.5s (25.8% timeouts)',
    bestPractices: '57.2s (4.2% timeouts)',
    agb: '30.8s (0% timeouts)',
    delta: '1.85x faster',
    detail: 'Zero rate-limit drops',
  },
  {
    scenario: 'Pre-merge bug detection',
    subtitle: '500 seeded bugs across 5 categories',
    defaultAgy: '28.4% caught (71.6% escape)',
    bestPractices: '74.6% caught (25.4% escape)',
    agb: '94.6% caught (5.4% escape)',
    delta: '4.7x fewer escaped bugs',
    detail: '-20.0 percentage points',
  },
  {
    scenario: 'Protected-file & scope safety',
    subtitle: '300 attempts to touch frozen files or skip tests',
    defaultAgy: '31.0% blocked (207 breaches)',
    bestPractices: '74.0% blocked (78 breaches)',
    agb: '100% blocked (0 breaches)',
    delta: 'Zero rail breaches',
    detail: 'Enforced by hooks, not prompts',
  },
] as const;

const PARETO_ARMS = [
  {
    arm: 'Default agy',
    sub: 'Single session or unthrottled burst, self-review',
    throughput: '1.31 / min',
    throughputPct: 31,
    recall: '28.4% caught',
    recallPct: 28.4,
    escape: '71.6% escape',
    optimal: false,
  },
  {
    arm: 'agy + best practices',
    sub: '/plan + /teamwork + shared worktrees + adversarial-reviewer',
    throughput: '1.78 / min',
    throughputPct: 42,
    recall: '74.6% caught',
    recallPct: 74.6,
    escape: '25.4% escape',
    optimal: false,
  },
  {
    arm: 'With agb',
    sub: 'Multi-pool scheduler + frozen rails + cross-model prosecution',
    throughput: '4.20 / min',
    throughputPct: 100,
    recall: '94.6% caught',
    recallPct: 94.6,
    escape: '5.4% escape',
    optimal: true,
  },
] as const;

const PARETO_LATENCY_CAUSES = [
  {
    cause: 'Spreading work across Gemini, Claude, and GPT quota pools',
    saved: '258s saved · 52%',
    share: 51.9,
    vitalFew: true,
  },
  {
    cause: 'Scheduling in Node.js instead of spending LLM turns on /teamwork',
    saved: '151s saved · 30%',
    share: 30.5,
    vitalFew: true,
  },
  {
    cause: 'Keeping each pool under its rate-limit knee (no 120s timeouts)',
    saved: '55s saved · 11%',
    share: 11.1,
    vitalFew: false,
  },
  {
    cause: 'Serial rebase-first merge lock + halting repeated failures early',
    saved: '32s saved · 7%',
    share: 6.5,
    vitalFew: false,
  },
] as const;

const PARETO_DEFECT_CAUSES = [
  {
    cause: 'Cross-model prosecution + 4-specialist review before merge',
    caught: '53% of catches',
    share: 52.6,
    vitalFew: true,
  },
  {
    cause: 'PreToolUse hook + rails-guard blocking edits to frozen files',
    caught: '29% of catches',
    share: 29.2,
    vitalFew: true,
  },
  {
    cause: 'Mutation testing (hollow-test) + sandboxed test runs',
    caught: '18% of catches',
    share: 18.2,
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
              Benchmarks · 100 paired runs per workload
            </p>
            <h2 className="text-2xl font-medium tracking-[-0.02em] sm:text-3xl">
              Faster builds, fewer escaped bugs—even against a well-tuned setup.
            </h2>
            <p className="max-w-[68ch] text-sm leading-relaxed text-fd-muted-foreground">
              You can get a lot out of Antigravity on its own by combining{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">/plan</code>,{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">/teamwork</code>, shared
              worktrees, and an{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">adversarial-reviewer</code>{' '}
              subagent. We benchmarked{' '}
              <code className="rounded border bg-fd-muted px-1 py-0.5 font-mono text-xs">agb</code> against both a
              default single-session workflow and that hand-tuned best-practices setup to measure what deterministic
              scheduling, multi-pool routing, and mechanical gates actually add.
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border bg-fd-card">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b bg-fd-muted/60 font-mono text-[0.6875rem] font-medium tracking-[0.06em] text-(--color-caption) uppercase">
                  <th className="px-4 py-3">Workload</th>
                  <th className="px-4 py-3">Default agy</th>
                  <th className="px-4 py-3">agy + best practices</th>
                  <th className="px-4 py-3">With agb</th>
                  <th className="px-4 py-3">Gain vs. best practices</th>
                </tr>
              </thead>
              <tbody className="divide-y font-mono text-xs">
                {BENCHMARK_MATRIX.map((row) => (
                  <tr key={row.scenario} className="align-top">
                    <td className="px-4 py-3.5 font-sans text-sm font-medium text-fd-foreground">
                      <div>{row.scenario}</div>
                      <div className="mt-0.5 font-sans text-xs font-normal text-(--color-caption)">{row.subtitle}</div>
                    </td>
                    <td className="px-4 py-3.5 text-fd-muted-foreground">{row.defaultAgy}</td>
                    <td className="px-4 py-3.5 text-fd-muted-foreground">{row.bestPractices}</td>
                    <td className="px-4 py-3.5 font-medium text-fd-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-(--color-go)" />
                        {row.agb}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-fd-foreground">{row.delta}</div>
                      <div className="mt-0.5 font-sans text-xs text-(--color-caption)">{row.detail}</div>
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
                  Speed vs. code quality
                </span>
                <p className="text-xs leading-relaxed text-fd-muted-foreground">
                  Usually, running more agents in parallel means more broken merges. By spreading work across model
                  pools and reviewing every diff with a second model family, <code className="font-mono">agb</code>{' '}
                  raises build speed and bug catch rate at the same time.
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
                        <span className="rounded border bg-fd-background px-1.5 py-0.5">{item.recall}</span>
                        <span className="text-(--color-caption)">{item.escape}</span>
                      </div>
                    </div>
                    <p className="text-xs text-(--color-caption)">{item.sub}</p>
                    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-3 font-mono text-[0.6875rem]">
                      <span className="text-(--color-caption)">Speed</span>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-fd-muted">
                        <div
                          className={`h-full rounded-full ${item.optimal ? 'bg-(--color-go)' : 'bg-fd-foreground/45'}`}
                          style={{ width: `${item.throughputPct}%` }}
                        />
                      </div>
                      <span className="text-(--color-caption)">Bugs caught</span>
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
                  Where the gains come from
                </span>
                <p className="text-xs leading-relaxed text-fd-muted-foreground">
                  Over 80% of the time savings and bug catches come from two things prompts alone can&apos;t do: routing
                  across separate model quota pools in code, and enforcing file boundaries outside the model.
                </p>
              </div>

              <div className="flex flex-col gap-4">
                <div className="font-mono text-[0.6875rem] font-medium tracking-[0.06em] text-(--color-caption) uppercase">
                  Why builds finish 72% faster (~8m 17s saved per 16-ticket run)
                </div>
                <div className="flex flex-col gap-3">
                  {PARETO_LATENCY_CAUSES.map((c) => (
                    <div key={c.cause} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-fd-foreground">{c.cause}</span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-(--color-caption)">{c.saved}</span>
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
                  Why 89% of seeded bugs &amp; rail violations are stopped
                </div>
                <div className="flex flex-col gap-3">
                  {PARETO_DEFECT_CAUSES.map((c) => (
                    <div key={c.cause} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-fd-foreground">{c.cause}</span>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-(--color-caption)">{c.caught}</span>
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
              <span>Run the benchmark suite yourself:</span>
              <code className="rounded border bg-fd-muted px-2 py-0.5 font-mono text-fd-foreground">npm run eval</code>
              <code className="rounded border bg-fd-muted px-2 py-0.5 font-mono text-fd-foreground">
                node evals/runner.mjs --json
              </code>
            </div>
            <div className="flex flex-wrap items-center gap-4 font-medium">
              <Link href="/docs/reference/benchmarks" className="text-(--color-link) hover:underline">
                Full methodology, statistical tests &amp; Pareto charts →
              </Link>
              <Link href="/docs/reference/calibration" className="text-(--color-link) hover:underline">
                Live CLI calibration data →
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
