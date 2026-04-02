# Intel Event Content Review

**Live:** https://intel-event-content-review.forge-os.ai  
**Repo:** Sandbox-Group-LLC/Intel-Content-Review (branch: main)  
**Deploy:** Render — auto-deploys on push to main

---

## Stack

- **Runtime:** Node.js + Express (CommonJS), single `server.js` + `index.html`
- **Database:** Neon PostgreSQL + pgvector
- **AI:** Claude claude-sonnet-4-6 (scoring, coaching, enrichment), Voyage AI voyage-3 (embeddings), Haiku claude-haiku-4-5-20251001 (reframes)
- **Email:** Resend — `FROM_EMAIL: Intel Content Review <noreply@makemysandbox.com>`
- **Competitive Intel:** Perplexity Sonar
- **PPTX Parsing:** adm-zip (CFP upload path)

### Environment Variables (Render)
`ANTHROPIC_API_KEY` · `VOYAGER_API_KEY` · `RESEND_API_KEY` · `PERPLEXITY_API_KEY` · `APP_DATABASE_URL`

---

## Intel Design System

| Token | Value |
|---|---|
| Energy Blue | `#00AAE8` |
| Cobalt | `#000864` |
| Carbon Light | `#EAEAEA` |
| Carbon Dark | `#2E2F2F` |

- Font: Intel One Display (served from `/api/assets/`)
- `border-radius: 0` everywhere — no shadows, no gradients, no emojis
- Favicon: Intel blue square logo embedded as base64 at `/favicon.png`

---

## Architecture

### Background AI Job Processor (CRITICAL)

Render hard-kills HTTP connections at 30s. Claude calls take 30-40s.

**Solution:** Persistent `setInterval` background processor started at boot:
- `ai_jobs` table: `submission_id`, `job_type` (score/coach), `status` (pending/running/done/error), timestamps
- `/score` and `/coach` routes: insert job row, return `{ok:true, job_id}` in <100ms
- `processJobs()` runs every 5s, claims jobs atomically via `UPDATE ... WHERE id = (SELECT ... LIMIT 1)`
- `runScoringJob()` + `runCoachingJob()` contain full intelligence logic
- `GET /api/jobs/:id` — client polls for status + result
- UI polls every 5s, auto-renders when `status === 'done'`, 3-min safety cutoff

### Three-Layer Intelligence Stack (injected into every score)

1. **Event goals** — `evt.ai_system_prompt` (configured per event)
2. **Memory brain** — top-5 past event insights via pgvector cosine similarity (voyage-3 embeddings)
3. **Competitive landscape** — Owned/Contested/Unclaimed topic context matched to submission track
4. **CFP source flag** — if `source='cfp'`, Claude gets note that this is a speaker-direct proposal

---

## Competitive Intelligence — Additional Context

The `/competitive/run` endpoint accepts three optional body fields that augment (not override) the auto-detected pipeline:

| Field | Effect |
|---|---|
| `known_competitors` | Injected into Perplexity Sonar as explicit research targets |
| `audience_notes` | Appended to auto-detected audience context from event system prompt |
| `strategic_notes` | Injected into Claude classifyGaps system prompt as positioning anchor |

All fields are purely additive — blank input is a no-op. Auto-detection runs regardless.

UI: Collapsible "Additional Context (optional)" panel above the Run Analysis button on the Competitive tab.

---

## Database Schema

### Core Tables

**events** — id, name, event_date, venue, slot_count, slug, notification_email, gate deadlines, context_profile, ai_system_prompt

**submissions** — id, event_id, title, content_lead, bu, track, format, duration, abstract, enriched_abstract, key_topics, demos, featured_products, business_challenge, partner_highlights, new_launches, reviewer_notes, status, disclosure_flag, nda_required, nda_approver, ai_score (JSONB), memory_insights (JSONB), coaching_report (JSONB), score_delta, version_number, competitive_analysis (JSONB), title_saturation_score, reframe_suggestions (JSONB), **source** (cfp/internal), **intel_speakers**, **partner_walkons**, **session_flow** (JSONB), **cfp_raw_filename**, **cfp_raw_file** (BYTEA)

**speakers, submission_speakers, submission_conflicts, submission_versions, submission_gates**

**event_memories** — vector(768), category, content, event_id

**survey_responses, speaker_history**

