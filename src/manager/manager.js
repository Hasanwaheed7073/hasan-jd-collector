/* JD Collector - the settings window.
 *
 * Three sheets: how hard to drive the collector, the prompt that leads every
 * exported batch, and the diagnostics that get written into an adapter when a
 * site redesigns.
 *
 * Config goes through the service worker rather than being written directly,
 * because the worker merges - a direct write to jdc_config would drop fields
 * this window does not know about. Saving is debounced on every edit; a save
 * button in a window you can close is a way to lose work.
 */

const $ = (id) => document.getElementById(id);

const LOG_KEY = 'jdc_log';
const SEARCH_KEY = 'jdc_search';

/* Duplicated from background.js so Reset works without a round trip. If the
 * worker's copy changes, this should follow it. */
const BUILTIN_PROMPT = [
  'Below are job postings I collected, with the facts parsed out of each one.',
  '',
  'For each job return one row:',
  'ID | Title | Company | one-line read | biggest concern',
  '',
  'Be concise and concrete. Say what the posting actually says.'
].join('\n');

/* Kept in step with DEFAULT_CONFIG.aiModels in background.js. */
/* The field check reads one job's pane rather than a page outline, so it gets
 * its own list - MiniMax M3 first, per its million-token context. */
const DEFAULT_VERIFY_MODELS =
  ['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'].join('\n');

const DEFAULT_MODELS = [
  'minimax/minimax-m2.7:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'z-ai/glm-5.2:free'
].join('\n');

/* Duplicated from background.js for the same reason as BUILTIN_PROMPT. */
const BUILTIN_VETTING = [
  'End your reply with exactly one line per job, in this literal format, so',
  'the result can be re-imported automatically:',
  'VERDICT <ID> ACCEPT',
  'VERDICT <ID> REJECT: <short reason>'
].join('\n');

let CONFIG = {};
let cfgTimer = null;

function bg(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (res) {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: chrome.runtime.lastError.message });
      }
      resolve(res || { ok: false, error: 'no response' });
    });
  });
}

function banner(text, ok) {
  const b = $('banner');
  if (!text) { b.hidden = true; b.textContent = ''; return; }
  b.textContent = text;
  b.className = 'banner' + (ok ? ' ok' : '');
  b.hidden = false;
  setTimeout(function () { if (b.textContent === text) b.hidden = true; }, 6000);
}

/* ---------------- sections ---------------- */

function showSection(name) {
  document.querySelectorAll('.navbtn').forEach(function (b) {
    b.classList.toggle('on', b.dataset.section === name);
  });
  document.querySelectorAll('.sheet').forEach(function (el) {
    el.hidden = el.dataset.section !== name;
  });
  if (name === 'diagnostics') refreshLog();
  if (name === 'vetting') refreshVerdicts();
  if (name === 'ai') refreshPlans();
}

/* ---------------- config ---------------- */

function configToForm() {
  const c = CONFIG || {};
  const put = function (id, v, fallback) {
    $(id).value = (v === undefined || v === null) ? fallback : v;
  };
  put('cDelay', c.delayMs, 1200);
  put('cJitter', c.jitterMs, 500);
  put('cPauseEvery', c.longPauseEvery, 25);
  put('cPauseMs', c.longPauseMs, 6000);
  put('cMaxPages', c.maxPages, 5);
  put('cMaxJobs', c.maxJobs, 0);
  $('cSkipSeen').checked = !!c.skipSeen;
  $('cSkipRejected').checked = !!c.skipRejected;
  $('cClearBefore').checked = c.clearBefore !== false;

  $('xPrompt').value = c.promptTemplate === undefined ? BUILTIN_PROMPT : c.promptTemplate;
  $('xVetting').value = c.vettingFormat === undefined ? BUILTIN_VETTING : c.vettingFormat;
  put('xBatchChars', c.batchChars, 80000);
  put('xMaxJd', c.maxJdChars, 6000);

  $('aEnabled').checked = !!c.aiEnabled;
  put('aKey', c.aiApiKey, '');
  put('aModels', c.aiModels, DEFAULT_MODELS);
  $('aVerify').checked = !!c.aiVerifyEnabled;
  put('aVerifyModels', c.aiVerifyModels, DEFAULT_VERIFY_MODELS);
  put('aVerifyMax', c.aiVerifyMaxJobs, 30);
  put('aVerifyChars', c.aiVerifySampleChars, 4000);
  put('aMaxCalls', c.aiMaxCalls, 2);
  put('aTimeout', c.aiTimeoutMs, 90000);

  renderPromptInfo();
}

