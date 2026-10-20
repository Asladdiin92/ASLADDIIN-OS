# Notion Academic & Life Dashboard

A personal dashboard built with **Next.js and React**. Your existing Notion
database is the source of truth: the dashboard reads tasks from Notion, turns
them into charts, progress indicators, and a deadline calendar, and lets you
create, edit, and archive planner items in the same database.

This guide explains how the application works, what each part is for, and how
to run, extend, and deploy it.

Notion remains the source of truth for planner data. MongoDB stores AI-specific
skills and integration state, not planner items. AI data defaults to the
database configured by `MONGO_DB_NAME` (`asladin-future-os` in the current
setup); set `AI_MONGO_DB_NAME` only to override that. Clerk handles
authentication, the existing Notion People property supplies optional
assignees, and AI plans stay temporary until their proposed tasks are
confirmed. The application reads every database page through Notion pagination
and maps optional columns only when the matching property exists. Missing
optional columns are not fabricated or seeded.

## Contents

- [How the project works](#how-the-project-works)
- [Technology used](#technology-used)
- [How Notion data flows through the app](#how-notion-data-flows-through-the-app)
- [Understanding the dashboard calculations](#understanding-the-dashboard-calculations)
- [Project structure](#project-structure)
- [Run it locally](#run-it-locally)
- [Connect your Notion database](#connect-your-notion-database)
- [Connect Google Workspace](#connect-google-workspace)
- [Connect GitHub and Telegram](#connect-github-and-telegram)
- [Configure Sentry](#configure-sentry)
- [Deploy to Render, Vercel, and MongoDB Atlas](#deploy-to-render-vercel-and-mongodb-atlas)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Ideas for learning and extending the project](#ideas-for-learning-and-extending-the-project)

## How the project works

The browser displays the dashboard, but it does **not** talk directly to
Notion. Clerk authenticates the user, and the server checks the signed-in
account against a verified-email allowlist before returning planner data or
creating a Notion item. The `/api/tasks` endpoint then reads the Notion
credentials from server environment variables, contacts the Notion API, and
returns task data to the browser.

When you create, edit, or archive a planner item, the browser calls this app's
API. The server checks the Clerk session and verified-email allowlist, validates
the input against the Notion database schema, and then makes the Notion change.
The planner assistant can turn natural-language instructions into a proposed
create or edit. It only reads Notion to prepare the proposal; you must confirm
the preview before the browser calls the existing create or edit API.
It can also generate a checklist-style task breakdown or a color-coded daily
timeline. Harar prayer times are fetched for the selected day and converted to
the browser's time zone; creating the generated steps or schedule blocks in
Notion always requires a separate confirmation.

```text
Your browser (React dashboard + Clerk sign-in)
        │
        │ Clerk session cookie
        ▼
Next.js middleware + API access check (allowlisted verified email)
        │
        │ GET /api/tasks            load tasks and database options
        │ POST /api/tasks           create a planner item
        │ PATCH /api/tasks/:id      edit a planner item
        │ DELETE /api/tasks/:id     archive a planner item
        │ POST /api/assistant      planner, research, writing, translation, file tools
        │ POST /api/assistant/next-action on-demand ranked next-task explanation
        │ GET /api/google/summary   Gmail, Calendar, and Drive snapshot
        │ POST /api/google/assistant on-demand task and Google data analysis
        │ GET /api/github repository, issue, PR, review, and check snapshots
        │ POST /api/github/actions server-held, one-time confirmed GitHub writes
        │ POST /api/telegram/webhook verified Telegram bot updates
        ▼
Next.js server (API routes + Notion mapping + short-lived encrypted Google session)
        │
        │ NOTION_API_KEY / GEMINI_API_KEY / GOOGLE_CLIENT_SECRET / SESSION_SECRET (server-only)
        │ NOTION_DATABASE_ID / MONGO_URI / GITHUB_PRIVATE_KEY / TELEGRAM_BOT_TOKEN (server-only)
        ├── Notion API (your existing planner database)
        ├── Google Gmail / Calendar / Drive APIs (on demand)
        ├── GitHub App installation (short-lived access tokens)
        ├── Telegram bot (linked private chat; confirmed planner actions)
        └── Gemini API (only when you ask the AI assistant)
```

The Notion secret stays on the server. It is never intentionally included in
the browser bundle or API response.

## Technology used

| Technology | What it does in this project |
| --- | --- |
| **Next.js App Router** | Provides the website, page layout, server-side API routes, middleware, and production build. |
| **Clerk** | Handles sign-in and sessions; a server-verified email allowlist authorizes planner access. |
| **React** | Builds the interactive dashboard, calendar, task table, and planner-item forms/actions from reusable components. |
| **TypeScript** | Gives task data and API request/response objects explicit types so mismatched fields can be caught during a build. |
| **Recharts** | Draws the status, priority, task type, and timeline charts. |
| **Lucide React** | Supplies consistent icons for navigation, metrics, actions, and states. |
| **Notion REST API** | Stores the real planner data and creates, updates, or archives pages in your database. This project calls it with the server's built-in `fetch`; it does not need the Notion SDK. |
| **Sentry** | Captures unhandled browser, server, and edge errors, console logs, and sampled performance traces when `NEXT_PUBLIC_SENTRY_DSN` is configured. |
| **CSS** | Styles the responsive layout, charts, calendar, form, and phone/tablet views. |
| **MongoDB Atlas** | Stores AI skills and integration state; it is not the planner database. |
| **GitHub App** | Reads installed repository issues/PRs/reviews/checks and runs confirmed issue/comment/PR actions. |
| **Telegram Bot API** | Provides linked planner commands and optional counts-only refresh notifications. |
| **Vercel** | Can host the Next.js app and supply production environment variables. |

Dependencies and commands are recorded in `package.json` and
`package-lock.json`. **Notion remains the planner database**; MongoDB stores
AI-specific data and integration metadata separately.

## Configure Sentry

Sentry is initialized for browser, Node.js, and Edge runtimes. The app captures
errors, console logs, sampled performance traces, and client-side route
transitions when `NEXT_PUBLIC_SENTRY_DSN` is set. Production traces are sampled
at 10%; development traces are sampled at 100%. The app does not explicitly
attach signed-in user identities to Sentry events.

For readable production stack traces, add these **server-side build
environment variables** to each deployment that builds this app:

```dotenv
SENTRY_AUTH_TOKEN=your_sentry_auth_token
SENTRY_ORG=your_sentry_organization_slug
SENTRY_PROJECT=node
```

Create a Sentry auth token with permission to create releases and upload source
maps. The organization slug is the Sentry organization in your project URL, and
the project slug is shown in Project Settings. The values shown when this guide
was written were `haramaya-university-bx` and `node`. Keep the token out of
`NEXT_PUBLIC_...` variables, source control, and browser code. The Next.js build
uploads source maps when the token is present and deletes the local maps after
upload. Without the token, error and trace reporting still work, but production
stack traces may not map back to the original source.

Sentry events are sent through `/api/_sentry` to reduce losses from browser
content blockers. The endpoint is intentionally public so unauthenticated
browser events can be forwarded; it only serves as the Sentry tunnel. Session
Replay is not enabled because dashboard pages can contain private planner
content. Review Sentry's masking and data-retention settings before enabling
Replay.

After setting the build variables, redeploy and trigger a normal app action.
Check **Issues** for errors and **Explore → Traces** for requests and route
transitions. Configure issue alerts and notification destinations in Sentry's
project settings; those are account-level settings and are not controlled by
this repository.

## Connect GitHub and Telegram

Follow [`connect.md`](./connect.md) for provider-console setup, required
permissions, environment variables, Vercel deployment, Telegram pairing, and
troubleshooting. GitHub and Telegram credentials are server-only. GitHub
external writes and Telegram Notion changes require one-time explicit
approval; GitHub/Telegram integrations do not expose secrets to the AI
assistant. MongoDB Atlas must be configured for their account links and
expiring approvals to work.

## How Notion data flows through the app

### 1. The page asks the app for data

The dashboard component in `app/page.tsx` sends a browser request:

```ts
fetch("/api/tasks", { cache: "no-store" })
```

The browser can only reach this same-origin route. Clerk middleware requires a
signed-in session, and the route independently checks that the account has a
verified address in `ALLOWED_EMAILS`. Authorized users receive normalized task
objects plus the valid select/status choices used to build the create-item form.

### 2. The server loads tasks and Notion options

`app/api/tasks/route.ts` implements `GET /api/tasks`. It loads:

- **Planner pages** from the database.
- **Database properties and options**, so form choices can match your real
  Notion configuration.

The server loads these in parallel and does not cache the responses. When
Notion returns more than one result page, `lib/notion.ts` follows Notion's
pagination cursor until it has loaded all results (up to the app's 2,000-item
limit).

### 3. Notion properties become predictable task objects

Notion returns pages with nested property structures. The mapping in
`lib/notion.ts` converts them into the simpler `Task` type from `lib/types.ts`:

| Dashboard field | Notion property by default | Used for |
| --- | --- | --- |
| `title` | `Item` (title) | Planner item name and task table link. |
| `type` | `Type` (select) | Task-type chart, badges, and create form. |
| `dueDate` | `Date` (date) | Calendar markers, upcoming deadlines, and overdue counts; date-times retain and display their time in the browser's local time zone. |
| `status` | `Status` (status) | Status label and completion calculation. |
| `area` | `Area` (select) | Progress-by-area calculations. |
| `course` | `Course` (select for creation; select or rich text for reading) | Secondary label below a task title. |
| `courseCode` | `Course Code` (rich text) | Course-code filter and course progress grouping. |
| `estimatedHours` | `Est.` or `Estimated Hours` (number) | Estimated workload in the task list and course progress. |
| `actualHours` | `Actual` or `Actual Hours` (number) | Actual workload and estimated-versus-actual progress. |
| `assessment` | `Assessment` or `Assessment Type` (select) | Assessment badge and deliverables filtering. |
| `dateEnd` | `Date.end` (date range) | End of a Notion date range or event block. |
| `deliverable` | `Deliverable` (checkbox) | Deliverable-only filtering, deadlines, and progress. If absent, Type `Deliverable` is used. |
| `creditHours` | `Credit Hours` (number) | Course credit value. |
| `instructor` | `Instructor` (rich text) | Instructor, client, or responsible person. |
| `peopleInstructor` | `People / Instructor` (people) | Assigned Notion people, read-only in the dashboard. |
| `marksGrade` | `Marks / Grade` (rich text) | Score, grade, or pending result. |
| `nextReviewDate` | `Next Review Date` (date) | Upcoming spaced-review dates. |
| `notes` | `Notes` (rich text) | Item context and technical notes. |
| `recurrence` | `Recurrence` (rich text) | Recurrence description for routines and classes. |
| `resourceLink` | `Resource Link` (URL or rich text) | Course, repository, or submission reference. |
| `semester` | `Semester` (select) | Semester filter in the calendar. |
| `timeBlock` | `Time Block` (rich text) | Recurring class, prayer, or work time. |
| `venueLink` | `Venue Link` or `Venue / Link` (URL or rich text) | Room, meeting place, or online link. |
| `priority` | `Priority` (select) | Priority chart and task table badge. |
| `nextAction` | `Next Action` (rich text) | Next-action column in the task table. |
| `completed` | `Completed` (checkbox), or completion status | Completed versus pending totals. |
| `createdAt` / `updatedAt` | Notion page creation and last-edit timestamps | Task timeline and last-updated metadata. |

These names are defaults based on the planner screenshot. If a property has a
different name in your database, set the corresponding environment variable.
The title property is also detected by its Notion title type if its name is
different.

The `Task` model also carries the original planner's optional metadata:
`dateEnd`, `deliverable`, `actualHours`, `assessment`, `creditHours`,
`instructor`, assigned Notion people, `marksGrade`, `nextReviewDate`, `notes`,
`recurrence`, `resourceLink`, `semester`, `timeBlock`, and `venueLink`.
Date/time display and form input use `Africa/Addis_Ababa`; timestamps are
written as UTC instants and all-day dates remain date-only.

### 4. Create a planner item

The **New item** button opens a form. Type, Status, Priority, Area, Course,
Assessment, and Semester choices are fetched from your actual database schema;
they are not hard-coded. Optional controls appear when the matching Notion
property exists and has a compatible type.
If a required choice isn't provided, creation defaults to `Deliverable` (or
`Task`, then the first Type option), `Planned` (or `Not started`, then the first
Status option), and `Medium` (or `Normal`, `Low`, then the first Priority
option). Optional Area, Course, due date, and Next action stay empty unless set.

When the form is submitted:

1. The browser sends JSON to `POST /api/tasks` with its Clerk session.
2. Middleware and the route check authentication; the route requires a
   verified, allowlisted email, checks request origin, and validates input.
3. `lib/notion.ts` checks the date and confirms the chosen values exist in the
   correct Notion property options.
4. The server uses Notion's create-page endpoint to add an item to
   `NOTION_DATABASE_ID`.
5. The returned Notion page is mapped to a `Task`; React adds it to the table
   and recalculates the dashboard.

The table's **Edit** action opens the form with current values; saving calls
`PATCH /api/tasks/:id`, and blank optional fields clear their Notion values.
Course Code, estimated/actual/credit hours, Assessment, date-time ranges,
deliverable state, review date, and the other mapped metadata can also be
entered or edited when those properties exist in the database. People assigned
through Notion's People property are displayed but not reassigned by this form.
**Delete** asks for confirmation and calls `DELETE /api/tasks/:id`, which
archives the page in Notion rather than permanently deleting it. Archived items
can be restored from Notion's trash.
The check action writes the Completed checkbox and, when available, a matching
Done/Planned status to Notion.

## Understanding the dashboard calculations

- **Task status chart:** a task is completed when the `Completed` checkbox is
  checked, or when its status is exactly `Done`, `Complete`, `Completed`, or
  `Finished` (case-insensitive). All other tasks count as pending.
- **Priority distribution:** counts tasks by their Priority option. Unassigned
  priority values are left out of the chart.
- **Task-type distribution:** counts tasks by their Type option. Blank types
  appear in the task table as `Other` and are omitted from the distribution
  chart.
- **Task timeline:** groups pages by their Notion `created_time` month for the
  current month and the previous five months. This is when the page was
  created, not the planner due date.
- **Deadline calendar:** shows the task due dates from the Notion Date
  property, including date ranges, with filters for date range, type, area,
  course, status, priority, and semester. Event markers are color-coded by
  class, deliverable, exam, prayer, freelance, review, and routine type. The
  upcoming list shows the next three non-completed deliverables and exams.
- **Overdue count:** counts tasks that are not completed and have a due date
  earlier than today's local date.
- **Progress by area:** groups tasks by Area and displays
  `completed tasks / total tasks` and that area's completion percentage.
- **Course progress:** groups items by Course Code and displays completed and
  pending counts plus the estimated hours remaining for each course.
- **Detailed progress:** shows totals for estimated versus actual hours,
  completion by Type, completed and overdue deliverables, and upcoming review
  dates.
- **Task filters and views:** category tabs filter all items, deliverables,
  routines/prayers, or items with a course code. Additional filters cover
  Type, Area, Priority, Status, and Course; sorting supports date, priority,
  and title. Table and Board views show the full loaded result set; the board
  groups items by Notion Status. Use the task details expander for remaining
  metadata such as notes, instructors, recurrence, and links.
- **Search and refresh:** task search filters the currently loaded tasks in the
  browser. **Refresh** makes fresh requests to the API and Notion.
- **Next best action:** Home ranks incomplete Notion items by overdue/due
  status, priority, and whether their recorded estimate fits before the next
  available focus window. The default focus window is 08:30–18:00 in
  `Africa/Addis_Ababa`. When Google is connected, the on-demand request checks
  upcoming Calendar events and avoids those meeting intervals. Select
  **Recommend my next action** to send only the selected task and focus-window
  context to Gemini for a brief explanation and first step. This does not run
  in the background or change Notion; estimates are shown only when recorded.

## Project structure

```text
notion-dashboard/
├── app/
│   ├── api/assistant/       # Server-side Gemini assistant and next-action route
│   ├── api/google/         # Google OAuth, workspace snapshot, and AI secretary
│   ├── api/tasks/route.ts   # GET task data/options and POST new items
│   ├── sign-in/             # Clerk sign-in page
│   ├── error.tsx            # Route-level recovery screen
│   ├── global-error.tsx     # Friendly recovery screen for unexpected errors
│   ├── globals.css          # Dashboard styles and responsive breakpoints
│   ├── layout.tsx           # Shared page layout and browser metadata
│   └── page.tsx             # Main dashboard, metrics, calendar, and item form
├── components/
│   ├── dashboard-charts.tsx # Recharts visualizations
│   └── planner-assistant.tsx # AI suggestions, task Q&A, and confirmed edits
├── lib/
│   ├── access.ts            # Verified-email allowlist check
│   ├── api-response.ts      # Consistent, safe browser API response parsing
│   ├── google-types.ts      # Google Workspace snapshot types
│   ├── google-workspace.ts  # OAuth session encryption and Google API calls
│   ├── gemini.test.ts       # Gemini fallback behavior tests
│   ├── gemini.ts            # Server-side Gemini API requests
│   ├── notion.ts            # Notion API requests, validation, and mapping
│   ├── next-action.ts       # Time-window and meeting-aware task ranking
│   ├── prayer-times.test.ts # Prayer-time lookup and timezone tests
│   ├── prayer-times.ts      # Harar prayer-time lookup and timezone conversion
│   └── types.ts             # Shared Task and API data types
├── middleware.ts            # Requires Clerk sign-in for app/API routes
├── .env.example             # Safe placeholder template to copy from
├── .env.local               # Your local secrets; ignored by Git
├── .gitignore               # Excludes secrets, build output, and dependencies
├── next.config.ts           # Next.js configuration
├── package.json             # Dependencies and npm scripts
├── package-lock.json        # Exact dependency resolution for repeatable installs
└── tsconfig.json            # TypeScript compiler settings
```

### A few useful concepts

- A **React component** is a reusable part of the interface. For example,
  `MetricCard`, `CalendarCard`, and `TaskTable` live in `app/page.tsx`.
- A **client component** has the `"use client"` directive because it uses
  browser interactions and React state. The dashboard page and chart components
  are client components.
- An **API route** is a server-side URL implemented by a `route.ts` file.
  `app/api/tasks/route.ts` handles `GET` and `POST`; `app/api/tasks/[id]/route.ts`
  handles item updates and archives.
- An **environment variable** is configuration supplied to the server at
  runtime. `NOTION_API_KEY` and `GEMINI_API_KEY` are secret; do not prefix them
  with `NEXT_PUBLIC_`.
- A **Notion integration** is the authenticated connection the app uses. It
  must be explicitly shared with your existing planner database.
- A **TypeScript type** such as `Task` describes the fields an object should
  contain and helps detect mistakes before running the app.

## Run it locally

Install **Node.js 20 or newer**. From this project directory, run:

```bash
npm install
```

The project already includes an ignored `.env.local` file. Keep it and fill it
in. If you remove it and need to make a new one from the example, run:

```bash
cp .env.example .env.local
```

Fill in the required values in `.env.local`:

```dotenv
NOTION_API_KEY=secret_your_notion_integration_token
NOTION_DATABASE_ID=your_notion_database_id
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
ALLOWED_EMAILS=your_verified_email@example.com
GEMINI_API_KEY=your_gemini_api_key
TAVILY_API_KEY=your_tavily_api_key
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REDIRECT_URI=https://my-notion-lemon.vercel.app/api/google/callback
GOOGLE_CALLBACK_URL=https://my-notion-lemon.vercel.app/api/google/callback
SESSION_SECRET=replace_with_a_random_secret_at_least_32_characters_long
```

The email must be verified in Clerk. `ALLOWED_EMAILS` is enforced server-side
by the API; do not expose it as a `NEXT_PUBLIC_` variable. Gemini and Tavily
keys are used only by server-side routes; never add a `NEXT_PUBLIC_` prefix to
them. `TAVILY_API_KEY` is needed only for live web research. Add it to
`.env.local` and to Vercel's server environment for production, then restart
or redeploy. Never paste secret keys into assistant prompts or commit them.

The **Planner assistant** includes quick actions to plan the day, decompose a
task, identify urgent work, or get a motivational nudge. Its coach rules put
faith/prayer first, then urgent University deadlines, Coding Lab milestones,
and Freelance Work; suggestions include estimated time, an area, and a
concrete next action.

Choose a tool from the assistant selector:

- **Analyze my planner** answers workload questions from complete computed
  totals by area, course, and type, due-today counts, and overdue ages. Actual
  hours in this Notion schema are totals without dated time entries, so the
  assistant cannot infer time spent for a specific week.
- **Web research** searches through Tavily, then asks Gemini to synthesize the
  result snippets with numbered source references and links. Search queries go
  to Tavily; returned snippets go to Gemini. Research requires `TAVILY_API_KEY`.
- **Writing assistant** drafts, revises, outlines, or summarizes text without
  loading or changing the Notion task list.
- **Translate text** translates into the target language you enter.
- **Analyze an uploaded file** accepts PDF, DOCX, TXT, Markdown, PNG/JPEG,
  CSV, and XLSX files up to 3 MB. Files are processed temporarily for the
  request and not saved by this app; their contents may be sent to Gemini.
  DOCX and spreadsheets are text-extracted on the server, while PDF/image
  content is sent to Gemini as an attachment.
- **Generate/autofill Notion items** drafts rows from pasted notes or an
  uploaded file. Review and select the rows before confirming the write.
  Multi-item creation is sent to Notion one item at a time and may partially
  succeed if Notion reports an error.

The Overview's **My Day** section highlights unfinished items due today,
overdue items, and tasks whose recurrence explicitly says daily/every day.
It prioritizes Critical/High work and provides quick complete/edit actions;
the AI planner remains responsible for suggesting a full time-blocked plan.

Home's **Next best action** is separate from that list and runs only when
requested. It chooses one real incomplete planner item, explains the ranking
with Gemini, and suggests a concrete first step. Its focus window uses the
default 08:30–18:00 Addis Ababa workday; outside that window it recommends the
next available work window. If Google Calendar is not connected, it clearly
warns that meeting conflicts could not be checked. The assistant cannot update
the task; use the normal task controls if you decide to make a change.

Notes are stored in the Notion planner item's Notes field, which has no
separate note-created or note-updated timestamp in this schema. The Notes view
therefore displays the parent item's creation and last-edited dates separately
from the note content rather than presenting either as a precise note date.

The assistant can also interpret instructions such as “add a biology review
task tomorrow” or “move my biology deadline to Friday.” For create/edit
instructions, it previews the fields and makes no Notion change until you
select **Confirm**. Recurrence is editable from assistant instructions. If you
explicitly ask to update all/every matching task and multiple tasks match, the
assistant previews each affected task and applies the confirmed updates one at
a time; a Notion error can therefore leave a partial batch. It asks for
clarification if an edit does not clearly match a task. Task breakdown steps
and daily schedule blocks are checkable, and the selected items are only
created in Notion after confirmation. Archiving remains a manual task-table
action. Planner data is sent to Gemini only for planner-specific tools;
writing, translation, and file analysis do not load the Notion task list.

Daily plans cover 08:30–18:00 in the device time zone and use prayer times for
Harar, Ethiopia from AlAdhan's by-city service (its default calculation
method). Prayer anchors are displayed separately; work blocks are validated
to avoid overlap, the configured window, and the prayer-time buffers. Selected
schedule blocks are saved as Notion date-times in the device's local time zone.
Only the task breakdown and exact task details needed for planning are sent to
Google Gemini. Planner-specific requests include all tasks loaded from Notion
(up to the app's 2,000-item fetch limit), so recommendations and updates are
not silently restricted to the first 150 records. Gemini 3.8 Flash
is tried first and automatically falls back to Gemini 3.5 Flash-Lite on
temporary overloads or timeouts.

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Restart the server after
editing `.env.local`. Use **Refresh** on the page to reload database data.

Useful project commands:

```bash
npm run dev    # Start the development server
npm run lint   # Check code with ESLint
npm test      # Test Notion task defaults and Gemini fallback behavior
npm run build  # Type-check and build the production app
npm run start  # Serve a completed production build
```

## Connect your Notion database

1. Create or reuse your Notion internal integration and copy its secret into
   `.env.local`.
2. In Notion, share your existing **Academic & Life Planner** database with
   that integration.
3. Give the integration **Read content**, **Insert content**, and **Update
   content** access. Read access loads tasks; insert creates items; update
   enables editing and archiving.
4. Copy the database ID into `NOTION_DATABASE_ID`. It is part of the database
   URL. Do not use the integration token as the database ID.
5. If you renamed a property, add the corresponding override shown in
   `.env.example`, for example:

   ```dotenv
   NOTION_TITLE_PROPERTY=Name
   NOTION_DUE_DATE_PROPERTY=Deadline
   NOTION_COMPLETED_PROPERTY=Done
   NOTION_COURSE_CODE_PROPERTY=Course Code
   NOTION_ESTIMATED_HOURS_PROPERTY=Est.
   NOTION_ASSESSMENT_PROPERTY=Assessment
   NOTION_ACTUAL_HOURS_PROPERTY=Actual
   NOTION_DELIVERABLE_PROPERTY=Deliverable
   NOTION_NEXT_REVIEW_DATE_PROPERTY=Next Review Date
   NOTION_SEMESTER_PROPERTY=Semester
   ```

Only set an override when a property name is different. The form supports the
database's select/status option properties, date property, rich-text Course
Code and Next action properties, and numeric Est. property. If your database
uses a different type for a field, adapt the corresponding mapping in `lib/notion.ts`.
The PostgreSQL-specific `app_users`, sync-state, and AI-plan tables are
intentionally not used.

## Connect Google Workspace

Google is linked to the signed-in Clerk account; it does not replace Clerk
login. Create an OAuth 2.0 **Web application** client in Google Cloud Console,
enable Gmail API, Google Calendar API, and Google Drive API, and add this exact
authorized redirect URI:

```text
https://my-notion-lemon.vercel.app/api/google/callback
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and both
`GOOGLE_REDIRECT_URI` and `GOOGLE_CALLBACK_URL` to the values in `.env.example`.
The two callback variables must match. For local development, register the
local callback URL separately and set both variables to that URL. Generate a
`SESSION_SECRET` with at least 32 characters (for example,
`openssl rand -base64 48`).

Use **Connect Google** on the dashboard while signed in. Gmail, Calendar, and
Drive are requested together. This implementation is session-only: it requests
online access, keeps an encrypted, HTTP-only Google access-token cookie for at
most one hour, and does not store a Google refresh token, email body, or Drive
file content in MongoDB or elsewhere. You may need to reconnect after the
session expires. Google OAuth does not use `MONGO_URI`; MongoDB is used only
for Telegram integration state and short-lived external-action approvals.
There is no background polling,
continuous activity history, or autonomous email/task creation in this
stateless setup.

The dashboard fetches unread Gmail snippets, the next seven days of calendar
events, and recent Drive file metadata on demand. When you explicitly ask the
**Personal secretary** assistant, it fetches up to three unread email bodies
alongside planner tasks, events, and file metadata, then sends that snapshot
to Gemini to answer your question. Avoid asking it to process sensitive mail
unless you accept that processing. It only suggests actions; it cannot send,
delete, create, or edit Google data. Google OAuth currently requests broad
Gmail and Drive scopes, which may require Google OAuth app verification before
the app can serve users beyond your test accounts.

## Deploy to Render, Vercel, and MongoDB Atlas

This repository is one Next.js application, not separate frontend and backend
projects. For a Vercel deployment, keep the app as a single Next.js service and
omit any `/api/*` rewrite to a placeholder host; the app can handle its API
routes directly on Vercel. The older Render-only rewrite in `vercel.json` was a
placeholder and should not be kept in a production deployment. This is a
single-app deployment arrangement, not a code-level separation of frontend and
backend.

### 1. Deploy the Next.js server to Render

1. Push this repository to GitHub and create a Render **Web Service** from it.
   Select the correct repository and branch. Set **Root Directory** to `.`
   (the repository root, where `package.json` and `package-lock.json` are
   located) and select the Node runtime.
2. Use these commands:

   ```text
   Build command: npm ci --include=dev && npm run build
   Start command: npm run start
   ```

   The build command explicitly includes development dependencies because
   TypeScript is required by Next.js to load `next.config.ts` and type-check the
   production build, even when Render sets `NODE_ENV=production`. `package.json`
   defines `build` as `next build` and `start` as `next start`.
   Choose Node.js **24.x LTS** in Render's runtime settings (or set
   `NODE_VERSION` to the current supported 24.x release). Render supplies the
   listening port through `PORT`; do not add or hard-code a port.
3. After the first successful deployment, copy the service's public HTTPS
   hostname, such as `https://my-notion-api.onrender.com`.
4. Edit `vercel.json` and replace
   `https://YOUR-RENDER-SERVICE.onrender.com` with that exact hostname. Keep
   the `/api/:path*` suffix. Commit and push this change before deploying the
   Vercel project so API requests do not point to the placeholder.

### 2. Add environment variables to Render

Render runs the API routes, so put the app's server-side configuration and
provider credentials in **Render → Web Service → Environment**. Add one
environment variable per row (do not paste the `.env.example` file as a
single value). The minimum working configuration is:

```dotenv
NOTION_API_KEY=your_notion_integration_secret
NOTION_DATABASE_ID=your_notion_database_id
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
CLERK_SECRET_KEY=your_clerk_secret_key
ALLOWED_EMAILS=your_verified_clerk_email@example.com
```

The Clerk variables are also needed on Vercel (next section), because both
deployments run the app's Clerk middleware. `ALLOWED_EMAILS` is checked by the
backend routes and belongs on Render.

For Atlas-backed features, set:

```dotenv
MONGO_URI=mongodb+srv://...
MONGO_DB_NAME=asladin_command_center
```

Add optional provider variables to Render only when you enable the feature:

| Feature | Variables |
| --- | --- |
| AI assistant | `GEMINI_API_KEY` |
| Web research | `TAVILY_API_KEY` |
| Google Workspace | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_CALLBACK_URL`, `SESSION_SECRET` |
| GitHub App | `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_URL` |

MongoDB is optional unless you use Telegram or another Mongo-backed integration:
set both `MONGO_URI` and `MONGO_DB_NAME` on Render. Missing MongoDB settings do
not prevent the app from starting; Mongo-backed features report a configuration
error when used. The app also accepts the legacy database-name variable
`MONGO_DATABASE_NAME`, but use `MONGO_DB_NAME` for new deployments.

The following Notion property overrides are optional. Add only the ones whose
default property names differ from your Notion database; the defaults shown
match `.env.example`:

| Variable | Default property |
| --- | --- |
| `NOTION_TITLE_PROPERTY` | `Item` |
| `NOTION_STATUS_PROPERTY` | `Status` |
| `NOTION_PRIORITY_PROPERTY` | `Priority` |
| `NOTION_TYPE_PROPERTY` | `Type` |
| `NOTION_DUE_DATE_PROPERTY` | `Date` |
| `NOTION_AREA_PROPERTY` | `Area` |
| `NOTION_COURSE_PROPERTY` | `Course` |
| `NOTION_COURSE_CODE_PROPERTY` | `Course Code` |
| `NOTION_ESTIMATED_HOURS_PROPERTY` | `Estimated Hours` |
| `NOTION_ASSESSMENT_PROPERTY` | `Assessment Type` |
| `NOTION_ACTUAL_HOURS_PROPERTY` | `Actual Hours` |
| `NOTION_CREDIT_HOURS_PROPERTY` | `Credit Hours` |
| `NOTION_DELIVERABLE_PROPERTY` | `Deliverable` |
| `NOTION_INSTRUCTOR_PROPERTY` | `Instructor` |
| `NOTION_PEOPLE_INSTRUCTOR_PROPERTY` | `People / Instructor` |
| `NOTION_MARKS_GRADE_PROPERTY` | `Marks / Grade` |
| `NOTION_NEXT_REVIEW_DATE_PROPERTY` | `Next Review Date` |
| `NOTION_NOTES_PROPERTY` | `Notes` |
| `NOTION_RECURRENCE_PROPERTY` | `Recurrence` |
| `NOTION_RESOURCE_LINK_PROPERTY` | `Resource Link` |
| `NOTION_SEMESTER_PROPERTY` | `Semester` |
| `NOTION_TIME_BLOCK_PROPERTY` | `Time Block` |
| `NOTION_VENUE_LINK_PROPERTY` | `Venue / Link` |
| `NOTION_NEXT_ACTION_PROPERTY` | `Next Action` |
| `NOTION_COMPLETED_PROPERTY` | `Completed` |

`NOTION_TOKEN` is accepted as an alternative to `NOTION_API_KEY`. Never put
server secrets in a `NEXT_PUBLIC_*` variable. After changing Render
environment variables, redeploy or restart the service.

### 3. Deploy the website to Vercel

1. Import the same GitHub repository and branch into Vercel as a Next.js
   project. Set **Root Directory** to `.` (the folder containing
   `package.json`, `package-lock.json`, and `vercel.json`), use the Next.js
   framework preset, and choose Node.js **24.x** in the project settings.
   Leave **Build Command** as the detected default `npm run build` (equivalent
   to `next build` here), and leave the output directory at its Next.js
   default. Vercel installs dependencies from the lockfile.
2. Set these two variables in **Vercel → Project → Settings → Environment
   Variables**, for the environments you deploy:

   ```dotenv
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   CLERK_SECRET_KEY=your_clerk_secret_key
   ```

   To enable Sentry, also set `NEXT_PUBLIC_SENTRY_DSN` in Vercel and on Render.
   Vercel needs it at build time for browser events; Render needs it at runtime
   for server and edge events.

   Use the same Clerk application and matching keys as on Render. Do not add
   the Notion, MongoDB, AI, Google, GitHub, Telegram, or `ALLOWED_EMAILS`
   secrets to Vercel for this arrangement; the API requests are proxied to
   Render. The Clerk secret is required by middleware and must remain server
   side.
3. In the repository's `vercel.json`, replace
   `https://YOUR-RENDER-SERVICE.onrender.com` with the actual Render HTTPS
   hostname before deploying. Commit and push the change.
4. Deploy Vercel and open the assigned production URL. The root
   `vercel.json` forwards `/api/*` to Render; Vercel continues to serve the
   Next.js page and its static assets.

### 4. Set public callback URLs

Use the Vercel production domain (or your custom public domain) for provider
callbacks and webhooks; Vercel proxies these API paths to Render.

- For Google OAuth, set both `GOOGLE_REDIRECT_URI` and `GOOGLE_CALLBACK_URL`
  on Render to `https://YOUR-VERCEL-DOMAIN/api/google/callback` and register
  that exact URL in the Google OAuth client. The two variables must match.
- For Telegram, set `TELEGRAM_WEBHOOK_URL` on Render to
  `https://YOUR-VERCEL-DOMAIN/api/telegram/webhook`.
- Configure the Clerk application for the Vercel public domain. Sign-in takes
  place on Vercel, and API calls reach Render with the user's session.

If you use a custom domain, use it as the public URL consistently and update
the corresponding Clerk, Google, and Telegram settings. Redeploy after
changing environment variables or `vercel.json`.

### 5. Configure MongoDB Atlas

Create an Atlas database user restricted to the application database, then
copy the Atlas `mongodb+srv://` connection string into Render's `MONGO_URI`
and set `MONGO_DB_NAME` to the database name in that URI. In Atlas **Network
Access**, allow the Render service's outbound IP addresses when available. Avoid
`0.0.0.0/0` unless necessary; it allows connections from any IP and should
only be used with a strong, least-privilege database user. MongoDB stores
integration state and short-lived approvals, not the planner tasks.

### Deployment checks and limitations

1. Sign in at the Vercel production domain using a verified Clerk email listed
   in Render's `ALLOWED_EMAILS`.
2. Confirm the dashboard loads its planner data and try one normal API-backed
   action. Check Render logs if API calls fail; the API executes there.
3. If a write returns a same-origin `403`, inspect how the proxy forwards the
   original host headers. Do not remove the origin checks to make the request
   pass.
4. If using MongoDB-backed features, verify Atlas network access and the two
   MongoDB variables on Render.

Both providers build the same Next.js code, and the application middleware
runs on both deployments. The rewrite keeps browser API calls on the Vercel
origin, while Render remains directly reachable at its own service URL. This
setup is convenient for a single repository, but it is not an independent
frontend/backend split; a separate backend would require a dedicated API
architecture and corresponding authentication/origin changes.

Do **not** upload `.env.local`, commit credentials, or expose server secrets
with a `NEXT_PUBLIC_` prefix. `.env.example` contains variable names and
placeholders, not values to copy into production.

## Security notes

- `.env.local` is excluded by `.gitignore`; `.env.example` contains placeholders
  only. Check that your real token is not in a commit before pushing.
- Never expose the token in a `NEXT_PUBLIC_...` variable, client component, or
  browser request.
- Sentry receives unhandled application errors and console logs at `log`,
  `warn`, and `error` levels when `NEXT_PUBLIC_SENTRY_DSN` is configured. Do
  not log API keys, session tokens, or private planner contents. Performance
  traces are sampled at 100% in development and 10% otherwise. Session replay
  is not enabled.
- `GEMINI_API_KEY` is sent to Google only from the server. Planner task details
  are sent to Gemini when using the assistant; do not use it if you do not want
  that data processed by Google.
- Google OAuth tokens are encrypted in a short-lived HTTP-only cookie, not
  exposed to client JavaScript, and scoped to `/api/google`. In the Personal
  secretary tool, up to three unread email bodies and the current task/event
  snapshot are sent to Gemini only after the user submits a question. Disconnect
  revokes the active Google access token. No refresh token or activity history
  is stored.
- `TAVILY_API_KEY` is sent only from the server. Research queries are sent to
  Tavily and retrieved snippets are passed to Gemini for a cited summary.
- Uploaded files are limited to 3 MB and processed for the current request;
  the application does not save them. Gemini may receive the file content for
  analysis or database drafting.
- Day planning sends the selected date and device time zone to this app's
  server; the server requests prayer times for Harar from AlAdhan. No precise
  device location is collected.
- Clerk middleware requires sign-in, and each task API method separately
  checks the signed-in user's verified email against the server-only
  `ALLOWED_EMAILS` allowlist. The dashboard UI is not the security boundary.
- Configure Clerk's sign-in settings and verify the intended account email.
  The API denies access when `ALLOWED_EMAILS` is missing or does not match.
- The POST route also checks same-origin requests and validates values against
  the Notion database schema. Keep the integration scoped to the pages it needs.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| “Add `NOTION_API_KEY` and `NOTION_DATABASE_ID`...” | Fill both values in `.env.local` and restart `npm run dev`. `NOTION_TOKEN` is also accepted instead of `NOTION_API_KEY`. |
| Clerk reports missing keys | Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` locally and in the Vercel project, then restart or redeploy. |
| Sentry does not show events | Set `NEXT_PUBLIC_SENTRY_DSN` in Vercel and Render, then rebuild/redeploy both services. |
| Planner assistant reports a missing Gemini key | Set `GEMINI_API_KEY` in `.env.local` or the Vercel environment, then restart or redeploy. |
| Google connection setup fails | Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a 32-character `SESSION_SECRET`; ensure both callback URL variables match the URI registered in Google Cloud Console, then redeploy. |
| Google asks to reauthorize | The stateless Google session expires within one hour. Reconnect from the dashboard; persistent refresh tokens are not stored. |
| Web research reports a missing Tavily key | Add `TAVILY_API_KEY` to `.env.local` or the Vercel environment, then restart or redeploy. |
| Gemini rejects the API key | Check that `GEMINI_API_KEY` is valid and that the Gemini API is enabled for its Google project. |
| Sign-in works but planner access is denied | Verify the signed-in email in Clerk and add the exact address to server-side `ALLOWED_EMAILS`. |
| Notion returns 401 | Check that the integration secret is correct and active. |
| Notion returns 404 | Check the database ID and share that database with the integration. |
| A task option is rejected | Refresh the dashboard and select an option that currently exists in Notion. |
| Creating an item reports a property error | Check the relevant property name and type in Notion, then correct the corresponding variable in `.env.local`. |
| The dashboard shows no tasks | Check that the integration has read access and that the shared database contains planner pages. |
| The task list is longer than 2,000 items | Add a Notion database filter before extending the pagination limit. |
| A development popup says “Try Turbopack” | This is a Next.js development suggestion, not a Notion connection error. It is safe to dismiss. |

## Ideas for learning and extending the project

If you are using this app to understand web development, these are useful
starting points:

1. Read `app/page.tsx` from top to bottom. Notice how React `useState` stores
   the tasks, loading state, search text, and open form state.
2. Follow `loadTasks` from the page into `GET /api/tasks`, then into
   `fetchNotionTasks` in `lib/notion.ts`. This is a complete example of data
   moving from a browser through a server to an external API and back.
3. Follow the create form's `submitTask` into `POST /api/tasks` and
   `createNotionTask`. Compare the form's values with the actual property
   payload sent to Notion.
4. Read `lib/types.ts` to see how TypeScript describes the task and API
   response shapes.
5. Read `components/dashboard-charts.tsx` to see how grouped data becomes
   charts using Recharts.
6. Change a visual rule in `app/globals.css`, run `npm run dev`, and see how
   Next.js updates the page while it is running.
7. After a change, run `npm run lint` and `npm run build`. A successful build
   checks TypeScript types and produces the production app.

Good next features to learn include filtering by status or area, editing a
Notion page with a validated `PATCH` API route, adding authentication, and
writing automated tests around the Notion-property mapping.
