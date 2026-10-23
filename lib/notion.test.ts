import assert from "node:assert/strict";
import test from "node:test";

process.env.NOTION_API_KEY ??= "notion-test-token";
process.env.NOTION_DATABASE_ID ??= "notion-test-database";
process.env.NOTION_NOTES_PROPERTY = "Notes";

let notion: typeof import("./notion");
test.before(async () => {
  notion = await import("./notion");
});

const database = {
  properties: {
    Item: { type: "title", title: {} },
    Type: { type: "select", select: { options: [{ name: "Task" }, { name: "Deliverable" }] } },
    Status: { type: "status", status: { options: [{ name: "Planned" }, { name: "In progress" }, { name: "Done" }] } },
    Priority: { type: "select", select: { options: [{ name: "High" }, { name: "Medium" }, { name: "Low" }] } },
    Area: { type: "select", select: { options: [{ name: "University" }] } },
    Course: { type: "select", select: { options: [{ name: "General" }, { name: "Network Design" }] } },
    "Course Code": { type: "rich_text", rich_text: {} },
    "Est.": { type: "number", number: {} },
    Assessment: { type: "select", select: { options: [{ name: "Lab" }, { name: "Assignment" }] } },
    Actual: { type: "number", number: {} },
    "Credit Hours": { type: "number", number: {} },
    Instructor: { type: "rich_text", rich_text: {} },
    "People / Instructor": { type: "people", people: {} },
    "Marks / Grade": { type: "rich_text", rich_text: {} },
    "Next Review Date": { type: "date", date: {} },
    Notes: { type: "rich_text", rich_text: {} },
    Recurrence: { type: "rich_text", rich_text: {} },
    "Resource Link": { type: "url", url: {} },
    Semester: { type: "select", select: { options: [{ name: "First Semester" }, { name: "Second Semester" }, { name: "Summer" }] } },
    "Time Block": { type: "rich_text", rich_text: {} },
    "Venue Link": { type: "rich_text", rich_text: {} },
    Deliverable: { type: "checkbox", checkbox: {} },
    Date: { type: "date", date: {} },
    "Next Action": { type: "rich_text", rich_text: {} },
    Completed: { type: "checkbox", checkbox: {} },
  },
};

const originalFetch = globalThis.fetch;

function mockNotion(
  page: Record<string, unknown>,
  capture: (url: string, init: RequestInit, body: Record<string, unknown>) => void,
  schema: { properties: Record<string, unknown> } = database,
) {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/databases/notion-test-database") && (!init.method || init.method === "GET")) {
      return Response.json(schema);
    }
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    capture(url, init, body);
    return Response.json(page);
  };
}

function page(properties: Record<string, unknown>) {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    url: "https://www.notion.so/test-task",
    created_time: "2026-10-01T00:00:00.000Z",
    properties,
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  notion.invalidateNotionTasksCache();
});

test("caches task reads briefly and invalidates after a successful task write", async () => {
  notion.invalidateNotionTasksCache();
  let taskQueries = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/databases/notion-test-database") && (!init.method || init.method === "GET")) {
      return Response.json(database);
    }
    if (url.endsWith("/databases/notion-test-database/query")) {
      taskQueries += 1;
      return Response.json({ results: [], has_more: false, next_cursor: null });
    }
    return Response.json(page({
      Item: { type: "title", title: [{ plain_text: "New task" }] },
      Status: { type: "status", status: { name: "Planned" } },
    }));
  };

  const [first, concurrent] = await Promise.all([
    notion.fetchNotionTasks(),
    notion.fetchNotionTasks(),
  ]);
  assert.deepEqual(first, []);
  assert.deepEqual(concurrent, []);
  first.length = 0;
  assert.deepEqual(await notion.fetchNotionTasks(), []);
  assert.equal(taskQueries, 1);

  await notion.createNotionTask({ title: "New task" });
  await notion.fetchNotionTasks();
  assert.equal(taskQueries, 2);
});

