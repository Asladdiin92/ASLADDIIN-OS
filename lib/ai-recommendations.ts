import "server-only";

import { ObjectId, type Collection } from "mongodb";
import { getMongoDb } from "@/lib/mongodb";
import { isRecommendationCurrent } from "@/lib/task-scoring";
import type { Task } from "@/lib/types";

export type StoredRecommendation = {
  _id: ObjectId;
  userId: string;
  taskId: string;
  taskFingerprint: string;
  taskTitle: string;
  score: number;
  label: string;
  factors: Array<{ key: string; points: number; evidence: string }>;
  explanation: { reason: string; firstStep: string };
  explanationSource: "ai" | "fallback";
  status: "active" | "dismissed" | "invalidated";
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  dismissedAt?: Date;
};

type NewRecommendation = Omit<StoredRecommendation, "_id" | "userId" | "status" | "createdAt" | "updatedAt">;
type RecommendationFingerprint = { taskId: string; taskFingerprint: string };
let collectionPromise: Promise<Collection<StoredRecommendation>> | undefined;

async function recommendationCollection(): Promise<Collection<StoredRecommendation>> {
  if (!collectionPromise) {
    collectionPromise = getMongoDb().then((db) =>
      db.collection<StoredRecommendation>("ai_recommendations")
    ).catch((error: unknown) => {
      collectionPromise = undefined;
      if (error instanceof Error && error.message.startsWith("MongoDB")) throw error;
      throw new Error("Recommendation storage could not be initialized.");
    });
  }
  return collectionPromise;
}

export async function getDismissedRecommendationTaskIds(userId: string): Promise<Set<string>> {
  const collection = await recommendationCollection();
  const records = await collection.find(
    { userId, status: "dismissed" },
    { projection: { _id: 0, taskId: 1 } },
  ).toArray();
  return new Set(records.map((record) => record.taskId));
}

export async function getCurrentRecommendation(
  userId: string,
  taskId: string,
  taskFingerprint: string,
  now = new Date(),
): Promise<StoredRecommendation | null> {
  const collection = await recommendationCollection();
  return collection.findOne({
    userId,
    taskId,
    taskFingerprint,
    status: "active",
    expiresAt: { $gt: now },
  });
}

export async function getCurrentRecommendations(
  userId: string,
  fingerprints: RecommendationFingerprint[],
  now = new Date(),
): Promise<Map<string, StoredRecommendation>> {
  if (fingerprints.length === 0) return new Map();

  const collection = await recommendationCollection();
  const taskFingerprints = new Map(fingerprints.map(({ taskId, taskFingerprint }) => [taskId, taskFingerprint]));
  const records = await collection.find({
    userId,
    taskId: { $in: fingerprints.map(({ taskId }) => taskId) },
    status: "active",
    expiresAt: { $gt: now },
  }).toArray();

  return new Map(records
    .filter((record) => taskFingerprints.get(record.taskId) === record.taskFingerprint)
    .map((record) => [record.taskId, record]));
}

export async function invalidateStaleRecommendations(userId: string, tasks: Task[], now = new Date()): Promise<void> {
  const collection = await recommendationCollection();
  const active = await collection.find(
    { userId, status: "active" },
    { projection: { taskId: 1, taskFingerprint: 1 } },
  ).toArray();
  const staleIds = active
    .filter((recommendation) => !isRecommendationCurrent(recommendation, tasks))
    .map((recommendation) => recommendation._id);
  if (staleIds.length) {
    await collection.updateMany(
      { _id: { $in: staleIds }, userId, status: "active" },
      { $set: { status: "invalidated", updatedAt: now }, $unset: { expiresAt: "" } },
    );
  }
}

export async function invalidateRecommendationForTask(userId: string, taskId: string, now = new Date()): Promise<void> {
  const collection = await recommendationCollection();
  await collection.updateOne(
    { userId, taskId, status: "active" },
    { $set: { status: "invalidated", updatedAt: now }, $unset: { expiresAt: "" } },
  );
}

export async function storeRecommendation(
  userId: string,
  recommendation: NewRecommendation,
  now = new Date(),
): Promise<StoredRecommendation | null> {
  const collection = await recommendationCollection();
  try {
    return await collection.findOneAndUpdate(
      { userId, taskId: recommendation.taskId, status: { $ne: "dismissed" } },
      {
        $set: {
          ...recommendation,
          userId,
          status: "active",
          updatedAt: now,
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 11000) throw error;
    return null;
  }
}

export async function dismissRecommendation(userId: string, recommendationId: string, now = new Date()): Promise<boolean> {
  if (!ObjectId.isValid(recommendationId) || new ObjectId(recommendationId).toHexString() !== recommendationId.toLowerCase()) {
    return false;
  }
  const collection = await recommendationCollection();
  const result = await collection.updateOne(
    { _id: new ObjectId(recommendationId), userId, status: "active" },
    {
      $set: { status: "dismissed", dismissedAt: now, updatedAt: now },
      $unset: { expiresAt: "" },
    },
  );
  return result.modifiedCount === 1;
}
