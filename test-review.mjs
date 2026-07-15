import { reviewFleet } from './lib/review.mjs';

async function run() {
  const result = await reviewFleet({
    diff: 'diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-Hello\n+World\n',
    context: 'Test context'
  });
  console.log(JSON.stringify(result, null, 2));
}

run();
