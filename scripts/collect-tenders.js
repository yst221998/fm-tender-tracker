#!/usr/bin/env node
/**
 * Free FM tender collector — runs in GitHub Actions or locally.
 * Fetches public listings from CPPP/eProcure and GeM, filters for FM keywords,
 * and writes data/tenders-feed.json.
 */

const fs = require('fs');
const path = require('path');

const FM_KEYWORDS = [
  'facility management',
  'integrated facility management',
  'ifm',
  'housekeeping',
  'soft services',
  'security services',
  'security guard',
  'pest control',
  'landscaping',
  'garden maintenance',
  'operations and maintenance',
  'operation and maintenance',
  'o&m',
  'o & m',
  'mep',
  'mechanical electrical plumbing',
  'cleaning services',
  'sanitation',
  'manpower supply',
  'support services',
  'facility services',
  'building maintenance',
  'estate management',
  'property management',
  'catering services',
  'laundry services',
  'waste management',
  'house keeping',
  'deep cleaning',
  'janitorial',
  'hospitality',
  'maintenance of garden',
  'maintenance of',
];

const CPPP_ORGWISE_URL =
  'https://eprocure.gov.in/eprocure/app?org=&page=FrontEndLatestActiveTendersOrgwise&service=page';

const FETCH_OPTS = {
  headers: {
    'User-Agent': 'FM-Tender-Tracker/1.0 (public tender aggregator; github-actions)',
    Accept: 'text/html,application/xhtml+xml',
  },
  signal: AbortSignal.timeout(45000),
};

function stripHtml(html) {
  return html
   .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function matchesFmKeywords(text) {
  const hay = (text || '').toLowerCase();
  return FM_KEYWORDS.some((kw) => hay.includes(kw));
}

function normalizeDeadline(raw) {
  if (!raw) return '';
  const m = raw.match(/(\d{2})[-/](\w{3})[-/](\d{4})/i);
  if (!m) return raw.trim();
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const mon = months[m[2].toLowerCase().slice(0, 3)];
  if (!mon) return raw.trim();
  return `${m[3]}-${mon}-${m[1]}`;
}

function dedupeKey(t) {
  const url = (t.url || '').toLowerCase().replace(/\/+$/, '');
  if (url) return url;
  return (t.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { ...FETCH_OPTS, ...opts });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

function parseCpppOrgwiseHtml(html) {
  const tenders = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowRe.exec(html)) !== null) {
    const row = match[1];
    if (!/<td/i.test(row)) continue;

    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) {
      cells.push(cm[1]);
    }
    if (cells.length < 6) continue;

    const closingRaw = decodeHtml(stripHtml(cells[2]));
    const titleHtml = cells[4];
    const orgRaw = decodeHtml(stripHtml(cells[5]));
    const titleFromBracket = titleHtml.match(/\[([^\]]{10,})\]/);
    const titleCell = titleFromBracket
      ? decodeHtml(titleFromBracket[1])
      : decodeHtml(stripHtml(titleHtml));
    if (!titleCell || titleCell.length < 8) continue;
    if (/^s\.?\s*no/i.test(titleCell)) continue;
    if (!matchesFmKeywords(titleCell + ' ' + orgRaw)) continue;

    const tidMatch = titleHtml.match(/\[(\d{4}_[A-Z0-9_]+_\d+)\]/i);
    const linkMatch = row.match(/href="([^"]*FrontEndTenderDetails[^"]*)"/i);
    let tenderUrl = '';
    if (linkMatch) {
      const href = linkMatch[1].replace(/&amp;/g, '&');
      tenderUrl = href.startsWith('http')
        ? href
        : `https://eprocure.gov.in/eprocure/app${href.startsWith('?') ? href : '?' + href}`;
    } else if (tidMatch) {
      tenderUrl = `https://eprocure.gov.in/eprocure/app?page=FrontEndTenderDetails&service=page&tid=${tidMatch[1]}`;
    }

    tenders.push({
      title: titleCell.replace(/\s+/g, ' ').trim(),
      org: orgRaw.replace(/\|\|/g, ' · ').trim(),
      location: '',
      deadline: normalizeDeadline(closingRaw),
      value: '',
      description: tidMatch ? `CPPP · ${tidMatch[1]}` : 'CPPP active tender',
      url: tenderUrl,
      source: 'cppp',
    });
  }

  return tenders;
}

async function collectCppp() {
  const all = [];
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = page === 1 ? CPPP_ORGWISE_URL : `${CPPP_ORGWISE_URL}&currentPage=${page}`;
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      if (page === 1) throw err;
      break;
    }
    const pageTenders = parseCpppOrgwiseHtml(html);
    if (!pageTenders.length) break;
    all.push(...pageTenders);
    if (page < maxPages) await new Promise((r) => setTimeout(r, 600));
  }

  return all;
}

