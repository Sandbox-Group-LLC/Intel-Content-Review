# Intel Event Content Review

An internal tool for managing and AI-scoring breakout session submissions for Intel events. Built to replace a manual PowerPoint-based review process with an intelligent workflow that scores submissions against event goals, enforces quality gates, injects institutional memory, coaches content owners, and tracks review status across a team.

Live: [https://intel-event-content-review.forge-os.ai](https://intel-event-content-review.forge-os.ai)

---

## Overview

Intel Event Content Review lets event teams define an event's strategic objectives, collect session submissions, and run AI scoring against those objectives — all in one place. The system learns from every event cycle through a Voyager AI-powered memory brain, enforces submission quality gates, generates coaching reports for content owners, and sends notifications via email. A submitter portal gives content owners direct access to their scores and coaching without admin access.

Built for Intel Federal Summit 2026 and designed to support any Intel event. Each event has its own AI system prompt, derived from the event's strategy document, which governs how submissions are scored.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express (CommonJS) |
| Frontend | Vanilla JS + HTML/CSS (`index.html`) |
| Database | Neon PostgreSQL via `@neondatabase/serverless` + pgvector |
| AI — Profile Generation | Claude (claude-sonnet-4-6) |
| AI — Scoring & Enrichment | Claude (claude-sonnet-4-6) |
| AI — Coaching Reports | Claude (claude-sonnet-4-6) |
| Embeddings | Voyager AI (voyage-3, 768-dim) |
| Email | Resend |
| File Parsing | Multer (in-memory) |
| Hosting | Render (service ID: `srv-d6utqi9j16oc738tkpe0`) |

---

## Environment Variables

| Variable | Description |
|---|---|
| `APP_DATABASE_URL` | Neon PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Used for all Claude API calls |
| `VOYAGER_API_KEY` | Used for embedding generation (Voyager AI voyage-3) |
| `RESEND_API_KEY` | Used for transactional email notifications |
| `EMAIL_FROM` | Sender address (optional, defaults to noreply@forge-os.ai) |
| `APP_URL` | Base URL for magic link generation (optional) |
| `PORT` | Optional, defaults to 3000 |

All variables are injected at runtime via Render. No `.env` file is used.

---

## Database Schema

Tables auto-created on startup via `ensureSchema()`.

### `events`
| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | Event name |
| `event_date` | TEXT | Display date |
| `venue` | TEXT | Venue name |
| `slot_count` | INTEGER | Total available session slots |
| `slug` | TEXT | URL slug for submitter portal |
| `notification_email` | TEXT | Reviewer email for submitter update notifications |
| `gate_50_deadline` | TEXT | Admin-defined 50% review deadline date |
| `gate_75_deadline` | TEXT | Admin-defined 75% review deadline date |
| `gate_90_deadline` | TEXT | Admin-defined 90% review deadline date |
| `context_profile` | TEXT | Human-readable event summary for submitters |
| `ai_system_prompt` | TEXT | System prompt used by AI scorer — generated from event strategy document |
| `created_at` | TIMESTAMPTZ | |

### `submissions`
| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `event_id` | INTEGER FK | Parent event |
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
| `status` | TEXT | `submitted` / `under_review` / `approved` / `declined` / `needs_revision` |
| `disclosure_flag` | BOOLEAN | Auto-detected roadmap/launch language |
| `nda_required` | BOOLEAN | NDA flag |
| `nda_approver` | TEXT | NDA approver name |
| `ai_score` | JSONB | Full AI scorecard |
| `memory_insights` | JSONB | Memory entries that influenced the score |
| `coaching_report` | JSONB | AI coaching report |
| `score_delta` | INTEGER | Score improvement from first version |
| `version_number` | INTEGER | Current version number |
| `created_at` | TIMESTAMPTZ | |

### `speakers`
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
| `headshot_mimetype` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `submission_gates`
Persists gate evaluation results per submission.

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `submission_id` | INTEGER FK | |
| `gate` | TEXT | `gate_50` / `gate_75` / `gate_90` |
| `score` | INTEGER | 0–100 completeness score |
| `level` | TEXT | `pass` (0–49) / `warn` (50–79) / `block` (80–100) |
| `checked_at` | TIMESTAMPTZ | |
| `blocking_fields` | JSONB | Fields preventing advancement |

### `submission_conflicts`
Stores detected topic overlap conflicts between submissions.

### `submission_versions`
Version history snapshots for every submission save.

### `event_memories`
Voyager AI-embedded lessons from past events.

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | |
| `event_id` | INTEGER FK | |
| `category` | TEXT | `what_worked` / `what_didnt` / `speaker_insight` / `topic_trend` / `audience_signal` / `kpi_outcome` |
| `content` | TEXT | Memory lesson text |
| `embedding` | vector(768) | Voyager AI embedding for similarity search |
| `signal_strength` | FLOAT | 0.1–3.0, adjustable via upvote/downvote |
| `source` | TEXT | `manual` / `auto_extracted` / `survey` |
| `created_at` | TIMESTAMPTZ | |

### `survey_responses`
Post-event survey data per session, imported from Evolio/Cvent CSV.

### `speaker_history`
Cross-event speaker performance tracking, auto-updated from survey imports.

### `magic_link_tokens`
Time-limited tokens for submitter portal access (72hr expiry).

---

## AI Features

### Event Profile Generation
`POST /api/events/generate-profile`

Accepts a raw strategy document and passes it to Claude. Returns a structured event profile and a detailed scoring rubric (`ai_system_prompt`) stored on the event record.

### AI Scoring
`POST /api/submissions/:id/score`

Before scoring, retrieves top-5 relevant memories via pgvector cosine similarity search and injects them into the Claude system prompt as past event insights. Scores across six universal dimensions:

| Dimension | Description |
|---|---|
| `audience_fit` | Content appropriate for this event's specific audience |
| `intel_alignment` | Showcases Intel silicon, software, or ecosystem meaningfully |
| `technical_depth` | Substantive for the technical buyers this event targets |
| `strategic_value` | Advances Intel's goals — pipeline, preference, trust, thought leadership |
| `partner_ecosystem_value` | Includes customer/partner voices that add credibility |
| `delivery_readiness` | Speakers confirmed, format appropriate, abstract clear |

Returns `overall` (0–100), dimension scores + rationale, strengths, gaps, recommendation.

### AI Coaching Reports
`POST /api/submissions/:id/coach`

Generates a structured coaching report grounded in gate status, memory brain, and event context. Returns: critical fixes, high-impact improvements, quick wins, past event examples, and an overall coaching note.

### Abstract Enrichment
`POST /api/submissions/:id/enrich`

Refines the original abstract for clarity and audience alignment without changing technical substance.

### Lesson Extraction
`POST /api/events/:id/memories/extract-lessons`

After survey import, Claude extracts 5–10 structured lessons from aggregate data. Each lesson is embedded with Voyager AI and stored in `event_memories` for future scoring augmentation.

---

## Quality Gates

Three milestone gates (50% / 75% / 90%) with admin-defined deadlines. Each gate is evaluated on a 0–100 completeness score:

| Score | Level | Behavior |
|---|---|---|
| 0–49 | Pass | No intervention |
| 50–79 | Warn | Advisory shown, reviewer can proceed |
| 80–100 | Block | Hard stop — status cannot advance |

Gate deadlines, disclosure flags (roadmap/NDA language detection), and topic overlap conflict detection all run automatically.

---

## Submitter Portal

`GET /submit/token/:token`

A self-contained Intel-branded page accessible via magic link (72hr expiry). Submitters can view their score, coaching report, and update content fields. Reviewer is notified by email on every submitter update.

Trigger magic link: `POST /api/submissions/:id/magic-link`

---

## Email Notifications (Resend)

| Trigger | Recipient |
|---|---|
| Submission scored | Content lead |
| Status changed | Content lead |
| Gate blocked | Content lead |
| Magic link requested | Submitter |
| Submitter updated submission | Reviewer (notification_email) |

All Intel addresses follow `first.last@intel.com` format and are derived automatically from the content_lead field.

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
| `POST` | `/api/submissions/:id/score` | Run AI scoring |
| `POST` | `/api/submissions/:id/coach` | Generate coaching report |
| `POST` | `/api/submissions/:id/enrich` | Run AI abstract enrichment |
| `GET` | `/api/submissions/:id/gates` | Evaluate and return gate status |
| `GET` | `/api/submissions/:id/conflicts` | Return detected topic conflicts |
| `GET` | `/api/submissions/:id/versions` | Version history |
| `POST` | `/api/submissions/:id/magic-link` | Send submitter portal magic link |
| `GET` | `/api/events/:id/memories` | List memories for event |
| `POST` | `/api/events/:id/memories` | Manually add a memory |
| `PUT` | `/api/memories/:id/signal` | Upvote/downvote memory signal strength |
| `DELETE` | `/api/memories/:id` | Delete a memory |
| `POST` | `/api/events/:id/memories/import-survey` | Ingest post-event survey CSV |
| `POST` | `/api/events/:id/memories/extract-lessons` | Extract AI lessons from survey data |
| `GET` | `/api/events/:id/survey` | Survey aggregate stats + per-session breakdown |
| `GET` | `/api/submissions/export` | CSV export for an event |
| `GET` | `/api/speakers` | List speakers for an event |
| `POST` | `/api/speakers` | Create a speaker (supports headshot upload) |
| `PUT` | `/api/speakers/:id` | Update a speaker |
| `DELETE` | `/api/speakers/:id` | Delete a speaker |
| `GET` | `/api/speakers/:id/headshot` | Serve speaker headshot image |
| `GET` | `/api/assets/:filename` | Serve static assets (fonts, logo) |
| `GET` | `/submit/token/:token` | Submitter portal page |
| `GET` | `/api/submit/verify/:token` | Verify magic link token |
| `PUT` | `/api/submit/:token` | Submitter updates submission via portal |
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
- 6 seed submissions across all content tracks (Agentic AI, Data Center/HPC, Edge & Embedded Systems, Commercial Client)

---

## Deployment

Deployed on Render as a single Node.js service. Auto-deploys on push to `main`.

```bash
npm start
# → node server.js
```

No build step. No bundler. The frontend is served as `index.html`.

---

## Repository Structure

```
├── server.js          # Express backend — all API routes, AI integrations, DB schema, gate engine
├── index.html         # Complete frontend — HTML, CSS, and JS in one file
├── package.json       # Dependencies
├── V2_WHITEBOARD.md   # v2 planning document — phases, decisions, build checklist
└── package-lock.json
```

---

## v2 Status

| Phase | Status | Description |
|---|---|---|
| Phase 1 — Gates & Compliance | ✅ Complete | Gate evaluation engine, disclosure flags, conflict detection |
| Phase 2 — Memory Brain | ✅ Complete | pgvector + Voyager AI, survey ingestion, memory-augmented scoring |
| Phase 3 — Coaching & Portal | ✅ Complete | Coaching reports, magic links, submitter portal, Resend email |
| Phase 4 — Program Intelligence | 🔲 Planned | Program health dashboard, KPI benchmarking, trend analytics |
| Phase 4.5 — Competitive Intelligence | 🔲 Planned | Perplexity Sonar + Sonnet + Haiku agent stack, whitespace analysis |

See `V2_WHITEBOARD.md` for full planning detail, decisions, and build checklist.
