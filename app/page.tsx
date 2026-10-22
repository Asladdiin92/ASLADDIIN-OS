"use client";

import { useClerk, useUser, UserButton } from "@clerk/nextjs";
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ChevronDown,
  Clock3,
  Columns3,
  Download,
  ExternalLink,
  Flame,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  LucideIcon,
  Mail,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  StickyNote,
  Target,
  Terminal,
  Trash2,
  UserRound,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  PriorityChart,
  StatusChart,
  TimelineChart,
  TypeChart,
} from "@/components/dashboard-charts";
import { PlannerAssistant } from "@/components/planner-assistant";
import { AIRecommendationsPanel, NextBestActionPanel } from "@/components/dashboard-insights";
import { DailyBriefingPanel } from "@/components/daily-briefing";
import { RecentActivityTimeline } from "@/components/recent-activity-timeline";
import { MetricsGrid } from "@/components/dashboard-metrics";
import { ProviderIntegrations } from "@/components/provider-integrations";
import { GoogleConnectionCard, GoogleWorkspacePage, WorkspaceAttention } from "@/components/google-workspace";
import type { Task, TaskOptions, TasksResponse } from "@/lib/types";
import type { GoogleWorkspaceSummary } from "@/lib/google-types";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";
import {
  formatPlannerDate as formatDate,
  plannerDateKey,
  plannerDateTimeInput as dateTimeLocalValue,
  plannerLocalTimeToIso,
  PLANNER_TIME_ZONE,
  todayInPlannerTimeZone,
} from "@/lib/planner-datetime";

type LoadState = "loading" | "ready" | "error";
type TaskMutationResponse = { ok: boolean; task?: Task; error?: string };
type SidebarNavigationItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  target?: string;
  count?: number;
  badge?: string;
  action?: () => void;
};
type SidebarNavigationGroup = { label: string; items: SidebarNavigationItem[] };

const isoToday = todayInPlannerTimeZone;
const emptyGoogleSummary: GoogleWorkspaceSummary = {
  connected: false,
  unreadEmails: 0,
  messages: [],
  events: [],
  files: [],
};
const dashboardTabs = [
  "overview", "planner-assistant", "tasks", "projects", "notes", "calendar", "progress", "integrations", "google-workspace",
  "goals", "knowledge", "system-activity", "completed-work", "project-progress", "reviews", "ai-observations",
  "appearance", "notifications", "privacy", "authentication", "ai-preferences", "integration-permissions", "data-controls",
];

