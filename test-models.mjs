import { runAgy } from './lib/agy.mjs';

async function run() {
  const claude = await runAgy({ model: 'Claude Sonnet 4.6 (Thinking)', prompt: 'test' });
  const gemini = await runAgy({ model: 'Gemini 3.1 Pro (High)', prompt: 'test' });
  
  console.log('Claude:', claude.error || 'OK');
  console.log('Gemini:', gemini.error || 'OK');
}
run();
