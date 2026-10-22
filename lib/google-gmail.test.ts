import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGoogleMessage,
  formatGmailReceivedTime,
  sanitizeGmailSnippet,
} from "./google-gmail";

test("sanitizes Gmail snippets and caps their displayed length", () => {
  assert.equal(
    sanitizeGmailSnippet("Hello <b>there</b><script>unsafe()</script> &amp; welcome"),
    "Hello there & welcome",
  );
  assert.equal(sanitizeGmailSnippet("a".repeat(10), 6), "aaaaa…");
});

test("classifies messages using explicit local wording rules", () => {
  const classifications = classifyGoogleMessage({
    from: "security@example.com",
    subject: "Action required: verify your account",
    snippet: "A new sign-in was detected.",
  });

  assert.deepEqual(classifications.map(({ category }) => category), ["Needs attention", "Security"]);
  assert.match(classifications[0].reason, /explicit action wording/i);
});

test("does not infer a reply requirement from ordinary message content", () => {
  const classifications = classifyGoogleMessage({
    from: "professor@university.edu",
    subject: "Course lecture notes",
    snippet: "The assignment notes are attached.",
  });

  assert.deepEqual(classifications.map(({ category }) => category), ["Academic"]);
  assert.ok(classifications.every(({ category }) => !category.toLowerCase().includes("reply")));
});

test("recognizes development and automated notification messages", () => {
  const classifications = classifyGoogleMessage({
    from: "noreply@github.com",
    subject: "Deployment notification",
    snippet: "Build complete.",
  });

  assert.deepEqual(classifications.map(({ category }) => category), [
    "Development tools",
    "Automated notifications",
  ]);
});

test("formats valid received dates and handles unavailable dates", () => {
  const now = Date.parse("2026-10-22T00:00:00Z");
  assert.equal(
    formatGmailReceivedTime("2026-10-22T00:00:10Z", now).relative,
    "just now",
  );
  assert.deepEqual(formatGmailReceivedTime("invalid", now), {
    relative: "Time unavailable",
    absolute: "Received time unavailable",
  });
});