test("creates a task using schema-aware defaults when fields are omitted", async () => {
  let createBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Read chapter" }] },
    Type: { type: "select", select: { name: "Deliverable" } },
    Status: { type: "status", status: { name: "Planned" } },
    Priority: { type: "select", select: { name: "Medium" } },
  }), (_url, init, body) => {
    assert.equal(init.method, "POST");
    createBody = body;
  });

  const task = await notion.createNotionTask({ title: "Read chapter" });
  const properties = createBody.properties as Record<string, Record<string, unknown>>;

  assert.deepEqual(createBody.parent, { database_id: "notion-test-database" });
  assert.deepEqual(properties.Type, { select: { name: "Deliverable" } });
  assert.deepEqual(properties.Status, { status: { name: "Planned" } });
  assert.deepEqual(properties.Priority, { select: { name: "Medium" } });
  assert.equal(task.title, "Read chapter");
});

test("stores long OCR notes as Notion-sized rich-text fragments", async () => {
  const notes = `${"a".repeat(1_999)}😀${"b".repeat(2_001)}`;
  let createBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "OCR result" }] },
    Type: { type: "select", select: { name: "Task" } },
    Status: { type: "status", status: { name: "Planned" } },
    Notes: { type: "rich_text", rich_text: [{ plain_text: notes }] },
  }), (_url, _init, body) => { createBody = body; });

  await notion.createNotionTask({ title: "OCR result", notes });
  const properties = createBody.properties as Record<string, { rich_text: Array<{ text: { content: string } }> }>;
  const chunks = properties.Notes.rich_text.map((item) => item.text.content);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 2_000));
  assert.equal(chunks.join(""), notes);
});

test("loads assessment choices from the Notion database schema", async () => {
  mockNotion({}, () => {});
  const options = await notion.fetchNotionTaskOptions();
  assert.deepEqual(options.assessments, ["Lab", "Assignment"]);
  assert.deepEqual(options.semesters, ["First Semester", "Second Semester", "Summer"]);
  assert.ok(options.availableFields.includes("dateEnd"));
  assert.ok(options.availableFields.includes("deliverable"));
});

test("creates a task with a confirmed local date-time due date", async () => {
  let createBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Algorithms homework" }] },
    Type: { type: "select", select: { name: "Task" } },
    Status: { type: "status", status: { name: "Planned" } },
    Date: { type: "date", date: { start: "2026-10-05T14:00:00+03:00" } },
  }), (_url, _init, body) => { createBody = body; });

  const task = await notion.createNotionTask({
    title: "Algorithms homework",
    dueDate: "2026-10-05T14:00:00+03:00",
  });
  const properties = createBody.properties as Record<string, Record<string, unknown>>;

  assert.deepEqual(properties.Date, { date: { start: "2026-10-05T14:00:00+03:00" } });
  assert.equal(task.dueDate, "2026-10-05T14:00:00+03:00");
});

test("reads and writes course codes, estimated hours, and assessment tags", async () => {
  let createBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Network design lab" }] },
    Type: { type: "select", select: { name: "Deliverable" } },
    Status: { type: "status", status: { name: "Not started" } },
    Course: { type: "select", select: { name: "Network Design" } },
    "Course Code": { type: "rich_text", rich_text: [{ plain_text: "ITeC4111" }] },
    "Est.": { type: "number", number: 3 },
    Assessment: { type: "select", select: { name: "Lab" } },
  }), (_url, _init, body) => { createBody = body; });

  const task = await notion.createNotionTask({
    title: "Network design lab",
    course: "Network Design",
    courseCode: "ITeC4111",
    estimatedHours: 3,
    assessment: "Lab",
  });
  const properties = createBody.properties as Record<string, Record<string, unknown>>;

  assert.deepEqual(properties["Course Code"], { rich_text: [{ text: { content: "ITeC4111" } }] });
  assert.deepEqual(properties["Est."], { number: 3 });
  assert.deepEqual(properties.Assessment, { select: { name: "Lab" } });
  assert.equal(task.courseCode, "ITeC4111");
  assert.equal(task.estimatedHours, 3);
  assert.equal(task.assessment, "Lab");
});

