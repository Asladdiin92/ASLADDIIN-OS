import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { GoogleWorkspaceSummary } from "@/lib/google-types";

const STATE_COOKIE = "google_oauth_state";
const TOKEN_COOKIE = "google_access";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];
const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;

type OAuthState = { userId: string; nonce: string; expiresAt: number };
export type GoogleSession = { userId: string; email: string; accessToken: string; expiresAt: number };
type GoogleService = "gmail" | "calendar" | "drive";
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

class GoogleRequestError extends Error {
  constructor(readonly service: GoogleService, readonly status: number) {
    super(status === 401 ? "Your Google session expired. Reconnect your Google account." : `${service} request failed (${status}).`);
    this.name = "GoogleRequestError";
  }
}

const googleServiceNames: Record<GoogleService, string> = {
  gmail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
};

type GoogleServiceResult<T> = { data: T; error?: never } | { data?: never; error: string };

async function requestGoogleService<T>(
  service: GoogleService,
  operation: () => Promise<T>,
): Promise<GoogleServiceResult<T>> {
  try {
    return { data: await operation() };
  } catch (error) {
    const status = error instanceof GoogleRequestError ? error.status : undefined;
    if (process.env.NODE_ENV === "development") {
      console.warn("Google Workspace service request failed.", {
        service,
        ...(status ? { status } : {}),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    if (status === 401) throw error;
    const name = googleServiceNames[service];
    return {
      error: status === 403
        ? `${name} access was denied by Google (403).`
        : status
          ? `${name} request failed (${status}).`
          : `${name} data could not be loaded.`,
    };
  }
}

function googleFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
  });
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
  }
  return secret;
}

function callbackUrl(requestUrl?: string): string {
  const configured = [process.env.GOOGLE_REDIRECT_URI, process.env.GOOGLE_CALLBACK_URL].filter(Boolean);
  if (configured.length > 1 && configured[0] !== configured[1]) {
    throw new Error("GOOGLE_REDIRECT_URI and GOOGLE_CALLBACK_URL must match when both are set.");
  }
  const value = configured[0] || (requestUrl ? new URL("/api/google/callback", requestUrl).toString() : "");
  if (!value) throw new Error("Set GOOGLE_REDIRECT_URI to your full Google OAuth callback URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("The Google OAuth callback URL must use HTTPS.");
  }
  return url.toString();
}

function clientCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting Google.");
  }
  return { clientId, clientSecret };
}

function key(): Buffer {
  return createHash("sha256").update(sessionSecret()).digest();
}

function hmac(value: string): string {
  return createHmac("sha256", key()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function googleOAuthCookieNames() {
  return { state: STATE_COOKIE, token: TOKEN_COOKIE };
}

export function clearGoogleCookie(response: NextResponse, cookieName: string, path = "/api/google") {
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path,
    maxAge: 0,
  });
}

export function createGoogleOAuthState(userId: string) {
  const nonce = randomBytes(32).toString("base64url");
  const payload: OAuthState = { userId, nonce, expiresAt: Date.now() + 10 * 60_000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { nonce, state: `${encoded}.${hmac(encoded)}` };
}

export function verifyGoogleOAuthState(state: string, nonce: string | undefined, userId: string): boolean {
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra || !nonce || !safeEqual(signature, hmac(encoded))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthState;
    return payload.userId === userId && payload.nonce === nonce && payload.expiresAt > Date.now();
  } catch {
    return false;
  }
}

export function googleAuthorizationUrl(state: string, requestUrl: string): string {
  const { clientId } = clientCredentials();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl(requestUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("access_type", "online");
  return url.toString();
}

export async function exchangeGoogleCode(code: string, requestUrl: string, userId: string): Promise<GoogleSession> {
  const { clientId, clientSecret } = clientCredentials();
  const response = await googleFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(requestUrl),
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  const tokens = await response.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in! <= 0) {
    throw new Error("Google could not complete authorization. Check the OAuth client and callback URL.");
  }

  const profileResponse = await googleFetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
  });
  const profile = await profileResponse.json() as { email?: string; verified_email?: boolean };
  if (!profileResponse.ok || !profile.email || profile.verified_email !== true) {
    throw new Error("Google did not return a verified account email.");
  }

  return {
    userId,
    email: profile.email,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + Math.min(tokens.expires_in!, 3600) * 1000,
  };
}

export function setGoogleSessionCookie(session: GoogleSession) {
  const value = Buffer.from(JSON.stringify(session)).toString("utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function readGoogleSession(request: NextRequest, userId: string): GoogleSession | null {
  const value = request.cookies.get(TOKEN_COOKIE)?.value;
  if (!value) return null;
  try {
    const [ivText, tagText, encryptedText, extra] = value.split(".");
    if (!ivText || !tagText || !encryptedText || extra) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const session = JSON.parse(decrypted) as GoogleSession;
    if (session.userId !== userId || !Number.isFinite(session.expiresAt) ||
        session.expiresAt <= Date.now() || !session.accessToken || !session.email) return null;
    return session;
  } catch {
    return null;
  }
}

export async function revokeGoogleAccess(session: GoogleSession): Promise<void> {
  const response = await googleFetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: session.accessToken }),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 400) {
    throw new Error("Google did not confirm the access-token revocation. Try disconnecting again.");
  }
}

