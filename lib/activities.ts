import "server-only";

import { createHash } from "node:crypto";
import { ObjectId, type Collection } from "mongodb";
import { getMongoDb } from "@/lib/mongodb";

export const ACTIVITY_TYPES = [
  "task_created",
  "task_updated",
  "task_completed",
  "project_updated",
  "note_created",
  "note_updated",
  "focus_started",
  "focus_completed",
  "ai_plan_generated",
  "ai_recommendation_generated",
  "notion_sync_completed",
] as const;

export const ACTIVITY_SOURCES = ["notion", "dashboard", "ai", "focus", "system"] as const;

export type ActivityType = typeof ACTIVITY_TYPES[number];
export type ActivitySource = typeof ACTIVITY_SOURCES[number];
export type Activity = {
  _id: ObjectId;
  userId: string;
  type: ActivityType;
  source: ActivitySource;
  title: string;
  description?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
type ActivityDocument = Omit<Activity, "_id"> & { _id?: ObjectId; idempotencyKey?: string };
type ActivityCursor = { occurredAt: Date; id: ObjectId };
export type ActivityPage = { activities: Activity[]; nextCursor: string | null };

const COLLECTION_NAME = "activities";
export const MAX_ACTIVITY_PAGE_SIZE = 50;
const MAX_METADATA_BYTES = 4096;
const MAX_METADATA_DEPTH = 5;
const SENSITIVE_KEY = /(?:secret|password|passwd|token|authorization|cookie|credential|api.?key|private.?key|email|phone|address|access.?key)/i;
const SENSITIVE_VALUE = [
  /\bBearer\s+\S+/i,
  /\bmongodb(?:\+srv)?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:sk|pk|ghp|github_pat|AIza)[-_][A-Za-z0-9_-]{12,}\b/i,
];

export type NewActivity = {
  type: ActivityType;
  source: ActivitySource;
  title: string;
  description?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateMetadataValue(value: unknown, depth: number): void {
  if (depth > MAX_METADATA_DEPTH) throw new Error("Activity metadata is nested too deeply.");
  if (typeof value === "string") {
    if (value.length > 1000 || SENSITIVE_VALUE.some((pattern) => pattern.test(value))) {
      throw new Error("Activity metadata must not contain sensitive values.");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Activity metadata numbers must be finite.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new Error("Activity metadata contains too many values.");
    value.forEach((item) => validateMetadataValue(item, depth + 1));
    return;
  }
  if (!isPlainObject(value)) throw new Error("Activity metadata must contain only JSON values.");
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error("Activity metadata must not contain sensitive fields.");
    validateMetadataValue(nested, depth + 1);
  }
}

function withoutIdempotencyKey(document: ActivityDocument): Activity {
  const activity = { ...document };
  delete activity.idempotencyKey;
  return activity as Activity;
}

function optionalText(input: Record<string, unknown>, field: string, maximum: number): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`Activity ${field} must be ${maximum} characters or fewer.`);
  }
  return value;
}

