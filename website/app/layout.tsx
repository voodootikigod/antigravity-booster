import '@fontsource-variable/google-sans-flex';
import '@fontsource-variable/google-sans-code';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { TelemetryStrip } from '@/components/brand';
import { appName } from '@/lib/shared';
import { getReleaseVersion } from '@/lib/version';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://www.agybooster.com'),
  title: {
    default: appName,
    template: `%s | ${appName}`,
  },
  description:
    'Deterministic multi-agent orchestration, quota-pool routing, and ADLC rail enforcement for Google Antigravity.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <TelemetryStrip version={getReleaseVersion()} />
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
