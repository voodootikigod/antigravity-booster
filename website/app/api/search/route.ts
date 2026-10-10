import { createSearchAPI } from 'fumadocs-core/search/server';
import { isIndexable, source } from '@/lib/source';

// createFromSource is deliberately not used: it cannot exclude design history (spec §3.1, D9).
export const { GET } = createSearchAPI('advanced', {
  indexes: source
    .getPages()
    .filter((p) => isIndexable(p))
    .map((p) => ({
      id: p.url,
      url: p.url,
      title: p.data.title,
      description: p.data.description,
      structuredData: p.data.structuredData,
    })),
});
