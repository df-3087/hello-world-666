import { NextRequest, NextResponse } from "next/server";
import {
  SITE_ACCESS_COOKIE,
  getSafeNextPath,
  getSiteAccessToken,
  isSiteAccessEnabled,
  matchesSitePassword,
} from "@/lib/site-access";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const { allowed, retryAfterMs } = checkRateLimit(`access:${ip}`, {
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
  });

  if (!allowed) {
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    return new NextResponse("Too many attempts. Please wait before trying again.", {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    });
  }

  const formData = await req.formData();
  const password = String(formData.get("password") || "");
  const nextPath = getSafeNextPath(String(formData.get("next") || req.nextUrl.searchParams.get("next") || "/"));

  if (!isSiteAccessEnabled()) {
    return NextResponse.redirect(new URL(nextPath, req.url), { status: 303 });
  }

  if (!matchesSitePassword(password)) {
    const redirectUrl = new URL("/unlock", req.url);
    redirectUrl.searchParams.set("error", "1");
    if (nextPath !== "/") {
      redirectUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }

  const token = await getSiteAccessToken();
  const response = NextResponse.redirect(new URL(nextPath, req.url), { status: 303 });

  if (token) {
    response.cookies.set({
      name: SITE_ACCESS_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  return response;
}
