import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasPlannerUserAccess } from "@/lib/access";
import { logActivity } from "@/lib/activity-logger";
import { analyzeImageWithVision } from "@/lib/cloud-vision";
import {
  listVisionAnalyses,
  deleteVisionAnalysis,
  saveVisionAnalysis,
  serializeVisionAnalysis,
  VISION_FEATURES,
  type VisionFeature,
} from "@/lib/vision-store";
import { BoundedRequestBodyError, isSameOrigin, readBoundedJson } from "@/lib/task-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 6 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function authorizedUser() {
  try {
    const { userId } = await auth();
    if (!userId) return { error: json({ ok: false, error: "Sign in to analyze images." }, 401) };
    if (!await hasPlannerUserAccess(userId)) {
      return { error: json({ ok: false, error: "You are not authorized to access this workspace." }, 403) };
    }
    return { userId };
  } catch {
    return { error: json({ ok: false, error: "Access could not be verified." }, 503) };
  }
}

export async function GET(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;
  const queryLimit = request.nextUrl.searchParams.get("limit");
  const limit = queryLimit === null ? 20 : Number(queryLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return json({ ok: false, error: "Analysis limit must be an integer from 1 to 50." }, 400);
  }
  try {
    const analyses = await listVisionAnalyses(access.userId, limit);
    return json({ ok: true, analyses: analyses.map(serializeVisionAnalysis) });
  } catch {
    return json({ ok: false, error: "Saved image analyses could not be loaded." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;
  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "This request must come from the dashboard." }, 403);
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return json({ ok: false, error: error.message }, error.status);
    }
    return json({ ok: false, error: "Send a valid image analysis request." }, 400);
  }
  if (!isPlainObject(body) ||
      Object.keys(body).some((key) => !["image", "features", "title", "category", "photoId"].includes(key))) {
    return json({ ok: false, error: "The image analysis request contains unsupported fields." }, 400);
  }
  const categories = ["workspace", "events", "team", "documents"] as const;
  if (typeof body.image !== "string" ||
      (body.features !== undefined &&
        (!Array.isArray(body.features) ||
          body.features.some((feature) => typeof feature !== "string" ||
            !VISION_FEATURES.includes(feature as VisionFeature)))) ||
      (body.title !== undefined && typeof body.title !== "string") ||
      (body.category !== undefined &&
        (typeof body.category !== "string" || !categories.includes(body.category as typeof categories[number]))) ||
      (body.photoId !== undefined && typeof body.photoId !== "string")) {
    return json({ ok: false, error: "The image analysis request contains invalid fields." }, 400);
  }
  try {
    const analysisInput = {
      image: body.image,
      ...(body.features !== undefined ? { features: body.features as VisionFeature[] } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.category !== undefined
        ? { category: body.category as typeof categories[number] }
        : {}),
      ...(body.photoId !== undefined ? { photoId: body.photoId } : {}),
    };
    const result = await analyzeImageWithVision(analysisInput);
    const saved = await saveVisionAnalysis(access.userId, result);
    await logActivity({
      userId: access.userId,
      type: "vision_analyzed",
      source: "dashboard",
      title: "Analyzed an image",
      entityType: "vision",
      entityId: saved.analysisId,
    });
    return json({ ok: true, analysis: serializeVisionAnalysis(saved) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image analysis failed.";
    const status = /required|valid|supported|must be|choose|image data|image url|private|public HTTPS/i.test(message)
      ? 400
      : /GEMINI_API_KEY/.test(message) ? 503 : 502;
    return json({ ok: false, error: message }, status);
  }
}

export async function DELETE(request: NextRequest) {
  const access = await authorizedUser();
  if (access.error) return access.error;
  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "This request must come from the dashboard." }, 403);
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, 8 * 1024);
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return json({ ok: false, error: error.message }, error.status);
    }
    return json({ ok: false, error: "Send a valid scan deletion request." }, 400);
  }
  if (!isPlainObject(body) ||
      Object.keys(body).some((key) => key !== "analysisId") ||
      typeof body.analysisId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.analysisId)) {
    return json({ ok: false, error: "The scan deletion request is invalid." }, 400);
  }
  try {
    const deleted = await deleteVisionAnalysis(access.userId, body.analysisId);
    return deleted
      ? json({ ok: true, deleted: true })
      : json({ ok: false, error: "Saved scan was not found." }, 404);
  } catch {
    return json({ ok: false, error: "Saved scan could not be deleted." }, 503);
  }
}
