# Connect Google, GitHub, Telegram, and Other APIs

This guide explains how external services connect to this app, where their
credentials belong, and what is already implemented.

## Integration status

| Service | Status in this repository | What it does |
| --- | --- | --- |
| Notion | Implemented | Source of truth for planner tasks and notes. Server routes read and update the configured database. |
| MongoDB Atlas | Implemented | Stores AI skills and integration state outside Notion; AI storage defaults to the configured MongoDB database. |
| Google | Implemented | User-authorized Gmail, Calendar, and Drive access. Google data is loaded on demand; the assistant only uses it after an explicit request. |
| Gemini | Implemented | Server-side AI provider for planner suggestions and other assistant actions. |
| Tavily | Implemented | Server-side web search for the research assistant. |
| GitHub | Implemented | GitHub App installation, repository/issue/PR browsing, review/check summaries, and approval-gated issue/comment/PR creation. |
| Telegram | Implemented | Account linking, read-only planner commands, approval-gated Notion task create/edit, and optional counts-only dashboard refresh messages. |

## ASLADIN AI persistence

Gemini remains the server-side reasoning engine. AI-specific data is stored
separately from the existing Notion planner:

```dotenv
MONGO_URI=mongodb+srv://...
MONGO_DB_NAME=asladin-future-os
# Optional override; omitted means the AI data uses MONGO_DB_NAME.
AI_MONGO_DB_NAME=
```

The app uses `AI_MONGO_DB_NAME` when set, otherwise `MONGO_DB_NAME` (or
`asladin-future-os` if neither is set). Existing Telegram, GitHub, activity,
and recommendation storage continues using `MONGO_DB_NAME`, so the AI and
integration collections share a database unless the AI override is set.
Create a least-privilege Atlas database user and allow the app's deployment
network in Atlas Network Access. Grant that user read/write access to each
database the app uses.

The AI data model uses these collections, created by MongoDB as each feature
first inserts data:

```text
asladin-future-os
├── ai_skills
├── ai_preferences
├── ai_feedback
├── ai_action_proposals
├── ai_action_logs
├── ai_memories
└── ai_conversations
```

ASLADIN stores each user-scoped chat exchange in `ai_conversations`, including
one document per conversation session with a title, bounded summary, ordered
messages, and creation/update/last-message timestamps. Conversation reads,
archives, and deletions are scoped to the authenticated Clerk user. Gemini
receives only the stored summary and a bounded recent message window. Chat
records omit full tool results, uploaded files, credentials, and system
instructions. Dashboard activity is stored separately in `activities` using
`MONGO_DB_NAME`; it remains unchanged.

`GET /api/ai/conversations` lists the signed-in user's sessions.
`GET /api/ai/conversations/{conversationId}` retrieves one session;
`PATCH` with `{ "archived": true }` archives it, and `DELETE` removes it.
The assistant execution endpoint creates a session when `conversationId` is
omitted and appends to an owned session when one is supplied. A browser-supplied
`userId` is rejected; ownership always comes from Clerk.

The authenticated `GET /api/ai/skills` endpoint lists the signed-in user's
skills and shared system skills, and `POST /api/ai/skills` saves one.
MongoDB creates `ai_skills` on the first successful insert. The initial
`list_tasks` system skill is a read-only handler definition; task retrieval
must still use the authenticated user's identity and existing access checks.
The remaining AI collections are created only when their features are added.

Ask ASLADIN to use the task-list skill with an authenticated same-origin
request to `/api/ai/skills/execute`:

```json
{
  "message": "What pending tasks should I focus on?"
}
```

Gemini can request `list_tasks` with optional `status` (`pending`,
`completed`, or `all`) and `limit` (integer 1–100); they default to `pending`
and 20. The response includes the normalized answer, `toolUsed`, and, when
used, a safe task result with the count, approved task fields, and generation
timestamp. The server resolves the stored handler name only through a fixed
code-side allowlist and reuses the existing Notion task fetcher. The stored
definition must explicitly set `approvedForAI: true`.

