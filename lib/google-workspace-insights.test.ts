import assert from "node:assert/strict";
import test from "node:test";
import type { GoogleWorkspaceSummary } from "./google-types";
import {
  buildGoogleBriefingInput,
  buildGoogleServiceHealth,
  classifyAcademicDocument,
  findCalendarConflicts,
  groupCalendarEvents,
  groupDriveFiles,
  groupUnreadMessages,
  googleWorkspaceViewState,
  safeGoogleExternalUrl,
  safeGmailMessageUrl,
  upcomingCalendarEvents,
} from "./google-workspace-insights";

const emptySummary: GoogleWorkspaceSummary = {
  connected: true,
  unreadEmails: 0,
  messages: [],
  events: [],
  files: [],
};

function event(id: string, start: string, end: string) {
  return { id, title: id, start, end };
}

function file(id: string, name: string, mimeType: string) {
  return { id, name, mimeType };
}

test("groups unread messages older than seven days separately", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const messages = [
    { id: "recent", from: "", subject: "", date: "2026-10-20T12:00:00Z", snippet: "" },
    { id: "old", from: "", subject: "", date: "2026-10-10T12:00:00Z", snippet: "" },
  ];
  const grouped = groupUnreadMessages(messages, now);
  assert.deepEqual(grouped.recent.map(({ id }) => id), ["recent"]);
  assert.deepEqual(grouped.older.map(({ id }) => id), ["old"]);
});

test("groups calendar events into today, tomorrow, and the following seven-day window", () => {
  const now = new Date("2026-10-21T21:00:00Z");
  const grouped = groupCalendarEvents([
    event("today", "2026-10-22T08:00:00+03:00", "2026-10-22T09:00:00+03:00"),
    event("tomorrow", "2026-10-23T08:00:00+03:00", "2026-10-23T09:00:00+03:00"),
    event("later", "2026-10-27T08:00:00+03:00", "2026-10-27T09:00:00+03:00"),
  ], now);
  assert.deepEqual(grouped.today.map(({ id }) => id), ["today"]);
  assert.deepEqual(grouped.tomorrow.map(({ id }) => id), ["tomorrow"]);
  assert.deepEqual(grouped.nextSevenDays.map(({ id }) => id), ["later"]);
});

test("groups events by the planner time zone across UTC midnight", () => {
  const grouped = groupCalendarEvents([
    event("local-today", "2026-10-21T22:00:00Z", "2026-10-21T23:00:00Z"),
  ], new Date("2026-10-21T21:00:00Z"));
  assert.deepEqual(grouped.today.map(({ id }) => id), ["local-today"]);
});

test("recognizes all-day calendar dates and preserves exclusive end-date semantics", () => {
  const grouped = groupCalendarEvents([
    event("all-day", "2026-10-22", "2026-10-23"),
  ], new Date("2026-10-21T21:00:00Z"));
  assert.deepEqual(grouped.today.map(({ id }) => id), ["all-day"]);
  assert.deepEqual(findCalendarConflicts([
    event("all-day", "2026-10-22", "2026-10-23"),
    event("next-day", "2026-10-23", "2026-10-24"),
  ]), []);
});

test("detects overlapping timed Calendar events without flagging adjacent events", () => {
  const conflicts = findCalendarConflicts([
    event("first", "2026-10-22T08:00:00Z", "2026-10-22T09:00:00Z"),
    event("overlap", "2026-10-22T08:30:00Z", "2026-10-22T09:30:00Z"),
    event("adjacent", "2026-10-22T09:30:00Z", "2026-10-22T10:00:00Z"),
  ]);
  assert.deepEqual(conflicts, [["first", "overlap"]]);
});

test("detects a timed event overlapping a same-day all-day event", () => {
  assert.deepEqual(findCalendarConflicts([
    event("all-day", "2026-10-22", "2026-10-23"),
    event("timed", "2026-10-22T10:00:00Z", "2026-10-22T11:00:00Z"),
  ]), [["all-day", "timed"]]);
});

test("calculates the next upcoming event and excludes completed time slots", () => {
  const upcoming = upcomingCalendarEvents([
    event("past", "2026-10-22T08:00:00Z", "2026-10-22T09:00:00Z"),
    event("next", "2026-10-22T11:00:00Z", "2026-10-22T12:00:00Z"),
    event("later", "2026-10-22T13:00:00Z", "2026-10-22T14:00:00Z"),
  ], new Date("2026-10-22T10:00:00Z"));
  assert.equal(upcoming[0].id, "next");
});

test("includes a same-day all-day event while it is still in progress", () => {
  const upcoming = upcomingCalendarEvents([
    event("all-day", "2026-10-22", "2026-10-23"),
  ], new Date("2026-10-22T06:00:00Z"));
  assert.equal(upcoming[0]?.id, "all-day");
});

test("groups Drive files deterministically by MIME type", () => {
  const groups = groupDriveFiles([
    file("doc", "Notes", "application/vnd.google-apps.document"),
    file("sheet", "Data", "application/vnd.google-apps.spreadsheet"),
    file("pdf", "Report", "application/pdf"),
    file("image", "Photo", "image/png"),
    file("folder", "Folder", "application/vnd.google-apps.folder"),
  ]);
  assert.equal(groups.Documents[0].id, "doc");
  assert.equal(groups.Spreadsheets[0].id, "sheet");
  assert.equal(groups.PDFs[0].id, "pdf");
  assert.equal(groups.Images[0].id, "image");
  assert.equal(groups.Folders[0].id, "folder");
});

