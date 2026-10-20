import "server-only";

import { randomUUID } from "node:crypto";
import { ObjectId, type Collection, type Db } from "mongodb";
import { getAIDatabase } from "@/lib/mongodb";

export const MAX_CONVERSATION_MESSAGES = 24;
export const MAX_CONVERSATION_MESSAGE_LENGTH = 8_000;
export const MAX_CONVERSATION_SUMMARY_LENGTH = 4_000;
export const MAX_CONVERSATION_DOCUMENT_BYTES = 96 * 1024;
export const GEMINI_RECENT_MESSAGE_COUNT = 12;

export type ConversationRole = "user" | "assistant";
export type ConversationMessageStatus = "completed";

export type AIConversationMessage = {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: Date;
  toolName?: "list_tasks";
  toolCallId?: string;
  status?: ConversationMessageStatus;
};

export type AIConversation = {
  _id: ObjectId;
  conversationId: string;
  userId: string;
  title: string;
  summary: string;
  messages: AIConversationMessage[];
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  archivedAt?: Date;
};

export type AIConversationContext = Pick<AIConversation, "summary" | "messages">;

export type ConversationTurnInput = {
  userMessage: string;
  assistantMessage: string;
  toolName?: "list_tasks";
  toolCallId?: string;
  createdAt?: Date;
};

export type ConversationChanges = Pick<
  AIConversation,
  "title" | "summary" | "messages" | "updatedAt" | "lastMessageAt"
>;

export type ConversationRepository = {
  create(conversation: AIConversation): Promise<void>;
  get(userId: string, conversationId: string): Promise<AIConversation | null>;
  list(userId: string, includeArchived: boolean, limit: number): Promise<AIConversation[]>;
  update(
    userId: string,
    conversationId: string,
    expectedUpdatedAt: Date,
    changes: ConversationChanges,
  ): Promise<boolean>;
  archive(userId: string, conversationId: string, archivedAt: Date): Promise<boolean>;
  delete(userId: string, conversationId: string): Promise<boolean>;
};

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bmongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|\d{8,}:[A-Za-z0-9_-]{25,})\b/g,
  /\b(?:api[_-]?key|client[_-]?secret|password|passwd|secret|token|session)\s*[:=]\s*["']?[^,\s"']+/gi,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redactConversationContent(content: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (safe, pattern) => safe.replace(pattern, "[REDACTED]"),
    content,
  );
}

function normalizeContent(content: unknown, maximum: number, field: string): string {
  if (typeof content !== "string" || !content.trim() || content.length > maximum) {
    throw new Error(`${field} must contain 1–${maximum} characters.`);
  }
  return redactConversationContent(content.trim());
}

function safeToolCallId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
    throw new Error("The AI tool-call identifier is invalid.");
  }
  return value;
}

function createTurnMessages(input: ConversationTurnInput): AIConversationMessage[] {
  const start = input.createdAt ?? new Date();
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) {
    throw new Error("The conversation timestamp is invalid.");
  }
  const userMessage = normalizeContent(input.userMessage, 2_000, "User message");
  const assistantMessage = normalizeContent(input.assistantMessage, MAX_CONVERSATION_MESSAGE_LENGTH, "Assistant message");
  const toolCallId = safeToolCallId(input.toolCallId);

  return [
    {
      id: randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: new Date(start.getTime()),
    },
    {
      id: randomUUID(),
      role: "assistant",
      content: assistantMessage,
      createdAt: new Date(start.getTime() + 1),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      status: "completed",
    },
  ];
}