async function collectGemForKeyword(keyword) {
  const body = new URLSearchParams({
    searchBid: keyword,
    searchType: 'fullText',
  });

  let html;
  try {
    html = await fetchText('https://bidplus.gem.gov.in/advance-search', {
      method: 'POST',
      headers: {
        ...FETCH_OPTS.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://bidplus.gem.gov.in/advance-search',
      },
      body: body.toString(),
    });
  } catch {
    html = await fetchText(`https://bidplus.gem.gov.in/all-bids?search=${encodeURIComponent(keyword)}`);
  }

  const tenders = [];
  const blockRe = /<div class="block[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;
  const blocks = html.match(blockRe) || [];

  for (const block of blocks) {
    const titleMatch = block.match(/<p[^>]*class="[^"]*bid_no[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const deptMatch = block.match(/Department Name And Address[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    const endMatch = block.match(/End Date[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    const itemsMatch = block.match(/Item\(s\)[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    const linkMatch = block.match(/href="(\/bidding\/bid\/getBidResultView\/[^"]+)"/i);

    const bidText = titleMatch ? decodeHtml(stripHtml(titleMatch[1])) : '';
    const items = itemsMatch ? decodeHtml(stripHtml(itemsMatch[1])) : '';
    const title = items || bidText;
    if (!title || title.length < 5) continue;
    if (!matchesFmKeywords(title + ' ' + bidText)) continue;

    const dept = deptMatch ? decodeHtml(stripHtml(deptMatch[1])) : '';
    tenders.push({
      title: title.replace(/\s+/g, ' ').trim(),
      org: dept.replace(/\s+/g, ' ').trim(),
      location: '',
      deadline: endMatch ? normalizeDeadline(decodeHtml(stripHtml(endMatch[1]))) : '',
      value: '',
      description: bidText ? `GeM · ${bidText}` : 'GeM bid listing',
      url: linkMatch ? `https://bidplus.gem.gov.in${linkMatch[1]}` : 'https://bidplus.gem.gov.in/all-bids',
      source: 'gem',
    });
  }

  if (tenders.length === 0) {
    const plain = stripHtml(html);
    const lines = plain.split(/\s{2,}/).filter((l) => l.length > 20 && matchesFmKeywords(l));
    for (const line of lines.slice(0, 15)) {
      tenders.push({
        title: line.slice(0, 200).trim(),
        org: '',
        location: '',
        deadline: '',
        value: '',
        description: `GeM search: ${keyword}`,
        url: `https://bidplus.gem.gov.in/advance-search`,
        source: 'gem',
      });
    }
  }

  return tenders;
}

async function collectGem() {
  const keywords = [
    'facility management',
    'housekeeping',
    'security services',
    'operation maintenance',
    'cleaning services',
    'pest control',
    'landscaping',
  ];
  const all = [];
  for (const kw of keywords) {
    try {
      const items = await collectGemForKeyword(kw);
      all.push(...items);
      await new Promise((r) => setTimeout(r, 800));
    } catch (err) {
      console.warn(`GeM keyword "${kw}" failed:`, err.message);
    }
  }
  return all;
}

async function collectEprocureHome() {
  const url = 'https://etenders.gov.in/eprocure/app?page=Home&service=page';
  const html = await fetchText(url);
  const tenders = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowRe.exec(html)) !== null) {
    const row = match[1];
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) {
      cells.push(decodeHtml(stripHtml(cm[1])));
    }
    if (cells.length < 3) continue;

    const title = cells[0] || '';
    const ref = cells[1] || '';
    const closing = cells[2] || '';
    if (!title || title.length < 15) continue;
    if (!matchesFmKeywords(title)) continue;

    tenders.push({
      title: title.replace(/^\d+\.\s*/, '').trim(),
      org: ref,
      location: '',
      deadline: normalizeDeadline(closing),
      value: '',
      description: 'eProcure home listing',
      url: 'https://etenders.gov.in/eprocure/app?page=FrontEndLatestActiveTenders&service=page',
      source: 'etenders',
    });
  }

  return tenders;
}

function mergeAndDedupe(items) {
  const seen = new Set();
  const out = [];
  for (const t of items) {
    const key = dedupeKey(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: t.title,
      org: t.org || '',
      location: t.location || '',
      deadline: t.deadline || '',
      value: t.value || '',
      description: t.description || '',
      url: t.url || '',
    });
  }
  return out;
}

async function main() {
  const sources = [];
  const collected = [];

  const collectors = [
    { name: 'cppp', fn: collectCppp },
    { name: 'gem', fn: collectGem },
    { name: 'etenders', fn: collectEprocureHome },
  ];

  for (const { name, fn } of collectors) {
    try {
      console.log(`Collecting from ${name}...`);
      const items = await fn();
      console.log(`  ${name}: ${items.length} raw matches`);
      if (items.length) sources.push(name);
      collected.push(...items);
    } catch (err) {
      console.warn(`  ${name} failed:`, err.message);
    }
  }

  const tenders = mergeAndDedupe(collected);
  const feed = {
    updatedAt: new Date().toISOString(),
    sources,
    tenders,
  };

  const outPath = path.join(__dirname, '..', 'data', 'tenders-feed.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(feed, null, 2) + '\n');
  console.log(`Wrote ${tenders.length} tenders to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
