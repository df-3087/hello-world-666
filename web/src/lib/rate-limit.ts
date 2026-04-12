type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Returns whether this key is within the allowed quota for the given window. */
export function checkRateLimit(
  key: string,
  opts: { maxRequests: number; windowMs: number }
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (existing.count >= opts.maxRequests) {
    return { allowed: false, retryAfterMs: existing.resetAt - now };
  }

  existing.count++;
  return { allowed: true, retryAfterMs: 0 };
}

/** Extracts the client IP from Vercel/proxy headers, falling back to a placeholder. */
export function getClientIp(req: Request): string {
  const forwarded = (req as { headers: { get(name: string): string | null } }).headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}
