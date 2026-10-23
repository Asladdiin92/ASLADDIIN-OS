import type { Task } from "@/lib/types";

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";
const TASK_CACHE_TTL_MS = 10_000;

type NotionValue = {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  date?: { start?: string; end?: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  number?: number | null;
  people?: Array<{ id?: string; name?: string }>;
};

type NotionPage = {
  id: string;
  url: string;
  created_time: string;
  last_edited_time?: string;
  properties: Record<string, NotionValue>;
};

type NotionQueryResponse = {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
};

type NotionPropertySchema = {
  type?: string;
  title?: Record<string, never>;
  rich_text?: Record<string, never>;
  select?: { options?: Array<{ name: string }> };
  status?: { options?: Array<{ name: string }> };
  number?: Record<string, never>;
  date?: Record<string, never>;
  checkbox?: Record<string, never>;
  url?: Record<string, never>;
  people?: Record<string, never>;
};

type NotionDatabase = {
  properties: Record<string, NotionPropertySchema>;
};

type TaskCacheEntry = { tasks: Task[]; expiresAt: number };
let taskCache: TaskCacheEntry | undefined;
let taskFetchInFlight: Promise<Task[]> | undefined;
let taskCacheVersion = 0;

export type CreateTaskInput = {
  title: string;
  type?: string;
  status?: string;
  priority?: string;
  area?: string;
  course?: string;
  courseCode?: string;
  estimatedHours?: number | null;
  actualHours?: number | null;
  assessment?: string;
  creditHours?: number | null;
  instructor?: string;
  marksGrade?: string;
  nextReviewDate?: string;
  notes?: string;
  recurrence?: string;
  resourceLink?: string;
  semester?: string;
  timeBlock?: string;
  venueLink?: string;
  dueDate?: string;
  dateEnd?: string;
  deliverable?: boolean;
  nextAction?: string;
};

export type TaskOptions = Awaited<ReturnType<typeof fetchNotionTaskOptions>>;

function notionToken(): string {
  const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error("Add NOTION_API_KEY (or NOTION_TOKEN) and NOTION_DATABASE_ID to .env.local, then restart the dev server.");
  }
  return token;
}

function notionDatabaseId(): string {
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    throw new Error("Add NOTION_DATABASE_ID to .env.local, then restart the dev server.");
  }
  return databaseId;
}

function notionHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionError(response: Response): Promise<Error> {
  const details = await response.json().catch(() => null) as { message?: string; code?: string } | null;
  if (response.status === 401) return new Error("Notion rejected the integration token. Check NOTION_API_KEY in .env.local.");
  if (response.status === 404) return new Error("Notion could not find this database. Check NOTION_DATABASE_ID and share the database with your integration.");
  return new Error(`Notion API error${details?.code ? ` (${details.code})` : ""}: ${details?.message ?? response.statusText}`);
}

const PROPERTY_ALIASES: Record<string, string[]> = {
  NOTION_ESTIMATED_HOURS_PROPERTY: ["Estimated Hours"],
  NOTION_ACTUAL_HOURS_PROPERTY: ["Actual Hours"],
  NOTION_ASSESSMENT_PROPERTY: ["Assessment Type"],
  NOTION_VENUE_LINK_PROPERTY: ["Venue / Link"],
};

