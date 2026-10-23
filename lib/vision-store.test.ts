import assert from "node:assert/strict";
import test from "node:test";
import {
  createVisionAnalysisService,
  serializeVisionAnalysis,
  validateVisionAnalysisInput,
  type StoredVisionAnalysis,
  type VisionAnalysisRepository,
} from "./vision-store";

class MemoryVisionAnalysisRepository implements VisionAnalysisRepository {
  readonly documents = new Map<string, StoredVisionAnalysis>();

  async create(analysis: StoredVisionAnalysis): Promise<void> {
    this.documents.set(`${analysis.userId}:${analysis.analysisId}`, structuredClone(analysis));
  }

  async list(userId: string, limit: number): Promise<StoredVisionAnalysis[]> {
    return [...this.documents.values()]
      .filter((analysis) => analysis.userId === userId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((analysis) => structuredClone(analysis));
  }

  async get(userId: string, analysisId: string): Promise<StoredVisionAnalysis | null> {
    const analysis = this.documents.get(`${userId}:${analysisId}`);
    return analysis ? structuredClone(analysis) : null;
  }

  async delete(userId: string, analysisId: string): Promise<boolean> {
    return this.documents.delete(`${userId}:${analysisId}`);
  }
}

const visionInput = {
  title: "Office whiteboard",
  category: "workspace",
  imageSourceType: "url",
  imageUrl: "https://example.com/whiteboard.png",
  featuresRequested: ["LABEL_DETECTION", "TEXT_DETECTION"],
  labelAnnotations: [{ description: "Whiteboard", score: 0.98, topicality: 0.9 }],
  fullTextAnnotation: {
    text: "Action items: API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
    lines: ["Action items:", "API_KEY=sk-abcdefghijklmnopqrstuvwxyz"],
  },
  logoAnnotations: [],
  landmarkAnnotations: [],
  faceAnnotations: [],
  safeSearchAnnotation: {
    adult: "VERY_UNLIKELY",
    spoof: "VERY_UNLIKELY",
    medical: "VERY_UNLIKELY",
    violence: "VERY_UNLIKELY",
    racy: "VERY_UNLIKELY",
    isSafe: true,
  },
  executionEngine: "google-cloud-vision",
};

test("validates, bounds, redacts, and serializes a Vision analysis", () => {
  const analysis = validateVisionAnalysisInput("user-1", visionInput, new Date("2026-10-23T10:00:00.000Z"));

  assert.match(analysis.analysisId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(analysis.imageUrl, "https://example.com/whiteboard.png");
  assert.equal(analysis.fullTextAnnotation?.text.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(analysis.fullTextAnnotation?.lines.join(" ").includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(analysis.safeSearchAnnotation.isSafe, true);
  const serialized = serializeVisionAnalysis(analysis);
  assert.equal(serialized.id, analysis._id.toHexString());
  assert.equal(serialized.createdAt, analysis.createdAt.toISOString());
});

test("rejects data URLs and accepts HTTPS image URLs without retaining base64", () => {
  assert.throws(
    () => validateVisionAnalysisInput("user-1", {
      ...visionInput,
      imageUrl: "data:image/png;base64,iVBORw0KGgo=",
    }),
    /HTTPS URL/,
  );
  const analysis = validateVisionAnalysisInput("user-1", visionInput);
  assert.equal(analysis.imageUrl, "https://example.com/whiteboard.png");
  assert.equal(JSON.stringify(analysis).includes("base64"), false);
});

test("rejects oversized OCR text and limits OCR line count", () => {
  assert.throws(
    () => validateVisionAnalysisInput("user-1", {
      ...visionInput,
      fullTextAnnotation: { text: "x".repeat(50_001), lines: [] },
    }),
    /50,000 characters/,
  );
  assert.throws(
    () => validateVisionAnalysisInput("user-1", {
      ...visionInput,
      fullTextAnnotation: { text: "x", lines: Array(501).fill("line") },
    }),
    /500 strings/,
  );
});

test("isolates Vision reads and deletes by owner", async () => {
  const repository = new MemoryVisionAnalysisRepository();
  const service = createVisionAnalysisService(repository);
  const first = await service.save("user-1", visionInput);
  await service.save("user-2", visionInput);

  assert.equal(await service.get("user-2", first.analysisId), null);
  assert.deepEqual((await service.list("user-1")).map((analysis) => analysis.userId), ["user-1"]);
  assert.equal(await service.delete("user-2", first.analysisId), false);
  assert.equal((await service.get("user-1", first.analysisId))?.analysisId, first.analysisId);
  assert.equal(await service.delete("user-1", first.analysisId), true);
});

test("rejects user ownership fields, invalid users, and malformed analysis inputs", () => {
  assert.throws(() => validateVisionAnalysisInput("", visionInput), /authenticated user ID/);
  assert.throws(() => validateVisionAnalysisInput(" user-1", visionInput), /authenticated user ID/);
  assert.throws(
    () => validateVisionAnalysisInput("user-1", { ...visionInput, userId: "user-2" }),
    /ownership/,
  );
  assert.throws(
    () => validateVisionAnalysisInput("user-1", { ...visionInput, _id: "forged" }),
    /ownership/,
  );
  assert.throws(
    () => validateVisionAnalysisInput("user-1", {
      ...visionInput,
      labelAnnotations: [{ description: "label", score: 0.9, userId: "user-2" }],
    }),
    /ownership/,
  );
  assert.throws(
    () => validateVisionAnalysisInput("user-1", { ...visionInput, category: "finance" }),
    /category/,
  );
  assert.throws(
    () => validateVisionAnalysisInput("user-1", {
      ...visionInput,
      labelAnnotations: [{ description: "label", score: 1.1 }],
    }),
    /score/,
  );
  assert.throws(
    () => validateVisionAnalysisInput("user-1", { ...visionInput, imageUrl: "http://example.com/image.png" }),
    /HTTPS URL/,
  );
});