async function googleGet<T>(token: string, url: URL, service: GoogleService): Promise<T> {
  const response = await googleFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new GoogleRequestError(service, response.status);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
    throw new Error("Google returned a message that is too large to process. Try again with a shorter email.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new Error("Google returned a message that is too large to process. Try again with a shorter email.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Google returned data that could not be read.");
  }
}

function emailHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function plainTextBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8").slice(0, 3000);
  }
  for (const part of payload.parts ?? []) {
    const text = plainTextBody(part);
    if (text) return text;
  }
  return "";
}

export async function fetchGoogleWorkspaceSummary(
  session: GoogleSession,
  includeMessageContent = false,
): Promise<GoogleWorkspaceSummary> {
  const messagesUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  messagesUrl.searchParams.set("q", "is:unread");
  messagesUrl.searchParams.set("maxResults", includeMessageContent ? "3" : "5");
  const calendarUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  calendarUrl.searchParams.set("timeMin", new Date().toISOString());
  calendarUrl.searchParams.set("timeMax", new Date(Date.now() + 7 * 86_400_000).toISOString());
  calendarUrl.searchParams.set("singleEvents", "true");
  calendarUrl.searchParams.set("orderBy", "startTime");
  calendarUrl.searchParams.set("maxResults", "20");
  const driveUrl = new URL("https://www.googleapis.com/drive/v3/files");
  driveUrl.searchParams.set("pageSize", "8");
  driveUrl.searchParams.set("orderBy", "modifiedTime desc");
  driveUrl.searchParams.set("q", "trashed = false");
  driveUrl.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink)");

  const [mailResult, calendarResult, driveResult] = await Promise.all([
    requestGoogleService("gmail", async () => {
      const mail = await googleGet<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(
        session.accessToken, messagesUrl, "gmail",
      );
      const messages = await Promise.all((mail.messages ?? []).slice(0, includeMessageContent ? 3 : 5).map(async ({ id }) => {
        const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
        messageUrl.searchParams.set("format", includeMessageContent ? "full" : "metadata");
        for (const header of ["From", "Subject", "Date"]) messageUrl.searchParams.append("metadataHeaders", header);
        const message = await googleGet<{
          id: string;
          snippet?: string;
          payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
        }>(session.accessToken, messageUrl, "gmail");
        const headers = message.payload?.headers;
        return {
          id: message.id,
          from: emailHeader(headers, "From"),
          subject: emailHeader(headers, "Subject") || "(no subject)",
          date: emailHeader(headers, "Date"),
          snippet: message.snippet ?? "",
          ...(includeMessageContent ? { body: plainTextBody(message.payload) } : {}),
        };
      }));
      return { unreadEmails: mail.resultSizeEstimate ?? messages.length, messages };
    }),
    requestGoogleService("calendar", () =>
      googleGet<{ items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; htmlLink?: string }> }>(
        session.accessToken, calendarUrl, "calendar",
      ),
    ),
    requestGoogleService("drive", () =>
      googleGet<{ files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }> }>(
        session.accessToken, driveUrl, "drive",
      ),
    ),
  ]);
  const errors: NonNullable<GoogleWorkspaceSummary["errors"]> = {};
  if (mailResult.error) errors.gmail = mailResult.error;
  if (calendarResult.error) errors.calendar = calendarResult.error;
  if (driveResult.error) errors.drive = driveResult.error;

  return {
    connected: true,
    email: session.email,
    unreadEmails: mailResult.data?.unreadEmails ?? 0,
    messages: mailResult.data?.messages ?? [],
    events: (calendarResult.data?.items ?? []).map((event) => ({
      id: event.id,
      title: event.summary || "(untitled event)",
      start: event.start?.dateTime ?? event.start?.date ?? "",
      end: event.end?.dateTime ?? event.end?.date ?? "",
      link: event.htmlLink,
    })),
    files: (driveResult.data?.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      link: file.webViewLink,
    })),
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

export async function fetchGoogleCalendarEvents(
  session: GoogleSession,
  start = new Date(),
  days = 8,
): Promise<Array<{ id: string; title: string; start: string; end: string; link?: string }>> {
  const events: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; htmlLink?: string }> = [];
  let pageToken: string | undefined;
  do {
    const calendarUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    calendarUrl.searchParams.set("timeMin", start.toISOString());
    calendarUrl.searchParams.set("timeMax", new Date(start.getTime() + days * 86_400_000).toISOString());
    calendarUrl.searchParams.set("singleEvents", "true");
    calendarUrl.searchParams.set("orderBy", "startTime");
    calendarUrl.searchParams.set("maxResults", "250");
    calendarUrl.searchParams.set("fields", "items(id,summary,start,end,htmlLink),nextPageToken");
    if (pageToken) calendarUrl.searchParams.set("pageToken", pageToken);

    const calendarResult = await googleGet<{
      items?: typeof events;
      nextPageToken?: string;
    }>(session.accessToken, calendarUrl, "calendar");
    events.push(...(calendarResult.items ?? []));
    pageToken = calendarResult.nextPageToken;
    if (pageToken && events.length >= 1000) {
      throw new Error("There are too many upcoming calendar events to check safely. Narrow your calendar or try again.");
    }
  } while (pageToken);

  return events.map((event) => ({
    id: event.id,
    title: event.summary || "(untitled event)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    link: event.htmlLink,
  }));
}
