import assert from "node:assert/strict";
import test from "node:test";
import {
  createGooglePersonContact,
  deleteGooglePersonContact,
  fetchGooglePeopleContacts,
  GooglePeopleRequestError,
} from "./google-contacts";
import type { GoogleSession } from "./google-workspace";

const session: GoogleSession = {
  userId: "user-1",
  email: "person@example.com",
  accessToken: "test-access-token",
  expiresAt: Date.now() + 60_000,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("fetches and normalizes valid People connections while skipping invalid contacts", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return jsonResponse({
      connections: [
        {
          resourceName: "people/c123",
          names: [{ displayName: " Ada Lovelace " }],
          emailAddresses: [{ value: " ADA@example.com " }],
          phoneNumbers: [{ value: "+1 555 0100" }],
          organizations: [{ name: "Engine Works", title: "Mathematician" }],
          photos: [{ url: "https://example.com/photo.png" }],
        },
        {
          resourceName: "people/no-email",
          names: [{ displayName: "No Email" }],
          emailAddresses: [{ value: "bad-email" }],
        },
        {
          resourceName: "people/no-name",
          emailAddresses: [{ value: "valid@example.com" }],
        },
      ],
    });
  }) as typeof fetch;
  try {
    const contacts = await fetchGooglePeopleContacts(session);
    assert.equal(requestedUrl,
      "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,photos&pageSize=100");
    assert.equal(requestedInit?.method, "GET");
    assert.equal(requestedInit?.cache, "no-store");
    assert.ok(requestedInit?.signal instanceof AbortSignal);
    assert.deepEqual(contacts, [{
      resourceName: "people/c123",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+1 555 0100",
      organization: "Engine Works",
      jobTitle: "Mathematician",
      photoUrl: "https://example.com/photo.png",
      source: "google",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates a normalized People contact", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ resourceName: "people/created-1" });
  }) as typeof fetch;
  try {
    const contact = await createGooglePersonContact(session, {
      name: "Ada Lovelace",
      email: "ADA@example.com",
      organization: "Engine Works",
      jobTitle: "Mathematician",
    });
    assert.equal(contact.resourceName, "people/created-1");
    assert.equal(contact.email, "ada@example.com");
    assert.equal(contact.source, "google");
    assert.deepEqual(body?.emailAddresses, [{ value: "ada@example.com" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deletes only a valid Google People resource", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await deleteGooglePersonContact(session, "people/c123");
    assert.equal(requestedUrl, "https://people.googleapis.com/v1/people/c123:deleteContact");
    await assert.rejects(deleteGooglePersonContact(session, "people/c123?alt=media"), /resource name/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces provider status and bounds People API responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({}, 403)) as typeof fetch;
  try {
    await assert.rejects(
      fetchGooglePeopleContacts(session),
      (error: unknown) => error instanceof GooglePeopleRequestError && error.status === 403,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => new Response("{}", {
    headers: { "Content-Length": "2000000" },
  })) as typeof fetch;
  try {
    await assert.rejects(fetchGooglePeopleContacts(session), /too large/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
