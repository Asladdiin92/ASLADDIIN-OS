"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard route error:", error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="app-error-screen">
      <section className="app-error-card" role="alert">
        <span className="app-error-label">WORKSPACE ERROR</span>
        <h1>This page couldn&apos;t load</h1>
        <p>{error.message || "An unexpected error interrupted this page."}</p>
        {error.digest && <small>Reference: {error.digest}</small>}
        <button type="button" onClick={() => reset()}>Try again</button>
      </section>
    </main>
  );
}
