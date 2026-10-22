import type { GoogleWorkspaceSummary } from "@/lib/google-types";
import {
  plannerDateKey,
  plannerLocalTimeToIso,
  todayInPlannerTimeZone,
} from "@/lib/planner-datetime";
import { sanitizeProviderText } from "@/lib/google-gmail";

type CalendarEvent = GoogleWorkspaceSummary["events"][number];
type DriveFile = GoogleWorkspaceSummary["files"][number];
type GmailMessage = GoogleWorkspaceSummary["messages"][number];

export function safeGoogleExternalUrl(value: string | undefined, allowedHosts: readonly string[]): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      allowedHosts.includes(url.hostname.toLowerCase()) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function safeGmailMessageUrl(messageId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(messageId)) return undefined;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;
}

function addCalendarDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function groupUnreadMessages(
  messages: GmailMessage[],
  now = new Date(),
  olderThanDays = 7,
): { recent: GmailMessage[]; older: GmailMessage[]; undated: GmailMessage[] } {
  const cutoff = now.getTime() - olderThanDays * 86_400_000;
  return messages.reduce(
    (groups, message) => {
      const timestamp = new Date(message.date).getTime();
      if (!Number.isFinite(timestamp)) groups.undated.push(message);
      else if (timestamp < cutoff) groups.older.push(message);
      else groups.recent.push(message);
      return groups;
    },
    { recent: [] as GmailMessage[], older: [] as GmailMessage[], undated: [] as GmailMessage[] },
  );
}

