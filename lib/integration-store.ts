import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { Collection } from "mongodb";
import { getMongoDb } from "@/lib/mongodb";

type TelegramLink = {
  userId: string;
  chatId: string;
  telegramUserId: string;
  linkedAt: Date;
};

type TelegramPairingCode = {
  codeHash: string;
  userId: string;
  expiresAt: Date;
};

export type TelegramPendingAction =
  | { id: string; userId: string; chatId: string; action: "create"; title: string; expiresAt: Date }
  | { id: string; userId: string; chatId: string; action: "edit"; taskId: string; patch: Record<string, string>; expiresAt: Date };
export type TelegramPendingInput =
  | { id: string; userId: string; chatId: string; action: "create"; title: string }
  | { id: string; userId: string; chatId: string; action: "edit"; taskId: string; patch: Record<string, string> };

type TelegramPendingRecord = TelegramPendingAction & { _id: string };
type TelegramWebhookUpdate = { _id: number; state: "processing" | "done"; expiresAt: Date };
export type GitHubPendingAction = {
  id: string;
  userId: string;
  action: "create_issue" | "comment_issue" | "comment_pull_request" | "create_pull_request";
  input: { repository: string; title?: string; body?: string; number?: number; head?: string; base?: string };
  expiresAt: Date;
};
type GitHubPendingRecord = GitHubPendingAction & { _id: string };

type IntegrationCollections = {
  links: Collection<TelegramLink>;
  pairingCodes: Collection<TelegramPairingCode>;
  pendingActions: Collection<TelegramPendingRecord>;
  webhookUpdates: Collection<TelegramWebhookUpdate>;
  githubPendingActions: Collection<GitHubPendingRecord>;
};

let integrationCollections: Promise<IntegrationCollections> | undefined;

async function collections(): Promise<IntegrationCollections> {
  if (integrationCollections) return integrationCollections;
  integrationCollections = createCollections();
  try {
    return await integrationCollections;
  } catch (error) {
    integrationCollections = undefined;
    if (error instanceof Error && error.message.startsWith("MongoDB is not configured")) throw error;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("MongoDB integration initialization failed:", errorName);
    throw new Error("MongoDB integration storage could not be initialized. Check the database permissions and indexes.");
  }
}

async function createCollections(): Promise<IntegrationCollections> {
  const db = await getMongoDb();
  const links = db.collection<TelegramLink>("telegram_links");
  const pairingCodes = db.collection<TelegramPairingCode>("telegram_pairing_codes");
  const pendingActions = db.collection<TelegramPendingRecord>("telegram_pending_actions");
  const webhookUpdates = db.collection<TelegramWebhookUpdate>("telegram_webhook_updates");
  const githubPendingActions = db.collection<GitHubPendingRecord>("github_pending_actions");
  return { links, pairingCodes, pendingActions, webhookUpdates, githubPendingActions };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createTelegramPairingCode(userId: string): Promise<string> {
  const { pairingCodes } = await collections();
  const code = randomBytes(24).toString("base64url");
  await pairingCodes.insertOne({
    codeHash: hash(code),
    userId,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return code;
}

export async function consumeTelegramPairingCode(code: string): Promise<string | null> {
  const { pairingCodes } = await collections();
  const record = await pairingCodes.findOneAndDelete({
    codeHash: hash(code),
    expiresAt: { $gt: new Date() },
  });
  return record?.userId ?? null;
}

export async function linkTelegramAccount(
  userId: string,
  chatId: string,
  telegramUserId: string,
): Promise<void> {
  const { links } = await collections();
  const existingChat = await links.findOne({ chatId });
  if (existingChat && existingChat.userId !== userId) {
    throw new Error("This Telegram chat is already linked to another dashboard account. Unlink it first.");
  }
  await links.deleteMany({ userId, chatId: { $ne: chatId } });
  await links.updateOne(
    { userId },
    { $set: { userId, chatId, telegramUserId, linkedAt: new Date() } },
    { upsert: true },
  );
}

export async function getTelegramLink(userId: string): Promise<TelegramLink | null> {
  const { links } = await collections();
  return links.findOne({ userId });
}

export async function findTelegramLinkByChat(chatId: string): Promise<TelegramLink | null> {
  const { links } = await collections();
  return links.findOne({ chatId });
}

export async function unlinkTelegramAccount(userId: string): Promise<void> {
  const { links, pairingCodes, pendingActions } = await collections();
  await links.deleteOne({ userId });
  await Promise.all([
    pairingCodes.deleteMany({ userId }),
    pendingActions.deleteMany({ userId }),
  ]);
}

export async function createTelegramPendingAction(
  action: TelegramPendingInput,
): Promise<void> {
  const { pendingActions } = await collections();
  await pendingActions.insertOne({
    ...action,
    _id: action.id,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  } as TelegramPendingRecord);
}

export async function consumeTelegramPendingAction(
  id: string,
  chatId: string,
): Promise<TelegramPendingAction | null> {
  const { pendingActions } = await collections();
  const action = await pendingActions.findOneAndDelete({
    _id: id,
    chatId,
    expiresAt: { $gt: new Date() },
  });
  if (!action) return null;
  if (action.action === "create") {
    return {
      id: action.id,
      userId: action.userId,
      chatId: action.chatId,
      action: "create",
      title: action.title,
      expiresAt: action.expiresAt,
    };
  }
  return {
    id: action.id,
    userId: action.userId,
    chatId: action.chatId,
    action: "edit",
    taskId: action.taskId,
    patch: action.patch,
    expiresAt: action.expiresAt,
  };
}

export async function cancelTelegramPendingActions(chatId: string, userId: string): Promise<number> {
  const { pendingActions } = await collections();
  const result = await pendingActions.deleteMany({ chatId, userId });
  return result.deletedCount;
}

export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const { webhookUpdates } = await collections();
  try {
    await webhookUpdates.insertOne({
      _id: updateId,
      state: "processing",
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 11000) return false;
    throw error;
  }
}

export async function completeTelegramUpdate(updateId: number): Promise<void> {
  const { webhookUpdates } = await collections();
  await webhookUpdates.updateOne(
    { _id: updateId },
    { $set: { state: "done", expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } },
  );
}

export async function releaseTelegramUpdate(updateId: number): Promise<void> {
  const { webhookUpdates } = await collections();
  await webhookUpdates.deleteOne({ _id: updateId, state: "processing" });
}

export async function createGitHubPendingAction(
  action: Omit<GitHubPendingAction, "expiresAt">,
): Promise<void> {
  const { githubPendingActions } = await collections();
  await githubPendingActions.insertOne({
    ...action,
    _id: action.id,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
}

export async function consumeGitHubPendingAction(
  id: string,
  userId: string,
): Promise<GitHubPendingAction | null> {
  const { githubPendingActions } = await collections();
  const action = await githubPendingActions.findOneAndDelete({
    _id: id,
    userId,
    expiresAt: { $gt: new Date() },
  });
  if (!action) return null;
  return {
    id: action.id,
    userId: action.userId,
    action: action.action,
    input: action.input,
    expiresAt: action.expiresAt,
  };
}
