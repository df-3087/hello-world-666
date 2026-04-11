import { NextRequest, NextResponse } from "next/server";
import {
  SITE_ACCESS_COOKIE,
  getSafeNextPath,
  getSiteAccessToken,
  isSiteAccessEnabled,
  matchesSitePassword,
} from "@/lib/site-access";

export async function POST(req: NextRequest) {
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
