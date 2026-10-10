import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { appName, getPageImageUrl } from '@/lib/shared';
import { source } from '@/lib/source';

export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  // The last segment is the literal `image.png`; drop it before resolving the page.
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '72px',
        background: '#0a0a0a',
        color: '#fafafa',
      }}
    >
      <div style={{ fontSize: 32, color: '#a3a3a3' }}>{appName}</div>
      <div style={{ fontSize: 72, fontWeight: 700, marginTop: 24 }}>{page.data.title}</div>
      {page.data.description ? (
        <div style={{ fontSize: 36, color: '#d4d4d4', marginTop: 24 }}>{page.data.description}</div>
      ) : null}
    </div>,
    { width: 1200, height: 630 },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: getPageImageUrl(page).segments,
  }));
}
