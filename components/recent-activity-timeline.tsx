"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpenText,
  Check,
  Circle,
  CirclePlus,
  Clock3,
  FolderKanban,
  ListChecks,
  NotebookPen,
  RefreshCw,
  ScanEye,
  Sparkles,
  Timer,
  type LucideIcon,
  ArrowUpRight,
  UserRoundPen,
  UserRoundPlus,
} from "lucide-react";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";

type ActivityType =
  | "task_created"
  | "task_updated"
  | "task_completed"
  | "project_updated"
  | "note_created"
  | "note_updated"
  | "focus_started"
  | "focus_completed"
  | "ai_plan_generated"
  | "ai_recommendation_generated"
  | "notion_sync_completed"
  | "contact_synced"
  | "contact_updated"
  | "vision_analyzed";

type Activity = {
  id: string;
  type: ActivityType;
  source: string;
  title: string;
  description?: string;
  entityType?: string;
  entityId?: string;
  occurredAt: string;
};

type ActivitiesResponse = {
  ok: boolean;
  activities?: Activity[];
  nextCursor?: string | null;
  error?: string;
};

const ACTIVITY_LIMIT = 8;

const ACTIVITY_PRESENTATION: Record<ActivityType, { icon: LucideIcon; tone: string }> = {
  task_created: { icon: CirclePlus, tone: "activity-tone-green" },
  task_updated: { icon: ListChecks, tone: "activity-tone-cyan" },
  task_completed: { icon: Check, tone: "activity-tone-green" },
  project_updated: { icon: FolderKanban, tone: "activity-tone-violet" },
  note_created: { icon: NotebookPen, tone: "activity-tone-cyan" },
  note_updated: { icon: BookOpenText, tone: "activity-tone-cyan" },
  focus_started: { icon: Timer, tone: "activity-tone-violet" },
  focus_completed: { icon: Clock3, tone: "activity-tone-green" },
  ai_plan_generated: { icon: Sparkles, tone: "activity-tone-violet" },
  ai_recommendation_generated: { icon: Sparkles, tone: "activity-tone-violet" },
  notion_sync_completed: { icon: RefreshCw, tone: "activity-tone-cyan" },
  contact_synced: { icon: UserRoundPlus, tone: "activity-tone-cyan" },
  contact_updated: { icon: UserRoundPen, tone: "activity-tone-violet" },
  vision_analyzed: { icon: ScanEye, tone: "activity-tone-violet" },
};

const SOURCE_LABELS: Record<string, string> = {
  notion: "Notion",
  dashboard: "Dashboard",
  ai: "AI assistant",
  focus: "Focus",
  system: "System",
};

const ENTITY_TABS: Record<string, { tab: string; label: string }> = {
  task: { tab: "tasks", label: "View tasks" },
  project: { tab: "projects", label: "View projects" },
  note: { tab: "notes", label: "View notes" },
  meeting: { tab: "calendar", label: "View calendar" },
};

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, "second");
}

export function ActivityTimelineItem({
  activity,
  onNavigate,
}: {
  activity: Activity;
  onNavigate?: (tab: string) => void;
}) {
  const presentation = ACTIVITY_PRESENTATION[activity.type];
  const Icon = presentation.icon;
  const entityLink = activity.entityType ? ENTITY_TABS[activity.entityType.toLowerCase()] : undefined;
  const date = new Date(activity.occurredAt);
  const validDate = Number.isFinite(date.getTime());

  return (
    <li className="activity-item timeline-item">
      <span className={`activity-check ${presentation.tone}`} aria-hidden="true">
        <Icon size={14} strokeWidth={2} />
      </span>
      <div className="activity-copy timeline-copy">
        <strong>{activity.title}</strong>
        <span>
          {SOURCE_LABELS[activity.source] ?? "Workspace"}
          {activity.description ? ` · ${activity.description}` : ""}
        </span>
      </div>
      <time dateTime={validDate ? date.toISOString() : undefined}>
        {validDate ? relativeTime(activity.occurredAt) : "Time unavailable"}
      </time>
      {entityLink && activity.entityId && (
        <a
          className="activity-related-link"
          href={`#${entityLink.tab}`}
          onClick={() => onNavigate?.(entityLink.tab)}
          aria-label={entityLink.label}
        >
          <ArrowUpRight size={12} />
        </a>
      )}
    </li>
  );
}

export function ActivityTimelineSkeleton() {
  return (
    <div className="activity-list timeline-skeleton" aria-label="Loading recent activity">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="activity-item timeline-skeleton-row" key={index} aria-hidden="true">
          <span className="timeline-skeleton-icon" />
          <span className="timeline-skeleton-copy"><i /><i /></span>
          <span className="timeline-skeleton-time" />
        </div>
      ))}
      <span className="sr-only">Loading recent activity…</span>
    </div>
  );
}

export function ActivityTimelineEmptyState() {
  return (
    <div className="activity-empty timeline-state" role="status">
      <span className="activity-check"><Circle size={13} /></span>
      <div><strong>No activity yet</strong><p>Completed tasks, new items, and AI plans will appear here.</p></div>
    </div>
  );
}

export function ActivityTimelineErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="activity-empty timeline-state timeline-error" role="alert">
      <span className="timeline-error-icon"><RefreshCw size={14} /></span>
      <div><strong>Couldn’t load recent activity</strong><p>{message}</p></div>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

export function RecentActivityTimeline({ refreshKey, onNavigate }: {
  refreshKey: string;
  onNavigate?: (tab: string) => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  const retry = useCallback(() => setRetryKey((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/activities?limit=${ACTIVITY_LIMIT}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        const result = await readApiResponse<ActivitiesResponse>(response);
        if (!response.ok || !result.ok || !Array.isArray(result.activities)) {
          throw new Error(result.error ?? "The activity feed returned an invalid response.");
        }
        setActivities(result.activities.slice(0, ACTIVITY_LIMIT));
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setError(apiErrorMessage(requestError, "Recent activity is temporarily unavailable."));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refreshKey, retryKey]);

  return (
    <section className="panel activity-panel" aria-labelledby="recent-activity-title">
      <div className="insight-heading">
        <div>
          <span className="insight-eyebrow">YOUR WORKSPACE</span>
          <h2 id="recent-activity-title">Recent activity</h2>
          <p>Latest completed actions and updates across your workspace.</p>
        </div>
        <span className="insight-heading-icon activity-heading-icon"><Clock3 size={17} /></span>
      </div>
      {loading ? <ActivityTimelineSkeleton />
        : error ? <ActivityTimelineErrorState message={error} onRetry={retry} />
          : activities.length === 0 ? <ActivityTimelineEmptyState />
            : (
              <ol className="activity-list">
                {activities.map((activity) => (
                  <ActivityTimelineItem key={activity.id} activity={activity} onNavigate={onNavigate} />
                ))}
              </ol>
            )}
    </section>
  );
}
