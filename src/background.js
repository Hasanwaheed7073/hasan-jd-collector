/* JD Collector - background service worker.
 *
 * Owns persisted state so a scrape survives panel closes and service-worker restarts.
 */

/* The hiringcafe adapter is shared with the panel and the tests, so it is a
 * plain lib rather than worker-local code. importScripts because this worker
 * is a classic script, not a module - and it must run before any handler
 * below touches self.JDC_HIRINGCAFE.
 *
 * The path is root-absolute on purpose. importScripts resolves relative to
 * THIS script, which lives in src/, so 'src/lib/...' became 'src/src/lib/...'
 * and the whole service worker failed to register - taking the entire
 * extension down, not just this feature. The leading slash means the
 * extension root regardless of where background.js sits. */
importScripts('/src/lib/hiringcafe.js');
importScripts('/src/lib/gemVerdicts.js');
importScripts('/src/lib/aiPlan.js');
importScripts('/src/lib/aiFields.js');

const K = {
  state: 'jdc_state',
  jobs: 'jdc_jobs',
  history: 'jdc_history',
  config: 'jdc_config',
  log: 'jdc_log',
  verdicts: 'jdc_verdicts',
  aiPlans: 'jdc_ai_plans'
};

const DEFAULT_STATE = {
  active: false,
  tabId: null,
  startedAt: null,
  finishedAt: null,
  reason: null,
  page: 1,
  pagesDone: 0,
  collected: 0,
  skippedSeen: 0,
  failed: 0,
  currentTitle: '',
  resolving: false,
  resolveDone: 0,
  resolveTotal: 0
};

/* Leads every exported batch. Deliberately says nothing about any particular
 * client or requirement - the extension does not know and does not judge. Edit
 * it in the settings window. */
const DEFAULT_PROMPT = [
  'Below are job postings I collected, with the facts parsed out of each one.',
  '',
  'For each job return one row:',
  'ID | Title | Company | one-line read | biggest concern',
  '',
  'Be concise and concrete. Say what the posting actually says.'].join('\n');

/* Optional, appended after the prompt when a batch is headed for a vetting
 * chat (a Gemini Gem, say) rather than just being read. It exists purely so
 * that reply can be scanned back in automatically by gemVerdicts.js - the
 * extension still forms no opinion of its own; this only makes someone
 * else's opinion machine-readable. Blank it in Settings to stop appending it. */
const DEFAULT_VETTING_FORMAT = [
  'End your reply with exactly one line per job, in this literal format, so',
  'the result can be re-imported automatically:',
  'VERDICT <ID> ACCEPT',
  'VERDICT <ID> REJECT: <short reason>'].join('\n');

const DEFAULT_CONFIG = {
  delayMs: 1200,
  jitterMs: 500,
  longPauseEvery: 25,
  longPauseMs: 6000,
  maxJobs: 0,
  maxPages: 5,
  skipSeen: false,
  skipRejected: false,
  clearBefore: true,
  batchChars: 80000,
  maxJdChars: 6000,
  promptTemplate: DEFAULT_PROMPT,
  vettingFormat: DEFAULT_VETTING_FORMAT,

  /* AI assist. Off, and keyless, until someone turns it on: it is the only
   * part of this extension that talks to a third party. */
  aiEnabled: false,
  aiApiKey: '',
  /* A LIST, tried in order. Free endpoints are rate limited hard - a few
   * calls a minute - so one model is one bad minute away from a run with no
   * assist at all. A second and third cost nothing until they are needed. */
  aiModels: [
    'minimax/minimax-m2.7:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'z-ai/glm-5.2:free'
  ].join('\n'),
  aiModel: 'minimax/minimax-m2.7:free',
  aiMaxCalls: 2,
  aiTimeoutMs: 90000,

  /* The field check: a model reading ONE job's pane and filling in what the
   * DOM could not. Separate from the selector assist and separately off,
   * because it is the only feature that sends posting text out of the
   * browser - and because it costs a call per job. */
  aiVerifyEnabled: false,
  aiVerifyModels: ['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'].join('\n'),
  aiVerifyMaxJobs: 30,
  aiVerifySampleChars: 4000
};

/* ---------- storage helpers ---------- */

async function get(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}

function set(obj) {
  return chrome.storage.local.set(obj);
}

async function getState() {
  return Object.assign({}, DEFAULT_STATE, await get(K.state, {}));
}

async function patchState(patch) {
  const s = Object.assign(await getState(), patch);
  await set({ [K.state]: s });
  return s;
}

async function getConfig() {
  return Object.assign({}, DEFAULT_CONFIG, await get(K.config, {}));
}

/* ---------- buffered job writes ---------- */

let jobBuffer = [];
let flushTimer = null;

async function flushJobs() {
  flushTimer = null;
  if (!jobBuffer.length) return;
  const incoming = jobBuffer;
  jobBuffer = [];
  const jobs = await get(K.jobs, []);
  const seen = new Set(jobs.map((j) => j.jobId));
  for (const j of incoming) {
    if (!seen.has(j.jobId)) {
      jobs.push(j);
      seen.add(j.jobId);
    }
  }
  await set({ [K.jobs]: jobs });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(function () {
    flushJobs().catch(console.error);
  }, 1200);
}

/* ---------- logging ---------- */

/* Serialised. This is read-modify-write on a single storage key, so concurrent
 * callers each read the same array and the last write wins - which silently
 * discarded most of a multi-line diagnostic. Chaining keeps every line. */
let logChain = Promise.resolve();

function pushLog(line) {
  logChain = logChain.then(async function () {
    const log = await get(K.log, []);
    log.push({ t: Date.now(), line: line });
    while (log.length > 300) log.shift();
    await set({ [K.log]: log });
  }).catch(function (e) {
    console.error('[JDC log]', e);
  });
  return logChain;
}

function notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(function () { /* panel not open */ });
}

/* ---------- content script plumbing ---------- */

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'JDC_PING' });
    if (pong && pong.ok) {
      /* Which build is actually driving that tab. Reloading the extension does
       * not replace a content script already running in an open tab, so this
       * is the difference between "the fix does not work" and "the fix is not
       * in the tab yet". */
      await pushLog('Content script in the tab: build ' + (pong.build || 'unknown (pre-2026-09-01)') + '.');
      return true;
    }
  } catch (e) { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: [
        'src/content/selectors.js',
        'src/lib/aiPlan.js',
        'src/lib/aiFields.js',
        'src/content/aiassist.js',
        'src/content/parse.js',
        'src/content/extract.js',
        'src/content/aisearch.js',
        'src/content/content.js'
      ]
    });
    return true;
  } catch (e) {
    await pushLog('Could not inject into tab: ' + e.message);
    return false;
  }
}

