import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedRequestBodyError,
  parseTaskInput,
  readBoundedJson,
} from "./task-request";

test("accepts the full set of optional planner metadata", async () => {
  const parsed = await parseTaskInput(new Request("https://example.com/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Network Design Lab",
      courseCode: "ITeC4111",
      estimatedHours: 3,
      actualHours: 1.5,
      assessment: "Lab",
      creditHours: 3,
      instructor: "Mr. Dessalew G.",
      marksGrade: "Pending",
      nextReviewDate: "2026-10-12T06:00:00.000Z",
      notes: "Capture evidence",
      recurrence: "Weekly",
      resourceLink: "https://example.com/lab",
      semester: "First Semester",
      timeBlock: "Monday morning",
      venueLink: "Room 4",
      dueDate: "2026-10-05T17:00:00.000Z",
      dateEnd: "2026-10-05T18:00:00.000Z",
      deliverable: true,
    }),
  }));

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.input.deliverable, true);
    assert.equal(parsed.input.actualHours, 1.5);
    assert.equal(parsed.input.dateEnd, "2026-10-05T18:00:00.000Z");
    assert.equal(parsed.input.venueLink, "Room 4");
  }
});

test("accepts OCR notes up to 50,000 characters and rejects longer notes", async () => {
  const valid = await parseTaskInput(new Request("https://example.com/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "OCR result", notes: "x".repeat(50_000) }),
  }));
  assert.equal(valid.ok, true);

  const invalid = await parseTaskInput(new Request("https://example.com/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "OCR result", notes: "x".repeat(50_001) }),
  }));
  assert.deepEqual(invalid, { ok: false, error: "Invalid notes value." });
});

test("rejects invalid numeric hours and unsupported metadata", async () => {
  const invalidHours = await parseTaskInput(new Request("https://example.com/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Lab", actualHours: -1 }),
  }));
  assert.deepEqual(invalidHours, { ok: false, error: "actualHours must be a number between 0 and 10,000." });

  const unsupported = await parseTaskInput(new Request("https://example.com/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Lab", peopleInstructorIds: ["notion-id"] }),
  }));
  assert.deepEqual(unsupported, { ok: false, error: "The request contains an unsupported field." });
});

test("reads JSON within the configured byte limit", async () => {
  const request = new Request("https://example.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readBoundedJson(request, 100), { ok: true });
});

test("rejects declared and streamed oversized JSON with status 413", async () => {
  const declared = new Request("https://example.com", {
    method: "POST",
    headers: { "Content-Length": "1000" },
    body: "{}",
  });
  await assert.rejects(
    readBoundedJson(declared, 10),
    (error: unknown) => error instanceof BoundedRequestBodyError && error.status === 413,
  );

  const streamed = new Request("https://example.com", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"too large"}'));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readBoundedJson(streamed, 5),
    (error: unknown) => error instanceof BoundedRequestBodyError && error.status === 413,
  );
});

test("returns a client error for malformed JSON", async () => {
  const request = new Request("https://example.com", { method: "POST", body: "not json" });
  await assert.rejects(
    readBoundedJson(request, 100),
    (error: unknown) => error instanceof BoundedRequestBodyError && error.status === 400,
  );
});
