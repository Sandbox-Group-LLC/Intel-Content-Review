# Intel Event Content Review — v2 Whiteboard

> **Purpose of this document:** Living planning space for v2. Start here before touching code. Update it as decisions get made. Check off progress as features ship.

---

## What v1 Is (Honest Baseline)

v1 is a solid, functional foundation. It does the job it was designed to do:

- Multi-event management with AI-generated event profiles
- Session submission intake (manual + PPTX upload parsing)
- AI scoring across 6 universal dimensions
- Abstract enrichment
- Speaker management with headshots
- Status workflow (submitted → under review → approved → declined)
- CSV export
- Intel-branded UI

**What it is not yet:** A powerhouse. It moves submissions through a funnel but it doesn't make them materially better, it doesn't learn from past events, it doesn't enforce quality gates, and it has no memory. Every event starts from zero.

---

## The v2 Vision

> **From submission funnel to content excellence engine.**

v2 transforms the tool from a review tracker into an intelligent system that makes Intel's session content measurably better with every event cycle — by injecting institutional memory, enforcing compliance gates, and closing the feedback loop between audience outcomes and content quality.

Three pillars:

1. **Memory** — The system learns from every event. Survey results, attendance data, scoring outcomes, and reviewer decisions accumulate into a pgvector brain that informs every future review.
2. **Gates** — Submissions don't just get scored. They move through defined compliance and quality gates before they're eligible for approval. No more half-baked TBD-heavy abstracts slipping through.
3. **Iteration** — The system doesn't just evaluate content. It actively helps content owners improve it through targeted AI coaching grounded in what has actually worked before.

---

## What's Missing from v1 (Gap Analysis)

### Intelligence Gaps
- **No institutional memory.** Every event starts cold. The AI has no knowledge of what scored well at past events, what attendees responded to, what speakers were rated highly, or what content patterns consistently underperformed.
- **No feedback loop.** Post-event survey results, session attendance data, and Net Promoter scores are never ingested. The scoring model can't learn.
- **Static scoring rubric.** The AI system prompt is generated once at event creation and never evolves. It doesn't incorporate lessons from the previous year's event of the same type.
- **No cross-event pattern recognition.** "Edge sessions with live demos score 20% higher than slide-only presentations at Federal Summit" — this insight exists nowhere.

### Quality & Compliance Gaps
- **No gate structure.** A submission with every field marked TBD can move straight to Approved. There's nothing stopping low-quality content from being rubber-stamped.
- **No completeness enforcement.** Missing speakers, undefined demos, blank abstracts — all of these can exist in an "approved" submission.
- **No brand/legal compliance check.** Intel has strict brand and legal review requirements for session content. There's no disclosure flag, no NDA check, no "new launch" alert routing.
- **No conflict detection.** Two sessions from different BUs covering the same topic for the same track slot — the system doesn't flag it.

### Workflow Gaps
- **No submission iteration.** Content owners get a score and a rationale but no structured path to improve and resubmit. There's no diff view, no version history, no "here's specifically what to fix."
- **No notifications.** No alerts when submissions are scored, when status changes, or when a deadline is approaching.
- **No deadline enforcement.** The content workback schedule (50%, 75%, 90% review gates) exists in the POR deck but nowhere in the tool.
- **No committee workflow.** Real reviews involve multiple stakeholders. There's no concept of reviewer assignment, voting, or consensus tracking.
- **No submitter-facing view.** Content owners submit via PowerPoint and hear nothing back. There's no portal where submitters can see their score, get AI coaching, and resubmit.

### Data Gaps
- **No attendance or engagement data.** Session seat reservations, walkout rates, Q&A engagement — none of this feeds back in.
- **No speaker performance tracking.** Speaker ratings from past events aren't captured or surfaced when that speaker submits again.
- **No track saturation visibility.** The slot tracker is basic. There's no view that shows topic overlap, audience segment coverage gaps, or thematic balance across the full program.

---

## v2 Feature Plan

### PHASE 1 — Quality Gates & Compliance Engine
*Goal: Make it impossible to approve a low-quality or non-compliant submission.*

