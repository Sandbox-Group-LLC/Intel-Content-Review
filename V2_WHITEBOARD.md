# Intel Event Content Review — v2 Whiteboard

> **Purpose of this document:** Living planning space for v2. Start here before touching code. Update it as decisions get made. Check off progress as features ship.

---

## Decisions Made

| # | Decision | Detail |
|---|---|---|
| 1 | Embedding model | **Voyager AI** — no additional API key, no OpenAI dependency |
| 2 | Submitter portal | **Yes, in scope for v2** — accessible via a separate slug one level removed from admin (e.g. `/submit/:eventSlug`) |
| 3 | Survey data format | **Intel/Evolio format confirmed** — see Survey Data section below for full field mapping |
| 4 | Gate enforcement strictness | **Three-level enforcement:** 0–49 = Pass (no block), 50–79 = Warn (advisory), 80–100 = Block (hard stop on status advance) |
| 5 | Notifications | **Email first** — Intel uses Teams/O365, all addresses are `first.last@intel.com` format |
| 6 | Auth | **Magic link for v2**, Microsoft Entra ID integration planned for v3 (noted: Entra ID = barf) |
| 7 | Transactional email | **Resend** — API key already in env vars |
| 8 | Voyager AI access | **VOYAGER_API_KEY** already set in Render env vars |
| 9 | Gate deadline dates | **Admin-defined per event** — dates change constantly, no auto-derivation |
| 10 | Ownership | **Claude owns this repo going forward** — direct commits via GitHub API, Render auto-deploy on every push to main |

---

## What v1 Is (Honest Baseline)

v1 is a solid, functional foundation. It does the job it was designed to do:

- Multi-event management with AI-generated event profiles
- Session submission intake (manual + PPTX upload parsing)
- AI scoring across 6 universal dimensions (audience_fit, intel_alignment, technical_depth, strategic_value, partner_ecosystem_value, delivery_readiness)
- Abstract enrichment
- Speaker management with headshots
- Status workflow (submitted → under review → approved → declined)
- CSV export
- Intel-branded UI, zero border-radius, IntelOneDisplay font

**What it is not yet:** A powerhouse. It moves submissions through a funnel but it doesn't make them materially better, it doesn't learn from past events, it doesn't enforce quality gates, and it has no memory. Every event starts from zero.

---

## The v2 Vision

> **From submission funnel to content excellence engine.**

v2 transforms the tool from a review tracker into an intelligent system that makes Intel's session content measurably better with every event cycle — by injecting institutional memory, enforcing compliance gates, and closing the feedback loop between audience outcomes and content quality.

**Three pillars:**

1. **Memory** — The system learns from every event. Survey results, attendance data, scoring outcomes, and reviewer decisions accumulate into a Voyager AI-powered brain that informs every future review.
2. **Gates** — Submissions don't just get scored. They move through defined compliance and quality gates before they're eligible for approval. Gate enforcement scales with gate score: Pass/Warn/Block.
3. **Iteration** — The system doesn't just evaluate content. It actively coaches content owners through a submitter portal, grounded in what has actually worked before.

---

## Survey Data Format (Intel/Evolio Standard)

Based on the 2025 Intel Vision & REC Post-Event Survey, here is the confirmed field structure that the survey import pipeline must handle.

### Per-Event Fields (Event Level)
| Field | Survey Question | Type |
|---|---|---|
| `overall_value` | "Rate the overall value you received from attending" | 5-pt scale (Excellent → Poor) |
| `nps_score` | "How likely are you to recommend Intel to a colleague?" | 0–10 NPS scale |
| `future_attendance` | "How likely are you to attend similar Intel events in the future?" | 5-pt scale |
| `partner_select_lift` | "As a result of attending, I am more likely to select Intel as my partner" | Yes / No / Unsure |
| `issues_addressed` | "Did the event address any of your current issues and challenges?" | Yes + text / No + text |
| `improvement_suggestions` | "Please provide any suggestions to improve in the future" | Open text |
| `most_valuable_takeaway` | "What was your most valuable takeaway?" | Open text |

