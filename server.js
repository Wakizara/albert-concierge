const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsing for JSON APIs.
app.use(express.json({ limit: '8kb' }));

// Anthropic client for marketplace brief parsing.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Supabase client — used to persist waitlist sign-ups.
// Anon key is fine here: RLS on `waitlist` allows anon INSERT only.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://whdshixpoazdmitiatfo.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}) : null;

// Backoffice access — redirects to the standalone admin app on Vercel.
// Auth + email allowlist enforced on that app side (contact@albert-conciergerie.com only).
const ADMIN_URL = 'https://albert-admin-alpha.vercel.app';

app.get('/admin', (_req, res) => {
  res.redirect(`${ADMIN_URL}/login`);
});

app.get('/admin/*splat', (req, res) => {
  const subpath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : (req.params.splat || '');
  res.redirect(`${ADMIN_URL}/${subpath}`);
});

// ---------- Waitlist ----------
// POST { email, name? } — validates, optionally forwards to a webhook (env WAITLIST_WEBHOOK).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/waitlist', async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const entry = {
    email,
    name: name || null,
    source: 'albert-conciergerie.com',
    user_agent: (req.headers['user-agent'] || '').slice(0, 240),
    ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim(),
  };

  // Persist to Supabase. The unique index on email makes duplicate sign-ups idempotent.
  if (supabase) {
    const { error } = await supabase.from('waitlist').insert(entry);
    if (error) {
      // 23505 = duplicate key. Treat as success so the user gets a kind UX.
      if (error.code === '23505') {
        console.log('[waitlist] duplicate', email);
        return res.json({ ok: true, duplicate: true });
      }
      console.error('[waitlist] supabase insert failed:', error.message, error.code);
      return res.status(500).json({ ok: false, error: 'storage_failed' });
    }
    console.log('[waitlist] stored', email);
  } else {
    // No Supabase configured — fall back to logs so entries aren't lost in dev.
    console.log('[waitlist:no-store]', JSON.stringify({ ...entry, created_at: new Date().toISOString() }));
  }

  // Optional: also forward to a webhook (Slack/Make/etc.) if configured.
  const webhook = process.env.WAITLIST_WEBHOOK;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...entry, created_at: new Date().toISOString() }),
      });
    } catch (err) {
      console.error('[waitlist] webhook failed:', err?.message || err);
    }
  }

  return res.json({ ok: true });
});

// ---------- Membership applications ----------
// POST { first_name, last_name, email, phone, description, instagram?, linkedin?, x_handle? }
// Persists to member_applications (source 'website'). RLS allows anon INSERT
// in 'pending' only. The concierge reviews in the back-office.
app.post('/api/apply', async (req, res) => {
  const b = req.body || {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  const application = {
    first_name: str(b.first_name, 80),
    last_name: str(b.last_name, 80),
    email: str(b.email, 254).toLowerCase(),
    phone: str(b.phone, 40),
    description: str(b.description, 2000),
    instagram: str(b.instagram, 200) || null,
    linkedin: str(b.linkedin, 300) || null,
    x_handle: str(b.x_handle, 200) || null,
    source: 'website',
    status: 'pending',
  };

  if (!application.first_name || !application.last_name) {
    return res.status(400).json({ ok: false, error: 'missing_name' });
  }
  if (!EMAIL_RE.test(application.email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }
  if (application.description.length < 10) {
    return res.status(400).json({ ok: false, error: 'missing_description' });
  }

  if (!supabase) {
    console.log('[apply:no-store]', JSON.stringify(application));
    return res.json({ ok: true });
  }

  const { error } = await supabase.from('member_applications').insert(application);
  if (error) {
    console.error('[apply] supabase insert failed:', error.message, error.code);
    return res.status(500).json({ ok: false, error: 'storage_failed' });
  }
  console.log('[apply] stored', application.email);
  return res.json({ ok: true });
});

// ---------- Marketplace · brief parsing ----------
// POST { brief: "natural language" } -> { city, category, guests, dates, budget_max, dietary, notes }
const MK_CITIES = ['Monaco', 'Mykonos', 'Paris', 'Dubai', 'Tokyo', 'London', 'St-Tropez', 'Aspen'];
const MK_CATEGORIES = ['Yacht', 'Chef', 'Aviation', 'Villa', 'Helicopter', 'Driver', 'Security', 'Spa'];

const MK_SYSTEM_PROMPT = `You are Albert's marketplace parser. A concierge writes a free-text brief describing a service their guest needs. Extract structured filters.

Return ONLY a JSON object, no prose, with this exact shape:
{
  "city": one of [${MK_CITIES.map(c => `"${c}"`).join(', ')}] or null,
  "category": one of [${MK_CATEGORIES.map(c => `"${c}"`).join(', ')}] or null,
  "guests": integer or null,
  "dates": short string like "Friday" or "next weekend" or null,
  "budget_max": integer in euros or null,
  "dietary": short string or null,
  "notes": short string with anything else important or null,
  "understood": one short human sentence describing what you understood, in the concierge's language
}

Rules:
- If the city or category is ambiguous or absent, return null for that field (do NOT guess).
- "private chef" -> category "Chef". "yacht" / "boat" / "sailing" -> "Yacht". "jet" / "plane" -> "Aviation". "helicopter" / "heli" -> "Helicopter". "villa" / "chalet" / "residence" -> "Villa". "driver" / "chauffeur" / "car" -> "Driver". "bodyguard" / "security" / "protection" -> "Security". "spa" / "massage" / "wellness" -> "Spa".
- Convert k/K shorthand to thousands (e.g. "30k" -> 30000).
- Strip currency symbols from budget.
- "understood" should mirror the language of the brief (French if input is French, English otherwise) and be under 20 words.`;

app.post('/api/marketplace/brief', async (req, res) => {
  const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim().slice(0, 1000) : '';
  if (!brief) return res.status(400).json({ ok: false, error: 'empty_brief' });
  if (!anthropic) return res.status(503).json({ ok: false, error: 'ai_unavailable' });

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: MK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: brief }],
    });
    const text = msg.content.find(b => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no_json_in_response');
    const parsed = JSON.parse(jsonMatch[0]);
    // Validate enums
    if (parsed.city && !MK_CITIES.includes(parsed.city)) parsed.city = null;
    if (parsed.category && !MK_CATEGORIES.includes(parsed.category)) parsed.category = null;
    return res.json({ ok: true, ...parsed });
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('[marketplace/brief]', msg);
    // Surface a coarse category so the UI can show a useful message.
    const code = /credit balance|billing|rate_limit/i.test(msg) ? 'ai_quota'
               : /api[_ ]?key|authentication/i.test(msg) ? 'ai_auth'
               : 'parse_failed';
    return res.status(500).json({ ok: false, error: code });
  }
});

// Marketplace · brief-request stub (logs intent; real provider notification TBD)
app.post('/api/marketplace/brief-request', (req, res) => {
  const body = req.body || {};
  console.log('[marketplace/brief-request]', JSON.stringify({
    provider: typeof body.provider === 'string' ? body.provider.slice(0, 200) : '',
    ts: typeof body.ts === 'number' ? body.ts : Date.now(),
  }));
  return res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Membership application form.
app.get('/apply', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'apply.html'));
});

// Hidden investor mockup — not linked from the main site.
app.get('/marketplace', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'marketplace.html'));
});

// Concierge dashboard preview — what a logged-in concierge sees daily.
app.get('/marketplace/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'marketplace-dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Albert server running on port ${PORT}`);
});

module.exports = app;