/* The Gem reader is its own tiny content script (src/content/gem.js), not the
 * LinkedIn collector, so it gets its own inject-and-ping helper and its own
 * strict host check - reading whatever tab happens to be active would be a
 * much easier bug to write than the LinkedIn path's, which at least gets its
 * data from a site the user meant to run the collector against. */
async function ensureGemContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'JDC_GEM_PING' });
    if (pong && pong.ok) return true;
  } catch (e) { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/content/gem.js'] });
    return true;
  } catch (e) {
    await pushLog('Could not inject into the Gem tab: ' + e.message);
    return false;
  }
}

async function activeGeminiTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return { error: 'No active tab.' };
  if (!/^https:\/\/gemini\.google\.com\//.test(tab.url || '')) {
    return { error: 'Open your Gemini Gem chat in this tab first.' };
  }
  return { tab: tab };
}

/* anyHost lets the diagnostic run on any site the extension has permission for
 * (hiring.cafe, say), while collection stays restricted to LinkedIn jobs. */
async function activeLinkedInTab(anyHost) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return { error: 'No active tab.' };

  if (anyHost) {
    if (!/^https?:\/\//.test(tab.url || '')) {
      return { error: 'Open the job site in this tab first.' };
    }
    return { tab: tab };
  }

  /* Any LinkedIn page, not just /jobs/. The AI job search and other surfaces
   * live on routes this used to reject outright, which presented as "the
   * collector does not work" when in fact it was never allowed to start. */
  if (!/^https:\/\/www\.linkedin\.com\//.test(tab.url || '')) {
    return { error: 'Open a LinkedIn tab first, on a page showing job results.' };
  }
  return { tab: tab };
}

/* ---------- collecting from hiringcafe ----------
 *
 * No tab, no content script, no page to drive: the worker fetches, and the
 * rows go through the same jobBuffer/flushJobs intake the LinkedIn collector
 * uses, so dedupe, storage, history and the panel list all work unchanged.
 *
 * Two calls per page and one per job. The search result carries no job
 * description - only a ~200 char summary - so the full text needs a second
 * request each. That is the cost of this source, and it is why descriptions
 * are fetched in small batches with a pause between them rather than all at
 * once: this is someone else's server. */

const HC = self.JDC_HIRINGCAFE;
const GEMV = self.JDC_GEMVERDICTS;

const HC_DESC_CONCURRENCY = 4;
const HC_PAGE_PAUSE_MS = 1500;
const HC_DESC_PAUSE_MS = 250;

let hcRunning = false;
let hcAbort = false;

/* User-Agent and Referer are forbidden header names: fetch() silently drops
 * them, so setting them was pretence. The browser sends its own real
 * User-Agent anyway, which is the one thing we actually wanted. */
async function hcGet(url, asJson) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': asJson ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml'
    },
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' from ' + new URL(url).pathname);
  }
  return asJson ? res.json() : res.text();
}

/* Descriptions in small parallel batches. A failure on one job is logged and
 * skipped - the summary is still there - rather than failing the whole run. */
/* Descriptions in small parallel batches, keyed by job id. Returning a map
 * rather than mutating the rows is what keeps hit and description paired: an
 * earlier version matched them BY POSITION against a list that had already
 * had expired rows filtered out of it, so one expired posting shifted every
 * description after it onto the wrong job.
 *
 * A failure on one job is counted and skipped - the summary is still there -
 * rather than failing the whole run. */
async function hcFetchDescriptions(hits) {
  const out = new Map();
  let failed = 0;

  for (let i = 0; i < hits.length; i += HC_DESC_CONCURRENCY) {
    if (hcAbort) break;
    const slice = hits.slice(i, i + HC_DESC_CONCURRENCY);
    await Promise.all(slice.map(async function (h) {
      try {
        const text = HC.descriptionFrom(await hcGet(HC.descriptionUrl(h.id), true));
        if (text) out.set(h.id, text);
      } catch (e) {
        failed++;
      }
    }));
    if (!hcAbort && i + HC_DESC_CONCURRENCY < hits.length) {
      await new Promise(function (r) { setTimeout(r, HC_DESC_PAUSE_MS); });
    }
  }
  return { texts: out, got: out.size, failed: failed };
}

