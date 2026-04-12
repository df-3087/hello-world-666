"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function UnlockContent() {
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";
  const hasError = searchParams.get("error") === "1";

  return (
    <main className="gate">
      <section className="gate-card">
        <p className="gate-kicker">FlightSnooper</p>
        <h1 className="title">Enter password</h1>
        <p className="subtitle">This site is shared by invite only. Enter the password to continue.</p>

        <form action="/api/access" method="POST" className="gate-form">
          <input type="hidden" name="next" value={nextPath} />
          <input name="password" type="password" placeholder="Password" autoComplete="current-password" required />
          <button type="submit">Continue</button>
        </form>

        {hasError ? <p className="gate-error">Incorrect password. Try again.</p> : null}
      </section>
    </main>
  );
}

export default function UnlockPage() {
  return (
    <Suspense fallback={null}>
      <UnlockContent />
    </Suspense>
  );
}
