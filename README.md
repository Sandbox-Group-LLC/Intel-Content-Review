# Intel Event Content Review

An internal tool for managing and scoring breakout session submissions for Intel events. Built to replace a manual, PowerPoint-based review process with an AI-powered workflow that scores submissions against event goals, enriches abstracts, and tracks review status across a team.

Live: [https://intel-event-content-review.forge-os.ai](https://intel-event-content-review.forge-os.ai)

---

## Overview

Intel Event Content Review lets event teams define an event's strategic objectives, collect session submissions, and run AI scoring against those objectives — all in one place. Reviewers can manage submission status, add notes, enrich abstracts with AI, and export the full submission set to CSV.

The app was purpose-built for Intel Federal Summit 2026 but is designed to support any Intel event. Each event has its own AI system prompt, derived from the event's strategy document, which governs how submissions are scored.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express (CommonJS) |
| Frontend | Vanilla JS + HTML/CSS, fully inlined in `index.html` |
| Database | Neon PostgreSQL via `@neondatabase/serverless` |
| AI — Profile Generation | Claude (claude-3-haiku) |
| AI — Scoring & Enrichment | Gemini 2.5 Pro |
| File Parsing | Multer (in-memory) |
| Markdown Rendering | Showdown |
| Hosting | Render (service ID: `srv-d6utqi9j16oc738tkpe0`) |

---

## Environment Variables

| Variable | Description |
|---|---|
| `APP_DATABASE_URL` | Neon PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Used for event profile generation |
| `GEMINI_API_KEY` | Used for AI scoring and abstract enrichment |
| `PORT` | Optional, defaults to 3000 |

All variables are injected at runtime via Render. No `.env` file is used.

---

## Database Schema

Three tables, auto-created on startup via `ensureSchema()`.

### `events`
Stores event metadata and the AI configuration used for scoring.

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | Event name |
| `event_date` | TEXT | Display date |
| `venue` | TEXT | Venue name |
| `slot_count` | INTEGER | Total available session slots |
| `context_profile` | TEXT | Human-readable event summary for submitters |
| `ai_system_prompt` | TEXT | System prompt used by the AI scorer — generated from the event strategy document |
| `created_at` | TIMESTAMPTZ | |

### `submissions`
One row per session submission, linked to an event and optionally to a speaker.

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `event_id` | INTEGER FK | Parent event |
| `speaker_id` | INTEGER FK | Primary speaker (optional) |
| `title` | TEXT | Session title |
| `content_lead` | TEXT | Content lead name |
| `bu` | TEXT | Intel Business Unit |
| `track` | TEXT | Content track |
| `format` | TEXT | Session format |
| `duration` | TEXT | Session length |
| `abstract` | TEXT | Original abstract |
| `enriched_abstract` | TEXT | AI-enriched abstract (HTML) |
| `key_topics` | TEXT | |
| `demos` | TEXT | |
| `featured_products` | TEXT | |
| `business_challenge` | TEXT | |
| `partner_highlights` | TEXT | |
| `new_launches` | TEXT | |
| `reviewer_notes` | TEXT | Manual reviewer notes |
| `status` | TEXT | `submitted` / `under_review` / `approved` / `declined` |
| `ai_score` | JSONB | Full AI scorecard (see scoring section) |
| `created_at` | TIMESTAMPTZ | |

### `speakers`
Speaker profiles with optional headshot storage.

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `event_id` | INTEGER FK | Parent event |
| `full_name` | TEXT | |
| `title` | TEXT | |
| `company` | TEXT | |
| `email` | TEXT | |
| `bio` | TEXT | |
| `headshot` | BYTEA | Binary image data |
| `headshot_mimetype` | TEXT | e.g. `image/jpeg` |
| `created_at` | TIMESTAMPTZ | |

---

## AI Features

### Event Profile Generation

`POST /api/events/generate-profile`

Accepts a raw strategy document (POR deck content, goals, KPIs, audience definitions, content pillars) and passes it to Claude. Returns two structured outputs:

- **`context_profile`** — a concise human-readable summary of the event for content submitters
- **`ai_system_prompt`** — a detailed scoring rubric prompt that governs all AI scoring for this event

This prompt is stored on the event record and used as the system message for every scoring call.

### AI Scoring

`POST /api/submissions/:id/score`

Sends a submission's key fields to Gemini 2.5 Pro using the parent event's `ai_system_prompt`. Returns a structured scorecard stored in `submissions.ai_score` as JSONB.

**Scorecard structure:**

```json
{
  "overall": 0–100,
  "federal_relevance":    { "score": 0–100, "rationale": "..." },
  "technical_depth":      { "score": 0–100, "rationale": "..." },
  "intel_alignment":      { "score": 0–100, "rationale": "..." },
  "audience_fit":         { "score": 0–100, "rationale": "..." },
  "innovation_signal":    { "score": 0–100, "rationale": "..." },
  "delivery_readiness":   { "score": 0–100, "rationale": "..." },
  "strengths": ["..."],
  "gaps": ["..."],
  "recommendation": "Accept | Accept with Revisions | Decline"
}
```

### Abstract Enrichment

`POST /api/submissions/:id/enrich`

Sends the original abstract to Gemini 2.5 Pro with the event's `context_profile` as context. Returns a refined version of the abstract — clearer, more impactful, audience-aligned — without changing the technical substance. Stored as HTML in `enriched_abstract`.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events` | List all events |
| `POST` | `/api/events` | Create an event |
| `PUT` | `/api/events/:id` | Update an event |
| `POST` | `/api/events/generate-profile` | Generate AI event profile from raw context |
| `GET` | `/api/submissions` | List submissions (filterable by `event_id`, `status`, `track`, `bu`) |
| `POST` | `/api/submissions` | Create a submission |
| `PUT` | `/api/submissions/:id` | Update a submission |
| `POST` | `/api/submissions/:id/score` | Run AI scoring on a submission |
| `POST` | `/api/submissions/:id/enrich` | Run AI abstract enrichment |
| `GET` | `/api/submissions/export` | Export all submissions for an event as CSV |
| `GET` | `/api/speakers` | List speakers for an event |
| `POST` | `/api/speakers` | Create a speaker (supports headshot upload) |
| `PUT` | `/api/speakers/:id` | Update a speaker |
| `DELETE` | `/api/speakers/:id` | Delete a speaker |
| `GET` | `/api/speakers/:id/headshot` | Serve speaker headshot image |
| `GET` | `/api/assets/:filename` | Serve static assets (fonts, logo) |
| `GET` | `/` | Serve the full frontend application |

---

## Design System

The frontend implements the Intel design system exactly:

- **Font:** Intel One Display (Light 300, Regular 400, Medium 500, Bold 700) — loaded from `/api/assets/`
- **Colors:**
  - Energy Blue `#00AAE8` — primary accent, CTAs, active states
  - Cobalt `#000864` — sidebar, nav backgrounds
  - Carbon Light `#EAEAEA` — page and card backgrounds
  - Carbon Dark `#2E2F2F` — body text, secondary surfaces
- **UI rules:** `border-radius: 0` on all elements, no shadows, borders instead of depth, square badges for status and scores

---

## Seed Data

On first startup, if the `events` table is empty, the app seeds:

**Intel Federal Summit 2026**
- April 27–28, 2026 — Marriott Westfields, Chantilly, VA
- 12 session slots (4 rooms × 3 blocks)
- Full AI system prompt configured for federal/defense audience
- 6 seed submissions across all content tracks (Agentic AI, Data Center/HPC, Edge & Embedded Systems, Commercial Client, Foundry)

---

## Deployment

The app is deployed on Render as a single Node.js service. Auto-deploys on push to `main`.

```bash
npm start
# → node server.js
```

No build step. No bundler. The entire frontend is served as a single static `index.html` file.

---

## Repository Structure

```
├── server.js        # Express backend, all API routes, AI integrations, DB schema
├── index.html       # Complete frontend — HTML, CSS, and JS in one file
├── package.json     # Dependencies
└── package-lock.json
```