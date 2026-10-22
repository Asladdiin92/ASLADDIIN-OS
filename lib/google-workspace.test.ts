import assert from "node:assert/strict";
import test from "node:test";
import { fetchGoogleWorkspaceSummary } from "./google-workspace";

test("Google Workspace summary keeps successful services when another service denies access", async () => {
  const originalFetch = globalThis.fetch;
  const session = {
    userId: "test-user",
    email: "test@example.com",
    accessToken: "test-token",
    expiresAt: Date.now() + 60_000,
  };

  try {
    for (const deniedService of ["gmail", "calendar", "drive"] as const) {
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        const service = url.hostname === "gmail.googleapis.com"
          ? "gmail"
          : url.hostname === "www.googleapis.com" && url.pathname.includes("/calendar/")
            ? "calendar"
            : "drive";
        if (service === deniedService) return Response.json({}, { status: 403 });
        if (service === "gmail") return Response.json({ messages: [], resultSizeEstimate: 2 });
        if (service === "calendar") {
          return Response.json({ items: [{ id: "event-1", summary: "Test event" }] });
        }
        return Response.json({ files: [{ id: "file-1", name: "Test file", mimeType: "text/plain" }] });
      };

      const result = await fetchGoogleWorkspaceSummary(session);
      assert.deepEqual(Object.keys(result.errors ?? {}), [deniedService]);
      assert.equal(result.connected, true);
      if (deniedService !== "gmail") assert.equal(result.unreadEmails, 2);
      if (deniedService !== "calendar") assert.equal(result.events.length, 1);
      if (deniedService !== "drive") assert.equal(result.files.length, 1);
      assert.match(result.errors?.[deniedService] ?? "", /403/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
