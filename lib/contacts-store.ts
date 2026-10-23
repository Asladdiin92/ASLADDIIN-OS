import "server-only";

import { ObjectId, type Collection } from "mongodb";
import { redactConversationContent } from "@/lib/ai-conversations";
import { getMongoDb } from "@/lib/mongodb";

const COLLECTION_NAME = "workspace_contacts";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9/_-]+$/;

export type WorkspaceContact = {
  _id: ObjectId;
  userId: string;
  resourceName: string;
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  jobTitle?: string;
  photoUrl?: string;
  notes: string;
  tags: string[];
  relationshipScore: number;
  source: "google" | "manual";
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ContactNoteChanges =
  Partial<Pick<WorkspaceContact, "notes" | "tags" | "relationshipScore">> &
  Pick<WorkspaceContact, "updatedAt">;

export type WorkspaceContactRepository = {
  list(userId: string, limit: number): Promise<WorkspaceContact[]>;
  upsert(contact: WorkspaceContact): Promise<WorkspaceContact>;
  sync(contact: WorkspaceContact): Promise<WorkspaceContact>;
  updateNotes(
    userId: string,
    resourceName: string,
    changes: ContactNoteChanges,
  ): Promise<WorkspaceContact | null>;
  delete(userId: string, resourceName: string): Promise<boolean>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateUserId(userId: string): void {
  if (typeof userId !== "string" || !userId || userId !== userId.trim() || userId.length > 256) {
    throw new Error("A stable authenticated user ID is required.");
  }
}

function validateNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The contact timestamp is invalid.");
  }
  return new Date(now.getTime());
}

function rejectOwnershipFields(input: Record<string, unknown>): void {
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (!Array.isArray(value) && ("userId" in value || "_id" in value)) {
      throw new Error("Contact ownership and database IDs are server-controlled.");
    }
    Object.values(value).forEach(visit);
  };
  visit(input);
}

function validateResourceName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
      !RESOURCE_NAME_PATTERN.test(value)) {
    throw new Error("Contact resourceName must contain 1–200 valid characters.");
  }
  return value;
}

function optionalText(
  input: Record<string, unknown>,
  field: string,
  maximum: number,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`Contact ${field} must be ${maximum} characters or fewer.`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Contact ${field} cannot be empty.`);
  return trimmed;
}

function validateNotes(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 4_000) {
    throw new Error("Contact notes must contain 0–4,000 characters.");
  }
  return redactConversationContent(value.trim());
}

function validateTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 ||
      value.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 50)) {
    throw new Error("Contact tags must contain at most 20 items of 1–50 characters each.");
  }
  return [...new Set(value.map((tag: string) => tag.trim()))];
}

function validateRelationshipScore(value: unknown): number {
  if (value === undefined) return 80;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Contact relationshipScore must be an integer from 0 to 100.");
  }
  return value;
}

function optionalDate(input: Record<string, unknown>, field: string): Date | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Contact ${field} must be a valid date.`);
  }
  return new Date(value.getTime());
}

