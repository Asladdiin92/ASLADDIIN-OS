"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCheck,
  Clock3,
  EyeOff,
  ExternalLink,
  LoaderCircle,
  type LucideIcon,
  Mail,
  Sparkles,
  Target,
} from "lucide-react";
import { formatPlannerDate, PLANNER_TIME_ZONE } from "@/lib/planner-datetime";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";
import type { FocusWindow, NextActionCandidate, NextActionSelection } from "@/lib/next-action";

type Recommendation = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: LucideIcon;
  mode: "ask" | "secretary";
  disabled?: boolean;
};

type NextActionResponse = NextActionSelection & {
  explanation?: { reason: string; firstStep: string };
  explanationSource?: "ai" | "fallback";
  score?: number;
  priorityLabel?: "Critical" | "Important" | "Normal" | "Can wait";
  factors?: Array<{ key: string; points: number; evidence: string }>;
  recommendationId?: string;
  calendarConnected: boolean;
  calendarAvailable?: boolean;
  currentLocalTime?: string;
  error?: string;
};

function safeTaskUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function focusWindowLabel(window: FocusWindow): string {
  const date = new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: PLANNER_TIME_ZONE,
  }).format(new Date(`${window.date}T12:00:00Z`));
  return `${date}, ${window.startTime}–${window.endTime}`;
}

