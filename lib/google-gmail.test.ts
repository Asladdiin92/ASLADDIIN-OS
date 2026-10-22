import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGoogleMessage,
  formatGmailReceivedTime,
  maskGoogleEmail,
  sanitizeGmailSnippet,
  sanitizeProviderText,
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

test("classifies a possible reply only when explicit request wording appears", () => {
  const classifications = classifyGoogleMessage({
    from: "person@example.com",
    subject: "Quick question",
    snippet: "Could you confirm the meeting time?",
  });
  const possibleReply = classifications.find(({ category }) => category === "Possible reply");
  assert.ok(possibleReply);
  assert.match(possibleReply.reason, /could you/i);
  assert.match(possibleReply.reason, /not a reply requirement/i);
});

test("classifies academic messages from academic wording or an education domain", () => {
  const classifications = classifyGoogleMessage({
    from: "registrar@sample.edu",
    subject: "Term update",
    snippet: "Please review.",
  });
  assert.ok(classifications.some(({ category }) => category === "Academic"));
});

test("classifies security alerts from explicit security-related wording", () => {
  const classifications = classifyGoogleMessage({
    from: "security@example.com",
    subject: "New device sign-in",
    snippet: "A new login was detected.",
  });
  assert.ok(classifications.some(({ category }) => category === "Security"));
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

test("masks connected account email by default", () => {
  assert.equal(maskGoogleEmail("asladin@example.com"), "asla****@example.com");
  assert.equal(maskGoogleEmail(undefined), "Unavailable");
});

test("sanitizes provider-supplied briefing text and removes markup/control characters", () => {
  assert.equal(sanitizeProviderText("<img src=x onerror=run()>Course\u0000 update"), "Course update");
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
