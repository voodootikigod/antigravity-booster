import { RootProvider } from 'fumadocs-ui/provider/next';
import { getReleaseVersion } from '@/lib/version';
import './global.css';

export default function Layout({ children }: LayoutProps<'/'>) {
  const version = getReleaseVersion();
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <div className="border-b bg-fd-secondary px-4 py-1.5 text-center text-sm text-fd-muted-foreground">
          {`These docs track main. Latest release: v${version}.`}
        </div>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
