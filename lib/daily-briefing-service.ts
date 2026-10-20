import "server-only";

import { listActivities } from "@/lib/activities";
import {
  createDailyBriefing,
  validateDailyBriefing,
  type DailyBriefing,
} from "@/lib/daily-briefing";
import { generateDailyBriefingText } from "@/lib/gemini";
import { getFocusMinutesToday } from "@/lib/focus-sessions";
import { fetchNotionTasks } from "@/lib/notion";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGENERATE_INTERVAL_MS = 60_000;

type CacheEntry = { briefing: DailyBriefing; expiresAt: number };
const briefingCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<DailyBriefing>>();
const regenerationTimes = new Map<string, number>();

async function measureStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    console.info("Daily briefing stage timing.", {
      stage,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
}

export class BriefingRateLimitError extends Error {
  constructor() {
    super("Please wait before regenerating your daily briefing.");
    this.name = "BriefingRateLimitError";
  }
}

function cacheKey(userId: string, timeZone: string, now: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return `${userId}:${timeZone}:${day}`;
}

function trimMap<K, V>(map: Map<K, V>, maxSize = 1000): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function enforceBriefingRegenerationLimit(userId: string, now = Date.now()): void {
  const previous = regenerationTimes.get(userId);
  if (previous !== undefined && now - previous < REGENERATE_INTERVAL_MS) {
    throw new BriefingRateLimitError();
  }
  regenerationTimes.set(userId, now);
  trimMap(regenerationTimes);
}

export async function getDailyBriefing(
  userId: string,
  timeZone: string,
  regenerate = false,
  now = new Date(),
): Promise<DailyBriefing> {
  const key = cacheKey(userId, timeZone, now);
  const cached = briefingCache.get(key);
  if (!regenerate && cached && cached.expiresAt > now.getTime()) return cached.briefing;
  const activeRequest = inFlight.get(key);
  if (activeRequest) return activeRequest;

  const request = (async () => {
    const [tasks, [activitiesResult, focusResult]] = await Promise.all([
      measureStage("notion_tasks", fetchNotionTasks),
      Promise.allSettled([
        measureStage("recent_activities", () => listActivities(userId, 10)),
        measureStage("focus_sessions", () => getFocusMinutesToday(userId, timeZone, now)),
      ]),
    ]);
    const warnings: string[] = [];
    const recentActivityTypes = activitiesResult.status === "fulfilled"
      ? activitiesResult.value.activities.map((activity) => activity.type)
      : [];
    if (activitiesResult.status === "rejected") {
      warnings.push("Recent activity data is unavailable.");
      console.error("Daily briefing activity context unavailable.", {
        errorName: activitiesResult.reason instanceof Error ? activitiesResult.reason.name : "UnknownError",
      });
    }
    const focusMinutesToday = focusResult.status === "fulfilled" ? focusResult.value : undefined;
    if (focusResult.status === "rejected") {
      warnings.push("Focus-session data is unavailable.");
      console.error("Daily briefing focus context unavailable.", {
        errorName: focusResult.reason instanceof Error ? focusResult.reason.name : "UnknownError",
      });
    }
    const briefing = await measureStage("briefing_generation", () => createDailyBriefing({
        tasks,
        now,
        timeZone,
        recentActivityTypes,
        ...(focusMinutesToday !== undefined ? { focusMinutesToday } : {}),
      }, generateDailyBriefingText, warnings));
    if (!validateDailyBriefing(briefing, tasks)) {
      throw new Error("Daily briefing response validation failed.");
    }
    briefingCache.set(key, { briefing, expiresAt: now.getTime() + CACHE_TTL_MS });
    trimMap(briefingCache);
    return briefing;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
