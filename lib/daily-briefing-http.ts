import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hasPlannerUserAccess } from "@/lib/access";
import { PLANNER_TIME_ZONE } from "@/lib/planner-datetime";
import {
  BriefingRateLimitError,
  enforceBriefingRegenerationLimit,
  getDailyBriefing,
} from "@/lib/daily-briefing-service";

function logStageTiming(stage: string, startedAt: number): void {
  console.info("Daily briefing stage timing.", {
    stage,
    durationMs: Math.round(performance.now() - startedAt),
  });
}

function selectedTimeZone(request: Request): string | null {
  const values = new URL(request.url).searchParams.getAll("timezone");
  if (values.length === 0) return PLANNER_TIME_ZONE;
  if (values.length !== 1 || values[0].length > 100) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: values[0] }).format();
    return values[0];
  } catch {
    return null;
  }
}

export async function handleDailyBriefingRequest(request: Request, regenerate: boolean) {
  let userId: string | null;
  let stageStartedAt = performance.now();
  try {
    const session = await auth();
    userId = session.userId;
  } catch (error) {
    console.error("Daily briefing authentication failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Daily briefing is temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    logStageTiming("authentication", stageStartedAt);
  }
  if (!userId) {
    return NextResponse.json({ error: "Sign in with an authorized account to view your briefing." }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  stageStartedAt = performance.now();
  try {
    if (!await hasPlannerUserAccess(userId)) {
      return NextResponse.json({ error: "You are not authorized to view this briefing." }, {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
  } catch (error) {
    console.error("Daily briefing authorization failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Daily briefing is temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    logStageTiming("authorization", stageStartedAt);
  }
  const timeZone = selectedTimeZone(request);
  if (!timeZone) {
    return NextResponse.json({ error: "Choose a valid timezone." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (regenerate) {
    try {
      enforceBriefingRegenerationLimit(userId);
    } catch (error) {
      if (error instanceof BriefingRateLimitError) {
        return NextResponse.json({ error: error.message }, {
          status: 429,
          headers: { "Cache-Control": "no-store", "Retry-After": "60" },
        });
      }
      throw error;
    }
  }

  try {
    const briefing = await getDailyBriefing(userId, timeZone, regenerate);
    return NextResponse.json(briefing, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Daily briefing generation failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Could not prepare your daily briefing. Please try again." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