## Where credentials go

### Local development

1. Copy `.env.example` to `.env.local` in the repository root.
2. Put each real credential in `.env.local`, replacing its placeholder.
3. Keep `.env.local` out of Git. The repository `.gitignore` should ignore it.
4. Restart the local Next.js server after changing environment variables.

Never put secrets in a `NEXT_PUBLIC_...` variable. Anything with the
`NEXT_PUBLIC_` prefix can be included in browser JavaScript. OAuth client IDs
are generally identifiers rather than passwords, but keep client secrets,
bot tokens, API keys, access tokens, and signing secrets on the server.

### Vercel deployment

In **Vercel → Project → Settings → Environment Variables**, add credentials
for the environments where the feature should work (Development, Preview,
Production). Redeploy after changing variables. Do not upload `.env.local` to
Vercel or commit it to the repository.

Use separate OAuth redirect URIs and credentials for local development and
production where practical. Restrict production credentials to the production
domain and revoke/rotate any secret that was exposed.

## Google Workspace: Gmail, Calendar, and Drive

Google OAuth and API routes are already in this app. Linking Google is
separate from signing into the dashboard with Clerk.

### 1. Create a Google OAuth client

1. Open the Google Cloud project that will own the integration.
2. Enable the Gmail API, Google Calendar API, and Google Drive API.
3. Configure the OAuth consent screen. Add the intended test users while the
   app is in testing; publishing or verification may be required for broader
   use because this app requests sensitive/restricted Google scopes.
4. Create an OAuth 2.0 client with application type **Web application**.
5. Add the app's exact callback URL under **Authorized redirect URIs**:

   Production:

   ```text
   https://my-notion-lemon.vercel.app/api/google/callback
   ```

   Local development (register this separately):

   ```text
   http://localhost:3000/api/google/callback
   ```

   The URI must match exactly: protocol, host, port, path, and trailing slash.

### 2. Set the Google environment variables

Add these to `.env.local` for local use and to Vercel for the matching
deployment environment:

```dotenv
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
GOOGLE_CALLBACK_URL=http://localhost:3000/api/google/callback
SESSION_SECRET=use_a_random_secret_of_at_least_32_characters
```

For production, change both callback variables to the production URL. If both
callback variables are set, they must be identical. Generate a strong session
secret locally, for example:

```bash
openssl rand -base64 48
```

Do not reuse the example text above as a real secret.

### 3. Authorize an account

1. Sign into the dashboard with an authorized Clerk account.
2. Select **Connect Google**.
3. Review Google's permission screen and approve only if you are comfortable
   with the requested access.
4. Return to the dashboard and use its Google Workspace panel or an explicit
   Google-enabled assistant action.

### What this implementation stores and accesses

- Google data is requested when the dashboard or a user-selected assistant
  feature needs it; there is no background polling.
- The current implementation requests Gmail, Calendar, and Drive scopes. Some
  are broad and may require Google app verification for general availability.
- The access token is encrypted into a short-lived, HTTP-only cookie, scoped to
  the Google API routes, and expires within about one hour.
- The app does not persist a Google refresh token or use MongoDB. Users may
  need to reconnect after the access token expires.
- The personal secretary can send a limited snapshot of selected Google data
  to Gemini after the user submits a question. Avoid sending sensitive content
  unless you accept that processing.
- The app currently suggests Google actions; it does not send email or modify
  Calendar/Drive data.
- Gmail, Calendar, and Drive are fetched independently. If Google denies one
  service's access, the dashboard keeps data from the other services and shows
  a service-specific error for the unavailable data.

MongoDB is not used for Google OAuth. The integration state database below
stores Telegram pairing/link state and short-lived approval records; it does
not store planner contents, Google tokens, or credentials.

## GitHub App

The dashboard uses a GitHub App (not an OAuth token or personal access
token). The App's installation ID and RSA private key stay on the server.
Installation access tokens are short-lived and are never sent to the browser.

