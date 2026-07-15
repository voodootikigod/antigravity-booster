import { execSync } from 'child_process';
try {
  const out = execSync('node bin/agb.mjs review . main', { encoding: 'utf8' });
  console.log('STDOUT:', out);
} catch (e) {
  console.error('ERROR!');
  console.error('STDOUT:', e.stdout);
  console.error('STDERR:', e.stderr);
}
