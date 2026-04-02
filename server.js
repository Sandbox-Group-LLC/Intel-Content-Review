var express = require('express');
var path = require('path');
var axios = require('axios');
var { neon } = require('@neondatabase/serverless');
var { Resend } = require('resend');
var crypto = require('crypto');

function getResend() { return new Resend(process.env.RESEND_API_KEY); }
var APP_URL = process.env.APP_URL || 'https://intel-event-content-review.forge-os.ai';
var FROM_EMAIL = process.env.EMAIL_FROM || 'Intel Content Review <noreply@forge-os.ai>';
var showdown = require('showdown');
var multer = require('multer');

var app = express();
var PORT = process.env.PORT || 3000;

// Multer configuration for in-memory file storage
var storage = multer.memoryStorage();
var upload = multer({ storage: storage });

function getDb() {
  return neon(process.env.APP_DATABASE_URL);
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

async function callClaude(systemPrompt, userPrompt, isJson) {
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set.');
  }
  try {
    var response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 120000
    });
    var content = response.data.content[0].text;
    if (isJson) {
      var jsonString = content.replace(/^```json\n|\n```$/g, '').replace(/^```\n|\n```$/g, '').trim();
      return JSON.parse(jsonString);
    } else {
      return content;
    }
  } catch (error) {
    console.error('Error calling Claude API:', error.response ? error.response.data : error.message);
    throw new Error('Failed to get response from AI model.');
  }
}

// Routing formerly-Gemini calls through Claude for a unified AI stack
async function callGemini(systemPrompt, userPrompt, isJson) {
  return await callClaude(systemPrompt, userPrompt, isJson);
}