### 1. Create and configure the App

1. In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub
   App**. Set a unique name and homepage URL for the deployed dashboard.
2. Set **Webhook** to inactive; this integration does not receive GitHub
   webhooks.
3. Grant only these repository permissions:

   | Permission | Access | Use |
   | --- | --- | --- |
   | Metadata | Read-only | List and verify installed repositories. |
   | Issues | Read and write | Read issues and create issues/comments. |
   | Pull requests | Read and write | Read PRs/reviews and create PRs/comments. |
   | Checks | Read-only | Read check-run status for the first 10 open PRs. |

4. Save the App, note the **App ID**, and use **Generate a private key** to
   download its `.pem` key. Keep it private.
5. Choose **All repositories** when installing the App on the account or
   organization. This is the installation scope chosen for this dashboard;
   the UI only displays repositories returned by that installation.
6. Find the installation ID in the URL of the App's installation settings
   page (`.../installations/<ID>`).

### 2. Add the server environment variables

```dotenv
GITHUB_APP_ID=your_github_app_id
GITHUB_INSTALLATION_ID=your_installation_id
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...key contents...\n-----END RSA PRIVATE KEY-----"
```

Set the values in `.env.local` for local development and in the appropriate
Vercel environments, then restart/redeploy. Store the PEM exactly, including
the header/footer; literal `\n` line separators are converted by the server.
The key must be a valid RSA private key; an absent or invalid GitHub App
configuration is shown as setup needed rather than an upstream outage. Never
prefix the private key with `NEXT_PUBLIC_`.

### 3. Use GitHub from the dashboard

Open the **GitHub** panel on Home and select an installed repository. It shows
open issues and PRs, reviewer decisions, and CI checks for up to 10 open PRs.
The panel supports creating an issue, commenting on an open issue/PR, and
creating a PR between two existing branches. The app does not push commits,
merge PRs, alter repository settings, or send repository contents to an AI
provider. Every write first creates a server-side proposal; it only runs after
you review and confirm, and the approval expires after 10 minutes.

## Telegram bot

The Telegram integration links one private Telegram chat to the signed-in
authorized dashboard account. MongoDB is required for link state, pairing
codes, pending approvals, and webhook deduplication. It does not store task
contents. The bot token and webhook secret are server-only.

### 1. Create the bot and set deployment variables

1. Create a bot with Telegram's official BotFather and copy its token.
2. Set these server-only variables:

   ```dotenv
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_BOT_USERNAME=your_bot_username_without_at
   TELEGRAM_WEBHOOK_SECRET=use_letters_numbers_underscore_or_hyphen
   TELEGRAM_WEBHOOK_URL=https://your-domain.example/api/telegram/webhook
   MONGO_URI=mongodb+srv://...
   MONGO_DB_NAME=asladin_command_center
   ```

3. For MongoDB Atlas, create a database user restricted to this database,
   allow the app's deployment network to connect, and use the TLS SRV URI
   supplied by Atlas. Do not reuse an administrator account.
4. For `TELEGRAM_WEBHOOK_SECRET`, generate a high-entropy value using a
   password manager or `openssl rand -hex 32`. Telegram permits 1–256
   characters from letters, digits, `_`, and `-`.
5. Deploy/redeploy the app at the public HTTPS domain matching
   `TELEGRAM_WEBHOOK_URL`.

### 2. Configure and link

1. Sign in to the dashboard, visit the Home **Telegram** panel, and choose
   **Configure bot webhook**. This registers the HTTPS webhook and bot
   commands with Telegram. Reconfigure after changing the deployment URL or
   webhook secret.
2. Choose **Generate one-time account link**, then open the generated
   Telegram link and press Start. The pairing code is single-use and expires
   after 10 minutes. The bot only accepts private chats.