function renderPromptInfo() {
  const t = $('xPrompt').value;
  $('promptInfo').textContent = t.length.toLocaleString() + ' characters' +
    (t.trim() === BUILTIN_PROMPT.trim() ? ' · unchanged from the built-in' : ' · edited');
}

function formToConfig() {
  /* Empty means "use the default", an explicit 0 means 0. Number('') is 0, so
   * the two have to be told apart on the raw string - otherwise clearing a
   * field silently sets it to zero, and for the per-job delay that means
   * hammering LinkedIn with no pause at all. */
  const num = function (id, fallback, floor) {
    const raw = String($(id).value).trim();
    if (raw === '') return fallback;
    const v = Number(raw);
    if (isNaN(v)) return fallback;
    return floor == null ? v : Math.max(floor, v);
  };

  return {
    delayMs: num('cDelay', 1200, 200),
    jitterMs: num('cJitter', 500, 0),
    longPauseEvery: num('cPauseEvery', 25),
    longPauseMs: num('cPauseMs', 6000, 0),
    maxPages: num('cMaxPages', 5),
    maxJobs: num('cMaxJobs', 0),
    skipSeen: $('cSkipSeen').checked,
    skipRejected: $('cSkipRejected').checked,
    clearBefore: $('cClearBefore').checked,
    promptTemplate: $('xPrompt').value,
    vettingFormat: $('xVetting').value,
    batchChars: num('xBatchChars', 80000, 5000),
    maxJdChars: num('xMaxJd', 6000),

    aiEnabled: $('aEnabled').checked,
    /* Trimmed because a key pasted with a trailing newline authenticates as
     * nothing and reports only "401". */
    aiApiKey: String($('aKey').value).trim(),
    aiModels: String($('aModels').value).trim(),
    aiVerifyEnabled: $('aVerify').checked,
    aiVerifyModels: String($('aVerifyModels').value).trim(),
    aiVerifyMaxJobs: num('aVerifyMax', 30, 0),
    aiVerifySampleChars: num('aVerifyChars', 4000, 500),
    aiMaxCalls: num('aMaxCalls', 2, 0),
    aiTimeoutMs: num('aTimeout', 90000, 10000)
  };
}

/* An external jdc_config write that lands while this window has its own edit
 * pending - another manager window, or the worker applying a default. Holding
 * the {oldValue, newValue} pair (not just newValue) is what lets the replay
 * below apply only the fields that actually changed, instead of overwriting
 * this window's own not-yet-saved edit with a stale snapshot of everything
 * else. */
let pendingExternalChange = null;

function saveConfig() {
  $('saveState').textContent = 'Saving…';
  if (cfgTimer) clearTimeout(cfgTimer);
  cfgTimer = setTimeout(async function () {
    cfgTimer = null;
    const res = await bg({ type: 'JDC_SET_CONFIG', config: formToConfig() });
    if (res && res.config) CONFIG = res.config;
    $('saveState').textContent = res && res.ok ? 'Saved' : 'Save failed';
    setTimeout(function () { if (!cfgTimer) $('saveState').textContent = ''; }, 1500);

    /* The debounce is done and this window's own edit is now on its way to
     * the worker (reflected in CONFIG above). Anything queued while that was
     * pending must not just be dropped - replay only the fields it actually
     * changed, on top of CONFIG as it now stands, so the edit that just
     * finished saving is never the one that gets clobbered. */
    if (pendingExternalChange) {
      const before = pendingExternalChange.oldValue || {};
      const after = pendingExternalChange.newValue || {};
      pendingExternalChange = null;

      const diff = {};
      Object.keys(after).forEach(function (k) {
        if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) diff[k] = after[k];
      });
      if (Object.keys(diff).length) {
        CONFIG = Object.assign({}, CONFIG, diff);
        configToForm();
      }
    }
  }, 400);
}

