"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";
import "./globals.css";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("Unexpected dashboard error:", error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="global-error-page">
          <section className="global-error-card" role="alert" aria-live="assertive">
            <span className="global-error-mark" aria-hidden="true">!</span>
            <p className="global-error-eyebrow">MY WORKSPACE</p>
            <h1>Something went wrong</h1>
            <p className="global-error-message">
              We couldn’t load your dashboard. Try again, or return to the home page.
            </p>
            {error.digest && (
              <p className="global-error-digest">
                Reference: <code>{error.digest}</code>
              </p>
            )}
            <div className="global-error-actions">
              <button className="global-error-retry" onClick={reset}>Try again</button>
              <Link className="global-error-home" href="/">Go to dashboard</Link>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