export function validateWorkspaceContactInput(
  userId: string,
  input: unknown,
  now = new Date(),
): WorkspaceContact {
  validateUserId(userId);
  if (!isPlainObject(input)) throw new Error("Contact input must be a plain object.");
  rejectOwnershipFields(input);
  const allowedFields = new Set([
    "resourceName", "name", "email", "phone", "organization", "jobTitle", "photoUrl",
    "notes", "tags", "relationshipScore", "source", "lastSyncedAt",
  ]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    throw new Error("Contact input contains unsupported fields.");
  }
  const timestamp = validateNow(now);
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) {
    throw new Error("Contact name must contain 1–200 characters.");
  }
  if (typeof input.email !== "string" || input.email.trim().length > 254 ||
      !EMAIL_PATTERN.test(input.email.trim())) {
    throw new Error("Contact email must be a valid address of at most 254 characters.");
  }
  if (input.source !== undefined && input.source !== "google" && input.source !== "manual") {
    throw new Error("Contact source must be google or manual.");
  }
  const phone = optionalText(input, "phone", 60);
  const organization = optionalText(input, "organization", 200);
  const jobTitle = optionalText(input, "jobTitle", 200);
  const lastSyncedAt = optionalDate(input, "lastSyncedAt");
  let photoUrl: string | undefined;
  if (input.photoUrl !== undefined) {
    if (typeof input.photoUrl !== "string" || input.photoUrl.length > 2_000) {
      throw new Error("Contact photoUrl must be a valid HTTPS URL.");
    }
    try {
      const url = new URL(input.photoUrl);
      if (input.photoUrl !== input.photoUrl.trim() || url.protocol !== "https:" || !url.hostname) {
        throw new Error();
      }
      photoUrl = url.toString();
    } catch {
      throw new Error("Contact photoUrl must be a valid HTTPS URL.");
    }
  }

  return {
    _id: new ObjectId(),
    userId,
    resourceName: validateResourceName(input.resourceName),
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    ...(phone ? { phone } : {}),
    ...(organization ? { organization } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    notes: validateNotes(input.notes),
    tags: validateTags(input.tags),
    relationshipScore: validateRelationshipScore(input.relationshipScore),
    source: input.source === "google" ? "google" : "manual",
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function validateContactNoteUpdate(
  userId: string,
  input: unknown,
  now = new Date(),
): ContactNoteChanges {
  validateUserId(userId);
  if (!isPlainObject(input)) throw new Error("Contact note update must be a plain object.");
  rejectOwnershipFields(input);
  const allowedFields = new Set(["notes", "tags", "relationshipScore"]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    throw new Error("Contact note update contains unsupported fields.");
  }
  if (!("notes" in input) && !("tags" in input) && !("relationshipScore" in input)) {
    throw new Error("Contact note update must include notes, tags, or relationshipScore.");
  }
  const timestamp = validateNow(now);
  return {
    ...(input.notes !== undefined ? { notes: validateNotes(input.notes) } : {}),
    ...(input.tags !== undefined ? { tags: validateTags(input.tags) } : {}),
    ...(input.relationshipScore !== undefined
      ? { relationshipScore: validateRelationshipScore(input.relationshipScore) }
      : {}),
    updatedAt: timestamp,
  };
}

function validateResourceNameForOperation(resourceName: string): string {
  return validateResourceName(resourceName);
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new Error("Contact page size must be an integer from 1 to 250.");
  }
}

export function createWorkspaceContactService(repository: WorkspaceContactRepository) {
  return {
    async list(userId: string, limit = 100): Promise<WorkspaceContact[]> {
      validateUserId(userId);
      validateLimit(limit);
      return repository.list(userId, limit);
    },
    async upsert(userId: string, input: unknown): Promise<WorkspaceContact> {
      return repository.upsert(validateWorkspaceContactInput(userId, input));
    },
    async sync(
      userId: string,
      contacts: unknown[],
      now = new Date(),
    ): Promise<WorkspaceContact[]> {
      validateUserId(userId);
      if (!Array.isArray(contacts)) throw new Error("Google contacts must be an array.");
      const timestamp = validateNow(now);
      const synced: WorkspaceContact[] = [];
      for (const input of contacts) {
        if (!isPlainObject(input)) throw new Error("Google contact input must be a plain object.");
        const contact = validateWorkspaceContactInput(userId, {
          ...input,
          source: "google",
          lastSyncedAt: timestamp,
        }, timestamp);
        synced.push(await repository.sync(contact));
      }
      return synced;
    },
    async updateNotes(
      userId: string,
      resourceName: string,
      input: unknown,
    ): Promise<WorkspaceContact | null> {
      validateUserId(userId);
      const resource = validateResourceNameForOperation(resourceName);
      return repository.updateNotes(
        userId,
        resource,
        validateContactNoteUpdate(userId, input),
      );
    },
    async delete(userId: string, resourceName: string): Promise<boolean> {
      validateUserId(userId);
      return repository.delete(userId, validateResourceNameForOperation(resourceName));
    },
  };
}

function mongoRepository(collection: Collection<WorkspaceContact>): WorkspaceContactRepository {
  return {
    list(userId, limit) {
      return collection.find({ userId }).sort({ updatedAt: -1 }).limit(limit).toArray();
    },
    async upsert(contact) {
      const { _id, createdAt, ...setFields } = contact;
      const result = await collection.findOneAndUpdate(
        { userId: contact.userId, resourceName: contact.resourceName },
        { $set: setFields, $setOnInsert: { _id, createdAt } },
        { upsert: true, returnDocument: "after" },
      );
      if (!result) throw new Error("Contact storage could not return the saved contact.");
      return result;
    },
    async sync(contact) {
      const profile = {
        name: contact.name,
        email: contact.email,
        ...(contact.phone !== undefined ? { phone: contact.phone } : {}),
        ...(contact.organization !== undefined ? { organization: contact.organization } : {}),
        ...(contact.jobTitle !== undefined ? { jobTitle: contact.jobTitle } : {}),
        ...(contact.photoUrl !== undefined ? { photoUrl: contact.photoUrl } : {}),
        source: contact.source,
        ...(contact.lastSyncedAt ? { lastSyncedAt: contact.lastSyncedAt } : {}),
        updatedAt: contact.updatedAt,
      };
      const result = await collection.findOneAndUpdate(
        { userId: contact.userId, resourceName: contact.resourceName },
        {
          $set: profile,
          $setOnInsert: {
            _id: contact._id,
            createdAt: contact.createdAt,
            notes: "",
            tags: [],
            relationshipScore: 80,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (!result) throw new Error("Google contact sync could not return the saved contact.");
      return result;
    },
    updateNotes(userId, resourceName, changes) {
      return collection.findOneAndUpdate(
        { userId, resourceName },
        { $set: changes },
        { returnDocument: "after" },
      );
    },
    async delete(userId, resourceName) {
      const result = await collection.deleteOne({ userId, resourceName });
      return result.deletedCount === 1;
    },
  };
}

let contactServicePromise: Promise<ReturnType<typeof createWorkspaceContactService>> | undefined;

async function contactService(): Promise<ReturnType<typeof createWorkspaceContactService>> {
  if (!contactServicePromise) {
    contactServicePromise = getMongoDb().then((db) =>
      createWorkspaceContactService(
        mongoRepository(db.collection<WorkspaceContact>(COLLECTION_NAME)),
      ),
    ).catch((error: unknown) => {
      contactServicePromise = undefined;
      if (error instanceof Error && error.message.startsWith("MongoDB")) throw error;
      throw new Error("Workspace contact storage could not be initialized.");
    });
  }
  return contactServicePromise;
}

export async function listWorkspaceContacts(
  userId: string,
  limit = 100,
): Promise<WorkspaceContact[]> {
  return (await contactService()).list(userId, limit);
}

export async function upsertWorkspaceContact(
  userId: string,
  input: unknown,
): Promise<WorkspaceContact> {
  return (await contactService()).upsert(userId, input);
}

export async function syncGoogleContactsToMongo(
  userId: string,
  contacts: unknown[],
  now = new Date(),
): Promise<WorkspaceContact[]> {
  return (await contactService()).sync(userId, contacts, now);
}

export async function updateWorkspaceContactNotes(
  userId: string,
  resourceName: string,
  input: unknown,
): Promise<WorkspaceContact | null> {
  return (await contactService()).updateNotes(userId, resourceName, input);
}

export async function deleteWorkspaceContact(
  userId: string,
  resourceName: string,
): Promise<boolean> {
  return (await contactService()).delete(userId, resourceName);
}

export function serializeWorkspaceContact(contact: WorkspaceContact) {
  return {
    id: contact._id.toHexString(),
    resourceName: contact.resourceName,
    name: contact.name,
    email: contact.email,
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.organization ? { organization: contact.organization } : {}),
    ...(contact.jobTitle ? { jobTitle: contact.jobTitle } : {}),
    ...(contact.photoUrl ? { photoUrl: contact.photoUrl } : {}),
    notes: contact.notes,
    tags: contact.tags,
    relationshipScore: contact.relationshipScore,
    source: contact.source,
    ...(contact.lastSyncedAt ? { lastSyncedAt: contact.lastSyncedAt.toISOString() } : {}),
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}
