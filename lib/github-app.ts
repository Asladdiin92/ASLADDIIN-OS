import "server-only";

import { createPrivateKey, createSign } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export type GitHubRepository = {
  fullName: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  url: string;
};
export type GitHubWorkItem = {
  number: number;
  title: string;
  state: string;
  url: string;
  user: string;
  updatedAt: string;
  reviews?: { approved: number; changesRequested: number };
  checks?: { total: number; failing: number; pending: number };
};
export type GitHubRepositorySnapshot = {
  repository: GitHubRepository;
  issues: GitHubWorkItem[];
  pullRequests: GitHubWorkItem[];
  branches: string[];
};
type GitHubResponseError = { message?: string; errors?: Array<{ message?: string }> };

export function isGitHubConfigured(): boolean {
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n").trim();
  if (!process.env.GITHUB_APP_ID?.trim() || !process.env.GITHUB_INSTALLATION_ID?.trim() || !privateKey) return false;
  try {
    return createPrivateKey(privateKey).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

function requiredConfig(): { appId: string; installationId: string; privateKey: string } {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const installationId = process.env.GITHUB_INSTALLATION_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n").trim();
  if (!appId || !installationId || !privateKey) {
    throw new Error("Set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY to connect the GitHub App.");
  }
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa") {
      throw new Error("unsupported key type");
    }
  } catch {
    throw new Error("Set GITHUB_PRIVATE_KEY to a valid GitHub App RSA private key.");
  }
  return { appId, installationId, privateKey };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 8 * 60, iss: appId })}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(message);
    return `${message}.${signer.sign(privateKey).toString("base64url")}`;
  } catch {
    throw new Error("GITHUB_PRIVATE_KEY must be a valid GitHub App RSA private key.");
  }
}

async function githubRequest<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("GitHub took too long to respond. Please try again.");
    }
    throw new Error("Could not connect to GitHub. Check your network and try again.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  let result: T;
  try {
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("GitHub returned a non-JSON response.");
    }
    result = await response.json() as T;
  } catch {
    throw new Error(`GitHub returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const details = result && typeof result === "object" ? result as GitHubResponseError : {};
    if (response.status === 429 || response.status === 403 && response.headers.has("x-ratelimit-remaining") &&
        response.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub API rate limit reached. Please try again later.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("GitHub rejected the App credentials or requested permission. Check the App installation and repository permissions.");
    }
    if (response.status === 404) throw new Error("That GitHub repository or item is not available to this App installation.");
    if (response.status === 422) throw new Error(details.errors?.[0]?.message ?? details.message ?? "GitHub rejected the proposed change.");
    throw new Error(details.message ?? `GitHub request failed (HTTP ${response.status}).`);
  }
  return result;
}

async function installationToken(): Promise<string> {
  const { appId, installationId, privateKey } = requiredConfig();
  const jwt = createAppJwt(appId, privateKey);
  const token = await githubRequest<{ token?: string }>(
    `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
    { method: "POST", body: JSON.stringify({}) },
  );
  if (!token.token) throw new Error("GitHub did not return an installation access token.");
  return token.token;
}

async function installedRepositories(token: string): Promise<GitHubRepository[]> {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubRequest<{
      repositories?: Array<{ full_name: string; name: string; default_branch: string; private: boolean; html_url: string }>;
      total_count?: number;
    }>(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, token);
    repositories.push(...(result.repositories ?? []).map((repository) => ({
      fullName: repository.full_name,
      name: repository.name,
      defaultBranch: repository.default_branch,
      private: repository.private,
      url: repository.html_url,
    })));
    if (repositories.length >= (result.total_count ?? 0)) return repositories;
  }
  throw new Error("This GitHub App installation has more than 1,000 repositories. Narrow the installation scope.");
}

export async function listGitHubRepositories(): Promise<GitHubRepository[]> {
  const token = await installationToken();
  return installedRepositories(token);
}