export function groupCalendarEvents(
  events: CalendarEvent[],
  now = new Date(),
): { today: CalendarEvent[]; tomorrow: CalendarEvent[]; nextSevenDays: CalendarEvent[]; undated: CalendarEvent[] } {
  const today = todayInPlannerTimeZone(now);
  const tomorrow = addCalendarDays(today, 1);
  const lastDay = addCalendarDays(today, 7);
  const groups = {
    today: [] as CalendarEvent[],
    tomorrow: [] as CalendarEvent[],
    nextSevenDays: [] as CalendarEvent[],
    undated: [] as CalendarEvent[],
  };

  for (const event of events) {
    if (!event.start || (event.start.includes("T") && !Number.isFinite(new Date(event.start).getTime()))) {
      groups.undated.push(event);
      continue;
    }
    const day = plannerDateKey(event.start);
    const parsedDay = new Date(`${day}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) {
      groups.undated.push(event);
    } else if (day === today) {
      groups.today.push(event);
    } else if (day === tomorrow) {
      groups.tomorrow.push(event);
    } else if (day > tomorrow && day <= lastDay) {
      groups.nextSevenDays.push(event);
    }
  }

  return groups;
}

function eventRange(event: CalendarEvent): { start: number; end: number } | null {
  if (!event.start || !event.end) return null;
  const allDay = !event.start.includes("T") && !event.end.includes("T");
  try {
    const start = allDay
      ? new Date(plannerLocalTimeToIso(event.start.slice(0, 10), "00:00")).getTime()
      : new Date(event.start).getTime();
    const end = allDay
      ? new Date(plannerLocalTimeToIso(event.end.slice(0, 10), "00:00")).getTime()
      : new Date(event.end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end };
  } catch {
    return null;
  }
}

export function findCalendarConflicts(events: CalendarEvent[]): Array<[string, string]> {
  const ranges = events.map((event) => ({ id: event.id, range: eventRange(event) }))
    .filter((entry): entry is { id: string; range: { start: number; end: number } } => entry.range !== null);
  const conflicts: Array<[string, string]> = [];
  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      const first = ranges[left];
      const second = ranges[right];
      if (first.range.start < second.range.end && second.range.start < first.range.end) {
        conflicts.push([first.id, second.id]);
      }
    }
  }
  return conflicts;
}

export function upcomingCalendarEvents(
  events: CalendarEvent[],
  now = new Date(),
  limit = events.length,
): CalendarEvent[] {
  const currentTime = now.getTime();
  return events
    .filter((event) => {
      const range = eventRange(event);
      if (!range) return false;
      const allDay = !event.start.includes("T");
      return allDay ? range.end > currentTime : range.start >= currentTime;
    })
    .sort((left, right) => eventRange(left)!.start - eventRange(right)!.start)
    .slice(0, Math.max(0, limit));
}

export function groupDriveFiles(files: DriveFile[]): Record<string, DriveFile[]> {
  const groups: Record<string, DriveFile[]> = {
    Documents: [],
    Spreadsheets: [],
    Presentations: [],
    PDFs: [],
    Images: [],
    Folders: [],
    Other: [],
  };
  for (const file of files) {
    const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
    const group = mimeType === "application/vnd.google-apps.folder" ? "Folders"
      : mimeType === "application/pdf" ? "PDFs"
        : mimeType.startsWith("image/") ? "Images"
          : /spreadsheet|excel/i.test(mimeType) ? "Spreadsheets"
            : /presentation|powerpoint/i.test(mimeType) ? "Presentations"
              : /document|word|text\//i.test(mimeType) ? "Documents"
                : "Other";
    groups[group].push(file);
  }
  return groups;
}

export function classifyAcademicDocument(file: DriveFile): { academic: boolean; reason: string } {
  const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
  const name = typeof file.name === "string" ? file.name : "";
  const documentType = /document|word|text\/|pdf/i.test(mimeType);
  const matchedTerm = name.match(/\b(syllabus|course|lecture|assignment|exam|semester|academic|transcript|research|study notes)\b/i)?.[0];
  if (documentType && matchedTerm) {
    return { academic: true, reason: `Document filename contains the academic term “${matchedTerm}”.` };
  }
  return { academic: false, reason: "No academic-document filename rule matched." };
}

export function buildGoogleServiceHealth(summary: GoogleWorkspaceSummary, loading: boolean, overallError = false) {
  const serviceKeys = ["gmail", "calendar", "drive"] as const;
  const statuses = Object.fromEntries(serviceKeys.map((service) => [
    service,
    !summary.connected ? "Unavailable"
      : summary.errors?.[service] || overallError ? "Error"
        : "Connected",
  ])) as Record<(typeof serviceKeys)[number], "Unavailable" | "Error" | "Connected">;

  return {
    loading,
    statuses,
    counts: {
      unread: statuses.gmail === "Connected" ? summary.unreadEmails : null,
      upcoming: statuses.calendar === "Connected" ? summary.events.length : null,
      files: statuses.drive === "Connected" ? summary.files.length : null,
    },
  };
}

export function googleWorkspaceViewState({
  loaded,
  loading,
  summary,
}: {
  loaded: boolean;
  loading: boolean;
  summary: GoogleWorkspaceSummary;
}): "loading" | "disconnected" | "empty" | "connected" {
  if (!loaded && loading) return "loading";
  if (!summary.connected) return "disconnected";
  const allDataEmpty = summary.unreadEmails === 0 && summary.messages.length === 0 &&
    summary.events.length === 0 && summary.files.length === 0;
  return allDataEmpty && !Object.keys(summary.errors ?? {}).length ? "empty" : "connected";
}

export function buildGoogleBriefingInput(summary: GoogleWorkspaceSummary) {
  return {
    unreadEmails: summary.errors?.gmail ? null : summary.unreadEmails,
    recentUnreadMessages: summary.errors?.gmail ? [] : summary.messages.map(({ from, subject, date, snippet, body }) => ({
      from: sanitizeProviderText(from, 120),
      subject: sanitizeProviderText(subject, 200),
      date: sanitizeProviderText(date, 100),
      snippet: sanitizeProviderText(snippet, 300),
      body: body ? sanitizeProviderText(body, 1000) : "",
    })),
    nextCalendarEvents: summary.errors?.calendar ? [] : summary.events.map(({ title, start, end }) => ({
      title: sanitizeProviderText(title, 200),
      start: sanitizeProviderText(start, 100),
      end: sanitizeProviderText(end, 100),
    })),
    recentDriveFiles: summary.errors?.drive ? [] : summary.files.map(({ name, mimeType, modifiedTime }) => ({
      name: sanitizeProviderText(name, 200),
      mimeType: sanitizeProviderText(mimeType, 100),
      modifiedTime: sanitizeProviderText(modifiedTime ?? "", 100),
    })),
  };
}