async function hcCollect(search) {
  if (hcRunning) return { ok: false, error: 'A hiringcafe run is already going.' };
  if (!HC) return { ok: false, error: 'The hiringcafe adapter did not load.' };

  hcRunning = true;
  hcAbort = false;

  const config = await getConfig();
  const maxJobs = Number(config.maxJobs) || 0;
  const maxPages = Number(config.maxPages) || 5;
  const state = HC.buildSearchState(search || {});

  if (!state.searchQuery) {
    hcRunning = false;
    return { ok: false, error: 'This saved search has no keywords. Add some in Manage.' };
  }
  if (!state.locations) {
    /* Without a location their backend geolocates the caller: the same query
     * returned 29 results with no location and 1,632 with a US one. Warn
     * rather than silently returning a near-empty run. */
    await pushLog('hiringcafe: no location on this search — results will be geolocated to wherever this browser looks like it is.');
  }

  await patchState({
    active: true, reason: '', startedAt: Date.now(), page: 0,
    collected: 0, currentTitle: 'hiringcafe', source: 'hiringcafe'
  });
  await pushLog('hiringcafe: searching for "' + state.searchQuery + '"' +
    (state.locations ? ' in ' + state.locations[0].formatted_address : ''));

  let collected = 0;
  let pages = 0;
  let reason = 'done';

  try {
    for (let page = 0; page < maxPages; page++) {
      if (hcAbort) { reason = 'stopped-by-user'; break; }

      const html = await hcGet(HC.searchUrl(state, page), false);
      const pageData = HC.pageFrom(html);

      if (pageData.error) {
        await pushLog('hiringcafe: ' + pageData.error);
        reason = 'error';
        break;
      }
      if (!pageData.hits.length) {
        reason = pages ? 'no-more-pages' : 'no-results';
        break;
      }

      /* Drop expired and cap BEFORE fetching descriptions - there is no point
       * making a request per job for rows that are about to be discarded, and
       * it is someone else's server. */
      let live = pageData.hits.filter(function (h) { return h && h.is_expired !== true; });
      if (maxJobs > 0 && collected + live.length > maxJobs) {
        live = live.slice(0, Math.max(0, maxJobs - collected));
      }

      await pushLog('hiringcafe: page ' + (page + 1) + ' — ' + pageData.hits.length +
        ' hits, ' + live.length + ' live' +
        (pageData.total != null ? ' (of ' + pageData.total.toLocaleString() + ' total)' : ''));

      if (!live.length) {
        reason = pages ? 'no-more-pages' : 'no-results';
        break;
      }

      /* Descriptions first, then normalise once with the text in hand. The
       * earlier version normalised twice and paired by position, which put
       * descriptions on the wrong jobs whenever a row was filtered out. */
      const d = await hcFetchDescriptions(live);
      const rebuilt = live.map(function (hit) {
        return HC.normalise(hit, {
          now: Date.now(),
          description: d.texts.get(hit.id) || ''
        });
      }).filter(Boolean);

      await pushLog('hiringcafe: ' + d.got + ' full descriptions' +
        (d.failed ? ', ' + d.failed + ' failed (summary kept)' : ''));

      jobBuffer.push.apply(jobBuffer, rebuilt);
      await flushJobs();

      collected += rebuilt.length;
      pages++;
      await patchState({ page: page + 1, collected: collected });
      notifyPanel({ type: 'JDC_STATE' });

      if (maxJobs > 0 && collected >= maxJobs) { reason = 'max-jobs-reached'; break; }
      if (pageData.lastPage) { reason = 'no-more-pages'; break; }

      await new Promise(function (r) { setTimeout(r, HC_PAGE_PAUSE_MS); });
    }
    if (reason === 'done' && pages >= maxPages) reason = 'max-pages-reached';
  } catch (e) {
    reason = 'error';
    await pushLog('hiringcafe: failed — ' + (e && e.message ? e.message : e));
  }

  await flushJobs();
  const st = await patchState({
    active: false, reason: reason, finishedAt: Date.now(), currentTitle: ''
  });
  await pushLog('hiringcafe: finished — ' + collected + ' jobs, ' + pages + ' page(s) (' + reason + ')');
  notifyPanel({ type: 'JDC_DONE', state: st });

  hcRunning = false;
  return { ok: true, collected: collected, pages: pages, reason: reason };
}

/* ---------- the client manager window ----------
 *
 * Client setup needs room the 400px side panel does not have, so it lives in
 * a popup window instead. A popup rather than a tab because it is a tool, not
 * a document - it should sit alongside the browser, not compete with the job
 * search for a tab strip slot. */

let managerWindowId = null;

async function openManager() {
  const url = chrome.runtime.getURL('src/manager/manager.html');

  /* Reopening should raise the existing window, not stack up copies that then
   * race each other on the same storage key. */
  if (managerWindowId != null) {
    try {
      const win = await chrome.windows.get(managerWindowId);
      if (win) {
        await chrome.windows.update(managerWindowId, { focused: true, drawAttention: true });
        return { ok: true, windowId: managerWindowId, reused: true };
      }
    } catch (e) {
      managerWindowId = null;   // closed since we last looked
    }
  }

  /* Sized to fit the two-pane layout, then clamped to the display so it does
   * not open partly offscreen on a laptop. */
  let width = 1180;
  let height = 860;
  try {
    const cur = await chrome.windows.getCurrent();
    if (cur && cur.width) width = Math.min(width, Math.max(900, cur.width - 80));
    if (cur && cur.height) height = Math.min(height, Math.max(600, cur.height - 60));
  } catch (e) { /* fall back to the defaults */ }

  const win = await chrome.windows.create({
    url: url, type: 'popup', width: width, height: height, focused: true
  });
  managerWindowId = win.id;
  return { ok: true, windowId: win.id, reused: false };
}

chrome.windows.onRemoved.addListener(function (id) {
  if (id === managerWindowId) managerWindowId = null;
});

/* ---------- resolving real apply URLs ---------- */

/* Set while a click is in flight so the tabs.onCreated listener below knows the
 * new tab belongs to us. */
let applyCapture = null;
let resolveAbort = false;
let resolveLoopRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.tabs.onCreated.addListener(function (tab) {
  if (!applyCapture || applyCapture.newTabId != null) return;
  if (tab.openerTabId !== applyCapture.openerTabId) return;
  applyCapture.newTabId = tab.id;
});

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch (e) { return null; }
}

async function waitUntil(fn, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (resolveAbort) return false;
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

const isLinkedIn = (url) => /(^|\.)linkedin\.com$/i.test(hostOf(url));

const JOB_URL = (jobId) => 'https://www.linkedin.com/jobs/view/' + jobId + '/';

async function resolveOneApply(tabId, jobId) {
  await chrome.tabs.update(tabId, { url: JOB_URL(jobId) });

  const loaded = await waitUntil(async function () {
    const t = await getTab(tabId);
    return !!(t && t.status === 'complete' && /\/jobs\/view\//.test(t.url || ''));
  }, 15000, 300);
  if (!loaded) return { status: 'page-load-failed', url: '' };

  await sleep(900); // let the SPA paint the apply button

  applyCapture = { openerTabId: tabId, newTabId: null };

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'JDC_CLICK_APPLY' });
  } catch (e) {
    applyCapture = null;
    return { status: 'click-failed', url: '' };
  }

  if (!res || !res.ok) {
    applyCapture = null;
    return { status: (res && res.error) || 'click-failed', url: '' };
  }
  if (res.viaLink && res.url) {
    applyCapture = null;
    return { status: 'from-link', url: res.url };
  }

  const opened = await waitUntil(async function () {
    return !!(applyCapture && applyCapture.newTabId != null);
  }, 7000, 150);

  if (!opened) {
    /* Some employers replace the current tab instead of opening one. */
    const t = await getTab(tabId);
    applyCapture = null;
    if (t && t.url && !isLinkedIn(t.url)) {
      const captured = t.url;
      await chrome.tabs.update(tabId, { url: JOB_URL(jobId) });
      return { status: 'resolved', url: captured };
    }
    return { status: 'no-new-tab', url: '' };
  }

  const newTabId = applyCapture.newTabId;
  applyCapture = null;

  await waitUntil(async function () {
    const t = await getTab(newTabId);
    return !!(t && t.status === 'complete' && t.url && t.url !== 'about:blank');
  }, 12000, 300);

  const t = await getTab(newTabId);
  const url = (t && t.url) || '';
  try { await chrome.tabs.remove(newTabId); } catch (e) { /* already gone */ }

  if (!url || url === 'about:blank') return { status: 'no-url', url: '' };
  // Stayed inside LinkedIn: there is no employer URL to hand back.
  if (isLinkedIn(url)) return { status: 'linkedin-only', url: '' };
  return { status: 'resolved', url: url };
}

