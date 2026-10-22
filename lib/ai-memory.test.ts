import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskShadowMemory,
  formatAIKnowledgeContext,
  shouldSyncTaskShadowMemory,
} from "./ai-memory";
import type { Task } from "./types";

const task: Task = {
  id: "notion-task-1",
  url: "https://www.notion.so/task",
  title: "Prepare lab report",
  status: "In progress",
  priority: "High",
  type: "Assignment",
  area: "University",
  course: "Network Design",
  courseCode: "ITeC4103",
  notes: "Include the test results.",
  nextAction: "Draft the findings section.",
  dueDate: "2026-10-28",
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-22T08:00:00.000Z",
  completed: false,
};

test("builds a read-only Notion shadow with searchable task context", () => {
  const document = buildTaskShadowMemory(task);

  assert.equal(document.type, "notion_task_shadow");
  assert.equal(document.sourceId, task.id);
  assert.equal(document.title, task.title);
  assert.equal(document.area, task.area);
  assert.equal(document.courseCode, task.courseCode);
  assert.equal(document.status, task.status);
  assert.equal(document.dueDate, task.dueDate);
  assert.equal(document.content, [
    "Title: Prepare lab report",
    "Course: Network Design ITeC4103",
    "Area: University",
    "Notes: Include the test results.",
    "Next Action: Draft the findings section.",
  ].join("\n"));
  assert.equal(document.updatedAt.toISOString(), task.updatedAt);
});

test("only syncs a task when its update timestamp is newer", () => {
  const storedAt = new Date("2026-10-22T08:00:00.000Z");
  assert.equal(shouldSyncTaskShadowMemory(storedAt, new Date("2026-10-22T08:00:00.000Z")), false);
  assert.equal(shouldSyncTaskShadowMemory(storedAt, new Date("2026-10-23T08:00:00.000Z")), true);
  assert.equal(shouldSyncTaskShadowMemory(undefined, storedAt), true);
});

test("formats semantic matches as a bounded untrusted context block", () => {
  assert.equal(formatAIKnowledgeContext([]), "");
  const context = formatAIKnowledgeContext([{
    type: "research_note",
    title: "Study methods",
    content: "Spaced repetition improves recall.",
    score: 0.91,
  }]);
  assert.match(context, /^Relevant Semantic Memory & Matched Tasks/);
  assert.match(context, /"type":"research_note"/);
});
