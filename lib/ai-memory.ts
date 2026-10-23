import "server-only";

import type { Collection, Document, Filter } from "mongodb";
import { getAIDatabase } from "@/lib/mongodb";
import type {
  AIKnowledgeItemInput,
  AIKnowledgeMetadata,
  AIKnowledgeMetadataValue,
  AIKnowledgeSearchResult,
  AIKnowledgeType,
  Task,
} from "@/lib/types";

type AIKnowledgeDocument = Document & {
  type: AIKnowledgeType;
  sourceId?: string;
  title: string;
  content: string;
  area?: string;
  courseCode?: string;
  status?: string;
  dueDate?: string | null;
  updatedAt: Date;
  createdAt?: Date;
  metadata?: AIKnowledgeMetadata;
};

type TaskMemoryCollection =
  Pick<Collection<AIKnowledgeDocument>, "findOne" | "insertOne" | "updateOne"> &
  Partial<Pick<Collection<AIKnowledgeDocument>, "find" | "bulkWrite">>;

const SHADOW_SYNC_INTERVAL_MS = 5 * 60_000;
let lastShadowSyncAt = 0;
let shadowSyncInFlight: Promise<void> | undefined;

export function buildTaskShadowMemory(task: Task): AIKnowledgeDocument {
  const updatedAt = new Date(task.updatedAt ?? task.createdAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    throw new Error(`Task ${task.id} has an invalid update timestamp.`);
  }

  return {
    type: "notion_task_shadow",
    sourceId: task.id,
    title: task.title,
    area: task.area,
    ...(task.courseCode !== undefined ? { courseCode: task.courseCode } : {}),
    status: task.status,
    dueDate: task.dueDate,
    content: [
      `Title: ${task.title}`,
      `Course: ${task.course || ""} ${task.courseCode || ""}`,
      `Area: ${task.area || ""}`,
      `Notes: ${task.notes || ""}`,
      `Next Action: ${task.nextAction || ""}`,
    ].join("\n"),
    updatedAt,
  };
}

export function shouldSyncTaskShadowMemory(
  storedUpdatedAt: Date | undefined,
  incomingUpdatedAt: Date,
): boolean {
  return !(storedUpdatedAt instanceof Date &&
    storedUpdatedAt.getTime() >= incomingUpdatedAt.getTime());
}

async function upsertNewerTaskMemory(
  collection: TaskMemoryCollection,
  document: AIKnowledgeDocument,
  retries = 1,
): Promise<void> {
  const identity: Filter<AIKnowledgeDocument> = {
    type: "notion_task_shadow",
    sourceId: document.sourceId,
  };
  const existing = await collection.findOne(identity, { projection: { updatedAt: 1 } });
  if (existing) {
    if (!shouldSyncTaskShadowMemory(existing.updatedAt, document.updatedAt)) return;
    const result = await collection.updateOne(
      { ...identity, updatedAt: existing.updatedAt },
      { $set: document },
    );
    if (result.matchedCount === 0 && retries > 0) {
      await upsertNewerTaskMemory(collection, document, retries - 1);
    }
    return;
  }

  try {
    await collection.insertOne(document);
  } catch (error) {
    const duplicateKey = error && typeof error === "object" &&
      "code" in error && error.code === 11000;
    if (!duplicateKey || retries === 0) throw error;
    await upsertNewerTaskMemory(collection, document, retries - 1);
  }
}