async function cmdResolveApply(ids) {
  const state = await getState();
  if (state.active) return { ok: false, error: 'Stop the collection run first.' };
  if (resolveLoopRunning) return { ok: false, error: 'Already resolving apply URLs.' };

  const found = await activeLinkedInTab();
  if (found.error) return { ok: false, error: found.error };
  const tabId = found.tab.id;

  const jobs = await get(K.jobs, []);
  const byId = new Map(jobs.map((j) => [j.jobId, j]));

  // Only external applications have an employer URL to find.
  const todo = (ids || []).filter(function (id) {
    const j = byId.get(id);
    return j && j.applyType === 'external' && !j.applyUrl;
  });

  if (!todo.length) {
    return { ok: false, error: 'Nothing to resolve: selection has no unresolved direct-apply jobs.' };
  }

  resolveAbort = false;
  resolveLoopRunning = true;
  await patchState({ resolving: true, resolveDone: 0, resolveTotal: todo.length, tabId: tabId });
  await pushLog('Resolving apply URLs for ' + todo.length + ' jobs.');
  notifyPanel({ type: 'JDC_STATE' });

  (async function run() {
    let resolved = 0;
    for (let i = 0; i < todo.length; i++) {
      if (resolveAbort) break;
      const jobId = todo[i];
      let out;
      try {
        out = await resolveOneApply(tabId, jobId);
      } catch (e) {
        out = { status: 'error', url: '' };
      }

      const list = await get(K.jobs, []);
      const job = list.find((j) => j.jobId === jobId);
      if (job) {
        job.applyUrl = out.url || '';
        job.applyUrlStatus = out.status;
        await set({ [K.jobs]: list });
      }

      if (out.url) resolved++;
      await patchState({ resolveDone: i + 1 });
      notifyPanel({ type: 'JDC_APPLY_RESOLVED', jobId: jobId, url: out.url || '', status: out.status });
      await pushLog('Apply URL ' + jobId + ': ' + (out.url || out.status));

      await sleep(700);
    }

    resolveLoopRunning = false;
    await patchState({ resolving: false });
    await pushLog('Apply URL pass finished: ' + resolved + ' of ' + todo.length + ' resolved.');
    notifyPanel({ type: 'JDC_STATE' });
  })().catch(async function (e) {
    resolveLoopRunning = false;
    await patchState({ resolving: false });
    await pushLog('Apply URL pass failed: ' + e.message);
    notifyPanel({ type: 'JDC_STATE' });
  });

  return { ok: true, count: todo.length };
}

/* ---------- Gem verdict memory ----------
 *
 * Hasan pastes exported batches into his own Gemini Gem for vetting against a
 * client's criteria; the Gem calls each job. This does not judge anything -
 * it reads back a judgement that already happened, in a chat Hasan runs, and
 * gives it a memory the same way JDC_MARK_EXPORTED gives "already exported"
 * one. jdc_verdicts holds { [jobId]: { verdict, reason, at, source } }. */

