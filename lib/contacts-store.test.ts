import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceContactService,
  serializeWorkspaceContact,
  validateContactNoteUpdate,
  validateWorkspaceContactInput,
  type ContactNoteChanges,
  type WorkspaceContact,
  type WorkspaceContactRepository,
} from "./contacts-store";

class MemoryWorkspaceContactRepository implements WorkspaceContactRepository {
  readonly documents = new Map<string, WorkspaceContact>();

  private key(userId: string, resourceName: string): string {
    return `${userId}:${resourceName}`;
  }

  async list(userId: string, limit: number): Promise<WorkspaceContact[]> {
    return [...this.documents.values()]
      .filter((contact) => contact.userId === userId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit)
      .map((contact) => structuredClone(contact));
  }

  async upsert(contact: WorkspaceContact): Promise<WorkspaceContact> {
    const key = this.key(contact.userId, contact.resourceName);
    const existing = this.documents.get(key);
    const saved = existing
      ? { ...contact, _id: existing._id, createdAt: existing.createdAt }
      : contact;
    this.documents.set(key, structuredClone(saved));
    return structuredClone(saved);
  }

  async sync(contact: WorkspaceContact): Promise<WorkspaceContact> {
    const key = this.key(contact.userId, contact.resourceName);
    const existing = this.documents.get(key);
    const saved = existing
      ? {
          ...contact,
          _id: existing._id,
          createdAt: existing.createdAt,
          notes: existing.notes,
          tags: existing.tags,
          relationshipScore: existing.relationshipScore,
        }
      : contact;
    this.documents.set(key, structuredClone(saved));
    return structuredClone(saved);
  }

  async updateNotes(
    userId: string,
    resourceName: string,
    changes: ContactNoteChanges,
  ): Promise<WorkspaceContact | null> {
    const key = this.key(userId, resourceName);
    const existing = this.documents.get(key);
    if (!existing) return null;
    const updated = { ...existing, ...structuredClone(changes) };
    this.documents.set(key, updated);
    return structuredClone(updated);
  }

  async delete(userId: string, resourceName: string): Promise<boolean> {
    return this.documents.delete(this.key(userId, resourceName));
  }
}

const fixedNow = new Date("2026-10-23T10:00:00.000Z");
const contactInput = {
  resourceName: "people/c123",
  name: "  Ada Lovelace  ",
  email: " ADA@example.com ",
  phone: "+1 555 0100",
  organization: "Analytical Engines",
  jobTitle: "Mathematician",
};

test("validates, normalizes, redacts, and serializes a contact", () => {
  const contact = validateWorkspaceContactInput("user-1", {
    ...contactInput,
    notes: "Call API_KEY=sk-abcdefghijklmnopqrstuvwxyz later",
    tags: [" friend ", "friend", "work"],
  }, fixedNow);

  assert.equal(contact.userId, "user-1");
  assert.equal(contact.name, "Ada Lovelace");
  assert.equal(contact.email, "ada@example.com");
  assert.equal(contact.notes.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.deepEqual(contact.tags, ["friend", "work"]);
  assert.equal(contact.relationshipScore, 80);
  assert.equal(contact.createdAt.toISOString(), fixedNow.toISOString());
  const serialized = serializeWorkspaceContact(contact);
  assert.equal(serialized.id, contact._id.toHexString());
  assert.equal(serialized.createdAt, fixedNow.toISOString());
});

test("isolates contact reads, updates, and deletes by owner", async () => {
  const repository = new MemoryWorkspaceContactRepository();
  const service = createWorkspaceContactService(repository);
  await service.upsert("user-1", { ...contactInput, resourceName: "people/c1" });
  await service.upsert("user-2", { ...contactInput, resourceName: "people/c2" });

  assert.deepEqual((await service.list("user-1")).map((item) => item.resourceName), ["people/c1"]);
  assert.equal(await service.updateNotes("user-1", "people/c2", { notes: "Changed" }), null);
  assert.equal(await service.delete("user-1", "people/c2"), false);
  assert.equal((await service.list("user-2")).length, 1);
  assert.equal(await service.updateNotes("user-2", "people/c1", { notes: "Changed" }), null);
  assert.equal(await service.delete("user-2", "people/c1"), false);
  const updated = await service.updateNotes("user-2", "people/c2", { notes: "Private" });
  assert.equal(updated?.notes, "Private");
  assert.deepEqual(updated?.tags, []);
  assert.equal(updated?.relationshipScore, 80);
  assert.equal(await service.delete("user-2", "people/c2"), true);
});

test("Google sync updates profile data without overwriting private contact metadata", async () => {
  const repository = new MemoryWorkspaceContactRepository();
  const service = createWorkspaceContactService(repository);
  await service.upsert("user-1", {
    ...contactInput,
    notes: "Personal notes",
    tags: ["family"],
    relationshipScore: 42,
  });
  const [synced] = await service.sync("user-1", [{
    ...contactInput,
    name: "Ada Byron",
    email: "ada.byron@example.com",
    organization: "Google",
  }], fixedNow);

  assert.equal(synced.name, "Ada Byron");
  assert.equal(synced.email, "ada.byron@example.com");
  assert.equal(synced.organization, "Google");
  assert.equal(synced.source, "google");
  assert.equal(synced.lastSyncedAt?.toISOString(), fixedNow.toISOString());
  assert.equal(synced.notes, "Personal notes");
  assert.deepEqual(synced.tags, ["family"]);
  assert.equal(synced.relationshipScore, 42);
});

test("rejects invalid ownership, identity, contact fields, and resource identifiers", () => {
  assert.throws(() => validateWorkspaceContactInput("", contactInput), /authenticated user ID/);
  assert.throws(() => validateWorkspaceContactInput(" user-1", contactInput), /authenticated user ID/);
  assert.throws(() => validateWorkspaceContactInput("u".repeat(257), contactInput), /authenticated user ID/);
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, userId: "user-2" }),
    /ownership/,
  );
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, _id: "forged" }),
    /ownership/,
  );
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, notes: { userId: "user-2" } }),
    /ownership/,
  );
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, email: "not-an-email" }),
    /valid address/,
  );
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, photoUrl: "javascript:alert(1)" }),
    /HTTPS URL/,
  );
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, resourceName: "people/c#123" }),
    /resourceName/,
  );
  assert.throws(
    () => validateWorkspaceContactInput("user-1", { ...contactInput, tags: Array(21).fill("tag") }),
    /tags/,
  );
  assert.throws(
    () => validateContactNoteUpdate("user-1", { _id: "forged", notes: "bad" }),
    /ownership/,
  );
  assert.throws(() => validateContactNoteUpdate("user-1", { notes: "x", extra: true }), /unsupported fields/);
});