/* A close must not outrun the debounce. */
window.addEventListener('beforeunload', function () {
  if (cfgTimer) {
    clearTimeout(cfgTimer);
    chrome.runtime.sendMessage({ type: 'JDC_SET_CONFIG', config: formToConfig() });
  }
});

/* ---------------- diagnostics ---------------- */

/* The log is an array of { t, line } records, not strings. */
async function refreshLog() {
  const got = await chrome.storage.local.get(LOG_KEY);
  const log = got[LOG_KEY];
  const box = $('logOut');
  if (!Array.isArray(log) || !log.length) {
    box.textContent = '(nothing logged yet)';
    return;
  }
  box.textContent = log
    .map(function (l) { return new Date(l.t).toLocaleTimeString() + '  ' + l.line; })
    .join('\n');
  box.scrollTop = box.scrollHeight;
}

/* ---------------- vetting feedback ---------------- */

async function refreshVerdicts() {
  const all = await bg({ type: 'JDC_GET_ALL' });
  const store = (all && all.verdicts) || {};
  const ids = Object.keys(store).sort(function (a, b) {
    return (store[b].at || 0) - (store[a].at || 0);
  });

  const box = $('gemList');
  box.textContent = '';

  if (!ids.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Nothing remembered yet. Open the chat you paste batches into, then scan.';
    box.appendChild(empty);
    return;
  }

  ids.forEach(function (id) {
    const v = store[id];
    const row = document.createElement('div');
    row.className = 'item';

    const badge = document.createElement('span');
    badge.className = 'badge' + (v.verdict === 'reject' ? '' : ' grey');
    badge.textContent = v.verdict === 'reject' ? 'turned down' : 'approved';

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = id + (v.reason ? ' — ' + v.reason : '');
    if (v.at) name.title = new Date(v.at).toLocaleString();

    const forget = document.createElement('button');
    forget.textContent = 'Forget';
    forget.addEventListener('click', async function () {
      await bg({ type: 'JDC_FORGET_VERDICT', jobId: id });
      refreshVerdicts();
    });

    row.appendChild(badge);
    row.appendChild(name);
    row.appendChild(forget);
    box.appendChild(row);
  });
}

/* ---------------- AI assist ---------------- */

/* One row per page path a plan has been resolved for. A plan is only ever a
 * cached answer to "where are things on this page" - the page re-checks every
 * selector before using it, so a stale row costs a re-resolve, not a bad
 * collect. */
async function refreshPlans() {
  const res = await bg({ type: 'JDC_AI_PLANS' });
  const plans = (res && res.plans) || {};
  const paths = Object.keys(plans).sort();

  const box = $('aiPlans');
  box.textContent = '';

  if (!paths.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No page has been resolved yet.';
    box.appendChild(empty);
    return;
  }

  paths.forEach(function (path) {
    const p = plans[path] || {};
    const keys = Object.keys(p.plan || {});

    const row = document.createElement('div');
    row.className = 'item';

    const badge = document.createElement('span');
    badge.className = 'badge grey';
    badge.textContent = keys.length + ' selector' + (keys.length === 1 ? '' : 's');

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = path + ' — ' + keys.join(', ');
    if (p.at) name.title = new Date(p.at).toLocaleString() + ' · ' + (p.model || '');

    row.appendChild(badge);
    row.appendChild(name);
    box.appendChild(row);
  });
}

/* ---------------- wiring ---------------- */