async function cmdGemDiagnose() {
  const found = await activeGeminiTab();
  if (found.error) return { ok: false, error: found.error };
  const ready = await ensureGemContentScript(found.tab.id);
  if (!ready) return { ok: false, error: 'Could not run on that tab. Reload the page and retry.' };
  try {
    const res = await chrome.tabs.sendMessage(found.tab.id, { type: 'JDC_GEM_DIAGNOSE' });
    return res || { ok: false, error: 'No response from the page.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function cmdGemScan() {
  if (!GEMV) return { ok: false, error: 'The verdict parser did not load.' };

  const found = await activeGeminiTab();
  if (found.error) return { ok: false, error: found.error };
  const ready = await ensureGemContentScript(found.tab.id);
  if (!ready) return { ok: false, error: 'Could not run on that tab. Reload the page and retry.' };

  let res;
  try {
    res = await chrome.tabs.sendMessage(found.tab.id, { type: 'JDC_GEM_SCAN' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!res || !res.ok) return res || { ok: false, error: 'No response from the page.' };

  const parsed = GEMV.parseVerdicts(res.text || '');
  const store = await get(K.verdicts, {});
  const now = Date.now();
  let added = 0;
  let updated = 0;

  parsed.matches.forEach(function (m) {
    if (store[m.jobId]) updated++; else added++;
    store[m.jobId] = { verdict: m.verdict, reason: m.reason || '', at: now, source: 'gem' };
  });
  await set({ [K.verdicts]: store });

  await pushLog('Gem scan: ' + added + ' new, ' + updated + ' updated, ' +
    parsed.ambiguous.length + ' ambiguous line(s) not imported.');

  return {
    ok: true,
    added: added,
    updated: updated,
    ambiguous: parsed.ambiguous,
    total: Object.keys(store).length
  };
}

/* ---------- commands ---------- */

async function cmdStart(config) {
  const found = await activeLinkedInTab();
  if (found.error) return { ok: false, error: found.error };
  const tab = found.tab;

  const merged = Object.assign(await getConfig(), config || {});
  await set({ [K.config]: merged });

  if (merged.clearBefore) {
    jobBuffer = [];
    await set({ [K.jobs]: [], [K.log]: [] });
  }

  await patchState(Object.assign({}, DEFAULT_STATE, {
    active: true,
    tabId: tab.id,
    startedAt: Date.now()
  }));

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    await patchState({ active: false, reason: 'injection-failed' });
    return { ok: false, error: 'Could not run on that tab. Reload the LinkedIn page and retry.' };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'JDC_BEGIN', config: merged });
  } catch (e) {
    await patchState({ active: false, reason: 'start-failed' });
    return { ok: false, error: 'Start failed: ' + e.message };
  }

  await pushLog('Scrape started.');
  notifyPanel({ type: 'JDC_STATE' });
  return { ok: true };
}

async function cmdStop() {
  const s = await getState();
  await patchState({ active: false, reason: 'stopped-by-user', finishedAt: Date.now() });
  await flushJobs();
  if (s.tabId != null) {
    chrome.tabs.sendMessage(s.tabId, { type: 'JDC_ABORT' }).catch(function () {});
  }
  await pushLog('Stopped by user.');
  notifyPanel({ type: 'JDC_STATE' });
  return { ok: true };
}

async function cmdGetAll() {
  await flushJobs();
  return {
    state: await getState(),
    config: await getConfig(),
    jobs: await get(K.jobs, []),
    history: await get(K.history, {}),
    verdicts: await get(K.verdicts, {}),
    log: await get(K.log, [])
  };
}

/* ---------- AI assist ----------
 *
 * The one part of this extension that talks to a third party, so it is off by
 * default, it carries a key the user supplies, and it sends STRUCTURE - the
 * outline built by src/content/aiassist.js: tags, class names, a few
 * attributes and truncated label text. No job description, no personal data.
 *
 * The call lives in the worker rather than the content script for two reasons:
 * a cross-origin fetch from a content script is the page's request, not the
 * extension's, and the API key has no business existing anywhere LinkedIn's
 * own scripts run.
 *
 * Plans are cached per page path, so a surface that has been resolved once
 * costs nothing on later runs - and a plan that has stopped matching is
 * dropped by the page-side check rather than believed. */

const AI_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const AIPLAN = self.JDC_AIPLAN;

/* The configured models, in order, de-duplicated. `aiModel` is the older
 * single-model field and still counts as the first choice. */
function aiModelList(cfg) {
  const raw = String(cfg.aiModels === undefined ? (cfg.aiModel || '') : cfg.aiModels);
  const out = [];
  raw.split(/[\n,]+/).forEach(function (m) {
    const name = m.trim();
    if (name && out.indexOf(name) === -1) out.push(name);
  });
  if (!out.length) out.push('minimax/minimax-m2.7:free');
  return out;
}

/* Ask one model. aiComplete below walks the list. */
async function aiChatOne(cfg, messages, opts, model) {
  const o = opts || {};
  const key = String(cfg.aiApiKey || '').trim();
  if (!key) return { ok: false, error: 'No OpenRouter API key set (Settings → AI assist).' };

  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); },
    Math.max(10000, Number(cfg.aiTimeoutMs) || 90000));
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        /* Optional OpenRouter attribution. Deliberately not a real URL: this
         * runs from a browser extension, not a site. */
        'X-Title': 'JD Collector'
      },
      body: JSON.stringify(Object.assign({
        model: model,
        messages: messages,
        temperature: 0,
        max_tokens: o.maxTokens || 1200
      }, o.json === false ? {} : {
        /* Free endpoints do not all honour this, which is why the reply is
         * parsed leniently regardless. The connection test opts out: asking
         * for one word and for JSON at the same time is a contradiction the
         * model resolves by ignoring one of them. */
        response_format: { type: 'json_object' }
      }))
    });
  } catch (e) {
    clearTimeout(timeout);
    if (e && e.name === 'AbortError') {
      return { ok: false, error: 'The model did not answer within the timeout.' };
    }
    return { ok: false, error: 'Could not reach OpenRouter: ' + (e && e.message ? e.message : e) };
  }
  clearTimeout(timeout);

  const ms = Date.now() - t0;
  let body = null;
  let raw = '';
  try {
    raw = await res.text();
    body = JSON.parse(raw);
  } catch (e) { /* handled below */ }

  if (!res.ok) {
    const detail = (body && body.error && body.error.message) || raw.slice(0, 200);
    /* Each of these means something different to fix, so they are named
     * rather than collapsed into "request failed". */
    if (res.status === 401) return { ok: false, error: 'OpenRouter rejected the API key (401).' };
    if (res.status === 402) return { ok: false, error: 'OpenRouter says this account cannot pay for that model (402). Free models end in ":free".' };
    if (res.status === 429) return { ok: false, error: 'Rate limited by OpenRouter (429). Free models allow only a few calls a minute.' };
    if (res.status === 404) return { ok: false, error: 'No such model: ' + model + ' (404).' };
    return { ok: false, error: 'OpenRouter returned ' + res.status + (detail ? ' — ' + detail : '') };
  }

  if (!body) return { ok: false, error: 'OpenRouter returned something that was not JSON.' };
  if (body.error) {
    return { ok: false, error: 'OpenRouter: ' + (body.error.message || JSON.stringify(body.error)) };
  }

  const text = AIPLAN.replyText(body);
  if (!text) return { ok: false, error: 'The model returned an empty reply.' };

  return { ok: true, text: text, ms: ms, model: body.model || model, usage: body.usage || null };
}

/* A bad key is a bad key for every model on the account, so it stops the walk
 * immediately. A rate limit, a provider outage, a timeout or a model that is
 * simply not available to this account are all reasons to try the NEXT model
 * rather than to give up - which is the whole point of configuring more than
 * one free endpoint. */
function aiWorthAnotherModel(error) {
  return !/rejected the API key/i.test(String(error || ''));
}

/* Walks the configured models in order. `opts.accept` lets the caller reject a
 * reply that arrived but was unusable - a model that answers with prose
 * instead of JSON has failed just as surely as one that timed out, and the
 * next model deserves its turn. */
async function aiComplete(cfg, messages, opts) {
  const models = aiModelList(cfg);
  const tried = [];
  /* The last reply that arrived but could not be used. Kept because "every
   * model failed" is not diagnosable on its own - what a model actually said
   * is the only way to tell a prompt problem from a provider one. */
  let lastUnusable = '';

  for (let i = 0; i < models.length; i++) {
    const out = await aiChatOne(cfg, messages, opts, models[i]);

    if (out.ok && (!opts || !opts.accept || opts.accept(out.text))) {
      out.tried = tried;
      out.modelIndex = i;
      return out;
    }

    if (out.ok) lastUnusable = String(out.text || '');
    const why = out.ok ? 'the reply could not be used' : out.error;
    tried.push({ model: models[i], error: why });
    await pushLog('AI assist: ' + models[i] + ' — ' + why +
      (i + 1 < models.length ? '. Trying ' + models[i + 1] + '.' : '.'));

    if (!out.ok && !aiWorthAnotherModel(out.error)) {
      return { ok: false, error: out.error, tried: tried, raw: lastUnusable.slice(0, 400) };
    }
  }

  return {
    ok: false,
    tried: tried,
    raw: lastUnusable.slice(0, 400),
    error: 'every configured model failed: ' +
      tried.map(function (t) { return t.model + ' (' + t.error + ')'; }).join('; ')
  };
}

