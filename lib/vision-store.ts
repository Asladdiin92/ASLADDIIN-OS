import "server-only";

import { randomUUID } from "node:crypto";
import { ObjectId, type Collection } from "mongodb";
import { redactConversationContent } from "@/lib/ai-conversations";
import { getMongoDb } from "@/lib/mongodb";

const COLLECTION_NAME = "vision_analyses";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const VISION_FEATURES = [
  "LABEL_DETECTION",
  "TEXT_DETECTION",
  "LOGO_DETECTION",
  "LANDMARK_DETECTION",
  "FACE_DETECTION",
  "SAFE_SEARCH_DETECTION",
] as const;
export type VisionFeature = typeof VISION_FEATURES[number];

export const SAFE_SEARCH_LIKELIHOODS = [
  "UNKNOWN",
  "VERY_UNLIKELY",
  "UNLIKELY",
  "POSSIBLE",
  "LIKELY",
  "VERY_LIKELY",
] as const;
export type SafeSearchLikelihood = typeof SAFE_SEARCH_LIKELIHOODS[number];

export type StoredVisionAnalysis = {
  _id: ObjectId;
  analysisId: string;
  userId: string;
  title: string;
  category: "workspace" | "events" | "team" | "documents";
  photoId?: string;
  imageSourceType: "url" | "upload" | "workspace" | "preset";
  imageUrl?: string;
  featuresRequested: VisionFeature[];
  labelAnnotations: Array<{ description: string; score: number; topicality?: number }>;
  fullTextAnnotation: { text: string; lines: string[] } | null;
  logoAnnotations: Array<{ description: string; score: number }>;
  landmarkAnnotations: Array<{
    description: string;
    score: number;
    latitude?: number;
    longitude?: number;
  }>;
  faceAnnotations: Array<{
    faceIndex: number;
    confidence: number;
    joyLikelihood: string;
    surpriseLikelihood: string;
    sorrowLikelihood: string;
    angerLikelihood: string;
    headwearLikelihood: string;
  }>;
  safeSearchAnnotation: {
    adult: string;
    spoof: string;
    medical: string;
    violence: string;
    racy: string;
    isSafe: boolean;
  };
  executionEngine: string;
  createdAt: Date;
};

export type VisionAnalysisRepository = {
  create(analysis: StoredVisionAnalysis): Promise<void>;
  list(userId: string, limit: number): Promise<StoredVisionAnalysis[]>;
  get(userId: string, analysisId: string): Promise<StoredVisionAnalysis | null>;
  delete(userId: string, analysisId: string): Promise<boolean>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateUserId(userId: string): void {
  if (typeof userId !== "string" || !userId || userId !== userId.trim() || userId.length > 256) {
    throw new Error("A stable authenticated user ID is required.");
  }
}

function validateNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The analysis timestamp is invalid.");
  }
  return new Date(now.getTime());
}

function rejectOwnershipFields(input: Record<string, unknown>): void {
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (!Array.isArray(value) && ("userId" in value || "_id" in value)) {
      throw new Error("Analysis ownership and database IDs are server-controlled.");
    }
    Object.values(value).forEach(visit);
  };
  visit(input);
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`Analysis ${field} must contain 1–${maximum} characters.`);
  }
  return value.trim();
}

function optionalText(
  input: Record<string, unknown>,
  field: string,
  maximum: number,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  return requiredText(value, field, maximum);
}

function validateScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Analysis ${field} must be a number from 0 to 1.`);
  }
  return value;
}

function validateLikelihood(value: unknown, field: string): SafeSearchLikelihood {
  if (typeof value !== "string" ||
      !SAFE_SEARCH_LIKELIHOODS.includes(value as SafeSearchLikelihood)) {
    throw new Error(`Analysis ${field} must be a supported likelihood.`);
  }
  return value as SafeSearchLikelihood;
}

function validateAnnotations<T>(
  value: unknown,
  field: string,
  maximum: number,
  validate: (item: Record<string, unknown>) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Analysis ${field} contains too many items.`);
  }
  return value.map((item) => {
    if (!isPlainObject(item)) throw new Error(`Analysis ${field} items must be plain objects.`);
    return validate(item);
  });
}

function validateFeatures(value: unknown): VisionFeature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > VISION_FEATURES.length ||
      value.some((feature) => typeof feature !== "string" ||
        !VISION_FEATURES.includes(feature as VisionFeature))) {
    throw new Error("Analysis featuresRequested contains an unsupported feature.");
  }
  return [...new Set(value as VisionFeature[])];
}

function validateFullText(value: unknown): StoredVisionAnalysis["fullTextAnnotation"] {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || typeof value.text !== "string" || value.text.length > 50_000) {
    throw new Error("Analysis OCR text must be 50,000 characters or fewer.");
  }
  if (value.lines !== undefined &&
      (!Array.isArray(value.lines) || value.lines.length > 500 ||
        value.lines.some((line) => typeof line !== "string"))) {
    throw new Error("Analysis OCR lines must contain at most 500 strings.");
  }
  const text = redactConversationContent(value.text);
  const lines = value.lines === undefined
    ? text.split(/\r?\n/).slice(0, 500)
    : (value.lines as string[]).map((line) => redactConversationContent(line));
  if (lines.join("\n").length > 50_000) {
    throw new Error("Analysis OCR lines must total 50,000 characters or fewer.");
  }
  return { text, lines };
}

