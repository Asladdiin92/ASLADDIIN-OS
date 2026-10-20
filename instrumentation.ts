import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  } else {
    return;
  }

  const registration = globalThis as typeof globalThis & { asladinMongoShutdownHandlersRegistered?: boolean };
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (registration.asladinMongoShutdownHandlersRegistered) return;
  registration.asladinMongoShutdownHandlersRegistered = true;

  const shutdown = (signal: NodeJS.Signals) => {
    const mongoState = globalThis as typeof globalThis & {
      asladinMongoCloseConnection?: () => Promise<void>;
    };
    void (mongoState.asladinMongoCloseConnection?.() ?? Promise.resolve())
      .catch(() => console.error("MongoDB graceful shutdown failed."))
      .finally(() => process.kill(process.pid, signal));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export const onRequestError = Sentry.captureRequestError;
