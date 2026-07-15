import { runAgy } from './lib/agy.mjs';
async function run() {
  const res = await runAgy({
    model: 'Gemini 3.5 Flash (Medium)',
    prompt: 'say hi',
    cwd: process.cwd()
  });
  console.log(res);
}
run();