export async function getGitHubRepositorySnapshot(fullName: string): Promise<GitHubRepositorySnapshot> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("Choose a valid repository.");
  }
  const token = await installationToken();
  const repository = (await installedRepositories(token)).find((item) => item.fullName.toLowerCase() === fullName.toLowerCase());
  if (!repository) throw new Error("Select a repository that is installed for this GitHub App.");
  const encodedRepository = repository.fullName.split("/").map(encodeURIComponent).join("/");
  const [issueResults, pullResults, branchResults] = await Promise.all([
    githubRequest<Array<{ number: number; title: string; state: string; html_url: string; user?: { login?: string }; updated_at: string; pull_request?: unknown }>>(
      `${GITHUB_API}/repos/${encodedRepository}/issues?state=open&per_page=30&sort=updated&direction=desc`, token,
    ),
    githubRequest<Array<{ number: number; title: string; state: string; html_url: string; user?: { login?: string }; updated_at: string; head: { sha: string } }>>(
      `${GITHUB_API}/repos/${encodedRepository}/pulls?state=open&per_page=30&sort=updated&direction=desc`, token,
    ),
    githubRequest<Array<{ name: string }>>(`${GITHUB_API}/repos/${encodedRepository}/branches?per_page=100`, token),
  ]);
  const mapItem = (item: { number: number; title: string; state: string; html_url: string; user?: { login?: string }; updated_at: string }): GitHubWorkItem => ({
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.html_url,
    user: item.user?.login ?? "unknown",
    updatedAt: item.updated_at,
  });
  const pullRequests = await Promise.all(pullResults.map(async (pull, index) => {
    const workItem = mapItem(pull);
    if (index >= 10) return workItem;
    const [reviews, checks] = await Promise.all([
      githubRequest<Array<{ state: string; submitted_at?: string; user?: { login?: string } }>>(
        `${GITHUB_API}/repos/${encodedRepository}/pulls/${pull.number}/reviews?per_page=100`, token,
      ),
      githubRequest<{ total_count?: number; check_runs?: Array<{ status: string; conclusion: string | null }> }>(
        `${GITHUB_API}/repos/${encodedRepository}/commits/${encodeURIComponent(pull.head.sha)}/check-runs?per_page=100`, token,
      ),
    ]);
    const latestReviewByUser = new Map<string, { state: string; submittedAt: string }>();
    for (const review of reviews) {
      const state = review.state.toUpperCase();
      if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "COMMENTED" || state === "DISMISSED") {
        const reviewer = review.user?.login ?? "unknown";
        const submittedAt = review.submitted_at ?? "";
        if (submittedAt >= (latestReviewByUser.get(reviewer)?.submittedAt ?? "")) {
          latestReviewByUser.set(reviewer, { state, submittedAt });
        }
      }
    }
    const checkRuns = checks.check_runs ?? [];
    return {
      ...workItem,
      reviews: {
        approved: [...latestReviewByUser.values()].filter((review) => review.state === "APPROVED").length,
        changesRequested: [...latestReviewByUser.values()].filter((review) => review.state === "CHANGES_REQUESTED").length,
      },
      checks: {
        total: checks.total_count ?? checkRuns.length,
        failing: checkRuns.filter((check) => check.conclusion === "failure" || check.conclusion === "cancelled" || check.conclusion === "timed_out").length,
        pending: checkRuns.filter((check) => check.status !== "completed").length,
      },
    };
  }));
  return {
    repository,
    issues: issueResults.filter((item) => !item.pull_request).map(mapItem),
    pullRequests,
    branches: branchResults.map((branch) => branch.name),
  };
}

export async function performGitHubAction(
  action: "create_issue" | "comment_issue" | "comment_pull_request" | "create_pull_request",
  input: { repository: string; title?: string; body?: string; number?: number; head?: string; base?: string },
): Promise<{ url: string; title: string }> {
  const snapshot = await getGitHubRepositorySnapshot(input.repository);
  const encodedRepository = snapshot.repository.fullName.split("/").map(encodeURIComponent).join("/");
  const token = await installationToken();
  if (action === "create_issue") {
    const title = input.title?.trim();
    if (!title || title.length > 256 || (input.body?.length ?? 0) > 20_000) throw new Error("Enter an issue title (1–256 characters) and description (up to 20,000 characters).");
    const result = await githubRequest<{ html_url: string; title: string }>(
      `${GITHUB_API}/repos/${encodedRepository}/issues`, token,
      { method: "POST", body: JSON.stringify({ title, body: input.body ?? "" }) },
    );
    return { url: result.html_url, title: result.title };
  }
  if (action === "comment_issue" || action === "comment_pull_request") {
    if (!Number.isInteger(input.number) || (input.number ?? 0) < 1 || !input.body?.trim() || input.body.length > 20_000) {
      throw new Error("Choose a valid issue or pull request number and a comment up to 20,000 characters.");
    }
    const title = action === "comment_issue"
      ? snapshot.issues.find((item) => item.number === input.number)?.title
      : snapshot.pullRequests.find((item) => item.number === input.number)?.title;
    if (!title) throw new Error("The selected open issue or pull request is not available in this repository.");
    const result = await githubRequest<{ html_url?: string }>(
      `${GITHUB_API}/repos/${encodedRepository}/issues/${input.number}/comments`, token,
      { method: "POST", body: JSON.stringify({ body: input.body.trim() }) },
    );
    return {
      url: result.html_url ?? `https://github.com/${snapshot.repository.fullName}/issues/${input.number}`,
      title: `Comment added to ${title}`,
    };
  }

  const title = input.title?.trim();
  if (!title || title.length > 256 || (input.body?.length ?? 0) > 20_000 ||
      !input.head || !snapshot.branches.includes(input.head) ||
      !input.base || !snapshot.branches.includes(input.base) || input.head === input.base) {
    throw new Error("Choose a title, two existing different branches, and a description up to 20,000 characters.");
  }
  const result = await githubRequest<{ html_url: string; title: string }>(
    `${GITHUB_API}/repos/${encodedRepository}/pulls`, token,
    { method: "POST", body: JSON.stringify({ title, body: input.body ?? "", head: input.head, base: input.base }) },
  );
  return { url: result.html_url, title: result.title };
}