async function fetchDatabase(): Promise<NotionDatabase> {
  const token = notionToken();
  const response = await fetch(`${NOTION_API}/databases/${encodeURIComponent(notionDatabaseId())}`, {
    headers: notionHeaders(token),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await notionError(response);
  return await response.json() as NotionDatabase;
}

function configuredProperty(properties: Record<string, NotionValue>, variable: string, fallback: string): string | undefined {
  const names = [process.env[variable], fallback, ...(PROPERTY_ALIASES[variable] ?? [])].filter(
    (name): name is string => Boolean(name),
  );
  const name = names.find((candidate) => properties[candidate]);
  if (name) return name;
  const value = Object.entries(properties).find(([, property]) => property.type === fallback);
  return value?.[0];
}

function schemaProperty(properties: Record<string, NotionPropertySchema>, variable: string, fallback: string): string | undefined {
  const names = [process.env[variable], fallback, ...(PROPERTY_ALIASES[variable] ?? [])].filter(
    (name): name is string => Boolean(name),
  );
  const name = names.find((candidate) => properties[candidate]);
  if (name) return name;
  const value = Object.entries(properties).find(([, property]) => property.type === fallback);
  return value?.[0];
}

function optionsFor(
  properties: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
): string[] {
  const name = schemaProperty(properties, variable, fallback);
  if (!name) return [];
  const property = properties[name];
  return (property.select?.options ?? property.status?.options ?? []).map((option) => option.name);
}

export async function fetchNotionTaskOptions() {
  const { properties } = await fetchDatabase();
  const mappedProperties: Array<[string, string, string, string]> = [
    ["courseCode", "NOTION_COURSE_CODE_PROPERTY", "Course Code", "rich_text"],
    ["estimatedHours", "NOTION_ESTIMATED_HOURS_PROPERTY", "Est.", "number"],
    ["actualHours", "NOTION_ACTUAL_HOURS_PROPERTY", "Actual", "number"],
    ["assessment", "NOTION_ASSESSMENT_PROPERTY", "Assessment", "select"],
    ["creditHours", "NOTION_CREDIT_HOURS_PROPERTY", "Credit Hours", "number"],
    ["instructor", "NOTION_INSTRUCTOR_PROPERTY", "Instructor", "rich_text"],
    ["peopleInstructor", "NOTION_PEOPLE_INSTRUCTOR_PROPERTY", "People / Instructor", "people"],
    ["marksGrade", "NOTION_MARKS_GRADE_PROPERTY", "Marks / Grade", "rich_text"],
    ["nextReviewDate", "NOTION_NEXT_REVIEW_DATE_PROPERTY", "Next Review Date", "date"],
    ["notes", "NOTION_NOTES_PROPERTY", "Notes", "rich_text"],
    ["recurrence", "NOTION_RECURRENCE_PROPERTY", "Recurrence", "rich_text"],
    ["resourceLink", "NOTION_RESOURCE_LINK_PROPERTY", "Resource Link", "link"],
    ["semester", "NOTION_SEMESTER_PROPERTY", "Semester", "select"],
    ["timeBlock", "NOTION_TIME_BLOCK_PROPERTY", "Time Block", "rich_text"],
    ["venueLink", "NOTION_VENUE_LINK_PROPERTY", "Venue Link", "link"],
    ["nextAction", "NOTION_NEXT_ACTION_PROPERTY", "Next Action", "rich_text"],
    ["dateEnd", "NOTION_DUE_DATE_PROPERTY", "Date", "date"],
    ["deliverable", "NOTION_DELIVERABLE_PROPERTY", "Deliverable", "checkbox"],
  ];
  return {
    types: optionsFor(properties, "NOTION_TYPE_PROPERTY", "Type"),
    statuses: optionsFor(properties, "NOTION_STATUS_PROPERTY", "Status"),
    priorities: optionsFor(properties, "NOTION_PRIORITY_PROPERTY", "Priority"),
    areas: optionsFor(properties, "NOTION_AREA_PROPERTY", "Area"),
    courses: optionsFor(properties, "NOTION_COURSE_PROPERTY", "Course"),
    assessments: optionsFor(properties, "NOTION_ASSESSMENT_PROPERTY", "Assessment"),
    semesters: optionsFor(properties, "NOTION_SEMESTER_PROPERTY", "Semester"),
    availableFields: mappedProperties.flatMap(([field, variable, fallback, type]) => {
      const name = schemaProperty(properties, variable, fallback);
      return name && (type === "link"
        ? ["url", "rich_text"].includes(properties[name]?.type ?? "")
        : properties[name]?.type === type) ? [field] : [];
    }),
  };
}

function addChoiceProperty(
  target: Record<string, unknown>,
  properties: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  value: string | undefined,
  kind: "select" | "status",
): void {
  if (!value) return;
  const name = schemaProperty(properties, variable, fallback);
  if (!name || properties[name]?.type !== kind) {
    throw new Error(`The Notion database does not have a ${kind} property named "${process.env[variable] || fallback}".`);
  }
  const options = kind === "status" ? properties[name]?.status?.options : properties[name]?.select?.options;
  if (!options?.some((option) => option.name === value)) {
    throw new Error(`"${value}" is not an available option for ${name}. Refresh the dashboard and choose an option from the list.`);
  }
  target[name] = kind === "status" ? { status: { name: value } } : { select: { name: value } };
}

function defaultChoice(
  properties: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  preferred: string[],
  kind: "select" | "status",
): string | undefined {
  const name = schemaProperty(properties, variable, fallback);
  if (!name || properties[name]?.type !== kind) return undefined;
  const options = kind === "status" ? properties[name]?.status?.options : properties[name]?.select?.options;
  const available = options?.map((option) => option.name) ?? [];
  return preferred.find((choice) => available.includes(choice)) ?? available[0];
}

function taskProperties(
  schema: Record<string, NotionPropertySchema>,
  input: CreateTaskInput,
  clearEmptyOptional: boolean,
): Record<string, unknown> {
  const title = input.title.trim();
  if (!title || title.length > 2000) throw new Error("Enter a title between 1 and 2,000 characters.");

  const titleName = schemaProperty(schema, "NOTION_TITLE_PROPERTY", "title");
  if (!titleName || schema[titleName]?.type !== "title") {
    throw new Error("The Notion database needs a title property. Check NOTION_TITLE_PROPERTY.");
  }
  const properties: Record<string, unknown> = {
    [titleName]: { title: [{ text: { content: title } }] },
  };

  const type = input.type?.trim() || defaultChoice(schema, "NOTION_TYPE_PROPERTY", "Type", ["Deliverable", "Task"], "select");
  const status = input.status?.trim() || defaultChoice(schema, "NOTION_STATUS_PROPERTY", "Status", ["Planned", "Not started"], "status");
  const priority = input.priority?.trim() || (!clearEmptyOptional
    ? defaultChoice(schema, "NOTION_PRIORITY_PROPERTY", "Priority", ["Medium", "Normal", "Low"], "select")
    : undefined);
  if (!type) throw new Error("Add at least one option to the Notion Type property.");
  if (!status) throw new Error("Add at least one option to the Notion Status property.");

  addChoiceProperty(properties, schema, "NOTION_TYPE_PROPERTY", "Type", type, "select");
  addChoiceProperty(properties, schema, "NOTION_STATUS_PROPERTY", "Status", status, "status");
  addChoiceProperty(properties, schema, "NOTION_PRIORITY_PROPERTY", "Priority", priority, "select");
  addChoiceProperty(properties, schema, "NOTION_AREA_PROPERTY", "Area", input.area, "select");
  addChoiceProperty(properties, schema, "NOTION_COURSE_PROPERTY", "Course", input.course, "select");
  addChoiceProperty(properties, schema, "NOTION_ASSESSMENT_PROPERTY", "Assessment", input.assessment, "select");
  addChoiceProperty(properties, schema, "NOTION_SEMESTER_PROPERTY", "Semester", input.semester, "select");
  addTextProperty(properties, schema, "NOTION_COURSE_CODE_PROPERTY", "Course Code", input.courseCode);
  addTextProperty(properties, schema, "NOTION_NEXT_ACTION_PROPERTY", "Next Action", input.nextAction);
  addTextProperty(properties, schema, "NOTION_INSTRUCTOR_PROPERTY", "Instructor", input.instructor);
  addTextProperty(properties, schema, "NOTION_MARKS_GRADE_PROPERTY", "Marks / Grade", input.marksGrade);
  addTextProperty(properties, schema, "NOTION_NOTES_PROPERTY", "Notes", input.notes);
  addTextProperty(properties, schema, "NOTION_RECURRENCE_PROPERTY", "Recurrence", input.recurrence);
  addTextProperty(properties, schema, "NOTION_TIME_BLOCK_PROPERTY", "Time Block", input.timeBlock);
  addNumberProperty(properties, schema, "NOTION_ESTIMATED_HOURS_PROPERTY", "Est.", input.estimatedHours);
  addNumberProperty(properties, schema, "NOTION_ACTUAL_HOURS_PROPERTY", "Actual", input.actualHours);
  addNumberProperty(properties, schema, "NOTION_CREDIT_HOURS_PROPERTY", "Credit Hours", input.creditHours);
  addLinkProperty(properties, schema, "NOTION_RESOURCE_LINK_PROPERTY", "Resource Link", input.resourceLink);
  addLinkProperty(properties, schema, "NOTION_VENUE_LINK_PROPERTY", "Venue Link", input.venueLink);
  addCheckboxProperty(properties, schema, "NOTION_DELIVERABLE_PROPERTY", "Deliverable", input.deliverable);

  if (clearEmptyOptional) {
    clearChoiceProperty(properties, schema, "NOTION_PRIORITY_PROPERTY", "Priority", input.priority);
    clearChoiceProperty(properties, schema, "NOTION_AREA_PROPERTY", "Area", input.area);
    clearChoiceProperty(properties, schema, "NOTION_COURSE_PROPERTY", "Course", input.course);
    clearChoiceProperty(properties, schema, "NOTION_ASSESSMENT_PROPERTY", "Assessment", input.assessment);
    clearChoiceProperty(properties, schema, "NOTION_SEMESTER_PROPERTY", "Semester", input.semester);
    clearTextProperty(properties, schema, "NOTION_COURSE_CODE_PROPERTY", "Course Code", input.courseCode);
    clearTextProperty(properties, schema, "NOTION_NEXT_ACTION_PROPERTY", "Next Action", input.nextAction);
    clearTextProperty(properties, schema, "NOTION_INSTRUCTOR_PROPERTY", "Instructor", input.instructor);
    clearTextProperty(properties, schema, "NOTION_MARKS_GRADE_PROPERTY", "Marks / Grade", input.marksGrade);
    clearTextProperty(properties, schema, "NOTION_NOTES_PROPERTY", "Notes", input.notes);
    clearTextProperty(properties, schema, "NOTION_RECURRENCE_PROPERTY", "Recurrence", input.recurrence);
    clearTextProperty(properties, schema, "NOTION_TIME_BLOCK_PROPERTY", "Time Block", input.timeBlock);
    clearNumberProperty(properties, schema, "NOTION_ESTIMATED_HOURS_PROPERTY", "Est.", input.estimatedHours);
    clearNumberProperty(properties, schema, "NOTION_ACTUAL_HOURS_PROPERTY", "Actual", input.actualHours);
    clearNumberProperty(properties, schema, "NOTION_CREDIT_HOURS_PROPERTY", "Credit Hours", input.creditHours);
    clearLinkProperty(properties, schema, "NOTION_RESOURCE_LINK_PROPERTY", "Resource Link", input.resourceLink);
    clearLinkProperty(properties, schema, "NOTION_VENUE_LINK_PROPERTY", "Venue Link", input.venueLink);
  }

  const dateName = schemaProperty(schema, "NOTION_DUE_DATE_PROPERTY", "Date");
  if (input.dueDate?.trim()) {
    validateDueDate(input.dueDate);
    if (input.dateEnd?.trim()) {
      validateDueDate(input.dateEnd);
      if (new Date(input.dateEnd).getTime() < new Date(input.dueDate).getTime()) {
        throw new Error("The end date must be on or after the start date.");
      }
    }
    if (!dateName || schema[dateName]?.type !== "date") {
      throw new Error(`The Notion database does not have a date property named "${process.env.NOTION_DUE_DATE_PROPERTY || "Date"}".`);
    }
    properties[dateName] = { date: { start: input.dueDate, ...(input.dateEnd?.trim() ? { end: input.dateEnd } : {}) } };
  } else if (clearEmptyOptional && input.dueDate === "" && dateName && schema[dateName]?.type === "date") {
    properties[dateName] = { date: null };
  }
  const reviewDateName = schemaProperty(schema, "NOTION_NEXT_REVIEW_DATE_PROPERTY", "Next Review Date");
  if (input.nextReviewDate?.trim()) {
    validateDueDate(input.nextReviewDate);
    if (!reviewDateName || schema[reviewDateName]?.type !== "date") {
      throw new Error(`The Notion database does not have a date property named "${process.env.NOTION_NEXT_REVIEW_DATE_PROPERTY || "Next Review Date"}".`);
    }
    properties[reviewDateName] = { date: { start: input.nextReviewDate } };
  } else if (clearEmptyOptional && input.nextReviewDate === "" && reviewDateName && schema[reviewDateName]?.type === "date") {
    properties[reviewDateName] = { date: null };
  }

  function addNumberProperty(
    target: Record<string, unknown>,
    schema: Record<string, NotionPropertySchema>,
    variable: string,
    fallback: string,
    value: number | null | undefined,
  ): void {
    if (value === undefined || value === null) return;
    const name = schemaProperty(schema, variable, fallback);
    if (!name || schema[name]?.type !== "number") {
      throw new Error(`The Notion database does not have a number property named "${process.env[variable] || fallback}".`);
    }
    if (!Number.isFinite(value) || value < 0 || value > 10000) {
      throw new Error(`${fallback} must be a number between 0 and 10,000.`);
    }
    target[name] = { number: value };
  }

  function addCheckboxProperty(
    target: Record<string, unknown>,
    schema: Record<string, NotionPropertySchema>,
    variable: string,
    fallback: string,
    value: boolean | undefined,
  ): void {
    if (value === undefined) return;
    const name = schemaProperty(schema, variable, fallback);
    if (!name || schema[name]?.type !== "checkbox") {
      throw new Error(`The Notion database does not have a checkbox property named "${process.env[variable] || fallback}".`);
    }
    target[name] = { checkbox: value };
  }

  function addLinkProperty(
    target: Record<string, unknown>,
    schema: Record<string, NotionPropertySchema>,
    variable: string,
    fallback: string,
    value: string | undefined,
  ): void {
    if (!value?.trim()) return;
    const name = schemaProperty(schema, variable, fallback);
    if (!name || !["url", "rich_text"].includes(schema[name]?.type ?? "")) {
      throw new Error(`The Notion database does not have a URL or text property named "${process.env[variable] || fallback}".`);
    }
    if (schema[name]?.type === "url") {
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(`${fallback} must be a valid http or https URL.`);
      }
      target[name] = { url: value };
    } else {
      target[name] = { rich_text: [{ text: { content: value } }] };
    }
  }

  return properties;
}

function clearChoiceProperty(
  target: Record<string, unknown>,
  schema: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  value: string | undefined,
): void {
  if (value === undefined || value.trim()) return;
  const name = schemaProperty(schema, variable, fallback);
  if (name && schema[name]?.type === "select") target[name] = { select: null };
}

function clearTextProperty(
  target: Record<string, unknown>,
  schema: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  value: string | undefined,
): void {
  if (value === undefined || value.trim()) return;
  const name = schemaProperty(schema, variable, fallback);
  if (name && schema[name]?.type === "rich_text") target[name] = { rich_text: [] };
}

function clearNumberProperty(
  target: Record<string, unknown>,
  schema: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  value: number | null | undefined,
): void {
  if (value !== null) return;
  const name = schemaProperty(schema, variable, fallback);
  if (name && schema[name]?.type === "number") target[name] = { number: null };
}

function clearLinkProperty(
  target: Record<string, unknown>,
  schema: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  value: string | undefined,
): void {
  if (value === undefined || value.trim()) return;
  const name = schemaProperty(schema, variable, fallback);
  if (name && schema[name]?.type === "url") target[name] = { url: null };
  if (name && schema[name]?.type === "rich_text") target[name] = { rich_text: [] };
}

function validateDueDate(value: string): void {
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const validDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const parsedDate = new Date(validDate ? `${value}T00:00:00.000Z` : value);
  const datePart = value.slice(0, 10);
  const parsedDatePart = new Date(`${datePart}T00:00:00.000Z`);
  if ((!validDate && !validDateTime) || Number.isNaN(parsedDate.getTime()) ||
      Number.isNaN(parsedDatePart.getTime()) || parsedDatePart.toISOString().slice(0, 10) !== datePart) {
    throw new Error("Choose a valid due date.");
  }
}

function addTextProperty(
  target: Record<string, unknown>,
  properties: Record<string, NotionPropertySchema>,
  variable: string,
  fallback: string,
  value: string | undefined,
): void {
  if (!value) return;
  const name = schemaProperty(properties, variable, fallback);
  if (!name || properties[name]?.type !== "rich_text") {
    throw new Error(`The Notion database does not have a text property named "${process.env[variable] || fallback}".`);
  }
  const characters = Array.from(value);
  const richText: Array<{ text: { content: string } }> = [];
  for (let offset = 0; offset < characters.length; offset += 2_000) {
    richText.push({ text: { content: characters.slice(offset, offset + 2_000).join("") } });
  }
  target[name] = { rich_text: richText };
}

export async function createNotionTask(input: CreateTaskInput): Promise<Task> {
  const token = notionToken();
  const databaseId = notionDatabaseId();
  const database = await fetchDatabase();
  validateInputLengths(input);
  const properties = taskProperties(database.properties, input, false);

  const response = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await notionError(response);
  const page = await response.json() as NotionPage;
  invalidateNotionTasksCache();
  return toTask(page);
}

export async function updateNotionTask(pageId: string, input: CreateTaskInput): Promise<Task> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
    throw new Error("Enter a valid planner item ID.");
  }
  validateInputLengths(input);
  const token = notionToken();
  const database = await fetchDatabase();
  const properties = taskProperties(database.properties, input, true);
  const response = await fetch(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await notionError(response);
  invalidateNotionTasksCache();
  return toTask(await response.json() as NotionPage);
}