### Per-Session Fields (Session Level)
| Field | Survey Question | Type |
|---|---|---|
| `session_satisfaction` | "Rate your overall satisfaction with this session" | 5-pt scale |
| `business_relevance` | "How useful was the information in this session to your current business priorities?" | 5-pt scale |
| `speaker_quality` | "Rate the speakers' presentation skills" | 5-pt scale |
| `session_comments` | "Please share any additional thoughts about this session" | Open text |

### KPI Targets (Hard-coded from Intel Standard)
These are the benchmarks against which survey results are measured — surface these prominently in the memory dashboard and program health view:

| KPI | Target |
|---|---|
| Overall event value (Excellent + Very Good) | 80% |
| Future attendance likelihood (Extremely + Very Likely) | 80% |
| Partner selection lift (Yes) | 75% |
| Session content useful to business priorities | 75% |
| Demo usefulness (Extremely + Very Useful) | 75% |
| Recommend Intel to colleague (NPS ≥ 8) | 75% |

### Trust/Confidence KPIs (Pre/Post Lift Tracking)
These are agreement statements tracked as pre/post lift — the memory brain should track these over time:
- "I am confident Intel can deliver on its product roadmap"
- "I trust Intel to help achieve my business outcomes"
- "I am familiar with Intel's products, solutions, and services"
- "Intel is a leading technology innovator"

### Registration Append Fields
Intel/Evolio appends registration data to survey responses. The import pipeline should handle:
- Respondent role / job title
- Industry / company type
- Registration category (agency, contractor, OEM, etc.)

### Import Format
Survey data is exported from Evolio as CSV. The import pipeline will:
1. Accept CSV upload via the admin UI
2. Auto-detect column headers and map to the schema above
3. Fuzzy-match session names to submission records (by title similarity)
4. Flag any sessions in the survey with no matching submission in the DB
5. Show a mapping review screen before committing the import
6. Extract verbatim text fields for vectorization into the memory brain

---

## What's Missing from v1 (Gap Analysis)

### Intelligence Gaps
- No institutional memory — every event starts cold
- No feedback loop — post-event survey results never ingested
- Static scoring rubric — doesn't evolve after event creation
- No cross-event pattern recognition

### Quality & Compliance Gaps
- No gate structure — TBD-heavy submissions can reach Approved status
- No completeness enforcement at defined milestones
- No brand/legal compliance check or disclosure flag routing
- No conflict detection between submissions

### Workflow Gaps
- No submission iteration path for content owners
- No notifications on score, status change, or deadline
- No deadline enforcement against the workback schedule
- No committee workflow (reviewer assignment, consensus)
- No submitter-facing portal

### Data Gaps
- No attendance or engagement data
- No speaker performance tracking across events
- No track saturation or thematic balance view

---

## v2 Feature Plan

### PHASE 1 — Quality Gates & Compliance Engine
*Goal: Make it impossible to approve a low-quality or non-compliant submission.*

#### 1.0 Gate Deadline Fields (Admin-Defined Per Event)
Three deadline date fields added to event creation/edit form:
- **Gate 50% deadline** — date by which all submissions must clear the 50% gate
- **Gate 75% deadline** — date by which all submissions must clear the 75% gate  
- **Gate 90% deadline** — date by which all submissions must clear the 90% gate

Deadlines surface in: program health dashboard readiness timeline, email reminder notifications (7 days out), and the gate checklist on each submission. Stored as `gate_50_deadline`, `gate_75_deadline`, `gate_90_deadline` TEXT columns on the events table.

#### 1.1 Gate Score System (Pass / Warn / Block)

Gates are evaluated on a 0–100 completeness score based on field population and quality signals. Enforcement scales with score:

| Score Range | Level | Behavior |
|---|---|---|
| 0–49 | **Pass** | No intervention — submission moves freely |
| 50–79 | **Warn** | Advisory flag shown — reviewer can override and proceed |
| 80–100 | **Block** | Hard stop — status cannot advance until blocking issues resolved |

Gate score is calculated from weighted field checks at each milestone:

**Gate 50% — Required Fields**
- Title populated
- Abstract populated (min 100 chars)
- BU assigned
- Track assigned
- Format and duration declared
- At least one Intel speaker named

**Gate 75% — Substance Check**
- All 50% fields pass
- Session flow defined
- Key topics populated
- Featured Intel products named (at least one)
- Partner/demo status declared (even "none" counts)