export function validateActivityInput(
  authenticatedUserId: string,
  input: unknown,
  now = new Date(),
): Omit<Activity, "_id"> {
  if (typeof authenticatedUserId !== "string" || !authenticatedUserId.trim() ||
      authenticatedUserId.length > 256 || authenticatedUserId !== authenticatedUserId.trim()) {
    throw new Error("A stable authenticated user ID is required to record an activity.");
  }
  if (!isPlainObject(input)) throw new Error("Activity input must be an object.");
  const allowedFields = new Set([
    "type", "source", "title", "description", "entityType", "entityId", "metadata", "occurredAt",
  ]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    throw new Error("Activity input contains unsupported fields; user ownership is server-controlled.");
  }
  if (!ACTIVITY_TYPES.includes(input.type as ActivityType)) {
    throw new Error("Choose a supported activity type.");
  }
  if (!ACTIVITY_SOURCES.includes(input.source as ActivitySource)) {
    throw new Error("Choose a supported activity source.");
  }
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) {
    throw new Error("Activity title must contain 1–200 characters.");
  }
  const description = optionalText(input, "description", 1000);
  const entityType = optionalText(input, "entityType", 80);
  const entityId = optionalText(input, "entityId", 200);
  if (input.metadata !== undefined) {
    if (!isPlainObject(input.metadata)) throw new Error("Activity metadata must be a plain object.");
    validateMetadataValue(input.metadata, 0);
    if (Buffer.byteLength(JSON.stringify(input.metadata), "utf8") > MAX_METADATA_BYTES) {
      throw new Error("Activity metadata must be 4 KB or smaller.");
    }
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Activity timestamp is invalid.");
  }
  const occurredAt = input.occurredAt === undefined ? now : input.occurredAt;
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
    throw new Error("Activity timestamp is invalid.");
  }
  const timestamp = new Date(now.getTime());
  return {
    userId: authenticatedUserId,
    type: input.type as ActivityType,
    source: input.source as ActivitySource,
    title: input.title.trim(),
    ...(description !== undefined ? { description } : {}),
    ...(entityType !== undefined ? { entityType } : {}),
    ...(entityId !== undefined ? { entityId } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    occurredAt: new Date(occurredAt.getTime()),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

let activityCollectionPromise: Promise<Collection<ActivityDocument>> | undefined;

async function activityCollection(): Promise<Collection<ActivityDocument>> {
  if (!activityCollectionPromise) {
    activityCollectionPromise = getMongoDb().then(async (db) => {
      return db.collection<ActivityDocument>(COLLECTION_NAME);
    }).catch((error: unknown) => {
      activityCollectionPromise = undefined;
      if (error instanceof Error && error.message.startsWith("MongoDB")) throw error;
      throw new Error("Activity storage could not be initialized.");
    });
  }
  return activityCollectionPromise;
}

export function createActivityIdempotencyKey(
  authenticatedUserId: string,
  type: ActivityType,
  operationKey: string,
): string {
  return createHash("sha256")
    .update(`${authenticatedUserId}\0${type}\0${operationKey}`)
    .digest("hex");
}

export function encodeActivityCursor(activity: Pick<Activity, "_id" | "occurredAt">): string {
  return Buffer.from(JSON.stringify({
    occurredAt: activity.occurredAt.toISOString(),
    id: activity._id.toHexString(),
  })).toString("base64url");
}

export function decodeActivityCursor(value: string): ActivityCursor {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid activities cursor.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid activities cursor.");
    }
    const cursor = parsed as Record<string, unknown>;
    if (Object.keys(cursor).length !== 2 || typeof cursor.occurredAt !== "string" ||
        typeof cursor.id !== "string" || !ObjectId.isValid(cursor.id) ||
        new ObjectId(cursor.id).toHexString() !== cursor.id.toLowerCase()) {
      throw new Error("Invalid activities cursor.");
    }
    const occurredAt = new Date(cursor.occurredAt);
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== cursor.occurredAt) {
      throw new Error("Invalid activities cursor.");
    }
    return { occurredAt, id: new ObjectId(cursor.id) };
  } catch {
    throw new Error("Invalid activities cursor.");
  }
}

export async function recordActivity(
  authenticatedUserId: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<Activity> {
  const activity = validateActivityInput(authenticatedUserId, input);
  if (idempotencyKey !== undefined &&
      (typeof idempotencyKey !== "string" || !/^[a-f0-9]{64}$/.test(idempotencyKey))) {
    throw new Error("Activity idempotency key is invalid.");
  }
  const collection = await activityCollection();
  const document: ActivityDocument = {
    ...activity,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  try {
    const result = await collection.insertOne(document);
    return { ...activity, _id: result.insertedId };
  } catch (error) {
    if (idempotencyKey && error && typeof error === "object" &&
        "code" in error && error.code === 11000) {
      const existing = await collection.findOne({ userId: authenticatedUserId, idempotencyKey });
      if (existing) return withoutIdempotencyKey(existing);
    }
    throw new Error("Activity storage could not save the event.");
  }
}

export async function listActivities(
  authenticatedUserId: string,
  limit: number,
  cursor?: string,
): Promise<ActivityPage> {
  if (typeof authenticatedUserId !== "string" || !authenticatedUserId.trim() ||
      authenticatedUserId.length > 256 || authenticatedUserId !== authenticatedUserId.trim()) {
    throw new Error("A stable authenticated user ID is required to list activities.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_PAGE_SIZE) {
    throw new Error("Activity page size is invalid.");
  }
  const after = cursor !== undefined ? decodeActivityCursor(cursor) : undefined;
  const collection = await activityCollection();
  const filter = after
    ? {
        userId: authenticatedUserId,
        $or: [
          { occurredAt: { $lt: after.occurredAt } },
          { occurredAt: after.occurredAt, _id: { $lt: after.id } },
        ],
      }
    : { userId: authenticatedUserId };
  const documents = await collection.find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = documents.length > limit;
  const activities = documents.slice(0, limit).map(withoutIdempotencyKey);
  return {
    activities,
    nextCursor: hasMore ? encodeActivityCursor(activities[activities.length - 1]) : null,
  };
}