function wire() {
  document.querySelectorAll('.navbtn').forEach(function (b) {
    b.addEventListener('click', function () { showSection(b.dataset.section); });
  });

  ['cDelay', 'cJitter', 'cPauseEvery', 'cPauseMs', 'cMaxPages', 'cMaxJobs',
    'xBatchChars', 'xMaxJd', 'aKey', 'aModels', 'aMaxCalls', 'aTimeout',
    'aVerifyModels', 'aVerifyMax', 'aVerifyChars'].forEach(function (id) {
    $(id).addEventListener('input', saveConfig);
  });
  ['cSkipSeen', 'cSkipRejected', 'cClearBefore', 'aEnabled', 'aVerify'].forEach(function (id) {
    $(id).addEventListener('change', saveConfig);
  });
  $('xPrompt').addEventListener('input', function () { renderPromptInfo(); saveConfig(); });
  $('xVetting').addEventListener('input', saveConfig);

  $('btnResetPrompt').addEventListener('click', function () {
    $('xPrompt').value = BUILTIN_PROMPT;
    renderPromptInfo();
    saveConfig();
    banner('Prompt reset to the built-in.', true);
  });

  $('btnResetVetting').addEventListener('click', function () {
    $('xVetting').value = BUILTIN_VETTING;
    saveConfig();
    banner('Vetting reply format reset to the built-in.', true);
  });

  $('btnGemScan').addEventListener('click', async function () {
    $('gemInfo').textContent = 'Reading the chat tab…';
    $('gemOut').textContent = '';
    const res = await bg({ type: 'JDC_GEM_SCAN' });
    $('gemInfo').textContent = '';

    if (!res.ok) return void ($('gemOut').textContent = 'Error: ' + res.error);

    const out = [
      res.added + ' new, ' + res.updated + ' updated — ' + res.total + ' remembered in total.'
    ];
    if (res.ambiguous && res.ambiguous.length) {
      out.push('');
      out.push(res.ambiguous.length + ' line(s) looked like a call but were not in a shape');
      out.push('worth trusting, so nothing was imported from them:');
      res.ambiguous.forEach(function (l) { out.push('  ' + l); });
    }
    $('gemOut').textContent = out.join('\n');
    refreshVerdicts();
  });

  $('btnGemDiag').addEventListener('click', async function () {
    $('gemInfo').textContent = 'Asking the chat tab…';
    const res = await bg({ type: 'JDC_GEM_DIAGNOSE' });
    $('gemOut').textContent = res.ok ? (res.report || '(empty report)') : ('Error: ' + res.error);
    $('gemInfo').textContent = '';
  });

  $('btnGemRefresh').addEventListener('click', refreshVerdicts);

  $('btnGemClear').addEventListener('click', async function () {
    if (!confirm('Forget every remembered call? "Skip jobs a previous vetting pass turned down" will stop working until it refills.')) return;
    await bg({ type: 'JDC_CLEAR_VERDICTS' });
    refreshVerdicts();
    banner('Cleared.', true);
  });

  $('btnAiProbe').addEventListener('click', async function () {
    if (!$('aKey').value.trim()) {
      return banner('Set an OpenRouter API key first.');
    }
    $('aiInfo').textContent = 'Describing the page and asking the model…';
    $('aiOut').textContent = '';
    const res = await bg({ type: 'JDC_AI_PROBE' });
    $('aiOut').textContent = res.ok ? (res.report || '(empty report)') : ('Error: ' + res.error);
    $('aiInfo').textContent = '';
    refreshPlans();
  });

  $('btnAiTest').addEventListener('click', async function () {
    $('aiInfo').textContent = 'Calling OpenRouter…';
    const res = await bg({ type: 'JDC_AI_TEST' });
    /* One row per model. Falls back to the single-answer shape rather than
     * rendering "Error: undefined" if the worker ever answers the old way. */
    $('aiOut').textContent = (res.results || []).length
      ? res.results.map(function (r) {
        return (r.ok ? 'OK    ' : 'FAIL  ') + r.model.padEnd(42) +
          (r.ok ? (r.ms + 'ms  "' + r.detail + '"') : r.detail);
      }).join('\n')
      : (res.ok
        ? ('OK — ' + res.model + ' answered in ' + res.ms + 'ms: "' + res.reply + '"')
        : ('Error: ' + res.error));
    $('aiInfo').textContent = '';
  });

  $('btnAiCopy').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText($('aiOut').textContent);
      banner('Report copied.', true);
    } catch (e) { banner('Could not copy: ' + e.message); }
  });

  $('btnAiRefresh').addEventListener('click', refreshPlans);

  $('btnAiClear').addEventListener('click', async function () {
    if (!confirm('Forget every resolved page plan? The next run on those pages will have to ask the model again.')) return;
    await bg({ type: 'JDC_AI_CLEAR_PLANS' });
    refreshPlans();
    banner('Forgotten.', true);
  });

  $('btnDiagJob').addEventListener('click', async function () {
    $('diagInfo').textContent = 'Asking the job tab…';
    const res = await bg({ type: 'JDC_DIAGNOSE' });
    $('diagOut').textContent = res.ok ? (res.report || '(empty report)') : ('Error: ' + res.error);
    $('diagInfo').textContent = '';
  });

  $('btnTraceOne').addEventListener('click', async function () {
    $('diagInfo').textContent = 'Tracing one job on the open tab…';
    $('diagOut').textContent = '';
    const res = await bg({ type: 'JDC_AI_TRACE' });
    $('diagOut').textContent = res.ok
      ? (res.report || '(empty report)')
      : ('Error: ' + res.error + (res.report ? '\n\n' + res.report : ''));
    $('diagInfo').textContent = '';
  });

  $('btnDiagHc').addEventListener('click', async function () {
    /* The probe runs against whatever the panel's search fields hold, since
     * those are the only criteria there are. */
    const got = await chrome.storage.local.get(SEARCH_KEY);
    const s = got[SEARCH_KEY] || {};
    const search = {
      keywords: s.sKeywords || '',
      location: s.sLocation || '',
      remote: s.sRemote || '',
      posted: s.sPosted || ''
    };
    if (!search.keywords) {
      return banner('Set job title / keywords in the side panel first — the probe uses those.');
    }

    $('diagInfo').textContent = 'Running the hiring.cafe chain…';
    $('diagOut').textContent = '';
    const res = await bg({ type: 'JDC_HC_PROBE', search: search });
    $('diagOut').textContent = res.ok ? res.report : ('Error: ' + res.error);
    $('diagInfo').textContent = '';
  });

  $('btnDiagCopy').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText($('diagOut').textContent);
      banner('Report copied.', true);
    } catch (e) { banner('Could not copy: ' + e.message); }
  });

  $('btnLogRefresh').addEventListener('click', refreshLog);
  $('btnLogCopy').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText($('logOut').textContent);
      banner('Log copied.', true);
    } catch (e) { banner('Could not copy: ' + e.message); }
  });
}

/* Settings changed elsewhere - the worker writing a default, or a second copy
 * of this window. Applied immediately, unless this window has its own edit
 * pending - in which case it is queued (see saveConfig) rather than dropped,
 * so the field being typed keeps its value on screen without the change
 * itself being lost. */
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (!changes.jdc_config) return;

  if (cfgTimer) {
    /* Keep the oldValue from BEFORE this round of queuing started, and only
     * ever advance newValue - so two external writes landing back to back
     * during the same pending edit still diff correctly against the true
     * starting point instead of losing the first write's changes. */
    if (pendingExternalChange) pendingExternalChange.newValue = changes.jdc_config.newValue;
    else pendingExternalChange = { oldValue: changes.jdc_config.oldValue, newValue: changes.jdc_config.newValue };
    return;
  }
  CONFIG = changes.jdc_config.newValue || {};
  configToForm();
});

(async function main() {
  wire();
  const all = await bg({ type: 'JDC_GET_ALL' });
  CONFIG = (all && all.config) || {};
  configToForm();
  showSection('collection');
})();