export function NextBestActionPanel({
  disabled,
  refreshKey,
  onComplete,
}: {
  disabled: boolean;
  refreshKey: number;
  onComplete: (taskId: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NextActionResponse | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const requestController = useRef<AbortController | null>(null);
  const lastAutomaticRequest = useRef<number | null>(null);

  const requestRecommendation = useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/assistant/next-action", {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
      });
      const payload = await readApiResponse<NextActionResponse>(response);
      if (!response.ok) throw new Error(payload.error ?? "Could not get a next-action recommendation.");
      if (payload.candidate && (!payload.explanation?.reason || !payload.explanation.firstStep ||
          !Number.isSafeInteger(payload.score) || !payload.priorityLabel ||
          !payload.recommendationId || !Array.isArray(payload.factors))) {
        throw new Error("The server returned an incomplete recommendation. Please try again.");
      }
      setResult(payload);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(apiErrorMessage(requestError, "Could not get a next-action recommendation."));
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (disabled || lastAutomaticRequest.current === refreshKey) return;
    lastAutomaticRequest.current = refreshKey;
    void requestRecommendation();
  }, [disabled, refreshKey, requestRecommendation]);

  useEffect(() => () => requestController.current?.abort(), []);

  const candidate: NextActionCandidate | null = result?.candidate ?? null;
  const dueDate = candidate?.dueDate;
  const validDueDate = Boolean(dueDate && !Number.isNaN(new Date(dueDate).getTime()));
  const safeUrl = candidate ? safeTaskUrl(candidate.url) : undefined;

  const dismiss = async () => {
    if (!result?.recommendationId || dismissing) return;
    setDismissing(true);
    setError("");
    try {
      const response = await fetch("/api/assistant/next-action", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", recommendationId: result.recommendationId }),
        cache: "no-store",
      });
      const payload = await readApiResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(payload.error ?? "Could not dismiss this recommendation.");
      await requestRecommendation();
    } catch (dismissError) {
      setError(apiErrorMessage(dismissError, "Could not dismiss this recommendation."));
    } finally {
      setDismissing(false);
    }
  };

  const complete = async () => {
    if (!candidate || completing || disabled) return;
    if (!window.confirm(`Mark “${candidate.title}” as completed in Notion?`)) return;
    setCompleting(true);
    try {
      await onComplete(candidate.id);
      await requestRecommendation();
    } finally {
      setCompleting(false);
    }
  };

  return (
    <section className="panel next-action-panel" aria-labelledby="next-action-title">
      <div className="panel-heading next-action-heading">
        <div>
          <span className="insight-eyebrow">ON-DEMAND · APPROVAL ONLY</span>
          <h2 id="next-action-title">Next best action</h2>
          <p>Deterministic 0–100 task scoring; AI is used only to explain the result.</p>
        </div>
        <span className="chart-heading-icon tone-green"><Target size={15} /></span>
      </div>
      {!result && !error && (
        <div className="next-action-intro">
          <p>{loading ? "Scoring your current planner tasks…" : "Scores use recorded urgency, priority, status, task age, and effort only. Nothing changes in Notion without your confirmation."}</p>
          <button type="button" className="next-action-run" onClick={() => void requestRecommendation()} disabled={disabled || loading}>
            {loading ? <><LoaderCircle size={13} className="spin" /> Checking your planner…</> : <><Sparkles size={13} /> Recommend my next action</>}
          </button>
        </div>
      )}
      {error && <div className="next-action-error" role="alert"><p>{error}</p><button type="button" onClick={() => void requestRecommendation()} disabled={disabled || loading}>Try again</button></div>}
      {result && !candidate && <div className="next-action-empty" role="status"><p>{result.message ?? "No incomplete planner item is available to recommend."}</p>
        <button type="button" className="next-action-run" onClick={() => void requestRecommendation()} disabled={disabled || loading}>Check again</button></div>}
      {result && candidate && result.explanation && (
        <div className="next-action-result" aria-live="polite">
          {result.currentLocalTime && <p className="next-action-checked">Checked {result.currentLocalTime}</p>}
          <div className="next-action-task">
            <div><span className="next-action-overline">RECOMMENDED TASK</span><strong>{candidate.title}</strong></div>
            {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer" aria-label={`Open ${candidate.title} in Notion`}><ExternalLink size={13} /></a>}
          </div>
          <div className="next-action-facts">
            <span className={`next-action-score score-${result.priorityLabel?.toLowerCase().replaceAll(" ", "-")}`}>
              {result.score}/100 · {result.priorityLabel}
            </span>
            <span className={`next-action-deadline deadline-${candidate.dueLabel.toLowerCase().replaceAll(" ", "-")}`}>{candidate.dueLabel}{validDueDate ? ` · ${formatPlannerDate(dueDate!)}` : ""}</span>
            <span>{candidate.priority} priority</span>
            <span>{candidate.estimatedMinutes === null ? "No duration estimate recorded" : `Notion estimate · ${candidate.estimatedMinutes} min`}</span>
            {candidate.area && <span>Area · {candidate.area}</span>}
          </div>
          {result.focusWindow && <p className="next-action-window"><Clock3 size={12} /> Focus window: {focusWindowLabel(result.focusWindow)} ({result.focusWindow.availableMinutes} min available)</p>}
          {!result.calendarConnected && <p className="next-action-calendar-note">Google Calendar isn&apos;t connected, so meeting conflicts could not be checked.</p>}
          {result.calendarConnected && !result.calendarAvailable && <p className="next-action-calendar-note">Calendar data was unavailable; meeting conflicts were not checked.</p>}
          {result.calendarConnected && result.calendarAvailable && result.focusWindow && <p className="next-action-calendar-note">{result.focusWindow.nextEventStart
            ? `Free time ends at ${result.focusWindow.nextEventStart} for your next calendar event.`
            : "Calendar checked; no meeting conflicts fall within this focus window."}</p>}
          {result.explanation.reason && <div className="next-action-reason"><strong>Why this task · {result.explanationSource === "fallback" ? "template" : "AI explanation"}</strong><p>{result.explanation.reason}</p></div>}
          <div className="next-action-factors">
            <strong>Score factors</strong>
            {result.factors?.map((factor) => (
              <span key={factor.key}><b>{factor.points > 0 ? `+${factor.points}` : "0"}</b> {factor.evidence}</span>
            ))}
          </div>
          <div className="next-action-first-step"><strong>First step</strong><p>{result.explanation.firstStep}</p></div>
          {candidate.nextAction && <p className="next-action-recorded">Recorded next action: {candidate.nextAction}</p>}
          <div className="next-action-actions">
            <button type="button" className="next-action-rerun" onClick={() => void requestRecommendation()} disabled={disabled || loading || dismissing || completing}>
              {loading ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />} Recheck priorities
            </button>
            <button type="button" className="next-action-dismiss" onClick={() => void dismiss()} disabled={disabled || loading || dismissing || completing}>
              {dismissing ? <LoaderCircle size={12} className="spin" /> : <EyeOff size={12} />} Dismiss
            </button>
            <button type="button" className="next-action-complete" onClick={() => void complete()} disabled={disabled || loading || dismissing || completing}>
              {completing ? <LoaderCircle size={12} className="spin" /> : <CheckCheck size={12} />} Mark completed
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function AIRecommendationsPanel({
  disabled,
  googleConnected,
  refreshKey,
  onNotify,
}: {
  disabled: boolean;
  googleConnected: boolean;
  refreshKey: number;
  onNotify: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [runningId, setRunningId] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const automaticBatchKey = useRef<string | null>(null);
  const recommendations = useMemo<Recommendation[]>(() => [
    {
      id: "priorities",
      title: "Choose my next priority",
      description: "Rank pending tasks by urgency, deadline, and effort.",
      prompt: "Review my pending tasks and recommend the top three priorities for today. For each, give one practical next action and explain briefly why it belongs in that order. Do not invent deadlines or progress.",
      icon: Target,
      mode: "ask",
    },
    {
      id: "inbox",
      title: "Triage my unread inbox",
      description: "Find urgent asks and summarize what needs a reply.",
      prompt: "Review my unread Gmail messages and identify genuinely urgent requests, deadlines, and messages that need a reply. Summarize each briefly with sender and subject. Do not draft or send replies.",
      icon: Mail,
      mode: "secretary",
      disabled: !googleConnected,
    },
    {
      id: "calendar",
      title: "Prepare for my next meeting",
      description: "Review upcoming events and highlight useful preparation.",
      prompt: "Review my upcoming Google Calendar events and connected planner tasks. Tell me what meeting is next and suggest preparation based only on available event details and relevant pending tasks. Do not create or change calendar events.",
      icon: CalendarClock,
      mode: "secretary",
      disabled: !googleConnected,
    },
  ], [googleConnected]);

  const runRecommendation = useCallback(async (recommendation: Recommendation, notifyUser = true) => {
    setRunningId(recommendation.id);
    setErrors((current) => ({ ...current, [recommendation.id]: "" }));
    setResults((current) => ({ ...current, [recommendation.id]: "" }));
    if (notifyUser) onNotify(`Running: ${recommendation.title}…`, "info");
    try {
      const secretary = recommendation.mode === "secretary";
      const response = await fetch(secretary ? "/api/google/assistant" : "/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(secretary
          ? { question: recommendation.prompt }
          : { mode: "ask", question: recommendation.prompt }),
      });
      const result = await readApiResponse<{ answer?: string; error?: string }>(response);
      if (!response.ok || !result.answer) {
        throw new Error(result.error ?? "The assistant could not complete this recommendation.");
      }
      setResults((current) => ({ ...current, [recommendation.id]: result.answer! }));
      if (notifyUser) onNotify(`${recommendation.title} is ready.`);
      return true;
    } catch (error) {
      const message = apiErrorMessage(error, "The assistant could not complete this recommendation.");
      setErrors((current) => ({
        ...current,
        [recommendation.id]: message,
      }));
      if (notifyUser) onNotify(message, "error");
      return false;
    } finally {
      setRunningId("");
    }
  }, [onNotify]);

  useEffect(() => {
    if (disabled) return;
    const batchKey = String(refreshKey);
    if (automaticBatchKey.current === batchKey) return;
    automaticBatchKey.current = batchKey;
    void (async () => {
      let completed = 0;
      for (const recommendation of recommendations) {
        if (recommendation.disabled) continue;
        if (await runRecommendation(recommendation, false)) completed += 1;
      }
      if (completed > 0) onNotify(`AI recommendations updated (${completed}).`);
    })();
  }, [disabled, refreshKey, recommendations, runRecommendation, onNotify]);

  return (
    <section className="panel recommendations-panel" aria-labelledby="recommendations-title">
      <div className="insight-heading">
        <div>
          <span className="insight-eyebrow">AI-POWERED NEXT STEPS</span>
          <h2 id="recommendations-title">Recommendations</h2>
          <p>Available recommendations run automatically when the Dashboard opens and after each dashboard refresh. Google reviews run only when connected.</p>
        </div>
        <span className="insight-heading-icon recommendations-heading-icon"><Sparkles size={17} /></span>
      </div>
      <div className="recommendation-list">
        {recommendations.map((recommendation) => {
          const Icon = recommendation.icon;
          const unavailable = disabled || Boolean(recommendation.disabled);
          const busy = runningId === recommendation.id;
          return (
            <article className={`recommendation-card${results[recommendation.id] ? " has-result" : ""}`} key={recommendation.id}>
              <span className={`recommendation-icon recommendation-icon-${recommendation.id}`}><Icon size={16} /></span>
              <div className="recommendation-copy">
                <strong>{recommendation.title}</strong>
                <p>{recommendation.disabled && !googleConnected ? "Connect Google to enable this review." : recommendation.description}</p>
              </div>
              <button type="button" className="recommendation-run" onClick={() => void runRecommendation(recommendation)} disabled={unavailable || Boolean(runningId)}>
                {busy ? <><LoaderCircle size={13} className="spin" /> Working</> : results[recommendation.id] ? <><Check size={13} /> Run again</> : <>Run <ArrowUpRight size={13} /></>}
              </button>
              {errors[recommendation.id] && <p className="recommendation-feedback recommendation-error" role="alert">{errors[recommendation.id]}</p>}
              {results[recommendation.id] && <div className="recommendation-feedback recommendation-result" role="status" aria-live="polite">{results[recommendation.id]}</div>}
            </article>
          );
        })}
      </div>
      <p className="recommendations-footnote">Automatic runs use AI for each available card. Planner data is sent for task recommendations; Google data is sent only for Google-connected reviews. These recommendations never execute external actions.</p>
    </section>
  );
}
