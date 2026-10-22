import type { SearchIndexDescription } from "mongodb";
import { getAIDatabase, getMongoDb } from "@/lib/mongodb";

export const AI_KNOWLEDGE_VECTOR_INDEX: SearchIndexDescription = {
  name: "ai_knowledge_vector_index",
  type: "vectorSearch",
  definition: {
    fields: [
      {
        type: "autoEmbed",
        modality: "text",
        path: "content",
        model: "voyage-4",
      },
      { type: "filter", path: "type" },
      { type: "filter", path: "courseCode" },
      { type: "filter", path: "area" },
    ],
  },
};

export type AiKnowledgeSearchCollection = {
  listSearchIndexes(): { toArray(): Promise<Array<{ name?: string }>> };
  createSearchIndex(description: SearchIndexDescription): Promise<string>;
};

export async function ensureAiKnowledgeVectorIndex(
  collection: AiKnowledgeSearchCollection,
): Promise<void> {
  try {
    const indexes = await collection.listSearchIndexes().toArray();
    if (indexes.some((index) => index.name === AI_KNOWLEDGE_VECTOR_INDEX.name)) return;
  } catch {
    // Continue to creation when listing search indexes is unsupported.
  }

  try {
    await collection.createSearchIndex(AI_KNOWLEDGE_VECTOR_INDEX);
  } catch (error) {
    console.warn("MongoDB Atlas vector search index setup was skipped.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function ensureMongoIndexes(): Promise<void> {
  const [appDb, aiDb] = await Promise.all([getMongoDb(), getAIDatabase()]);
  const knowledgeCollection = aiDb.collection("ai_knowledge");

  await Promise.all([
    appDb.collection("activities").createIndex({ userId: 1, occurredAt: -1, _id: -1 }),
    appDb.collection("activities").createIndex({ userId: 1, type: 1 }),
    appDb.collection("activities").createIndex(
      { userId: 1, idempotencyKey: 1 },
      { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
    ),
    appDb.collection("ai_recommendations").createIndex(
      { userId: 1, taskId: 1 },
      { unique: true },
    ),
    appDb.collection("ai_recommendations").createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, partialFilterExpression: { status: "active" } },
    ),
    appDb.collection("ai_recommendations").createIndex({ userId: 1, status: 1 }),
    appDb.collection("telegram_links").createIndex({ userId: 1 }, { unique: true }),
    appDb.collection("telegram_links").createIndex({ chatId: 1 }, { unique: true }),
    appDb.collection("telegram_pairing_codes").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    appDb.collection("telegram_pending_actions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    appDb.collection("telegram_webhook_updates").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    appDb.collection("github_pending_actions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    aiDb.collection("ai_conversations").createIndex({ userId: 1, updatedAt: -1 }),
    aiDb.collection("ai_conversations").createIndex(
      { conversationId: 1 },
      { unique: true, partialFilterExpression: { conversationId: { $type: "string" } } },
    ),
    knowledgeCollection.createIndex(
      { type: 1, sourceId: 1 },
      { unique: true, partialFilterExpression: { sourceId: { $exists: true } } },
    ),
    knowledgeCollection.createIndex({ updatedAt: -1 }),
    ensureAiKnowledgeVectorIndex(knowledgeCollection),
  ]);
}