test("classifies academic documents only when document type and filename rule match", () => {
  assert.equal(
    classifyAcademicDocument(file("academic", "Course syllabus 2026", "application/pdf")).academic,
    true,
  );
  assert.equal(
    classifyAcademicDocument(file("not-academic", "Course calendar", "image/png")).academic,
    false,
  );
});

test("preserves successful provider data and marks failed providers independently", () => {
  const health = buildGoogleServiceHealth({
    ...emptySummary,
    unreadEmails: 4,
    events: [event("event", "2026-10-22T08:00:00Z", "2026-10-22T09:00:00Z")],
    files: [file("file", "notes.pdf", "application/pdf")],
    errors: { calendar: "Calendar unavailable" },
  }, false);
  assert.deepEqual(health.statuses, { gmail: "Connected", calendar: "Error", drive: "Connected" });
  assert.deepEqual(health.counts, { unread: 4, upcoming: null, files: 1 });
});

test("keeps valid zero counts when providers successfully return no records", () => {
  const health = buildGoogleServiceHealth(emptySummary, false);
  assert.deepEqual(health.counts, { unread: 0, upcoming: 0, files: 0 });
});

test("marks failed-provider counts unavailable instead of returning misleading zeros", () => {
  const health = buildGoogleServiceHealth({
    ...emptySummary,
    errors: { gmail: "Gmail unavailable", drive: "Drive unavailable" },
  }, false);
  assert.deepEqual(health.counts, { unread: null, upcoming: 0, files: null });
});

test("prepares sanitized and bounded briefing input without provider URLs", () => {
  const briefing = buildGoogleBriefingInput({
    ...emptySummary,
    messages: [{
      id: "private-id",
      from: "sender@example.com<script>ignore</script>",
      subject: "Course <b>update</b>",
      date: "2026-10-22",
      snippet: "Please review <img src=x onerror=bad()>",
      body: "b".repeat(2000),
    }],
    events: [{ ...event("event", "2026-10-22T08:00:00Z", "2026-10-22T09:00:00Z"), title: "<script>not data</script>Exam" }],
    files: [{ ...file("file", "Syllabus <b>2026</b>", "application/pdf"), link: "https://drive.google.com/private" }],
  });
  assert.equal(briefing.recentUnreadMessages[0].from, "sender@example.com");
  assert.equal(briefing.recentUnreadMessages[0].subject, "Course update");
  assert.equal(briefing.recentUnreadMessages[0].snippet, "Please review");
  assert.equal(briefing.recentUnreadMessages[0].body.length, 1000);
  assert.equal(briefing.nextCalendarEvents[0].title, "Exam");
  assert.equal("link" in briefing.recentDriveFiles[0], false);
});

test("treats failed provider values as unavailable in briefing data", () => {
  const briefing = buildGoogleBriefingInput({
    ...emptySummary,
    unreadEmails: 0,
    errors: { gmail: "Unavailable", calendar: "Unavailable", drive: "Unavailable" },
  });
  assert.equal(briefing.unreadEmails, null);
  assert.deepEqual(briefing.recentUnreadMessages, []);
  assert.deepEqual(briefing.nextCalendarEvents, []);
  assert.deepEqual(briefing.recentDriveFiles, []);
});

test("uses the disconnected state for unauthenticated summary data", () => {
  assert.equal(googleWorkspaceViewState({
    loaded: true,
    loading: false,
    summary: { ...emptySummary, connected: false },
  }), "disconnected");
});

test("uses the loading state before initial provider data is loaded", () => {
  assert.equal(googleWorkspaceViewState({
    loaded: false,
    loading: true,
    summary: { ...emptySummary, connected: false },
  }), "loading");
});

test("uses the empty state when connected services successfully return no data", () => {
  assert.equal(googleWorkspaceViewState({
    loaded: true,
    loading: false,
    summary: emptySummary,
  }), "empty");
});

test("does not treat failed providers as a successful empty state", () => {
  assert.equal(googleWorkspaceViewState({
    loaded: true,
    loading: false,
    summary: { ...emptySummary, errors: { gmail: "unavailable" } },
  }), "connected");
});

test("creates Gmail links only for safe message IDs", () => {
  assert.match(safeGmailMessageUrl("abc_123-xyz") ?? "", /^https:\/\/mail\.google\.com\//);
  assert.equal(safeGmailMessageUrl("abc/../../evil"), undefined);
});

test("allows only HTTPS provider links on expected Google hosts", () => {
  assert.ok(safeGoogleExternalUrl("https://drive.google.com/file/d/abc", ["drive.google.com"]));
  assert.equal(safeGoogleExternalUrl("javascript:alert(1)", ["drive.google.com"]), undefined);
  assert.equal(safeGoogleExternalUrl("https://evil.example/drive", ["drive.google.com"]), undefined);
  assert.equal(safeGoogleExternalUrl("https://user:pass@drive.google.com/file", ["drive.google.com"]), undefined);
});