function titleFromMessage(message: string): string {
  const normalized = normalizeContent(message, 2_000, "User message")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}...` : normalized;
}

function summarizeMessages(
  previousSummary: string,
  removed: AIConversationMessage[],
): string {
  const excerpts = removed.map((message) => {
    const text = message.content.replace(/\s+/g, " ").trim();
    return `${message.role}: ${text.slice(0, 180)}`;
  });
  const combined = [previousSummary, ...excerpts].filter(Boolean).join("\n");
  return combined.length > MAX_CONVERSATION_SUMMARY_LENGTH
    ? combined.slice(-MAX_CONVERSATION_SUMMARY_LENGTH)
    : combined;
}

function validateUserId(userId: string): void {
  if (typeof userId !== "string" || !userId.trim() ||
      userId.length > 256 || userId !== userId.trim()) {
    throw new Error("A stable authenticated user ID is required.");
  }
}

export function validateConversationId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("A valid conversation ID is required.");
  }
  return value;
}

export function validateConversationTurn(input: unknown): ConversationTurnInput {
  if (!isPlainObject(input) ||
      Object.keys(input).some((key) => ![
        "userMessage", "assistantMessage", "toolName", "toolCallId", "createdAt",
      ].includes(key))) {
    throw new Error("Conversation input contains unsupported fields.");
  }
  if (input.toolName !== undefined && input.toolName !== "list_tasks") {
    throw new Error("The conversation tool is unsupported.");
  }
  const createdAt = input.createdAt === undefined ? undefined : input.createdAt;
  if (createdAt !== undefined && (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime()))) {
    throw new Error("The conversation timestamp is invalid.");
  }
  const turn: ConversationTurnInput = {
    userMessage: normalizeContent(input.userMessage, 2_000, "User message"),
    assistantMessage: normalizeContent(input.assistantMessage, MAX_CONVERSATION_MESSAGE_LENGTH, "Assistant message"),
    ...(input.toolName === "list_tasks" ? { toolName: "list_tasks" as const } : {}),
    ...(input.toolCallId !== undefined
      ? { toolCallId: safeToolCallId(input.toolCallId) }
      : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
  return turn;
}

function validateConversationDocument(conversation: AIConversation): void {
  const bytes = Buffer.byteLength(JSON.stringify(conversation), "utf8");
  if (bytes > MAX_CONVERSATION_DOCUMENT_BYTES) {
    throw new Error("The conversation has reached its storage size limit.");
  }
}

export function createAIConversationService(repository: ConversationRepository) {
  return {
    async create(userId: string, conversationId: string, input: unknown): Promise<AIConversation> {
      validateUserId(userId);
      validateConversationId(conversationId);
      const turn = validateConversationTurn(input);
      const messages = createTurnMessages(turn);
      const now = messages[1].createdAt;
      const conversation: AIConversation = {
        _id: new ObjectId(),
        conversationId,
        userId,
        title: titleFromMessage(turn.userMessage),
        summary: `Started with: ${titleFromMessage(turn.userMessage)}`,
        messages,
        createdAt: messages[0].createdAt,
        updatedAt: now,
        lastMessageAt: now,
      };
      validateConversationDocument(conversation);
      await repository.create(conversation);
      return conversation;
    },

    async append(userId: string, conversationId: string, input: unknown): Promise<AIConversation | null> {
      validateUserId(userId);
      validateConversationId(conversationId);
      const turn = validateConversationTurn(input);
      const existing = await repository.get(userId, conversationId);
      if (!existing || existing.archivedAt) return null;

      const proposedStart = (turn.createdAt ?? new Date()).getTime();
      const additions = createTurnMessages({
        ...turn,
        createdAt: new Date(Math.max(proposedStart, existing.updatedAt.getTime() + 1)),
      });
      const messages = [...existing.messages, ...additions]
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      const overflow = Math.max(0, messages.length - MAX_CONVERSATION_MESSAGES);
      const removed = messages.slice(0, overflow);
      const retained = messages.slice(overflow);
      let summary = summarizeMessages(existing.summary, removed);
      const changes: ConversationChanges = {
        title: existing.title,
        summary,
        messages: retained,
        updatedAt: additions[1].createdAt,
        lastMessageAt: additions[1].createdAt,
      };
      let updated = { ...existing, ...changes };
      while (Buffer.byteLength(JSON.stringify(updated), "utf8") > MAX_CONVERSATION_DOCUMENT_BYTES &&
          changes.messages.length > 2) {
        const pruned = changes.messages.splice(0, Math.min(2, changes.messages.length - 2));
        summary = summarizeMessages(summary, pruned);
        changes.summary = summary;
        updated = { ...existing, ...changes };
      }
      validateConversationDocument(updated);
      const saved = await repository.update(
        userId,
        conversationId,
        existing.updatedAt,
        changes,
      );
      if (!saved) throw new Error("The conversation changed during this request. Please retry.");
      return updated;
    },

    async get(userId: string, conversationId: string): Promise<AIConversation | null> {
      validateUserId(userId);
      validateConversationId(conversationId);
      return repository.get(userId, conversationId);
    },

    async list(userId: string, includeArchived = false, limit = 50): Promise<AIConversation[]> {
      validateUserId(userId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Conversation limit must be an integer from 1 to 100.");
      }
      return repository.list(userId, includeArchived, limit);
    },

    async archive(userId: string, conversationId: string): Promise<boolean> {
      validateUserId(userId);
      validateConversationId(conversationId);
      return repository.archive(userId, conversationId, new Date());
    },

    async delete(userId: string, conversationId: string): Promise<boolean> {
      validateUserId(userId);
      validateConversationId(conversationId);
      return repository.delete(userId, conversationId);
    },

    async context(userId: string, conversationId: string): Promise<AIConversationContext | null> {
      const conversation = await this.get(userId, conversationId);
      if (!conversation || conversation.archivedAt) return null;
      return {
        summary: conversation.summary.slice(-MAX_CONVERSATION_SUMMARY_LENGTH),
        messages: conversation.messages.slice(-GEMINI_RECENT_MESSAGE_COUNT),
      };
    },
  };
}

function mongoRepository(collection: Collection<AIConversation>): ConversationRepository {
  return {
    async create(conversation) {
      await collection.insertOne(conversation);
    },
    get(userId, conversationId) {
      return collection.findOne({ userId, conversationId });
    },
    list(userId, includeArchived, limit) {
      const filter = {
        userId,
        conversationId: { $type: "string" as const },
        ...(includeArchived ? {} : { archivedAt: { $exists: false } }),
      };
      return collection.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();
    },
    async update(userId, conversationId, expectedUpdatedAt, changes) {
      const result = await collection.updateOne(
        { userId, conversationId, updatedAt: expectedUpdatedAt, archivedAt: { $exists: false } },
        { $set: changes },
      );
      return result.modifiedCount === 1;
    },
    async archive(userId, conversationId, archivedAt) {
      const result = await collection.updateOne(
        { userId, conversationId, archivedAt: { $exists: false } },
        { $set: { archivedAt, updatedAt: archivedAt } },
      );
      return result.modifiedCount === 1;
    },
    async delete(userId, conversationId) {
      const result = await collection.deleteOne({ userId, conversationId });
      return result.deletedCount === 1;
    },
  };
}

let conversationServicePromise: Promise<ReturnType<typeof createAIConversationService>> | undefined;

async function conversationService(): Promise<ReturnType<typeof createAIConversationService>> {
  if (!conversationServicePromise) {
    conversationServicePromise = getAIDatabase().then((db: Db) => {
      const collection = db.collection<AIConversation>("ai_conversations");
      return createAIConversationService(mongoRepository(collection));
    }).catch((error: unknown) => {
      conversationServicePromise = undefined;
      if (error instanceof Error && error.message.startsWith("MongoDB")) throw error;
      throw new Error("AI conversation storage could not be initialized.");
    });
  }
  return conversationServicePromise;
}

export function newAIConversationId(): string {
  return randomUUID();
}

export async function createAIConversation(
  userId: string,
  conversationId: string,
  input: unknown,
): Promise<AIConversation> {
  return (await conversationService()).create(userId, conversationId, input);
}

export async function appendAIConversationTurn(
  userId: string,
  conversationId: string,
  input: unknown,
): Promise<AIConversation | null> {
  return (await conversationService()).append(userId, conversationId, input);
}

export async function getAIConversation(
  userId: string,
  conversationId: string,
): Promise<AIConversation | null> {
  return (await conversationService()).get(userId, conversationId);
}

export async function listAIConversations(
  userId: string,
  includeArchived = false,
  limit = 50,
): Promise<AIConversation[]> {
  return (await conversationService()).list(userId, includeArchived, limit);
}

export async function archiveAIConversation(userId: string, conversationId: string): Promise<boolean> {
  return (await conversationService()).archive(userId, conversationId);
}

export async function deleteAIConversation(userId: string, conversationId: string): Promise<boolean> {
  return (await conversationService()).delete(userId, conversationId);
}

export async function getAIConversationContext(
  userId: string,
  conversationId: string,
): Promise<AIConversationContext | null> {
  return (await conversationService()).context(userId, conversationId);
}

export function serializeAIConversation(conversation: AIConversation) {
  return {
    conversationId: conversation.conversationId,
    title: conversation.title,
    summary: conversation.summary,
    messages: conversation.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    ...(conversation.archivedAt ? { archivedAt: conversation.archivedAt.toISOString() } : {}),
  };
}
