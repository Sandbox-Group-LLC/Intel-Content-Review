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
      model: 'claude-3-haiku-20240307',
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

async function callGemini(systemPrompt, userPrompt, isJson) {
  var GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable not set.');
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + GEMINI_API_KEY;
  
  var requestBody = {
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{ 
      parts: [{ text: userPrompt }]
    }],
    generationConfig: {}
  };

  if (isJson) {
    requestBody.generationConfig.responseMimeType = 'application/json';
  }

  try {
    var response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    if (!response.data.candidates || !response.data.candidates.length) {
        throw new Error('No content returned from Gemini API');
    }
    
    var contentText = response.data.candidates[0].content.parts[0].text;
    
    if (isJson) {
      return JSON.parse(contentText);
    } else {
      return contentText;
    }
  } catch (error) {
    console.error('Error calling Gemini API:', error.response ? error.response.data : error.message);
    if (error.response && error.response.data && error.response.data.error) {
        console.error('Gemini API Error Details:', error.response.data.error.message);
    }
    throw new Error('Failed to get response from AI model.');
  }
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
      '1. Federal Relevance — Does this directly address federal/defense/IC use cases, mission requirements, or procurement concerns?',
      '2. Technical Depth — Is the content substantive enough for technical buyers and architects in cleared environments?',
      '3. Intel Alignment — Does it showcase Intel silicon, software, or ecosystem advantages meaningfully?',
      '4. Audience Fit — Is the content level and framing appropriate for GS-13+, SES, and senior program managers?',
      '5. Innovation Signal — Does it present genuinely new capabilities, architectures, or approaches vs. known baselines?',
      '6. Delivery Readiness — Are the speakers credible, is the format appropriate, and is the abstract clear enough to attract the right attendees?',
      '',
      'Return ONLY valid JSON in this exact shape:',
      '{',
      '  "overall": <integer 0-100>,',
      '  "dimensions": {',
      '    "federal_relevance": { "score": <int>, "rationale": "<string>" },',
      '    "technical_depth": { "score": <int>, "rationale": "<string>" },',
      '    "intel_alignment": { "score": <int>, "rationale": "<string>" },',
      '    "audience_fit": { "score": <int>, "rationale": "<string>" },',
      '    "innovation_signal": { "score": <int>, "rationale": "<string>" },',
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

// IMPORTANT: generate-profile must be before /api/events/:id
app.post('/api/events/generate-profile', async function (req, res) {
  try {
    var context_raw = req.body.context_raw;
    if (!context_raw) return res.status(400).json({ ok: false, error: 'context_raw is required.' });
    var systemPrompt = 'You are an expert assistant for creating event content strategies. Given raw context about an event, generate two things: (1) a concise context_profile summarizing the event focus, audience, and key themes for content submitters, and (2) a detailed ai_system_prompt for an AI that will score session submissions. The ai_system_prompt must instruct the AI to score on six dimensions: federal_relevance, technical_depth, intel_alignment, audience_fit, innovation_signal, delivery_readiness (each returning score 0-100 and rationale), plus overall (0-100), strengths (array), gaps (array), and recommendation (Accept|Accept with Revisions|Decline). Return ONLY valid JSON with keys: context_profile and ai_system_prompt.';
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
    var result = await sql`
      UPDATE events SET
        name = ${name},
        event_date = ${event_date},
        venue = ${venue},
        slot_count = ${slot_count},
        context_profile = ${context_profile},
        ai_system_prompt = ${ai_system_prompt}
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
    
    res.json({ ok: true, submission: submission });
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
    var scorecard = await callGemini(evt.ai_system_prompt, userPrompt, true);
    await sql`UPDATE submissions SET ai_score = ${scorecard} WHERE id = ${id}`;
    res.json({ ok: true, scorecard: scorecard });
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
        status = COALESCE(${b.status}, status)
      WHERE id = ${id}
      RETURNING *
    `;
    
    if (!result.length) {
      return res.status(404).json({ ok: false, error: 'Submission not found' });
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
    
    res.json({ ok: true, submission: result[0] });
  } catch (err) {
    console.error('[api/submissions PUT]', err.message);
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
