import Link from 'next/link';
import { installCommand } from '@/lib/shared';

export default function HomePage() {
  return (
    <main className="flex flex-col justify-center items-center text-center flex-1 gap-6 px-4 py-16">
      <h1 className="text-3xl font-bold">antigravity-booster</h1>
      <p className="max-w-xl text-fd-muted-foreground">
        agb orchestrates Google Antigravity for large parallel build-outs: a deterministic scheduler, quota-pool-aware
        dispatch, cross-model prosecution and ADLC-shaped gates.
      </p>
      <pre className="max-w-full overflow-x-auto rounded-lg border bg-fd-secondary px-4 py-3 text-left text-sm">
        <code>{installCommand}</code>
      </pre>
      <Link href="/docs" className="font-medium underline">
        Read the docs
      </Link>
    </main>
  );
}