#### 1.1 Submission Completeness Gate
- Define required fields per review stage (50%, 75%, 90% milestones matching Intel's workback schedule)
- Block status advancement if required fields are missing for that stage
- Visual gate checklist on each submission: green checkmarks / red blocks per requirement
- "Ready for 75% review" badge only appears when 50% gate is cleared

**Required fields by gate:**
- **50% gate:** Title, abstract, BU, track, format, duration, at least one Intel speaker named
- **75% gate:** All 50% fields + session flow defined, key topics populated, featured products named, partner/demo status declared (even if "none")
- **90% gate:** All 75% fields + partner speakers confirmed or explicitly declined, demos confirmed or declined, no launches/disclosures reviewed

#### 1.2 Compliance Flag System
- Auto-detect disclosure flags: scan abstract and topics for language suggesting new product launches, roadmap reveals, or NDA-sensitive content
- Surface a "Disclosure Review Required" badge — doesn't block but routes for review
- NDA field: explicit yes/no with required approver name if yes
- "New launch" field from the one-pager template gets surfaced prominently and flagged for legal routing

#### 1.3 Conflict & Overlap Detection
- When a submission is saved, scan all other submissions in the same event for:
  - Same track + overlapping key topics (semantic similarity via pgvector)
  - Same speaker assigned to overlapping time slots
  - Duplicate or near-duplicate titles
- Surface conflicts as warnings, not blockers, with links to the conflicting submissions

---

### PHASE 2 — pgvector Memory Brain
*Goal: The system learns from every event and injects that knowledge into every review.*

#### 2.1 Database Layer
Add pgvector extension to Neon. New tables:

**`event_memories`**
- Stores vectorized lessons from completed events
- Sources: post-event survey results, session scores vs. actual attendance, speaker ratings, reviewer decisions
- Categories: `what_worked`, `what_didnt`, `speaker_insight`, `topic_trend`, `audience_signal`
- Fields: event_id, category, content (text), embedding (vector), score (signal strength), created_at

**`survey_responses`**
- Raw post-event survey data ingested per session
- Fields: event_id, submission_id, overall_rating, content_relevance, speaker_quality, would_recommend, verbatim_feedback, created_at

**`speaker_history`**
- Cross-event speaker performance record
- Fields: speaker_name, email, events_count, avg_speaker_rating, avg_session_score, sessions (JSONB array), created_at

#### 2.2 Memory Ingestion
- **Survey import:** CSV upload endpoint for post-event survey results. Maps responses to submissions by session title or ID. Vectorizes verbatim feedback and stores in event_memories.
- **Outcome import:** After an event, import actual attendance numbers, walkout rates, and Q&A engagement per session (CSV or manual entry).
- **Auto-lesson extraction:** After survey + outcome data is ingested, run a Claude call to extract 5-10 structured lessons from the data. Store as `what_worked` / `what_didnt` memories with embeddings.
- **Speaker rating capture:** Pull speaker ratings from survey data and update speaker_history automatically.

#### 2.3 Memory-Augmented Scoring
- Before scoring a submission, run a pgvector similarity search against event_memories
- Retrieve top 5 most relevant memories (by cosine similarity to the submission's abstract + topics)
- Inject retrieved memories into the scoring system prompt as additional context:
  > "Based on outcomes from past Intel events: [memory 1] [memory 2]..."
- Score rationale now reflects both the event rubric AND institutional knowledge
- Surface "Past Event Insight" section in the scorecard UI showing which memories influenced the score

#### 2.4 Memory Dashboard
- Dedicated Memory tab in the app
- Browse all stored memories by event, category, and signal strength
- Upvote/downvote memories to adjust their influence weight
- Manually add memories ("We learned that...")
- See which memories have influenced the most scoring decisions

---

### PHASE 3 — Submission Coaching & Iteration Engine
*Goal: Don't just score submissions — make them measurably better.*

#### 3.1 Targeted AI Coaching
- After scoring, generate a structured coaching report for the content owner
- Not a generic "here's how to improve" — specific, actionable, grounded in:
  - The dimension scores and rationale
  - Relevant memories from past events
  - The event's specific audience and goals
- Coaching report structure:
  - **Critical fixes** (issues that would block approval at current gate)
  - **High-impact improvements** (changes that would meaningfully improve the score)
  - **Quick wins** (small changes with outsized impact)
  - **Examples from past events** (concrete examples of what good looks like, pulled from memory)

#### 3.2 Version History & Diff View
- Every save of a submission creates a version snapshot
- Version history panel shows all versions with timestamps and who edited
- Diff view highlights what changed between versions
- Score history shows how the score evolved across versions — did the coaching work?
- "Score delta" metric: how much did the overall score improve from v1 to vN?

#### 3.3 Submitter Portal (Optional — Phase 3b)
- Separate lightweight view for content owners (no full reviewer access)
- Submitter can see: their submission, their score, their coaching report, their gate status
- Submitter can update their submission and trigger a rescore
- Reviewer gets notified when a submission is updated
- This is the closed-loop version of the tool — submitters are active participants, not passive uploaders

---

### PHASE 4 — Program Intelligence & Analytics
*Goal: Give program managers a strategic view of the full content program.*

#### 4.1 Program Health Dashboard
- Event-level view (not submission-level)
- **Coverage map:** Which audience segments are well-served vs. underserved by current submissions?
- **Track balance:** Slot utilization per track + average score per track + thematic overlap heat map
- **Speaker diversity:** Mix of Intel vs. partner vs. customer voices across the program
- **Readiness timeline:** % of submissions at each gate stage vs. the workback schedule — are we on track?
- **Score distribution:** Histogram of overall scores — are we top-heavy (lots of 80s) or scattered?

#### 4.2 Trend Intelligence (Cross-Event)
- Surfaces patterns across multiple events of the same type
- "Edge sessions with live demos have averaged 18 points higher scores at Federal Summit over 3 years"
- "Sessions featuring government agency co-speakers have 34% higher attendance vs. Intel-only sessions"
- These insights surface automatically as memory accumulates across events
- Displayed as insight cards on the Memory dashboard

#### 4.3 Comparative Benchmarking
- Compare the current event's submission quality vs. the same event from prior years
- "This year's Federal Summit submissions are averaging 71/100 vs. 64/100 last year at the same stage"
- Track improvement in submission quality over time as a measure of the tool's ROI

---

## Technical Architecture Changes for v2

### Database Additions
```sql
-- pgvector extension (Neon supports this natively)
CREATE EXTENSION IF NOT EXISTS vector;

-- Memory brain
CREATE TABLE IF NOT EXISTS event_memories (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  category TEXT, -- what_worked | what_didnt | speaker_insight | topic_trend | audience_signal
  content TEXT,
  embedding vector(1536),
  signal_strength FLOAT DEFAULT 1.0, -- adjustable via upvote/downvote
  source TEXT, -- survey | manual | auto_extracted
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Post-event survey responses
CREATE TABLE IF NOT EXISTS survey_responses (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  submission_id INTEGER REFERENCES submissions(id),
  overall_rating INTEGER, -- 1-5
  content_relevance INTEGER, -- 1-5
  speaker_quality INTEGER, -- 1-5
  would_recommend BOOLEAN,
  verbatim_feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cross-event speaker performance
CREATE TABLE IF NOT EXISTS speaker_history (
  id SERIAL PRIMARY KEY,
  full_name TEXT,
  email TEXT UNIQUE,
  events_count INTEGER DEFAULT 0,
  avg_speaker_rating FLOAT,
  avg_session_score FLOAT,
  sessions JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Submission version history
CREATE TABLE IF NOT EXISTS submission_versions (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER REFERENCES submissions(id),
  version_number INTEGER,
  snapshot JSONB, -- full submission state at this version
  ai_score JSONB,
  edited_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gate status per submission
CREATE TABLE IF NOT EXISTS submission_gates (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER REFERENCES submissions(id),
  gate TEXT, -- gate_50 | gate_75 | gate_90
  status TEXT, -- pending | passed | blocked
  checked_at TIMESTAMPTZ,
  blocking_fields JSONB -- array of field names that are blocking
);
```

### New API Endpoints
```
POST /api/events/:id/memories/import-survey    → Ingest survey CSV
POST /api/events/:id/memories/import-outcomes  → Ingest attendance/outcome data
POST /api/events/:id/memories/extract-lessons  → Run Claude lesson extraction
GET  /api/events/:id/memories                  → List memories for event
PUT  /api/memories/:id/signal                  → Upvote/downvote memory weight
POST /api/memories                             → Manually add a memory

POST /api/submissions/:id/coach                → Generate coaching report
GET  /api/submissions/:id/versions             → Get version history
GET  /api/submissions/:id/gate-status          → Get gate checklist status

GET  /api/events/:id/program-health            → Program health dashboard data
GET  /api/analytics/trends                     → Cross-event trend intelligence
```

### Stack Additions
- `pgvector` — via Neon native support, no additional service needed
- `@xenova/transformers` or OpenAI embeddings API — for generating embeddings on memory content and submission abstracts
- Embedding strategy: use `text-embedding-3-small` (OpenAI) or Claude's embedding approach — decision TBD

---

## Build Order & Checklist

### Phase 1 — Quality Gates & Compliance (Build First)
- [ ] Define gate requirements per milestone (50/75/90)
- [ ] Build gate evaluation logic in server.js
- [ ] Add `submission_gates` table to schema
- [ ] Gate checklist UI component on submission detail view
- [ ] Block status advancement when gate requirements not met
- [ ] Compliance flag: auto-detect disclosure language in abstract
- [ ] NDA field surfaced prominently in submission form
- [ ] Conflict/overlap detection on submission save
- [ ] Update README with gate field requirements

### Phase 2 — pgvector Memory Brain
- [ ] Enable pgvector on Neon instance
- [ ] Add `event_memories`, `survey_responses`, `speaker_history` tables
- [ ] Survey CSV import endpoint + UI
- [ ] Outcome data import endpoint + UI
- [ ] Auto-lesson extraction (Claude call post-ingestion)
- [ ] Embedding generation on memory save
- [ ] Memory retrieval in scoring pipeline (similarity search before score call)
- [ ] "Past Event Insight" section in scorecard UI
- [ ] Memory dashboard tab (browse, upvote/downvote, manual add)
- [ ] Speaker history auto-update on survey import

### Phase 3 — Coaching & Iteration
- [ ] Coaching report generation endpoint
- [ ] Coaching report UI (critical fixes / high-impact / quick wins / examples)
- [ ] Submission versioning on every save
- [ ] Version history panel + diff view
- [ ] Score delta tracking across versions
- [ ] Submitter portal (Phase 3b — separate scoping decision)

### Phase 4 — Program Intelligence
- [ ] Program health dashboard (coverage map, track balance, readiness timeline)
- [ ] Score distribution histogram
- [ ] Cross-event trend intelligence (requires 2+ events with memory data)
- [ ] Comparative benchmarking vs. prior year same event
- [ ] Insight cards on memory dashboard

---

## Open Questions & Decisions Needed

1. **Embedding model:** OpenAI `text-embedding-3-small` (requires another API key) vs. a local/free alternative. Neon pgvector works with any embedding — what's the right tradeoff for Intel's infosec posture?
2. **Submitter portal:** Is Phase 3b in scope for v2 or does it become v3? Requires thinking through auth (even lightweight) and whether content owners should have direct system access.
3. **Survey data format:** What format does Intel's post-event survey data come in? Cvent? Manual export? Knowing this shapes the import pipeline design.
4. **Gate enforcement strictness:** Should gates hard-block status changes or soft-warn? Recommendation is hard-block at 90% gate, soft-warn at 50% and 75%.
5. **Notifications:** Email? Slack? In-app only? Scope TBD — but Slack integration is low-lift given ForgeOS has it natively.
6. **Auth:** v1 has no auth. As this becomes more powerful (submitter portal, committee voting), auth becomes necessary. Lightweight options: magic link, SSO via Intel's IdP, or simple shared password per event.

---

## North Star Metric

> After three event cycles using v2, the average AI score of approved sessions should be measurably higher than the average score of approved sessions from the first cycle — and post-event survey scores should follow.

The tool succeeds when the feedback loop closes: survey data → memory → better scoring → coaching → better submissions → better sessions → better survey data.

---

*Last updated: March 31, 2026*
*Owner: Brian Morgan / Taylor*