function countBy(tasks: Task[], select: (task: Task) => string) {
  const counts = new Map<string, number>();
  tasks.forEach((task) => {
    const name = select(task).trim() || "Other";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return Array.from(counts, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

function supportsSemester(options: TaskOptions | null): options is TaskOptions {
  return Boolean(options?.availableFields.includes("semester"));
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function getTimeline(tasks: Task[]) {
  const now = new Date();
  const [year, month] = todayInPlannerTimeZone(now).split("-").map(Number);
  const months = Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(year, month - 6 + index, 15)));
  const counts = months.map((month) => {
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    const count = tasks.filter((task) => {
      return plannerDateKey(task.createdAt).slice(0, 7) === key;
    }).length;
    return { month: new Intl.DateTimeFormat("en", { month: "short", timeZone: PLANNER_TIME_ZONE }).format(month), count };
  });
  return counts;
}

function isOverdue(task: Task, today: string) {
  const deadline = task.dateEnd || task.dueDate;
  return !task.completed && Boolean(deadline) && plannerDateKey(deadline!) < today;
}

function isScheduledForDay(task: Task, today: string): boolean {
  if (task.completed) return false;
  if (task.dueDate) {
    const start = plannerDateKey(task.dueDate);
    const end = plannerDateKey(task.dateEnd || task.dueDate);
    if (start <= today && today <= end) return true;
  }
  const recurrence = task.recurrence ?? "";
  if (/\b(daily|every day|each day)\b/i.test(recurrence)) return true;
  if (/\bweekdays\b/i.test(recurrence)) {
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5;
  }
  return false;
}

function getMyDayTasks(tasks: Task[], today: string): Task[] {
  const priorityRank = (priority: string) =>
    ({ Critical: 0, High: 1, Medium: 2, Low: 3 }[priority as "Critical" | "High" | "Medium" | "Low"] ?? 4);
  return tasks.filter((task) => isScheduledForDay(task, today) || isOverdue(task, today))
    .sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      Number(isOverdue(b, today)) - Number(isOverdue(a, today)) ||
      plannerDateKey(a.dueDate ?? "9999-12-31").localeCompare(plannerDateKey(b.dueDate ?? "9999-12-31")) ||
      a.title.localeCompare(b.title),
    )
    .slice(0, 8);
}

function Sidebar({
  onClose,
  activeTarget,
  onSelectTarget,
  taskCount,
  projectCount,
  meetingCount,
}: {
  onClose?: () => void;
  activeTarget: string;
  onSelectTarget: (target: string) => void;
  taskCount: number;
  projectCount: number;
  meetingCount: number;
}) {
  const clerk = useClerk();
  const navigationGroups: SidebarNavigationGroup[] = [
    {
      label: "MAIN",
      items: [
        { id: "overview", label: "Dashboard", icon: LayoutDashboard, target: "overview" },
        { id: "planner-assistant", label: "AI Assistant", icon: Sparkles, target: "planner-assistant" },
      ],
    },
    {
      label: "WORKSPACE",
      items: [
        { id: "tasks", label: "Tasks", icon: ListChecks, target: "tasks", count: taskCount, badge: "tasks-badge" },
        { id: "notes", label: "Notes", icon: StickyNote, target: "notes" },
        { id: "projects", label: "Projects", icon: GitBranch, target: "projects", count: projectCount, badge: "projects-badge" },
        { id: "calendar", label: "Calendar", icon: CalendarDays, target: "calendar", count: meetingCount, badge: "calendar-badge" },
        { id: "goals", label: "Goals", icon: Target, target: "goals" },
        { id: "knowledge", label: "Knowledge", icon: BookOpen, target: "knowledge" },
      ],
    },
    {
      label: "ACTIVITY & INSIGHTS",
      items: [
        { id: "progress", label: "Productivity trends", icon: Target, target: "progress" },
        { id: "system-activity", label: "System activity", icon: Clock3, target: "system-activity" },
        { id: "completed-work", label: "Completed work", icon: CheckCheck, target: "completed-work" },
        { id: "project-progress", label: "Project progress", icon: GitBranch, target: "project-progress" },
        { id: "reviews", label: "Weekly and monthly reviews", icon: CalendarDays, target: "reviews" },
        { id: "ai-observations", label: "AI-generated observations", icon: Sparkles, target: "ai-observations" },
      ],
    },
    {
      label: "INTEGRATIONS",
      items: [
        { id: "integrations", label: "Integrations", icon: Columns3, target: "integrations" },
        { id: "google-workspace", label: "Google Workspace", icon: Mail, target: "google-workspace" },
      ],
    },
    {
      label: "SETTINGS",
      items: [
        { id: "profile", label: "Profile", icon: UserRound, action: () => clerk.openUserProfile() },
        { id: "appearance", label: "Appearance", icon: Columns3, target: "appearance" },
        { id: "notifications", label: "Notifications", icon: CircleAlert, target: "notifications" },
        { id: "privacy", label: "Privacy", icon: CircleAlert, target: "privacy" },
        { id: "authentication", label: "Authentication", icon: Check, target: "authentication" },
        { id: "ai-preferences", label: "AI preferences", icon: Sparkles, target: "ai-preferences" },
        { id: "integration-permissions", label: "Integration permissions", icon: Columns3, target: "integration-permissions" },
        { id: "data-controls", label: "Data export and deletion", icon: Trash2, target: "data-controls" },
      ],
    },
  ];
  return (
    <aside className="sidebar">
      <a className="brand" href="#overview" onClick={(event) => {
        event.preventDefault();
        onSelectTarget("overview");
        onClose?.();
      }}>
        <span className="brand-mark"><Terminal size={17} strokeWidth={2.2} /></span>
        <span className="brand-copy"><strong>ASLADDIIN OS</strong><small>Productivity platform</small></span>
      </a>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {navigationGroups.map((group) => (
          <section className="nav-group" aria-label={group.label} key={group.label}>
            <h2 className="nav-group-label">{group.label}</h2>
            <div className="nav-group-items">
              {group.items.map(({ id, label, icon: Icon, target, count, badge, action }) => {
                const isActive = target !== undefined && activeTarget === target;
                return (
                  <button
                    id={`nav-${id}`}
                    type="button"
                    className={`nav-link${isActive ? " active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={label}
                    title={`${group.label}: ${label}`}
                    key={id}
                    onClick={() => {
                      if (target) onSelectTarget(target);
                      action?.();
                      onClose?.();
                    }}
                  >
                    <Icon size={16} strokeWidth={1.8} />
                    <span>{label}</span>
                    {count !== undefined && count > 0 && <span className={`nav-badge ${badge}`}>{count}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
      <div className="sidebar-label projects-label">PLANNER DATABASE</div>
      <div className="database-link"><span className="database-icon"><BookOpen size={14} /></span><span>Academic &amp; Life Planner</span></div>
      <div className="sidebar-bottom">
        <div className="notion-status"><span className="status-indicator" /><span>Powered by your Notion database</span></div>
        <div className="profile-row"><span className="profile-avatar">A</span><span><strong>Asladin</strong><small>Personal workspace</small></span><Sparkles size={15} className="profile-sparkle" /></div>
      </div>
    </aside>
  );
}

function NotesPanel({ tasks }: { tasks: Task[] }) {
  const validTimestamp = (value: string) => !Number.isNaN(new Date(value).getTime());
  const noteTimestamp = (value: string) => validTimestamp(value) ? formatDate(value, { year: "numeric", month: "short", day: "numeric" }) : "Unavailable";
  const notes = tasks
    .flatMap((task) => task.notes?.trim()
      ? [{ task, note: task.notes.trim() }]
      : [])
    .sort((a, b) => new Date(b.task.updatedAt || b.task.createdAt).getTime() - new Date(a.task.updatedAt || a.task.createdAt).getTime());

  return (
    <section className="panel notes-panel" aria-labelledby="notes-title">
      <div className="section-heading notes-heading">
        <div><span className="insight-eyebrow">KNOWLEDGE BASE</span><h2 id="notes-title">Notes from your planner</h2><p>Note text is stored on its planner item; dates below refer to that item, not a separate note timestamp.</p></div>
        <span className="notes-count">{notes.length} note{notes.length === 1 ? "" : "s"}</span>
      </div>
      {notes.length > 0 ? <div className="notes-grid">
        {notes.map(({ task, note }) => (
          <article className="note-card" key={task.id}>
            <div className="note-card-meta"><span>{task.area || task.type}</span></div>
            <h3>{task.title}</h3>
            <div className="note-dates">
              <span>Item created <time dateTime={validTimestamp(task.createdAt) ? task.createdAt : undefined}>{noteTimestamp(task.createdAt)}</time></span>
              <span>Item updated <time dateTime={validTimestamp(task.updatedAt || task.createdAt) ? task.updatedAt || task.createdAt : undefined}>{noteTimestamp(task.updatedAt || task.createdAt)}</time></span>
            </div>
            <div className="note-content"><strong>Note content</strong><p>{note}</p></div>
            <a href={task.url} target="_blank" rel="noreferrer">Open planner item <ExternalLink size={12} /></a>
          </article>
        ))}
      </div> : <div className="notes-empty"><BookOpen size={20} /><strong>No planner notes yet</strong><p>Add notes to a Notion item and they will appear here.</p></div>}
    </section>
  );
}

function TaskDialog({
  options,
  task,
  onClose,
  onSaved,
}: {
  options: TaskOptions;
  task: Task | null;
  onClose: () => void;
  onSaved: (task: Task) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const hasChoices = options.types.length > 0 && options.statuses.length > 0;
  const supports = (field: string) => options.availableFields.includes(field);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(form.entries());
    const dueDate = String(values.dueDate ?? "");
    const dueTime = String(values.dueTime ?? "");
    const localDueDate = dueDate && dueTime
      ? plannerLocalTimeToIso(dueDate, dueTime)
      : dueDate;
    const dateEnd = String(values.dateEnd ?? "");
    const dateEndTime = String(values.dateEndTime ?? "");
    const localDateEnd = dateEnd && dateEndTime
      ? plannerLocalTimeToIso(dateEnd, dateEndTime)
      : dateEnd;
    const nextReviewDate = String(values.nextReviewDate ?? "");
    const nextReviewTime = String(values.nextReviewTime ?? "");
    const localNextReviewDate = nextReviewDate && nextReviewTime
      ? plannerLocalTimeToIso(nextReviewDate, nextReviewTime)
      : nextReviewDate;
    const estimatedHours = String(values.estimatedHours ?? "");
    const taskValues = Object.fromEntries(Object.entries(values).filter(([name]) => !["dueTime", "dateEndTime", "nextReviewTime"].includes(name)));
    const body = {
      ...taskValues,
      dueDate: localDueDate,
      dateEnd: localDateEnd,
      nextReviewDate: localNextReviewDate,
      estimatedHours: estimatedHours === "" ? null : Number(estimatedHours),
      actualHours: values.actualHours === "" ? null : values.actualHours === undefined ? undefined : Number(values.actualHours),
      creditHours: values.creditHours === "" ? null : values.creditHours === undefined ? undefined : Number(values.creditHours),
      ...(supports("deliverable") ? { deliverable: values.deliverable === "on" } : {}),
    };

    try {
      const response = await fetch(task ? `/api/tasks/${encodeURIComponent(task.id)}` : "/api/tasks", {
        method: task ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readApiResponse<TaskMutationResponse>(response);
      if (!response.ok || !result.ok || !result.task) {
        throw new Error(result.error ?? "Could not create the planner item.");
      }
      onSaved(result.task);
    } catch (submitError) {
      setError(apiErrorMessage(submitError, "Could not create the planner item."));
    } finally {
      setSaving(false);
    }
  }

  function choiceField(name: string, label: string, values: string[], preferred?: string, required = false, emptyLabel = "None") {
    const taskValue = task ? task[name as keyof Task] : undefined;
    const selected = task
      ? typeof taskValue === "string" && values.includes(taskValue) ? taskValue : ""
      : values.includes(preferred ?? "") ? preferred : values[0];
    return (
      <label className="create-field" key={name}>
        <span>{label}{required && <i> *</i>}</span>
        <select name={name} defaultValue={selected ?? ""} required={required && values.length > 0} disabled={values.length === 0}>
          {values.length === 0 && <option value="">No options available</option>}
          {!required && <option value="">{emptyLabel}</option>}
          {values.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
      </label>
    );
  }

  return (
    <dialog ref={dialogRef} className="create-dialog" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="create-form" onSubmit={submitTask}>
        <div className="create-dialog-heading">
          <div><span className="create-dialog-icon">{task ? <Pencil size={16} /> : <Plus size={17} />}</span><div><h2>{task ? "Edit planner item" : "New planner item"}</h2><p>{task ? "Update this item in your Notion database." : "Add it directly to your Notion database."}</p></div></div>
          <button type="button" className="create-dialog-close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>
        <label className="create-field create-title-field">
          <span>Title <i>*</i></span>
          <input name="title" defaultValue={task?.title ?? ""} maxLength={2000} placeholder="What do you need to get done?" required autoFocus />
        </label>
        <div className="create-fields-grid">
          {choiceField("type", "Type", options.types, "Deliverable", true)}
          {choiceField("status", "Status", options.statuses, "Planned", true)}
          {choiceField("priority", "Priority", options.priorities, "Medium", false, "Use default")}
          {choiceField("area", "Area", options.areas)}
          {choiceField("course", "Course", options.courses)}
          {supports("assessment") && choiceField("assessment", "Assessment", options.assessments)}
          {supports("courseCode") && <label className="create-field"><span>Course code</span><input name="courseCode" defaultValue={task?.courseCode ?? ""} maxLength={50} placeholder="e.g. ITeC4133" /></label>}
          {supports("estimatedHours") && <label className="create-field"><span>Estimated hours</span><input name="estimatedHours" type="number" min="0" max="10000" step="0.25" defaultValue={task?.estimatedHours ?? ""} /></label>}
          {supports("actualHours") && <label className="create-field"><span>Actual hours</span><input name="actualHours" type="number" min="0" max="10000" step="0.25" defaultValue={task?.actualHours ?? ""} /></label>}
          {supports("creditHours") && <label className="create-field"><span>Course credits</span><input name="creditHours" type="number" min="0" max="10000" step="0.5" defaultValue={task?.creditHours ?? ""} /></label>}
          <label className="create-field"><span>Due date</span><input name="dueDate" type="date" defaultValue={task?.dueDate?.slice(0, 10) ?? ""} /></label>
          <label className="create-field"><span>Due time</span><input name="dueTime" type="time" defaultValue={task?.dueDate?.includes("T") ? dateTimeLocalValue(task.dueDate).slice(11, 16) : ""} /></label>
          {supports("dateEnd") && <>
            <label className="create-field"><span>End date</span><input name="dateEnd" type="date" defaultValue={task?.dateEnd?.slice(0, 10) ?? ""} /></label>
            <label className="create-field"><span>End time</span><input name="dateEndTime" type="time" defaultValue={task?.dateEnd?.includes("T") ? dateTimeLocalValue(task.dateEnd).slice(11, 16) : ""} /></label>
          </>}
          {supports("semester") && choiceField("semester", "Semester", options.semesters)}
          {supports("nextReviewDate") && <>
            <label className="create-field"><span>Next review date</span><input name="nextReviewDate" type="date" defaultValue={task?.nextReviewDate?.slice(0, 10) ?? ""} /></label>
            <label className="create-field"><span>Next review time</span><input name="nextReviewTime" type="time" defaultValue={task?.nextReviewDate?.includes("T") ? dateTimeLocalValue(task.nextReviewDate).slice(11, 16) : ""} /></label>
          </>}
          {supports("instructor") && <label className="create-field"><span>Instructor / responsible</span><input name="instructor" defaultValue={task?.instructor ?? ""} maxLength={255} /></label>}
          {supports("marksGrade") && <label className="create-field"><span>Marks / grade</span><input name="marksGrade" defaultValue={task?.marksGrade ?? ""} maxLength={100} /></label>}
          {supports("recurrence") && <label className="create-field"><span>Recurrence</span><input name="recurrence" defaultValue={task?.recurrence ?? ""} maxLength={255} placeholder="e.g. Weekly, weekdays" /></label>}
          {supports("timeBlock") && <label className="create-field"><span>Time block</span><input name="timeBlock" defaultValue={task?.timeBlock ?? ""} maxLength={255} /></label>}
          {supports("resourceLink") && <label className="create-field"><span>Resource link</span><input name="resourceLink" defaultValue={task?.resourceLink ?? ""} maxLength={2000} /></label>}
          {supports("venueLink") && <label className="create-field"><span>Venue / meeting link</span><input name="venueLink" defaultValue={task?.venueLink ?? ""} maxLength={255} /></label>}
          {supports("deliverable") && <label className="create-field create-checkbox-field"><span>Deliverable</span><input name="deliverable" type="checkbox" defaultChecked={task?.deliverable ?? false} /></label>}
        </div>
        <label className="create-field next-action-field">
          <span>Next action</span>
          <textarea name="nextAction" defaultValue={task?.nextAction ?? ""} maxLength={2000} rows={2} placeholder="What is the next concrete step?" />
        </label>
        {supports("notes") && <label className="create-field next-action-field">
          <span>Notes</span>
          <textarea name="notes" defaultValue={task?.notes ?? ""} maxLength={2000} rows={3} placeholder="Context, reflection, or technical notes" />
        </label>}
        {!hasChoices && <p className="create-form-notice">Type and Status options could not be loaded. Check that these properties exist in your Notion database.</p>}
        {error && <p className="create-form-error" role="alert">{error}</p>}
        <div className="create-dialog-actions">
          <button type="button" className="create-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="create-submit" disabled={saving || !hasChoices}>
            {saving ? <><LoaderCircle size={14} className="spin" /> Saving...</> : task ? <><Pencil size={14} /> Save changes</> : <><Plus size={14} /> Create item</>}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function CalendarCard({ tasks, options }: { tasks: Task[]; options: TaskOptions | null }) {
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const [year, month] = isoToday().split("-").map(Number);
    return new Date(year, month - 1, 1);
  });
  const [calendarType, setCalendarType] = useState("");
  const [calendarArea, setCalendarArea] = useState("");
  const [calendarCourse, setCalendarCourse] = useState("");
  const [calendarStatus, setCalendarStatus] = useState("");
  const [calendarPriority, setCalendarPriority] = useState("");
  const [calendarSemester, setCalendarSemester] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const calendarTasks = tasks.filter((task) =>
    (!calendarType || task.type === calendarType) &&
    (!calendarArea || task.area === calendarArea) &&
    (!calendarCourse || task.course === calendarCourse) &&
    (!calendarStatus || (task.completed ? "Done" : task.status) === calendarStatus) &&
    (!calendarPriority || task.priority === calendarPriority) &&
    (!calendarSemester || task.semester === calendarSemester) &&
    (!rangeStart || !task.dueDate || (task.dateEnd ? plannerDateKey(task.dateEnd) : plannerDateKey(task.dueDate)) >= rangeStart) &&
    (!rangeEnd || !task.dueDate || plannerDateKey(task.dueDate) <= rangeEnd)
  );
  const firstWeekday = (visibleMonth.getDay() + 6) % 7;
  const monthLength = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((firstWeekday + monthLength) / 7) * 7 }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day > 0 && day <= monthLength ? day : null;
  });
  const deadlines = new Map<string, Task[]>();
  const monthFirst = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const monthLast = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}-${String(monthLength).padStart(2, "0")}`;
  calendarTasks.forEach((task) => {
    if (!task.dueDate) return;
    const start = plannerDateKey(task.dueDate);
    const end = task.dateEnd ? plannerDateKey(task.dateEnd) : start;
    const clippedStart = start < monthFirst ? monthFirst : start;
    const clippedEnd = end > monthLast ? monthLast : end;
    for (let date = new Date(`${clippedStart}T00:00:00Z`), last = new Date(`${clippedEnd}T00:00:00Z`);
      date <= last; date.setUTCDate(date.getUTCDate() + 1)) {
      const day = date.toISOString().slice(0, 10);
      deadlines.set(day, [...(deadlines.get(day) ?? []), task]);
    }
  });
  const monthLabel = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: PLANNER_TIME_ZONE }).format(visibleMonth);
  const today = isoToday();

  return (
    <section className="panel calendar-panel" id="calendar">
      <div className="panel-heading">
        <div><h2>Deadline calendar</h2><p>Important dates, all in one place</p></div>
        <div className="calendar-controls">
          <button className="round-button" aria-label="Previous month" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
          <button className="round-button" aria-label="Next month" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
        </div>
        <div className="calendar-filters">
          <label><span>From</span><input type="date" aria-label="Calendar start date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label>
          <label><span>To</span><input type="date" aria-label="Calendar end date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label>
          <select aria-label="Calendar type filter" value={calendarType} onChange={(event) => setCalendarType(event.target.value)}><option value="">All types</option>{(options?.types ?? []).map((value) => <option key={value}>{value}</option>)}</select>
          <select aria-label="Calendar area filter" value={calendarArea} onChange={(event) => setCalendarArea(event.target.value)}><option value="">All areas</option>{(options?.areas ?? []).map((value) => <option key={value}>{value}</option>)}</select>
          <select aria-label="Calendar course filter" value={calendarCourse} onChange={(event) => setCalendarCourse(event.target.value)}><option value="">All courses</option>{(options?.courses ?? []).map((value) => <option key={value}>{value}</option>)}</select>
          <select aria-label="Calendar status filter" value={calendarStatus} onChange={(event) => setCalendarStatus(event.target.value)}><option value="">All statuses</option>{Array.from(new Set([...(options?.statuses ?? []), "Done"])).map((value) => <option key={value}>{value}</option>)}</select>
          <select aria-label="Calendar priority filter" value={calendarPriority} onChange={(event) => setCalendarPriority(event.target.value)}><option value="">All priorities</option>{(options?.priorities ?? []).map((value) => <option key={value}>{value}</option>)}</select>
          {supportsSemester(options) && <select aria-label="Calendar semester filter" value={calendarSemester} onChange={(event) => setCalendarSemester(event.target.value)}><option value="">All semesters</option>{options.semesters.map((value) => <option key={value}>{value}</option>)}</select>}
        </div>
      </div>
      <div className="calendar-month">{monthLabel}<button type="button" className="calendar-current" onClick={() => setVisibleMonth(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1))}>Jump to this month</button></div>
      <div className="calendar-grid calendar-weekdays">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-grid calendar-days">
        {cells.map((day, index) => {
          if (day === null) return <div className="calendar-day out-of-month" key={`blank-${index}`} />;
          const date = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const dueTasks = deadlines.get(date) ?? [];
          return (
            <div className={`calendar-day${date === today ? " today" : ""}`} key={date} title={dueTasks.map((task) => task.title).join(", ")}>
              <span className="calendar-day-number">{day}</span>{dueTasks.length > 0 && <span className="calendar-event-markers" aria-label={`${dueTasks.length} planner item${dueTasks.length > 1 ? "s" : ""}`}>
                {dueTasks.slice(0, 4).map((task) => <i className={`deadline-marker event-${task.type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} key={task.id} />)}
              </span>}
            </div>
          );
        })}
      </div>
      <div className="calendar-legend"><span className="deadline-marker event-class" /> Class <span className="deadline-marker event-deliverable" /> Deliverable <span className="deadline-marker event-exam" /> Exam <span className="deadline-marker event-prayer" /> Prayer <span className="calendar-today-key" /> Today</div>
      <div className="upcoming-list">
        <div className="upcoming-heading">UPCOMING DELIVERABLES &amp; EXAMS</div>
        {calendarTasks.filter((task) => task.dueDate && !task.completed && (task.deliverable || /deliverable|exam/i.test(task.type)) && plannerDateKey(task.dateEnd || task.dueDate) >= today)
          .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")).slice(0, 3).map((task) => (
            <div className="upcoming-item" key={task.id}>
              <span className="upcoming-date">{formatDate(task.dueDate!)}{task.dateEnd ? ` – ${formatDate(task.dateEnd)}` : ""}</span>
              <span className="upcoming-task">{task.title}</span>
              <span className="upcoming-type">{task.type}</span>
            </div>
          ))}
        {calendarTasks.filter((task) => task.dueDate && !task.completed && (task.deliverable || /deliverable|exam/i.test(task.type)) && plannerDateKey(task.dateEnd || task.dueDate) >= today).length === 0 && <p className="upcoming-empty">No upcoming deliverables or exams.</p>}
      </div>
    </section>
  );
}

function TaskTable({ tasks, options, loading, search, onSearch, onCreate, onEdit, onDelete, onComplete, onBreakdown, createDisabled, deleting, completingId }: {
  tasks: Task[];
  options: TaskOptions | null;
  loading: boolean;
  search: string;
  onSearch: (value: string) => void;
  onCreate: () => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onComplete: (task: Task) => void;
  onBreakdown: (task: Task) => void;
  createDisabled: boolean;
  deleting: boolean;
  completingId: string;
}) {
  const [activeFilter, setActiveFilter] = useState<"all" | "deliverables" | "routines" | "course">("all");
  const [selectedCourse, setSelectedCourse] = useState("");
  const [view, setView] = useState<"table" | "board">("table");
  const [typeFilter, setTypeFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [semesterFilter, setSemesterFilter] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "priority" | "title">("date");
  const [expandedTaskId, setExpandedTaskId] = useState("");
  const today = isoToday();
  const searched = tasks.filter((task) => `${task.title} ${task.type} ${task.area} ${task.course} ${task.courseCode ?? ""} ${task.assessment ?? ""} ${task.status} ${task.priority} ${task.nextAction} ${task.instructor ?? ""} ${task.marksGrade ?? ""} ${task.notes ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const isDeliverable = (task: Task) => /deliverable/i.test(task.type) || /lab|assignment|project/i.test(task.assessment ?? "");
  const isRoutine = (task: Task) => /routine|prayer/i.test(task.type);
  const deliverableCount = searched.filter((task) => task.deliverable || isDeliverable(task)).length;
  const routineCount = searched.filter(isRoutine).length;
  const courseTasks = searched.filter((task) => Boolean(task.courseCode?.trim()));
  const courseCodes = Array.from(new Set(tasks.map((task) => task.courseCode?.trim()).filter((code): code is string => Boolean(code)))).sort();
  const filtered = searched.filter((task) => {
    if (activeFilter === "deliverables" && !(task.deliverable || isDeliverable(task))) return false;
    if (activeFilter === "routines" && !isRoutine(task)) return false;
    if (activeFilter === "course" && (!task.courseCode?.trim() || (selectedCourse && task.courseCode?.trim() !== selectedCourse))) return false;
    if (typeFilter && task.type !== typeFilter) return false;
    if (areaFilter && task.area !== areaFilter) return false;
    if (priorityFilter && task.priority !== priorityFilter) return false;
    if (statusFilter && (task.completed ? "Done" : task.status) !== statusFilter) return false;
    if (courseFilter && task.course !== courseFilter) return false;
    if (semesterFilter && task.semester !== semesterFilter) return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === "priority") {
      const rank = (priority: string) => ({ Critical: 0, High: 1, Medium: 2, Low: 3 }[priority as "Critical" | "High" | "Medium" | "Low"] ?? 4);
      return rank(a.priority) - rank(b.priority) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
    }
    if (sortBy === "title") return a.title.localeCompare(b.title);
    return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
  });
  const boardStatuses = Array.from(new Set([
    ...(options?.statuses ?? []).filter((status) => !/^(done|complete|completed|finished)$/i.test(status)),
    ...tasks.map((task) => task.status).filter((status) => !/^(done|complete|completed|finished)$/i.test(status)),
    "Done",
  ]));

  function renderActions(task: Task) {
    return <div className="task-row-actions">
      <button type="button" aria-label={`${task.completed ? "Mark incomplete" : "Mark complete"}: ${task.title}`} title={task.completed ? "Mark as not complete" : "Mark complete"} onClick={() => onComplete(task)} disabled={deleting || completingId === task.id}>
        {completingId === task.id ? <LoaderCircle size={13} className="spin" /> : <CheckCheck size={13} />}
      </button>
      <button type="button" aria-label={`Break down ${task.title}`} title="Break this task into steps" onClick={() => onBreakdown(task)} disabled={deleting || task.completed || createDisabled}><Sparkles size={13} /></button>
      <button type="button" aria-label={`${expandedTaskId === task.id ? "Hide" : "Show"} details for ${task.title}`} aria-expanded={expandedTaskId === task.id} title="Show all Notion fields" onClick={() => setExpandedTaskId(expandedTaskId === task.id ? "" : task.id)}><ChevronDown size={13} /></button>
      <button type="button" aria-label={`Edit ${task.title}`} title="Edit task" onClick={() => onEdit(task)} disabled={deleting}><Pencil size={13} /></button>
      <button type="button" className="delete-task" aria-label={`Archive ${task.title}`} title="Archive task" onClick={() => onDelete(task)} disabled={deleting}>
        {deleting ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
      </button>
    </div>;
  }

  return (
    <section className="panel task-panel" id="tasks">
      <div className="panel-heading task-panel-heading">
        <div><h2>Your tasks</h2><p>The latest from your Notion planner</p></div>
        <div className="task-actions">
          <label className="task-search"><Search size={14} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Filter tasks..." aria-label="Filter tasks" /></label>
          <div className="task-view-toggle" role="group" aria-label="Task view">
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
            <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 size={12} /> Board</button>
          </div>
          <button className="create-item-button" onClick={onCreate} type="button" disabled={createDisabled}><Plus size={13} /> New item</button>
        </div>
      </div>
      <div className="task-filter-row" role="tablist" aria-label="Filter task categories">
        <button type="button" role="tab" aria-selected={activeFilter === "all"} onClick={() => setActiveFilter("all")}>All <span>{searched.length}</span></button>
        <button type="button" role="tab" aria-selected={activeFilter === "deliverables"} onClick={() => setActiveFilter("deliverables")}>Deliverables <span>{deliverableCount}</span></button>
        <button type="button" role="tab" aria-selected={activeFilter === "routines"} onClick={() => setActiveFilter("routines")}>Routines &amp; Prayers <span>{routineCount}</span></button>
        <button type="button" role="tab" aria-selected={activeFilter === "course"} onClick={() => setActiveFilter("course")}>By Course <span>{courseTasks.length}</span></button>
        {activeFilter === "course" && <select aria-label="Filter by course code" value={selectedCourse} onChange={(event) => setSelectedCourse(event.target.value)}>
          <option value="">All course codes</option>
          {courseCodes.map((code) => <option value={code} key={code}>{code} ({tasks.filter((task) => task.courseCode?.trim() === code).length})</option>)}
        </select>}
      </div>
      <div className="task-advanced-filters" aria-label="Task filters and sorting">
        <select aria-label="Filter by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">Every type</option>{(options?.types ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</select>
        <select aria-label="Filter by area" value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}><option value="">Every area</option>{(options?.areas ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</select>
        <select aria-label="Filter by priority" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="">Every priority</option>{(options?.priorities ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</select>
        <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">Every status</option>{Array.from(new Set([...(options?.statuses ?? []), ...tasks.map((task) => task.completed ? "Done" : task.status)])).map((value) => <option value={value} key={value}>{value}</option>)}</select>
        <select aria-label="Filter by course" value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}><option value="">Every course</option>{(options?.courses ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</select>
        {supportsSemester(options) && <select aria-label="Filter by semester" value={semesterFilter} onChange={(event) => setSemesterFilter(event.target.value)}><option value="">Every semester</option>{options.semesters.map((value) => <option value={value} key={value}>{value}</option>)}</select>}
        <select aria-label="Sort tasks" value={sortBy} onChange={(event) => setSortBy(event.target.value as "date" | "priority" | "title")}><option value="date">Sort: date</option><option value="priority">Sort: priority</option><option value="title">Sort: title</option></select>
      </div>
      {view === "table" ? <div className="task-table-scroll">
        <table className="task-table">
          <thead><tr><th>Task</th><th>Type</th><th>Area</th><th>Course</th><th>Priority</th><th>Status</th><th>Next action</th><th>Date / time</th><th>Deliverable</th><th>Course code</th><th>Assessment</th><th>Est.</th><th>Actual</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map((task) => (
              <Fragment key={task.id}>
              <tr>
                <td><div className="task-title-cell"><span className={`task-state ${task.completed ? "is-complete" : ""}`}>{task.completed && <Check size={11} />}</span><a href={task.url} target="_blank" rel="noreferrer">{task.title}<ExternalLink size={10} /></a></div>{task.course && <span className="task-subtitle">{task.course}</span>}</td>
                <td><span className={`pill type-pill ${task.type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{task.type}</span></td>
                <td><span className="area-value">{task.area}</span></td>
                <td>{task.course || "—"}</td>
                <td><span className={`pill priority-pill ${task.priority.toLowerCase()}`}>{task.priority}</span></td>
                <td><span className={`pill status-pill ${task.completed ? "completed" : task.status.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{task.completed ? "Completed" : task.status}</span></td>
                <td className="next-action" title={task.nextAction || undefined}>{task.nextAction || "—"}</td>
                <td className={`due-date${isOverdue(task, today) ? " overdue" : ""}`}>{task.dueDate ? <>{isOverdue(task, today) && <CircleAlert size={12} />}{formatDate(task.dueDate)}{task.dateEnd ? ` – ${formatDate(task.dateEnd)}` : ""}</> : "—"}</td>
                <td>{task.deliverable ? <Check size={12} className="deliverable-check" /> : "—"}</td>
                <td>{task.courseCode ? <span className="course-code-pill">{task.courseCode}</span> : "—"}</td>
                <td>{task.assessment ? <span className={`pill assessment-pill ${task.assessment.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{task.assessment}</span> : "—"}</td>
                <td className="estimated-hours">{task.estimatedHours !== undefined ? <><Clock3 size={11} /> {task.estimatedHours}h</> : "—"}</td>
                <td>{task.actualHours !== undefined ? `${task.actualHours}h` : "—"}</td>
                <td>{renderActions(task)}</td>
              </tr>
              {expandedTaskId === task.id && <tr className="task-details-row"><td colSpan={14}>
                <div className="task-details-grid">
                  {task.instructor && <div><span>Instructor</span><strong>{task.instructor}</strong></div>}
                  {task.peopleInstructor?.length ? <div><span>People</span><strong>{task.peopleInstructor.join(", ")}</strong></div> : null}
                  {task.creditHours !== undefined && <div><span>Credit hours</span><strong>{task.creditHours}</strong></div>}
                  {task.marksGrade && <div><span>Marks / grade</span><strong>{task.marksGrade}</strong></div>}
                  {task.nextReviewDate && <div><span>Next review</span><strong>{formatDate(task.nextReviewDate)}</strong></div>}
                  {task.semester && <div><span>Semester</span><strong>{task.semester}</strong></div>}
                  {task.recurrence && <div><span>Recurrence</span><strong>{task.recurrence}</strong></div>}
                  {task.timeBlock && <div><span>Time block</span><strong>{task.timeBlock}</strong></div>}
                  {task.resourceLink && <div><span>Resource</span>{safeHttpUrl(task.resourceLink) ? <a href={safeHttpUrl(task.resourceLink)} target="_blank" rel="noreferrer">Open link</a> : <strong>{task.resourceLink}</strong>}</div>}
                  {task.venueLink && <div><span>Venue</span>{safeHttpUrl(task.venueLink) ? <a href={safeHttpUrl(task.venueLink)} target="_blank" rel="noreferrer">Open link</a> : <strong>{task.venueLink}</strong>}</div>}
                  {task.notes && <div className="task-details-notes"><span>Notes</span><strong>{task.notes}</strong></div>}
                </div>
              </td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
        {loading && <div className="table-message"><LoaderCircle size={17} className="spin" /> Loading your Notion tasks...</div>}
        {!loading && filtered.length === 0 && <div className="table-message">{search ? "No tasks match these filters." : "Your Notion database has no tasks yet."}</div>}
      </div> : <div className="task-board">
        {boardStatuses.map((status) => {
          const laneTasks = filtered.filter((task) => (task.completed ? "Done" : task.status) === status);
          return <section className="board-column" key={status}>
            <h3><span className={`board-status-dot ${status.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} />{status}<span>{laneTasks.length}</span></h3>
            {laneTasks.map((task) => <article className="board-task-card" key={task.id}>
              <a href={task.url} target="_blank" rel="noreferrer">{task.title}<ExternalLink size={10} /></a>
              <div className="board-task-meta">
                {task.courseCode && <span className="course-code-pill">{task.courseCode}</span>}
                {task.assessment && <span className={`pill assessment-pill ${task.assessment.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{task.assessment}</span>}
                {task.estimatedHours !== undefined && <span><Clock3 size={10} /> {task.estimatedHours}h</span>}
              </div>
              {task.dueDate && <p className={`board-task-date${isOverdue(task, today) ? " overdue" : ""}`}><CalendarDays size={11} />{formatDate(task.dueDate)}</p>}
              <div className="board-task-footer"><span className={`pill priority-pill ${task.priority.toLowerCase()}`}>{task.priority}</span>{renderActions(task)}</div>
            </article>)}
            {laneTasks.length === 0 && <p className="board-empty">No items</p>}
          </section>;
        })}
        {loading && <div className="table-message"><LoaderCircle size={17} className="spin" /> Loading your Notion tasks...</div>}
        {!loading && filtered.length === 0 && <div className="table-message">No tasks match these filters.</div>}
      </div>}
      {!loading && <div className="table-footer">Showing {filtered.length} of {tasks.length} tasks</div>}
      {loading && <div className="skeleton-row"><span /><span /><span /><span /></div>}
    </section>
  );
}

export default function DashboardPage() {
  const clerk = useClerk();
  const { isLoaded, user } = useUser();
  const hasAccess = Boolean(user);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [requestDayPlan, setRequestDayPlan] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" | "info" } | null>(null);
  const [archiveTask, setArchiveTask] = useState<Task | null>(null);
  const [taskOptions, setTaskOptions] = useState<TaskOptions | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState("");
  const [completingTaskId, setCompletingTaskId] = useState("");
  const [actionError, setActionError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [taskToBreakDown, setTaskToBreakDown] = useState<Task | null>(null);
  const [googleSummary, setGoogleSummary] = useState<GoogleWorkspaceSummary>(emptyGoogleSummary);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleSummaryLoaded, setGoogleSummaryLoaded] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const [googleLastSyncedAt, setGoogleLastSyncedAt] = useState<string | null>(null);

  const notify = useCallback((message: string, tone: "success" | "error" | "info" = "success") => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!archiveTask) return;
    const cancelButton = document.querySelector<HTMLButtonElement>(".confirm-cancel");
    cancelButton?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArchiveTask(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [archiveTask]);

  const selectTab = useCallback((target: string) => {
    if (!dashboardTabs.includes(target)) return;
    window.history.replaceState(null, "", `#${target}`);
    setActiveTab(target);
    if (target === "overview") setActivityRefreshKey((current) => current + 1);
    setSidebarOpen(false);
  }, []);

  const loadTasks = useCallback(async (showToast = false) => {
    setState("loading");
    setError("");
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      const result = await readApiResponse<TasksResponse>(response);
      if (!response.ok || !result.configured) throw new Error(result.error ?? "Could not load your Notion database.");
      setTasks(result.tasks);
      setTaskOptions(result.options ?? null);
      setState("ready");
      setLastUpdated(new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: PLANNER_TIME_ZONE }).format(new Date()));
      if (showToast) {
        setDashboardRefreshKey((current) => current + 1);
        notify("Workspace data refreshed.");
        try {
          const response = await fetch("/api/telegram/notify", { method: "POST" });
          const result = await readApiResponse<{ sent?: boolean }>(response);
          if (result.sent) notify("Workspace refreshed. Counts-only Telegram summary sent.");
        } catch (notificationError) {
          notify(apiErrorMessage(notificationError, "Workspace refreshed, but Telegram could not be notified."), "error");
        }
      }
    } catch (loadError) {
      setTasks([]);
      setState("error");
      const message = apiErrorMessage(loadError, "Could not load your Notion database.");
      setError(message);
      if (showToast) notify(message, "error");
    }
  }, [notify]);

  const loadGoogleSummary = useCallback(async (showToast = false) => {
    setGoogleLoading(true);
    setGoogleError("");
    try {
      const response = await fetch("/api/google/summary", { cache: "no-store" });
      const result = await readApiResponse<GoogleWorkspaceSummary & { error?: string }>(response);
      if (response.status === 401) {
        setGoogleSummary(emptyGoogleSummary);
        setGoogleLastSyncedAt(null);
      }
      if (!response.ok) throw new Error(result.error ?? "Google session expired. Reconnect your Google account.");
      setGoogleSummary(result);
      const successfulServices = (["gmail", "calendar", "drive"] as const)
        .filter((service) => !result.errors?.[service]);
      if (result.connected && successfulServices.length > 0) {
        setGoogleLastSyncedAt(new Date().toISOString());
      } else if (!result.connected) {
        setGoogleLastSyncedAt(null);
      }
      const serviceErrors = Object.entries(result.errors ?? {}).map(([service, message]) => {
        const name = service === "gmail" ? "Gmail" : service === "calendar" ? "Google Calendar" : "Google Drive";
        return `${name}: ${message}`;
      });
      if (serviceErrors.length) setGoogleError(serviceErrors.join(" "));
      else if (showToast) notify("Google Workspace data refreshed.");
    } catch (loadError) {
      const message = apiErrorMessage(loadError, "Could not load Google Workspace.");
      setGoogleError(message);
      if (showToast) notify(message, "error");
    } finally {
      setGoogleLoading(false);
      setGoogleSummaryLoaded(true);
    }
  }, [notify]);

  useEffect(() => {
    if (isLoaded && hasAccess) void loadTasks();
  }, [hasAccess, isLoaded, loadTasks]);

  useEffect(() => {
    if (isLoaded && hasAccess) void loadGoogleSummary();
  }, [hasAccess, isLoaded, loadGoogleSummary]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("google");
    if (result === "connected") {
      setSuccessMessage("Google Workspace connected for this browser session.");
      notify("Google Workspace connected.");
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    } else if (result) {
      const message = result === "auth-error"
        ? "Google authorization was not verified. Sign in to the dashboard and try connecting again."
        : "Google connection did not complete. Check your OAuth settings and try again.";
      setGoogleError(message);
      notify(message, "error");
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }, [notify]);

  function handleTaskSaved(task: Task) {
    setActivityRefreshKey((current) => current + 1);
    setTasks((current) => editingTask
      ? current.map((currentTask) => currentTask.id === task.id ? task : currentTask)
      : [task, ...current]);
    setCreateDialogOpen(false);
    setEditingTask(null);
    setLastUpdated(new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: PLANNER_TIME_ZONE }).format(new Date()));
    const message = editingTask ? `“${task.title}” was updated.` : `“${task.title}” was added to your Notion planner.`;
    setSuccessMessage(message);
    notify(message);
  }

  function handleAssistantTaskSaved(task: Task) {
    setActivityRefreshKey((current) => current + 1);
    setTasks((current) => current.some((item) => item.id === task.id)
      ? current.map((item) => item.id === task.id ? task : item)
      : [task, ...current]);
    setLastUpdated(new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: PLANNER_TIME_ZONE }).format(new Date()));
  }

  const clearTaskToBreakDown = useCallback(() => setTaskToBreakDown(null), []);
  const clearDayPlanRequest = useCallback(() => setRequestDayPlan(false), []);

  async function handleTaskDelete(task: Task) {
    setDeletingTaskId(task.id);
    setActionError("");
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      const result = await readApiResponse<{ ok: boolean; error?: string }>(response);
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not archive the planner item.");
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setLastUpdated(new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: PLANNER_TIME_ZONE }).format(new Date()));
      const message = `“${task.title}” was archived from your planner.`;
      setSuccessMessage(message);
      notify(message);
    } catch (deleteError) {
      const message = apiErrorMessage(deleteError, "Could not archive the planner item.");
      setActionError(message);
      notify(message, "error");
    } finally {
      setDeletingTaskId("");
    }
  }

  async function confirmArchiveTask() {
    if (!archiveTask) return;
    const task = archiveTask;
    setArchiveTask(null);
    await handleTaskDelete(task);
  }

  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (dashboardTabs.includes(target)) setActiveTab(target);
    else window.history.replaceState(null, "", "#overview");
  }, []);

  async function handleTaskComplete(task: Task) {
    setCompletingTaskId(task.id);
    setActionError("");
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !task.completed }),
      });
      const result = await readApiResponse<TaskMutationResponse>(response);
      if (!response.ok || !result.ok || !result.task) {
        throw new Error(result.error ?? "Could not update task completion.");
      }
      setTasks((current) => current.map((item) => item.id === task.id ? result.task! : item));
      setActivityRefreshKey((current) => current + 1);
      setLastUpdated(new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: PLANNER_TIME_ZONE }).format(new Date()));
      setSuccessMessage(`“${task.title}” marked ${result.task.completed ? "complete" : "not complete"}.`);
      notify(`“${task.title}” marked ${result.task.completed ? "complete" : "not complete"}.`);
    } catch (completeError) {
      const message = apiErrorMessage(completeError, "Could not update task completion.");
      setActionError(message);
      notify(message, "error");
    } finally {
      setCompletingTaskId("");
    }
  }

  async function handleGoogleDisconnect() {
    setGoogleError("");
    try {
      const response = await fetch("/api/google/disconnect", { method: "POST" });
      const result = await readApiResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(result.error ?? "Could not disconnect Google.");
      setGoogleSummary(emptyGoogleSummary);
      setGoogleLastSyncedAt(null);
      notify("Google Workspace disconnected and access revoked.");
    } catch (disconnectError) {
      const message = apiErrorMessage(disconnectError, "Could not disconnect Google.");
      setGoogleError(message);
      notify(message, "error");
    }
  }

  const today = isoToday();
  const myDayTasks = useMemo(() => getMyDayTasks(tasks, today), [tasks, today]);
  const myDayTaskCount = tasks.filter((task) => isScheduledForDay(task, today) || isOverdue(task, today)).length;
  const meetingsToday = googleSummary.events.filter((event) =>
    event.start && plannerDateKey(event.start) === today
  ).length;
  const metrics = useMemo(() => {
    const completed = tasks.filter((task) => task.completed).length;
    const pending = tasks.length - completed;
    const overdue = tasks.filter((task) => isOverdue(task, today)).length;
    return { completed, pending, overdue, completion: tasks.length ? Math.round((completed / tasks.length) * 100) : 0 };
  }, [tasks, today]);

  const statusDistribution = [
    { name: "Completed", value: metrics.completed },
    { name: "Pending", value: metrics.pending },
  ];
  const priorityData = countBy(tasks, (task) => task.priority).filter((item) => item.name !== "Unassigned");
  const typeData = countBy(tasks, (task) => task.type).filter((item) => item.name !== "Other");
  const timelineData = getTimeline(tasks);
  const areaData = countBy(tasks, (task) => task.area)
    .map((area) => {
      const areaTasks = tasks.filter((task) => (task.area.trim() || "Other") === area.name);
      const completed = areaTasks.filter((task) => task.completed).length;
      return { ...area, completed, percentage: areaTasks.length ? Math.round((completed / areaTasks.length) * 100) : 0 };
    }).filter((area) => area.name !== "Unassigned" && area.name !== "Other");
  const typeProgress = countBy(tasks, (task) => task.type).map((type) => {
    const group = tasks.filter((task) => task.type === type.name);
    return {
      name: type.name,
      total: group.length,
      completed: group.filter((task) => task.completed).length,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const totalEstimatedHours = tasks.reduce((sum, task) => sum + (task.estimatedHours ?? 0), 0);
  const totalActualHours = tasks.reduce((sum, task) => sum + (task.actualHours ?? 0), 0);
  const deliverableTasks = tasks.filter((task) => task.deliverable || /deliverable/i.test(task.type));
  const completedDeliverables = deliverableTasks.filter((task) => task.completed).length;
  const overdueDeliverables = deliverableTasks.filter((task) => isOverdue(task, today)).length;
  const upcomingReviews = tasks.filter((task) => task.nextReviewDate && plannerDateKey(task.nextReviewDate) >= today && !task.completed)
    .sort((a, b) => (a.nextReviewDate ?? "").localeCompare(b.nextReviewDate ?? "")).slice(0, 4);
  const courseGroups = new Map<string, Task[]>();
  tasks.forEach((task) => {
    const code = task.courseCode?.trim();
    if (code) courseGroups.set(code, [...(courseGroups.get(code) ?? []), task]);
  });
  const courseData = Array.from(courseGroups, ([code, courseTasks]) => {
    const completed = courseTasks.filter((task) => task.completed).length;
    const remainingHours = courseTasks.filter((task) => !task.completed)
      .reduce((sum, task) => sum + (task.estimatedHours ?? 0), 0);
    return {
      code,
      name: courseTasks.find((task) => task.course)?.course || code,
      completed,
      total: courseTasks.length,
      remainingHours,
      percentage: courseTasks.length ? Math.round((completed / courseTasks.length) * 100) : 0,
    };
  }).sort((a, b) => a.code.localeCompare(b.code));
  const courseWorkloadHours = tasks.filter((task) => !task.completed)
    .reduce((sum, task) => sum + (task.estimatedHours ?? 0), 0);
  const greeting = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: PLANNER_TIME_ZONE }).format(new Date());
  const tabLabels: Record<string, string> = {
    overview: "Dashboard",
    tasks: "Tasks",
    projects: "Projects",
    notes: "Notes",
    calendar: "Calendar",
    progress: "Activity & Insights",
    "planner-assistant": "AI Assistant",
    integrations: "Integrations",
    "google-workspace": "Google Workspace",
    goals: "Goals",
    knowledge: "Knowledge",
    "system-activity": "System activity",
    "completed-work": "Completed work",
    "project-progress": "Project progress",
    reviews: "Weekly and monthly reviews",
    "ai-observations": "AI-generated observations",
    appearance: "Appearance",
    notifications: "Notifications",
    privacy: "Privacy",
    authentication: "Authentication",
    "ai-preferences": "AI preferences",
    "integration-permissions": "Integration permissions",
    "data-controls": "Data export and deletion",
  };
  const activeTabLabel = tabLabels[activeTab] ?? "Dashboard";
  const settingsPages: Record<string, { title: string; description: string; detail: string; actionLabel: string; actionTarget: string }> = {
    appearance: {
      title: "Appearance",
      description: "The workspace currently uses its standard responsive theme.",
      detail: "Theme customization is not available yet; this page does not store a preference that the app cannot apply.",
      actionLabel: "Return to dashboard",
      actionTarget: "overview",
    },
    notifications: {
      title: "Notifications",
      description: "Dashboard notices appear in the app, and Telegram can send counts-only refresh summaries when configured.",
      detail: "Telegram does not receive task titles, notes, email, or calendar details. Manage its connection from Integrations.",
      actionLabel: "Manage integrations",
      actionTarget: "integrations",
    },
    privacy: {
      title: "Privacy",
      description: "Your Notion database remains the source of truth for planner tasks.",
      detail: "MongoDB stores AI and integration metadata. Connected Google data is only used by on-demand features; review or revoke provider connections in Integrations.",
      actionLabel: "Review integrations",
      actionTarget: "integrations",
    },
    authentication: {
      title: "Authentication",
      description: "Clerk manages your sign-in session and account security.",
      detail: "Open your Clerk account profile to manage account details and security options.",
      actionLabel: "Manage Clerk account",
      actionTarget: "profile",
    },
    "ai-preferences": {
      title: "AI preferences",
      description: "The assistant can summarize planner context and help prepare next steps.",
      detail: "AI-generated changes are proposals; writing or editing planner items still requires your confirmation.",
      actionLabel: "Open AI Assistant",
      actionTarget: "planner-assistant",
    },
    "integration-permissions": {
      title: "Integration permissions",
      description: "Review connected providers and revoke access from their integration cards.",
      detail: "The Integrations page shows connection status and the available disconnect or account-link actions.",
      actionLabel: "Open Integrations",
      actionTarget: "integrations",
    },
    "data-controls": {
      title: "Data export and deletion",
      description: "Download the planner tasks currently loaded from your Notion database.",
      detail: "This export contains planner task data only. Deletion is not performed here; manage planner records in Notion and revoke app connections from Integrations.",
      actionLabel: "Manage integrations",
      actionTarget: "integrations",
    },
  };
  const settingsPage = settingsPages[activeTab];

  function downloadPlannerExport() {
    const exportData = {
      exportedAt: new Date().toISOString(),
      source: "ASLADDIIN OS",
      tasks,
    };
    const file = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aslad-diin-os-planner-${today}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!isLoaded) {
    return <main className="auth-page"><LoaderCircle size={20} className="spin" /><span>Checking your access…</span></main>;
  }
  if (!hasAccess) {
    return (
      <main className="auth-page">
        <section className="access-denied">
          <h1>Sign in required</h1>
          <p>Sign in with the verified email address authorized for this planner.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell" id="overview">
      <div className={`sidebar-wrap${sidebarOpen ? " sidebar-open" : ""}`}><Sidebar activeTarget={activeTab} onSelectTarget={selectTab} onClose={() => setSidebarOpen(false)}
        taskCount={myDayTaskCount} projectCount={areaData.length} meetingCount={meetingsToday} /></div>
      {sidebarOpen && <button className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu round-button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button>
          <div className="breadcrumbs"><span>ASLADDIIN OS</span><span>/</span><strong>{activeTabLabel}</strong></div>
          <div className="topbar-right">
            <span className="updated-label">{lastUpdated ? `Updated at ${lastUpdated}` : "Live from Notion"}</span>
            <span className={`connection-label ${state === "ready" ? "connected" : state === "error" ? "disconnected" : ""}`}><i />{state === "ready" ? "Connected" : state === "error" ? "Not connected" : "Connecting"}</span>
            <UserButton />
          </div>
        </header>

        <div className="page-wrap">
          <div className={`tab-content${activeTab === "overview" ? " is-active" : ""}`} id="overview-tab" role="region" aria-labelledby="nav-overview" aria-hidden={activeTab !== "overview"}>
          <section className="welcome-row command-center-banner">
            <div className="command-center-copy">
              <h1>Good morning, {user?.firstName || "Asladin"}</h1>
              <p>Here is what needs your attention today.</p>
            </div>
            <div className="command-center-actions">
              <time className="command-center-date"><CalendarDays size={13} />{greeting}</time>
              <button type="button" className="home-action-button home-action-primary" onClick={() => { setEditingTask(null); setCreateDialogOpen(true); }} disabled={!taskOptions}>
                <Plus size={14} /> New Task
              </button>
              <button type="button" className="home-action-button" onClick={() => selectTab("planner-assistant")}>
                <Sparkles size={14} /> Ask AI
              </button>
              <button type="button" className="home-action-button" disabled title="Focus timer is not available yet">
                <Clock3 size={14} /> Start Focus
              </button>
              <button type="button" className="home-action-button" onClick={() => void loadTasks(true)} disabled={state === "loading"}>
                <RefreshCw size={14} className={state === "loading" ? "spin" : ""} /> Refresh
              </button>
            </div>
          </section>

          {state === "error" && <div className="connection-banner"><span className="banner-icon"><AlertTriangle size={16} /></span><div><strong>We couldn’t load your Notion tasks</strong><p>{error}</p></div><button onClick={() => void loadTasks()}>Try again</button></div>}
          {state === "loading" && tasks.length === 0 && <div className="loading-banner"><LoaderCircle size={15} className="spin" /> Connecting securely to your Notion database...</div>}
          {successMessage && <div className="success-banner" role="status"><Check size={15} /><span>{successMessage}</span><button onClick={() => setSuccessMessage("")} aria-label="Dismiss">×</button></div>}
          {actionError && <div className="connection-banner" role="alert"><span className="banner-icon"><AlertTriangle size={16} /></span><div><strong>Could not update the planner</strong><p>{actionError}</p></div><button onClick={() => setActionError("")}>Dismiss</button></div>}

          <MetricsGrid
            tasks={tasks}
            tasksReady={state === "ready"}
            tasksError={state === "error" ? error : undefined}
            refreshKey={dashboardRefreshKey}
            timeZone={PLANNER_TIME_ZONE}
          />

          <section className="daily-focus-grid" aria-label="Daily briefing and focused tasks">
            <DailyBriefingPanel refreshKey={dashboardRefreshKey} />
            <section className="panel my-day-panel" id="my-day" aria-labelledby="my-day-title">
              <div className="panel-heading">
                <div><h2 id="my-day-title">My Day</h2><p>Today&apos;s deadlines, overdue work, and daily routines</p></div>
                <span className="chart-heading-icon tone-amber"><CalendarDays size={15} /></span>
              </div>
              {myDayTasks.length > 0 ? (
                <div className="my-day-list">
                  {myDayTasks.map((task) => (
                    <article className={`my-day-item${task.completed ? " completed" : ""}`} key={task.id}>
                      <button type="button" aria-label={`Mark ${task.title} ${task.completed ? "not complete" : "complete"}`}
                        onClick={() => void handleTaskComplete(task)} disabled={state !== "ready" || completingTaskId === task.id}>
                        {completingTaskId === task.id ? <LoaderCircle size={14} className="spin" /> : <CheckCheck size={14} />}
                      </button>
                      <a className="my-day-title" href={task.url} target="_blank" rel="noreferrer">
                        <strong>{task.title}</strong><span>{[task.courseCode, task.course, task.nextAction].filter(Boolean).join(" · ")}</span>
                      </a>
                      <span className={`my-day-priority priority-${task.priority.toLowerCase()}`}>{task.priority}</span>
                      <button className="my-day-edit" type="button" onClick={() => { setCreateDialogOpen(false); setEditingTask(task); }}>Edit</button>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="my-day-empty">{state === "ready" ? "No overdue, due-today, or daily recurring items. You’re clear for today." : "Connect to Notion to see today's focus."}</p>
              )}
              <div className="my-day-footer">
                <span>{myDayTaskCount} focus item{myDayTaskCount === 1 ? "" : "s"}{myDayTaskCount > myDayTasks.length ? ` · showing top ${myDayTasks.length}` : ""}{tasks.some((task) => isOverdue(task, today)) ? ` · ${tasks.filter((task) => isOverdue(task, today)).length} overdue` : ""}</span>
                <button type="button" disabled={state !== "ready"} onClick={() => {
                  setRequestDayPlan(true);
                  selectTab("planner-assistant");
                  window.setTimeout(() => document.getElementById("planner-assistant")?.scrollIntoView({ behavior: "smooth" }), 0);
                }}>Plan my day with AI <Sparkles size={12} /></button>
              </div>
            </section>
          </section>

          <WorkspaceAttention
            summary={googleSummary}
            loaded={googleSummaryLoaded}
            loading={googleLoading}
            onOpenWorkspace={() => selectTab("google-workspace")}
          />

          <NextBestActionPanel
            disabled={state !== "ready"}
            refreshKey={dashboardRefreshKey}
            onComplete={async (taskId) => {
              const task = tasks.find((item) => item.id === taskId);
              if (task) await handleTaskComplete(task);
            }}
          />

          <section className="dashboard-insights-grid" aria-label="Recent activity and AI recommendations">
            <RecentActivityTimeline
              refreshKey={`${dashboardRefreshKey}:${activityRefreshKey}`}
              onNavigate={selectTab}
            />
            <AIRecommendationsPanel
              disabled={state !== "ready" || !googleSummaryLoaded}
              googleConnected={googleSummary.connected}
              refreshKey={dashboardRefreshKey}
              onNotify={notify}
            />
          </section>

          </div>

          <div className={`tab-content${activeTab === "integrations" ? " is-active" : ""}`} id="integrations-tab" role="region" aria-labelledby="nav-integrations" aria-hidden={activeTab !== "integrations"}>
            <div className="section-heading">
              <div><h2>Integrations</h2><p>Connect the tools that support your workspace.</p></div>
              <span className="live-label"><i /> Manage connected services</span>
            </div>
            <section className="integrations-page" aria-label="Connected services">
              <section className="panel planner-source-panel" aria-labelledby="notion-source-title">
                <div className="panel-heading">
                  <div><h2 id="notion-source-title">Notion</h2><p>Your planner database for tasks, notes, and projects.</p></div>
                  <div className="google-workspace-actions">
                    <span className={`connection-label ${state === "ready" ? "connected" : state === "error" ? "disconnected" : ""}`}>
                      <i />{state === "ready" ? "Connected" : state === "error" ? "Not connected" : "Connecting"}
                    </span>
                    <button type="button" className="refresh-button" onClick={() => void loadTasks(true)} disabled={state === "loading"}>
                      <RefreshCw size={13} className={state === "loading" ? "spin" : ""} />Refresh
                    </button>
                  </div>
                </div>
                {state === "error" && <p className="google-workspace-error" role="alert">{error}</p>}
              </section>
              <GoogleConnectionCard
                summary={googleSummary}
                loaded={googleSummaryLoaded}
                loading={googleLoading}
                error={googleError}
                lastSyncedAt={googleLastSyncedAt}
                onRefresh={(showToast) => void loadGoogleSummary(showToast)}
                onDisconnect={() => void handleGoogleDisconnect()}
                onOpenWorkspace={() => selectTab("google-workspace")}
              />
              <ProviderIntegrations />
            </section>
          </div>

          <div className={`tab-content${activeTab === "google-workspace" ? " is-active" : ""}`} id="google-workspace-tab" role="region" aria-labelledby="nav-google-workspace" aria-hidden={activeTab !== "google-workspace"}>
            <GoogleWorkspacePage
              summary={googleSummary}
              loaded={googleSummaryLoaded}
              loading={googleLoading}
              error={googleError}
              onRefresh={(showToast) => void loadGoogleSummary(showToast)}
              onOpenIntegrations={() => selectTab("integrations")}
            />
          </div>

          <div className={`tab-content${activeTab === "progress" ? " is-active" : ""}`} id="progress-tab" role="region" aria-labelledby="nav-progress" aria-hidden={activeTab !== "progress"}>
          <div className="section-heading" id="progress"><div><h2>Your progress</h2><p>See where your time and attention are going</p></div><span className="live-label"><i /> All insights from your database</span></div>
          <section className="charts-grid">
            <article className="panel chart-panel"><div className="panel-heading"><div><h3>Task status</h3><p>Completed vs. pending</p></div><span className="chart-heading-icon tone-green"><CheckCheck size={15} /></span></div><div className="status-chart-row"><StatusChart data={statusDistribution} /><div className="status-legend"><div><i className="legend-completed" /><span>Completed</span><strong>{metrics.completed}</strong></div><div><i className="legend-pending" /><span>Pending</span><strong>{metrics.pending}</strong></div></div></div></article>
            <article className="panel chart-panel"><div className="panel-heading"><div><h3>Priority distribution</h3><p>Focus on what matters most</p></div><span className="chart-heading-icon tone-amber"><Flame size={15} /></span></div>{priorityData.length > 0 ? <PriorityChart data={priorityData} /> : <div className="chart-empty">Add priorities to your Notion tasks to see this chart.</div>}</article>
            <article className="panel chart-panel"><div className="panel-heading"><div><h3>Task type</h3><p>How your tasks are categorized</p></div><span className="chart-heading-icon tone-violet"><Target size={15} /></span></div><TypeChart data={typeData} /></article>
            <article className="panel chart-panel timeline-panel"><div className="panel-heading"><div><h3>Task timeline</h3><p>Tasks created over the last 6 months</p></div><span className="chart-heading-icon tone-blue"><CalendarDays size={15} /></span></div><TimelineChart data={timelineData} /></article>
          </section>
          <section className="progress-details-grid" aria-label="Detailed progress">
            <article className="panel progress-detail-card">
              <div className="panel-heading"><div><h3>Estimated vs. actual hours</h3><p>Total recorded workload</p></div><Clock3 size={15} className="panel-title-icon" /></div>
              <div className="hours-comparison"><div><span>Estimated</span><strong>{totalEstimatedHours}h</strong></div><div><span>Actual</span><strong>{totalActualHours}h</strong></div></div>
            </article>
            <article className="panel progress-detail-card">
              <div className="panel-heading"><div><h3>Progress by type</h3><p>Completed items by category</p></div><Target size={15} className="panel-title-icon" /></div>
              <div className="type-progress-list">{typeProgress.map((type) => <div className="type-progress-row" key={type.name}><span>{type.name}</span><strong>{type.completed}/{type.total}</strong></div>)}</div>
            </article>
            <article className="panel progress-detail-card">
              <div className="panel-heading"><div><h3>Deliverables</h3><p>Completion and overdue work</p></div><CheckCheck size={15} className="panel-title-icon" /></div>
              <div className="deliverable-progress-metrics"><div><strong>{completedDeliverables}/{deliverableTasks.length}</strong><span>completed</span></div><div><strong className={overdueDeliverables ? "overdue-value" : ""}>{overdueDeliverables}</strong><span>overdue</span></div></div>
            </article>
            <article className="panel progress-detail-card">
              <div className="panel-heading"><div><h3>Upcoming reviews</h3><p>Next scheduled review dates</p></div><CalendarDays size={15} className="panel-title-icon" /></div>
              <div className="review-progress-list">{upcomingReviews.map((task) => <a href={task.url} target="_blank" rel="noreferrer" key={task.id}><time>{formatDate(task.nextReviewDate!)}</time><span>{task.title}</span></a>)}
                {upcomingReviews.length === 0 && <p className="course-progress-empty">No upcoming reviews scheduled.</p>}
              </div>
            </article>
          </section>
          </div>

          <div className={`tab-content${activeTab === "planner-assistant" ? " is-active" : ""}`} id="ai-assistant-tab" role="region" aria-labelledby="nav-planner-assistant" aria-hidden={activeTab !== "planner-assistant"}>
          <PlannerAssistant disabled={state !== "ready"} tasks={tasks} options={taskOptions} googleConnected={googleSummary.connected}
            taskToBreakDown={taskToBreakDown} onBreakdownHandled={clearTaskToBreakDown}
            onTaskSaved={handleAssistantTaskSaved} startDayPlan={requestDayPlan} onDayPlanStarted={clearDayPlanRequest} />
          </div>

          <div className={`tab-content${activeTab === "calendar" ? " is-active" : ""}`} id="calendar-tab" role="region" aria-labelledby="nav-calendar" aria-hidden={activeTab !== "calendar"}>
            <CalendarCard tasks={tasks} options={taskOptions} />
          </div>

          <div className={`tab-content${activeTab === "projects" ? " is-active" : ""}`} id="projects-tab" role="region" aria-labelledby="nav-projects" aria-hidden={activeTab !== "projects"}>
            <section className="panel areas-panel" id="projects">
              <div className="panel-heading"><div><h2>Progress by area</h2><p>Completion across your focus areas</p></div><Target size={16} className="panel-title-icon" /></div>
              <div className="area-list">
                {areaData.map((area, index) => (
                  <div className="area-row" key={area.name}>
                    <div className="area-topline"><span className={`area-color area-color-${index}`} /><strong>{area.name}</strong><span className="area-task-count">{area.completed}/{area.value}</span><b>{area.percentage}%</b></div>
                    <div className="area-progress"><span className={`area-progress-${index}`} style={{ width: `${area.percentage}%` }} /></div>
                  </div>
                ))}
                {state === "ready" && areaData.length === 0 && <div className="chart-empty area-empty">Add an Area to your tasks to see progress here.</div>}
                {state === "loading" && areaData.length === 0 && <div className="area-placeholder"><span /><span /><span /></div>}
              </div>
              <div className="course-progress-section">
                <div className="course-progress-heading"><strong>Courses</strong><span>{courseWorkloadHours}h remaining</span></div>
                {courseData.map((course, index) => (
                  <div className="course-progress-row" key={course.code}>
                    <div className="course-progress-label"><span className={`course-progress-dot course-progress-dot-${index % 5}`} /><strong>{course.code}</strong><span>{course.name}</span><b>{course.remainingHours}h</b></div>
                    <div className="course-progress-bar"><span style={{ width: `${course.percentage}%` }} /></div>
                    <small>{course.completed}/{course.total} completed · {course.total - course.completed} pending</small>
                  </div>
                ))}
                {courseData.length === 0 && <p className="course-progress-empty">Add a Course Code to academic items to see course workload.</p>}
              </div>
              <div className="area-summary"><span><span className="summary-dot" />{areaData.length} active areas</span><span>{metrics.completion}% avg. completion</span></div>
              <div className="focus-tip"><Sparkles size={14} /><span><strong>Keep your momentum</strong> Small steps across every area still add up.</span></div>
            </section>
          </div>

          <div className={`tab-content${activeTab === "tasks" ? " is-active" : ""}`} id="tasks-tab" role="region" aria-labelledby="nav-tasks" aria-hidden={activeTab !== "tasks"}>
          <TaskTable tasks={tasks} options={taskOptions} loading={state === "loading"} search={search} onSearch={setSearch}
            onCreate={() => { setEditingTask(null); setCreateDialogOpen(true); }}
            onEdit={(task) => { setCreateDialogOpen(false); setEditingTask(task); }}
            onComplete={(task) => void handleTaskComplete(task)}
            onBreakdown={(task) => {
              setTaskToBreakDown(task);
              selectTab("planner-assistant");
              window.setTimeout(() => document.getElementById("planner-assistant")?.scrollIntoView({ behavior: "smooth" }), 0);
            }}
            onDelete={(task) => setArchiveTask(task)}
            createDisabled={state !== "ready" || !taskOptions} deleting={Boolean(deletingTaskId)} completingId={completingTaskId} />
          </div>

          <div className={`tab-content${activeTab === "notes" ? " is-active" : ""}`} id="notes-tab" role="region" aria-labelledby="nav-notes" aria-hidden={activeTab !== "notes"}>
            <NotesPanel tasks={tasks} />
          </div>

          {activeTab === "goals" && (
            <div className="tab-content is-active" id="goals-tab" role="region" aria-labelledby="nav-goals">
              <div className="section-heading">
                <div><h2>Goals</h2><p>Track progress using the areas and tasks already in your Notion planner.</p></div>
                <button type="button" className="refresh-button" onClick={() => selectTab("projects")}>View project progress</button>
              </div>
              <section className="panel areas-panel">
                <div className="panel-heading"><div><h3>Progress by area</h3><p>Current goal progress is estimated from completed planner tasks.</p></div><Target size={16} className="panel-title-icon" /></div>
                <div className="area-list">
                  {areaData.map((area, index) => (
                    <div className="area-row" key={area.name}>
                      <div className="area-topline"><span className={`area-color area-color-${index}`} /><strong>{area.name}</strong><span className="area-task-count">{area.completed}/{area.value}</span><b>{area.percentage}%</b></div>
                      <div className="area-progress"><span className={`area-progress-${index}`} style={{ width: `${area.percentage}%` }} /></div>
                    </div>
                  ))}
                  {state === "ready" && areaData.length === 0 && <div className="chart-empty area-empty">Add an Area to your Notion tasks to see goal progress here.</div>}
                  {state === "loading" && areaData.length === 0 && <div className="area-placeholder"><span /><span /><span /></div>}
                  {state === "error" && <p className="course-progress-empty">{error}</p>}
                </div>
                <div className="area-summary"><span><span className="summary-dot" />{areaData.length} tracked areas</span><span>{metrics.completion}% overall task completion</span></div>
              </section>
            </div>
          )}

          {activeTab === "knowledge" && (
            <div className="tab-content is-active" id="knowledge-tab" role="region" aria-labelledby="nav-knowledge">
              <NotesPanel tasks={tasks} />
            </div>
          )}

          {activeTab === "system-activity" && (
            <div className="tab-content is-active" id="system-activity-tab" role="region" aria-labelledby="nav-system-activity">
              <div className="section-heading"><div><h2>System activity</h2><p>Recent changes and completed actions in your workspace.</p></div></div>
              <RecentActivityTimeline refreshKey={`${dashboardRefreshKey}:${activityRefreshKey}:system`} onNavigate={selectTab} />
            </div>
          )}

          {activeTab === "completed-work" && (
            <div className="tab-content is-active" id="completed-work-tab" role="region" aria-labelledby="nav-completed-work">
              <div className="section-heading"><div><h2>Completed work</h2><p>{metrics.completed} completed planner item{metrics.completed === 1 ? "" : "s"} from your Notion database.</p></div></div>
              <TaskTable tasks={tasks.filter((task) => task.completed)} options={taskOptions} loading={state === "loading"} search={search} onSearch={setSearch}
                onCreate={() => { setEditingTask(null); setCreateDialogOpen(true); }}
                onEdit={(task) => { setCreateDialogOpen(false); setEditingTask(task); }}
                onComplete={(task) => void handleTaskComplete(task)}
                onBreakdown={(task) => { setTaskToBreakDown(task); selectTab("planner-assistant"); }}
                onDelete={(task) => setArchiveTask(task)}
                createDisabled={state !== "ready" || !taskOptions} deleting={Boolean(deletingTaskId)} completingId={completingTaskId} />
            </div>
          )}

          {activeTab === "project-progress" && (
            <div className="tab-content is-active" id="project-progress-tab" role="region" aria-labelledby="nav-project-progress">
              <div className="section-heading"><div><h2>Project progress</h2><p>Completion summaries based on the areas represented in your planner.</p></div>
                <button type="button" className="refresh-button" onClick={() => selectTab("projects")}>Open projects</button>
              </div>
              <section className="panel areas-panel">
                <div className="panel-heading"><div><h3>Active areas</h3><p>Completed items compared with total planner items.</p></div><GitBranch size={16} className="panel-title-icon" /></div>
                <div className="area-list">
                  {areaData.map((area, index) => (
                    <div className="area-row" key={area.name}>
                      <div className="area-topline"><span className={`area-color area-color-${index}`} /><strong>{area.name}</strong><span className="area-task-count">{area.completed}/{area.value}</span><b>{area.percentage}%</b></div>
                      <div className="area-progress"><span className={`area-progress-${index}`} style={{ width: `${area.percentage}%` }} /></div>
                    </div>
                  ))}
                  {state === "ready" && areaData.length === 0 && <div className="chart-empty area-empty">Add an Area to your Notion tasks to see project progress.</div>}
                  {state === "loading" && areaData.length === 0 && <div className="area-placeholder"><span /><span /><span /></div>}
                  {state === "error" && <p className="course-progress-empty">{error}</p>}
                </div>
                <div className="area-summary"><span><span className="summary-dot" />{areaData.length} active areas</span><span>{metrics.completion}% overall task completion</span></div>
              </section>
            </div>
          )}

          {activeTab === "reviews" && (
            <div className="tab-content is-active" id="reviews-tab" role="region" aria-labelledby="nav-reviews">
              <div className="section-heading"><div><h2>Weekly and monthly reviews</h2><p>Review dates recorded on incomplete planner items.</p></div></div>
              <section className="panel progress-detail-card">
                <div className="panel-heading"><div><h3>Upcoming reviews</h3><p>Scheduled next review dates, ordered by date.</p></div><CalendarDays size={15} className="panel-title-icon" /></div>
                <div className="review-progress-list">
                  {upcomingReviews.map((task) => <a href={task.url} target="_blank" rel="noreferrer" key={task.id}><time>{formatDate(task.nextReviewDate!)}</time><span>{task.title}</span><ExternalLink size={12} /></a>)}
                  {state === "ready" && upcomingReviews.length === 0 && <p className="course-progress-empty">No upcoming reviews are scheduled. Add a Next Review Date to a planner item to see it here.</p>}
                  {state === "loading" && <p className="course-progress-empty">Loading review dates…</p>}
                  {state === "error" && <p className="course-progress-empty">{error}</p>}
                </div>
              </section>
            </div>
          )}

          {activeTab === "ai-observations" && (
            <div className="tab-content is-active" id="ai-observations-tab" role="region" aria-labelledby="nav-ai-observations">
              <div className="section-heading"><div><h2>AI-generated observations</h2><p>Use the existing briefing and assistant to turn planner context into practical next steps.</p></div></div>
              <section className="panel progress-detail-card">
                <div className="panel-heading"><div><h3>Current workspace snapshot</h3><p>These counts come directly from the tasks currently loaded from Notion.</p></div><Sparkles size={15} className="panel-title-icon" /></div>
                <div className="hours-comparison">
                  <div><span>Incomplete</span><strong>{metrics.pending}</strong></div>
                  <div><span>Overdue</span><strong className={metrics.overdue ? "overdue-value" : ""}>{metrics.overdue}</strong></div>
                  <div><span>Completed</span><strong>{metrics.completed}</strong></div>
                </div>
                <p className="course-progress-empty">The AI daily briefing is available on the Dashboard. Ask the AI Assistant to summarize notes, plan your day, or break a project into steps.</p>
                <div className="google-workspace-actions">
                  <button type="button" className="refresh-button" onClick={() => selectTab("overview")}>Open dashboard briefing</button>
                  <button type="button" className="refresh-button" onClick={() => selectTab("planner-assistant")}>Open AI Assistant</button>
                </div>
              </section>
            </div>
          )}

          {settingsPage && (
            <div className="tab-content is-active" id={`${activeTab}-tab`} role="region" aria-labelledby={`nav-${activeTab}`}>
              <div className="section-heading"><div><h2>{settingsPage.title}</h2><p>{settingsPage.description}</p></div></div>
              <section className="panel progress-detail-card">
                <div className="panel-heading"><div><h3>{settingsPage.title} controls</h3><p>{settingsPage.detail}</p></div></div>
                <div className="google-workspace-actions">
                  {activeTab === "data-controls" && (
                    <button type="button" className="refresh-button" onClick={downloadPlannerExport} disabled={state !== "ready"}>
                      <Download size={13} />Export planner data
                    </button>
                  )}
                  <button type="button" className="refresh-button" onClick={() => {
                    if (settingsPage.actionTarget === "profile") clerk.openUserProfile();
                    else selectTab(settingsPage.actionTarget);
                  }}>{settingsPage.actionLabel}</button>
                </div>
              </section>
            </div>
          )}

          <footer className="page-footer"><span>Made for a more focused day</span><span><i /> Connected securely to your Notion database <span className="footer-separator">·</span> {tasks.length} planner items</span></footer>
        </div>
      </main>
      {toast && <div className={`command-toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite"><span>{toast.message}</span><button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">×</button></div>}
      {archiveTask && <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchiveTask(null); }}>
        <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-dialog-title" aria-describedby="archive-dialog-description">
          <span className="confirm-dialog-icon"><Trash2 size={17} /></span>
          <h2 id="archive-dialog-title">Archive this planner item?</h2>
          <p id="archive-dialog-description">“{archiveTask.title}” will move to Notion&apos;s trash. You can restore it there later.</p>
          <div><button type="button" className="confirm-cancel" onClick={() => setArchiveTask(null)}>Keep item</button><button type="button" className="confirm-danger" onClick={() => void confirmArchiveTask()}>Archive item</button></div>
        </section>
      </div>}
      {(createDialogOpen || editingTask) && taskOptions && <TaskDialog key={editingTask?.id ?? "new"} options={taskOptions} task={editingTask}
        onClose={() => { setCreateDialogOpen(false); setEditingTask(null); }} onSaved={handleTaskSaved} />}
    </div>
  );
}
