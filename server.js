var express = require('express');
var path = require('path');
var axios = require('axios');
var { neon } = require('@neondatabase/serverless');
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
      timeout: 60000
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
        gate_90_deadline = ${gate_90_deadline}
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
