"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, CalendarDays, Cloud, FileText, LoaderCircle, Mail, RefreshCw, Sparkles } from "lucide-react";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";
import { formatPlannerDate, plannerDateKey, todayInPlannerTimeZone } from "@/lib/planner-datetime";
import type { GoogleWorkspaceSummary } from "@/lib/google-types";

type GoogleWorkspaceDataProps = {
  summary: GoogleWorkspaceSummary;
  loaded: boolean;
  loading: boolean;
  error: string;
  onRefresh: (showToast?: boolean) => void;
};

type GoogleConnectionCardProps = GoogleWorkspaceDataProps & {
  onDisconnect: () => void;
  onOpenWorkspace: () => void;
};

type GoogleWorkspacePageProps = Pick<GoogleWorkspaceDataProps, "summary" | "loaded" | "loading" | "error" | "onRefresh"> & {
  onOpenIntegrations: () => void;
};

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function displayDate(value: string): string {
  if (!value.includes("T")) {
    const parsedDate = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(parsedDate.getTime())
      ? value
      : formatPlannerDate(value, { year: "numeric", month: "short", day: "numeric" });
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatPlannerDate(value, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function GoogleServiceError({ message }: { message: string | undefined }) {
  return message ? <p className="google-service-error" role="status">{message}</p> : null;
}

export function WorkspaceAttention({
  summary,
  loaded,
  loading,
  onOpenWorkspace,
}: Pick<GoogleWorkspaceDataProps, "summary" | "loaded" | "loading"> & { onOpenWorkspace: () => void }) {
  const today = todayInPlannerTimeZone();
  const todayEvents = summary.events.filter((event) => event.start && plannerDateKey(event.start) === today);
  const nextEvent = summary.events
    .filter((event) => event.start)
    .slice()
    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime())[0];

  return (
    <section className="panel workspace-attention-panel" aria-labelledby="workspace-attention-title">
      <div className="panel-heading">
        <div>
          <span className="insight-eyebrow">GOOGLE WORKSPACE · DIRECT DATA</span>
          <h2 id="workspace-attention-title">Workspace attention</h2>
          <p>Live unread mail, upcoming meetings, and recent Drive activity.</p>
        </div>
        <button type="button" className="refresh-button" onClick={onOpenWorkspace}>
          Open Workspace <ArrowUpRight size={12} />
        </button>
      </div>
      {!loaded && loading ? (
        <p className="workspace-attention-empty" role="status"><LoaderCircle size={13} className="spin" /> Checking Google Workspace…</p>
      ) : !summary.connected ? (
        <div className="workspace-attention-empty">
          <span>Google Workspace is not connected.</span>
          <button type="button" onClick={onOpenWorkspace}>Manage connection</button>
        </div>
      ) : (
        <>
          <div className="workspace-attention-metrics">
            <div><Mail size={14} /><strong>{summary.unreadEmails}</strong><span>unread emails</span></div>
            <div><CalendarDays size={14} /><strong>{todayEvents.length}</strong><span>meetings today</span></div>
            <div><Cloud size={14} /><strong>{summary.files.length}</strong><span>recent files</span></div>
          </div>
          {nextEvent && (
            <p className="workspace-attention-next">
              <span>Next listed event · direct Calendar data</span>
              <strong>{nextEvent.title}</strong>
              <time>{displayDate(nextEvent.start)}</time>
            </p>
          )}
          {summary.errors && Object.keys(summary.errors).length > 0 && (
            <p className="workspace-attention-warning" role="status">
              Some Google data is unavailable. Open Workspace for service details.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function GoogleConnectionCard({
  summary,
  loaded,
  loading,
  error,
  onRefresh,
  onDisconnect,
  onOpenWorkspace,
}: GoogleConnectionCardProps) {
  const failedServices = Object.keys(summary.errors ?? {});
  const status = !loaded && loading
    ? "Checking connection"
    : !summary.connected
      ? "Not connected"
      : failedServices.length
        ? "Partially available"
        : "Connected";

  return (
    <section className="panel google-connection-card" aria-labelledby="google-connection-title">
      <div className="panel-heading">
        <div>
          <h2 id="google-connection-title"><Cloud size={15} /> Google Workspace</h2>
          <p>{summary.connected ? `Connected${summary.email ? ` as ${summary.email}` : ""}` : "Connect Google to use Workspace features."}</p>
        </div>
        <span className={`provider-status${summary.connected && !failedServices.length ? " is-connected" : ""}`}>
          <i />{status}
        </span>
      </div>
      {error && <p className="google-workspace-error" role="alert">{error}</p>}
      {failedServices.length > 0 && (
        <p className="google-connection-health-note" role="status">
          {failedServices.map((service) => `${service[0].toUpperCase()}${service.slice(1)}`).join(", ")} data could not be loaded.
        </p>
      )}
      <div className="google-connection-actions">
        {summary.connected ? (
          <>
            <button type="button" className="refresh-button" onClick={() => onRefresh(true)} disabled={loading}>
              {loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} Check connection
            </button>
            <button type="button" className="google-disconnect-button" onClick={onDisconnect}>Disconnect</button>
            <button type="button" className="provider-secondary-button" onClick={onOpenWorkspace}>Open Workspace</button>
          </>
        ) : (
          <>
            <a className="google-connect-button" href="/api/google/connect">Connect Google</a>
            <button type="button" className="provider-secondary-button" onClick={onOpenWorkspace}>Workspace details</button>
          </>
        )}
      </div>
    </section>
  );
}

export function GoogleWorkspacePage({
  summary,
  loaded,
  loading,
  error,
  onRefresh,
  onOpenIntegrations,
}: GoogleWorkspacePageProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [assistantError, setAssistantError] = useState("");
  const [asking, setAsking] = useState(false);

  async function askAssistant(nextQuestion: string) {
    setQuestion(nextQuestion);
    setAnswer("");
    setAssistantError("");
    setAsking(true);
    try {
      const response = await fetch("/api/google/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: nextQuestion }),
        cache: "no-store",
        signal: AbortSignal.timeout(65_000),
      });
      const result = await readApiResponse<{ answer?: string; error?: string }>(response);
      if (!response.ok || !result.answer) {
        throw new Error(result.error ?? "The Workspace assistant could not answer.");
      }
      setAnswer(result.answer);
    } catch (requestError) {
      setAssistantError(apiErrorMessage(requestError, "The Workspace assistant could not answer."));
    } finally {
      setAsking(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (question.trim()) void askAssistant(question.trim());
  }

  return (
    <div className="google-workspace-page">
      <div className="section-heading">
        <div>
          <span className="insight-eyebrow">CONNECTED GOOGLE DATA</span>
          <h2>Google Workspace</h2>
          <p>Review live Gmail, Calendar, and Drive data, then ask for an explicitly AI-generated observation.</p>
        </div>
        <div className="google-workspace-actions">
          {summary.connected && (
            <button type="button" className="refresh-button" onClick={() => onRefresh(true)} disabled={loading}>
              {loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} Refresh data
            </button>
          )}
          <button type="button" className="refresh-button" onClick={onOpenIntegrations}>Connection settings</button>
        </div>
      </div>

      {!loaded && loading && <div className="workspace-loading" role="status"><LoaderCircle size={15} className="spin" /> Loading live Google data…</div>}
      {error && <p className="google-workspace-error" role="alert">{error}</p>}
      {loaded && !summary.connected && (
        <section className="panel workspace-connect-empty">
          <Cloud size={22} />
          <h3>Connect Google Workspace</h3>
          <p>Authorize Google to view the Gmail, Calendar, and Drive data available to this app.</p>
          <a className="google-connect-button" href="/api/google/connect">Connect Google</a>
        </section>
      )}
      {summary.connected && (
        <>
          <div className="workspace-data-grid">
            <section className="panel workspace-data-panel" aria-labelledby="workspace-gmail-title">
              <div className="workspace-data-heading">
                <div><span className="workspace-data-icon"><Mail size={15} /></span><div><h3 id="workspace-gmail-title">Unread Gmail</h3><p>{summary.unreadEmails} unread · showing up to {summary.messages.length} returned messages</p></div></div>
                <span className="workspace-source-label">DIRECT GOOGLE DATA</span>
              </div>
              <GoogleServiceError message={summary.errors?.gmail} />
              {!summary.errors?.gmail && summary.messages.length === 0
                ? <p className="workspace-data-empty">No unread messages were returned by Google.</p>
                : <div className="workspace-message-list">{summary.messages.map((message) => (
                  <article className="workspace-message" key={message.id}>
                    <div className="workspace-message-topline"><strong>{message.subject}</strong><time>{message.date}</time></div>
                    <span>{message.from || "Sender not returned"}</span>
                    {message.snippet && <p>{message.snippet}</p>}
                    <span className="workspace-deterministic-label">Unread · Google query result</span>
                  </article>
                ))}</div>}
            </section>

            <section className="panel workspace-data-panel" aria-labelledby="workspace-calendar-title">
              <div className="workspace-data-heading">
                <div><span className="workspace-data-icon"><CalendarDays size={15} /></span><div><h3 id="workspace-calendar-title">Upcoming Calendar</h3><p>Events returned for the next seven days</p></div></div>
                <span className="workspace-source-label">DIRECT GOOGLE DATA</span>
              </div>
              <GoogleServiceError message={summary.errors?.calendar} />
              {!summary.errors?.calendar && summary.events.length === 0
                ? <p className="workspace-data-empty">No upcoming events were returned by Google.</p>
                : <div className="workspace-event-list">{summary.events.map((event) => {
                  const link = safeExternalUrl(event.link);
                  const content = <><time>{event.start ? displayDate(event.start) : "Time unavailable"}</time><strong>{event.title}</strong>{event.end && <span>Ends {displayDate(event.end)}</span>}</>;
                  return link
                    ? <a className="workspace-event" href={link} target="_blank" rel="noreferrer" key={event.id}>{content}</a>
                    : <article className="workspace-event" key={event.id}>{content}</article>;
                })}</div>}
            </section>

            <section className="panel workspace-data-panel" aria-labelledby="workspace-drive-title">
              <div className="workspace-data-heading">
                <div><span className="workspace-data-icon"><FileText size={15} /></span><div><h3 id="workspace-drive-title">Recent Drive files</h3><p>{summary.files.length} latest files returned by Google</p></div></div>
                <span className="workspace-source-label">DIRECT GOOGLE DATA</span>
              </div>
              <GoogleServiceError message={summary.errors?.drive} />
              {!summary.errors?.drive && summary.files.length === 0
                ? <p className="workspace-data-empty">No recent files were returned by Google.</p>
                : <div className="workspace-file-list">{summary.files.map((file) => {
                  const link = safeExternalUrl(file.link);
                  const content = <><FileText size={14} /><span><strong>{file.name}</strong><small>{file.mimeType}{file.modifiedTime ? ` · Modified ${displayDate(file.modifiedTime)}` : ""}</small></span></>;
                  return link
                    ? <a className="workspace-file" href={link} target="_blank" rel="noreferrer" key={file.id}>{content}</a>
                    : <article className="workspace-file" key={file.id}>{content}</article>;
                })}</div>}
            </section>
          </div>

          <section className="panel workspace-ai-panel" aria-labelledby="workspace-ai-title">
            <div className="workspace-ai-heading">
              <div><span className="insight-eyebrow">GENERATED ONLY WHEN YOU ASK</span><h3 id="workspace-ai-title"><Sparkles size={15} /> Workspace AI insights</h3><p>AI observations may interpret connected Google content and your planner tasks. They are not direct provider data.</p></div>
            </div>
            <div className="workspace-ai-prompts">
              <button type="button" onClick={() => void askAssistant("Review my unread Gmail messages and identify urgent requests or items that appear to need a reply. Explain which observations are inferred, and do not draft or send replies.")} disabled={asking || !loaded || !summary.connected}>
                <Mail size={13} /> Review unread mail
              </button>
              <button type="button" onClick={() => void askAssistant("Review my upcoming Google Calendar events and connected planner tasks. Identify the next event and suggest preparation based only on the available details. Do not create or change events.")} disabled={asking || !loaded || !summary.connected}>
                <CalendarDays size={13} /> Prepare for meetings
              </button>
              <button type="button" onClick={() => void askAssistant("Summarize the recent Google Drive files returned to you and suggest a relevant next step only when supported by the provided file metadata and planner tasks. State what is unavailable.")} disabled={asking || !loaded || !summary.connected}>
                <Cloud size={13} /> Review recent files
              </button>
            </div>
            <form className="workspace-ai-form" onSubmit={submitQuestion}>
              <label htmlFor="workspace-ai-question">Ask about your workspace</label>
              <div><input id="workspace-ai-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} placeholder="e.g. What should I prepare for next?" disabled={asking} />
                <button type="submit" disabled={asking || !loaded || !summary.connected || !question.trim()}>{asking ? <><LoaderCircle size={13} className="spin" /> Thinking…</> : <><Sparkles size={13} /> Ask AI</>}</button></div>
            </form>
            {assistantError && <p className="google-workspace-error" role="alert">{assistantError}</p>}
            {asking && <p className="workspace-ai-loading" role="status"><LoaderCircle size={13} className="spin" /> Generating an AI observation…</p>}
            {answer && <article className="workspace-ai-answer" aria-live="polite"><span>AI-GENERATED OBSERVATION</span><p>{answer}</p></article>}
            <p className="workspace-ai-disclosure">Choosing an AI action sends a limited Google snapshot and planner context to the configured AI provider. Nothing is sent automatically from this page.</p>
          </section>
        </>
      )}
    </div>
  );
}