async function ensureSchema() {
  var sql = getDb();
  console.log('Checking and ensuring database schema...');
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      event_date TEXT,
      venue TEXT,
      slot_count INTEGER DEFAULT 0,
      context_profile TEXT,
      ai_system_prompt TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS speakers (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      full_name TEXT,
      title TEXT,
      company TEXT,
      email TEXT,
      bio TEXT,
      headshot BYTEA,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
      title TEXT,
      content_lead TEXT,
      bu TEXT,
      track TEXT,
      format TEXT,
      duration TEXT,
      abstract TEXT,
      key_topics TEXT,
      demos TEXT,
      featured_products TEXT,
      business_challenge TEXT,
      partner_highlights TEXT,
      new_launches TEXT,
      reviewer_notes TEXT,
      status TEXT DEFAULT 'submitted',
      ai_score JSONB,
      enriched_abstract TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Add headshot_mimetype column to speakers table if it doesn't exist
  try {
    var colCheckSpeakers = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'speakers' AND column_name = 'headshot_mimetype' AND table_schema = 'public'`;
    if (colCheckSpeakers.length === 0) {
      console.log('Adding headshot_mimetype column to speakers table...');
      await sql`ALTER TABLE speakers ADD COLUMN headshot_mimetype TEXT`;
      console.log('headshot_mimetype column added.');
    }
  } catch (addColErr) {
    console.log('headshot_mimetype column check skipped:', addColErr.message);
  }

  // Migrate ai_score to JSONB if it was previously created as INTEGER
  try {
    var colCheck = await sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'submissions'
        AND column_name = 'ai_score'
    `;
    if (colCheck.length > 0 && colCheck[0].data_type === 'integer') {
      console.log('Migrating ai_score column from INTEGER to JSONB...');
      await sql`ALTER TABLE submissions ALTER COLUMN ai_score TYPE JSONB USING NULL`;
      console.log('ai_score column migrated to JSONB.');
    } else {
      console.log('ai_score column type OK:', colCheck.length > 0 ? colCheck[0].data_type : 'not found');
    }
  } catch (migrateErr) {
    console.log('ai_score migration check skipped:', migrateErr.message);
  }

  try {
    var colCheckEnriched = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'submissions' AND column_name = 'enriched_abstract' AND table_schema = 'public'`;
    if (colCheckEnriched.length === 0) {
      console.log('Adding enriched_abstract column to submissions table...');
      await sql`ALTER TABLE submissions ADD COLUMN enriched_abstract TEXT`;
      console.log('enriched_abstract column added.');
    }
  } catch (addColErr) {
    console.log('enriched_abstract column check skipped:', addColErr.message);
  }
  
  // Drop intel_speakers and partner_speakers if they exist
  try {
    await sql`ALTER TABLE submissions DROP COLUMN IF EXISTS intel_speakers`;
    await sql`ALTER TABLE submissions DROP COLUMN IF EXISTS partner_speakers`;
    console.log('Old speaker columns removed if they existed.');
  } catch (dropErr) {
    console.log('Old speaker column drop check skipped:', dropErr.message);
  }

  // Add speaker_id column to submissions table if it doesn't exist
  try {
    var colCheckSpeakerId = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'submissions' AND column_name = 'speaker_id' AND table_schema = 'public'`;
    if (colCheckSpeakerId.length === 0) {
      console.log('Adding speaker_id column to submissions table...');
      await sql`ALTER TABLE submissions ADD COLUMN speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL`;
      console.log('speaker_id column added.');
    }
  } catch (addSpeakerIdErr) {
    console.log('speaker_id column check failed:', addSpeakerIdErr.message);
  }

  // Direct column additions - no check, just add if not exists
  console.log('[MIGRATION] Adding missing columns to submissions table...');
  
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS title TEXT`; console.log('[OK] title'); } catch(e) { console.log('[SKIP] title:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS content_lead TEXT`; console.log('[OK] content_lead'); } catch(e) { console.log('[SKIP] content_lead:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS bu TEXT`; console.log('[OK] bu'); } catch(e) { console.log('[SKIP] bu:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS track TEXT`; console.log('[OK] track'); } catch(e) { console.log('[SKIP] track:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS format TEXT`; console.log('[OK] format'); } catch(e) { console.log('[SKIP] format:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS duration TEXT`; console.log('[OK] duration'); } catch(e) { console.log('[SKIP] duration:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS abstract TEXT`; console.log('[OK] abstract'); } catch(e) { console.log('[SKIP] abstract:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS key_topics TEXT`; console.log('[OK] key_topics'); } catch(e) { console.log('[SKIP] key_topics:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS demos TEXT`; console.log('[OK] demos'); } catch(e) { console.log('[SKIP] demos:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS featured_products TEXT`; console.log('[OK] featured_products'); } catch(e) { console.log('[SKIP] featured_products:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS business_challenge TEXT`; console.log('[OK] business_challenge'); } catch(e) { console.log('[SKIP] business_challenge:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS partner_highlights TEXT`; console.log('[OK] partner_highlights'); } catch(e) { console.log('[SKIP] partner_highlights:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS new_launches TEXT`; console.log('[OK] new_launches'); } catch(e) { console.log('[SKIP] new_launches:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewer_notes TEXT`; console.log('[OK] reviewer_notes'); } catch(e) { console.log('[SKIP] reviewer_notes:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'submitted'`; console.log('[OK] status'); } catch(e) { console.log('[SKIP] status:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS enriched_abstract TEXT`; console.log('[OK] enriched_abstract'); } catch(e) { console.log('[SKIP] enriched_abstract:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS ai_score JSONB`; console.log('[OK] ai_score'); } catch(e) { console.log('[SKIP] ai_score:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL`; console.log('[OK] speaker_id'); } catch(e) { console.log('[SKIP] speaker_id:', e.message); }
  
  console.log('[MIGRATION] Column check complete.');

  // Add gate deadline columns to events table
  try { await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS gate_50_deadline TEXT`; console.log('[OK] gate_50_deadline'); } catch(e) { console.log('[SKIP] gate_50_deadline:', e.message); }
  try { await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS gate_75_deadline TEXT`; console.log('[OK] gate_75_deadline'); } catch(e) { console.log('[SKIP] gate_75_deadline:', e.message); }
  try { await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS gate_90_deadline TEXT`; console.log('[OK] gate_90_deadline'); } catch(e) { console.log('[SKIP] gate_90_deadline:', e.message); }

  // Add disclosure_flag column to submissions
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS disclosure_flag BOOLEAN DEFAULT FALSE`; console.log('[OK] disclosure_flag'); } catch(e) { console.log('[SKIP] disclosure_flag:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS nda_required BOOLEAN DEFAULT FALSE`; console.log('[OK] nda_required'); } catch(e) { console.log('[SKIP] nda_required:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS nda_approver TEXT`; console.log('[OK] nda_approver'); } catch(e) { console.log('[SKIP] nda_approver:', e.message); }

  // Create submission_gates table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS submission_gates (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        gate TEXT NOT NULL,
        score INTEGER DEFAULT 0,
        level TEXT DEFAULT 'pass',
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        blocking_fields JSONB DEFAULT '[]',
        UNIQUE(submission_id, gate)
      )
    `;
    console.log('[OK] submission_gates table');
  } catch(e) { console.log('[SKIP] submission_gates:', e.message); }

  // Create submission_conflicts table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS submission_conflicts (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        conflicting_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        conflict_type TEXT,
        description TEXT,
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(submission_id, conflicting_id, conflict_type)
      )
    `;
    console.log('[OK] submission_conflicts table');
  } catch(e) { console.log('[SKIP] submission_conflicts:', e.message); }

  // ── PHASE 2: Memory Brain tables ────────────────────────────────────────────

  // pgvector extension
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    console.log('[OK] pgvector extension');
  } catch(e) { console.log('[SKIP] pgvector:', e.message); }

  // event_memories — vectorized lessons from completed events
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS event_memories (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        category TEXT,
        content TEXT,
        embedding vector(768),
        signal_strength FLOAT DEFAULT 1.0,
        source TEXT DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('[OK] event_memories table');
  } catch(e) { console.log('[SKIP] event_memories:', e.message); }

  // survey_responses — post-event survey data per session
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS survey_responses (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
        session_title TEXT,
        session_satisfaction INTEGER,
        business_relevance INTEGER,
        speaker_quality INTEGER,
        session_comments TEXT,
        overall_event_value INTEGER,
        nps_score INTEGER,
        partner_select_lift TEXT,
        respondent_role TEXT,
        respondent_industry TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('[OK] survey_responses table');
  } catch(e) { console.log('[SKIP] survey_responses:', e.message); }

  // speaker_history — cross-event speaker performance
  try {
    await sql`
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
      )
    `;
    console.log('[OK] speaker_history table');
  } catch(e) { console.log('[SKIP] speaker_history:', e.message); }

  // submission_versions — version history per submission
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS submission_versions (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        version_number INTEGER,
        snapshot JSONB,
        ai_score JSONB,
        edited_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('[OK] submission_versions table');
  } catch(e) { console.log('[SKIP] submission_versions:', e.message); }

  // Add memory-augmented scoring fields to submissions
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS memory_insights JSONB`; console.log('[OK] memory_insights'); } catch(e) { console.log('[SKIP] memory_insights:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS version_number INTEGER DEFAULT 1`; console.log('[OK] version_number'); } catch(e) { console.log('[SKIP] version_number:', e.message); }

  // ── PHASE 4.5: Competitive intelligence fields ──────────────────────────
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS competitive_analysis JSONB`; console.log('[OK] competitive_analysis'); } catch(e) { console.log('[SKIP] competitive_analysis:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS title_saturation_score INTEGER DEFAULT 0`; console.log('[OK] title_saturation_score'); } catch(e) { console.log('[SKIP] title_saturation_score:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reframe_suggestions JSONB`; console.log('[OK] reframe_suggestions'); } catch(e) { console.log('[SKIP] reframe_suggestions:', e.message); }
  try {
    await sql`CREATE TABLE IF NOT EXISTS competitive_intelligence (id SERIAL PRIMARY KEY, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, pillar TEXT, sonar_raw JSONB, gap_analysis JSONB, whitespace_report JSONB, run_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(event_id, pillar))`;
    console.log('[OK] competitive_intelligence table');
  } catch(e) { console.log('[SKIP] competitive_intelligence:', e.message); }

  // ── PHASE 3: Auth, coaching, portal fields ───────────────────────────────
  try { await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS slug TEXT`; console.log('[OK] events.slug'); } catch(e) { console.log('[SKIP] events.slug:', e.message); }
  try { await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS notification_email TEXT`; console.log('[OK] notification_email'); } catch(e) { console.log('[SKIP] notification_email:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS coaching_report JSONB`; console.log('[OK] coaching_report'); } catch(e) { console.log('[SKIP] coaching_report:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS score_delta INTEGER DEFAULT 0`; console.log('[OK] score_delta'); } catch(e) { console.log('[SKIP] score_delta:', e.message); }

  // ── v2.1 PHASE 1: CFP schema ─────────────────────────────────────────────
  await ensureCFPSchema(sql);
  try {
    await sql`CREATE TABLE IF NOT EXISTS magic_link_tokens (
      id SERIAL PRIMARY KEY, token TEXT UNIQUE NOT NULL,
      submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
      email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    console.log('[OK] magic_link_tokens table');
  } catch(e) { console.log('[SKIP] magic_link_tokens:', e.message); }

  // Create submission_speakers junction table for many-to-many relationship
  console.log('[MIGRATION] Creating submission_speakers junction table...');
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS submission_speakers (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
        speaker_id INTEGER REFERENCES speakers(id) ON DELETE CASCADE,
        UNIQUE(submission_id, speaker_id)
      )
    `;
    console.log('[OK] submission_speakers table');
  } catch(e) { console.log('[SKIP] submission_speakers:', e.message); }

  // Migrate existing speaker_id data to submission_speakers
  console.log('[MIGRATION] Migrating legacy speaker_id to submission_speakers...');
  try {
    await sql`
      INSERT INTO submission_speakers (submission_id, speaker_id)
      SELECT id, speaker_id FROM submissions 
      WHERE speaker_id IS NOT NULL 
      AND NOT EXISTS (
        SELECT 1 FROM submission_speakers ss 
        WHERE ss.submission_id = submissions.id AND ss.speaker_id = submissions.speaker_id
      )
    `;
    console.log('[OK] Legacy speaker_id migration');
  } catch(e) { console.log('[SKIP] Legacy migration:', e.message); }

  console.log('Schema is ready.');
}

async function seedData() {
  var sql = getDb();
  console.log('Checking for seed data...');
  var eventCount = await sql`SELECT COUNT(*) FROM events`;
  if (parseInt(eventCount[0].count, 10) === 0) {
    console.log('No events found, seeding database...');

    var context_profile = [
      'Intel Federal Summit 2026',
      'Date: April 27-28, 2026',
      'Venue: Marriott Westfields Chantilly, VA',
      'Available session slots: 12',
      '',
      'Audience: Senior federal IT decision-makers, defense program managers, intelligence community architects, DoD CIOs and CTOs, cleared systems integrators.',
      '',
      'Strategic themes for 2026:',
      '- Agentic AI for autonomous mission systems and decision support',
      '- Edge & embedded computing for contested/denied environments',
      '- Data center modernization for classified and FedRAMP workloads',
      '- Silicon-level security: TDX, SGX, Boot Guard for zero-trust architectures',
      '- High-performance computing for simulation, modeling, and intelligence analysis',
      '- Commercial client platforms for government-managed device fleets',
      '',
      'Intel federal portfolio highlights: Intel Xeon 6 (Granite Rapids), Intel Core Ultra (Meteor Lake) with NPU for on-device AI, Gaudi 3 AI accelerators, Intel TDX for confidential computing, Intel vPro for enterprise manageability.',
      '',
      'Content bar: Sessions must be technically credible, speak directly to federal procurement and mission realities, and avoid purely commercial/enterprise framing.'
    ].join('\n');

    var ai_system_prompt = [
      'You are an AI content reviewer for the Intel Federal Summit 2026, a premier event targeting US federal government, defense, intelligence community, and public sector IT decision-makers.',
      '',
      'Scoring mission: Evaluate session submissions on their relevance, technical depth, and strategic value to federal/defense audiences. Intel\'s federal priorities for 2026 center on AI for national security, edge computing at the tactical edge, data center modernization for classified workloads, and silicon-level trust/security.',
      '',
      'Score each submission on six dimensions (0-100 each):',
      '1. Audience Fit — Is the content level, framing, and subject matter appropriate for the specific audience defined by this event?',
      '2. Intel Alignment — Does it showcase Intel silicon, software, or ecosystem advantages in a meaningful and credible way?',
      '3. Technical Depth — Is the content substantive enough for the technical buyers, architects, and decision-makers this event targets?',
      '4. Strategic Value — Does the session advance Intel\'s key goals for this event — pipeline, preference, trust, or thought leadership?',
      '5. Partner Ecosystem Value — Does it include customer, partner, or third-party voices that add credibility and real-world validation?',
      '6. Delivery Readiness — Are the speakers confirmed and credible, the format appropriate, and the abstract clear enough to attract the right attendees?',
      '',
      'Return ONLY valid JSON in this exact shape:',
      '{',
      '  "overall": <integer 0-100>,',
      '  "dimensions": {',
      '    "audience_fit": { "score": <int>, "rationale": "<string>" },',
      '    "intel_alignment": { "score": <int>, "rationale": "<string>" },',
      '    "technical_depth": { "score": <int>, "rationale": "<string>" },',
      '    "strategic_value": { "score": <int>, "rationale": "<string>" },',
      '    "partner_ecosystem_value": { "score": <int>, "rationale": "<string>" },',
      '    "delivery_readiness": { "score": <int>, "rationale": "<string>" }',
      '  },',
      '  "strengths": ["<string>", ...],',
      '  "gaps": ["<string>", ...],',
      '  "recommendation": "<Accept|Accept with Revisions|Decline>"',
      '}'
    ].join('\n');

    var newEvent = await sql`
      INSERT INTO events (name, event_date, venue, slot_count, context_profile, ai_system_prompt)
      VALUES ('Intel Federal Summit 2026', 'April 27-28, 2026', 'Marriott Westfields Chantilly, VA', 12, ${context_profile}, ${ai_system_prompt})
      RETURNING id
    `;
    var eventId = newEvent[0].id;

    var submissions = [
      {
        title: 'Agentic AI at the Tactical Edge: Autonomous Decision Support for DoD',
        bu: 'DCAI',
        track: 'Agentic AI',
        abstract: 'This session presents Intel\'s Gaudi 3-powered agentic AI framework deployed in a classified Army logistics optimization pilot. We demonstrate how multi-agent systems running on Intel silicon achieve sub-second decision latency for resupply routing in GPS-denied environments, reducing mission planner cognitive load by 40%. Architecture deep-dive covers inference pipeline, security isolation via Intel TDX, and integration with existing C2 systems.'
      },
      {
        title: 'Building Trustworthy AI Agents for Intelligence Analysis Workflows',
        bu: 'DCAI',
        track: 'Agentic AI',
        abstract: 'Intelligence analysts face an explosion of multi-source data requiring rapid synthesis. This session covers Intel\'s reference architecture for deploying agentic AI pipelines in air-gapped IC environments, using open-weight LLMs on Xeon 6 with Intel AMX acceleration. Topics include agent orchestration patterns, hallucination mitigation for high-stakes decisions, provenance tracking, and audit logging for compliance with IC data handling directives.'
      },
      {
        title: 'Intel Core Ultra at the Edge: AI Inference in SWaP-Constrained Platforms',
        bu: 'NEX',
        track: 'Edge & Embedded Systems',
        abstract: 'Forward-deployed ISR platforms demand AI inference capabilities within strict SWaP envelopes. Intel Core Ultra\'s integrated NPU delivers 34 TOPS within a 15W TDP, enabling real-time object detection, signals classification, and sensor fusion directly on the platform. This session covers thermal management, security hardening via BootGuard, ruggedization considerations, and a case study from a SOCOM-adjacent program.'
      },
      {
        title: 'Modernizing the DoD Data Center: Xeon 6 for Classified HPC Workloads',
        bu: 'DCAI',
        track: 'Data Center/HPC',
        abstract: 'The Department of Defense operates hundreds of data centers supporting classified modeling, simulation, and intelligence processing workloads that cannot move to commercial cloud. Intel Xeon 6 with P-cores delivers 2.1x the performance-per-watt of prior generation for HPC workloads while Intel TDX enables confidential computing enclaves for multi-tenant classified environments. Session covers ATO considerations, migration path from legacy infrastructure, and JWICS/SIPRNet integration.'
      },
      {
        title: 'Zero Trust Device Identity: Intel vPro and Hardware-Rooted Security for Federal Fleets',
        bu: 'CCG',
        track: 'Commercial Client',
        abstract: 'Federal agencies managing large device fleets under CISA zero trust mandates require hardware-rooted identity and remote attestation capabilities beyond software MDM. Intel vPro with Hardware Shield provides silicon-level platform attestation, below-OS threat detection, and remote remediation. Session covers NIST SP 800-155 alignment, integration with Microsoft SCCM and Intune for federal M365 tenants, FedRAMP implications, and practical deployment guidance.'
      },
      {
        title: 'AI-Assisted Code Modernization for Legacy Defense Systems',
        bu: 'CCG',
        track: 'Commercial Client',
        abstract: 'Defense software teams maintain millions of lines of COBOL, Ada, and legacy C++ in mission-critical systems. This workshop explores using Intel-optimized LLMs running locally on Core Ultra developer workstations to assist with code analysis, documentation generation, and controlled modernization without sending sensitive source code to external APIs. Covers toolchain setup, model selection, Intel OpenVINO integration, and lessons from a pilot with a prime integrator.'
      }
    ];

    for (var i = 0; i < submissions.length; i++) {
      var sub = submissions[i];
      await sql`
        INSERT INTO submissions (event_id, title, bu, track, abstract, status)
        VALUES (${eventId}, ${sub.title}, ${sub.bu}, ${sub.track}, ${sub.abstract}, 'submitted')
      `;
    }
    console.log('Database seeded successfully.');
  } else {
    console.log('Data already exists, skipping seed.');
  }
}

// ─── ASSET PROXY ─────────────────────────────────────────────────────────────

app.get('/api/assets/:filename', async function (req, res) {
  try {
    var url = 'https://forge-os.ai/api/assets/' + req.params.filename;
    var response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(404).send('asset not found');
  }
});

// ─── EVENTS API ───────────────────────────────────────────────────────────────

app.get('/api/events', async function (req, res) {
  try {
    var sql = getDb();
    var rows = await sql`SELECT * FROM events ORDER BY created_at DESC`;
    res.json({ ok: true, events: rows });
  } catch (err) {
    console.error('[api/events GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── EMAIL & MAGIC LINK HELPERS ──────────────────────────────────────────────

async function sendEmail(to, subject, html) {
  try {
    var resend = getResend();
    if (!process.env.RESEND_API_KEY) { console.log('[Email] No RESEND_API_KEY — skipping:', subject); return false; }
    await resend.emails.send({ from: FROM_EMAIL, to: to, subject: subject, html: html });
    console.log('[Email] Sent:', subject, '->', to);
    return true;
  } catch(e) {
    console.error('[Email] Failed:', e.message);
    return false;
  }
}

function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function createMagicLink(submissionId, email, sql) {
  var token = generateToken();
  var expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await sql`INSERT INTO magic_link_tokens (token, submission_id, email, expires_at) VALUES (${token}, ${submissionId}, ${email}, ${expiresAt.toISOString()}) ON CONFLICT (token) DO NOTHING`;
  return APP_URL + '/submit/token/' + token;
}

async function notifyScored(submission, event) {
  if (!submission.content_lead) return;
  var email = submission.content_lead.includes('@') ? submission.content_lead : submission.content_lead.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '') + '@intel.com';
  var overall = submission.ai_score ? (submission.ai_score.overall || submission.ai_score.overall_score || '—') : '—';
  await sendEmail(email, 'Your session has been scored — ' + submission.title,
    '<div style="font-family:Arial,sans-serif;max-width:600px"><h2 style="color:#000864">Session Scored</h2>' +
    '<p>Your session <strong>' + submission.title + '</strong> has been reviewed.</p>' +
    '<p><strong>Overall Score: ' + overall + ' / 100</strong></p>' +
    '<p style="color:#666;font-size:12px">Intel Content Review</p></div>');
}

async function notifyStatusChange(submission, event, newStatus) {
  if (!submission.content_lead) return;
  var email = submission.content_lead.includes('@') ? submission.content_lead : submission.content_lead.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '') + '@intel.com';
  var labels = { submitted:'Submitted', under_review:'Under Review', approved:'Approved', declined:'Declined', needs_revision:'Needs Revision' };
  await sendEmail(email, 'Status update: ' + submission.title + ' is now ' + (labels[newStatus]||newStatus),
    '<div style="font-family:Arial,sans-serif;max-width:600px"><h2 style="color:#000864">Status Updated</h2>' +
    '<p>Your session <strong>' + submission.title + '</strong> status: <strong>' + (labels[newStatus]||newStatus) + '</strong></p>' +
    '<p style="color:#666;font-size:12px">Intel Content Review</p></div>');
}

async function notifyGateBlocked(submission, event, gate) {
  if (!submission.content_lead) return;
  var email = submission.content_lead.includes('@') ? submission.content_lead : submission.content_lead.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '') + '@intel.com';
  var labels = { gate_50:'50%', gate_75:'75%', gate_90:'90%' };
  await sendEmail(email, 'Action required: ' + submission.title + ' blocked at ' + (labels[gate]||gate) + ' review',
    '<div style="font-family:Arial,sans-serif;max-width:600px"><h2 style="color:#CC0000">Submission Blocked</h2>' +
    '<p>Your session <strong>' + submission.title + '</strong> cannot advance. Please complete required fields.</p>' +
    '<p style="color:#666;font-size:12px">Intel Content Review</p></div>');
}

// ─── VOYAGER AI EMBEDDING CLIENT ─────────────────────────────────────────────

async function generateEmbedding(text) {
  var VOYAGER_API_KEY = process.env.VOYAGER_API_KEY;
  if (!VOYAGER_API_KEY) {
    console.log('[Voyager] No API key — skipping embedding');
    return null;
  }
  try {
    var axios = require('axios');
    var response = await axios.post('https://api.voyageai.com/v1/embeddings', {
      input: text,
      model: 'voyage-3'
    }, {
      headers: {
        'Authorization': 'Bearer ' + VOYAGER_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return response.data.data[0].embedding;
  } catch(e) {
    console.error('[Voyager] Embedding error:', e.message);
    return null;
  }
}

async function searchMemories(embedding, eventId, limit) {
  if (!embedding) return [];
  var sql = getDb();
  limit = limit || 5;
  try {
    // Cosine similarity search using pgvector
    var embStr = '[' + embedding.join(',') + ']';
    var results = await sql`
      SELECT id, category, content, signal_strength, source,
             1 - (embedding <=> ${embStr}::vector) AS similarity
      FROM event_memories
      WHERE event_id = ${eventId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${embStr}::vector
      LIMIT ${limit}
    `;
    return results.filter(function(r) { return r.similarity > 0.5; });
  } catch(e) {
    console.error('[Memory] Search error:', e.message);
    return [];
  }
}

// ─── GATE EVALUATION ENGINE ──────────────────────────────────────────────────

function evaluateGate(submission, gate) {
  // Returns { score: 0-100, level: 'pass'|'warn'|'block', blocking_fields: [] }
  var fields = [];
  var blocking = [];

  if (gate === 'gate_50') {
    // Required: title, abstract (100+ chars), bu, track, format, duration, at least one intel speaker
    if (!submission.title || submission.title.trim().length < 3) {
      fields.push({ field: 'title', label: 'Session title', required: true });
    }
    if (!submission.abstract || submission.abstract.trim().length < 100) {
      fields.push({ field: 'abstract', label: 'Abstract (min 100 characters)', required: true });
    }
    if (!submission.bu || submission.bu.trim().length < 1) {
      fields.push({ field: 'bu', label: 'Business Unit (BU)', required: true });
    }
    if (!submission.track || submission.track.trim().length < 1) {
      fields.push({ field: 'track', label: 'Content track', required: true });
    }
    if (!submission.format || submission.format.trim().length < 1) {
      fields.push({ field: 'format', label: 'Session format', required: true });
    }
    if (!submission.duration || submission.duration.trim().length < 1) {
      fields.push({ field: 'duration', label: 'Duration', required: true });
    }
    if (!submission.content_lead || submission.content_lead.trim().length < 2) {
      fields.push({ field: 'content_lead', label: 'At least one Intel speaker / content lead named', required: true });
    }
  }

  if (gate === 'gate_75') {
    // All gate_50 fields plus: key_topics, featured_products, partner/demo status declared
    var g50 = evaluateGate(submission, 'gate_50');
    fields = fields.concat(g50.blocking_fields);
    if (!submission.key_topics || submission.key_topics.trim().length < 5) {
      fields.push({ field: 'key_topics', label: 'Key topics populated', required: true });
    }
    if (!submission.featured_products || submission.featured_products.trim().length < 3) {
      fields.push({ field: 'featured_products', label: 'Featured Intel products named', required: true });
    }
    // Partner and demo status must be declared — even "none" is acceptable
    var demosDeclared = submission.demos && submission.demos.trim().length > 0;
    var partnerDeclared = submission.partner_highlights && submission.partner_highlights.trim().length > 0;
    if (!demosDeclared) {
      fields.push({ field: 'demos', label: 'Demo status declared (or "None")', required: true });
    }
    if (!partnerDeclared) {
      fields.push({ field: 'partner_highlights', label: 'Partner status declared (or "None")', required: true });
    }
  }

  if (gate === 'gate_90') {
    // All gate_75 fields plus: new_launches reviewed, abstract quality threshold (200+ chars)
    var g75 = evaluateGate(submission, 'gate_75');
    fields = fields.concat(g75.blocking_fields);
    if (!submission.new_launches || submission.new_launches.trim().length < 1) {
      fields.push({ field: 'new_launches', label: 'New launches / disclosures reviewed and declared', required: true });
    }
    if (!submission.abstract || submission.abstract.trim().length < 200) {
      fields.push({ field: 'abstract', label: 'Abstract meets quality threshold (min 200 characters for 90% gate)', required: true });
    }
    // business_challenge should be populated
    if (!submission.business_challenge || submission.business_challenge.trim().length < 5) {
      fields.push({ field: 'business_challenge', label: 'Business challenge defined', required: true });
    }
  }

  // Deduplicate fields by field name
  var seen = {};
  var uniqueFields = [];
  for (var i = 0; i < fields.length; i++) {
    if (!seen[fields[i].field]) {
      seen[fields[i].field] = true;
      uniqueFields.push(fields[i]);
      blocking.push(fields[i]);
    }
  }

  // Score: 0 blocking = 0 score issues; each blocking field adds proportional weight
  var maxFields = gate === 'gate_50' ? 7 : gate === 'gate_75' ? 11 : 14;
  var passedFields = maxFields - blocking.length;
  var score = Math.round((blocking.length / maxFields) * 100);

  // Level thresholds: 0-49 pass, 50-79 warn, 80-100 block
  var level = score < 50 ? 'pass' : score < 80 ? 'warn' : 'block';

  return { score: score, level: level, blocking_fields: blocking };
}

function scanDisclosureFlags(submission) {
  // Scan abstract and key_topics for disclosure-sensitive language
  var sensitivePatterns = [
    /new launch/i, /announcing/i, /world first/i, /first ever/i,
    /not yet announced/i, /coming soon/i, /under nda/i,
    /confidential/i, /pre-release/i, /prerelease/i,
    /embargo/i, /not public/i, /future product/i,
    /roadmap/i, /unreleased/i, /pre-production/i
  ];
  var text = ((submission.abstract || '') + ' ' + (submission.key_topics || '') + ' ' + (submission.new_launches || '')).toLowerCase();
  for (var i = 0; i < sensitivePatterns.length; i++) {
    if (sensitivePatterns[i].test(text)) return true;
  }
  return false;
}

// ─── GATE API ROUTES ──────────────────────────────────────────────────────────

// GET gate status for a submission
app.get('/api/submissions/:id/gates', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var subResult = await sql`SELECT * FROM submissions WHERE id = ${id}`;
    if (!subResult.length) return res.status(404).json({ ok: false, error: 'Submission not found' });
    var sub = subResult[0];

    var gates = ['gate_50', 'gate_75', 'gate_90'];
    var results = {};
    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      var eval_result = evaluateGate(sub, g);
      results[g] = eval_result;
      // Upsert into submission_gates
      await sql`
        INSERT INTO submission_gates (submission_id, gate, score, level, checked_at, blocking_fields)
        VALUES (${id}, ${g}, ${eval_result.score}, ${eval_result.level}, NOW(), ${JSON.stringify(eval_result.blocking_fields)})
        ON CONFLICT (submission_id, gate) DO UPDATE SET
          score = EXCLUDED.score,
          level = EXCLUDED.level,
          checked_at = EXCLUDED.checked_at,
          blocking_fields = EXCLUDED.blocking_fields
      `;
    }

    // Check and update disclosure flag
    var flagged = scanDisclosureFlags(sub);
    if (flagged !== sub.disclosure_flag) {
      await sql`UPDATE submissions SET disclosure_flag = ${flagged} WHERE id = ${id}`;
    }

    res.json({ ok: true, gates: results, disclosure_flag: flagged });
  } catch(err) {
    console.error('[api/submissions gates]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET conflicts for a submission
app.get('/api/submissions/:id/conflicts', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var conflicts = await sql`
      SELECT sc.*, s.title as conflicting_title, s.track as conflicting_track, s.bu as conflicting_bu
      FROM submission_conflicts sc
      JOIN submissions s ON s.id = sc.conflicting_id
      WHERE sc.submission_id = ${id}
      ORDER BY sc.detected_at DESC
    `;
    res.json({ ok: true, conflicts: conflicts });
  } catch(err) {
    console.error('[api/submissions conflicts]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// IMPORTANT: generate-profile must be before /api/events/:id
app.post('/api/events/generate-profile', async function (req, res) {
  try {
    var context_raw = req.body.context_raw;
    if (!context_raw) return res.status(400).json({ ok: false, error: 'context_raw is required.' });
    var systemPrompt = 'You are an expert assistant for creating Intel event content strategies. Given raw context about an event, generate two things: (1) a concise context_profile summarizing the event focus, audience, and key themes for content submitters, and (2) a detailed ai_system_prompt for an AI that will score session submissions against this specific event\'s goals. The ai_system_prompt must instruct the AI to score on six universal dimensions — audience_fit, intel_alignment, technical_depth, strategic_value, partner_ecosystem_value, delivery_readiness — each returning score 0-100 and a one-sentence rationale interpreted through the lens of THIS event\'s specific audience, objectives, and content pillars. Also return overall (0-100), strengths (array), gaps (array), and recommendation (Accept|Accept with Revisions|Decline). Return ONLY valid JSON with keys: context_profile and ai_system_prompt.';
    var profile = await callClaude(systemPrompt, context_raw, true);
    res.json({ ok: true, profile: profile });
  } catch (err) {
    console.error('[generate-profile]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/events', async function (req, res) {
  try {
    var sql = getDb();
    var body = req.body;
    var name = body.name;
    var event_date = body.event_date || '';
    var venue = body.venue || '';
    var slot_count = parseInt(body.total_slots || body.slot_count) || 0;
    var context_profile = body.context_profile || '';
    var ai_system_prompt = body.ai_system_prompt || '';
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    var result = await sql`
      INSERT INTO events (name, event_date, venue, slot_count, context_profile, ai_system_prompt)
      VALUES (${name}, ${event_date}, ${venue}, ${slot_count}, ${context_profile}, ${ai_system_prompt})
      RETURNING *
    `;
    res.json({ ok: true, event: result[0] });
  } catch (err) {
    console.error('[api/events POST]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/events/:id', async function (req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var body = req.body;
    var name = body.name || '';
    var event_date = body.event_date || '';
    var venue = body.venue || '';
    var slot_count = parseInt(body.total_slots || body.slot_count) || 0;
    var context_profile = body.context_profile || '';
    var ai_system_prompt = body.ai_system_prompt || '';
    var gate_50_deadline = body.gate_50_deadline || null;
    var gate_75_deadline = body.gate_75_deadline || null;
    var gate_90_deadline = body.gate_90_deadline || null;
    var result = await sql`
      UPDATE events SET
        name = ${name},
        event_date = ${event_date},
        venue = ${venue},
        slot_count = ${slot_count},
        context_profile = ${context_profile},
        ai_system_prompt = ${ai_system_prompt},
        gate_50_deadline = ${gate_50_deadline},
        gate_75_deadline = ${gate_75_deadline},
        gate_90_deadline = ${gate_90_deadline},
        slug = COALESCE(${body.slug||null}, slug),
        notification_email = COALESCE(${body.notification_email||null}, notification_email)
      WHERE id = ${id}
      RETURNING *
    `;
    if (!result.length) return res.status(404).json({ ok: false, error: 'event not found' });
    res.json({ ok: true, event: result[0] });
  } catch (err) {
    console.error('[api/events PUT]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── SUBMISSIONS API ──────────────────────────────────────────────────────────

// IMPORTANT: /export must be before /:id to avoid 'export' matching as an id
app.get('/api/submissions/export', async function (req, res) {
  try {
    var sql = getDb();
    var event_id = req.query.event_id;
    if (!event_id) return res.status(400).json({ ok: false, error: 'event_id is required' });
    var submissions = await sql`
      SELECT 
        s.id, s.title, s.bu, s.track, s.format, 
        (
          SELECT string_agg(sp.full_name, ', ' ORDER BY sp.full_name)
          FROM submission_speakers ss
          JOIN speakers sp ON sp.id = ss.speaker_id
          WHERE ss.submission_id = s.id
        ) as speaker_names, 
        s.status, s.ai_score
      FROM submissions s
      WHERE s.event_id = ${event_id} ORDER BY s.title ASC
    `;
    var csv = 'ID,Title,BU,Track,Format,Speaker,Status,AI Score\n';
    submissions.forEach(function (sub) {
      var aiScore = (sub.ai_score && sub.ai_score.overall) ? sub.ai_score.overall : '';
      csv += [
        sub.id,
        '"' + (sub.title || '').replace(/"/g, '""') + '"',
        '"' + (sub.bu || '').replace(/"/g, '""') + '"',
        '"' + (sub.track || '').replace(/"/g, '""') + '"',
        '"' + (sub.format || '').replace(/"/g, '""') + '"',
        '"' + (sub.speaker_names || '').replace(/"/g, '""') + '"',
        sub.status || 'submitted',
        aiScore
      ].join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
    res.end(csv);
  } catch (err) {
    console.error('[submissions/export]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/submissions', async function (req, res) {
  try {
    var sql = getDb();
    var event_id = req.query.event_id;
    console.log('[api/submissions] Fetching for event_id:', event_id);
    if (!event_id) return res.status(400).json({ ok: false, error: 'event_id is required' });
    var rows = await sql`
      SELECT
        s.id, s.event_id, s.speaker_id, s.title, s.content_lead, s.bu, s.track,
        s.format, s.duration, s.abstract, s.key_topics, s.demos,
        s.featured_products, s.business_challenge, s.partner_highlights,
        s.new_launches, s.reviewer_notes, s.status, s.ai_score,
        s.enriched_abstract, s.created_at,
        (
          SELECT string_agg(sp.full_name, ', ' ORDER BY sp.full_name)
          FROM submission_speakers ss
          JOIN speakers sp ON sp.id = ss.speaker_id
          WHERE ss.submission_id = s.id
        ) as speaker_names,
        (
          SELECT array_agg(ss.speaker_id)
          FROM submission_speakers ss
          WHERE ss.submission_id = s.id
        ) as speaker_ids
      FROM submissions s
      WHERE s.event_id = ${event_id}
      ORDER BY s.created_at DESC
    `;
    console.log('[api/submissions] Found', rows.length, 'submissions');
    res.json({ ok: true, submissions: rows });
  } catch (err) {
    console.error('[api/submissions GET] Error:', err.message, err.stack);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/submissions', async function (req, res) {
  try {
    var sql = getDb();
    var b = req.body;
    var result = await sql`
      INSERT INTO submissions (
        event_id, title, content_lead, bu, track, format, duration,
        abstract, key_topics, demos,
        featured_products, business_challenge, partner_highlights, new_launches
      ) VALUES (
        ${b.event_id}, ${b.title || ''}, ${b.content_lead || ''}, ${b.bu || ''},
        ${b.track || ''}, ${b.format || ''}, ${b.duration || ''},
        ${b.abstract || ''},
        ${b.key_topics || ''}, ${b.demos || ''}, ${b.featured_products || ''},
        ${b.business_challenge || ''}, ${b.partner_highlights || ''}, ${b.new_launches || ''}
      )
      RETURNING *
    `;
    var submission = result[0];
    
    // Handle speaker_ids array for multi-speaker support
    var speakerIds = b.speaker_ids || [];
    if (!Array.isArray(speakerIds)) speakerIds = speakerIds ? [speakerIds] : [];
    
    for (var i = 0; i < speakerIds.length; i++) {
      var spkId = parseInt(speakerIds[i], 10);
      if (spkId) {
        await sql`INSERT INTO submission_speakers (submission_id, speaker_id) VALUES (${submission.id}, ${spkId})`;
      }
    }
    
    // ── Run conflict detection ──
    try {
      var allSubs = await sql`
        SELECT id, title, track, key_topics FROM submissions
        WHERE event_id = ${submission.event_id} AND id != ${submission.id}
      `;
      for (var ci = 0; ci < allSubs.length; ci++) {
        var other = allSubs[ci];
        if (other.track && submission.track && other.track === submission.track) {
          var myTopics = (submission.key_topics || '').toLowerCase().split(/[,;]+/).map(function(t) { return t.trim(); }).filter(Boolean);
          var theirTopics = (other.key_topics || '').toLowerCase().split(/[,;]+/).map(function(t) { return t.trim(); }).filter(Boolean);
          var overlap = myTopics.filter(function(t) { return theirTopics.some(function(tt) { return tt.includes(t) || t.includes(tt); }); });
          if (overlap.length > 0) {
            await sql`
              INSERT INTO submission_conflicts (submission_id, conflicting_id, conflict_type, description)
              VALUES (${submission.id}, ${other.id}, 'topic_overlap', ${'Same track (' + submission.track + ') with overlapping topics: ' + overlap.slice(0,3).join(', ')})
              ON CONFLICT (submission_id, conflicting_id, conflict_type) DO NOTHING
            `;
          }
        }
      }
    } catch(ce) { console.log('[conflict detection]', ce.message); }

    // ── Run initial gate evaluation and disclosure scan ──
    var gateResults = {};
    ['gate_50', 'gate_75', 'gate_90'].forEach(function(g) { gateResults[g] = evaluateGate(submission, g); });
    var disclosureFlagged = scanDisclosureFlags(submission);
    if (disclosureFlagged) {
      try { await sql`UPDATE submissions SET disclosure_flag = true WHERE id = ${submission.id}`; } catch(e) {}
    }

    res.json({ ok: true, submission: submission, gates: gateResults, disclosure_flag: disclosureFlagged });
  } catch (err) {
    console.error('[api/submissions POST]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// IMPORTANT: /api/submissions/:id/score must be before /api/submissions/:id
app.post('/api/submissions/:id/score', async function (req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var subResult = await sql`
      SELECT
        s.id, s.event_id, s.speaker_id, s.title, s.content_lead, s.bu, s.track,
        s.format, s.duration, s.abstract, s.key_topics, s.demos,
        s.featured_products, s.business_challenge, s.partner_highlights,
        s.new_launches, s.reviewer_notes, s.status, s.ai_score,
        s.enriched_abstract, s.created_at,
        (
          SELECT string_agg(sp.full_name, ', ' ORDER BY sp.full_name)
          FROM submission_speakers ss
          JOIN speakers sp ON sp.id = ss.speaker_id
          WHERE ss.submission_id = s.id
        ) as speaker_names
      FROM submissions s
      WHERE s.id = ${id}
    `;
    if (!subResult.length) return res.status(404).json({ ok: false, error: 'Submission not found' });
    var sub = subResult[0];
    var evtResult = await sql`SELECT * FROM events WHERE id = ${sub.event_id}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];
    if (!evt.ai_system_prompt) return res.status(400).json({ ok: false, error: 'AI system prompt not configured for this event.' });
    // ── Memory-augmented scoring: retrieve relevant past lessons ──
    var memoryContext = '';
    var memoryInsights = [];
    try {
      var scoringText = (sub.title || '') + ' ' + (sub.abstract || '') + ' ' + (sub.key_topics || '');
      var scoringEmbedding = await generateEmbedding(scoringText);
      var relevantMemories = await searchMemories(scoringEmbedding, evt.id, 5);
      if (relevantMemories.length > 0) {
        memoryContext = '\n\nPAST EVENT INSIGHTS (factor these into your scoring):\n';
        relevantMemories.forEach(function(m, idx) {
          memoryContext += (idx + 1) + '. [' + m.category.toUpperCase() + '] ' + m.content + '\n';
          memoryInsights.push({ id: m.id, category: m.category, content: m.content.slice(0, 150), similarity: parseFloat(m.similarity) });
        });
      }
    } catch(me) { console.log('[Memory] retrieval skipped:', me.message); }

    var userPrompt = [
      'Title: ' + (sub.title || ''),
      'Abstract: ' + (sub.abstract || ''),
      'Business Unit: ' + (sub.bu || ''),
      'Track: ' + (sub.track || ''),
      'Key Topics: ' + (sub.key_topics || ''),
      'Featured Products: ' + (sub.featured_products || ''),
      'Business Challenge: ' + (sub.business_challenge || ''),
      'Speakers: ' + (sub.speaker_names || 'N/A')
    ].join('\n');
    var scorecard = await callClaude(evt.ai_system_prompt + memoryContext, userPrompt, true);
    await sql`UPDATE submissions SET ai_score = ${JSON.stringify(scorecard)}, memory_insights = ${JSON.stringify(memoryInsights)} WHERE id = ${id}`;
    try {
      var evtForScore = await sql`SELECT * FROM events WHERE id = ${sub.event_id}`;
      if (evtForScore.length) notifyScored(sub, evtForScore[0]).catch(function(){});
    } catch(ne) {}
    try {
      var firstVer = await sql`SELECT ai_score FROM submission_versions WHERE submission_id = ${id} ORDER BY version_number ASC LIMIT 1`;
      if (firstVer.length && firstVer[0].ai_score) {
        var fs = firstVer[0].ai_score.overall || firstVer[0].ai_score.overall_score || 0;
        var cs = scorecard.overall || scorecard.overall_score || 0;
        await sql`UPDATE submissions SET score_delta = ${cs - fs} WHERE id = ${id}`;
      }
    } catch(de) {}
    res.json({ ok: true, scorecard: scorecard, memory_insights: memoryInsights });
  } catch (err) {
    console.error('[submissions/score]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/submissions/:id/enrich', async function (req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;

    var subResult = await sql`SELECT * FROM submissions WHERE id = ${id}`;
    if (!subResult.length) {
      return res.status(404).json({ ok: false, error: 'Submission not found' });
    }
    var submission = subResult[0];

    var eventResult = await sql`SELECT * FROM events WHERE id = ${submission.event_id}`;
    if (!eventResult.length) {
      return res.status(404).json({ ok: false, error: 'Event not found for this submission' });
    }
    var event = eventResult[0];

    if (!submission.abstract || submission.abstract.trim() === '') {
      return res.status(400).json({ ok: false, error: 'Submission abstract is empty.' });
    }

    var systemPrompt = 'You are a world-class content editor for a tech conference. Your task is to refine the provided abstract to be clearer, more impactful, and better aligned with the event\'s audience, without changing the core technical message.\n\nEvent context for audience and theme alignment:\n' + event.context_profile;

    var enriched_abstract_markdown = await callGemini(systemPrompt, submission.abstract, false);
    
    var converter = new showdown.Converter();
    var enriched_abstract_html = converter.makeHtml(enriched_abstract_markdown);

    var updateResult = await sql`
      UPDATE submissions
      SET enriched_abstract = ${enriched_abstract_html}
      WHERE id = ${id}
      RETURNING *
    `;

    res.json({ ok: true, submission: updateResult[0] });
  } catch (err) {
    console.error('[submissions/enrich]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/submissions/:id', async function (req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var b = req.body;
    
    // Update submission fields using tagged template
    var result = await sql`
      UPDATE submissions SET
        title = COALESCE(${b.title}, title),
        content_lead = COALESCE(${b.content_lead}, content_lead),
        bu = COALESCE(${b.bu}, bu),
        track = COALESCE(${b.track}, track),
        format = COALESCE(${b.format}, format),
        duration = COALESCE(${b.duration}, duration),
        abstract = COALESCE(${b.abstract}, abstract),
        key_topics = COALESCE(${b.key_topics}, key_topics),
        demos = COALESCE(${b.demos}, demos),
        featured_products = COALESCE(${b.featured_products}, featured_products),
        business_challenge = COALESCE(${b.business_challenge}, business_challenge),
        partner_highlights = COALESCE(${b.partner_highlights}, partner_highlights),
        new_launches = COALESCE(${b.new_launches}, new_launches),
        reviewer_notes = COALESCE(${b.reviewer_notes}, reviewer_notes),
        status = COALESCE(${b.status}, status),
        nda_required = COALESCE(${b.nda_required}, nda_required),
        nda_approver = COALESCE(${b.nda_approver}, nda_approver)
      WHERE id = ${id}
      RETURNING *
    `;
    
    if (!result.length) {
      return res.status(404).json({ ok: false, error: 'Submission not found' });
    }

    // ── Gate enforcement on status advancement ──
    var newStatus = b.status;
    var gateBlockedMessages = [];
    if (newStatus && ['under_review', 'approved'].includes(newStatus)) {
      var sub = result[0];
      var gateToCheck = newStatus === 'approved' ? 'gate_90' : 'gate_50';
      var gateEval = evaluateGate(sub, gateToCheck);
      if (gateEval.level === 'block') {
        return res.status(422).json({
          ok: false,
          error: 'Gate blocked: submission cannot advance to ' + newStatus + ' until blocking issues are resolved.',
          gate: gateToCheck,
          gate_result: gateEval
        });
      }
      if (gateEval.level === 'warn') {
        gateBlockedMessages.push({ gate: gateToCheck, level: 'warn', blocking_fields: gateEval.blocking_fields });
      }
    }

    // Run disclosure flag scan on every save
    var flagged = scanDisclosureFlags(result[0]);
    if (flagged !== result[0].disclosure_flag) {
      await sql`UPDATE submissions SET disclosure_flag = ${flagged} WHERE id = ${id}`;
    }

    // Handle speaker_ids array if provided
    if (b.speaker_ids !== undefined) {
      var speakerIds = b.speaker_ids || [];
      if (!Array.isArray(speakerIds)) speakerIds = speakerIds ? [speakerIds] : [];
      
      // Delete existing speaker associations
      await sql`DELETE FROM submission_speakers WHERE submission_id = ${id}`;
      
      // Insert new speaker associations
      for (var i = 0; i < speakerIds.length; i++) {
        var spkId = parseInt(speakerIds[i], 10);
        if (spkId) {
          await sql`INSERT INTO submission_speakers (submission_id, speaker_id) VALUES (${id}, ${spkId})`;
        }
      }
    }
    
    // ── Fire status change notification ──
    try {
      if (b.status && result[0] && b.status !== result[0].status) {
        var evtN = await sql`SELECT * FROM events WHERE id = ${result[0].event_id}`;
        if (evtN.length) {
          notifyStatusChange(result[0], evtN[0], b.status).catch(function(){});
          if (gateBlockedMessages.length > 0) notifyGateBlocked(result[0], evtN[0], gateBlockedMessages[0].gate).catch(function(){});
        }
      }
    } catch(ne) { console.log('[notify]', ne.message); }

    // ── Save version snapshot ──
    try {
      var sub = result[0];
      var versionNum = (sub.version_number || 1);
      await sql`
        INSERT INTO submission_versions (submission_id, version_number, snapshot, ai_score, edited_by)
        VALUES (${id}, ${versionNum}, ${JSON.stringify(sub)}, ${sub.ai_score ? JSON.stringify(sub.ai_score) : null}, 'reviewer')
      `;
      // Increment version number
      await sql`UPDATE submissions SET version_number = ${versionNum + 1} WHERE id = ${id}`;
    } catch(ve) { console.log('[version]', ve.message); }

    res.json({ ok: true, submission: result[0], gate_warnings: gateBlockedMessages });
  } catch (err) {
    console.error('[api/submissions PUT]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ─── PHASE 3: COACHING, MAGIC LINK, SUBMITTER PORTAL ────────────────────────

// POST generate coaching report for a submission
app.post('/api/submissions/:id/coach', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var subResult = await sql`SELECT * FROM submissions WHERE id = ${id}`;
    if (!subResult.length) return res.status(404).json({ ok: false, error: 'Submission not found' });
    var sub = subResult[0];
    var evtResult = await sql`SELECT * FROM events WHERE id = ${sub.event_id}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];
    var gate90 = evaluateGate(sub, 'gate_90');
    var memoryContext = '';
    try {
      var coachText = (sub.title||'') + ' ' + (sub.abstract||'') + ' ' + (sub.track||'');
      var coachEmbed = await generateEmbedding(coachText);
      var coachMems = await searchMemories(coachEmbed, evt.id, 3);
      if (coachMems.length > 0) {
        memoryContext = 'Past event insights:\n';
        coachMems.forEach(function(m,i){ memoryContext += (i+1)+'. ['+m.category+'] '+m.content+'\n'; });
      }
    } catch(me) { console.log('[coach memory]', me.message); }
    var sp = 'You are a content coaching expert for Intel events. Give specific, actionable coaching to help session owners improve submissions. Be direct. Return ONLY valid JSON.';
    var up = [];
    up.push('Event: '+evt.name);
    up.push('Context: '+(evt.context_profile||'').slice(0,300));
    up.push('Title: '+(sub.title||''));
    up.push('Track: '+(sub.track||''));
    up.push('Abstract: '+(sub.abstract||''));
    up.push('Key topics: '+(sub.key_topics||''));
    up.push('Products: '+(sub.featured_products||''));
    up.push('Demos: '+(sub.demos||''));
    up.push('Partners: '+(sub.partner_highlights||''));
    up.push('Gate 90 blocking: '+JSON.stringify(gate90.blocking_fields.map(function(f){return f.label;})));
    if (memoryContext) up.push(memoryContext);
    up.push('Return JSON: {"critical_fixes":[{"issue":"","action":""}],"high_impact":[{"opportunity":"","action":"","expected_gain":""}],"quick_wins":[{"change":"","reason":""}],"past_event_examples":[{"lesson":"","application":""}],"overall_coaching_note":""}');
    var report = await callClaude(sp, up.join('\n'), true);
    await sql`UPDATE submissions SET coaching_report = ${JSON.stringify(report)} WHERE id = ${id}`;
    res.json({ ok: true, report: report });
  } catch(err) {
    console.error('[api/coach]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET version history with diff data
app.get('/api/submissions/:id/versions', async function(req, res) {
  try {
    var sql = getDb();
    var versions = await sql`
      SELECT id, version_number, edited_by, created_at,
        snapshot->>'title' as title,
        snapshot->>'abstract' as abstract,
        snapshot->>'status' as status,
        ai_score
      FROM submission_versions
      WHERE submission_id = ${req.params.id}
      ORDER BY version_number DESC
    `;
    res.json({ ok: true, versions: versions });
  } catch(err) {
    console.error('[api/versions]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST send magic link to submitter
app.post('/api/submissions/:id/magic-link', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var email = req.body.email;
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    var subResult = await sql`SELECT * FROM submissions WHERE id = ${id}`;
    if (!subResult.length) return res.status(404).json({ ok: false, error: 'Submission not found' });
    var sub = subResult[0];
    var evtResult = await sql`SELECT * FROM events WHERE id = ${sub.event_id}`;
    var evt = evtResult[0] || {};
    var link = await createMagicLink(id, email, sql);
    await sendEmail(email,
      'Your Intel Content Review access link — ' + sub.title,
      '<div style="font-family:Arial,sans-serif;max-width:600px">' +
      '<h2 style="color:#000864">Access Your Submission</h2>' +
      '<p>You have been invited to review your session for <strong>' + evt.name + '</strong>.</p>' +
      '<p><strong>Session:</strong> ' + sub.title + '</p>' +
      '<p><a href="' + link + '" style="background:#00AAE8;color:#fff;padding:12px 24px;text-decoration:none;font-weight:700;display:inline-block">View My Submission</a></p>' +
      '<p style="color:#666;font-size:12px">Link expires in 72 hours. Intel Content Review.</p></div>'
    );
    res.json({ ok: true, message: 'Magic link sent to ' + email });
  } catch(err) {
    console.error('[api/magic-link]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET verify magic link token
app.get('/api/submit/verify/:token', async function(req, res) {
  try {
    var sql = getDb();
    var token = req.params.token;
    var result = await sql`
      SELECT t.*, s.*, e.name as event_name, e.context_profile
      FROM magic_link_tokens t
      JOIN submissions s ON s.id = t.submission_id
      JOIN events e ON e.id = s.event_id
      WHERE t.token = ${token} AND t.expires_at > NOW() AND t.used_at IS NULL
    `;
    if (!result.length) return res.status(401).json({ ok: false, error: 'Invalid or expired link.' });
    res.json({ ok: true, submission: result[0], event_name: result[0].event_name });
  } catch(err) {
    console.error('[api/submit/verify]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT submitter updates via portal
app.put('/api/submit/:token', async function(req, res) {
  try {
    var sql = getDb();
    var token = req.params.token;
    var b = req.body;
    var tokenResult = await sql`SELECT * FROM magic_link_tokens WHERE token = ${token} AND expires_at > NOW() AND used_at IS NULL`;
    if (!tokenResult.length) return res.status(401).json({ ok: false, error: 'Invalid or expired link' });
    var submissionId = tokenResult[0].submission_id;
    var email = tokenResult[0].email;
    var result = await sql`
      UPDATE submissions SET
        abstract = COALESCE(${b.abstract||null}, abstract),
        key_topics = COALESCE(${b.key_topics||null}, key_topics),
        demos = COALESCE(${b.demos||null}, demos),
        featured_products = COALESCE(${b.featured_products||null}, featured_products),
        partner_highlights = COALESCE(${b.partner_highlights||null}, partner_highlights),
        business_challenge = COALESCE(${b.business_challenge||null}, business_challenge),
        version_number = COALESCE(version_number, 1) + 1
      WHERE id = ${submissionId}
      RETURNING *
    `;
    try {
      var sub = result[0];
      await sql`INSERT INTO submission_versions (submission_id, version_number, snapshot, ai_score, edited_by) VALUES (${submissionId}, ${sub.version_number}, ${JSON.stringify(sub)}, ${sub.ai_score ? JSON.stringify(sub.ai_score) : null}, ${email})`;
    } catch(ve) {}
    try {
      var evtR = await sql`SELECT * FROM events WHERE id = ${result[0].event_id}`;
      var evt = evtR[0] || {};
      if (evt.notification_email) {
        await sendEmail(evt.notification_email,
          email + ' updated their submission — ' + result[0].title,
          '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<h2 style="color:#000864">Submission Updated</h2>' +
          '<p><strong>' + email + '</strong> updated: ' + result[0].title + '</p>' +
          '<p>Log in to review changes and re-score if needed.</p></div>'
        );
      }
    } catch(ne) {}
    res.json({ ok: true, submission: result[0] });
  } catch(err) {
    console.error('[api/submit PUT]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET submitter portal page
app.get('/submit/token/:token', async function(req, res) {
  try {
    var sql = getDb();
    var token = req.params.token;
    var tokenResult = await sql`
      SELECT t.*, s.title, s.abstract, s.key_topics, s.demos, s.featured_products,
        s.partner_highlights, s.business_challenge, s.track, s.bu, s.format, s.duration,
        s.ai_score, s.coaching_report, s.version_number, s.score_delta,
        e.name as event_name, e.context_profile, e.id as event_id
      FROM magic_link_tokens t
      JOIN submissions s ON s.id = t.submission_id
      JOIN events e ON e.id = s.event_id
      WHERE t.token = ${token}
    `;
    var expired = !tokenResult.length || new Date(tokenResult[0].expires_at) < new Date() || tokenResult[0].used_at;
    var sub = tokenResult.length ? tokenResult[0] : null;
    var score = sub && sub.ai_score ? (typeof sub.ai_score === 'string' ? JSON.parse(sub.ai_score) : sub.ai_score) : null;
    var overall = score ? (score.overall || score.overall_score || null) : null;
    var scoreCls = overall === null ? 'score-na' : overall >= 80 ? 'score-high' : overall >= 60 ? 'score-mid' : 'score-low';
    var coaching = sub && sub.coaching_report ? (typeof sub.coaching_report === 'string' ? JSON.parse(sub.coaching_report) : sub.coaching_report) : null;
    var css = [
      '@font-face{font-family:IntelOneDisplay;font-weight:300;src:url("/api/assets/intelone-display-light.woff") format("woff")}',
      '@font-face{font-family:IntelOneDisplay;font-weight:400;src:url("/api/assets/intelone-display-regular.woff") format("woff")}',
      '@font-face{font-family:IntelOneDisplay;font-weight:700;src:url("/api/assets/intelone-display-bold.woff") format("woff")}',
      '*{box-sizing:border-box;border-radius:0;margin:0;padding:0}',
      'body{font-family:IntelOneDisplay,Arial,sans-serif;background:#EAEAEA;color:#2E2F2F}',
      'header{background:#000864;padding:16px 24px;display:flex;align-items:center;gap:16px}',
      'header img{height:28px}',
      'header span{color:#fff;font-weight:700;font-size:18px}',
      '.container{max-width:800px;margin:32px auto;padding:0 16px}',
      '.card{background:#fff;border:1px solid #EAEAEA;padding:24px;margin-bottom:16px}',
      'h2{font-size:20px;font-weight:700;color:#000864;margin-bottom:16px}',
      'h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}',
      'label{font-size:12px;font-weight:700;display:block;margin-bottom:4px}',
      'input,textarea{width:100%;border:1px solid #2E2F2F;padding:10px;font-family:inherit;font-size:14px;background:#fff;margin-bottom:12px}',
      'textarea{min-height:120px;resize:vertical}',
      '.btn{background:#00AAE8;color:#fff;border:none;padding:12px 24px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer}',
      '.badge{display:inline-block;padding:3px 10px;font-size:11px;font-weight:700;color:#fff}',
      '.score-high{background:#007A3D}.score-mid{background:#B8860B}.score-low{background:#CC0000}.score-na{background:#6B6B6B}',
      '.alert-info{background:#EEF6FB;border:1px solid #00AAE8;padding:12px;margin-bottom:10px;font-size:13px}',
      '.alert-warn{background:#FFF8EC;border:1px solid #B8860B;padding:12px;margin-bottom:10px;font-size:13px}',
      '.alert-err{background:#FFF0F0;border:1px solid #CC0000;padding:12px;margin-bottom:10px;font-size:13px}',
      '#msg{margin-top:12px;font-size:13px}'
    ].join('\n');
    var bodyContent = '';
    if (expired || !sub) {
      bodyContent = '<div class="card"><div class="alert-err">This link has expired or is invalid. Please contact your event coordinator for a new access link.</div></div>';
    } else {
      bodyContent += '<div class="card">';
      bodyContent += '<h2>' + (sub.title||'Your Submission') + '</h2>';
      bodyContent += '<div style="font-size:13px;color:#666;margin-bottom:8px">' + (sub.event_name||'') + ' &middot; ' + (sub.track||'') + ' &middot; Version ' + (sub.version_number||1) + '</div>';
      if (overall !== null) {
        bodyContent += '<div style="margin-bottom:8px">AI Score: <span class="badge ' + scoreCls + '">' + overall + ' / 100</span>';
        if (sub.score_delta && sub.score_delta !== 0) bodyContent += ' <span style="color:' + (sub.score_delta > 0 ? '#007A3D' : '#CC0000') + ';font-size:12px">' + (sub.score_delta > 0 ? '&#9650;' : '&#9660;') + Math.abs(sub.score_delta) + ' from v1</span>';
        bodyContent += '</div>';
      } else {
        bodyContent += '<div style="margin-bottom:8px"><span class="badge score-na">Not yet scored</span></div>';
      }
      bodyContent += '</div>';
      if (coaching) {
        bodyContent += '<div class="card"><h3>Coaching Report</h3>';
        if (coaching.overall_coaching_note) bodyContent += '<div class="alert-info">' + coaching.overall_coaching_note + '</div>';
        if (coaching.critical_fixes && coaching.critical_fixes.length) {
          bodyContent += '<h3 style="color:#CC0000;margin-top:12px">Critical Fixes</h3>';
          coaching.critical_fixes.forEach(function(f){ bodyContent += '<div class="alert-err"><strong>' + f.issue + '</strong><br>' + f.action + '</div>'; });
        }
        if (coaching.high_impact && coaching.high_impact.length) {
          bodyContent += '<h3 style="color:#B8860B;margin-top:12px">High Impact</h3>';
          coaching.high_impact.forEach(function(f){ bodyContent += '<div class="alert-warn"><strong>' + f.opportunity + '</strong><br>' + f.action + '</div>'; });
        }
        if (coaching.quick_wins && coaching.quick_wins.length) {
          bodyContent += '<h3 style="color:#007A3D;margin-top:12px">Quick Wins</h3>';
          coaching.quick_wins.forEach(function(f){ bodyContent += '<div style="padding:8px;background:#F0FAF5;border-left:3px solid #007A3D;margin-bottom:6px;font-size:13px"><strong>' + f.change + '</strong><br>' + f.reason + '</div>'; });
        }
        bodyContent += '</div>';
      }
      bodyContent += '<div class="card"><h3>Update Your Submission</h3>';
      bodyContent += '<p style="font-size:13px;color:#666;margin-bottom:16px">You can update content fields below. Your reviewer will be notified.</p>';
      bodyContent += '<label>Abstract</label><textarea id="f-abstract">' + (sub.abstract||'') + '</textarea>';
      bodyContent += '<label>Key Topics</label><textarea id="f-topics" style="min-height:80px">' + (sub.key_topics||'') + '</textarea>';
      bodyContent += '<label>Featured Intel Products</label><input id="f-products" value="' + (sub.featured_products||'') + '">';
      bodyContent += '<label>Demos</label><input id="f-demos" value="' + (sub.demos||'') + '">';
      bodyContent += '<label>Partner Highlights</label><input id="f-partners" value="' + (sub.partner_highlights||'') + '">';
      bodyContent += '<label>Business Challenge</label><textarea id="f-challenge" style="min-height:80px">' + (sub.business_challenge||'') + '</textarea>';
      bodyContent += '<button type="button" class="btn" onclick="saveSubmission()">Save Updates</button>';
      bodyContent += '<div id="msg"></div></div>';
    }
    var js = 'var TOKEN=' + JSON.stringify(token) + ';' +
      'async function saveSubmission(){' +
        'var msg=document.getElementById("msg");msg.textContent="Saving...";' +
        'var body={abstract:document.getElementById("f-abstract").value,' +
          'key_topics:document.getElementById("f-topics").value,' +
          'featured_products:document.getElementById("f-products").value,' +
          'demos:document.getElementById("f-demos").value,' +
          'partner_highlights:document.getElementById("f-partners").value,' +
          'business_challenge:document.getElementById("f-challenge").value};' +
        'try{var r=await fetch("/api/submit/"+TOKEN,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});' +
        'var data=await r.json();' +
        'if(data.ok){msg.style.color="#007A3D";msg.textContent="\u2713 Saved. Your reviewer has been notified.";}' +
        'else{msg.style.color="#CC0000";msg.textContent="Error: "+(data.error||"Save failed");}' +
        '}catch(e){msg.style.color="#CC0000";msg.textContent="Error: "+e.message;}}';
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Intel Content Review &mdash; Submission Portal</title>' +
      '<style>' + css + '</style></head><body>' +
      '<header><img src="/api/assets/Logo.png" alt="Intel"><span>Content Review &mdash; Submission Portal</span></header>' +
      '<div class="container">' + bodyContent + '</div>' +
      '<script>' + js + '</scr' + 'ipt></body></html>';
    res.send(html);
  } catch(err) {
    console.error('[submit portal]', err.message);
    res.status(500).send('<p>Something went wrong. Please try again.</p>');
  }
});


// ─── PHASE 4.5: COMPETITIVE INTELLIGENCE ─────────────────────────────────────

// ── Perplexity Sonar client (Stage 1) ────────────────────────────────────────
async function callSonar(pillar, audienceContext) {
  var PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PERPLEXITY_API_KEY) {
    console.log('[Sonar] No PERPLEXITY_API_KEY — skipping');
    return null;
  }
  var prompt = 'Research the ' + pillar + ' conference and event space for this audience: ' + audienceContext + '. ' +
    'Focus on government, defense, and enterprise technology events. ' +
    'Return ONLY valid JSON, no other text: ' +
    '{"dominantSpeakers":["name — topic they own"],' +
    '"dominantOrganizations":["org — what they present about"],' +
    '"saturatedTopics":["topics appearing at every conference in this space"],' +
    '"emergingTopics":["topics first appearing in last 12 months"],' +
    '"missingTopics":["audience needs with no speaker representation"],' +
    '"aiCitations":["who gets cited when AI answers questions about this space"],' +
    '"recentConferenceAgendas":["conference name — standout session titles"]}';
  try {
    var response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': 'Bearer ' + PERPLEXITY_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    var text = response.data.choices[0].message.content;
    // Strip markdown code fences if present
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Try direct parse first
    try { return JSON.parse(text); } catch(e1) {}
    // Try extracting JSON object — use last complete } to avoid truncation
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch(e2) {}
    }
    // Build a safe fallback from what we can extract
    console.log('[Sonar] Could not parse JSON, using fallback structure');
    return { dominantSpeakers: [], dominantOrganizations: [], saturatedTopics: [], emergingTopics: [], missingTopics: [], aiCitations: [], recentConferenceAgendas: [] };
  } catch(e) {
    console.error('[Sonar] Error:', e.message);
    return { dominantSpeakers: [], dominantOrganizations: [], saturatedTopics: [], emergingTopics: [], missingTopics: [], aiCitations: [], recentConferenceAgendas: [] };
  }
}

// ── Stage 2: Gap classification (claude-sonnet-4-6) ───────────────────────────
async function classifyGaps(sonarData, eventSystemPrompt, submissions, pillar) {
  // Trim eventSystemPrompt to first 600 chars to avoid timeout
  var eventContext = (eventSystemPrompt || '').slice(0, 600);

  var systemPrompt = 'You are a competitive intelligence agent for Intel events. ' +
    'Classify session topic authority: OWNED (80-100 confidence, 1-2 dominant voices), ' +
    'CONTESTED (50-79, multiple voices no clear leader), UNCLAIMED (0-49, demand exists no authority). ' +
    'Evaluate: format ownership, recency gap, speaker authority, AI citation signal. ' +
    'Event context: ' + eventContext + ' Return ONLY valid JSON.';

  var submissionTopics = submissions.map(function(s) {
    return { title: s.title, abstract: (s.abstract || '').slice(0, 100), track: s.track };
  });

  // Trim Sonar data to keep prompt manageable
  var trimmedSonar = {
    dominantSpeakers: (sonarData.dominantSpeakers || []).slice(0, 5),
    dominantOrganizations: (sonarData.dominantOrganizations || []).slice(0, 5),
    saturatedTopics: (sonarData.saturatedTopics || []).slice(0, 6),
    emergingTopics: (sonarData.emergingTopics || []).slice(0, 6),
    missingTopics: (sonarData.missingTopics || []).slice(0, 5),
    aiCitations: (sonarData.aiCitations || []).slice(0, 5)
  };

  var parts = [];
  parts.push('Pillar: ' + pillar);
  parts.push('Competitive research: ' + JSON.stringify(trimmedSonar));
  parts.push('Intel submissions: ' + JSON.stringify(submissionTopics));
  parts.push('Return JSON: {"marketSnapshot":{"totalTopicsAnalyzed":0,"owned":0,"contested":0,"unclaimed":0,"highUrgencyOpportunities":0},"topics":[{"topic":"","ownershipStatus":"owned","confidence":0,"ownedBy":[],"formatGaps":[],"recencyGap":false,"recencyNote":"","aiCitationOwner":"","whyUnclaimed":"","entryAngle":"","suggestedSessionTitle":"","urgency":"high","urgencyReason":""}],"whitespaceOpportunities":[{"cluster":"","sessionCount":0,"estimatedClaimWindow":"","ownItStrategy":""}],"competitorProfiles":[{"name":"","topicsOwned":[],"weaknesses":[],"attackAngle":""}]}');
  var userPrompt = parts.join('\n\n');

  return await callClaude(systemPrompt, userPrompt, true);
}

// ── Stage 3: Per-submission reframe (claude-haiku-4-5-20251001) ───────────────
async function reframeSubmission(submission, gapAnalysis, pillar) {
  try {
    var response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: 'You are a competitive intelligence specialist for Intel events. Analyze session titles for saturation and suggest unclaimed angles. Return ONLY valid JSON.',
      messages: [{
        role: 'user',
        content: 'Submission: ' + submission.title + '\nAbstract: ' + (submission.abstract || '').slice(0, 300) + '\nPillar: ' + pillar + '\n\n' +
          'Saturated topics in this space: ' + JSON.stringify((gapAnalysis.topics || []).filter(function(t){ return t.ownershipStatus === 'owned'; }).map(function(t){ return t.topic; }).slice(0,5)) + '\n' +
          'Unclaimed opportunities: ' + JSON.stringify((gapAnalysis.whitespaceOpportunities || []).slice(0,3)) + '\n\n' +
          'Return JSON: {"title_saturation_score":0,"saturation_reason":"","reframe_suggestions":[{"title":"","angle":"","ownership_potential":"high|medium|low"}],"named_framework_suggestion":"","ai_citation_gap":""}'
      }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
    var text = response.data.content[0].text;
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return JSON.parse(text); } catch(e1) {}
    var start = text.indexOf('{'); var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch(e2) {}
    }
    console.log('[Haiku reframe] Could not parse JSON response');
    return null;
  } catch(e) {
    console.error('[Haiku reframe] Error:', e.message);
    return null;
  }
}

// ── Schema additions ──────────────────────────────────────────────────────────
// Added in ensureSchema via ALTER TABLE — see server startup

// ── API Routes ────────────────────────────────────────────────────────────────

// POST run full 3-stage competitive intelligence pipeline for an event
app.post('/api/events/:id/competitive/run', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;

    var evtResult = await sql`SELECT * FROM events WHERE id = ${eventId}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];

    if (!evt.ai_system_prompt) return res.status(400).json({ ok: false, error: 'Event has no AI system prompt. Generate an event profile first.' });

    // Extract content pillars from ai_system_prompt
    var pillars = [];
    var pillarMatch = evt.ai_system_prompt.match(/CONTENT PILLARS[:\s]+([^\n]+)/i);
    if (pillarMatch) {
      pillars = pillarMatch[1].split(/[|,]/).map(function(p){ return p.trim(); }).filter(Boolean);
    }
    if (pillars.length === 0) pillars = ['Agentic AI', 'Data Center', 'Edge Computing', 'Commercial Client'];

    // Extract audience context
    var audienceMatch = evt.ai_system_prompt.match(/PRIMARY AUDIENCE[:\s]+([^\n]+)/i);
    var audienceContext = audienceMatch ? audienceMatch[1] : 'government and defense technology leaders';

    res.json({ ok: true, message: 'Pipeline started', pillars: pillars, status: 'running' });

    // Run pipeline async (don't block the response)
    setImmediate(async function() {
      try {
        var allResults = {};

        for (var pi = 0; pi < pillars.length; pi++) {
          var pillar = pillars[pi];
          console.log('[Competitive] Stage 1: Sonar research for pillar:', pillar);

          // Stage 1: Perplexity Sonar
          var sonarData = await callSonar(pillar, audienceContext);
          if (!sonarData) {
            sonarData = { dominantSpeakers: [], dominantOrganizations: [], saturatedTopics: [], emergingTopics: [], missingTopics: [], aiCitations: [], recentConferenceAgendas: [] };
          }

          // Get submissions for this pillar
          var pillarSubs = await sql`SELECT id, title, abstract, track, bu FROM submissions WHERE event_id = ${eventId} AND track ILIKE ${'%' + pillar.split(' ')[0] + '%'}`;

          console.log('[Competitive] Stage 2: Gap classification for pillar:', pillar, '(' + pillarSubs.length + ' submissions)');

          // Stage 2: Claude Sonnet gap classification
          var gapAnalysis = null;
          try {
            gapAnalysis = await classifyGaps(sonarData, evt.ai_system_prompt, pillarSubs, pillar);
          } catch(ge) {
            console.error('[Competitive] Stage 2 error:', ge.message);
            gapAnalysis = { marketSnapshot: {}, topics: [], whitespaceOpportunities: [], competitorProfiles: [] };
          }

          // Stage 3: Per-submission Haiku reframe
          console.log('[Competitive] Stage 3: Haiku reframes for', pillarSubs.length, 'submissions');
          for (var si = 0; si < pillarSubs.length; si++) {
            var sub = pillarSubs[si];
            var reframe = await reframeSubmission(sub, gapAnalysis || {}, pillar);
            if (reframe) {
              await sql`
                UPDATE submissions SET
                  competitive_analysis = ${JSON.stringify({ pillar: pillar, gap_analysis_summary: (gapAnalysis || {}).marketSnapshot, reframe: reframe })},
                  title_saturation_score = ${Math.round(reframe.title_saturation_score || 0)},
                  reframe_suggestions = ${JSON.stringify(reframe.reframe_suggestions || [])}
                WHERE id = ${sub.id}
              `;
            }
          }

          allResults[pillar] = {
            sonar_raw: sonarData,
            gap_analysis: gapAnalysis,
            submissions_analyzed: pillarSubs.length
          };

          // Store in competitive_intelligence table
          await sql`
            INSERT INTO competitive_intelligence (event_id, pillar, sonar_raw, gap_analysis, whitespace_report)
            VALUES (${eventId}, ${pillar}, ${JSON.stringify(sonarData)}, ${JSON.stringify(gapAnalysis)}, ${JSON.stringify((gapAnalysis || {}).whitespaceOpportunities || [])})
            ON CONFLICT (event_id, pillar) DO UPDATE SET
              sonar_raw = EXCLUDED.sonar_raw,
              gap_analysis = EXCLUDED.gap_analysis,
              whitespace_report = EXCLUDED.whitespace_report,
              run_at = NOW()
          `;
        }

        console.log('[Competitive] Pipeline complete for event', eventId);
      } catch(pipeErr) {
        console.error('[Competitive] Pipeline error:', pipeErr.message);
      }
    });

  } catch(err) {
    console.error('[api/competitive/run]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET latest competitive intelligence results for an event
app.get('/api/events/:id/competitive', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;

    var results = await sql`
      SELECT * FROM competitive_intelligence
      WHERE event_id = ${eventId}
      ORDER BY run_at DESC
    `;

    var subsWithCompetitive = await sql`
      SELECT id, title, track, bu, title_saturation_score, reframe_suggestions, competitive_analysis
      FROM submissions
      WHERE event_id = ${eventId} AND competitive_analysis IS NOT NULL
      ORDER BY title_saturation_score DESC
    `;

    // Build whitespace report across all pillars
    var allWhitespace = [];
    results.forEach(function(r) {
      var wr = r.whitespace_report;
      if (typeof wr === 'string') { try { wr = JSON.parse(wr); } catch(e) { wr = []; } }
      if (Array.isArray(wr)) {
        wr.forEach(function(w) { allWhitespace.push(Object.assign({}, w, { pillar: r.pillar })); });
      }
    });

    res.json({
      ok: true,
      pillars: results,
      submissions: subsWithCompetitive,
      whitespace_report: allWhitespace,
      last_run: results.length > 0 ? results[0].run_at : null
    });
  } catch(err) {
    console.error('[api/competitive GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST run Stage 3 reframe on a single submission
app.post('/api/submissions/:id/competitive/reframe', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;

    var subResult = await sql`SELECT * FROM submissions WHERE id = ${id}`;
    if (!subResult.length) return res.status(404).json({ ok: false, error: 'Submission not found' });
    var sub = subResult[0];

    // Get latest gap analysis for this pillar
    var evtResult = await sql`SELECT * FROM events WHERE id = ${sub.event_id}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });

    var ciResult = await sql`
      SELECT * FROM competitive_intelligence
      WHERE event_id = ${sub.event_id}
      ORDER BY run_at DESC
      LIMIT 5
    `;

    // Find matching pillar
    var pillar = sub.track || 'General';
    var matchingCI = ciResult.find(function(ci){ return ci.pillar && pillar.toLowerCase().includes(ci.pillar.split(' ')[0].toLowerCase()); });
    var gapAnalysis = matchingCI ? (typeof matchingCI.gap_analysis === 'string' ? JSON.parse(matchingCI.gap_analysis) : matchingCI.gap_analysis) : {};

    var reframe = await reframeSubmission(sub, gapAnalysis || {}, pillar);
    if (!reframe) return res.status(500).json({ ok: false, error: 'Reframe generation failed' });

    await sql`
      UPDATE submissions SET
        competitive_analysis = ${JSON.stringify({ pillar: pillar, reframe: reframe })},
        title_saturation_score = ${Math.round(reframe.title_saturation_score || 0)},
        reframe_suggestions = ${JSON.stringify(reframe.reframe_suggestions || [])}
      WHERE id = ${id}
    `;

    res.json({ ok: true, reframe: reframe });
  } catch(err) {
    console.error('[api/competitive/reframe]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ─── v2.1 PHASE 1: CFP ADMIN — SCHEMA, CONFIG, INVITE SYSTEM ─────────────────

// ── Schema additions (called inside ensureSchema) ─────────────────────────────
async function ensureCFPSchema(sql) {
  // Extend submissions table
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'internal'`; console.log('[OK] submissions.source'); } catch(e) { console.log('[SKIP] source:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS intel_speakers TEXT`; console.log('[OK] intel_speakers'); } catch(e) { console.log('[SKIP] intel_speakers:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS partner_walkons TEXT`; console.log('[OK] partner_walkons:', e.message); } catch(e) { console.log('[SKIP] partner_walkons:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS session_flow JSONB`; console.log('[OK] session_flow'); } catch(e) { console.log('[SKIP] session_flow:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS cfp_raw_filename TEXT`; console.log('[OK] cfp_raw_filename'); } catch(e) { console.log('[SKIP] cfp_raw_filename:', e.message); }
  try { await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS cfp_raw_file BYTEA`; console.log('[OK] cfp_raw_file'); } catch(e) { console.log('[SKIP] cfp_raw_file:', e.message); }

  // CFP config per event
  try {
    await sql`CREATE TABLE IF NOT EXISTS cfp_config (
      id SERIAL PRIMARY KEY,
      event_id INTEGER UNIQUE REFERENCES events(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'closed',
      deadline TEXT,
      welcome_heading TEXT,
      welcome_body TEXT,
      reply_to_email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    console.log('[OK] cfp_config table');
  } catch(e) { console.log('[SKIP] cfp_config:', e.message); }

  // CFP invitations
  try {
    await sql`CREATE TABLE IF NOT EXISTS cfp_invitations (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      opened_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ,
      submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
      reminder_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    console.log('[OK] cfp_invitations table');
  } catch(e) { console.log('[SKIP] cfp_invitations:', e.message); }
}

// ── CFP email helpers ─────────────────────────────────────────────────────────
function buildCFPInviteEmail(invite, evt, cfpConfig, portalUrl) {
  var heading = (cfpConfig && cfpConfig.welcome_heading) || 'You\'re invited to submit a session';
  var body = (cfpConfig && cfpConfig.welcome_body) || 'We\'d love to have you share your expertise at ' + evt.name + '.';
  var deadline = (cfpConfig && cfpConfig.deadline) ? 'Submission deadline: <strong>' + cfpConfig.deadline + '</strong><br><br>' : '';
  var greeting = invite.name ? 'Hi ' + invite.name + ',' : 'Hi,';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#000864;padding:20px 24px;display:flex;align-items:center;gap:12px">' +
      '<span style="color:#fff;font-weight:700;font-size:18px">' + escHtmlServer(evt.name) + '</span>' +
    '</div>' +
    '<div style="padding:32px 24px;background:#fff">' +
      '<p style="margin:0 0 12px">' + greeting + '</p>' +
      '<h2 style="color:#000864;font-size:20px;margin:0 0 12px">' + escHtmlServer(heading) + '</h2>' +
      '<p style="color:#444;margin:0 0 16px">' + escHtmlServer(body) + '</p>' +
      '<p style="color:#444;margin:0 0 24px">' + deadline + 'Use the link below to access your personal submission portal. You\'ll be able to fill out a session proposal form or upload your completed one-page template.</p>' +
      '<a href="' + portalUrl + '" style="display:inline-block;background:#00AAE8;color:#fff;padding:14px 28px;text-decoration:none;font-weight:700;font-size:15px">Submit Your Session</a>' +
      '<p style="margin:24px 0 0;font-size:12px;color:#888">This link is personal to you. It expires when submissions close. If you have questions, reply to this email.</p>' +
    '</div>' +
    '<div style="background:#EAEAEA;padding:12px 24px;font-size:11px;color:#666">' + escHtmlServer(evt.name) + ' &mdash; Intel Content Review</div>' +
  '</div>';
}

function escHtmlServer(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── API Routes ────────────────────────────────────────────────────────────────

// GET CFP config for an event
app.get('/api/events/:id/cfp/config', async function(req, res) {
  try {
    var sql = getDb();
    var result = await sql`SELECT * FROM cfp_config WHERE event_id = ${req.params.id}`;
    res.json({ ok: true, config: result[0] || null });
  } catch(err) {
    console.error('[api/cfp/config GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT update (or create) CFP config for an event
app.put('/api/events/:id/cfp/config', async function(req, res) {
  try {
    var sql = getDb();
    var b = req.body;
    var eventId = req.params.id;
    var result = await sql`
      INSERT INTO cfp_config (event_id, status, deadline, welcome_heading, welcome_body, reply_to_email, updated_at)
      VALUES (${eventId}, ${b.status||'closed'}, ${b.deadline||null}, ${b.welcome_heading||null}, ${b.welcome_body||null}, ${b.reply_to_email||null}, NOW())
      ON CONFLICT (event_id) DO UPDATE SET
        status = EXCLUDED.status,
        deadline = EXCLUDED.deadline,
        welcome_heading = EXCLUDED.welcome_heading,
        welcome_body = EXCLUDED.welcome_body,
        reply_to_email = EXCLUDED.reply_to_email,
        updated_at = NOW()
      RETURNING *
    `;
    res.json({ ok: true, config: result[0] });
  } catch(err) {
    console.error('[api/cfp/config PUT]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET all invitations for an event
app.get('/api/events/:id/cfp/invitations', async function(req, res) {
  try {
    var sql = getDb();
    var result = await sql`
      SELECT i.*, s.title as submission_title, s.status as submission_status, s.ai_score
      FROM cfp_invitations i
      LEFT JOIN submissions s ON s.id = i.submission_id
      WHERE i.event_id = ${req.params.id}
      ORDER BY i.sent_at DESC
    `;
    res.json({ ok: true, invitations: result });
  } catch(err) {
    console.error('[api/cfp/invitations GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST send single invite
app.post('/api/events/:id/cfp/invite', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;
    var email = (req.body.email || '').trim().toLowerCase();
    var name = (req.body.name || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });

    var evtResult = await sql`SELECT * FROM events WHERE id = ${eventId}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];

    var cfpResult = await sql`SELECT * FROM cfp_config WHERE event_id = ${eventId}`;
    var cfpConfig = cfpResult[0] || {};

    // Check for existing invite
    var existing = await sql`SELECT * FROM cfp_invitations WHERE event_id = ${eventId} AND email = ${email}`;
    var token, invite;
    if (existing.length) {
      token = existing[0].token;
      invite = existing[0];
      await sql`UPDATE cfp_invitations SET sent_at = NOW(), reminder_count = reminder_count + 1 WHERE id = ${existing[0].id}`;
    } else {
      token = generateToken();
      var inserted = await sql`
        INSERT INTO cfp_invitations (event_id, token, email, name, sent_at)
        VALUES (${eventId}, ${token}, ${email}, ${name||null}, NOW())
        RETURNING *
      `;
      invite = inserted[0];
    }

    var slug = evt.slug || String(eventId);
    var portalUrl = APP_URL + '/cfp/' + slug + '/' + token;
    var subject = existing.length
      ? 'Reminder: Submit your session for ' + evt.name
      : 'You\'re invited to submit a session — ' + evt.name;
    var html = buildCFPInviteEmail(invite, evt, cfpConfig, portalUrl);

    var replyTo = cfpConfig.reply_to_email || FROM_EMAIL;
    try {
      var resend = getResend();
      await resend.emails.send({ from: FROM_EMAIL, to: email, replyTo: replyTo, subject: subject, html: html });
      console.log('[CFP] Invite sent to', email);
    } catch(emailErr) {
      console.error('[CFP] Email failed:', emailErr.message);
    }

    res.json({ ok: true, token: token, portal_url: portalUrl, resent: existing.length > 0 });
  } catch(err) {
    console.error('[api/cfp/invite]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST bulk invite — comma or newline separated emails
app.post('/api/events/:id/cfp/invite-bulk', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;
    var raw = req.body.emails || '';
    var emails = raw.split(/[\n,;]+/).map(function(e){ return e.trim().toLowerCase(); }).filter(function(e){ return e && e.includes('@'); });
    if (!emails.length) return res.status(400).json({ ok: false, error: 'No valid emails found' });

    var evtResult = await sql`SELECT * FROM events WHERE id = ${eventId}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];
    var cfpResult = await sql`SELECT * FROM cfp_config WHERE event_id = ${eventId}`;
    var cfpConfig = cfpResult[0] || {};
    var slug = evt.slug || String(eventId);

    var results = { sent: 0, resent: 0, failed: 0, urls: [] };
    for (var ei = 0; ei < emails.length; ei++) {
      var email = emails[ei];
      try {
        var existing = await sql`SELECT * FROM cfp_invitations WHERE event_id = ${eventId} AND email = ${email}`;
        var token;
        var invite;
        if (existing.length) {
          token = existing[0].token;
          invite = existing[0];
          await sql`UPDATE cfp_invitations SET sent_at = NOW(), reminder_count = reminder_count + 1 WHERE id = ${existing[0].id}`;
          results.resent++;
        } else {
          token = generateToken();
          var inserted = await sql`INSERT INTO cfp_invitations (event_id, token, email, sent_at) VALUES (${eventId}, ${token}, ${email}, NOW()) RETURNING *`;
          invite = inserted[0];
          results.sent++;
        }
        var portalUrl = APP_URL + '/cfp/' + slug + '/' + token;
        results.urls.push({ email: email, url: portalUrl });
        var html = buildCFPInviteEmail(invite, evt, cfpConfig, portalUrl);
        var subject = existing.length ? 'Reminder: Submit your session — ' + evt.name : 'You\'re invited to submit a session — ' + evt.name;
        try {
          var resend = getResend();
          await resend.emails.send({ from: FROM_EMAIL, to: email, subject: subject, html: html });
        } catch(emailErr) { results.failed++; }
      } catch(rowErr) { results.failed++; console.error('[CFP bulk] row error:', rowErr.message); }
    }

    res.json({ ok: true, results: results });
  } catch(err) {
    console.error('[api/cfp/invite-bulk]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE revoke an invitation
app.delete('/api/cfp/invitations/:id', async function(req, res) {
  try {
    var sql = getDb();
    await sql`DELETE FROM cfp_invitations WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch(err) {
    console.error('[api/cfp/invitation DELETE]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET verify CFP invite token (for portal use in Phase 2)
app.get('/api/cfp/verify/:token', async function(req, res) {
  try {
    var sql = getDb();
    var result = await sql`
      SELECT i.*, e.name as event_name, e.slug as event_slug, e.event_date, e.venue,
             c.status as cfp_status, c.deadline, c.welcome_heading, c.welcome_body,
             s.id as submission_id, s.title as submission_title, s.status as submission_status
      FROM cfp_invitations i
      JOIN events e ON e.id = i.event_id
      LEFT JOIN cfp_config c ON c.event_id = i.event_id
      LEFT JOIN submissions s ON s.id = i.submission_id
      WHERE i.token = ${req.params.token}
    `;
    if (!result.length) return res.status(404).json({ ok: false, error: 'Invalid or expired invitation link.' });
    var row = result[0];
    // Mark as opened if first visit
    if (!row.opened_at) {
      await sql`UPDATE cfp_invitations SET opened_at = NOW() WHERE token = ${req.params.token}`;
    }
    res.json({ ok: true, invitation: row });
  } catch(err) {
    console.error('[api/cfp/verify]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ─── PHASE 4: PROGRAM INTELLIGENCE ──────────────────────────────────────────

// GET program health dashboard for an event
app.get('/api/events/:id/program-health', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;

    // Get event info
    var evtResult = await sql`SELECT * FROM events WHERE id = ${eventId}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];

    // Get all submissions for this event
    var subs = await sql`
      SELECT id, title, track, bu, format, status, ai_score, disclosure_flag,
             nda_required, demos, partner_highlights, content_lead,
             version_number, score_delta
      FROM submissions
      WHERE event_id = ${eventId}
    `;

    // Gate status per submission
    var gates = await sql`
      SELECT submission_id, gate, level, score, blocking_fields
      FROM submission_gates
      WHERE submission_id = ANY(${subs.map(function(s){ return s.id; })})
    `;
    var gateMap = {};
    gates.forEach(function(g) {
      if (!gateMap[g.submission_id]) gateMap[g.submission_id] = {};
      gateMap[g.submission_id][g.gate] = g;
    });

    // ── Track balance ──
    var trackMap = {};
    subs.forEach(function(s) {
      var track = s.track || 'Unassigned';
      if (!trackMap[track]) trackMap[track] = { submissions: 0, approved: 0, scores: [], hasDemo: 0, hasPartner: 0 };
      trackMap[track].submissions++;
      if (s.status === 'approved') trackMap[track].approved++;
      if (s.ai_score) {
        var sc = typeof s.ai_score === 'string' ? JSON.parse(s.ai_score) : s.ai_score;
        var overall = sc.overall || sc.overall_score;
        if (overall != null) trackMap[track].scores.push(parseInt(overall));
      }
      if (s.demos && s.demos.trim() && s.demos.toLowerCase() !== 'none' && s.demos.toLowerCase() !== 'tbd') trackMap[track].hasDemo++;
      if (s.partner_highlights && s.partner_highlights.trim() && s.partner_highlights.toLowerCase() !== 'none') trackMap[track].hasPartner++;
    });

    var tracks = Object.keys(trackMap).map(function(t) {
      var td = trackMap[t];
      var avgScore = td.scores.length > 0 ? Math.round(td.scores.reduce(function(a,b){return a+b;},0) / td.scores.length) : null;
      return {
        track: t,
        submissions: td.submissions,
        approved: td.approved,
        avg_score: avgScore,
        scored: td.scores.length,
        has_demo_pct: td.submissions > 0 ? Math.round((td.hasDemo / td.submissions) * 100) : 0,
        has_partner_pct: td.submissions > 0 ? Math.round((td.hasPartner / td.submissions) * 100) : 0,
        slot_fill_pct: evt.slot_count > 0 ? Math.round((td.submissions / Math.max(1, Math.round(evt.slot_count / Math.max(Object.keys(trackMap).length, 1)))) * 100) : 0
      };
    }).sort(function(a,b){ return b.submissions - a.submissions; });

    // ── Score distribution histogram ──
    var buckets = { '0-49': 0, '50-59': 0, '60-69': 0, '70-79': 0, '80-89': 0, '90-100': 0 };
    var allScores = [];
    subs.forEach(function(s) {
      if (s.ai_score) {
        var sc = typeof s.ai_score === 'string' ? JSON.parse(s.ai_score) : s.ai_score;
        var overall = parseInt(sc.overall || sc.overall_score);
        if (!isNaN(overall)) {
          allScores.push(overall);
          if (overall < 50) buckets['0-49']++;
          else if (overall < 60) buckets['50-59']++;
          else if (overall < 70) buckets['60-69']++;
          else if (overall < 80) buckets['70-79']++;
          else if (overall < 90) buckets['80-89']++;
          else buckets['90-100']++;
        }
      }
    });
    var avgOverall = allScores.length > 0 ? Math.round(allScores.reduce(function(a,b){return a+b;},0) / allScores.length) : null;

    // ── Gate readiness ──
    var gateReadiness = { gate_50: { pass: 0, warn: 0, block: 0, total: 0 }, gate_75: { pass: 0, warn: 0, block: 0, total: 0 }, gate_90: { pass: 0, warn: 0, block: 0, total: 0 } };
    subs.forEach(function(s) {
      var sg = gateMap[s.id] || {};
      ['gate_50', 'gate_75', 'gate_90'].forEach(function(g) {
        gateReadiness[g].total++;
        if (sg[g]) gateReadiness[g][sg[g].level || 'pass']++;
        else gateReadiness[g].pass++; // unscored = pass (not yet evaluated)
      });
    });

    // ── Status breakdown ──
    var statusCounts = {};
    subs.forEach(function(s) {
      var st = s.status || 'submitted';
      statusCounts[st] = (statusCounts[st] || 0) + 1;
    });

    // ── Speaker diversity ──
    var intelOnly = 0, withPartner = 0, withCustomer = 0;
    subs.forEach(function(s) {
      var ph = (s.partner_highlights || '').toLowerCase();
      var hasPartner = ph && ph !== 'none' && ph !== 'tbd' && ph.trim().length > 0;
      if (hasPartner) withPartner++;
      else intelOnly++;
    });

    // ── Compliance flags ──
    var disclosureCount = subs.filter(function(s){ return s.disclosure_flag; }).length;
    var ndaCount = subs.filter(function(s){ return s.nda_required; }).length;

    // ── Score improvement trend (submissions with multiple versions) ──
    var improving = subs.filter(function(s){ return s.score_delta && s.score_delta > 0; }).length;
    var declining = subs.filter(function(s){ return s.score_delta && s.score_delta < 0; }).length;

    res.json({
      ok: true,
      event: { id: evt.id, name: evt.name, slot_count: evt.slot_count, gate_50_deadline: evt.gate_50_deadline, gate_75_deadline: evt.gate_75_deadline, gate_90_deadline: evt.gate_90_deadline },
      summary: {
        total_submissions: subs.length,
        scored: allScores.length,
        avg_score: avgOverall,
        approved: statusCounts['approved'] || 0,
        slot_utilization: evt.slot_count > 0 ? Math.round((subs.length / evt.slot_count) * 100) : 0,
        disclosure_flags: disclosureCount,
        nda_flags: ndaCount,
        improving_submissions: improving,
        declining_submissions: declining
      },
      tracks: tracks,
      score_distribution: buckets,
      gate_readiness: gateReadiness,
      status_breakdown: statusCounts,
      speaker_diversity: { intel_only: intelOnly, with_partner: withPartner }
    });
  } catch(err) {
    console.error('[api/program-health]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET cross-event trend intelligence
app.get('/api/analytics/trends', async function(req, res) {
  try {
    var sql = getDb();

    // Get all events with their submission stats
    var events = await sql`SELECT * FROM events ORDER BY created_at ASC`;
    if (events.length === 0) return res.json({ ok: true, events: [], insights: [] });

    var eventStats = [];
    for (var ei = 0; ei < events.length; ei++) {
      var evt = events[ei];
      var subs = await sql`SELECT ai_score, status, track, demos, partner_highlights FROM submissions WHERE event_id = ${evt.id}`;
      var scores = [];
      var trackCounts = {};
      var demoCount = 0;
      var partnerCount = 0;

      subs.forEach(function(s) {
        if (s.ai_score) {
          var sc = typeof s.ai_score === 'string' ? JSON.parse(s.ai_score) : s.ai_score;
          var overall = parseInt(sc.overall || sc.overall_score);
          if (!isNaN(overall)) scores.push(overall);
        }
        var track = s.track || 'Unassigned';
        trackCounts[track] = (trackCounts[track] || 0) + 1;
        if (s.demos && s.demos.toLowerCase() !== 'none' && s.demos.toLowerCase() !== 'tbd') demoCount++;
        if (s.partner_highlights && s.partner_highlights.toLowerCase() !== 'none') partnerCount++;
      });

      eventStats.push({
        id: evt.id,
        name: evt.name,
        event_date: evt.event_date,
        total_submissions: subs.length,
        scored: scores.length,
        avg_score: scores.length > 0 ? Math.round(scores.reduce(function(a,b){return a+b;},0) / scores.length) : null,
        approved: subs.filter(function(s){ return s.status === 'approved'; }).length,
        demo_pct: subs.length > 0 ? Math.round((demoCount / subs.length) * 100) : 0,
        partner_pct: subs.length > 0 ? Math.round((partnerCount / subs.length) * 100) : 0,
        top_tracks: Object.keys(trackCounts).sort(function(a,b){ return trackCounts[b]-trackCounts[a]; }).slice(0,3).map(function(t){ return { track: t, count: trackCounts[t] }; })
      });
    }

    // Generate cross-event insights
    var insights = [];
    if (eventStats.length >= 2) {
      var latest = eventStats[eventStats.length - 1];
      var prev = eventStats[eventStats.length - 2];

      if (latest.avg_score !== null && prev.avg_score !== null) {
        var scoreDiff = latest.avg_score - prev.avg_score;
        insights.push({
          type: scoreDiff >= 0 ? 'positive' : 'negative',
          metric: 'Average Score',
          text: 'Average submission score is ' + (scoreDiff >= 0 ? '+' : '') + scoreDiff + ' points vs. ' + prev.name + ' (' + latest.avg_score + ' vs. ' + prev.avg_score + ')'
        });
      }

      if (latest.demo_pct !== prev.demo_pct) {
        insights.push({
          type: latest.demo_pct > prev.demo_pct ? 'positive' : 'neutral',
          metric: 'Demo Inclusion',
          text: 'Demo inclusion rate is ' + latest.demo_pct + '% vs. ' + prev.demo_pct + '% in ' + prev.name
        });
      }

      if (latest.partner_pct !== prev.partner_pct) {
        insights.push({
          type: latest.partner_pct > prev.partner_pct ? 'positive' : 'neutral',
          metric: 'Partner Participation',
          text: 'Partner participation rate is ' + latest.partner_pct + '% vs. ' + prev.partner_pct + '% in ' + prev.name
        });
      }

      // Submission volume trend
      var volDiff = latest.total_submissions - prev.total_submissions;
      insights.push({
        type: 'neutral',
        metric: 'Submission Volume',
        text: latest.total_submissions + ' submissions for ' + latest.name + ' (' + (volDiff >= 0 ? '+' : '') + volDiff + ' vs. ' + prev.name + ')'
      });
    } else {
      insights.push({
        type: 'info',
        metric: 'Cross-Event Trends',
        text: 'Trend intelligence becomes available after two or more events have submission data. Currently tracking ' + eventStats.length + ' event.'
      });
    }

    // Pull relevant memories as insight cards
    var memories = await sql`
      SELECT em.id, em.category, em.content, em.signal_strength, e.name as event_name
      FROM event_memories em
      JOIN events e ON e.id = em.event_id
      WHERE em.category IN ('what_worked', 'what_didnt', 'topic_trend', 'audience_signal')
      ORDER BY em.signal_strength DESC, em.created_at DESC
      LIMIT 8
    `;

    res.json({ ok: true, events: eventStats, insights: insights, memory_cards: memories });
  } catch(err) {
    console.error('[api/analytics/trends]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ─── PHASE 2: MEMORY BRAIN API ──────────────────────────────────────────────

// GET all memories for an event
app.get('/api/events/:id/memories', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var category = req.query.category || null;
    var memories = category
      ? await sql`SELECT id, category, content, signal_strength, source, created_at FROM event_memories WHERE event_id = ${id} AND category = ${category} ORDER BY signal_strength DESC, created_at DESC`
      : await sql`SELECT id, category, content, signal_strength, source, created_at FROM event_memories WHERE event_id = ${id} ORDER BY signal_strength DESC, created_at DESC`;
    res.json({ ok: true, memories: memories });
  } catch(err) {
    console.error('[api/memories GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST manually add a memory
app.post('/api/events/:id/memories', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var { category, content, source } = req.body;
    if (!content) return res.status(400).json({ ok: false, error: 'content required' });
    var embedding = await generateEmbedding(content);
    var embStr = embedding ? '[' + embedding.join(',') + ']' : null;
    var result = embStr
      ? await sql`INSERT INTO event_memories (event_id, category, content, embedding, source) VALUES (${id}, ${category || 'manual'}, ${content}, ${embStr}::vector, ${source || 'manual'}) RETURNING *`
      : await sql`INSERT INTO event_memories (event_id, category, content, source) VALUES (${id}, ${category || 'manual'}, ${content}, ${source || 'manual'}) RETURNING *`;
    res.json({ ok: true, memory: result[0] });
  } catch(err) {
    console.error('[api/memories POST]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT upvote/downvote memory signal strength
app.put('/api/memories/:id/signal', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var direction = req.body.direction; // 'up' or 'down'
    var delta = direction === 'up' ? 0.2 : -0.2;
    var result = await sql`
      UPDATE event_memories
      SET signal_strength = GREATEST(0.1, LEAST(3.0, signal_strength + ${delta}))
      WHERE id = ${id}
      RETURNING *
    `;
    if (!result.length) return res.status(404).json({ ok: false, error: 'Memory not found' });
    res.json({ ok: true, memory: result[0] });
  } catch(err) {
    console.error('[api/memories signal]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE a memory
app.delete('/api/memories/:id', async function(req, res) {
  try {
    var sql = getDb();
    await sql`DELETE FROM event_memories WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch(err) {
    console.error('[api/memories DELETE]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST import survey CSV for an event
app.post('/api/events/:id/memories/import-survey', upload.single('survey'), async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;
    if (!req.file) return res.status(400).json({ ok: false, error: 'CSV file required' });

    var csvText = req.file.buffer.toString('utf-8');
    var lines = csvText.split('\n').filter(function(l) { return l.trim(); });
    if (lines.length < 2) return res.status(400).json({ ok: false, error: 'CSV must have header row and data' });

    // Parse headers
    var headers = lines[0].split(',').map(function(h) { return h.trim().replace(/"/g, '').toLowerCase(); });

    // Column mapping — flexible, matches Intel/Evolio export format
    function findCol(names) {
      for (var i = 0; i < names.length; i++) {
        var idx = headers.findIndex(function(h) { return h.includes(names[i]); });
        if (idx >= 0) return idx;
      }
      return -1;
    }

    var colMap = {
      session_title: findCol(['session', 'title', 'name']),
      satisfaction: findCol(['satisfaction', 'overall sat']),
      relevance: findCol(['relevance', 'useful', 'business']),
      speaker: findCol(['speaker', 'present']),
      comments: findCol(['comment', 'feedback', 'additional']),
      overall_value: findCol(['overall value', 'event value']),
      nps: findCol(['nps', 'recommend', 'likely']),
      partner_lift: findCol(['partner', 'select intel', 'likely to select']),
      role: findCol(['role', 'title', 'job']),
      industry: findCol(['industry', 'sector'])
    };

    var imported = 0;
    var skipped = 0;
    var rows = [];

    for (var i = 1; i < lines.length; i++) {
      var cols = lines[i].split(',').map(function(c) { return c.trim().replace(/^"|"$/g, ''); });
      if (cols.length < 2) continue;

      var sessionTitle = colMap.session_title >= 0 ? cols[colMap.session_title] : null;

      // Fuzzy match session title to a submission
      var submissionId = null;
      if (sessionTitle) {
        var subs = await sql`SELECT id, title FROM submissions WHERE event_id = ${eventId}`;
        var titleLower = sessionTitle.toLowerCase();
        var match = subs.find(function(s) {
          return s.title && (s.title.toLowerCase().includes(titleLower) || titleLower.includes(s.title.toLowerCase().slice(0, 20)));
        });
        if (match) submissionId = match.id;
      }

      var row = {
        event_id: eventId,
        submission_id: submissionId,
        session_title: sessionTitle,
        session_satisfaction: colMap.satisfaction >= 0 ? parseInt(cols[colMap.satisfaction]) || null : null,
        business_relevance: colMap.relevance >= 0 ? parseInt(cols[colMap.relevance]) || null : null,
        speaker_quality: colMap.speaker >= 0 ? parseInt(cols[colMap.speaker]) || null : null,
        session_comments: colMap.comments >= 0 ? cols[colMap.comments] : null,
        overall_event_value: colMap.overall_value >= 0 ? parseInt(cols[colMap.overall_value]) || null : null,
        nps_score: colMap.nps >= 0 ? parseInt(cols[colMap.nps]) || null : null,
        partner_select_lift: colMap.partner_lift >= 0 ? cols[colMap.partner_lift] : null,
        respondent_role: colMap.role >= 0 ? cols[colMap.role] : null,
        respondent_industry: colMap.industry >= 0 ? cols[colMap.industry] : null
      };
      rows.push(row);
    }

    // Insert all rows
    for (var ri = 0; ri < rows.length; ri++) {
      var r = rows[ri];
      try {
        await sql`
          INSERT INTO survey_responses (event_id, submission_id, session_title, session_satisfaction, business_relevance, speaker_quality, session_comments, overall_event_value, nps_score, partner_select_lift, respondent_role, respondent_industry)
          VALUES (${r.event_id}, ${r.submission_id}, ${r.session_title}, ${r.session_satisfaction}, ${r.business_relevance}, ${r.speaker_quality}, ${r.session_comments}, ${r.overall_event_value}, ${r.nps_score}, ${r.partner_select_lift}, ${r.respondent_role}, ${r.respondent_industry})
        `;
        imported++;
      } catch(ie) { skipped++; }
    }

    // Auto-update speaker history from survey data
    try {
      var speakerSubs = await sql`
        SELECT s.content_lead, AVG(sr.speaker_quality) as avg_quality, AVG(sr.session_satisfaction) as avg_sat, AVG(sr.business_relevance) as avg_rel, COUNT(*) as responses
        FROM survey_responses sr
        JOIN submissions s ON s.id = sr.submission_id
        WHERE sr.event_id = ${eventId} AND s.content_lead IS NOT NULL AND sr.speaker_quality IS NOT NULL
        GROUP BY s.content_lead
      `;
      for (var si = 0; si < speakerSubs.length; si++) {
        var sp = speakerSubs[si];
        await sql`
          INSERT INTO speaker_history (full_name, avg_speaker_rating, avg_session_satisfaction, avg_business_relevance, events_count)
          VALUES (${sp.content_lead}, ${parseFloat(sp.avg_quality)}, ${parseFloat(sp.avg_sat)}, ${parseFloat(sp.avg_rel)}, 1)
          ON CONFLICT (email) DO UPDATE SET
            avg_speaker_rating = (speaker_history.avg_speaker_rating + EXCLUDED.avg_speaker_rating) / 2,
            avg_session_satisfaction = (speaker_history.avg_session_satisfaction + EXCLUDED.avg_session_satisfaction) / 2,
            events_count = speaker_history.events_count + 1,
            updated_at = NOW()
        `;
      }
    } catch(she) { console.log('[speaker_history]', she.message); }

    res.json({ ok: true, imported: imported, skipped: skipped, total_rows: rows.length });
  } catch(err) {
    console.error('[api/import-survey]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST extract lessons from survey data and store as memories
app.post('/api/events/:id/memories/extract-lessons', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;

    // Get event info
    var evtResult = await sql`SELECT * FROM events WHERE id = ${eventId}`;
    if (!evtResult.length) return res.status(404).json({ ok: false, error: 'Event not found' });
    var evt = evtResult[0];

    // Get survey aggregate stats
    var stats = await sql`
      SELECT
        AVG(session_satisfaction) as avg_satisfaction,
        AVG(business_relevance) as avg_relevance,
        AVG(speaker_quality) as avg_speaker,
        AVG(nps_score) as avg_nps,
        COUNT(*) as total_responses,
        COUNT(DISTINCT submission_id) as sessions_rated
      FROM survey_responses WHERE event_id = ${eventId}
    `;

    // Get per-session stats
    var sessionStats = await sql`
      SELECT sr.session_title, s.track, s.bu, s.format,
        AVG(sr.session_satisfaction) as avg_sat,
        AVG(sr.business_relevance) as avg_rel,
        AVG(sr.speaker_quality) as avg_spk,
        COUNT(*) as responses,
        STRING_AGG(sr.session_comments, ' | ') as all_comments
      FROM survey_responses sr
      LEFT JOIN submissions s ON s.id = sr.submission_id
      WHERE sr.event_id = ${eventId}
      GROUP BY sr.session_title, s.track, s.bu, s.format
      ORDER BY avg_sat DESC
    `;

    var systemPrompt = 'You are an event intelligence analyst. Extract 5-10 specific, actionable lessons from post-event survey data. Each lesson should be concrete enough to influence future session selection decisions. Return ONLY valid JSON: { "lessons": [{ "category": "what_worked|what_didnt|speaker_insight|topic_trend|audience_signal|kpi_outcome", "content": "specific lesson in one clear sentence", "signal_strength": 0.5-2.0 }] }';

    var userPrompt = 'Event: ' + evt.name + '\n\nOverall stats: ' + JSON.stringify(stats[0]) + '\n\nPer-session data: ' + JSON.stringify(sessionStats.slice(0, 20));

    var lessonsResult = await callClaude(systemPrompt, userPrompt, true);
    var lessons = lessonsResult.lessons || [];

    var stored = 0;
    for (var li = 0; li < lessons.length; li++) {
      var lesson = lessons[li];
      var embedding = await generateEmbedding(lesson.content);
      var embStr = embedding ? '[' + embedding.join(',') + ']' : null;
      if (embStr) {
        await sql`
          INSERT INTO event_memories (event_id, category, content, embedding, signal_strength, source)
          VALUES (${eventId}, ${lesson.category}, ${lesson.content}, ${embStr}::vector, ${lesson.signal_strength || 1.0}, 'auto_extracted')
        `;
      } else {
        await sql`
          INSERT INTO event_memories (event_id, category, content, signal_strength, source)
          VALUES (${eventId}, ${lesson.category}, ${lesson.content}, ${lesson.signal_strength || 1.0}, 'auto_extracted')
        `;
      }
      stored++;
    }

    res.json({ ok: true, lessons_extracted: stored, lessons: lessons });
  } catch(err) {
    console.error('[api/extract-lessons]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET submission version history
app.get('/api/submissions/:id/versions', async function(req, res) {
  try {
    var sql = getDb();
    var versions = await sql`
      SELECT id, version_number, edited_by, created_at,
        snapshot->>'title' as title,
        snapshot->>'status' as status
      FROM submission_versions
      WHERE submission_id = ${req.params.id}
      ORDER BY version_number DESC
    `;
    res.json({ ok: true, versions: versions });
  } catch(err) {
    console.error('[api/versions]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET survey results for an event
app.get('/api/events/:id/survey', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.params.id;
    var summary = await sql`
      SELECT
        COUNT(*) as total_responses,
        ROUND(AVG(session_satisfaction)::numeric, 1) as avg_satisfaction,
        ROUND(AVG(business_relevance)::numeric, 1) as avg_relevance,
        ROUND(AVG(speaker_quality)::numeric, 1) as avg_speaker_quality,
        ROUND(AVG(nps_score)::numeric, 1) as avg_nps,
        COUNT(CASE WHEN overall_event_value >= 4 THEN 1 END) * 100 / NULLIF(COUNT(*), 0) as pct_high_value,
        COUNT(CASE WHEN partner_select_lift = 'Yes' THEN 1 END) * 100 / NULLIF(COUNT(*), 0) as pct_partner_lift
      FROM survey_responses WHERE event_id = ${eventId}
    `;
    var bySession = await sql`
      SELECT sr.session_title, s.id as submission_id, s.track, s.bu,
        COUNT(*) as responses,
        ROUND(AVG(sr.session_satisfaction)::numeric, 1) as avg_satisfaction,
        ROUND(AVG(sr.business_relevance)::numeric, 1) as avg_relevance,
        ROUND(AVG(sr.speaker_quality)::numeric, 1) as avg_speaker_quality
      FROM survey_responses sr
      LEFT JOIN submissions s ON s.id = sr.submission_id
      WHERE sr.event_id = ${eventId}
      GROUP BY sr.session_title, s.id, s.track, s.bu
      ORDER BY avg_satisfaction DESC NULLS LAST
    `;
    res.json({ ok: true, summary: summary[0], by_session: bySession });
  } catch(err) {
    console.error('[api/survey GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── SPEAKERS API ───────────────────────────────────────────────────────────

app.get('/api/speakers', async function(req, res) {
  try {
    var sql = getDb();
    var event_id = req.query.event_id;
    if (!event_id) {
      return res.status(400).json({ ok: false, error: 'event_id query parameter is required' });
    }
    var speakers = await sql`
      SELECT id, event_id, full_name, title, company, email, bio, created_at, (headshot IS NOT NULL) as has_headshot
      FROM speakers
      WHERE event_id = ${event_id}
      ORDER BY full_name ASC
    `;

    res.json({ ok: true, speakers: speakers });
  } catch (err) {
    console.error('[api/speakers GET]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/speakers/:id/headshot-debug', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var result = await sql`SELECT id, headshot_mimetype, (headshot IS NOT NULL) as has_headshot, octet_length(headshot) as headshot_bytes, LEFT(encode(headshot, 'hex'), 20) as headshot_hex_prefix FROM speakers WHERE id = ${id}`;
    res.json({ result: result[0] || null });
  } catch(err) { res.json({ error: err.message }); }
});

app.get('/api/speakers/:id/headshot-inspect', async function(req, res) {
  try {
    var sql = getDb();
    var result = await sql`SELECT headshot, headshot_mimetype FROM speakers WHERE id = ${req.params.id}`;
    if (!result.length) return res.json({ found: false });
    var raw = result[0].headshot;
    var info = {
      type: typeof raw,
      constructor: raw && raw.constructor ? raw.constructor.name : 'null',
      isBuffer: Buffer.isBuffer(raw),
      isUint8Array: raw instanceof Uint8Array,
      length: raw ? (raw.length || raw.byteLength || 'no-len') : null,
      first4: null
    };
    try {
      if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
        info.first4 = Buffer.from(raw).slice(0,4).toString('hex');
      } else if (typeof raw === 'string') {
        info.first20chars = raw.slice(0, 20);
      } else if (raw && typeof raw === 'object') {
        info.keys = Object.keys(raw).slice(0, 5);
        info.first4ofData = raw.data ? raw.data.slice(0,4) : null;
      }
    } catch(e) { info.inspectError = e.message; }
    res.json(info);
  } catch(err) { res.json({ error: err.message }); }
});

app.post('/api/speakers/migrate-headshots', async function(req, res) {
  try {
    var sql = getDb();
    var speakers = await sql`SELECT id, headshot, headshot_mimetype FROM speakers WHERE headshot IS NOT NULL`;
    var fixed = 0;
    for (var s of speakers) {
      var raw = s.headshot;
      var buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      // Check if buffer contains JSON text
      if (buf[0] !== 0x7b && buf[0] !== 0x5b) continue;
      var trimmed = buf.toString('utf8');
      try {
        var parsed = JSON.parse(trimmed);
        var arr = parsed.data || parsed;
        buf = Buffer.from(arr);
        var mime = s.headshot_mimetype || (buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg' : 'image/png');
        await sql`UPDATE speakers SET headshot = ${buf}, headshot_mimetype = ${mime} WHERE id = ${s.id}`;
        fixed++;
      } catch(e) { console.error('migrate speaker', s.id, e.message); }
    }
    res.json({ ok: true, fixed: fixed, total: speakers.length });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/speakers/:id/headshot', async function(req, res) {
  try {
    var sql = getDb();
    var result = await sql`SELECT headshot, headshot_mimetype FROM speakers WHERE id = ${req.params.id}`;
    if (!result.length || !result[0].headshot) return res.status(404).send('Not found');
    var raw = result[0].headshot;

    // Normalize to Buffer
    var buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    // If the buffer contains JSON text (first byte is '{'), unwrap it
    if (buf[0] === 0x7b || buf[0] === 0x5b) {
      try {
        var parsed = JSON.parse(buf.toString('utf8'));
        buf = Buffer.from(parsed.data || parsed);
      } catch(e) { /* not JSON, use as-is */ }
    }

    var mime = result[0].headshot_mimetype ||
      (buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg' :
       buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    console.error('[headshot]', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});


app.post('/api/speakers', upload.single('headshot'), async function(req, res) {
  try {
    var sql = getDb();
    var b = req.body;
    var headshot = req.file ? req.file.buffer : null;
    var headshot_mimetype = req.file ? req.file.mimetype : null;
    
    if (!b.event_id || !b.full_name) {
      return res.status(400).json({ ok: false, error: 'event_id and full_name are required' });
    }

    var result = await sql`
      INSERT INTO speakers (event_id, full_name, title, company, email, bio, headshot, headshot_mimetype)
      VALUES (${b.event_id}, ${b.full_name}, ${b.title || ''}, ${b.company || ''}, ${b.email || ''}, ${b.bio || ''}, ${headshot}, ${headshot_mimetype})
      RETURNING id, event_id, full_name, title, company, email, bio, created_at, (headshot IS NOT NULL) as has_headshot
    `;
    
    var speaker = result[0];
    res.status(201).json({ ok: true, speaker: speaker });
  } catch (err) {
    console.error('[api/speakers POST]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/speakers/:id', upload.single('headshot'), async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var b = req.body;
    var headshot = req.file ? req.file.buffer : null;
    var headshot_mimetype = req.file ? req.file.mimetype : null;

    var current = await sql`SELECT id FROM speakers WHERE id = ${id}`;
    if (current.length === 0) {
        return res.status(404).json({ ok: false, error: 'Speaker not found' });
    }

    var result;
    if (headshot) {
      result = await sql`
        UPDATE speakers
        SET full_name=${b.full_name}, title=${b.title}, company=${b.company}, email=${b.email}, bio=${b.bio}, headshot=${headshot}, headshot_mimetype=${headshot_mimetype}
        WHERE id = ${id}
        RETURNING id, event_id, full_name, title, company, email, bio, created_at, (headshot IS NOT NULL) as has_headshot
      `;
    } else {
      result = await sql`
        UPDATE speakers
        SET full_name=${b.full_name}, title=${b.title}, company=${b.company}, email=${b.email}, bio=${b.bio}
        WHERE id = ${id}
        RETURNING id, event_id, full_name, title, company, email, bio, created_at, (headshot IS NOT NULL) as has_headshot
      `;
    }

    var speaker = result[0];
    res.json({ ok: true, speaker: speaker });
  } catch (err) {
    console.error('[api/speakers PUT]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/speakers/:id', async function(req, res) {
  try {
    var sql = getDb();
    var id = req.params.id;
    var result = await sql`DELETE FROM speakers WHERE id = ${id} RETURNING id`;
    if (result.length === 0) {
      return res.status(404).json({ ok: false, error: 'Speaker not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/speakers DELETE]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ─── FRONTEND ─────────────────────────────────────────────────────────────────

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────

// Run schema migration BEFORE accepting requests
ensureSchema()
  .then(function () {
    console.log('[startup] Schema ready, seeding data...');
    return seedData();
  })
  .then(function () {
    console.log('[startup] Data seeded, starting server...');
    app.listen(PORT, '0.0.0.0', function () {
      console.log('[server] listening on port ' + PORT);
    });
  })
  .catch(function (err) {
    console.error('[startup] DB error:', err.message);
    // Start server anyway for graceful degradation
    app.listen(PORT, '0.0.0.0', function () {
      console.log('[server] listening on port ' + PORT + ' (DB migration failed)');
    });
  });
