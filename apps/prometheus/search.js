/**
 * search.js — Prometheus prospect finder
 *
 * Navigates LinkedIn people search, extracts profile URLs,
 * and saves new prospects to the leads table in Supabase.
 *
 * Usage:
 *   CAMPAIGN_ID=<uuid> SEARCH_JOB_ID=<uuid> node search.js
 *
 * Or create a search_job row first (recommended):
 *   node search.js --campaign <uuid> --keywords "Director Finanzas Mexico" --count 25
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import { supabase, logActivity } from './lib/supabase.js';

dotenv.config();
chromium.use(StealthPlugin());

const LI_AT_COOKIE    = process.env.LI_AT;
const CAMPAIGN_ID     = process.env.CAMPAIGN_ID;
const SEARCH_JOB_ID   = process.env.SEARCH_JOB_ID;  // optional — auto-created if absent

// Parse CLI flags: --keywords "..." --count 25 --location "Mexico" --title "Director"
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanDelay() {
  await new Promise(r => setTimeout(r, randInt(1200, 2800)));
}

// Delay entre páginas de búsqueda — más largo que humanDelay para simular lectura + scroll
async function pageDelay() {
  await new Promise(r => setTimeout(r, randInt(7000, 18000)));
}

// Scroll suave antes de paginar — simula que el usuario revisó los resultados
async function humanScrollSearch(page) {
  const steps = randInt(3, 6);
  for (let i = 0; i < steps; i++) {
    await page.evaluate(s => window.scrollBy(0, s), randInt(200, 400));
    await new Promise(r => setTimeout(r, randInt(300, 700)));
  }
  // Scroll de regreso a la parte superior antes del next page (como haría un humano)
  await new Promise(r => setTimeout(r, randInt(500, 1200)));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await new Promise(r => setTimeout(r, randInt(600, 1000)));
}

// ── Build LinkedIn search URL ─────────────────────────────────────────────
function buildSearchUrl(filters) {
  const base = 'https://www.linkedin.com/search/results/people/';
  const params = new URLSearchParams();

  if (filters.keywords) params.set('keywords', filters.keywords);
  if (filters.location) {
    // LinkedIn uses geoUrn for location — keyword search includes it naturally
    params.set('keywords', [filters.keywords, filters.location].filter(Boolean).join(' '));
  }
  params.set('origin', 'GLOBAL_SEARCH_HEADER');

  return `${base}?${params.toString()}`;
}

// ── Extract profile cards from search results page ────────────────────────
// Strategy:
//   1. Find profile name links: <a href*="/in/"> whose visible text is short
//      (names < 80 chars) — this excludes mutual-connection links buried in cards
//   2. Walk up exactly 4 levels to get the tight card container
//   3. Extract headline/location from <p> siblings — skip name and noise
async function extractProfilesFromPage(page) {
  return page.evaluate(() => {
    const NOISE_RE = /^[•·]\s*\d|conectar|connect|mensaje|message|seguir|follow|pendiente/i;
    const seen = new Set();
    const results = [];

    // Both relative (/in/) and absolute (linkedin.com/in/) hrefs
    const allLinks = Array.from(document.querySelectorAll(
      'a[href*="/in/"], a[href*="linkedin.com/in/"]'
    ));

    for (const link of allLinks) {
      const href = link.getAttribute('href') || '';
      // Normalize to absolute URL
      const fullHref = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
      const profileUrl = fullHref.split('?')[0].replace(/\/$/, '') + '/';
      if (!profileUrl.includes('/in/')) continue;
      if (seen.has(profileUrl)) continue;

      // Name: direct text nodes only (ignores child spans like badge, degree icon)
      const nameFromNodes = Array.from(link.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      // Filter: name links have short text. Long text = mutual-connection link or nav link.
      if (!nameFromNodes || nameFromNodes.length > 80) continue;
      // Skip links that look like UI actions
      if (NOISE_RE.test(nameFromNodes)) continue;

      seen.add(profileUrl);
      const name = nameFromNodes;

      // Walk up 4 levels from <a> to get a tight card container
      // Structure: <a> → <p> → <div> → <div> → card-div
      let card = link.parentElement?.parentElement?.parentElement?.parentElement || null;

      // Collect <p> texts from card, excluding name and noise
      const paras = card
        ? Array.from(card.querySelectorAll('p'))
            .map(p => {
              // Get text content but strip child <a> text (mutual connection names)
              // by only reading direct text nodes + non-anchor descendants
              return (p.textContent || '').replace(/\s+/g, ' ').trim();
            })
            .filter(t =>
              t &&
              t !== name &&
              t.length < 100 &&
              !NOISE_RE.test(t) &&
              !t.includes(name.split(' ')[0]) // skip paras that contain the name
            )
        : [];

      // Headline: first substantive para (not a degree "• 2º" indicator)
      const headline = paras.find(t => !/^[•·\-]\s/.test(t) && t.length > 5) || null;
      // Location: typically contains commas or is short
      const location = paras.find(t =>
        t !== headline && (t.includes(',') || (t.length < 60 && t.length > 3))
      ) || null;

      results.push({
        profileUrl,
        name,
        headline: headline || null,
        location: location || null,
      });
    }

    return results;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
  if (!LI_AT_COOKIE || LI_AT_COOKIE === 'PASTE_YOUR_LI_AT_COOKIE_HERE') {
    console.error('[SEARCH] ERROR: LI_AT not set in .env'); process.exit(1);
  }
  if (!CAMPAIGN_ID) {
    console.error('[SEARCH] ERROR: CAMPAIGN_ID not set'); process.exit(1);
  }

  const cli = parseArgs();

  // ── Load campaign config from Supabase ────────────────────────────────
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('search_keywords, search_location, search_count, title_blacklist, title_whitelist')
    .eq('id', CAMPAIGN_ID)
    .single();

  if (campErr) {
    console.error('[SEARCH] Could not load campaign:', campErr.message); process.exit(1);
  }

  // CLI args override campaign defaults — useful for one-off searches
  const keywords    = cli.keywords || (campaign.search_keywords?.[0] ?? 'Director General Mexico');
  const location    = cli.location || campaign.search_location || null;
  const targetCount = parseInt(cli.count || campaign.search_count || '25');
  const blacklist   = campaign.title_blacklist || [];
  const whitelist   = campaign.title_whitelist || [];

  if (!cli.keywords && campaign.search_keywords?.length) {
    console.log(`[SEARCH] Keywords from campaign: ${campaign.search_keywords.join(', ')}`);
  }

  // ── Load or create search_job ──────────────────────────────────────────
  let job;
  if (SEARCH_JOB_ID) {
    const { data } = await supabase.from('search_jobs').select('*').eq('id', SEARCH_JOB_ID).single();
    job = data;
  } else {
    const { data, error } = await supabase.from('search_jobs').insert({
      campaign_id:   CAMPAIGN_ID,
      search_type:   'linkedin_people',
      filters:       { keywords, location, title: cli.title || null },
      target_count:  targetCount,
      status:        'running',
      started_at:    new Date().toISOString(),
    }).select().single();

    if (error) { console.error('[SEARCH] Could not create search_job:', error.message); process.exit(1); }
    job = data;
    console.log(`[SEARCH] Created search_job ${job.id}`);
  }

  const jobFilters = job.filters;

  console.log(`[SEARCH] Job ${job.id} — looking for ${targetCount} prospects`);
  console.log(`[SEARCH] Filters: ${JSON.stringify(jobFilters)}`);

  // ── Launch browser ─────────────────────────────────────────────────────
  const PROXY_URL = process.env.PROXY_URL || null;
  if (!PROXY_URL) {
    console.error('[SEARCH] ❌ PROXY_URL no configurado — abortando para evitar ban de IP de datacenter.');
    process.exit(1);
  }

  function parseProxy(proxyUrl) {
    if (!proxyUrl) return null;
    try {
      const u = new URL(proxyUrl);
      return {
        server:   `${u.protocol}//${u.hostname}:${u.port}`,
        username: u.username || undefined,
        password: u.password || undefined,
      };
    } catch {
      return { server: proxyUrl };
    }
  }

  const proxy = parseProxy(PROXY_URL);

  if (proxy) console.log(`[SEARCH] Using proxy: ${proxy.server}`);
  else       console.log('[SEARCH] ⚠️  No proxy configured — using direct IP (ban risk on datacenter IPs)');

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'];
  const browser = await chromium.launch({ headless: true, args: launchArgs });

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  ];
  const context = await browser.newContext({
    userAgent: USER_AGENTS[randInt(0, USER_AGENTS.length - 1)],
    viewport: { width: randInt(1260, 1440), height: randInt(860, 920) },
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    ...(proxy ? { proxy } : {}),
  });

  await context.addCookies([{
    name: 'li_at', value: LI_AT_COOKIE,
    domain: '.linkedin.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'None',
  }]);

  const page = await context.newPage();

  // ── Session warmup — visit feed first like a real user ────────────────
  console.log('[SEARCH] Warming up session — visiting feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (page.url().includes('/login') || page.url().includes('/authwall')) {
    console.error('[SEARCH] Cookie expired — re-login required.');
    await browser.close(); process.exit(1);
  }
  // Simulate reading the feed for a few seconds
  await page.waitForTimeout(randInt(3000, 6000));
  await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300) + 300));
  await page.waitForTimeout(randInt(1500, 3000));
  console.log('[SEARCH] Session warm — proceeding to search.');

  const found   = [];
  const seen    = new Set();
  let   pageNum = 1;
  const MAX_PAGES = 40;

  try {
    while (found.length < targetCount && pageNum <= MAX_PAGES) {
      const url = buildSearchUrl(jobFilters) + `&page=${pageNum}`;
      console.log(`[SEARCH] Page ${pageNum} → ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Verify still authenticated
      if (page.url().includes('/login') || page.url().includes('/authwall')) {
        console.error('[SEARCH] Cookie expired — re-login required.'); break;
      }

      // Wait for results to render — anchor on profile links (class-agnostic)
      try {
        await page.waitForSelector(
          'a[href*="linkedin.com/in/"]',
          { state: 'attached', timeout: 12000 }
        );
      } catch {
        console.log('[SEARCH] No results on this page — stopping.');
        break;
      }

      await humanDelay();
      const profiles = await extractProfilesFromPage(page);

      if (!profiles.length) {
        console.log('[SEARCH] Empty page — end of results.');
        break;
      }

      for (const p of profiles) {
        if (seen.has(p.profileUrl)) continue;
        seen.add(p.profileUrl);

        // ── Title whitelist filter (si hay lista, el headline debe tener al menos uno) ─
        if (whitelist.length > 0) {
          const h = (p.headline || '').toLowerCase();
          const matched = whitelist.find(w => h.includes(w.toLowerCase()));
          if (!matched) {
            console.log(`[SEARCH] Skipped (no whitelist match): ${p.name} — ${p.headline}`);
            continue;
          }
        }

        // ── Title blacklist filter ────────────────────────────────────────
        if (blacklist.length > 0 && p.headline) {
          const h = p.headline.toLowerCase();
          const blocked = blacklist.find(b => h.includes(b.toLowerCase()));
          if (blocked) {
            console.log(`[SEARCH] Skipped (blacklist: "${blocked}"): ${p.name} — ${p.headline}`);
            continue;
          }
        }

        found.push(p);
        if (found.length >= targetCount) break;
      }

      console.log(`[SEARCH] Page ${pageNum}: +${profiles.length} profiles (total so far: ${found.length})`);
      pageNum++;
      await humanScrollSearch(page); // scroll como humano antes de ir a siguiente página
      await pageDelay();             // pausa larga entre páginas (7–18s)
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[SEARCH] Found ${found.length} profiles — saving to Supabase...`);

  // ── Save to leads (skip duplicates) ───────────────────────────────────
  let saved = 0;
  let dupes = 0;

  for (const p of found) {
    const { error } = await supabase.from('leads').insert({
      campaign_id:  CAMPAIGN_ID,
      linkedin_url: p.profileUrl,
      full_name:    p.name,
      status:       'pending',
      profile_data: { headline: p.headline, location: p.location },
      scraped_at:   new Date().toISOString(),
    });

    if (error?.code === '23505') { dupes++; } // unique violation = already exists
    else if (error) { console.warn(`[SEARCH] Insert error for ${p.profileUrl}:`, error.message); }
    else { saved++; }
  }

  // ── Update search_job status ───────────────────────────────────────────
  await supabase.from('search_jobs').update({
    status:       'completed',
    found_count:  saved,
    completed_at: new Date().toISOString(),
  }).eq('id', job.id);

  await logActivity(null, null, 'search_completed', 'success', {
    search_job_id: job.id,
    campaign_id:   CAMPAIGN_ID,
    found:         found.length,
    saved,
    dupes,
  });

  console.log(`[SEARCH] ✓ Saved ${saved} new prospects (${dupes} duplicates skipped)`);
  console.log(`[SEARCH] Done. Run batch.js to start processing.`);
}

run().catch(err => {
  console.error('[SEARCH] Fatal:', err);
  process.exit(1);
});