test("maps the live Notion metadata property aliases", async () => {
  const liveProperties: Record<string, unknown> = { ...database.properties };
  delete liveProperties["Est."];
  delete liveProperties["Actual"];
  delete liveProperties["Assessment"];
  delete liveProperties["Venue Link"];
  liveProperties["Estimated Hours"] = { type: "number", number: {} };
  liveProperties["Actual Hours"] = { type: "number", number: {} };
  liveProperties["Assessment Type"] = {
    type: "select",
    select: { options: [{ name: "Lab" }, { name: "Assignment" }] },
  };
  liveProperties["Venue / Link"] = { type: "rich_text", rich_text: {} };

  const pageData = page({
    Item: { type: "title", title: [{ plain_text: "Security lab" }] },
    Type: { type: "select", select: { name: "Deliverable" } },
    Status: { type: "status", status: { name: "Planned" } },
    "Estimated Hours": { type: "number", number: 3 },
    "Actual Hours": { type: "number", number: 1 },
    "Assessment Type": { type: "select", select: { name: "Lab" } },
    "Venue / Link": { type: "rich_text", rich_text: [{ plain_text: "Room 4" }] },
  });
  let updateBody: Record<string, unknown> = {};
  mockNotion(pageData, (_url, _init, body) => { updateBody = body; }, { properties: liveProperties });

  const options = await notion.fetchNotionTaskOptions();
  assert.ok(options.availableFields.includes("estimatedHours"));
  assert.ok(options.availableFields.includes("actualHours"));
  assert.ok(options.availableFields.includes("assessment"));
  assert.ok(options.availableFields.includes("venueLink"));
  assert.deepEqual(options.assessments, ["Lab", "Assignment"]);

  const task = await notion.updateNotionTask("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", {
    title: "Security lab",
    estimatedHours: 4,
    actualHours: 2,
    assessment: "Lab",
    venueLink: "https://example.com/room",
  });
  const properties = updateBody.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties["Estimated Hours"], { number: 4 });
  assert.deepEqual(properties["Actual Hours"], { number: 2 });
  assert.deepEqual(properties["Assessment Type"], { select: { name: "Lab" } });
  assert.deepEqual(properties["Venue / Link"], { rich_text: [{ text: { content: "https://example.com/room" } }] });
  assert.equal(task.estimatedHours, 3);
  assert.equal(task.actualHours, 1);
  assert.equal(task.assessment, "Lab");
  assert.equal(task.venueLink, "Room 4");
});

test("round-trips the original planner metadata and date range", async () => {
  let createBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Weekly AI class" }] },
    Type: { type: "select", select: { name: "Class" } },
    Status: { type: "status", status: { name: "Planned" } },
    Date: { type: "date", date: { start: "2026-10-05T09:00:00+03:00", end: "2026-10-05T11:00:00+03:00" } },
    "Next Review Date": { type: "date", date: { start: "2026-10-12" } },
    "Actual": { type: "number", number: 1.5 },
    "Credit Hours": { type: "number", number: 3 },
    Instructor: { type: "rich_text", rich_text: [{ plain_text: "Mr. Dessalew G." }] },
    "People / Instructor": { type: "people", people: [{ id: "notion-user-id", name: "Mr. Dessalew G." }] },
    "Marks / Grade": { type: "rich_text", rich_text: [{ plain_text: "Pending" }] },
    Notes: { type: "rich_text", rich_text: [{ plain_text: "Bring lab notebook" }] },
    Recurrence: { type: "rich_text", rich_text: [{ plain_text: "Weekly" }] },
    "Resource Link": { type: "url", url: "https://example.com/course" },
    Semester: { type: "select", select: { name: "First Semester" } },
    "Time Block": { type: "rich_text", rich_text: [{ plain_text: "Monday 09:00-11:00" }] },
    "Venue Link": { type: "rich_text", rich_text: [{ plain_text: "Room 4" }] },
    Deliverable: { type: "checkbox", checkbox: true },
  }), (_url, _init, body) => { createBody = body; });

  const task = await notion.createNotionTask({
    title: "Weekly AI class",
    dueDate: "2026-10-05T09:00:00+03:00",
    dateEnd: "2026-10-05T11:00:00+03:00",
    nextReviewDate: "2026-10-12",
    actualHours: 1.5,
    creditHours: 3,
    instructor: "Mr. Dessalew G.",
    marksGrade: "Pending",
    notes: "Bring lab notebook",
    recurrence: "Weekly",
    resourceLink: "https://example.com/course",
    semester: "First Semester",
    timeBlock: "Monday 09:00-11:00",
    venueLink: "Room 4",
    deliverable: true,
  });
  const properties = createBody.properties as Record<string, Record<string, unknown>>;

  assert.deepEqual(properties.Date, { date: { start: "2026-10-05T09:00:00+03:00", end: "2026-10-05T11:00:00+03:00" } });
  assert.deepEqual(properties["Next Review Date"], { date: { start: "2026-10-12" } });
  assert.deepEqual(properties.Actual, { number: 1.5 });
  assert.deepEqual(properties["Credit Hours"], { number: 3 });
  assert.deepEqual(properties.Deliverable, { checkbox: true });
  assert.deepEqual(properties.Semester, { select: { name: "First Semester" } });
  assert.equal(task.dateEnd, "2026-10-05T11:00:00+03:00");
  assert.equal(task.dateIsDateTime, true);
  assert.equal(task.instructor, "Mr. Dessalew G.");
  assert.deepEqual(task.peopleInstructor, ["Mr. Dessalew G."]);
  assert.equal(task.actualHours, 1.5);
  assert.equal(task.creditHours, 3);
  assert.equal(task.deliverable, true);
  assert.equal(task.notes, "Bring lab notebook");
  assert.equal(task.resourceLink, "https://example.com/course");
  assert.equal(task.venueLink, "Room 4");
  assert.equal(task.semester, "First Semester");
});

