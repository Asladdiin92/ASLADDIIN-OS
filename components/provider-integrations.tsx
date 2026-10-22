"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ExternalLink, Github, LoaderCircle, MessageCircle, RefreshCw, ShieldCheck } from "lucide-react";

type Repository = { fullName: string; defaultBranch: string; private: boolean };
type WorkItem = { number: number; title: string; url: string; user: string; updatedAt: string; reviews?: { approved: number; changesRequested: number }; checks?: { total: number; failing: number; pending: number } };
type Snapshot = { repository: Repository; issues: WorkItem[]; pullRequests: WorkItem[]; branches: string[] };
type TelegramStatus = { configured: boolean; linked: boolean; botUsername?: string; error?: string };
type GitHubAction = "create_issue" | "comment_issue" | "comment_pull_request" | "create_pull_request";
type Proposal = { approvalId: string; actionName: string; repository: string; expiresInSeconds: number };

async function readResponse<T>(response: Response): Promise<T & { error?: string }> {
  let result: T & { error?: string };
  try {
    result = await response.json() as T & { error?: string };
  } catch {
    throw new Error(`The server returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(result.error ?? `The request failed (HTTP ${response.status}).`);
  return result;
}

export function ProviderIntegrations() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repository, setRepository] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedAction, setSelectedAction] = useState<GitHubAction>("create_issue");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [number, setNumber] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [actionResult, setActionResult] = useState<{ title: string; url: string } | null>(null);
  const [githubError, setGithubError] = useState("");
  const [githubLoading, setGithubLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [telegramError, setTelegramError] = useState("");
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [botUrl, setBotUrl] = useState("");
  const [telegramNotice, setTelegramNotice] = useState("");

  const loadRepositories = useCallback(async () => {
    setGithubLoading(true);
    setGithubError("");
    try {
      const response = await fetch("/api/github", { cache: "no-store" });
      const result = await readResponse<{ configured?: boolean; repositories: Repository[] }>(response);
      if (result.configured === false) {
        setRepositories([]);
        setGithubError("GitHub App is not configured.");
        return;
      }
      setRepositories(result.repositories);
      if (repository && !result.repositories.some((item) => item.fullName === repository)) {
        setRepository("");
        setSnapshot(null);
      }
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Could not load GitHub repositories.");
    } finally {
      setGithubLoading(false);
    }
  }, [repository]);

  const loadTelegramStatus = useCallback(async () => {
    setTelegramError("");
    try {
      const response = await fetch("/api/telegram/link", { cache: "no-store" });
      const result = await readResponse<TelegramStatus>(response);
      setTelegram(result);
    } catch (error) {
      setTelegram({ configured: false, linked: false });
      setTelegramError(error instanceof Error ? error.message : "Could not load Telegram status.");
    }
  }, []);

  useEffect(() => {
    void loadRepositories();
    void loadTelegramStatus();
  }, [loadRepositories, loadTelegramStatus]);

  useEffect(() => {
    if (!repository) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    setGithubLoading(true);
    setGithubError("");
    void fetch(`/api/github?repository=${encodeURIComponent(repository)}`, { cache: "no-store" })
      .then((response) => readResponse<{ configured?: boolean; snapshot: Snapshot | null }>(response))
      .then((result) => {
        if (!cancelled) {
          setSnapshot(result.snapshot);
          if (result.configured === false) setGithubError("GitHub App is not configured.");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setGithubError(error instanceof Error ? error.message : "Could not load this repository.");
      })
      .finally(() => { if (!cancelled) setGithubLoading(false); });
    return () => { cancelled = true; };
  }, [repository]);

  async function proposeAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository) return;
    setActionLoading(true);
    setGithubError("");
    setActionResult(null);
    try {
      const response = await fetch("/api/github/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "propose",
          action: selectedAction,
          repository,
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          ...(number ? { number: Number(number) } : {}),
          ...(head ? { head } : {}),
          ...(base ? { base } : {}),
        }),
      });
      setProposal(await readResponse<Proposal>(response));
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "Could not prepare the GitHub action.");
    } finally {
      setActionLoading(false);
    }
  }

  async function confirmAction() {
    if (!proposal) return;
    setActionLoading(true);
    setGithubError("");
    try {
      const response = await fetch("/api/github/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "confirm", approvalId: proposal.approvalId }),
      });
      const result = await readResponse<{ title: string; url: string }>(response);
      setProposal(null);
      setActionResult(result);
      setTitle("");
      setBody("");
      setNumber("");
      setHead("");
      setBase("");
      setGithubError("");
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : "The GitHub action could not be completed.");
      setProposal(null);
    } finally {
      setActionLoading(false);
    }
  }

  async function startTelegramLink() {
    setTelegramLoading(true);
    setTelegramError("");
    setTelegramNotice("");
    setBotUrl("");
    try {
      const response = await fetch("/api/telegram/link", { method: "POST" });
      const result = await readResponse<{ botUrl: string }>(response);
      setBotUrl(result.botUrl);
      setTelegramNotice("One-time pairing link created; it expires in 10 minutes.");
    } catch (error) {
      setTelegramError(error instanceof Error ? error.message : "Could not start Telegram linking.");
    } finally {
      setTelegramLoading(false);
    }
  }

  async function configureTelegram() {
    setTelegramLoading(true);
    setTelegramError("");
    setTelegramNotice("");
    try {
      await readResponse(await fetch("/api/telegram/setup", { method: "POST" }));
      setTelegramNotice("Telegram webhook and bot commands are configured.");
    } catch (error) {
      setTelegramError(error instanceof Error ? error.message : "Could not configure the Telegram webhook.");
    } finally {
      setTelegramLoading(false);
    }
  }

  async function unlinkTelegram() {
    setTelegramLoading(true);
    setTelegramError("");
    setTelegramNotice("");
    try {
      await readResponse(await fetch("/api/telegram/link", { method: "DELETE" }));
      setBotUrl("");
      setTelegramNotice("Telegram account unlinked.");
      await loadTelegramStatus();
    } catch (error) {
      setTelegramError(error instanceof Error ? error.message : "Could not unlink Telegram.");
    } finally {
      setTelegramLoading(false);
    }
  }

  const actionLabel = selectedAction === "create_issue" ? "Create issue"
    : selectedAction === "comment_issue" ? "Comment on issue"
      : selectedAction === "comment_pull_request" ? "Comment on pull request" : "Create pull request";

  return (
    <section className="provider-integrations-grid" aria-label="Provider integrations">
      <article className="panel provider-panel">
        <div className="panel-heading">
          <div><h2><Github size={15} /> GitHub</h2><p>Browse installed repositories and review changes before confirming them.</p></div>
          <button type="button" className="refresh-button" onClick={() => void loadRepositories()} disabled={githubLoading} aria-label="Refresh GitHub repositories">
            {githubLoading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
        {githubError && <p className="provider-error" role="alert">{githubError}</p>}
        {actionResult && <p className="provider-success" role="status">{actionResult.title} completed. <a href={actionResult.url} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={11} /></a></p>}
        <label className="provider-field">Installed repository
          <select value={repository} onChange={(event) => { setRepository(event.target.value); setProposal(null); }} disabled={!repositories.length || Boolean(proposal)}>
            <option value="">{repositories.length ? "Choose a repository" : "No repositories available"}</option>
            {repositories.map((item) => <option key={item.fullName} value={item.fullName}>{item.fullName}{item.private ? " · private" : ""}</option>)}
          </select>
        </label>
        {snapshot && <div className="provider-repo-data">
          <div className="provider-counts"><span><strong>{snapshot.issues.length}</strong> open issues</span><span><strong>{snapshot.pullRequests.length}</strong> open PRs</span></div>
          <div className="provider-list">
            {snapshot.issues.slice(0, 5).map((item) => <a key={`issue-${item.number}`} href={item.url} target="_blank" rel="noreferrer"><span>#{item.number} {item.title}</span><ExternalLink size={11} /></a>)}
            {snapshot.pullRequests.slice(0, 5).map((item) => <a key={`pr-${item.number}`} href={item.url} target="_blank" rel="noreferrer"><span>PR #{item.number} {item.title}{item.reviews && item.checks ? ` · ${item.reviews.approved} approved · ${item.reviews.changesRequested} changes · checks ${item.checks.failing ? `${item.checks.failing} failing` : item.checks.pending ? "pending" : `${item.checks.total} clear`}` : ""}</span><ExternalLink size={11} /></a>)}
            {!snapshot.issues.length && !snapshot.pullRequests.length && <p>No open issues or pull requests found.</p>}
          </div>
          <form className="provider-action-form" onSubmit={(event) => void proposeAction(event)}>
            <label className="provider-field">Action
              <select value={selectedAction} onChange={(event) => { setSelectedAction(event.target.value as GitHubAction); setProposal(null); }} disabled={Boolean(proposal)}>
                <option value="create_issue">Create issue</option><option value="comment_issue">Comment on issue</option>
                <option value="comment_pull_request">Comment on pull request</option><option value="create_pull_request">Create pull request</option>
              </select>
            </label>
            {(selectedAction === "create_issue" || selectedAction === "create_pull_request") && <label className="provider-field">Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={256} required disabled={Boolean(proposal)} /></label>}
            {(selectedAction === "comment_issue" || selectedAction === "comment_pull_request") && <label className="provider-field">Item number<input type="number" min="1" step="1" value={number} onChange={(event) => setNumber(event.target.value)} required disabled={Boolean(proposal)} /></label>}
            {selectedAction === "create_pull_request" && <div className="provider-branch-fields">
              <label className="provider-field">Head branch<select value={head} onChange={(event) => setHead(event.target.value)} required disabled={Boolean(proposal)}><option value="">Choose branch</option>{snapshot.branches.map((branch) => <option key={branch}>{branch}</option>)}</select></label>
              <label className="provider-field">Base branch<select value={base} onChange={(event) => setBase(event.target.value)} required disabled={Boolean(proposal)}><option value="">Choose branch</option>{snapshot.branches.map((branch) => <option key={branch}>{branch}</option>)}</select></label>
            </div>}
            <label className="provider-field">{selectedAction.includes("comment") ? "Comment" : "Description"}<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={20_000} rows={3} disabled={Boolean(proposal)} /></label>
            {proposal ? <div className="provider-approval" role="status">
              <div className="provider-preview">
                <p><ShieldCheck size={14} /> Review: <strong>{proposal.actionName}</strong> in <strong>{proposal.repository}</strong>. This approval expires in 10 minutes.</p>
                {(selectedAction === "create_issue" || selectedAction === "create_pull_request") && <p><strong>Title:</strong> {title}</p>}
                {(selectedAction === "comment_issue" || selectedAction === "comment_pull_request") && <p><strong>Target:</strong> #{number}</p>}
                {selectedAction === "create_pull_request" && <p><strong>Branches:</strong> {head} → {base}</p>}
                {body && <pre>{body}</pre>}
              </div>
              <button type="button" className="provider-primary-button" onClick={() => void confirmAction()} disabled={actionLoading}>{actionLoading ? "Working..." : "Confirm GitHub action"}</button>
              <button type="button" className="provider-secondary-button" onClick={() => setProposal(null)} disabled={actionLoading}>Cancel</button>
            </div> : <button className="provider-primary-button" type="submit" disabled={actionLoading}>{actionLoading ? "Preparing review..." : `Review ${actionLabel.toLowerCase()}`}</button>}
            {!proposal && <p className="provider-note">No GitHub write occurs until you review and confirm the action. PR creation uses existing branches; the app never pushes code or merges PRs.</p>}
          </form>
        </div>}
      </article>

      <article className="panel provider-panel">
        <div className="panel-heading">
          <div><h2><MessageCircle size={15} /> Telegram</h2><p>Link your private chat for planner commands and counts-only refresh updates.</p></div>
          <span className={`provider-status${telegram?.linked ? " is-connected" : ""}`}><i />{telegram?.linked ? "Linked" : telegram?.configured ? "Not linked" : "Setup needed"}</span>
        </div>
        {telegramError && <p className="provider-error" role="alert">{telegramError}</p>}
        {telegramNotice && <p className="provider-success" role="status">{telegramNotice}</p>}
        {telegram?.error && <p className="provider-note">{telegram.error}</p>}
        <div className="provider-telegram-actions">
          {!telegram?.linked && <button type="button" className="provider-primary-button" onClick={() => void startTelegramLink()} disabled={telegramLoading}>{telegramLoading ? "Preparing link..." : "Generate one-time account link"}</button>}
          {botUrl && <a className="provider-secondary-button" href={botUrl} target="_blank" rel="noreferrer">Open Telegram to link <ExternalLink size={12} /></a>}
          <button type="button" className="provider-secondary-button" onClick={() => void configureTelegram()} disabled={telegramLoading}>Configure bot webhook</button>
          {telegram?.linked && <button type="button" className="provider-secondary-button" onClick={() => void unlinkTelegram()} disabled={telegramLoading}>Unlink Telegram account</button>}
        </div>
        <div className="provider-telegram-safety">
          <strong>Approval and privacy</strong>
          <p>Telegram can read planner counts and incomplete task summaries. Creating or editing a Notion task requires your confirmation in Telegram. Dashboard refresh messages contain counts only—never task titles, notes, email, or calendar details.</p>
          <p>Pairing links expire in 10 minutes. Configure the webhook after deploying the HTTPS app endpoint.</p>
        </div>
      </article>
    </section>
  );
}
