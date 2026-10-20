import { getAIDatabase, getMongoDb } from "@/lib/mongodb";

export async function ensureMongoIndexes(): Promise<void> {
  const [appDb, aiDb] = await Promise.all([getMongoDb(), getAIDatabase()]);

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
  ]);
}
