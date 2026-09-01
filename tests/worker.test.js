/* Boots src/background.js the way Chrome boots a service worker.
 *
 * Two load-time failures shipped before this existed, and neither was
 * detectable by the rest of the suite: a wrong importScripts path, and an
 * import statement spliced inside the file's opening comment block. Both took
 * the WHOLE extension down - the worker never registered, so collection,
 * vetting, the panel and the manager were all dead at once.
 *
 * `node --check` cannot catch either: the first is a runtime resolution
 * failure, and the second was still syntactically valid JavaScript for a while.
 * So this suite does what Chrome does - provides a worker-shaped global scope,
 * evaluates the file, and asserts the worker actually came up. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

/* ---------- a worker-shaped global ---------- */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const swRel = manifest.background.service_worker;
const swDir = path.posix.dirname(swRel);

const listeners = { message: [], removed: [], activated: [], updated: [] };
const STORE = {};

/* A stand-in for hiringcafe.com. Serves one search page and one description
 * per job, and records every URL asked for. */
const FETCHED = [];
let SERVE = null;

function jsonResponse(obj) {
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify(obj)),
    json: () => Promise.resolve(obj)
  });
}
function htmlResponse(html) {
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(html),
    json: () => Promise.reject(new Error('not json'))
  });
}
const imported = [];
let importError = null;

const chrome = {
  runtime: {
    lastError: null,
    getURL: (p) => 'chrome-extension://test/' + String(p).replace(/^\//, ''),
    sendMessage: () => Promise.resolve({}),
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} }
  },
  storage: {
    local: {
      get: (k) => {
        const out = {};
        (Array.isArray(k) ? k : [k]).forEach(function (key) {
          if (STORE[key] !== undefined) out[key] = STORE[key];
        });
        return Promise.resolve(out);
      },
      set: (o) => { Object.assign(STORE, o); return Promise.resolve(); },
      remove: () => Promise.resolve()
    },
    onChanged: { addListener: () => {} }
  },
  tabs: {
    query: () => Promise.resolve([]),
    sendMessage: () => Promise.resolve({}),
    update: () => Promise.resolve(),
    create: () => Promise.resolve({ id: 1 }),
    remove: () => Promise.resolve(),
    onCreated: { addListener: () => {} },
    onActivated: { addListener: (fn) => listeners.activated.push(fn) },
    onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    onRemoved: { addListener: () => {} }
  },
  windows: {
    create: () => Promise.resolve({ id: 9 }),
    get: () => Promise.resolve({ id: 9 }),
    getCurrent: () => Promise.resolve({ id: 9, width: 1600, height: 1000 }),
    update: () => Promise.resolve(),
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) }
  },
  scripting: { executeScript: () => Promise.resolve([]) },
  action: { onClicked: { addListener: () => {} }, setTitle: () => Promise.resolve() },
  sidePanel: {
    setPanelBehavior: () => Promise.resolve(),
    setOptions: () => Promise.resolve(),
    open: () => Promise.resolve()
  },
  downloads: { download: () => {} },
  permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
};

