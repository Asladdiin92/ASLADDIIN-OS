import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  dismissRecommendation,
  getCurrentRecommendations,
  getDismissedRecommendationTaskIds,
  invalidateStaleRecommendations,
  storeRecommendation,
} from "@/lib/ai-recommendations";
import { hasPlannerUserAccess } from "@/lib/access";
import { explainNextAction } from "@/lib/gemini";
import { fetchGoogleCalendarEvents, readGoogleSession } from "@/lib/google-workspace";
import { PLANNER_TIME_ZONE } from "@/lib/planner-datetime";
import { getNextFocusWindow, type NextActionCandidate } from "@/lib/next-action";
import {
  explainScoredTask,
  rankTasks,
  taskRecommendationFingerprint,
  type ScoredTask,
} from "@/lib/task-scoring";
import { fetchNotionTasks } from "@/lib/notion";
import { isSameOrigin } from "@/lib/task-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function taskCandidate(scored: ScoredTask): NextActionCandidate {
  const task = scored.task;
  const deadline = scored.factors.find((factor) => factor.key === "deadline")?.evidence;
  const hasDeadline = deadline !== "No deadline recorded" && deadline !== "Deadline is unavailable or invalid";
  return {
    id: task.id,
    url: task.url,
    title: task.title,
    priority: task.priority || "Unassigned",
    area: task.area || "",
    dueDate: hasDeadline ? task.dateEnd || task.dueDate : null,
    dueLabel: deadline === "Overdue" ? "Overdue"
      : deadline === "Due today" ? "Due today"
        : hasDeadline ? "Upcoming" : "No deadline",
    estimatedMinutes: Number.isFinite(task.estimatedHours) && (task.estimatedHours ?? 0) > 0
      ? Math.ceil(task.estimatedHours! * 60)
      : null,
    nextAction: task.nextAction || "",
  };
}

function safeErrorResponse(error: unknown) {
  console.error("Next-action recommendation failed.", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: "Could not prepare your next-action recommendation. Please try again." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function authorizedUser(request: NextRequest): Promise<string | NextResponse> {
  const { userId } = await auth();
  if (!userId || !await hasPlannerUserAccess(userId)) {
    return NextResponse.json({ error: "You are not authorized to use this planner." }, { status: 403 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "This request must come from the dashboard." }, { status: 403 });
  }
  return userId;
}

export async function POST(request: NextRequest) {
  const userId = await authorizedUser(request);
  if (userId instanceof NextResponse) return userId;

  try {
    const now = new Date();
    const session = readGoogleSession(request, userId);
    const [tasks, eventsResult] = await Promise.all([
      fetchNotionTasks(),
      session ? fetchGoogleCalendarEvents(session, now).then(
        (events) => ({ events, available: true }),
        () => ({ events: [], available: false }),
      ) : Promise.resolve({ events: [], available: false }),
    ]);
    const [, dismissed] = await Promise.all([
      invalidateStaleRecommendations(userId, tasks, now),
      getDismissedRecommendationTaskIds(userId),
    ]);
    const ranked = rankTasks(tasks, dismissed, now, PLANNER_TIME_ZONE);
    const currentRecommendations = await getCurrentRecommendations(
      userId,
      ranked.map((scored) => ({
        taskId: scored.task.id,
        taskFingerprint: taskRecommendationFingerprint(scored.task),
      })),
      now,
    );
    const focusWindow = getNextFocusWindow(now, PLANNER_TIME_ZONE, eventsResult.events);
    const currentLocalTime = new Intl.DateTimeFormat("en", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: PLANNER_TIME_ZONE,
      timeZoneName: "short",
    }).format(now);

    for (const scored of ranked) {
      const fingerprint = taskRecommendationFingerprint(scored.task);
      const saved = currentRecommendations.get(scored.task.id);
      if (saved && saved.score === scored.score &&
          JSON.stringify(saved.factors) === JSON.stringify(scored.factors)) {
        return NextResponse.json({
          candidate: taskCandidate(scored),
          focusWindow,
          explanation: saved.explanation,
          explanationSource: saved.explanationSource,
          score: saved.score,
          priorityLabel: saved.label,
          factors: saved.factors,
          recommendationId: saved._id.toHexString(),
          calendarConnected: Boolean(session),
          calendarAvailable: eventsResult.available,
          currentLocalTime,
        }, { headers: { "Cache-Control": "no-store" } });
      }

      const candidate = taskCandidate(scored);
      const result = await explainScoredTask(scored, async () => {
        if (!focusWindow) throw new Error("No available focus window.");
        return explainNextAction(candidate, focusWindow, currentLocalTime);
      });
      const record = await storeRecommendation(userId, {
        taskId: scored.task.id,
        taskFingerprint: fingerprint,
        taskTitle: scored.task.title,
        score: scored.score,
        label: scored.label,
        factors: scored.factors,
        explanation: result.explanation,
        explanationSource: result.source,
        expiresAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
      }, now);
      if (!record || record.status !== "active") continue;
      return NextResponse.json({
        candidate,
        focusWindow,
        explanation: record.explanation,
        explanationSource: record.explanationSource,
        score: record.score,
        priorityLabel: record.label,
        factors: record.factors,
        recommendationId: record._id.toHexString(),
        calendarConnected: Boolean(session),
        calendarAvailable: eventsResult.available,
        currentLocalTime,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({
      candidate: null,
      focusWindow,
      message: ranked.length
        ? "The available recommendation was dismissed. Recheck to load another task."
        : "There are no incomplete, non-dismissed planner tasks to recommend.",
      calendarConnected: Boolean(session),
      calendarAvailable: eventsResult.available,
      currentLocalTime,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const userId = await authorizedUser(request);
  if (userId instanceof NextResponse) return userId;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        (body as Record<string, unknown>).action !== "dismiss" ||
        typeof (body as Record<string, unknown>).recommendationId !== "string") {
      return NextResponse.json({ error: "Choose a valid recommendation to dismiss." }, { status: 400 });
    }
    const dismissed = await dismissRecommendation(
      userId,
      (body as { recommendationId: string }).recommendationId,
    );
    if (!dismissed) {
      return NextResponse.json({ error: "This recommendation is no longer active." }, { status: 404 });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
