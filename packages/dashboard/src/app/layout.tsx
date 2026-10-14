import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AutoApproveSwitch from '@/components/AutoApproveSwitch';
import { isValidDashboardSession, SESSION_COOKIE } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mochi',
  description: 'Mochi — pocket money, soft and sweet. Agent wallet, live activity and approvals on Monad',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const publicPage = requestHeaders.get('x-mochi-public-page') === '1';
  const authenticated = publicPage || isValidDashboardSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!authenticated) redirect('/oauth/dashboard/login');
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className={publicPage ? 'min-h-screen w-full' : 'max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6'}>
          {publicPage ? (
            children
          ) : (
            <>
              <header className="flex flex-col gap-3 mb-4 sm:mb-6">
                <div className="flex items-center justify-between">
                  <h1 className="text-xl font-bold">
                    <span className="text-monad">Mochi</span>
                    <span className="ml-2 text-xs font-normal text-white/40">pocket money, soft and sweet</span>
                  </h1>
                  <AutoApproveSwitch />
                </div>
                <nav className="flex gap-4 text-sm overflow-x-auto pb-1 -mx-1 px-1">
                  <a href="/" className="text-white/70 hover:text-white whitespace-nowrap">Dashboard</a>
                  <a href="/marketplace" className="text-white/70 hover:text-white whitespace-nowrap">Market</a>
                  <a href="/auctions" className="text-white/70 hover:text-white whitespace-nowrap">Auctions</a>
                  <a href="/approvals" className="text-white/70 hover:text-white whitespace-nowrap">Approvals</a>
                </nav>
              </header>
              {children}
            </>
          )}
        </div>
      </body>
    </html>
  );
}
