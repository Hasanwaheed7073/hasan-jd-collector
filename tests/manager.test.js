/* Loads the real manager.html + manager.js in jsdom with stubbed chrome APIs.
 *
 * The settings window writes on a debounce with no Save button, so the things
 * worth pinning are that edits actually reach storage, that the bar only ever
 * shows one section, and that config goes through the worker's merge rather
 * than a direct write that would drop keys this window does not know about. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', 'src', 'manager');
const html = fs.readFileSync(path.join(ROOT, 'manager.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'manager.js'), 'utf8');

const dom = new JSDOM(html, { url: 'chrome-extension://test/manager.html' });
global.window = dom.window;
global.document = dom.window.document;

/* Node 21+ exposes navigator as an accessor-only global, so a plain assignment
 * silently does nothing and the clipboard stub is never reached. */
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true
});

require('../src/lib/hiringcafe.js');

let copied = null;
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: (t) => { copied = t; return Promise.resolve(); } },
  configurable: true
});

const STORE = {};
const SENT = [];
let CONFIG_STORE = {
  delayMs: 1200, jitterMs: 500, longPauseEvery: 25, longPauseMs: 6000,
  maxPages: 5, maxJobs: 0, skipSeen: false, clearBefore: true,
  batchChars: 80000, maxJdChars: 6000, promptTemplate: 'STORED PROMPT'
};
const changeListeners = [];

global.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => {
      SENT.push(msg);
      let res = { ok: true };
      if (msg.type === 'JDC_GET_ALL') {
        res = { state: {}, config: CONFIG_STORE, jobs: [], history: {}, log: [] };
      } else if (msg.type === 'JDC_SET_CONFIG') {
        CONFIG_STORE = Object.assign({}, CONFIG_STORE, msg.config || {});
        res = { ok: true, config: CONFIG_STORE };
      } else if (msg.type === 'JDC_DIAGNOSE') {
        res = { ok: true, report: 'JOB PAGE REPORT' };
      } else if (msg.type === 'JDC_HC_PROBE') {
        res = { ok: true, report: 'HC PROBE for ' + (msg.search && msg.search.keywords) };
      } else if (msg.type === 'JDC_AI_PROBE') {
        res = { ok: true, report: 'AI PROBE REPORT' };
      } else if (msg.type === 'JDC_AI_TEST') {
        res = {
          ok: true, model: 'minimax/minimax-m2.7:free', ms: 900, reply: 'OK',
          results: [
            { model: 'minimax/minimax-m2.7:free', ok: true, ms: 900, detail: 'OK' },
            { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', ok: true, ms: 1400, detail: 'OK' },
            { model: 'z-ai/glm-5.2:free', ok: false, ms: null,
              detail: 'Rate limited by OpenRouter (429).' }
          ]
        };
      } else if (msg.type === 'JDC_AI_PLANS') {
        res = { ok: true, plans: { '/jobs/search-results/': {
          plan: { list: 'ul.a5b65bc4', card: 'li._2e9433c3' },
          model: 'minimax/minimax-m2.7:free', at: 1756000000000
        } } };
      }
      if (cb) cb(res);
      return Promise.resolve(res);
    },
    onMessage: { addListener: () => {} }
  },
  storage: {
    local: {
      get: (k, cb) => {
        const out = {};
        (Array.isArray(k) ? k : [k]).forEach((key) => { if (STORE[key] !== undefined) out[key] = STORE[key]; });
        return cb ? cb(out) : Promise.resolve(out);
      },
      set: (o, cb) => { Object.assign(STORE, o); return cb ? cb() : Promise.resolve(); }
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) }
  }
};

let API;
eval(src + '\n;API = { showSection, configToForm, formToConfig, refreshLog, ' +
  'get CONFIG(){return CONFIG}, set CONFIG(v){CONFIG=v}, BUILTIN_PROMPT };');

const $ = (id) => document.getElementById(id);

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
/* Saves are debounced at 400ms, so draining microtasks would check storage
 * before the write happened. */