3. Use `/help` in Telegram. `/summary` returns task counts; `/tasks` returns
   up to 8 incomplete tasks. `/create <title>` and `/edit <task-id>
   field=value` create proposals and do not modify Notion until you tap
   **Confirm**. Approvals expire after 10 minutes; `/cancel` cancels pending
   proposals.
4. The dashboard's explicit **Refresh** button sends a counts-only message
   when a linked account is configured. It never sends task titles, notes,
   email, or calendar details. Normal page loads do not send Telegram
   messages.
5. Use **Unlink Telegram account** in the dashboard to revoke the link and
   pending approvals.

The webhook route is exempted from Clerk middleware because Telegram cannot
present a Clerk session; it independently checks Telegram's secret header,
validates update structure, verifies the linked Telegram user and dashboard
allowlist, and limits request size. Never expose a bot token in a URL,
browser bundle, log, or AI prompt.

## Adding another API provider

Use this pattern for Slack, Microsoft 365, Trello, or another service:

1. **Define a narrow feature.** Specify the exact data and actions needed;
   avoid requesting every available permission.
2. **Choose authentication.** Prefer OAuth for a user's account or a provider
   app with limited installation scope. Use static keys only for a
   server-to-server service that actually requires one.
3. **Keep credentials server-side.** Add placeholders to `.env.example` and
   real values only to `.env.local` or deployment settings.
4. **Create server routes.** Authenticate the Clerk user, verify the account is
   allowed to use the feature, validate input and request origin, then call
   the provider from the server.
5. **Validate provider responses.** Handle non-JSON responses, expired
   credentials, rate limits, timeouts, partial failures, and revoked access.
   Do not treat an HTTP success alone as proof that a response has the
   expected shape.
6. **Minimize data exposure.** Send only fields needed for the user-requested
   task to an AI provider. Treat provider content as untrusted input and never
   let it override system instructions.
7. **Require approval for writes.** Show a preview of intended external
   changes and perform them only after explicit confirmation.
8. **Add lifecycle controls.** Include a connected/disconnected state,
   reconnect guidance, disconnect/revocation, safe logs, and tests for the
   success and failure paths.
9. **Document deployment.** Describe provider-console setup, exact callback
   and webhook URLs, required environment variables, scopes, and limitations.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Google **setup error** or redirect fails | Confirm client ID/secret exist, callback URL is registered exactly, and `GOOGLE_REDIRECT_URI` equals `GOOGLE_CALLBACK_URL`. |
| Google reports a redirect URI mismatch | Register the exact URI, including `/api/google/callback`, protocol, hostname, and port. |
| Google authorization succeeds locally but not on Vercel | Add production credentials and the production callback URL to Vercel and Google Cloud, then redeploy. |
| Google asks you to connect again | The current access session expires within about an hour; reconnect. |
| Google permission or verification warning | Review requested scopes and OAuth consent-screen publishing/verification status in Google Cloud. |
| GitHub reports missing configuration or permission | Check App ID, installation ID, RSA private key, installation scope, and the four repository permission grants; then reinstall/update permissions. |
| Telegram linking/setup fails | Check bot token/username/secret, MongoDB URI and network access, the exact HTTPS webhook URL, and that the app was redeployed. |
| A provider key works locally but is missing in production | Add it to the correct Vercel environment and redeploy. Keep it server-only. |
| The assistant cannot use provider data | Confirm that the provider feature is implemented, the account is connected, its permissions are approved, and the server-side environment is configured. |

## Security checklist

- Never commit `.env.local`, OAuth client secrets, bot tokens, private keys, or
  access tokens.
- Never use `NEXT_PUBLIC_` for a secret.
- Never include credentials in error messages, browser responses, logs,
  screenshots, or AI prompts.
- Request the minimum scopes and restrict installations to the intended
  accounts/resources.
- Treat provider data and webhook payloads as untrusted.
- Require explicit user confirmation before sending messages or changing
  remote data.
- Revoke and rotate credentials immediately if they are exposed.
- Review the app's repository installation scope and revoke the GitHub App
  installation or Telegram link when it is no longer needed.