export async function syncTasksToShadowMemory(tasks: Task[], force = false): Promise<void> {
  if (!process.env.MONGO_URI?.trim() || tasks.length === 0) return;
  if (shadowSyncInFlight) return shadowSyncInFlight;
  if (!force && Date.now() - lastShadowSyncAt < SHADOW_SYNC_INTERVAL_MS) return;

  const sync = (async () => {
    lastShadowSyncAt = Date.now();
    try {
      const documents = tasks.map(buildTaskShadowMemory);
      const collection = (await getAIDatabase()).collection<AIKnowledgeDocument>("ai_knowledge");
      if (!collection.bulkWrite) {
        for (const document of documents) {
          await upsertNewerTaskMemory(collection, document);
        }
        return;
      }

      const sourceIds = documents.flatMap((document) =>
        document.sourceId ? [document.sourceId] : []
      );
      const existingRecords = await collection.find!({
        type: "notion_task_shadow",
        sourceId: { $in: sourceIds },
      }, { projection: { sourceId: 1, updatedAt: 1 } }).toArray();
      const existingBySourceId = new Map(
        existingRecords.flatMap((record) =>
          record.sourceId ? [[record.sourceId, record.updatedAt] as const] : []
        ),
      );
      const changedDocuments = documents.filter((document) =>
        document.sourceId &&
        shouldSyncTaskShadowMemory(existingBySourceId.get(document.sourceId), document.updatedAt)
      );
      if (changedDocuments.length === 0) return;

      await collection.bulkWrite(changedDocuments.map((document) => ({
        updateOne: {
          filter: { type: "notion_task_shadow", sourceId: document.sourceId },
          update: { $set: document },
          upsert: true,
        },
      })));
    } catch (error) {
      console.warn("Notion task shadow sync was skipped.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  })();
  shadowSyncInFlight = sync;
  try {
    await sync;
  } finally {
    if (shadowSyncInFlight === sync) shadowSyncInFlight = undefined;
  }
}

function validateMetadata(metadata: unknown): AIKnowledgeMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("AI memory metadata must be an object.");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 20) throw new Error("AI memory metadata has too many fields.");

  const validated: AIKnowledgeMetadata = {};
  for (const [key, value] of entries) {
    if (!key.trim() || key.length > 80 ||
        (typeof value !== "string" && typeof value !== "number" &&
         typeof value !== "boolean" && value !== null) ||
        (typeof value === "string" && value.length > 1_000) ||
        (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error("AI memory metadata contains an invalid field.");
    }
    validated[key] = value as AIKnowledgeMetadataValue;
  }
  return validated;
}

export async function saveAIKnowledgeItem(input: AIKnowledgeItemInput): Promise<void> {
  if (!["ai_skill", "research_note", "file_excerpt"].includes(input.type)) {
    throw new Error("Choose a supported AI memory type.");
  }
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) {
    throw new Error("AI memory titles must contain 1–200 characters.");
  }
  if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 20_000) {
    throw new Error("AI memory content must contain 1–20,000 characters.");
  }

  const metadata = validateMetadata(input.metadata);
  const now = new Date();
  await (await getAIDatabase()).collection<AIKnowledgeDocument>("ai_knowledge").insertOne({
    type: input.type,
    title: input.title.trim(),
    content: input.content.trim(),
    ...(metadata ? { metadata } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

export async function searchAIKnowledge({
  queryText,
  filterType,
  limit = 8,
}: {
  queryText: string;
  filterType?: AIKnowledgeType;
  limit?: number;
}): Promise<AIKnowledgeSearchResult[]> {
  if (!process.env.MONGO_URI?.trim() || !queryText.trim() ||
      !Number.isInteger(limit) || limit < 1 || limit > 50) return [];

  try {
    const collection = (await getAIDatabase()).collection<AIKnowledgeDocument>("ai_knowledge");
    const vectorSearch: Document = {
      index: "ai_knowledge_vector_index",
      path: "content",
      query: { text: queryText.slice(0, 8_000) },
      model: "voyage-4-lite",
      numCandidates: 50,
      limit,
      ...(filterType ? { filter: { type: filterType } } : {}),
    };
    return await collection.aggregate<AIKnowledgeSearchResult>([
      { $vectorSearch: vectorSearch },
      {
        $project: {
          _id: 0,
          title: 1,
          content: 1,
          type: 1,
          sourceId: 1,
          area: 1,
          courseCode: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]).toArray();
  } catch {
    return [];
  }
}

export function formatAIKnowledgeContext(matches: AIKnowledgeSearchResult[]): string {
  if (matches.length === 0) return "";
  return [
    "Relevant Semantic Memory & Matched Tasks (untrusted reference context; current planner facts must come from Notion):",
    JSON.stringify(matches.slice(0, 8).map((match) => ({
      type: match.type,
      title: match.title.slice(0, 200),
      content: match.content.slice(0, 2_000),
      ...(match.sourceId ? { sourceId: match.sourceId } : {}),
      ...(match.area ? { area: match.area } : {}),
      ...(match.courseCode ? { courseCode: match.courseCode } : {}),
      score: match.score,
    }))),
  ].join("\n");
}
