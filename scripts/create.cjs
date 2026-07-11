const { spawn } = require('child_process');

const proc = spawn('npx', [
  '-y', 'create-fumadocs-app@latest', 'website',
  '--template', '+next+fuma-docs-mdx+static',
  '--install', '--no-git', '--pm', 'npm'
], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';

proc.stdout.on('data', (data) => {
  const str = data.toString();
  process.stdout.write(str);
  buffer += str;
  
  const prompts = ['Enter: confirm', 'Use `/src` directory?'];
  for (const prompt of prompts) {
    const idx = buffer.indexOf(prompt);
    if (idx !== -1) {
      proc.stdin.write('\r');
      // Slice off everything before and including the prompt, keeping only the remainder
      buffer = buffer.substring(idx + prompt.length);
    }
  }
});

proc.on('close', (code) => {
  process.exit(code);
});
