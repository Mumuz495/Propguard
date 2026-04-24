const JIN10_MCP_URL = 'https://mcp.jin10.com/mcp';
const MCP_PROTOCOL_VERSION = '2025-11-25';
const CACHE_TTL = {
  calendar: 5 * 60,
  flash: 90,
  news: 5 * 60,
  equity: 5 * 60,
  speech: 3 * 60,
  xTimeline: 3 * 24 * 60 * 60
};
const WATCHLIST = ['NVDA','AAPL','MSFT','TSLA','AMZN','META','GOOGL','AVGO','AMD','NFLX','COST','ADBE','CRM','ORCL','INTC','QCOM','MU','PLTR','SMCI','JPM','BRK.B','LLY','UNH','XOM'];
const CIK = {
  AAPL:'0000320193', MSFT:'0000789019', NVDA:'0001045810', TSLA:'0001318605', AMZN:'0001018724', META:'0001326801',
  GOOGL:'0001652044', GOOG:'0001652044', AVGO:'0001730168', AMD:'0000002488', NFLX:'0001065280', COST:'0000909832',
  ADBE:'0000796343', CRM:'0001108524', ORCL:'0001341439', INTC:'0000050863', QCOM:'0000804328', MU:'0000723125',
  PLTR:'0001321655', SMCI:'0001375365', JPM:'0000019617', 'BRK.B':'0001067983', LLY:'0000059478', UNH:'0000731766', XOM:'0000034088'
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
      ...(init.headers || {})
    }
  });
}

async function cached(request, key, ttlSec, producer, force = false) {
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = '/__cache/' + key;
  cacheUrl.search = '';
  const cacheReq = new Request(cacheUrl.toString(), { method: 'GET' });
  if (!force) {
    const hit = await cache.match(cacheReq);
    if (hit) {
      const data = await hit.json();
      return json({ ...data, cached: true });
    }
  }
  const produced = await producer();
  const payload = { ...produced, cached: false, cached_at: new Date().toISOString(), ttl: ttlSec };
  const res = json(payload, { headers: { 'cache-control': `public, max-age=${ttlSec}` } });
  await cache.put(cacheReq, res.clone());
  return res;
}

// Internal cache helper not tied to an incoming request path.
async function cachedByKey(key, ttlSec, producer, force = false) {
  const cache = caches.default;
  const cacheReq = new Request(`https://propguard-cache.internal/${key}`, { method: 'GET' });
  if (!force) {
    const hit = await cache.match(cacheReq);
    if (hit) return await hit.json();
  }
  const payload = await producer();
  const res = new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttlSec}`
    }
  });
  await cache.put(cacheReq, res);
  return payload;
}

function parseMcpPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // Jin10 MCP may return SSE frames, e.g. "event: message" + "data: {...}".
  const dataLines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('data:'));
  if (dataLines.length) {
    for (let i = dataLines.length - 1; i >= 0; i--) {
      const data = dataLines[i].slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { return JSON.parse(data); } catch (_) {}
    }
  }
  return JSON.parse(raw);
}

async function mcpPost(env, payload, sessionId) {
  const token = env.JIN10_API_TOKEN;
  if (!token) throw new Error('JIN10_API_TOKEN secret is not configured');
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'authorization': `Bearer ${token}`
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(JIN10_MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jin10 MCP HTTP ${res.status}: ${text.slice(0, 240)}`);
  const body = parseMcpPayload(text);
  if (body && body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return { body, sessionId: res.headers.get('mcp-session-id') || sessionId || undefined };
}

async function makeMcpSession(env) {
  let id = 1;
  const init = await mcpPost(env, {
    jsonrpc: '2.0', id: id++, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'PropGuard', version: '1.0.0' } }
  });
  const sessionId = init.sessionId;
  await mcpPost(env, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId);
  const tools = await mcpPost(env, { jsonrpc: '2.0', id: id++, method: 'tools/list', params: {} }, sessionId);
  const resources = await mcpPost(env, { jsonrpc: '2.0', id: id++, method: 'resources/list', params: {} }, sessionId);
  return {
    call: async (name, args = {}) => {
      const call = await mcpPost(env, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args || {} } }, sessionId);
      const result = call.body?.result || call.body;
      if (result?.isError) throw new Error(result?.content?.[0]?.text || 'Jin10 tool returned isError=true');
      return result?.structuredContent || result;
    },
    tools: tools.body?.result,
    resources: resources.body?.result
  };
}

