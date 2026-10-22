import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_KNOWLEDGE_VECTOR_INDEX,
  ensureAiKnowledgeVectorIndex,
  type AiKnowledgeSearchCollection,
} from "./mongodb-indexes";

test("creates the AI knowledge auto-embedding vector search index", async () => {
  const created: unknown[] = [];
  const collection: AiKnowledgeSearchCollection = {
    listSearchIndexes: () => ({ toArray: async () => [] }),
    createSearchIndex: async (description) => {
      created.push(description);
      return description.name ?? "";
    },
  };

  await ensureAiKnowledgeVectorIndex(collection);

  assert.deepEqual(created, [{
    name: "ai_knowledge_vector_index",
    type: "vectorSearch",
    definition: {
      fields: [
        { type: "autoEmbed", modality: "text", path: "content", model: "voyage-4" },
        { type: "filter", path: "type" },
        { type: "filter", path: "courseCode" },
        { type: "filter", path: "area" },
      ],
    },
  }]);
  assert.deepEqual(AI_KNOWLEDGE_VECTOR_INDEX, created[0]);
});

test("does not recreate an existing AI knowledge vector search index", async () => {
  let creationCount = 0;
  const collection: AiKnowledgeSearchCollection = {
    listSearchIndexes: () => ({
      toArray: async () => [{ name: AI_KNOWLEDGE_VECTOR_INDEX.name }],
    }),
    createSearchIndex: async () => {
      creationCount += 1;
      return AI_KNOWLEDGE_VECTOR_INDEX.name ?? "";
    },
  };

  await ensureAiKnowledgeVectorIndex(collection);

  assert.equal(creationCount, 0);
});

test("keeps index setup available when Atlas search indexes are unsupported", async () => {
  let creationAttempted = false;
  const collection: AiKnowledgeSearchCollection = {
    listSearchIndexes: () => ({
      toArray: async () => {
        throw new Error("Search indexes are not supported");
      },
    }),
    createSearchIndex: async () => {
      creationAttempted = true;
      return AI_KNOWLEDGE_VECTOR_INDEX.name ?? "";
    },
  };

  await ensureAiKnowledgeVectorIndex(collection);

  assert.equal(creationAttempted, true);
});