async function aiResolve(msg) {
  const cfg = await getConfig();
  if (!cfg.aiEnabled) return { ok: false, error: 'AI assist is off (Settings → AI assist).' };

  const path = String((msg && msg.path) || '');
  const plans = await get(K.aiPlans, {});
  const hit = plans[path];

  if (hit && hit.plan && !(msg && msg.force)) {
    return { ok: true, plan: hit.plan, cached: true, model: hit.model, at: hit.at };
  }
  if (msg && msg.cachedOnly) {
    return { ok: false, error: 'no plan remembered for this page', cached: false };
  }
  if (!msg || !msg.digest) return { ok: false, error: 'no page outline to send' };

  /* Walks the configured models, and only accepts a reply that parses into
   * a plan - a model that answers with prose has failed as surely as one that
   * timed out, and the next one deserves its turn. */
  const out = await aiComplete(cfg, AIPLAN.buildMessages(msg.digest, msg.reason), {
    accept: function (text) { return AIPLAN.parsePlan(text).ok; }
  });
  if (!out.ok) {
    await pushLog('AI assist: ' + out.error);
    return out;
  }

  const parsed = AIPLAN.parsePlan(out.text);
  if (!parsed.ok) {
    await pushLog('AI assist: ' + parsed.error + '.');
    return {
      ok: false,
      error: parsed.error,
      /* Kept short and returned rather than logged: this is the only way to
       * see WHY a model's answer was unusable. */
      raw: String(out.text).slice(0, 400)
    };
  }

  plans[path] = {
    plan: parsed.plan,
    notes: parsed.notes,
    model: out.model,
    at: Date.now()
  };
  await set({ [K.aiPlans]: plans });

  return {
    ok: true,
    plan: parsed.plan,
    notes: parsed.notes,
    cached: false,
    model: out.model,
    ms: out.ms,
    usage: out.usage,
    digestChars: String(msg.digest).length
  };
}

/* ---------- the field check ----------
 *
 * One job's pane text in, the fields the page could not yield out - and every
 * one of them checked back against that same text before it is allowed
 * anywhere near a row. See src/lib/aiFields.js for why that check is the whole
 * licence for this feature.
 *
 * It runs on its own model list, defaulting to MiniMax M3, because this is a
 * reading job on up to 4,000 characters rather than the structural puzzle the
 * selector assist poses. */
const AIFIELDS = self.JDC_AIFIELDS;

async function aiCheckFields(msg) {
  const cfg = await getConfig();
  if (!cfg.aiEnabled || !cfg.aiVerifyEnabled) {
    return { ok: false, error: 'the field check is off (Settings → AI assist).' };
  }

  const sample = String((msg && msg.sample) || '');
  const missing = (msg && msg.missing) || [];
  const current = (msg && msg.current) || {};

  if (!sample) return { ok: false, error: 'no page text to check' };
  if (!missing.length) return { ok: true, accepted: {}, rejected: [], skipped: 'nothing missing' };

  /* Its own model list, so the reading model and the selector model can be
   * chosen independently. */
  const verifyCfg = Object.assign({}, cfg, {
    aiModels: cfg.aiVerifyModels || cfg.aiModels
  });

  const out = await aiComplete(verifyCfg,
    AIFIELDS.buildMessages(sample, missing),
    {
      maxTokens: 600,
      accept: function (text) { return AIFIELDS.parseFields(text).ok; }
    });

  if (!out.ok) return { ok: false, error: out.error, tried: out.tried, raw: out.raw };

  const parsed = AIFIELDS.parseFields(out.text);
  if (!parsed.ok) return { ok: false, error: parsed.error, raw: String(out.text).slice(0, 300) };

  const checked = AIFIELDS.verify(parsed.fields, sample, current);

  return {
    ok: true,
    model: out.model,
    ms: out.ms,
    accepted: checked.accepted,
    rejected: checked.rejected,
    asked: missing
  };
}

/* "Resolve this page now", from the settings window: describe the page, ask
 * the model, check the answer against that same page, and print every step.
 * Same spirit as the hiring.cafe probe - a failure says which step broke. */
async function cmdAiProbe() {
  const out = [];
  const line = function (s) { out.push(s); };

  const cfg = await getConfig();
  line('model:   ' + (cfg.aiModel || '(unset)'));
  line('api key: ' + (cfg.aiApiKey ? 'set' : 'NOT SET — nothing can be asked without one'));
  line('enabled: ' + (cfg.aiEnabled ? 'yes' : 'no — a run will not use this, but this probe still will'));
  line('');

  const found = await activeLinkedInTab(true);
  if (found.error) return { ok: true, report: out.concat(['STOPPED: ' + found.error]).join('\n') };
  const ready = await ensureContentScript(found.tab.id);
  if (!ready) return { ok: true, report: out.concat(['STOPPED: could not run on that tab. Reload the page.']).join('\n') };

  let digestRes;
  try {
    digestRes = await chrome.tabs.sendMessage(found.tab.id, { type: 'JDC_AI_DIGEST', reason: 'manual probe' });
  } catch (e) {
    return { ok: true, report: out.concat(['STOPPED: the page did not answer — ' + e.message]).join('\n') };
  }
  if (!digestRes || !digestRes.ok) {
    return { ok: true, report: out.concat(['STOPPED: ' + ((digestRes && digestRes.error) || 'no outline')]).join('\n') };
  }

  const path = new URL(found.tab.url).pathname;
  line('page outline: ' + digestRes.digest.length.toLocaleString() + ' characters describing ' + path);

  const res = await aiResolve({ path: path, digest: digestRes.digest, reason: 'manual probe', force: true });
  if (!res.ok) {
    line('');
    line('THE MODEL CALL FAILED: ' + res.error);
    if (res.raw) {
      line('');
      line('first 400 characters of what came back:');
      line('  ' + res.raw.replace(/\s+/g, ' '));
    }
    return { ok: true, report: out.join('\n') };
  }

  line('answered in ' + res.ms + 'ms' +
    (res.usage ? ('  (' + (res.usage.prompt_tokens || '?') + ' in / ' +
      (res.usage.completion_tokens || '?') + ' out tokens)') : ''));
  if (res.notes) line('model notes: ' + res.notes);
  line('');

  let applied;
  try {
    applied = await chrome.tabs.sendMessage(found.tab.id, { type: 'JDC_AI_APPLY', plan: res.plan });
  } catch (e) {
    return { ok: true, report: out.concat(['The plan came back but the page did not answer: ' + e.message]).join('\n') };
  }
  line(applied && applied.ok ? applied.report : ('Could not check the plan: ' + ((applied && applied.error) || 'no answer')));
  line('');
  line('Accepted selectors are in use on that tab right now and are remembered');
  line('for ' + path + ', so the next run starts with them at no cost.');

  return { ok: true, report: out.join('\n') };
}

