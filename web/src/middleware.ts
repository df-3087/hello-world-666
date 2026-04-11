import { NextRequest, NextResponse } from "next/server";
import { SITE_ACCESS_COOKIE, getSafeNextPath, isSiteAccessAuthorized, isSiteAccessEnabled } from "@/lib/site-access";

const PUBLIC_FILE = /\.[^/]+$/;

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (
    !isSiteAccessEnabled() ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/access") ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  const isAuthorized = await isSiteAccessAuthorized(req.cookies.get(SITE_ACCESS_COOKIE)?.value);

  if (pathname.startsWith("/unlock")) {
    if (isAuthorized) {
      const url = req.nextUrl.clone();
      url.pathname = getSafeNextPath(req.nextUrl.searchParams.get("next"));
      url.search = "";
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

  if (isAuthorized) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/:path*"],
};
