import { getLLMText, isIndexable, source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages().filter(isIndexable);
  const texts = await Promise.all(pages.map(getLLMText));
  return new Response(texts.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