function validateSafeSearch(value: unknown): StoredVisionAnalysis["safeSearchAnnotation"] {
  const input = value === undefined ? {} : value;
  if (!isPlainObject(input)) throw new Error("Analysis safe-search annotation must be an object.");
  const result = {
    adult: input.adult ?? "UNKNOWN",
    spoof: input.spoof ?? "UNKNOWN",
    medical: input.medical ?? "UNKNOWN",
    violence: input.violence ?? "UNKNOWN",
    racy: input.racy ?? "UNKNOWN",
    isSafe: input.isSafe ?? false,
  };
  if (typeof result.isSafe !== "boolean") {
    throw new Error("Analysis safe-search isSafe must be a boolean.");
  }
  return {
    adult: validateLikelihood(result.adult, "adult"),
    spoof: validateLikelihood(result.spoof, "spoof"),
    medical: validateLikelihood(result.medical, "medical"),
    violence: validateLikelihood(result.violence, "violence"),
    racy: validateLikelihood(result.racy, "racy"),
    isSafe: result.isSafe,
  };
}

export function validateVisionAnalysisInput(
  userId: string,
  input: unknown,
  now = new Date(),
): StoredVisionAnalysis {
  validateUserId(userId);
  if (!isPlainObject(input)) throw new Error("Analysis input must be a plain object.");
  rejectOwnershipFields(input);
  const allowedFields = new Set([
    "title", "category", "photoId", "imageSourceType", "imageUrl", "featuresRequested",
    "labelAnnotations", "fullTextAnnotation", "logoAnnotations", "landmarkAnnotations",
    "faceAnnotations", "safeSearchAnnotation", "executionEngine",
  ]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    throw new Error("Analysis input contains unsupported fields.");
  }
  const categories = ["workspace", "events", "team", "documents"] as const;
  const sourceTypes = ["url", "upload", "workspace", "preset"] as const;
  if (!categories.includes(input.category as typeof categories[number])) {
    throw new Error("Analysis category is unsupported.");
  }
  if (!sourceTypes.includes(input.imageSourceType as typeof sourceTypes[number])) {
    throw new Error("Analysis imageSourceType is unsupported.");
  }
  let imageUrl: string | undefined;
  if (input.imageUrl !== undefined) {
    if (typeof input.imageUrl !== "string" || input.imageUrl.length > 2_000) {
      throw new Error("Analysis imageUrl must be an HTTPS URL of at most 2,000 characters.");
    }
    try {
      const url = new URL(input.imageUrl);
      if (input.imageUrl !== input.imageUrl.trim() || url.protocol !== "https:" || !url.hostname) {
        throw new Error();
      }
      imageUrl = url.toString();
    } catch {
      throw new Error("Analysis imageUrl must be an HTTPS URL of at most 2,000 characters.");
    }
  }
  const labels = validateAnnotations(input.labelAnnotations, "labelAnnotations", 30, (item) => ({
    description: requiredText(item.description, "label description", 500),
    score: validateScore(item.score, "label score"),
    ...(item.topicality !== undefined
      ? { topicality: validateScore(item.topicality, "label topicality") }
      : {}),
  }));
  const logos = validateAnnotations(input.logoAnnotations, "logoAnnotations", 20, (item) => ({
    description: requiredText(item.description, "logo description", 500),
    score: validateScore(item.score, "logo score"),
  }));
  const landmarks = validateAnnotations(input.landmarkAnnotations, "landmarkAnnotations", 20, (item) => {
    const latitude = item.latitude;
    const longitude = item.longitude;
    if (latitude !== undefined &&
        (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
      throw new Error("Analysis landmark latitude must be from -90 to 90.");
    }
    if (longitude !== undefined &&
        (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
      throw new Error("Analysis landmark longitude must be from -180 to 180.");
    }
    return {
      description: requiredText(item.description, "landmark description", 500),
      score: validateScore(item.score, "landmark score"),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
    };
  });
  const faces = validateAnnotations(input.faceAnnotations, "faceAnnotations", 20, (item) => {
    if (typeof item.faceIndex !== "number" || !Number.isInteger(item.faceIndex) || item.faceIndex < 0) {
      throw new Error("Analysis faceIndex must be a non-negative integer.");
    }
    return {
      faceIndex: item.faceIndex,
      confidence: validateScore(item.confidence, "face confidence"),
      joyLikelihood: validateLikelihood(item.joyLikelihood, "joyLikelihood"),
      surpriseLikelihood: validateLikelihood(item.surpriseLikelihood, "surpriseLikelihood"),
      sorrowLikelihood: validateLikelihood(item.sorrowLikelihood, "sorrowLikelihood"),
      angerLikelihood: validateLikelihood(item.angerLikelihood, "angerLikelihood"),
      headwearLikelihood: validateLikelihood(item.headwearLikelihood, "headwearLikelihood"),
    };
  });
  const photoId = optionalText(input, "photoId", 200);
  return {
    _id: new ObjectId(),
    analysisId: randomUUID(),
    userId,
    title: requiredText(input.title, "title", 200),
    category: input.category as StoredVisionAnalysis["category"],
    ...(photoId ? { photoId } : {}),
    imageSourceType: input.imageSourceType as StoredVisionAnalysis["imageSourceType"],
    ...(imageUrl ? { imageUrl } : {}),
    featuresRequested: validateFeatures(input.featuresRequested),
    labelAnnotations: labels,
    fullTextAnnotation: validateFullText(input.fullTextAnnotation),
    logoAnnotations: logos,
    landmarkAnnotations: landmarks,
    faceAnnotations: faces,
    safeSearchAnnotation: validateSafeSearch(input.safeSearchAnnotation),
    executionEngine: requiredText(input.executionEngine, "executionEngine", 120),
    createdAt: validateNow(now),
  };
}

function validateAnalysisId(analysisId: string): string {
  if (typeof analysisId !== "string" || !UUID_V4_PATTERN.test(analysisId)) {
    throw new Error("A valid analysis UUID is required.");
  }
  return analysisId;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Analysis page size must be an integer from 1 to 100.");
  }
}

export function createVisionAnalysisService(repository: VisionAnalysisRepository) {
  return {
    async save(userId: string, input: unknown): Promise<StoredVisionAnalysis> {
      const analysis = validateVisionAnalysisInput(userId, input);
      await repository.create(analysis);
      return analysis;
    },
    async list(userId: string, limit = 25): Promise<StoredVisionAnalysis[]> {
      validateUserId(userId);
      validateLimit(limit);
      return repository.list(userId, limit);
    },
    async get(userId: string, analysisId: string): Promise<StoredVisionAnalysis | null> {
      validateUserId(userId);
      return repository.get(userId, validateAnalysisId(analysisId));
    },
    async delete(userId: string, analysisId: string): Promise<boolean> {
      validateUserId(userId);
      return repository.delete(userId, validateAnalysisId(analysisId));
    },
  };
}

function mongoRepository(collection: Collection<StoredVisionAnalysis>): VisionAnalysisRepository {
  return {
    async create(analysis) {
      await collection.insertOne(analysis);
    },
    list(userId, limit) {
      return collection.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
    },
    get(userId, analysisId) {
      return collection.findOne({ userId, analysisId });
    },
    async delete(userId, analysisId) {
      const result = await collection.deleteOne({ userId, analysisId });
      return result.deletedCount === 1;
    },
  };
}

let visionServicePromise: Promise<ReturnType<typeof createVisionAnalysisService>> | undefined;

async function visionService(): Promise<ReturnType<typeof createVisionAnalysisService>> {
  if (!visionServicePromise) {
    visionServicePromise = getMongoDb().then((db) =>
      createVisionAnalysisService(
        mongoRepository(db.collection<StoredVisionAnalysis>(COLLECTION_NAME)),
      ),
    ).catch((error: unknown) => {
      visionServicePromise = undefined;
      if (error instanceof Error && error.message.startsWith("MongoDB")) throw error;
      throw new Error("Vision analysis storage could not be initialized.");
    });
  }
  return visionServicePromise;
}

export async function saveVisionAnalysis(
  userId: string,
  input: unknown,
): Promise<StoredVisionAnalysis> {
  return (await visionService()).save(userId, input);
}

export async function listVisionAnalyses(
  userId: string,
  limit = 25,
): Promise<StoredVisionAnalysis[]> {
  return (await visionService()).list(userId, limit);
}

export async function getVisionAnalysis(
  userId: string,
  analysisId: string,
): Promise<StoredVisionAnalysis | null> {
  return (await visionService()).get(userId, analysisId);
}

export async function deleteVisionAnalysis(
  userId: string,
  analysisId: string,
): Promise<boolean> {
  return (await visionService()).delete(userId, analysisId);
}

export function serializeVisionAnalysis(analysis: StoredVisionAnalysis) {
  return {
    id: analysis._id.toHexString(),
    analysisId: analysis.analysisId,
    title: analysis.title,
    category: analysis.category,
    ...(analysis.photoId ? { photoId: analysis.photoId } : {}),
    imageSourceType: analysis.imageSourceType,
    ...(analysis.imageUrl ? { imageUrl: analysis.imageUrl } : {}),
    featuresRequested: analysis.featuresRequested,
    labelAnnotations: analysis.labelAnnotations,
    fullTextAnnotation: analysis.fullTextAnnotation,
    logoAnnotations: analysis.logoAnnotations,
    landmarkAnnotations: analysis.landmarkAnnotations,
    faceAnnotations: analysis.faceAnnotations,
    safeSearchAnnotation: analysis.safeSearchAnnotation,
    executionEngine: analysis.executionEngine,
    createdAt: analysis.createdAt.toISOString(),
  };
}