/* ---------- message router ---------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    const type = msg && msg.type;

    if (type === 'JDC_GET_ALL') return sendResponse(await cmdGetAll());
    if (type === 'JDC_START') return sendResponse(await cmdStart(msg.config));
    if (type === 'JDC_STOP') return sendResponse(await cmdStop());

    if (type === 'JDC_SET_CONFIG') {
      const merged = Object.assign(await getConfig(), msg.config || {});
      await set({ [K.config]: merged });
      return sendResponse({ ok: true, config: merged });
    }

    if (type === 'JDC_CLEAR_JOBS') {
      jobBuffer = [];
      await set({ [K.jobs]: [], [K.log]: [] });
      await patchState({ collected: 0, skippedSeen: 0, failed: 0, pagesDone: 0 });
      notifyPanel({ type: 'JDC_STATE' });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_MARK_EXPORTED') {
      const hist = await get(K.history, {});
      const now = Date.now();
      const ids = msg.ids || [];
      for (let i = 0; i < ids.length; i++) hist[ids[i]] = now;
      await set({ [K.history]: hist });
      return sendResponse({ ok: true, count: Object.keys(hist).length });
    }

    if (type === 'JDC_RESOLVE_APPLY') {
      return sendResponse(await cmdResolveApply(msg.ids));
    }

    if (type === 'JDC_STOP_RESOLVE') {
      resolveAbort = true;
      await patchState({ resolving: false });
      await pushLog('Apply URL pass stopped by user.');
      notifyPanel({ type: 'JDC_STATE' });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_DIAGNOSE') {
      const found = await activeLinkedInTab(true);
      if (found.error) return sendResponse({ ok: false, error: found.error });
      const ready = await ensureContentScript(found.tab.id);
      if (!ready) return sendResponse({ ok: false, error: 'Could not run on that tab. Reload the page.' });
      try {
        const res = await chrome.tabs.sendMessage(found.tab.id, { type: 'JDC_DIAGNOSE' });
        return sendResponse(res || { ok: false, error: 'No response from the page.' });
      } catch (e) {
        return sendResponse({ ok: false, error: e.message });
      }
    }

    if (type === 'JDC_AI_RESOLVE') {
      return sendResponse(await aiResolve(msg));
    }

    if (type === 'JDC_AI_TRACE') {
      const found = await activeLinkedInTab(true);
      if (found.error) return sendResponse({ ok: false, error: found.error });
      const ready = await ensureContentScript(found.tab.id);
      if (!ready) return sendResponse({ ok: false, error: 'Could not run on that tab. Reload the page.' });
      try {
        const res = await chrome.tabs.sendMessage(found.tab.id, { type: 'JDC_AI_TRACE' });
        return sendResponse(res || { ok: false, error: 'No response from the page.' });
      } catch (e) {
        return sendResponse({ ok: false, error: e.message });
      }
    }

    if (type === 'JDC_AI_FIELDS') {
      return sendResponse(await aiCheckFields(msg));
    }

    if (type === 'JDC_AI_PROBE') {
      return sendResponse(await cmdAiProbe());
    }

    if (type === 'JDC_AI_TEST') {
      const cfg = await getConfig();
      /* Every configured model, not just the first. The useful answer is
       * which of them work, since the point of a list is that one being rate
       * limited does not take the assist down with it. */
      const models = aiModelList(cfg);
      const results = [];

      for (let i = 0; i < models.length; i++) {
        const one = await aiChatOne(cfg, [
          { role: 'system', content: 'Reply with the single word OK and nothing else.' },
          { role: 'user', content: 'ping' }
        ], { maxTokens: 32, json: false }, models[i]);

        results.push({
          model: models[i],
          ok: !!one.ok,
          ms: one.ms || null,
          detail: one.ok
            ? AIPLAN.stripReasoning(one.text).replace(/\s+/g, ' ').trim().slice(0, 60)
            : one.error
        });
      }

      const working = results.filter(function (r) { return r.ok; });
      return sendResponse({
        ok: working.length > 0,
        error: working.length ? null : 'no configured model answered',
        results: results,
        model: working.length ? working[0].model : null,
        ms: working.length ? working[0].ms : null,
        reply: working.length ? working[0].detail : null
      });
    }

    if (type === 'JDC_AI_PLANS') {
      return sendResponse({ ok: true, plans: await get(K.aiPlans, {}) });
    }

    if (type === 'JDC_AI_CLEAR_PLANS') {
      await set({ [K.aiPlans]: {} });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_CLEAR_HISTORY') {
      await set({ [K.history]: {} });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_GEM_DIAGNOSE') {
      return sendResponse(await cmdGemDiagnose());
    }

    if (type === 'JDC_GEM_SCAN') {
      return sendResponse(await cmdGemScan());
    }

    if (type === 'JDC_FORGET_VERDICT') {
      const store = await get(K.verdicts, {});
      delete store[msg.jobId];
      await set({ [K.verdicts]: store });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_CLEAR_VERDICTS') {
      await set({ [K.verdicts]: {} });
      return sendResponse({ ok: true });
    }

    /* --- from the content script --- */

    if (type === 'JDC_IS_ACTIVE') {
      const s = await getState();
      return sendResponse({ active: !!s.active, config: await getConfig(), state: s });
    }

    if (type === 'JDC_JOBS') {
      const jobs = msg.jobs || [];
      jobBuffer.push.apply(jobBuffer, jobs);
      scheduleFlush();
      const prev = await getState();
      const s = await patchState({ collected: prev.collected + jobs.length });
      notifyPanel({ type: 'JDC_JOBS', jobs: jobs, state: s });
      /* A response with something in it: the content script logs this as the
       * save status, and "{ok:true}" alone cannot tell a stored job from a
       * dropped one. */
      return sendResponse({
        ok: true,
        received: jobs.length,
        buffered: jobBuffer.length,
        collected: s.collected
      });
    }

    if (type === 'JDC_PROGRESS') {
      const s = await patchState(msg.patch || {});
      notifyPanel({ type: 'JDC_PROGRESS', state: s });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_LOG') {
      await pushLog(msg.line);
      notifyPanel({ type: 'JDC_LOG', line: msg.line });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_DONE') {
      await flushJobs();
      const s = await patchState({
        active: false,
        reason: msg.reason || 'done',
        finishedAt: Date.now(),
        currentTitle: ''
      });
      await pushLog('Finished: ' + (msg.reason || 'done'));
      notifyPanel({ type: 'JDC_DONE', state: s });
      return sendResponse({ ok: true });
    }

    if (type === 'JDC_HC_PROBE') {
      /* Runs the collect chain one step at a time and reports each step, so a
       * failure says WHICH call broke and with what status instead of just
       * "not working". Reads nothing into storage. */
      const out = [];
      const line = function (s) { out.push(s); };
      try {
        const search = msg.search || {};
        line('search: ' + JSON.stringify({
          keywords: search.keywords || null,
          location: search.location || null,
          remote: search.remote || null,
          posted: search.posted || null
        }));

        const state = HC.buildSearchState(search);
        line('searchState: ' + JSON.stringify(state));
        if (!state.searchQuery) line('WARNING: no keywords — the run will refuse to start');
        if (!state.locations) line('WARNING: no location — results will be geolocated to this connection');

        const url = HC.searchUrl(state, 0);
        line('');
        line('GET ' + url.slice(0, 160) + (url.length > 160 ? '…' : ''));

        let html;
        const t0 = Date.now();
        try {
          html = await hcGet(url, false);
          line('  ok — ' + html.length.toLocaleString() + ' bytes in ' + (Date.now() - t0) + 'ms');
        } catch (e) {
          line('  FAILED — ' + (e && e.message ? e.message : e));
          line('');
          line('If this says "Failed to fetch", the extension has no permission for');
          line('hiringcafe.com. Check host_permissions in the manifest and reload.');
          return sendResponse({ ok: true, report: out.join('\n') });
        }

        line('');
        line('parsing __NEXT_DATA__');
        line('  <script id="__NEXT_DATA__"> present: ' +
          (html.indexOf('__NEXT_DATA__') !== -1));
        const pageData = HC.pageFrom(html);
        line('  hits: ' + pageData.hits.length);
        line('  total: ' + (pageData.total == null ? 'unknown' : pageData.total));
        line('  lastPage: ' + pageData.lastPage);
        line('  error: ' + JSON.stringify(pageData.error));

        if (!pageData.hits.length) {
          line('');
          line('No hits. Either the query genuinely matches nothing, or the page');
          line('shape changed and pageFrom needs updating. First 300 chars of the');
          line('response, to tell those apart:');
          line('  ' + html.slice(0, 300).replace(/\s+/g, ' '));
          return sendResponse({ ok: true, report: out.join('\n') });
        }

        const hit = pageData.hits[0];
        line('');
        line('first hit, raw keys: ' + Object.keys(hit).join(', '));

        const job = HC.normalise(hit, { now: Date.now() });
        line('');
        line('normalised (no description yet):');
        ['jobId', 'title', 'company', 'location', 'workplaceType', 'applyType',
         'applyUrl', 'payRaw', 'yoeMin', 'atsSource'].forEach(function (k) {
          line('  ' + k.padEnd(16) + JSON.stringify(job ? job[k] : null));
        });

        const durl = HC.descriptionUrl(hit.id);
        line('');
        line('GET ' + durl.slice(0, 160));
        try {
          const body = await hcGet(durl, true);
          const text = HC.descriptionFrom(body);
          line('  ok — description ' + text.length.toLocaleString() + ' chars of text');
          line('  first 200: ' + text.slice(0, 200).replace(/\s+/g, ' '));
        } catch (e) {
          line('  FAILED — ' + (e && e.message ? e.message : e));
          line('  (a run would still collect, keeping the short summary)');
        }

        line('');
        line('All steps that could run, ran. If a real collect still fails, the');
        line('activity log on this page records every step of it.');
      } catch (e) {
        line('PROBE CRASHED: ' + (e && e.stack ? e.stack : e));
      }
      return sendResponse({ ok: true, report: out.join('\n') });
    }

    if (type === 'JDC_HC_COLLECT') {
      /* Deliberately not awaited: the run outlives this message so the panel
       * is not blocked, and progress arrives through notifyPanel like the
       * LinkedIn collector. */
      hcCollect(msg.search).catch(function (e) {
        pushLog('hiringcafe: crashed — ' + (e && e.message ? e.message : e));
        hcRunning = false;
      });
      return sendResponse({ ok: true, started: true });
    }

    if (type === 'JDC_HC_STOP') {
      hcAbort = true;
      return sendResponse({ ok: true, stopping: hcRunning });
    }

    if (type === 'JDC_OPEN_MANAGER') {
      try {
        return sendResponse(await openManager());
      } catch (e) {
        return sendResponse({ ok: false, error: 'Could not open the manager: ' + e.message });
      }
    }


    return sendResponse({ ok: false, error: 'unknown message' });
  })().catch(function (e) {
    console.error('[JDC bg]', e);
    try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) {}
  });
  return true; // keep the channel open for the async work above
});

/* ---------- toolbar / lifecycle ---------- */

chrome.runtime.onInstalled.addListener(function () {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
});

chrome.action.onClicked.addListener(function (tab) {
  chrome.sidePanel.open({ tabId: tab.id }).catch(function () {});
});

/* A torn-down service worker takes any in-flight apply-URL pass with it, so a
 * fresh evaluation must never inherit a stale "resolving" flag. */
(async function clearStaleResolving() {
  const s = await getState();
  if (s.resolving && !resolveLoopRunning) await patchState({ resolving: false });
})();

/* If the scraped tab dies mid-run, do not leave the state stuck on active. */
chrome.tabs.onRemoved.addListener(async function (tabId) {
  const s = await getState();
  if (s.active && s.tabId === tabId) {
    await flushJobs();
    await patchState({ active: false, reason: 'tab-closed', finishedAt: Date.now() });
    notifyPanel({ type: 'JDC_STATE' });
  }
});