const sandbox = {
  chrome: chrome,
  console: console,
  fetch: function (url, opts) {
    FETCHED.push(String(url));
    if (SERVE) return SERVE(String(url), opts || {});
    return Promise.reject(new Error('no network in this test'));
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  URL: URL,
  URLSearchParams: URLSearchParams,
  /* Real service workers have these; the AI assist call uses them to time out. */
  AbortController: AbortController,
  AbortSignal: AbortSignal,
  TextDecoder: TextDecoder,
  TextEncoder: TextEncoder,
  Blob: typeof Blob !== 'undefined' ? Blob : function () {},
  Date: Date,
  Math: Math,
  JSON: JSON
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

/* Chrome resolves importScripts against the importing script's own URL; a
 * leading slash means the extension root. Reimplemented exactly, because
 * getting this wrong is what broke the extension. */
sandbox.importScripts = function () {
  for (let i = 0; i < arguments.length; i++) {
    const spec = String(arguments[i]);
    const rel = spec.startsWith('/')
      ? spec.slice(1)
      : path.posix.normalize(path.posix.join(swDir, spec));
    imported.push({ spec: spec, resolved: rel });

    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error("NetworkError: The script at '" + rel + "' failed to load.");
    }
    vm.runInContext(fs.readFileSync(abs, 'utf8'), context, { filename: rel });
  }
};

const context = vm.createContext(sandbox);

/* ---------- boot it ---------- */

console.log('--- the service worker registers ---');

let booted = false;
try {
  vm.runInContext(fs.readFileSync(path.join(ROOT, swRel), 'utf8'), context, { filename: swRel });
  booted = true;
} catch (e) {
  importError = e;
}

check('background.js evaluated without throwing', booted, true);
if (importError) console.log('          ' + importError.message);

check('importScripts was called', imported.length > 0, true);
imported.forEach(function (i) {
  check('  ' + JSON.stringify(i.spec) + ' resolved to ' + i.resolved,
    fs.existsSync(path.join(ROOT, i.resolved)), true);
});

/* This is the exact failure that was reported: src/src/lib/... */
check('nothing resolved to a doubled directory',
  imported.filter(function (i) { return /(^|\/)src\/src\//.test(i.resolved); }), []);

console.log('\n--- the worker set itself up ---');
check('a message listener was registered', listeners.message.length > 0, true);
check('the adapter reached the worker scope', typeof sandbox.JDC_HIRINGCAFE, 'object');
check('and it is usable from there',
  typeof sandbox.JDC_HIRINGCAFE.buildSearchState, 'function');
check('a window-closed listener was registered', listeners.removed.length > 0, true);

console.log('\n--- the worker answers messages ---');

function send(msg) {
  return new Promise(function (resolve) {
    let answered = false;
    const done = function (res) { answered = true; resolve(res); };
    const kept = listeners.message[0](msg, {}, done);
    /* The dispatcher returns true to keep the channel open for async work. */
    if (!kept && !answered) resolve(undefined);
    setTimeout(function () { if (!answered) resolve({ __timeout: true }); }, 400);
  });
}

(async function () {
  const unknown = await send({ type: 'JDC_NOT_A_REAL_MESSAGE' });
  check('an unknown type is refused, not ignored',
    unknown && unknown.ok === false, true);

  const stop = await send({ type: 'JDC_HC_STOP' });
  check('the hiringcafe stop handler answers', stop && stop.ok, true);

  /* Starting a run is fire-and-forget by design; it must answer immediately
   * rather than blocking the panel for the length of a collect. */
  const start = await send({ type: 'JDC_HC_COLLECT', search: { keywords: 'cra', location: 'United States' } });
  check('the collect handler answers immediately', start && start.ok, true);
  check('and reports that it started', start && start.started, true);

  console.log('\n--- a real collect run, against a stubbed hiringcafe ---');

  /* Three hits with the MIDDLE one expired. That is the shape that broke:
   * descriptions used to be paired by position against a list the expired row
   * had already been filtered out of, so job 3 got job 2's description. */
  const hit = function (n, expired) {
    return {
      id: 'src___board___' + n,
      objectID: 'src___board___' + n,
      source: 'greenhouse',
      board_token: 'board',
      apply_url: 'https://employer.example/jobs/' + n,
      is_expired: !!expired,
      job_information: { title: 'CRA ' + n },
      v5_processed_job_data: {
        company_name: 'Company ' + n,
        workplace_type: 'Remote',
        formatted_workplace_location: 'Boston, Massachusetts, United States',
        requirements_summary: 'Summary for job ' + n,
        yearly_min_compensation: 100000,
        yearly_max_compensation: 120000,
        listed_compensation_currency: 'USD'
      }
    };
  };

  const pageHtml = '<html><body><script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: {
      ssrHits: [hit(1), hit(2, true), hit(3)],
      ssrPage: 0, ssrTotalCount: 3, ssrIsLastPage: true
    } } }) + '<\/script></body></html>';

  SERVE = function (url) {
    if (url.indexOf('/api/job-description') !== -1) {
      const id = decodeURIComponent(url.split('id=')[1]);
      const n = id.split('___').pop();
      return jsonResponse({ job: { job_information: {
        description: '<p>FULL TEXT FOR JOB ' + n + '</p>'
      } } });
    }
    return htmlResponse(pageHtml);
  };

  FETCHED.length = 0;
  await send({ type: 'JDC_HC_COLLECT', search: {
    keywords: 'clinical research associate', location: 'United States', remote: '2'
  } });

  /* The run is fire-and-forget; give it room to finish. */
  for (let i = 0; i < 60 && !(STORE.jdc_jobs && STORE.jdc_jobs.length); i++) {
    await new Promise(function (r) { setTimeout(r, 50); });
  }

  const saved = STORE.jdc_jobs || [];
  check('two live jobs were stored', saved.length, 2);
  check('the expired one was dropped',
    saved.map(function (j) { return j.title; }), ['CRA 1', 'CRA 3']);

  /* The whole point of the fix. */
  const byTitle = {};
  saved.forEach(function (j) { byTitle[j.title] = j; });
  check('CRA 1 got ITS OWN description',
    /FULL TEXT FOR JOB 1/.test(byTitle['CRA 1'].description), true);
  check('CRA 3 got ITS OWN description, not the expired row\'s neighbour',
    /FULL TEXT FOR JOB 3/.test(byTitle['CRA 3'].description), true);
  check('and no crossover', /FULL TEXT FOR JOB 2/.test(JSON.stringify(saved)), false);

  check('no description was fetched for the expired job',
    FETCHED.filter(function (u) { return u.indexOf('___2') !== -1; }), []);
  check('the description source is recorded as full',
    byTitle['CRA 1'].descriptionSource, 'hiringcafe:full');
  check('structured pay came through', byTitle['CRA 1'].payMinAnnual, 100000);
  check('the apply url came through',
    byTitle['CRA 3'].applyUrl, 'https://employer.example/jobs/3');

  console.log('\n--- a failed search reports rather than hanging ---');
  STORE.jdc_jobs = [];
  SERVE = function () {
    return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve(''), json: () => Promise.resolve({}) });
  };
  await send({ type: 'JDC_HC_COLLECT', search: { keywords: 'x', location: 'United States' } });
  for (let i = 0; i < 40; i++) {
    await new Promise(function (r) { setTimeout(r, 50); });
    if (STORE.jdc_state && STORE.jdc_state.active === false) break;
  }
  check('the run ended rather than hanging', STORE.jdc_state.active, false);
  check('and the failure is in the log',
    (STORE.jdc_log || []).some(function (l) { return /403/.test(l.line); }), true);

  console.log('\n--- AI assist: the worker side of it ---');

  /* The only part of this extension that talks to a third party, so what it
   * sends, when it refuses to send anything, and what it does with a bad
   * answer all matter more than the happy path. */

  const AI_URL = 'https://openrouter.ai/api/v1/chat/completions';
  let lastRequest = null;

  function aiReply(content) {
    return jsonResponse({
      model: 'minimax/minimax-m2.7:free',
      choices: [{ message: { content: content } }],
      usage: { prompt_tokens: 900, completion_tokens: 40 }
    });
  }

  SERVE = function (url, opts) {
    if (url.indexOf('openrouter.ai') === -1) return htmlResponse('');
    lastRequest = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return aiReply('{"list":"ul.a5b65bc4","card":"li._2e9433c3","description":"div._jd"}');
  };

  /* Off by default: a run must not reach OpenRouter because a key happens to
   * be sitting in storage. */
  STORE.jdc_config = { aiEnabled: false, aiApiKey: 'k-test' };
  FETCHED.length = 0;
  const offRes = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/search-results/', digest: 'outline' });
  check('with AI assist off, nothing is asked', offRes.ok, false);
  check('and nothing was sent', FETCHED.filter(function (u) { return u.indexOf('openrouter') !== -1; }), []);

  STORE.jdc_config = { aiEnabled: true, aiApiKey: 'k-test', aiModel: 'minimax/minimax-m2.7:free' };
  STORE.jdc_ai_plans = {};

  const test = await send({ type: 'JDC_AI_TEST' });
  check('the connection test answers', test.ok, true);
  check('and reports the model that replied', test.model, 'minimax/minimax-m2.7:free');
  /* Asking for one word AND for JSON at once is a contradiction the model
   * resolves by ignoring one of them, so the ping opts out of JSON mode. */
  check('the ping does not ask for JSON', lastRequest.body.response_format, undefined);

  FETCHED.length = 0;
  const res = await send({
    type: 'JDC_AI_RESOLVE', path: '/jobs/search-results/', digest: 'OUTLINE-GOES-HERE', reason: 'no cards'
  });
  check('a resolve returns a plan', res.ok, true);
  check('parsed into selectors', res.plan,
    { list: 'ul.a5b65bc4', card: 'li._2e9433c3', description: 'div._jd' });
  check('it went to OpenRouter', lastRequest.url, AI_URL);
  check('with the key in the Authorization header',
    lastRequest.opts.headers.Authorization, 'Bearer k-test');
  check('and the configured model', lastRequest.body.model, 'minimax/minimax-m2.7:free');
  check('a resolve does ask for JSON', lastRequest.body.response_format, { type: 'json_object' });
  check('the page outline is what was sent',
    /OUTLINE-GOES-HERE/.test(JSON.stringify(lastRequest.body.messages)), true);
  check('and the reason it was asked for',
    /no cards/.test(JSON.stringify(lastRequest.body.messages)), true);

  /* Cached per page path: a surface resolved once costs nothing afterwards,
   * which is what makes a free-tier model workable here at all. */
  check('the plan is remembered for that page',
    Object.keys(STORE.jdc_ai_plans), ['/jobs/search-results/']);

  FETCHED.length = 0;
  const again = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/search-results/', digest: 'OUTLINE-GOES-HERE' });
  check('asking again returns the remembered plan', [again.ok, again.cached], [true, true]);
  check('without calling the model', FETCHED, []);

  const cachedOnly = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/other/', cachedOnly: true });
  check('a cache-only ask for an unknown page just says no', cachedOnly.ok, false);
  check('and still calls nothing', FETCHED, []);

  /* A model that answers with prose must not take a run down with it. */
  SERVE = function (url, opts) {
    lastRequest = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return aiReply('I had a look but I could not work out this layout.');
  };
  const junk = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/junk/', digest: 'x', force: true });
  check('an unusable answer is reported, not thrown', junk.ok, false);
  check('and the raw reply comes back so it can be read',
    /could not work out/.test(junk.raw), true);
  check('nothing was cached from it', STORE.jdc_ai_plans['/jobs/junk/'], undefined);

  /* Each failure a key can produce says what to fix. */
  SERVE = function () {
    return Promise.resolve({
      ok: false, status: 401,
      text: () => Promise.resolve('{"error":{"message":"No auth credentials found"}}'),
      json: () => Promise.resolve({})
    });
  };
  const unauth = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/x/', digest: 'x', force: true });
  check('a rejected key says so plainly', /rejected the API key/.test(unauth.error), true);

  SERVE = function () {
    return Promise.resolve({
      ok: false, status: 429,
      text: () => Promise.resolve('{"error":{"message":"rate limited"}}'),
      json: () => Promise.resolve({})
    });
  };
  const limited = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/x/', digest: 'x', force: true });
  check('and a rate limit names the free tier', /Rate limited/.test(limited.error), true);

  console.log('\n--- more than one model, tried in order ---');

  /* Free endpoints are rate limited to a few calls a minute, so one model is
   * one bad minute away from a run with no assist at all. */
  STORE.jdc_config = {
    aiEnabled: true,
    aiApiKey: 'k-test',
    aiModels: 'minimax/minimax-m2.7:free\nnvidia/nemotron-3-ultra-550b-a55b:free\nz-ai/glm-5.2:free'
  };
  STORE.jdc_ai_plans = {};

  const asked = [];
  const rateLimited = function () {
    return Promise.resolve({
      ok: false, status: 429,
      text: () => Promise.resolve('{"error":{"message":"rate limited"}}'),
      json: () => Promise.resolve({})
    });
  };

  SERVE = function (url, opts) {
    const body = JSON.parse(opts.body);
    asked.push(body.model);
    if (body.model === 'minimax/minimax-m2.7:free') return rateLimited();
    return aiReply('{"list":"ul.x","card":"li.y","description":"div.jd"}');
  };

  const failover = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/a/', digest: 'x', force: true });
  check('a rate-limited first model does not end it', failover.ok, true);
  check('the second model answered', failover.model, 'minimax/minimax-m2.7:free');
  check('both were asked, in order', asked,
    ['minimax/minimax-m2.7:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']);
  check('and the plan came through', failover.plan.card, 'li.y');
  check('the fallback is in the log',
    (STORE.jdc_log || []).some(function (l) { return /Trying nvidia/.test(l.line); }), true);

  /* A model that answers with prose has failed as surely as one that timed
   * out - the next one deserves its turn. */
  asked.length = 0;
  SERVE = function (url, opts) {
    const body = JSON.parse(opts.body);
    asked.push(body.model);
    if (body.model === 'minimax/minimax-m2.7:free') {
      return aiReply('I had a look but could not work out this layout.');
    }
    return aiReply('{"list":"ul.z","card":"li.z","description":"div.z"}');
  };
  const unusable = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/b/', digest: 'x', force: true });
  check('an unusable reply hands over to the next model', unusable.ok, true);
  check('which was asked', asked.length, 2);
  check('and its plan is the one kept', unusable.plan.card, 'li.z');

  /* A bad key is bad for every model on the account: retrying is just three
   * requests to be told the same thing. */
  asked.length = 0;
  SERVE = function (url, opts) {
    asked.push(JSON.parse(opts.body).model);
    return Promise.resolve({
      ok: false, status: 401,
      text: () => Promise.resolve('{"error":{"message":"No auth credentials found"}}'),
      json: () => Promise.resolve({})
    });
  };
  const badKey = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/c/', digest: 'x', force: true });
  check('a rejected key stops at the first model', asked.length, 1);
  check('and says so', /rejected the API key/.test(badKey.error), true);

  /* Every model down is reported as every model down, by name. */
  asked.length = 0;
  SERVE = function (url, opts) { asked.push(JSON.parse(opts.body).model); return rateLimited(); };
  const allDown = await send({ type: 'JDC_AI_RESOLVE', path: '/jobs/d/', digest: 'x', force: true });
  check('all three were tried', asked.length, 3);
  check('the failure names them', /every configured model failed/.test(allDown.error), true);
  check('with the reason for each', /glm-5\.2:free \(Rate limited/.test(allDown.error), true);

  console.log('\n--- the connection test reports every model ---');
  SERVE = function (url, opts) {
    const body = JSON.parse(opts.body);
    if (body.model === 'z-ai/glm-5.2:free') return rateLimited();
    return aiReply('OK');
  };
  const probe = await send({ type: 'JDC_AI_TEST' });
  check('it answers ok while any model works', probe.ok, true);
  check('one row per model', probe.results.length, 3);
  check('the working ones are marked', probe.results.map(function (r) { return r.ok; }),
    [true, true, false]);
  check('and the failing one carries its reason',
    /Rate limited/.test(probe.results[2].detail), true);

  SERVE = null;
  console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
})();