**Gate 90% — Completeness**
- All 75% fields pass
- Partner speakers confirmed or explicitly declined
- Demo confirmed or explicitly declined
- New launches / disclosures reviewed and flagged or cleared
- Abstract meets minimum quality threshold (AI-evaluated)

#### 1.2 Compliance Flag System
- Scan abstract and key topics for language suggesting new product launches, roadmap reveals, or NDA content
- Surface "Disclosure Review Required" badge — does not block but routes for review
- Explicit NDA yes/no field with required approver if yes
- "New launch" field from one-pager surfaced prominently with routing flag

#### 1.3 Conflict & Overlap Detection
When a submission is saved, scan other submissions in the same event:
- Same track + semantically overlapping key topics (Voyager AI similarity)
- Same speaker in potentially conflicting time slots
- Near-duplicate titles
Surface as warnings with links — not hard blocks

---

### PHASE 2 — Voyager AI Memory Brain
*Goal: The system learns from every event and injects that knowledge into every review.*

#### 2.1 Database Layer
Enable pgvector on Neon. New tables:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS event_memories (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  category TEXT, -- what_worked | what_didnt | speaker_insight | topic_trend | audience_signal | kpi_outcome
  content TEXT,
  embedding vector(768), -- Voyager AI embedding dimension
  signal_strength FLOAT DEFAULT 1.0,
  source TEXT, -- survey | manual | auto_extracted | outcome_data
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  submission_id INTEGER REFERENCES submissions(id),
  session_satisfaction INTEGER, -- 1-5
  business_relevance INTEGER, -- 1-5
  speaker_quality INTEGER, -- 1-5
  session_comments TEXT,
  overall_event_value INTEGER, -- 1-5 (event-level, repeated per row for denormalized querying)
  nps_score INTEGER, -- 0-10
  partner_select_lift TEXT, -- yes | no | unsure
  respondent_role TEXT,
  respondent_industry TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS speaker_history (
  id SERIAL PRIMARY KEY,
  full_name TEXT,
  email TEXT UNIQUE,
  events_count INTEGER DEFAULT 0,
  avg_speaker_rating FLOAT,
  avg_session_satisfaction FLOAT,
  avg_business_relevance FLOAT,
  sessions JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS submission_versions (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER REFERENCES submissions(id),
  version_number INTEGER,
  snapshot JSONB,
  ai_score JSONB,
  edited_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS submission_gates (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER REFERENCES submissions(id),
  gate TEXT, -- gate_50 | gate_75 | gate_90
  score INTEGER, -- 0-100
  level TEXT, -- pass | warn | block
  checked_at TIMESTAMPTZ,
  blocking_fields JSONB
);
```

#### 2.2 Memory Ingestion
- **Survey import:** CSV upload with auto-column mapping + fuzzy session matching + mapping review screen before commit
- **Outcome import:** Manual entry or CSV for attendance numbers, walkout rates, Q&A engagement
- **Auto-lesson extraction:** After import, Claude call extracts 5–10 structured lessons. Stored as categorized memories with Voyager embeddings.
- **KPI outcome tracking:** Session-level survey scores compared against Intel's standard KPI targets — stored as `kpi_outcome` memories
- **Speaker rating capture:** Auto-updates speaker_history from survey data

#### 2.3 Memory-Augmented Scoring
- Before scoring: Voyager similarity search against event_memories
- Retrieve top 5 most relevant memories by cosine similarity to submission abstract + topics
- Inject retrieved memories into scoring system prompt as additional context
- "Past Event Insight" section in scorecard UI showing which memories influenced the score
- Memory influence is weighted by signal_strength (upvote/downvote adjustable)

#### 2.4 Memory Dashboard
- Dedicated Memory tab
- Browse by event, category, signal strength
- Upvote/downvote to adjust influence weight
- Manually add memories
- See which memories have influenced the most scoring decisions
- KPI outcome history: how did this event's sessions perform against Intel's standard targets?

---

### PHASE 3 — Submission Coaching & Iteration Engine
*Goal: Don't just score submissions — make them measurably better.*

#### 3.1 Targeted AI Coaching
After scoring, generate a structured coaching report for the content owner:
- **Critical fixes** — issues blocking approval at current gate
- **High-impact improvements** — changes that would meaningfully lift the score
- **Quick wins** — small changes with outsized impact
- **Examples from past events** — concrete examples pulled from memory of what good looks like

#### 3.2 Version History & Diff View
- Every save creates a version snapshot
- Version history panel with timestamps and editor
- Diff view highlighting changes between versions
- Score history showing score evolution across versions
- Score delta metric: total improvement from v1 to vN

#### 3.3 Submitter Portal (`/submit/:eventSlug`)
- Separate lightweight route, one slug removed from admin
- No access to other submissions, reviewer notes, or admin functions
- Submitter sees: their submission fields, gate status checklist, AI score (after scoring), coaching report
- Submitter can update submission and trigger a rescore
- Reviewer gets email notification when submission is updated
- Auth: magic link sent to `first.last@intel.com` — link is scoped to that submission only
- Portal is invitation-only — reviewer triggers magic link send from admin UI

---

### PHASE 4 — Program Intelligence & Analytics
*Goal: Give program managers a strategic view of the full content program.*

#### 4.1 Program Health Dashboard
- Coverage map: audience segments well-served vs. underserved
- Track balance: slot utilization, average score per track, thematic overlap
- Speaker diversity: Intel vs. partner vs. customer voice ratio
- Readiness timeline: % of submissions at each gate stage vs. workback schedule
- Score distribution histogram

#### 4.2 Cross-Event Trend Intelligence
- Patterns across multiple events of the same type
- Surfaces automatically as memory accumulates
- "Edge sessions with live demos averaged 18 points higher at Federal Summit over 3 cycles"
- Displayed as insight cards on the Memory dashboard

#### 4.3 KPI Benchmarking
- Compare current event's submission scores vs. prior year same event at same stage
- Track session quality improvement over time as the tool's core ROI metric
- Surface Intel standard KPI targets alongside actual survey outcomes after event closes

---

## Notification System Design

All notifications via email. Intel addresses follow `first.last@intel.com` format.

| Trigger | Recipient | Subject |
|---|---|---|
| Submission scored | Content lead | "Your session has been scored — [title]" |
| Status changed | Content lead | "Status update: [title] is now [status]" |
| Gate blocked | Content lead | "Action required: [title] is blocked at [gate] review" |
| Submission updated (by submitter) | Reviewer/Content lead | "[Submitter] updated their submission — [title]" |
| Magic link request | Submitter | "Your Intel Content Review access link" |
| 7 days to gate deadline | Content lead | "Deadline reminder: [gate] review due in 7 days" |

Email sender: **Resend** — API key already provisioned in Render env vars.

---

## Auth Design

**v2: Magic Link**
- Reviewer/admin access: email + magic link sent to `@intel.com` address
- Submitter portal: magic link scoped to a single submission, expires after 72 hours
- No password storage, no session management complexity
- Admin can revoke links from the submission detail view

**v3: Microsoft Entra ID (SSO)**
- Replace magic link with Entra ID SSO
- Role-based access: Admin | Reviewer | Content Owner
- Planned but not scoped for v2

---

## Technical Architecture Changes for v2

### Stack Additions
- **Voyager AI** — embeddings for memory brain and conflict detection (no additional API key vs. OpenAI)
- **Resend or SendGrid** — transactional email for notifications and magic links (new env var: `EMAIL_API_KEY`)
- **pgvector** — Neon native, just needs `CREATE EXTENSION IF NOT EXISTS vector`

### New Environment Variables
| Variable | Purpose |
|---|---|
| `EMAIL_API_KEY` | Transactional email (Resend or SendGrid) |
| `EMAIL_FROM` | Sender address (e.g. `noreply@intel-events.com`) |
| `APP_URL` | Base URL for magic link generation |
| `RESEND_API_KEY` | Resend transactional email — already set in Render |
| `VOYAGER_API_KEY` | Voyager AI embeddings — already set in Render |

### New API Endpoints
```
POST /api/events/:id/memories/import-survey    → Ingest survey CSV
POST /api/events/:id/memories/import-outcomes  → Ingest attendance/outcome data
POST /api/events/:id/memories/extract-lessons  → Run Claude lesson extraction post-ingestion
GET  /api/events/:id/memories                  → List memories for event
PUT  /api/memories/:id/signal                  → Upvote/downvote memory weight
POST /api/memories                             → Manually add memory

POST /api/submissions/:id/coach                → Generate coaching report
GET  /api/submissions/:id/versions             → Version history
GET  /api/submissions/:id/gate-status          → Gate checklist + score + level

POST /api/auth/magic-link                      → Request magic link (admin triggers for submitter)
GET  /api/auth/verify/:token                   → Verify magic link token → set session
GET  /submit/:eventSlug                        → Submitter portal (separate route)

GET  /api/events/:id/program-health            → Program health dashboard data
GET  /api/analytics/trends                     → Cross-event trend intelligence
```

---

## Build Order & Checklist

### Phase 1 — Quality Gates & Compliance
- [ ] Define gate field requirements and scoring weights
- [ ] Build gate evaluation function (returns score 0-100 + level + blocking fields)
- [ ] Add `submission_gates` table to schema
- [ ] Gate checklist UI on submission detail (green / amber / red per field)
- [ ] Enforce Pass/Warn/Block on status advancement
- [ ] Compliance flag: auto-detect disclosure language in abstract
- [ ] NDA field surfaced prominently in submission form
- [ ] Conflict/overlap detection on submission save (Voyager similarity)
- [ ] Update README with gate requirements and enforcement levels

### Phase 2 — Voyager AI Memory Brain
- [ ] Enable pgvector on Neon (`CREATE EXTENSION IF NOT EXISTS vector`)
- [ ] Add `event_memories`, `survey_responses`, `speaker_history` tables
- [ ] Integrate Voyager AI for embedding generation
- [ ] Survey CSV import endpoint — auto column mapping + fuzzy session matching
- [ ] Mapping review screen before import commit
- [ ] Outcome data import (attendance, walkout, Q&A engagement)
- [ ] Auto-lesson extraction (Claude call post-ingestion)
- [ ] KPI outcome tracking against Intel standard targets
- [ ] Memory-augmented scoring (similarity search → inject into scoring prompt)
- [ ] "Past Event Insight" section in scorecard UI
- [ ] Memory dashboard tab (browse, filter, upvote/downvote, manual add)
- [ ] Speaker history auto-update on survey import
- [ ] Add `submission_versions` table + versioning on every save

### Phase 3 — Coaching & Submitter Portal
- [ ] Coaching report generation endpoint + UI (critical / high-impact / quick wins / examples)
- [ ] Version history panel + diff view
- [ ] Score delta metric across versions
- [ ] Magic link auth system (generate, store, verify, expire, revoke)
- [ ] Submitter portal route (`/submit/:eventSlug`)
- [ ] Submitter view: gate status, score, coaching report, edit + rescore
- [ ] Email notifications: Resend/SendGrid integration
- [ ] All notification triggers wired (score, status, gate block, update, magic link, deadline)

### Phase 4 — Program Intelligence
- [ ] Program health dashboard (coverage map, track balance, readiness timeline)
- [ ] Score distribution histogram
- [ ] Cross-event trend intelligence (requires 2+ events with memory)
- [ ] KPI benchmarking vs. prior year same event
- [ ] Insight cards on memory dashboard
- [ ] Update README with all new endpoints and env vars

---

## Open Questions (Resolved)

| Question | Resolution |
|---|---|
| Embedding model | Voyager AI ✅ |
| Submitter portal scope | In scope v2, `/submit/:eventSlug` slug ✅ |
| Survey data format | Intel/Evolio CSV confirmed, field mapping documented above ✅ |
| Gate enforcement | 0–49 Pass, 50–79 Warn, 80–100 Block ✅ |
| Notifications | Email first, `first.last@intel.com` format ✅ |
| Auth | Magic link v2, Entra ID v3 ✅ |

## Remaining Open Questions
*All open questions resolved. Ready to build.*

---

## North Star Metric

> After three event cycles using v2, the average AI score of approved sessions should be measurably higher than the average score from the first cycle — and post-event survey session scores should follow.

The tool succeeds when the feedback loop closes:
**survey data → memory → better scoring → coaching → better submissions → better sessions → better survey data**

---

*Last updated: March 31, 2026*
*Owner: Brian Morgan / Taylor*
