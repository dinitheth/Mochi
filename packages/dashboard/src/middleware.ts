import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = new Set(['/about', '/privacy', '/terms']);

export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-mochi-public-page', PUBLIC_PATHS.has(request.nextUrl.pathname) ? '1' : '0');
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/about', '/privacy', '/terms'],
};