async function jin10ToolCall(env, name, args = {}) {
  const session = await makeMcpSession(env);
  return session.call(name, args);
}
function pickData(structured) { return structured?.data ?? structured; }

function normalizeTs(v) {
  if (!v) return Date.now();
  if (typeof v === 'number') return v > 2000000000 ? v : v * 1000;
  const compact = String(v).replace(/\D/g, '').slice(0, 14);
  if (compact.length === 14) return Date.UTC(+compact.slice(0,4), +compact.slice(4,6)-1, +compact.slice(6,8), +compact.slice(8,10), +compact.slice(10,12), +compact.slice(12,14));
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : Date.now();
}
function detectSymbols(text = '') {
  const hay = String(text).toLowerCase();
  const aliases = { NVDA:['nvda','nvidia'], AAPL:['aapl','apple'], MSFT:['msft','microsoft'], TSLA:['tsla','tesla'], AMZN:['amzn','amazon'], META:['meta','facebook'], GOOGL:['googl','google','alphabet'], AVGO:['avgo','broadcom'], AMD:['amd','advanced micro'], NFLX:['nflx','netflix'], JPM:['jpm','jpmorgan'], LLY:['lly','eli lilly'], UNH:['unh','unitedhealth'], XOM:['xom','exxon'] };
  return Object.entries(aliases).filter(([, words]) => words.some(w => hay.includes(w))).map(([s]) => s);
}
function marketsFor(symbols, title='') {
  const nq = new Set(['NVDA','AAPL','MSFT','TSLA','AMZN','META','GOOGL','GOOG','AVGO','AMD','NFLX','COST','ADBE','CRM','ORCL','INTC','QCOM','MU','PLTR','SMCI']);
  const es = new Set(['JPM','BRK.B','LLY','UNH','XOM','AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','TSLA']);
  const out = new Set();
  symbols.forEach(s => { if (nq.has(s)) out.add('NQ'); if (es.has(s)) out.add('ES'); });
  if (/nasdaq|qqq|semiconductor|chips|ai|nvidia|apple|tesla|microsoft|纳斯达克|英伟达|苹果|特斯拉|微软|芯片|半导体|人工智能/i.test(title)) out.add('NQ');
  if (/s&p|spx|spy|broad market|fed|tariff|treasury|oil|geopolitical|美联储|鲍威尔|特朗普|川普|关税|降息|加息|通胀|原油|地缘|财政部|美债/i.test(title)) out.add('ES');
  return [...out];
}
function scoreNews(item) {
  let s = 35;
  const t = (item.title || '').toLowerCase();
  if ((item.symbols || []).some(x => ['NVDA','AAPL','MSFT','TSLA','AMZN','META','GOOGL','AVGO'].includes(x))) s += 18;
  if (item.category === 'earnings') s += 25;
  if (item.category === 'sec') s += 18;
  if (item.category === 'trump_x') s += 35;
  if (/earnings|revenue|guidance|outlook|eps|miss|beat|8-k|10-q|10-k|sec filing|investigation|doj|ftc|lawsuit|recall|halts|tariff|sanction|china|fed|powell|rate cut|rate hike|chips|export control|war|attack|oil/.test(t)) s += 22;
  if ((item.markets||[]).includes('NQ') && (item.markets||[]).includes('ES')) s += 8;
  return Math.min(100, Math.max(10, s));
}
function newsItem(id, source, title, extra = {}) {
  const symbols = (extra.symbols || detectSymbols(title)).map(s => String(s).toUpperCase()).filter(Boolean);
  const markets = marketsFor(symbols, title);
  const item = { id, source, title, url: extra.url || '', tsUTC: normalizeTs(extra.tsUTC || extra.time), symbols, markets, category: extra.category || 'company_news', reason: extra.reason || '', raw: extra.raw || null };
  item.severity = extra.severity ?? scoreNews(item);
  return item;
}
function jin10EquityItem(item, prefix = 'jin10') {
  const title = String(item?.title || item?.content || item?.introduction || '').trim();
  if (!title) return null;
  const text = `${title} ${item?.content || ''}`;
  const symbols = detectSymbols(text);
  const isTrump = /特朗普|川普|Trump|Donald Trump|关税|tariff/i.test(text);
  const isEarnings = /财报|业绩|营收|利润|指引|earnings|revenue|guidance|eps/i.test(text);
  const isMacroNoise = /美联储|鲍威尔|利率|通胀|非农|CPI|PPI|FOMC|Fed|Powell|rate|inflation/i.test(text);
  return newsItem(`${prefix}_${item?.id || title.slice(0, 80)}`, 'jin10', title, {
    url: item?.url || '',
    tsUTC: item?.time || item?.pub_time || item?.created_at,
    symbols,
    category: isEarnings ? 'earnings' : (isTrump ? 'trump_x' : 'company_news'),
    severity: isTrump ? 88 : (isEarnings ? 75 : (isMacroNoise ? 58 : undefined)),
    reason: prefix === 'jin10_flash' ? 'Jin10 flash / noise supplement' : 'Jin10 news / noise supplement',
    raw: item
  });
}
async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'accept': 'application/json', ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/xml,text/xml,text/plain,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function fetchSEC() {
  const cutoff = Date.now() - 14*24*3600*1000;
  const out = [];
  await Promise.all(WATCHLIST.filter(s => CIK[s]).slice(0, 24).map(async sym => {
    try {
      const cik = CIK[sym].padStart(10, '0');
      const j = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': 'PropGuard contact@example.com' } });
      const r = j.filings?.recent || {};
      (r.form || []).slice(0, 20).forEach((form, i) => {
        if (!['8-K','8-K/A','10-Q','10-K','6-K'].includes(form)) return;
        const ms = normalizeTs(r.acceptanceDateTime?.[i] || r.filingDate?.[i]);
        if (ms < cutoff) return;
        const acc = (r.accessionNumber?.[i] || '').replace(/-/g, '');
        const doc = r.primaryDocument?.[i] || '';
        const url = acc && doc ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik,10)}/${acc}/${doc}` : '';
        const items = (r.items?.[i] || '').trim();
        out.push(newsItem(`sec_${sym}_${r.accessionNumber?.[i] || i}`, 'sec_edgar', `${sym} SEC ${form}${items ? ` Item ${items}` : ''}`, { url, tsUTC: ms, symbols: [sym], category: 'sec', reason: r.acceptanceDateTime?.[i] ? 'SEC accepted time' : 'SEC filing date only' }));
      });
    } catch (_) {}
  }));
  return out;
}
async function fetchGoogleNews() {
  const feeds = [
    ['google_news', 'company_news', 'Free Google News RSS watchlist', '(Nvidia OR NVDA OR Tesla OR TSLA OR Apple OR AAPL OR Microsoft OR MSFT OR Amazon OR Meta OR Google OR Alphabet OR Broadcom OR AMD) (earnings OR guidance OR revenue OR outlook OR shares OR stock) when:1d'],
    ['google_news_trump', 'trump_x', 'Free Trump market keyword RSS', '(Trump OR "Donald Trump") (tariff OR China OR Fed OR Powell OR oil OR chips OR Nvidia OR sanctions OR war OR market) when:1d']
  ];
  const out = [];
  for (const [source, category, reason, q] of feeds) {
    try {
      const xml = await fetchText('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en');
      const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].slice(0, 30).map(m => m[0]);
      for (const item of items) {
        const pick = tag => (item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, '').trim();
        const title = pick('title');
        if (!title) continue;
        out.push(newsItem(`${source}_${(pick('link') || title).slice(0, 100)}`, source, title, { url: pick('link'), tsUTC: pick('pubDate'), category: /earnings|guidance|revenue|eps|outlook/i.test(title) ? 'earnings' : category, reason }));
      }
    } catch (_) {}
  }
  return out;
}

function decodeHtml(s = '') {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]*>/g, '')
    .trim();
}
function speechItem(id, source, title, extra = {}) {
  const cleanTitle = decodeHtml(title);
  const category = extra.category || 'scheduled_speech';
  const baseSeverity = category === 'scheduled_speech' ? 82 : category === 'breaking' ? 70 : 62;
  const item = newsItem(id, source, cleanTitle, {
    ...extra,
    category: extra.newsCategory || (category === 'breaking' ? 'company_news' : 'official_speech'),
    severity: extra.severity ?? baseSeverity
  });
  item.watchType = category;
  item.actor = extra.actor || '';
  item.scheduledTime = extra.scheduledTime || '';
  item.venue = extra.venue || '';
  return item;
}
function parseRssItems(xml, source, mapper) {
  const out = [];
  const rows = [...String(xml || '').matchAll(/<item>[\s\S]*?<\/item>/g)].map(m => m[0]);
  for (const row of rows) {
    const pick = tag => decodeHtml((row.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, ''));
    const title = pick('title');
    if (!title) continue;
    const it = mapper({ source, title, link: pick('link'), pubDate: pick('pubDate'), description: pick('description') });
    if (it) out.push(it);
  }
  return out;
}
async function fetchCNNBreaking() {
  const feeds = [
    'http://rss.cnn.com/rss/cnn_allpolitics.rss',
    'http://rss.cnn.com/rss/edition.rss'
  ];
  const out = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchText(feed);
      const mapped = parseRssItems(xml, 'cnn', x => {
        const text = `${x.title} ${x.description}`.toLowerCase();
        if (!/(trump|white house|fed|powell|fomc|tariff|speech|remarks|press conference|briefing)/i.test(text)) return null;
        return speechItem(`cnn_${(x.link || x.title).slice(0, 120)}`, 'cnn', x.title, {
          url: x.link,
          tsUTC: x.pubDate,
          category: 'breaking',
          actor: /trump/i.test(text) ? 'Trump' : (/powell|fed|fomc/i.test(text) ? 'Fed' : 'US Politics'),
          reason: 'CNN breaking supplement'
        });
      });
      out.push(...mapped.slice(0, 20));
    } catch (_) {}
  }
  return out;
}
async function fetchXJson(env, url) {
  const token = env.X_BEARER_TOKEN;
  if (!token) throw new Error('X_BEARER_TOKEN not configured');
  const res = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'authorization': `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`X API HTTP ${res.status}`);
  return res.json();
}
async function fetchXTrumpTimeline(env) {
  if (!env.X_BEARER_TOKEN) return [];
  const rawUser = String(env.X_TRUMP_USERNAME || 'realDonaldTrump').trim();
  const username = rawUser.replace(/^@/, '');
  const key = `x_trump_timeline_v2_${username.toLowerCase()}`;
  const ttl = Number(env.X_TIMELINE_TTL_SEC || CACHE_TTL.xTimeline) || CACHE_TTL.xTimeline;
  const payload = await cachedByKey(key, ttl, async () => {
    const out = [];
    try {
      const userResp = await fetchXJson(
        env,
        `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=id,name,username,verified`
      );
      const user = userResp?.data;
      if (!user?.id) return out;
      const tw = await fetchXJson(
        env,
        `https://api.x.com/2/users/${encodeURIComponent(user.id)}/tweets?max_results=20&exclude=replies&tweet.fields=created_at,public_metrics,referenced_tweets,source,lang`
      );
      const rows = Array.isArray(tw?.data) ? tw.data : [];
      for (const t of rows) {
        const text = decodeHtml(String(t?.text || '')).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        const hot = /(tariff|china|fed|fomc|powell|rates?|sanction|war|oil|inflation|jobs|trump|关税|美联储|降息|加息|通胀)/i.test(text);
        const title = /^https?:\/\/t\.co\/\S+$/i.test(text) ? '[Link post] (open tweet for full context)' : text;
        out.push(speechItem(`x_${t.id}`, 'x_trump', title, {
          url: `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(t.id)}`,
          tsUTC: t.created_at,
          category: 'breaking',
          actor: user?.name || 'Trump',
          severity: hot ? 92 : 78,
          reason: `X official account monitor @${username} (cached ${Math.round(ttl / 3600)}h)`,
          newsCategory: /trump/i.test(lower) ? 'trump_x' : 'company_news',
          raw: t
        }));
      }
    } catch (_) {}
    return out;
  });
  return Array.isArray(payload) ? payload : [];
}
async function fetchXZerohedgeTrump(env) {
  if (!env.X_BEARER_TOKEN) return [];
  const rawUser = String(env.X_ZEROHEDGE_USERNAME || 'zerohedge').trim();
  const username = rawUser.replace(/^@/, '');
  const ttl = Number(env.X_ZEROHEDGE_TTL_SEC || env.X_TIMELINE_TTL_SEC || CACHE_TTL.xTimeline) || CACHE_TTL.xTimeline;
  const key = `x_zerohedge_trump_v1_${username.toLowerCase()}`;
  const keywordRegex = new RegExp(
    String(env.X_ZH_TRUMP_KEYWORDS || 'trump|donald\\s+trump|white\\s+house|maga|election|tariff')
      .split('|')
      .map(s => s.trim())
      .filter(Boolean)
      .join('|'),
    'i'
  );
  const payload = await cachedByKey(key, ttl, async () => {
    const out = [];
    try {
      const userResp = await fetchXJson(
        env,
        `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=id,name,username,verified`
      );
      const user = userResp?.data;
      if (!user?.id) return out;
      const tw = await fetchXJson(
        env,
        `https://api.x.com/2/users/${encodeURIComponent(user.id)}/tweets?max_results=30&exclude=replies&tweet.fields=created_at,public_metrics,referenced_tweets,source,lang`
      );
      const rows = Array.isArray(tw?.data) ? tw.data : [];
      for (const t of rows) {
        const text = decodeHtml(String(t?.text || '')).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (!keywordRegex.test(text)) continue;
        const title = /^https?:\/\/t\.co\/\S+$/i.test(text) ? '[Link post] (open tweet for full context)' : text;
        out.push(speechItem(`xzh_${t.id}`, 'x_zerohedge', title, {
          url: `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(t.id)}`,
          tsUTC: t.created_at,
          category: 'breaking',
          actor: user?.name || 'ZeroHedge',
          severity: 84,
          reason: `ZeroHedge X monitor (TRUMP keywords, cached ${Math.round(ttl / 3600)}h)`,
          newsCategory: 'trump_x',
          raw: t
        }));
      }
    } catch (_) {}
    return out;
  });
  return Array.isArray(payload) ? payload : [];
}
async function fetchFedOfficialSpeech() {
  const out = [];
  try {
    const [speeches, testimony] = await Promise.all([
      fetchJson('https://www.federalreserve.gov/json/ne-speeches.json'),
      fetchJson('https://www.federalreserve.gov/json/ne-testimony.json')
    ]);
    const rows = [...(Array.isArray(speeches) ? speeches : []), ...(Array.isArray(testimony) ? testimony : [])].slice(0, 80);
    for (const row of rows) {
      const title = decodeHtml(row?.l || row?.title || row?.t || '');
      if (!title) continue;
      const date = row?.d || row?.date || '';
      const href = row?.pt || row?.url || '';
      const url = href ? (String(href).startsWith('http') ? href : `https://www.federalreserve.gov${href}`) : 'https://www.federalreserve.gov/newsevents/speeches.htm';
      out.push(speechItem(`fed_${(url || title).slice(0, 120)}`, 'fed_official', title, {
        url,
        tsUTC: date,
        category: 'scheduled_speech',
        actor: 'Federal Reserve',
        reason: 'Federal Reserve official speech/testimony page'
      }));
    }
  } catch (_) {}
  return out;
}
async function fetchWhiteHouseSchedule() {
  const out = [];
  try {
    const html = await fetchText('https://www.whitehouse.gov/briefings-statements/');
    const links = [...html.matchAll(/href="(https:\/\/www\.whitehouse\.gov\/briefings-statements\/[^"#]+)"/g)]
      .map(m => m[1])
      .filter(u => /\/\d{4}\/\d{2}\//.test(u))
      .slice(0, 30);
    for (const url of links) {
      const slug = url.split('/').filter(Boolean).pop() || '';
      const title = decodeHtml(slug.replace(/-/g, ' '));
      if (!/(remarks|briefing|statement|presidential|president|trump|address|press)/i.test(title)) continue;
      const d = (url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//) || []);
      const ts = d.length === 4 ? `${d[1]}-${d[2]}-${d[3]}T00:00:00Z` : undefined;
      out.push(speechItem(`wh_${url.slice(-90)}`, 'white_house', title, {
        url,
        tsUTC: ts,
        category: 'scheduled_speech',
        actor: 'White House',
        reason: 'White House briefings/statements schedule stream'
      }));
    }
  } catch (_) {}
  return out;
}
async function fetchFactbaseTrump() {
  const out = [];
  try {
    const html = await fetchText('https://rollcall.com/factbase/trump/calendar/');
    const links = [...html.matchAll(/href="(https:\/\/rollcall\.com\/factbase\/trump\/transcript\/[^"#]+)"/g)]
      .map(m => m[1])
      .slice(0, 40);
    for (const url of links) {
      const slug = (url.split('/').filter(Boolean).pop() || '').replace(/-/g, ' ');
      if (!slug) continue;
      const dm = url.match(/(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{1,2})-(\d{4})/i);
      let ts;
      if (dm) {
        ts = `${dm[3]}-${String(new Date(`${dm[1]} 1, 2000`).getMonth() + 1).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}T00:00:00Z`;
      }
      out.push(speechItem(`factbase_${url.slice(-100)}`, 'factbase', slug, {
        url,
        tsUTC: ts,
        category: 'scheduled_speech',
        actor: 'Trump',
        reason: 'Factba.se Trump calendar/transcript tracking'
      }));
    }
  } catch (_) {}
  return out;
}
async function fetchSpeechWatchBundle(env) {
  const [whitehouse, factbase, fed, cnn, x, zh] = await Promise.all([
    fetchWhiteHouseSchedule(),
    fetchFactbaseTrump(),
    fetchFedOfficialSpeech(),
    fetchCNNBreaking(),
    fetchXTrumpTimeline(env),
    fetchXZerohedgeTrump(env)
  ]);
  const byId = new Map();
  [...whitehouse, ...factbase, ...fed, ...cnn, ...x, ...zh].forEach(x => { if (x?.id && !byId.has(x.id)) byId.set(x.id, x); });
  const items = [...byId.values()].sort((a, b) => b.tsUTC - a.tsUTC).slice(0, 220);
  const stats = {
    total: items.length,
    scheduled: items.filter(x => x.watchType === 'scheduled_speech').length,
    breaking: items.filter(x => x.watchType === 'breaking').length,
    trump: items.filter(x => /trump/i.test(`${x.actor || ''} ${x.title || ''}`)).length,
    fed: items.filter(x => (x.source || '').includes('fed')).length
  };
  return { ok: true, source: 'speech_watch_bundle', data: { items, stats, sources: { whitehouse: whitehouse.length, factbase: factbase.length, fed: fed.length, cnn: cnn.length, x: x.length, zerohedge: zh.length } } };
}
async function fetchEquityBundle(env) {
  const [sec, rss, jin10] = await Promise.all([
    fetchSEC(),
    fetchGoogleNews(),
    (async () => {
      try {
        const bundle = await fetchJin10Bundle(env);
        const flash = Array.isArray(bundle?.data?.flash?.items) ? bundle.data.flash.items : [];
        const news = Array.isArray(bundle?.data?.news?.items) ? bundle.data.news.items : [];
        return [
          ...flash.map(x => jin10EquityItem(x, 'jin10_flash')),
          ...news.map(x => jin10EquityItem(x, 'jin10_news'))
        ].filter(Boolean);
      } catch (_) {
        return [];
      }
    })()
  ]);
  const byId = new Map();
  [...sec, ...rss, ...jin10].forEach(x => { if (x?.id && !byId.has(x.id)) byId.set(x.id, x); });
  return { ok: true, source: 'propguard_worker_cache', data: { items: [...byId.values()].sort((a,b)=>b.tsUTC-a.tsUTC).slice(0, 250) } };
}
async function fetchJin10Bundle(env) {
  const session = await makeMcpSession(env);
  const [calendar, flash, news] = await Promise.all([
    session.call('list_calendar', {}),
    session.call('list_flash', {}),
    session.call('list_news', {})
  ]);
  return { ok: true, source: 'jin10_mcp', data: { calendar: pickData(calendar), flash: pickData(flash), news: pickData(news) } };
}

async function handleApi(request, env, path) {
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  try {
    if (path === '/api/jin10/health') return json({ ok: true, hasToken: Boolean(env.JIN10_API_TOKEN), protocolVersion: MCP_PROTOCOL_VERSION });
    if (path === '/api/jin10/bundle') return cached(request, 'jin10_bundle_v1', CACHE_TTL.flash, () => fetchJin10Bundle(env), force);
    if (path === '/api/equity-news/bundle') return cached(request, 'equity_bundle_v3', CACHE_TTL.equity, () => fetchEquityBundle(env), force);
    if (path === '/api/speech-watch/bundle') return cached(request, 'speech_watch_bundle_v1', CACHE_TTL.speech, () => fetchSpeechWatchBundle(env), force);
    if (path === '/api/jin10/calendar') return cached(request, 'jin10_calendar_v1', CACHE_TTL.calendar, async () => ({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'list_calendar', {})) }), force);
    if (path === '/api/jin10/flash') {
      const cursor = url.searchParams.get('cursor') || undefined;
      return cached(request, `jin10_flash_${cursor || 'first'}_v1`, CACHE_TTL.flash, async () => ({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'list_flash', cursor ? { cursor } : {})) }), force);
    }
    if (path === '/api/jin10/news') {
      const cursor = url.searchParams.get('cursor') || undefined;
      return cached(request, `jin10_news_${cursor || 'first'}_v1`, CACHE_TTL.news, async () => ({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'list_news', cursor ? { cursor } : {})) }), force);
    }
    if (path === '/api/jin10/search-flash') {
      const keyword = url.searchParams.get('keyword') || '';
      if (!keyword) return json({ ok: false, error: 'keyword is required' }, { status: 400 });
      return json({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'search_flash', { keyword })) });
    }
    if (path === '/api/jin10/search-news') {
      const keyword = url.searchParams.get('keyword') || '';
      const cursor = url.searchParams.get('cursor') || undefined;
      if (!keyword) return json({ ok: false, error: 'keyword is required' }, { status: 400 });
      return json({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'search_news', cursor ? { keyword, cursor } : { keyword })) });
    }
    if (path === '/api/jin10/quote') {
      const code = url.searchParams.get('code') || '';
      if (!code) return json({ ok: false, error: 'code is required' }, { status: 400 });
      return json({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'get_quote', { code })) });
    }
    if (path === '/api/jin10/kline') {
      const code = url.searchParams.get('code') || '';
      if (!code) return json({ ok: false, error: 'code is required' }, { status: 400 });
      const args = { code };
      if (url.searchParams.get('time')) args.time = url.searchParams.get('time');
      if (url.searchParams.get('count')) args.count = Number(url.searchParams.get('count'));
      return json({ ok: true, source: 'jin10_mcp', data: pickData(await jin10ToolCall(env, 'get_kline', args)) });
    }
    return json({ ok: false, error: 'Not found' }, { status: 404 });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({ ok: true });
    if (url.pathname.startsWith('/api/jin10/') || url.pathname.startsWith('/api/equity-news/') || url.pathname.startsWith('/api/speech-watch/')) return handleApi(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  }
};
