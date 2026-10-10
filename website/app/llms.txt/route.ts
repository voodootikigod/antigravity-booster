import { isIndexable, source } from '@/lib/source';

export const revalidate = false;

export function GET() {
  const lines = ['# antigravity-booster', ''];
  for (const page of source.getPages().filter(isIndexable)) {
    const desc = page.data.description ? `: ${page.data.description}` : '';
    lines.push(`- [${page.data.title}](${page.url})${desc}`);
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
