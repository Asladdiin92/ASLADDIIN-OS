import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeImageWithVision,
  validateVisionImageInput,
} from "./cloud-vision";

const inlineImage = "data:image/png;base64,YQ==";

const cloudResponse = {
  responses: [{
    labelAnnotations: [{ description: "Office", score: 0.98, topicality: 0.9 }],
    fullTextAnnotation: { text: "Project board" },
    logoAnnotations: [],
    landmarkAnnotations: [],
    faceAnnotations: [],
    safeSearchAnnotation: {
      adult: "VERY_UNLIKELY",
      spoof: "VERY_UNLIKELY",
      medical: "VERY_UNLIKELY",
      violence: "VERY_UNLIKELY",
      racy: "VERY_UNLIKELY",
    },
  }],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("accepts supported image URLs and data URLs and rejects SSRF targets", () => {
  assert.deepEqual(validateVisionImageInput(inlineImage), {
    kind: "data",
    mimeType: "image/png",
    content: "YQ==",
  });
  assert.equal(validateVisionImageInput("https://example.com/image.jpg").kind, "url");
  for (const image of [
    "http://example.com/image.jpg",
    "https://user:pass@example.com/image.jpg",
    "https://example.com:8443/image.jpg",
    "https://localhost/image.jpg",
    "https://127.0.0.1/image.jpg",
    "https://10.1.2.3/image.jpg",
    "https://172.16.0.1/image.jpg",
    "https://192.168.1.2/image.jpg",
    "https://192.0.2.1/image.jpg",
    "https://169.254.1.1/image.jpg",
    "https://[::1]/image.jpg",
    "https://[::ffff:7f00:1]/image.jpg",
    "https://metadata.internal/image.jpg",
    "https://host.local/image.jpg",
    "https://localhost./image.jpg",
  ]) {
    assert.throws(() => validateVisionImageInput(image), /HTTPS|private|reserved/i, image);
  }
  assert.throws(
    () => validateVisionImageInput("data:text/html;base64,PGh0bWw+"),
    /supported base64 image/,
  );
});

test("uses Cloud Vision when configured and normalizes annotations", async () => {
  const previousKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GOOGLE_CLOUD_VISION_API_KEY = "test-cloud-key";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(cloudResponse);
  }) as typeof fetch;
  try {
    const result = await analyzeImageWithVision({
      image: inlineImage,
      features: ["LABEL_DETECTION", "TEXT_DETECTION"],
      title: "Office",
    });
    assert.equal(result.executionEngine, "Google Cloud Vision API");
    assert.equal(result.imageSourceType, "upload");
    assert.equal(result.labelAnnotations[0]?.description, "Office");
    assert.equal(result.fullTextAnnotation?.text, "Project board");
    assert.equal(JSON.stringify(requestBody).includes("data:image"), false);
    assert.equal(((requestBody?.requests as Array<{ image: { content?: string } }>)[0]).image.content, "YQ==");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_CLOUD_VISION_API_KEY;
    else process.env.GOOGLE_CLOUD_VISION_API_KEY = previousKey;
  }
});

test("falls back to Gemini Vision if Cloud Vision fails", async () => {
  const previousCloudKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GOOGLE_CLOUD_VISION_API_KEY = "test-cloud-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let cloudCalled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("vision.googleapis.com")) {
      cloudCalled = true;
      return response({ error: { message: "billing is not enabled" } }, 403);
    }
    const body = JSON.parse(String(init?.body)) as {
      contents: Array<{ parts: Array<{ text?: string; inline_data?: { data: string } }> }>;
    };
    assert.equal(body.contents[0].parts[1].inline_data?.data, "YQ==");
    return response({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              labelAnnotations: [{ description: "Desk", score: 0.9 }],
              fullTextAnnotation: { text: "Notes", lines: ["Notes"] },
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
            }),
          }],
        },
      }],
    });
  }) as typeof fetch;
  try {
    const result = await analyzeImageWithVision({ image: inlineImage });
    assert.equal(cloudCalled, true);
    assert.equal(result.executionEngine, "Gemini Vision Fallback");
    assert.equal(result.labelAnnotations[0]?.description, "Desk");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCloudKey === undefined) delete process.env.GOOGLE_CLOUD_VISION_API_KEY;
    else process.env.GOOGLE_CLOUD_VISION_API_KEY = previousCloudKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }
});

test("rejects oversized and malformed image inputs before provider calls", () => {
  assert.throws(
    () => validateVisionImageInput(`data:image/png;base64,${"A".repeat(5_600_000)}`),
    /4 MB/,
  );
  assert.throws(
    () => validateVisionImageInput("data:image/png;base64,not base64"),
    /supported base64/,
  );
});
