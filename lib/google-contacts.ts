import "server-only";

import type { GoogleSession } from "@/lib/google-workspace";

const PEOPLE_CONNECTIONS_URL =
  "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,photos&pageSize=100";
const MAX_PEOPLE_RESPONSE_BYTES = 1_048_576;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GooglePersonContact = {
  resourceName: string;
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  jobTitle?: string;
  photoUrl?: string;
  source: "google";
};

export class GooglePeopleRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GooglePeopleRequestError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : undefined;
}

function normalizedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maximum ? text : undefined;
}

function safePhotoUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function readGoogleJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PEOPLE_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Google People API returned a response that is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    if (response.status === 204) return null;
    throw new Error("Google People API returned an empty response.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PEOPLE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Google People API returned a response that is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Google People API returned invalid JSON.");
  }
}

async function requestPeopleApi(
  session: GoogleSession,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  if (!session.accessToken) throw new Error("A valid Google session is required.");
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GooglePeopleRequestError(response.status, `Google People API request failed (${response.status}).`);
  }
  return readGoogleJson(response);
}

function normalizePerson(value: unknown): GooglePersonContact | null {
  if (!isPlainObject(value)) return null;
  const resourceName = normalizedText(value.resourceName, 200);
  if (!resourceName || !/^people\/[A-Za-z0-9_-]+$/.test(resourceName)) return null;
  const names = Array.isArray(value.names) ? value.names : [];
  const primaryName = names.find(isPlainObject);
  const emailAddresses = Array.isArray(value.emailAddresses) ? value.emailAddresses : [];
  const email = emailAddresses
    .filter(isPlainObject)
    .map((address) => normalizedEmail(address.value))
    .find(Boolean);
  if (!email) return null;
  const name = normalizedText(primaryName?.displayName, 200) ??
    normalizedText(primaryName?.unstructuredName, 200);
  if (!name) return null;
  const phoneNumbers = Array.isArray(value.phoneNumbers) ? value.phoneNumbers : [];
  const phone = phoneNumbers.filter(isPlainObject)
    .map((item) => normalizedText(item.value, 60))
    .find(Boolean);
  const organizations = Array.isArray(value.organizations) ? value.organizations : [];
  const organization = organizations.find(isPlainObject);
  const photos = Array.isArray(value.photos) ? value.photos : [];
  const photo = photos.find(isPlainObject);
  const photoUrl = safePhotoUrl(photo?.url);

  return {
    resourceName,
    name,
    email,
    ...(phone ? { phone } : {}),
    ...(normalizedText(organization?.name, 200)
      ? { organization: normalizedText(organization?.name, 200) }
      : {}),
    ...(normalizedText(organization?.title, 200)
      ? { jobTitle: normalizedText(organization?.title, 200) }
      : {}),
    ...(photoUrl ? { photoUrl } : {}),
    source: "google",
  };
}

export async function fetchGooglePeopleContacts(
  session: GoogleSession,
): Promise<GooglePersonContact[]> {
  const result = await requestPeopleApi(session, PEOPLE_CONNECTIONS_URL, { method: "GET" });
  if (!isPlainObject(result) || (result.connections !== undefined && !Array.isArray(result.connections))) {
    throw new Error("Google People API returned an invalid contacts list.");
  }
  return (result.connections ?? [])
    .map(normalizePerson)
    .filter((contact): contact is GooglePersonContact => contact !== null);
}

export async function createGooglePersonContact(
  session: GoogleSession,
  input: {
    name: string;
    email: string;
    phone?: string;
    organization?: string;
    jobTitle?: string;
  },
): Promise<GooglePersonContact> {
  const name = normalizedText(input.name, 200);
  const email = normalizedEmail(input.email);
  const phone = normalizedText(input.phone, 60);
  const organization = normalizedText(input.organization, 200);
  const jobTitle = normalizedText(input.jobTitle, 200);
  if (!name || !email ||
      (input.phone !== undefined && !phone) ||
      (input.organization !== undefined && !organization) ||
      (input.jobTitle !== undefined && !jobTitle)) {
    throw new Error("Google contact name, email, or optional fields are invalid.");
  }
  const body = {
    names: [{ givenName: name }],
    emailAddresses: [{ value: email }],
    ...(phone ? { phoneNumbers: [{ value: phone }] } : {}),
    ...(organization || jobTitle
      ? { organizations: [{ ...(organization ? { name: organization } : {}), ...(jobTitle ? { title: jobTitle } : {}) }] }
      : {}),
  };
  const result = await requestPeopleApi(
    session,
    "https://people.googleapis.com/v1/people:createContact",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const normalized = normalizePerson({
    ...(isPlainObject(result) ? result : {}),
    names: [{ displayName: name }],
    emailAddresses: [{ value: email }],
    phoneNumbers: phone ? [{ value: phone }] : [],
    organizations: organization || jobTitle ? [{ name: organization, title: jobTitle }] : [],
  });
  if (!normalized) throw new Error("Google People API returned an invalid created contact.");
  return normalized;
}

export async function deleteGooglePersonContact(
  session: GoogleSession,
  resourceName: string,
): Promise<void> {
  if (!/^people\/[A-Za-z0-9_-]+$/.test(resourceName)) {
    throw new Error("A valid Google People resource name is required.");
  }
  await requestPeopleApi(
    session,
    `https://people.googleapis.com/v1/${resourceName}:deleteContact`,
    { method: "DELETE" },
  );
}
