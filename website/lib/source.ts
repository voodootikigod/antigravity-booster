import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { docs } from '@/.source/server';
import { docsRoute } from './shared';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export const DESIGN_HISTORY_PREFIX = '/docs/project/design-history';

/** Design history is listed in the nav but excluded from search and llms.txt (spec D9). */
export function isIndexable(page: { url: string }): boolean {
  // Boundary match: the section index URL has no trailing slash.
  return page.url !== DESIGN_HISTORY_PREFIX && !page.url.startsWith(`${DESIGN_HISTORY_PREFIX}/`);
}

type Page = ReturnType<typeof source.getPages>[number];

/** Fumadocs getLLMText pattern. */
export async function getLLMText(page: Page): Promise<string> {
  const processed = await page.data.getText('processed');
  return `# ${page.data.title} (${page.url})

${processed}`;
}
