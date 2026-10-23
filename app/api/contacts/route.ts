import { randomUUID } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasPlannerUserAccess } from "@/lib/access";
import { logActivity } from "@/lib/activity-logger";
import {
  createGooglePersonContact,
  deleteGooglePersonContact,
  fetchGooglePeopleContacts,
  GooglePeopleRequestError,
} from "@/lib/google-contacts";
import { readGoogleSession } from "@/lib/google-workspace";
import {
  deleteWorkspaceContact,
  listWorkspaceContacts,
  serializeWorkspaceContact,
  syncGoogleContactsToMongo,
  updateWorkspaceContactNotes,
  upsertWorkspaceContact,
  validateContactNoteUpdate,
  validateWorkspaceContactInput,
} from "@/lib/contacts-store";
import { BoundedRequestBodyError, isSameOrigin, readBoundedJson } from "@/lib/task-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const CONTACT_BODY_LIMIT = 16 * 1024;
const DELETE_BODY_LIMIT = 8 * 1024;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function authorizedUser() {
  try {
    const { userId } = await auth();
    if (!userId) return { error: json({ ok: false, error: "Sign in to access contacts." }, 401) };
    if (!await hasPlannerUserAccess(userId)) {
      return { error: json({ ok: false, error: "You are not authorized to access this workspace." }, 403) };
    }
    return { userId };
  } catch {
    return { error: json({ ok: false, error: "Access could not be verified." }, 503) };
  }
}

function parseBodyError(error: unknown) {
  if (error instanceof BoundedRequestBodyError) {
    return json({ ok: false, error: error.message }, error.status);
  }
  return null;
}

export async function GET(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;

  const session = readGoogleSession(request, access.userId);
  let didSync = false;
  let syncWarning: string | undefined;
  if (request.nextUrl.searchParams.get("sync") === "true" && session) {
    try {
      const googleContacts = await fetchGooglePeopleContacts(session);
      await syncGoogleContactsToMongo(access.userId, googleContacts);
      didSync = true;
    } catch (error) {
      syncWarning = error instanceof GooglePeopleRequestError && [401, 403].includes(error.status)
        ? "Google Contacts permission is unavailable. Reconnect Google to sync contacts."
        : "Google Contacts could not be synced. Showing saved contacts.";
    }
  }
  try {
    const contacts = await listWorkspaceContacts(access.userId);
    return json({
      ok: true,
      contacts: contacts.map(serializeWorkspaceContact),
      googleConnected: Boolean(session),
      synced: didSync,
      ...(syncWarning ? { syncWarning } : {}),
    });
  } catch {
    return json({ ok: false, error: "Saved contacts could not be loaded." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;
  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "This request must come from the dashboard." }, 403);
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, CONTACT_BODY_LIMIT);
  } catch (error) {
    return parseBodyError(error) ?? json({ ok: false, error: "Send a valid contact request." }, 400);
  }
  if (!isPlainObject(body) ||
      Object.keys(body).some((key) => ![
        "name", "email", "phone", "organization", "jobTitle", "notes", "tags", "relationshipScore",
      ].includes(key))) {
    return json({ ok: false, error: "The contact request contains unsupported fields." }, 400);
  }

  const fields = {
    name: body.name,
    email: body.email,
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.organization !== undefined ? { organization: body.organization } : {}),
    ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.relationshipScore !== undefined ? { relationshipScore: body.relationshipScore } : {}),
  };
  let validated;
  try {
    validated = validateWorkspaceContactInput(access.userId, {
      ...fields,
      resourceName: "contact/validation",
      source: "manual",
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Contact input is invalid." }, 400);
  }

  const session = readGoogleSession(request, access.userId);
  let resourceName = `contact/${randomUUID()}`;
  let source: "google" | "manual" = "manual";
  if (session) {
    try {
      const googleContact = await createGooglePersonContact(session, {
        name: validated.name,
        email: validated.email,
        ...(validated.phone ? { phone: validated.phone } : {}),
        ...(validated.organization ? { organization: validated.organization } : {}),
        ...(validated.jobTitle ? { jobTitle: validated.jobTitle } : {}),
      });
      resourceName = googleContact.resourceName;
      source = "google";
    } catch {
      // Local MongoDB persistence remains available when the Google API is unavailable.
    }
  }

  try {
    const saved = await upsertWorkspaceContact(access.userId, {
      ...fields,
      resourceName,
      source,
    });
    await logActivity({
      userId: access.userId,
      type: "contact_synced",
      source: "dashboard",
      title: "Saved workspace contact",
      entityType: "contact",
      entityId: saved.resourceName,
    });
    return json({ ok: true, contact: serializeWorkspaceContact(saved) }, 201);
  } catch {
    return json({ ok: false, error: "The contact could not be saved." }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;
  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "This request must come from the dashboard." }, 403);
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, CONTACT_BODY_LIMIT);
  } catch (error) {
    return parseBodyError(error) ?? json({ ok: false, error: "Send a valid contact update." }, 400);
  }
  if (!isPlainObject(body) ||
      Object.keys(body).some((key) => !["resourceName", "notes", "tags", "relationshipScore"].includes(key)) ||
      typeof body.resourceName !== "string") {
    return json({ ok: false, error: "The contact update is invalid." }, 400);
  }
  const changes = {
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.relationshipScore !== undefined ? { relationshipScore: body.relationshipScore } : {}),
  };
  try {
    validateContactNoteUpdate(access.userId, changes);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "The contact update is invalid." }, 400);
  }
  try {
    const updated = await updateWorkspaceContactNotes(access.userId, body.resourceName, changes);
    if (!updated) return json({ ok: false, error: "Contact not found." }, 404);
    await logActivity({
      userId: access.userId,
      type: "contact_updated",
      source: "dashboard",
      title: "Updated workspace contact",
      entityType: "contact",
      entityId: updated.resourceName,
    });
    return json({ ok: true, contact: serializeWorkspaceContact(updated) });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "The contact could not be updated." }, 400);
  }
}

export async function DELETE(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;
  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "This request must come from the dashboard." }, 403);
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, DELETE_BODY_LIMIT);
  } catch (error) {
    return parseBodyError(error) ?? json({ ok: false, error: "Send a valid contact request." }, 400);
  }
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "resourceName") ||
      typeof body.resourceName !== "string" ||
      body.resourceName.length > 200 ||
      !/^[A-Za-z0-9/_-]+$/.test(body.resourceName)) {
    return json({ ok: false, error: "The contact request is invalid." }, 400);
  }

  const session = readGoogleSession(request, access.userId);
  if (body.resourceName.startsWith("people/") && session) {
    try {
      await deleteGooglePersonContact(session, body.resourceName);
    } catch (error) {
      if (!(error instanceof GooglePeopleRequestError && [403, 404].includes(error.status))) {
        return json({ ok: false, error: "Google could not delete the contact." }, 502);
      }
    }
  }
  try {
    if (!await deleteWorkspaceContact(access.userId, body.resourceName)) {
      return json({ ok: false, error: "Contact not found." }, 404);
    }
    return json({ ok: true, deleted: true });
  } catch {
    return json({ ok: false, error: "The contact could not be deleted." }, 503);
  }
}