test("updates task properties and clears optional values", async () => {
  let updateBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Updated" }] },
    Type: { type: "select", select: { name: "Task" } },
    Status: { type: "status", status: { name: "In progress" } },
    Priority: { type: "select", select: null },
    Area: { type: "select", select: null },
    Course: { type: "select", select: null },
    "Course Code": { type: "rich_text", rich_text: [] },
    "Est.": { type: "number", number: null },
    Assessment: { type: "select", select: null },
    Date: { type: "date", date: null },
    "Next Action": { type: "rich_text", rich_text: [] },
  }), (url, init, body) => {
    assert.ok(url.endsWith("/pages/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    assert.equal(init.method, "PATCH");
    updateBody = body;
  });

  await notion.updateNotionTask("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", {
    title: "Updated",
    type: "Task",
    status: "In progress",
    priority: "",
    area: "",
    course: "",
    courseCode: "",
    estimatedHours: null,
    assessment: "",
    dueDate: "",
    nextAction: "",
  });

  const properties = updateBody.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.Priority, { select: null });
  assert.deepEqual(properties.Area, { select: null });
  assert.deepEqual(properties.Course, { select: null });
  assert.deepEqual(properties["Course Code"], { rich_text: [] });
  assert.deepEqual(properties["Est."], { number: null });
  assert.deepEqual(properties.Assessment, { select: null });
  assert.deepEqual(properties.Date, { date: null });
  assert.deepEqual(properties["Next Action"], { rich_text: [] });
});

test("partial task updates preserve optional Notion metadata that was not sent", async () => {
  let updateBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Updated title" }] },
    Type: { type: "select", select: { name: "Task" } },
    Status: { type: "status", status: { name: "Planned" } },
  }), (_url, _init, body) => { updateBody = body; });

  await notion.updateNotionTask("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { title: "Updated title" });

  const properties = updateBody.properties as Record<string, unknown>;
  assert.equal("Notes" in properties, false);
  assert.equal("Est." in properties, false);
  assert.equal("Deliverable" in properties, false);
  assert.equal("Next Review Date" in properties, false);
  assert.equal("Date" in properties, false);
});

test("archives a task instead of permanently deleting it", async () => {
  let archiveBody: Record<string, unknown> = {};
  mockNotion({}, (url, init, body) => {
    assert.ok(url.endsWith("/pages/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    assert.equal(init.method, "PATCH");
    archiveBody = body;
  });

  await notion.archiveNotionTask("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.deepEqual(archiveBody, { archived: true });
});

test("marks a task complete using the Notion checkbox and status", async () => {
  let updateBody: Record<string, unknown> = {};
  mockNotion(page({
    Item: { type: "title", title: [{ plain_text: "Finish lab" }] },
    Status: { type: "status", status: { name: "Done" } },
    Completed: { type: "checkbox", checkbox: true },
  }), (_url, init, body) => {
    assert.equal(init.method, "PATCH");
    updateBody = body;
  });
  const task = await notion.setNotionTaskCompleted("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", true);
  const properties = updateBody.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.Completed, { checkbox: true });
  assert.deepEqual(properties.Status, { status: { name: "Done" } });
  assert.equal(task.completed, true);
});

test("rejects invalid Notion IDs before making a request", async () => {
  await assert.rejects(
    notion.archiveNotionTask("not-a-page-id"),
    (error: unknown) => error instanceof Error && /valid planner item ID/.test(error.message),
  );
});