const settleSaved = async () => { await sleep(500); await settle(); };

(async function run() {
  await settle();

  console.log('--- five sections, exactly one showing ---');

  const sheets = () => Array.from(document.querySelectorAll('.sheet'));

  check('five buttons in the bar', document.querySelectorAll('.navbtn').length, 5);
  check('five sheets', sheets().length, 5);

  API.showSection('collection');
  check('one visible', sheets().filter((e) => !e.hidden).length, 1);
  check('and it is collection', sheets().find((e) => !e.hidden).dataset.section, 'collection');
  check('the bar marks it', document.querySelector('.navbtn.on').dataset.section, 'collection');

  ['export', 'vetting', 'ai', 'diagnostics', 'collection'].forEach(function (name) {
    API.showSection(name);
    check(name + ' shows alone', sheets().filter((e) => !e.hidden).length, 1);
    check(name + ' is the one showing', sheets().find((e) => !e.hidden).dataset.section, name);
    check(name + ' marks exactly one button', document.querySelectorAll('.navbtn.on').length, 1);
  });

  /* Clients and in-extension fit scoring are gone and must stay gone. The
   * Vetting feedback section is NOT their return: it stores a verdict someone
   * else already made, the way the export history stores "already exported".
   * The line it must not cross is forming an opinion of its own, so what is
   * checked below is the absence of every control that would let it. */
  console.log('\n--- the removed sections are really gone ---');
  const bar = document.querySelector('.nav').textContent;
  check('no Clients tab', /client/i.test(bar), false);
  check('no client editor in the page', !!$('clientList'), false);
  check('no resume pane', !!$('resumeList'), false);
  check('no saved-search pane', !!$('searchList'), false);
  check('no vetting pacing fields', !!$('vBatchSize'), false);
  check('no fit-scoring toggle', !!$('cScoreJobs'), false);

  console.log('\n--- vetting feedback remembers, it does not judge ---');
  const vetSheet = sheets().find((e) => e.dataset.section === 'vetting');
  const vetText = vetSheet.textContent;
  check('it offers no score or rank control', /\bscore|\brank/i.test(vetText), false);
  check('no criteria field to judge against', !!$('vCriteria'), false);
  check('no fit threshold', !!$('vMinScore'), false);
  check('it says the call was the user\'s', /forms no opinion of its own/i.test(vetText), true);

  console.log('\n--- the collection form round-trips through the config ---');

  API.showSection('collection');
  check('delay loaded from the worker', $('cDelay').value, '1200');
  check('max pages loaded', $('cMaxPages').value, '5');
  check('clearBefore loaded', $('cClearBefore').checked, true);
  check('the stored prompt loaded, not the built-in', $('xPrompt').value, 'STORED PROMPT');

  $('cDelay').value = '2500';
  $('cMaxPages').value = '2';
  $('cSkipSeen').checked = true;
  const built = API.formToConfig();
  check('the form reads back', [built.delayMs, built.maxPages, built.skipSeen], [2500, 2, true]);
  check('and carries the prompt with it', built.promptTemplate, 'STORED PROMPT');

  /* Empty and zero are different answers, and Number('') gives 0. */
  $('cJitter').value = '';
  check('a cleared field falls back to its default', API.formToConfig().jitterMs, 500);
  $('cJitter').value = '0';
  check('an explicit zero is kept', API.formToConfig().jitterMs, 0);
  $('cMaxJobs').value = '';
  check('and the same for a limit field', API.formToConfig().maxJobs, 0);
  $('cDelay').value = '0';
  check('a zero per-job delay is floored, never 0ms', API.formToConfig().delayMs, 200);
  $('cDelay').value = '2500';
  $('cJitter').value = '500';

  console.log('\n--- config is saved through the worker, never written direct ---');

  SENT.length = 0;
  $('cDelay').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await settleSaved();

  const setCalls = SENT.filter((m) => m.type === 'JDC_SET_CONFIG');
  check('a set went to the worker', setCalls.length > 0, true);
  check('with the edited value', setCalls[setCalls.length - 1].config.delayMs, 2500);
  check('the worker merged it', CONFIG_STORE.delayMs, 2500);
  check('and fields it did not send survived', CONFIG_STORE.longPauseMs, 6000);
  check('jdc_config was not written directly', STORE.jdc_config, undefined);

  console.log('\n--- the prompt ---');
  $('btnResetPrompt').click();
  await settleSaved();
  check('reset restores the built-in', $('xPrompt').value, API.BUILTIN_PROMPT);
  check('and it says so', /unchanged from the built-in/.test($('promptInfo').textContent), true);

  /* The built-in prompt must not smuggle a client profile back in. */
  check('the built-in prompt names no client', /client/i.test(API.BUILTIN_PROMPT), false);
  check('and asks for no fit verdict', /\bFIT\b|Strong|Possible/.test(API.BUILTIN_PROMPT), false);

  $('xPrompt').value = 'edited by hand';
  $('xPrompt').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('an edit is reported as such', /edited/.test($('promptInfo').textContent), true);

  console.log('\n--- diagnostics ---');

  API.showSection('diagnostics');
  $('btnDiagJob').click();
  await settle();
  check('the job report is shown', $('diagOut').textContent, 'JOB PAGE REPORT');

  /* The hiring.cafe probe reads the panel's search fields, which are the only
   * criteria there are now. */
  STORE.jdc_search = { sKeywords: 'clinical research associate', sLocation: 'United States' };
  $('btnDiagHc').click();
  await settle();
  check('the probe used the panel search',
    $('diagOut').textContent, 'HC PROBE for clinical research associate');

  STORE.jdc_search = { sKeywords: '' };
  $('diagOut').textContent = 'UNCHANGED';
  $('btnDiagHc').click();
  await settle();
  check('with no keywords it refuses', $('diagOut').textContent, 'UNCHANGED');
  check('and says why', /keywords/.test($('banner').textContent), true);

  $('btnDiagCopy').click();
  await settle();
  check('copy takes the report text', copied, 'UNCHANGED');

  console.log('\n--- AI assist ---');

  API.showSection('ai');
  const aiSheet = sheets().find((e) => e.dataset.section === 'ai');

  /* Off and keyless until asked for: this is the only part of the extension
   * that talks to a third party. */
  check('it is off by default', $('aEnabled').checked, false);
  /* A LIST, not one model: free endpoints are rate limited hard enough that a
   * single one is a single point of failure for the whole assist. */
  check('the model list defaults to three free ones',
    $('aModels').value.split('\n').length, 3);
  check('with MiniMax first',
    $('aModels').value.split('\n')[0], 'minimax/minimax-m2.7:free');
  check('and Nemotron Ultra among them',
    /nemotron-3-ultra/.test($('aModels').value), true);
  check('the key field does not display the key', $('aKey').type, 'password');
  check('the section says what leaves the browser',
    /structural outline of the page/i.test(aiSheet.textContent), true);
  check('and that job descriptions do not',
    /descriptions are not included/i.test(aiSheet.textContent), true);
  check('it promises no judgement of jobs',
    /never asked what a job says/i.test(aiSheet.textContent), true);

  /* Without a key there is nothing to send, so the probe must not pretend. */
  $('aiOut').textContent = 'UNCHANGED';
  $('btnAiProbe').click();
  await settle();
  check('with no key the probe refuses', $('aiOut').textContent, 'UNCHANGED');
  check('and says why', /API key/i.test($('banner').textContent), true);

  $('aEnabled').checked = true;
  $('aKey').value = ' k-test\n';
  $('aEnabled').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settleSaved();
  check('enabling it saves through the worker', CONFIG_STORE.aiEnabled, true);
  /* A key pasted with a trailing newline authenticates as nothing and reports
   * only "401", which is a miserable thing to debug. */
  check('and the key is stored trimmed', CONFIG_STORE.aiApiKey, 'k-test');

  $('btnAiProbe').click();
  await settle();
  check('with a key the probe runs and shows its report',
    $('aiOut').textContent, 'AI PROBE REPORT');

  $('btnAiTest').click();
  await settle();
  /* One row per model. The useful answer is which of them work, not whether
   * the first one does - the whole point of a list is surviving one endpoint
   * being rate limited. */
  const testOut = $('aiOut').textContent;
  check('the connection test reports one row per model', testOut.split('\n').length, 3);
  check('the working ones are marked OK',
    /OK\s+minimax\/minimax-m2\.7:free/.test(testOut), true);
  check('and a rate-limited one carries its reason',
    /FAIL\s+z-ai\/glm-5\.2:free\s+Rate limited/.test(testOut), true);

  $('btnAiRefresh').click();
  await settle();
  check('a remembered plan is listed by page path',
    /\/jobs\/search-results\//.test($('aiPlans').textContent), true);
  check('with the fields it resolved',
    /list, card/.test($('aiPlans').textContent), true);

  console.log('\n--- the log renders records, not [object Object] ---');
  STORE.jdc_log = [
    { t: Date.UTC(2026, 0, 1, 12, 0, 0), line: 'Page 1: 25 cards.' },
    { t: Date.UTC(2026, 0, 1, 12, 0, 5), line: 'Collected 4266001.' }
  ];
  await API.refreshLog();
  check('no object stringification', /object Object/.test($('logOut').textContent), false);
  check('both lines present', $('logOut').textContent.split('\n').length, 2);
  check('the message survived', /Page 1: 25 cards\./.test($('logOut').textContent), true);

  STORE.jdc_log = [];
  await API.refreshLog();
  check('an empty log says so', $('logOut').textContent, '(nothing logged yet)');
  delete STORE.jdc_log;
  await API.refreshLog();
  check('a missing log says so too', $('logOut').textContent, '(nothing logged yet)');

  console.log('\n--- an external change refreshes the form ---');
  check('a listener was registered', changeListeners.length > 0, true);

  CONFIG_STORE = Object.assign({}, CONFIG_STORE, { maxJobs: 99 });
  changeListeners.forEach(function (fn) {
    fn({ jdc_config: { newValue: CONFIG_STORE } }, 'local');
  });
  await settleSaved();
  check('the collection form picked it up', $('cMaxJobs').value, '99');

  changeListeners.forEach(function (fn) { fn({ something_else: {} }, 'sync'); });
  await settle();
  check('an unrelated area is ignored', $('cMaxJobs').value, '99');

  console.log('\n--- an external change during a pending save is queued, not dropped ---');

  /* This is the actual race: an external write lands WHILE this window's own
   * debounce is still running. The old code checked `!cfgTimer` at the moment
   * the event arrived and, finding it truthy, threw the change away forever -
   * no later event was ever going to retry it. */
  API.showSection('collection');
  const beforeExternal = Object.assign({}, CONFIG_STORE);

  $('cJitter').value = '750';
  $('cJitter').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  // The debounce is now running; this window's own edit has not been sent yet.

  const afterExternal = Object.assign({}, beforeExternal, { maxPages: 8 });
  CONFIG_STORE = afterExternal;
  changeListeners.forEach(function (fn) {
    fn({ jdc_config: { oldValue: beforeExternal, newValue: afterExternal } }, 'local');
  });

  check('the field being edited keeps its typed value, not clobbered mid-debounce',
    $('cJitter').value, '750');
  check('the external change is not applied yet either',
    $('cMaxPages').value, String(beforeExternal.maxPages));

  await settleSaved();

  check('the edit that was pending went through once the debounce cleared',
    $('cJitter').value, '750');
  check('and the external change was replayed afterward, not dropped',
    $('cMaxPages').value, '8');

  console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
})().catch(function (e) {
  console.log('  FAIL  the suite threw: ' + (e && e.stack || e));
  process.exit(1);
});