export async function setNotionTaskCompleted(pageId: string, completed: boolean): Promise<Task> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
    throw new Error("Enter a valid planner item ID.");
  }
  const database = await fetchDatabase();
  const properties: Record<string, unknown> = {};
  const checkboxName = schemaProperty(database.properties, "NOTION_COMPLETED_PROPERTY", "Completed");
  if (checkboxName && database.properties[checkboxName]?.type === "checkbox") {
    properties[checkboxName] = { checkbox: completed };
  }
  const statusName = schemaProperty(database.properties, "NOTION_STATUS_PROPERTY", "Status");
  if (statusName && database.properties[statusName]?.type === "status") {
    const statuses = database.properties[statusName]?.status?.options?.map((option) => option.name) ?? [];
    const desiredStatus = completed
      ? statuses.find((value) => /^(done|complete|completed|finished)$/i.test(value))
      : statuses.find((value) => /^(planned|not started)$/i.test(value));
    if (desiredStatus) properties[statusName] = { status: { name: desiredStatus } };
  }
  if (Object.keys(properties).length === 0) {
    throw new Error("Add a Completed checkbox or a Done status option to your Notion database to mark tasks complete.");
  }
  const response = await fetch(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    headers: notionHeaders(notionToken()),
    body: JSON.stringify({ properties }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await notionError(response);
  invalidateNotionTasksCache();
  return toTask(await response.json() as NotionPage);
}

export async function archiveNotionTask(pageId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
    throw new Error("Enter a valid planner item ID.");
  }
  const response = await fetch(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    headers: notionHeaders(notionToken()),
    body: JSON.stringify({ archived: true }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await notionError(response);
  invalidateNotionTasksCache();
}

function validateInputLengths(input: CreateTaskInput): void {
  for (const [label, value] of Object.entries(input)) {
    const maximumLength = label === "notes" ? 50_000 : 2_000;
    if (typeof value === "string" && value.length > maximumLength) {
      throw new Error(`${label} must be ${maximumLength.toLocaleString("en")} characters or fewer.`);
    }
  }
}

function text(value: NotionValue | undefined): string {
  if (!value) return "";
  if (value.title) return value.title.map((part) => part.plain_text ?? "").join("");
  if (value.rich_text) return value.rich_text.map((part) => part.plain_text ?? "").join("");
  if (value.select?.name) return value.select.name;
  if (value.status?.name) return value.status.name;
  if (value.multi_select) return value.multi_select.map((item) => item.name ?? "").filter(Boolean).join(", ");
  if (value.type === "url") return value.url ?? "";
  if (value.type === "email") return value.email ?? "";
  if (value.type === "phone_number") return value.phone_number ?? "";
  if (typeof value.number === "number") return String(value.number);
  return "";
}

function propertyText(properties: Record<string, NotionValue>, variable: string, fallback: string): string {
  const name = configuredProperty(properties, variable, fallback);
  return name ? text(properties[name]) : "";
}

function toTask(page: NotionPage): Task {
  const properties = page.properties ?? {};
  const titleProperty = configuredProperty(properties, "NOTION_TITLE_PROPERTY", "title")
    ?? Object.keys(properties).find((name) => properties[name]?.type === "title");
  const status = propertyText(properties, "NOTION_STATUS_PROPERTY", "Status") || "Not started";
  const completedName = configuredProperty(properties, "NOTION_COMPLETED_PROPERTY", "Completed");
  const checkboxCompleted = completedName ? properties[completedName]?.checkbox === true : false;
  const done = /^(done|complete|completed|finished)$/i.test(status.trim());
  const dueDateProperty = configuredProperty(properties, "NOTION_DUE_DATE_PROPERTY", "Date");
  const dateValue = dueDateProperty ? properties[dueDateProperty]?.date : null;
  const dueDate = dateValue?.start ?? null;
  const nextReviewProperty = configuredProperty(properties, "NOTION_NEXT_REVIEW_DATE_PROPERTY", "Next Review Date");
  const numberProperty = (variable: string, fallback: string) => {
    const name = configuredProperty(properties, variable, fallback);
    const value = name ? properties[name]?.number : null;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const peoplePropertyName = configuredProperty(properties, "NOTION_PEOPLE_INSTRUCTOR_PROPERTY", "People / Instructor");
  const peopleInstructor = peoplePropertyName
    ? (properties[peoplePropertyName]?.people ?? []).map((person) => person.name || person.id || "").filter(Boolean)
    : [];
  const peopleInstructorIds = peoplePropertyName
    ? (properties[peoplePropertyName]?.people ?? []).map((person) => person.id ?? "").filter(Boolean)
    : [];

  return {
    id: page.id,
    url: page.url,
    title: (titleProperty ? text(properties[titleProperty]) : "") || "Untitled item",
    status,
    priority: propertyText(properties, "NOTION_PRIORITY_PROPERTY", "Priority") || "Unassigned",
    type: propertyText(properties, "NOTION_TYPE_PROPERTY", "Type") || "Other",
    area: propertyText(properties, "NOTION_AREA_PROPERTY", "Area") || "Unassigned",
    course: propertyText(properties, "NOTION_COURSE_PROPERTY", "Course"),
    courseCode: propertyText(properties, "NOTION_COURSE_CODE_PROPERTY", "Course Code"),
    estimatedHours: (() => {
      const name = configuredProperty(properties, "NOTION_ESTIMATED_HOURS_PROPERTY", "Est.");
      const value = name ? properties[name]?.number : null;
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    })(),
    actualHours: numberProperty("NOTION_ACTUAL_HOURS_PROPERTY", "Actual"),
    assessment: propertyText(properties, "NOTION_ASSESSMENT_PROPERTY", "Assessment"),
    creditHours: numberProperty("NOTION_CREDIT_HOURS_PROPERTY", "Credit Hours"),
    instructor: propertyText(properties, "NOTION_INSTRUCTOR_PROPERTY", "Instructor"),
    peopleInstructor,
    peopleInstructorIds,
    marksGrade: propertyText(properties, "NOTION_MARKS_GRADE_PROPERTY", "Marks / Grade"),
    nextReviewDate: nextReviewProperty ? properties[nextReviewProperty]?.date?.start ?? null : null,
    notes: propertyText(properties, "NOTION_NOTES_PROPERTY", "Notes"),
    recurrence: propertyText(properties, "NOTION_RECURRENCE_PROPERTY", "Recurrence"),
    resourceLink: propertyText(properties, "NOTION_RESOURCE_LINK_PROPERTY", "Resource Link"),
    semester: propertyText(properties, "NOTION_SEMESTER_PROPERTY", "Semester"),
    timeBlock: propertyText(properties, "NOTION_TIME_BLOCK_PROPERTY", "Time Block"),
    venueLink: propertyText(properties, "NOTION_VENUE_LINK_PROPERTY", "Venue Link"),
    nextAction: propertyText(properties, "NOTION_NEXT_ACTION_PROPERTY", "Next Action"),
    dueDate,
    dateEnd: dateValue?.end ?? null,
    dateIsDateTime: Boolean(dueDate?.includes("T")),
    deliverable: (() => {
      const name = configuredProperty(properties, "NOTION_DELIVERABLE_PROPERTY", "Deliverable");
      return name ? properties[name]?.checkbox === true : /deliverable/i.test(propertyText(properties, "NOTION_TYPE_PROPERTY", "Type"));
    })(),
    createdAt: page.created_time,
    updatedAt: page.last_edited_time ?? page.created_time,
    completed: checkboxCompleted || done,
  };
}

async function fetchNotionTasksUncached(): Promise<Task[]> {
  const token = notionToken();
  const databaseId = notionDatabaseId();

  const tasks: Task[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(`${NOTION_API}/databases/${encodeURIComponent(databaseId)}/query`, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw await notionError(response);
    }

    const data = await response.json() as NotionQueryResponse;
    tasks.push(...data.results.map(toTask));
    if (!data.has_more || !data.next_cursor) return tasks;
    cursor = data.next_cursor;
  }

  throw new Error("The database has more than 2,000 entries. Add a database filter or narrow the dashboard query.");
}

export function invalidateNotionTasksCache(): void {
  taskCacheVersion += 1;
  taskCache = undefined;
  taskFetchInFlight = undefined;
}

export async function fetchNotionTasks(): Promise<Task[]> {
  const now = Date.now();
  if (taskCache && taskCache.expiresAt > now) return structuredClone(taskCache.tasks);
  if (taskFetchInFlight) return taskFetchInFlight.then((tasks) => structuredClone(tasks));

  const cacheVersion = taskCacheVersion;
  const request = fetchNotionTasksUncached()
    .then((tasks) => {
      if (cacheVersion === taskCacheVersion) {
        taskCache = { tasks, expiresAt: Date.now() + TASK_CACHE_TTL_MS };
      }
      return tasks;
    })
    .finally(() => {
      if (taskFetchInFlight === request) taskFetchInFlight = undefined;
    });
  taskFetchInFlight = request;
  return request.then((tasks) => structuredClone(tasks));
}