**magic_link_tokens** — 72hr expiry, submitter portal auth

**competitive_intelligence** — pillar, gap_analysis (JSONB), run_at

**cfp_config** — per-event: status (open/closed), deadline, welcome_heading, welcome_body, reply_to_email

**cfp_invitations** — token, event_id, email, name, sent_at, opened_at, submitted_at, submission_id, reminder_count

**ai_jobs** — submission_id, job_type, status, created_at, started_at, completed_at, error_msg

---

## AI Scoring — 6 Universal Dimensions

`audience_fit` · `intel_alignment` · `technical_depth` · `strategic_value` · `partner_ecosystem_value` · `delivery_readiness`

---

## Navigation

Events → Submissions → Review → Speakers → Competitive → Program → Memory → **Admin**

---

## v2.1 — CFP Speaker Portal System

### Phase 1 — Admin Tab
- CFP open/closed toggle per event, submission deadline (date picker), invitation email config (heading, body, reply-to)
- `cfp_config` + `cfp_invitations` schema
- Single invite (name + email → branded magic link email via Resend)
- Bulk invite (paste comma/newline/semicolon list)
- Invitation tracker: Invited / Opened / Submitted status chips, Resend + Revoke per row

### Phase 2 — Speaker CFP Portal (`/cfp/:slug/:token`)
- Invite-only (token required), one submission per magic link
- **Dual path:**
  - **Form:** all one-pager fields — title, format, duration, abstract, Intel speakers, partner walk-ons, session flow (5 segments with individual durations), key topics, demos, featured Intel products, partner highlights, new launches
  - **Upload:** drag-and-drop PPTX → server-side `adm-zip` parser extracts slide1.xml text nodes → pre-fills editable field preview → speaker reviews before submitting
- Return visits show submission status + coaching report if generated
- Confirmation email to speaker, reviewer notification to reply-to address

### Phase 3 — Review Integration
- `CFP` badge (Energy Blue chip) in submission table and detail panel
- Full three-layer intelligence stack injected into scoring for CFP submissions
- CFP source context: "speaker-direct proposal — score delivery_readiness accordingly"
- Speaker column falls back: `speaker_names → intel_speakers → content_lead`

---

## Key API Routes

| Method | Path | Description |
|---|---|---|
| POST | `/api/submissions/:id/score` | Queue scoring job → returns job_id |
| POST | `/api/submissions/:id/coach` | Queue coaching job → returns job_id |
| GET | `/api/jobs/:id` | Poll job status + result |
| GET/PUT | `/api/events/:id/cfp/config` | CFP config CRUD |
| GET | `/api/events/:id/cfp/invitations` | Invitation list with status |
| POST | `/api/events/:id/competitive/run` | Run competitive pipeline (accepts `known_competitors`, `audience_notes`, `strategic_notes` in body) |
| GET | `/api/events/:id/competitive` | Get competitive intelligence results |
| POST | `/api/events/:id/cfp/invite` | Single invite (resend-aware) |
| POST | `/api/events/:id/cfp/invite-bulk` | Bulk invite |
| DELETE | `/api/cfp/invitations/:id` | Revoke invite |
| GET | `/cfp/:slug/:token` | Speaker portal page |
| POST | `/api/cfp/:token/submit` | Submit via form |
| POST | `/api/cfp/:token/upload` | Upload + parse PPTX |
| GET | `/api/assets/:filename` | Proxy to forge-os.ai assets |
| GET | `/favicon.png` | Intel logo favicon (embedded base64) |

---

## Repo Protocol

- Always read README.md first (SSOT)
- Always fetch current file + capture SHA before writing
- Conventional commits: `feat:` `fix:` `refactor:` `style:`
- Never give Brian code to run — commit directly
- Write JS blocks to temp files, validate with `node --check` before committing

---

## Seed Data

Intel Federal Summit 2026 (event id=1), April 27-28 2026, Marriott Westfields Chantilly VA, 12 slots, 6 seed submissions across Agentic AI / Data Center / Edge / Commercial Client tracks.

---

## Known Constraints

- Render 30s HTTP timeout — solved via background job processor
- Assets proxied to `forge-os.ai` — favicon served locally as embedded base64
- No auth gate currently — PIN gate planned before client presentation, MS Entra ID TBD
- Memory seeding: first-time events benefit from 4-6 manually added memories via Memory Browser before first scoring run
