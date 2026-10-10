import '@fontsource-variable/google-sans-flex';
import '@fontsource-variable/google-sans-code';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { TelemetryStrip } from '@/components/brand';
import { getReleaseVersion } from '@/lib/version';
import './global.css';

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
