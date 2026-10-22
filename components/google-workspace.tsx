"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, CalendarDays, Cloud, FileText, LoaderCircle, Mail, RefreshCw, Sparkles } from "lucide-react";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";
import { classifyGoogleMessage, formatGmailReceivedTime, maskGoogleEmail, sanitizeGmailSnippet, sanitizeProviderText } from "@/lib/google-gmail";
import {
  buildGoogleServiceHealth,
  classifyAcademicDocument,
  findCalendarConflicts,
  groupCalendarEvents,
  groupDriveFiles,
  groupUnreadMessages,
  googleWorkspaceViewState,
  safeGoogleExternalUrl,
  safeGmailMessageUrl,
  upcomingCalendarEvents,
} from "@/lib/google-workspace-insights";
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
  lastSyncedAt: string | null;
  onDisconnect: () => void;
  onOpenWorkspace: () => void;
};

type GoogleWorkspacePageProps = Pick<GoogleWorkspaceDataProps, "summary" | "loaded" | "loading" | "error" | "onRefresh"> & {
  onOpenIntegrations: () => void;
};

function displayDate(value: string): string {
  const safeValue = sanitizeProviderText(value, 100);
  if (!value.includes("T")) {
    const parsedDate = new Date(`${safeValue}T12:00:00Z`);
    return Number.isNaN(parsedDate.getTime())
      ? safeValue
      : formatPlannerDate(safeValue, { year: "numeric", month: "short", day: "numeric" });
  }
  const parsed = new Date(safeValue);
  return Number.isNaN(parsed.getTime()) ? safeValue : formatPlannerDate(safeValue, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function GoogleServiceError({ message }: { message: string | undefined }) {
  return message ? <p className="google-service-error" role="status">{message}</p> : null;
}

function formatRelativeTime(value: string | null): string {
  if (!value) return "Not synchronized yet";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Not synchronized yet";

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "just now";
  let name: string;
  let count: number;
  if (elapsedSeconds < 3600) {
    name = "minute";
    count = Math.floor(elapsedSeconds / 60);
  } else if (elapsedSeconds < 86_400) {
    name = "hour";
    count = Math.floor(elapsedSeconds / 3600);
  } else {
    name = "day";
    count = Math.floor(elapsedSeconds / 86_400);
  }
  return `${count} ${name}${count === 1 ? "" : "s"} ago`;
}

export function WorkspaceAttention({
  summary,
  loaded,
  loading,
  onOpenWorkspace,
}: Pick<GoogleWorkspaceDataProps, "summary" | "loaded" | "loading"> & { onOpenWorkspace: () => void }) {
  const today = todayInPlannerTimeZone();
  const todayEvents = summary.events.filter((event) => event.start && plannerDateKey(event.start) === today);
  const nextEvent = upcomingCalendarEvents(summary.events)[0];

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
            <div><Mail size={14} /><strong>{summary.errors?.gmail ? "—" : summary.unreadEmails}</strong><span>unread emails</span></div>
            <div><CalendarDays size={14} /><strong>{summary.errors?.calendar ? "—" : todayEvents.length}</strong><span>meetings today</span></div>
            <div><Cloud size={14} /><strong>{summary.errors?.drive ? "—" : summary.files.length}</strong><span>recent files</span></div>
          </div>
          {nextEvent && (
            <p className="workspace-attention-next">
              <span>Next listed event · direct Calendar data</span>
              <strong>{sanitizeProviderText(nextEvent.title, 200)}</strong>
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
  lastSyncedAt,
  onRefresh,
  onDisconnect,
  onOpenWorkspace,
}: GoogleConnectionCardProps) {
  const serviceHealth = buildGoogleServiceHealth(summary, loading, Boolean(error) && !Object.keys(summary.errors ?? {}).length);
  const serviceStatuses = [
    { key: "gmail", label: "Gmail" },
    { key: "calendar", label: "Calendar" },
    { key: "drive", label: "Drive" },
  ] as const;

  return (
    <section className="panel google-connection-card" aria-labelledby="google-connection-title">
      <div className="panel-heading">
        <div>
          <h2 id="google-connection-title"><Cloud size={15} /> Google Workspace</h2>
          <p>Connected account: {summary.connected ? maskGoogleEmail(summary.email) : "Not connected"}</p>
          <p>Last synchronized: {formatRelativeTime(lastSyncedAt)}</p>
        </div>
        {!loaded && loading && <span className="provider-status"><i />Checking connection</span>}
      </div>
      <ul className="google-service-statuses" aria-label="Google service status">
        {serviceStatuses.map(({ key, label }) => {
          const status = serviceHealth.statuses[key];
          return (
            <li key={key}>
              <span>{label}</span>
              <span className={`google-service-state is-${status.toLowerCase()}`}><i />{status}</span>
            </li>
          );
        })}
      </ul>
      <p className="google-connection-counts" aria-label="Google Workspace summary">
        {serviceHealth.counts.unread ?? "—"} unread
        <span aria-hidden="true"> • </span>
        {serviceHealth.counts.upcoming ?? "—"} upcoming
        <span aria-hidden="true"> • </span>
        {serviceHealth.counts.files ?? "—"} files
      </p>
      {error && !Object.keys(summary.errors ?? {}).length && (
        <p className="google-connection-health-note" role="alert">Google Workspace could not be refreshed. Check the service status above and try again.</p>
      )}
      <div className="google-connection-actions">
        {summary.connected ? (
          <>
            <button type="button" className="refresh-button" onClick={() => onRefresh(true)} disabled={loading}>
              {loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} Refresh
            </button>
            <a className="provider-secondary-button" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              Manage permissions
            </a>
            <button type="button" className="google-disconnect-button" onClick={onDisconnect}>Disconnect</button>
          </>
        ) : (
          <a className="google-connect-button" href="/api/google/connect">Connect Google</a>
        )}
        <button type="button" className="provider-secondary-button" onClick={onOpenWorkspace}>Open Google Workspace</button>
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

  const viewState = googleWorkspaceViewState({
    loaded,
    loading,
    summary,
  });
  const unreadGroups = groupUnreadMessages(summary.messages);
  const calendarGroups = groupCalendarEvents(summary.events);
  const calendarConflicts = new Set(findCalendarConflicts(summary.events).flat());
  const driveGroups = groupDriveFiles(summary.files);
  const calendarSections = [
    { label: "Today", events: calendarGroups.today },
    { label: "Tomorrow", events: calendarGroups.tomorrow },
    { label: "Next seven days", events: calendarGroups.nextSevenDays },
    { label: "Date unavailable", events: calendarGroups.undated },
  ].filter(({ events }) => events.length > 0);

  function renderMessage(message: GoogleWorkspaceSummary["messages"][number]) {
    const received = formatGmailReceivedTime(message.date);
    const sender = sanitizeProviderText(message.from || "Sender not returned", 200);
    const subject = sanitizeProviderText(message.subject, 240) || "(no subject)";
    const snippet = sanitizeGmailSnippet(message.snippet);
    const classifications = classifyGoogleMessage({ from: sender, subject, snippet });
    const receivedDate = new Date(message.date);
    const gmailUrl = safeGmailMessageUrl(message.id);
    return (
      <article className="workspace-message" key={message.id}>
        <div className="workspace-message-topline">
          <strong title={subject}>{subject}</strong>
          <time dateTime={Number.isNaN(receivedDate.getTime()) ? undefined : receivedDate.toISOString()} title={received.absolute} tabIndex={0}>{received.relative}</time>
        </div>
        <span title={sender}>{sender}</span>
        {snippet && <p>{snippet}</p>}
        <div className="workspace-message-meta">
          <span className="workspace-deterministic-label">Unread · Google query result</span>
          <div className="workspace-message-categories" aria-label="Local deterministic categories">
            {classifications.map(({ category, reason }) => (
              <span className="workspace-message-category" aria-label={`${category}: ${reason}`} title={reason} tabIndex={0} key={category}>{category}</span>
            ))}
          </div>
        </div>
        {gmailUrl && (
          <a className="workspace-open-gmail" href={gmailUrl} target="_blank" rel="noopener noreferrer">
            Open in Gmail <ArrowUpRight size={11} />
          </a>
        )}
      </article>
    );
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

      {viewState === "loading" && <div className="workspace-loading" role="status"><LoaderCircle size={15} className="spin" /> Loading live Google data…</div>}
      {error && <p className="google-workspace-error" role="alert">{error}</p>}
      {loaded && viewState === "disconnected" && (
        <section className="panel workspace-connect-empty">
          <Cloud size={22} />
          <h3>Connect Google Workspace</h3>
          <p>Authorize Google to view the Gmail, Calendar, and Drive data available to this app.</p>
          <a className="google-connect-button" href="/api/google/connect">Connect Google</a>
        </section>
      )}
      {(viewState === "connected" || viewState === "empty") && (
        <>
          <div className="workspace-data-grid">
            <section className="panel workspace-data-panel" aria-labelledby="workspace-gmail-title">
              <div className="workspace-data-heading">
                <div><span className="workspace-data-icon"><Mail size={15} /></span><div><h3 id="workspace-gmail-title">Unread Gmail</h3><p>Total unread: {summary.errors?.gmail ? "Unavailable" : summary.unreadEmails} · showing {summary.errors?.gmail ? "—" : summary.messages.length} recent messages</p></div></div>
                <span className="workspace-source-label">DIRECT GOOGLE DATA</span>
              </div>
              <p className="workspace-gmail-classification-note">
                Local categories use visible sender, subject, and snippet wording. “Possible reply” and “Needs attention” require explicit matched phrases; neither indicates a requirement.
              </p>
              <GoogleServiceError message={summary.errors?.gmail} />
              {!summary.errors?.gmail && summary.messages.length === 0
                ? <p className="workspace-data-empty">No recent unread messages were returned by Google.</p>
                : <div className="workspace-message-list">
                  {unreadGroups.recent.length > 0 && <>
                    {unreadGroups.older.length > 0 && <h4 className="workspace-subgroup-heading">Recent unread</h4>}
                    {unreadGroups.recent.map(renderMessage)}
                  </>}
                  {unreadGroups.older.length > 0 && <>
                    <h4 className="workspace-subgroup-heading" title="Messages received more than seven days ago">Older unread · over 7 days</h4>
                    {unreadGroups.older.map(renderMessage)}
                  </>}
                  {unreadGroups.undated.map(renderMessage)}
                </div>}
            </section>

            <section className="panel workspace-data-panel" aria-labelledby="workspace-calendar-title">
              <div className="workspace-data-heading">
                <div><span className="workspace-data-icon"><CalendarDays size={15} /></span><div><h3 id="workspace-calendar-title">Upcoming Calendar</h3><p>{summary.errors?.calendar ? "Upcoming events: unavailable" : `${upcomingCalendarEvents(summary.events).length} upcoming events · next seven days`}</p></div></div>
                <span className="workspace-source-label">DIRECT GOOGLE DATA</span>
              </div>
              <GoogleServiceError message={summary.errors?.calendar} />
              {!summary.errors?.calendar && summary.events.length === 0
                ? <p className="workspace-data-empty">No upcoming events were returned by Google.</p>
                : <div className="workspace-event-list">{calendarSections.map(({ label, events }) => (
                  <section className="workspace-calendar-group" key={label} aria-label={label}>
                    <h4 className="workspace-subgroup-heading">{label}</h4>
                    {events.map((event) => {
                      const isAllDay = Boolean(event.start && !event.start.includes("T"));
                      const link = safeGoogleExternalUrl(event.link, ["www.google.com", "calendar.google.com"]);
                      const title = sanitizeProviderText(event.title, 240) || "(untitled event)";
                      const content = <><time>{isAllDay ? `${displayDate(event.start)} · All day` : event.start ? displayDate(event.start) : "Time unavailable"}</time><strong>{title}</strong>{event.end && !isAllDay && <span>Ends {displayDate(event.end)}</span>}{calendarConflicts.has(event.id) && <span className="workspace-conflict-label" title="This event overlaps another returned Calendar event." tabIndex={0}>Time conflict · overlaps another event</span>}</>;
                      return link
                        ? <a className="workspace-event" href={link} target="_blank" rel="noopener noreferrer" title={title} key={event.id}>{content}</a>
                        : <article className="workspace-event" title={title} tabIndex={0} key={event.id}>{content}</article>;
                    })}
                  </section>
                ))}</div>}
            </section>

            <section className="panel workspace-data-panel" aria-labelledby="workspace-drive-title">
              <div className="workspace-data-heading">
                <div><span className="workspace-data-icon"><FileText size={15} /></span><div><h3 id="workspace-drive-title">Recent Drive files</h3><p>{summary.errors?.drive ? "Recent files: unavailable" : `${summary.files.length} latest files returned by Google`}</p></div></div>
                <span className="workspace-source-label">DIRECT GOOGLE DATA</span>
              </div>
              <GoogleServiceError message={summary.errors?.drive} />
              {!summary.errors?.drive && summary.files.length === 0
                ? <p className="workspace-data-empty">No recent files were returned by Google.</p>
                : <div className="workspace-file-list">{Object.entries(driveGroups).map(([group, files]) => files.length > 0 && (
                  <section className="workspace-drive-group" key={group} aria-label={`${group} files`}>
                    <h4 className="workspace-subgroup-heading">{group} · {files.length}</h4>
                    {files.map((file) => {
                      const link = safeGoogleExternalUrl(file.link, ["drive.google.com", "docs.google.com"]);
                      const fileName = sanitizeProviderText(file.name, 240) || "Unnamed file";
                      const mimeType = sanitizeProviderText(file.mimeType, 100);
                      const academic = classifyAcademicDocument(file);
                      const content = <><FileText size={14} /><span><strong>{fileName}</strong><small>{mimeType}{file.modifiedTime ? ` · Modified ${displayDate(file.modifiedTime)}` : ""}</small>{academic.academic && <small className="workspace-academic-label" title={academic.reason} tabIndex={0}>Academic document · deterministic name match</small>}</span></>;
                      return link
                        ? <a className="workspace-file" href={link} target="_blank" rel="noopener noreferrer" title={fileName} key={file.id}>{content}</a>
                        : <article className="workspace-file" title={fileName} tabIndex={0} key={file.id}>{content}</article>;
                    })}
                  </section>
                ))}</div>}
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
