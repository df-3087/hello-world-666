const SITE_ACCESS_COOKIE = "site-access";

const encoder = new TextEncoder();

function getSitePassword(): string {
  return process.env.SITE_PASSWORD || "";
}

export { SITE_ACCESS_COOKIE };

export function isSiteAccessEnabled(): boolean {
  return getSitePassword().length > 0;
}

export function getSafeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getSiteAccessToken(): Promise<string | null> {
  const password = getSitePassword();
  if (!password) {
    return null;
  }

  return sha256(`site-access:${password}`);
}

export async function isSiteAccessAuthorized(cookieValue?: string): Promise<boolean> {
  if (!isSiteAccessEnabled()) {
    return true;
  }

  if (!cookieValue) {
    return false;
  }

  const token = await getSiteAccessToken();
  return cookieValue === token;
}

export function matchesSitePassword(candidate: string): boolean {
  const password = getSitePassword();
  return password.length > 0 && candidate === password;
}
