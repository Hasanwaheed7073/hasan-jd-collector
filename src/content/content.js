/* JD Collector - the driver that walks the search results and pulls each JD.
 *
 * Runs entirely in the page so it behaves like a human clicking through the
 * list: no private API calls, and the collected data never leaves the browser.
 * Progress is persisted after every job, so a full page reload (which LinkedIn
 * sometimes forces on pagination) resumes instead of restarting.
 */

(function () {
  /* Bumped whenever this file changes in a way worth telling apart in a log.
   *
   * Reloading the extension does NOT replace a content script already running
   * in an open tab, and the old "have I loaded?" flag was a bare `true`, so a
   * fresh injection saw it and returned - leaving the tab running yesterday's
   * code with no way to tell from the outside. Keying the guard on the build
   * fixes that, and reporting it in the log settles "is the fix even running"
   * in one line instead of an afternoon. */
  const BUILD = '2026-09-01.7-apply-pagination';
  if (window.__JDC_CONTENT_LOADED__ === BUILD) return;
  window.__JDC_CONTENT_LOADED__ = BUILD;

  const S = window.JDC_SEL.SEL;
  const q = window.JDC_SEL.q;
  const qa = window.JDC_SEL.qa;
  const EX = window.JDC_EX;

  const PROCESSED_KEY = 'jdc_processed';
  const PAGE_SIZE = 25;

  let running = false;
  let aborted = false;
  let stopRequested = false;
  let usedGenericFallback = false;
  let config = null;
  let processed = new Set();

  /* ---------- small utilities ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  const log = (line) => send({ type: 'JDC_LOG', line: line });
  const progress = (patch) => send({ type: 'JDC_PROGRESS', patch: patch });

  async function waitFor(fn, timeoutMs, stepMs) {
    const deadline = Date.now() + (timeoutMs || 12000);
    const step = stepMs || 60;
    while (Date.now() < deadline) {
      if (aborted) return false;
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return true;
      await sleep(step);
    }
    return false;
  }

  function jitter() {
    const base = Math.max(150, Number(config.delayMs) || 0);
    const j = Math.max(0, Number(config.jitterMs) || 0);
    // Deterministic randomness is not needed here; human-ish spacing is.
    return base + Math.floor(Math.random() * (j + 1));
  }

  /* ---------- URL helpers ---------- */

  function currentStart() {
    const v = new URL(location.href).searchParams.get('start');
    const n = parseInt(v || '0', 10);
    return isNaN(n) ? 0 : n;
  }

  function currentPageNumber() {
    return Math.floor(currentStart() / PAGE_SIZE) + 1;
  }

  /* The extension is injected across linkedin.com so it can diagnose any
   * surface, but collection must only ever run under /jobs/. */
  function onJobsPath() {
    return /^\/jobs(\/|$)/.test(location.pathname);
  }

  function currentJobIdFromUrl() {
    const u = new URL(location.href);
    const p = u.searchParams.get('currentJobId');
    if (p) return p;
    const m = /\/jobs\/view\/(\d+)/.exec(u.pathname);
    return m ? m[1] : null;
  }

  /* ---------- the job list ---------- */

  function getCards() {
    const list = q(S.list);
    const raw = list ? qa(S.card, list) : qa(S.card);
    const cards = raw.filter((c) => cardJobId(c));
    if (cards.length) return cards;

    /* A LEARNED card selector that matches cards carrying no id of their own is
     * still the best answer available: those get their id from the URL after
     * the click, which is the by-position path further down. The same is not
     * assumed of the hand-written selectors - one of those matching id-less
     * elements is far more likely to be a misfire than a discovery. */
    if (raw.length >= 3 && window.JDC_SEL.learned('card')) {
      usedGenericFallback = true;
      return raw;
    }

    /* Nothing matched the known layouts. Infer the list from the job links
     * themselves so a redesign - or a surface like the AI job search - still
     * collects instead of silently returning zero. */
    const generic = window.JDC_SEL.genericCards();
    if (generic.length) usedGenericFallback = true;
    return generic;
  }

  /* Delegates to the shared id reader so this understands every form the
   * selector layer does. It previously knew only /jobs/view/ hrefs and data
   * attributes, so on a surface whose cards link via ?currentJobId= it reported
   * "no job id" for a list that was in fact fully identified. */
  function cardJobId(card) {
    if (!card) return null;

    const own = window.JDC_SEL.jobIdFromAttrs(card);
    if (own) return own;

    const inner = card.querySelector(window.JDC_SEL.JOB_CANDIDATE_SELECTOR);
    if (inner) {
      const id = window.JDC_SEL.jobIdFromAttrs(inner);
      if (id) return id;
    }
    return null;
  }

  /* The list virtualises aggressively: a card element captured a minute ago may
   * have been recycled out of the DOM by the time we reach it. Always re-find
   * the card by job id at click time rather than holding element references. */
  function findCardById(id) {
    const direct = document.querySelector('li[data-occludable-job-id="' + id + '"]');
    if (direct) return direct;

    const byJob = document.querySelector('[data-job-id="' + id + '"]');
    if (byJob) return byJob.closest('li') || byJob;

    // Both link forms: the classic /jobs/view/ path and the ?currentJobId= query.
    const a = document.querySelector(
      'a[href*="/jobs/view/' + id + '"], a[href*="currentJobId=' + id + '"]');
    if (a) return a.closest('li') || a.closest('div.job-card-container') || a.parentElement || a;

    return null;
  }

  async function findCardScrolling(id) {
    let card = findCardById(id);
    if (card) return card;

    // Recycled out of the DOM: walk the rail until it renders again.
    const list = q(S.list);
    const scroller = list ? (scrollParent(list) || document.scrollingElement) : document.scrollingElement;

    for (let i = 0; i < 12 && !card; i++) {
      if (scroller === document.scrollingElement) window.scrollBy(0, Math.round(window.innerHeight * 0.7));
      else scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.7, scroller.scrollHeight);
      await sleep(200);
      card = findCardById(id);
    }
    return card;
  }

  function scrollParent(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /* The left rail lazy-renders cards as you scroll. Scroll it to the bottom
   * until the card count stops growing so a page yields all ~25 jobs. */
  async function loadWholeList() {
    /* Wait for the count to settle, not merely to become non-zero.
     *
     * These lists stream in: stopping at the first card meant collecting 1 of
     * 25 and paginating away from the rest, which is what "Page 1: 1 cards"
     * followed by "Page 1: 5 cards" in the same run was showing. */
    let seen = -1;
    let steady = 0;
    const settleBy = Date.now() + 15000;
    while (Date.now() < settleBy && steady < 3) {
      if (aborted) break;
      const n = getCards().length;
      if (n > 0 && n === seen) steady++; else steady = 0;
      seen = n;
      await sleep(400);
    }

    const list = q(S.list);
    const scroller = list
      ? (scrollParent(list) || document.scrollingElement)
      : (scrollParent(getCards()[0]) || document.scrollingElement);
    let last = -1;
    let stable = 0;

    for (let i = 0; i < 40 && stable < 3; i++) {
      if (aborted) break;
      const count = getCards().length;
      if (count === last) stable++; else stable = 0;
      last = count;

      if (scroller === document.scrollingElement) {
        window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      } else {
        scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.85, scroller.scrollHeight);
      }
      await sleep(220);
    }

    // Put the rail back at the top so clicking cards is predictable.
    if (scroller === document.scrollingElement) window.scrollTo(0, 0);
    else scroller.scrollTop = 0;
    await sleep(200);

    return getCards();
  }

  /* ---------- opening one job ---------- */

  /* A fingerprint of whatever the details pane is currently showing. Used to
   * detect that the pane actually changed, for surfaces that do not update the
   * URL when you pick a job. */
  function paneSignature() {
    const t = EX.text(EX.titleEl());
    const d = EX.descriptionEl();
    const body = d ? (d.textContent || '').replace(/\s+/g, ' ').trim() : '';
    /* Length and tail as well as head. Two postings for the same role at the
     * same company - LinkedIn is full of them - can share their first 140
     * characters exactly, and a signature that cannot tell those apart reads a
     * real pane swap as "nothing happened". */
    return t + '|' + body.length + '|' + body.slice(0, 140) + '|' + body.slice(-80);
  }

  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /* Confirming the details pane is now showing the job we clicked.
   *
   * The URL used to settle this on its own, and it is the weakest of the three
   * signals: LinkedIn's AI job search rewrites currentJobId the instant you
   * click, whether or not the pane behind it has re-rendered. A real run got
   * five consecutive jobs whose captured description was byte-identical -
   * every one of them "confirmed" by a URL that had moved on ahead of the
   * page. A URL is a claim about what should be showing; the pane is the
   * evidence of what is.
   *
   * So: the pane having CHANGED is proof on its own. An unchanged pane is only
   * accepted when it was already showing this very job - which the card's own
   * title, not the URL, is what establishes. */
  function paneShowsJob(jobId, before, cardTitle) {
    const desc = EX.descriptionEl();
    const titleEl = EX.titleEl();
    if (!desc || !titleEl) return false;
    if ((desc.textContent || '').trim().length <= 120) return false;

    if (paneSignature() !== before) return true;                // it re-rendered

    /* Unchanged. The first card of a page is often already open, so this is
     * normal - but it has to be THIS job, and the card's own title is what
     * establishes that. The URL only ever gets a veto here: if it names a
     * different job the pane is stale, and if it names none at all (surfaces
     * that never rewrite it) there is nothing for it to say either way. */
    const paneTitle = normTitle(EX.text(titleEl));
    const wanted = normTitle(cardTitle);
    const titleAgrees = !!(wanted && paneTitle &&
      (paneTitle.indexOf(wanted) !== -1 || wanted.indexOf(paneTitle) !== -1));

    const urlId = currentJobIdFromUrl();
    return titleAgrees && (!urlId || urlId === String(jobId));
  }

  /* ---------- never write one posting onto two jobs ----------
   *
   * The last line of defence behind the pane check, and the one that does not
   * depend on getting any heuristic right: two different job ids cannot have
   * the same description. When they do, the pane did not update and what we
   * are about to store is the previous job's posting under this job's id -
   * which is worse than collecting nothing, because nothing about the row says
   * so afterwards. */
  let seenDescriptions = new Map();

  function descKey(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length < 200) return '';        // too short to be distinctive
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h + ':' + s.length;
  }

  /* Returns the id this description was already stored under, or null. */
  function alreadyCollectedAs(job) {
    const key = descKey(job && job.description);
    if (!key) return null;
    const owner = seenDescriptions.get(key);
    if (owner && owner !== job.jobId) return owner;
    seenDescriptions.set(key, job.jobId);
    return null;
  }

  // Testing seam: exercised by tests/pane.test.js.
  window.__JDC_TEST = {
    paneShowsJob: paneShowsJob,
    paneSignature: paneSignature,
    normTitle: normTitle,
    candidateBlocks: function () { return candidateBlocks(); },
    changedBlock: function (before) { return changedBlock(before); },
    cssPath: function (el) { return cssPath(el); },
    relearnDescription: function (before) { return relearnDescription(before); },
    collectOneAiJob: function (A, id, meta) { return collectOneAiJob(A, id, meta); },
    traceOneAiJob: function () { return traceOneAiJob(); },
    aiLoadMoreControl: function (A) { return aiLoadMoreControl(A); },
    aiScrollForMore: function (A, seen) { return aiScrollForMore(A, seen); }
  };

  async function openCard(card, jobId, cardTitle) {
    const linkSel = S.cardLink.join(',');
    const before = paneSignature();

    /* The list is virtualised: a card can carry its job id while its contents
     * are still a placeholder. Scroll it into view and wait for the real link
     * to render, otherwise the click lands on nothing. */
    try { card.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { card.scrollIntoView(); }
    await waitFor(() => !!card.querySelector(linkSel), 3000);

    const target = card.querySelector(linkSel) || card;
    await sleep(80);
    target.click();

    const ok = await waitFor(function () {
      return paneShowsJob(jobId, before, cardTitle);
    }, 14000);

    if (!ok) return false;

    /* Expand a clipped description. The classic layout has a footer button;
     * the AI job search has an inline "… more" instead, and without catching
     * it the JD is captured cut off mid-sentence - usually losing exactly the
     * requirements half that the vetting depends on. */
    let more = q(S.showMore);
    if (!more || !/more/i.test(more.textContent || '')) {
      more = window.JDC_SEL.genericShowMore(EX.descriptionEl() || document);
    }
    if (more) {
      try { more.click(); await sleep(220); } catch (e) {}
    }
    return true;
  }

  /* The details pane renders its description lazily on this surface: the
   * header, the Apply button and the upsell cards paint immediately, and the
   * posting itself is a blank gap until that region is scrolled towards. A
   * collector that reads the pane the instant the header appears sees no
   * description at all and falls through to whatever else is dense on the
   * page - which is how the results rail kept winning.
   *
   * So nudge it. The pane is the tallest scrollable region that does not hold
   * the results list; scrolling it down is what a reader does anyway. */
  async function nudgePaneForLazyContent() {
    const listRoot = window.JDC_SEL.genericListRootAny();
    const nodes = document.querySelectorAll('div, section, main, article');
    let best = null;

    for (let i = 0; i < nodes.length && i < 3000; i++) {
      const el = nodes[i];
      if (listRoot && (el.contains(listRoot) || el === listRoot || listRoot.contains(el))) continue;
      if (el.scrollHeight <= el.clientHeight + 80) continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }

    if (best) {
      best.scrollTop = Math.min(best.scrollTop + best.clientHeight, best.scrollHeight);
    } else {
      window.scrollBy(0, Math.round(window.innerHeight * 0.6));
    }
    await sleep(500);
  }

  /* ---------- learning the description by watching what changes ----------
   *
   * The one thing that is true of a job description on every layout ever
   * shipped: it is the block that changes when you select a different job.
   * Class names, headings and text anchors are all guesses at where that block
   * is; this is a measurement of it.
   *
   * It exists because of a run where the click worked - the URL moved from
   * 4459259331 to 4459238201, so LinkedIn had genuinely switched jobs - and
   * the text we captured did not change at all. Every heuristic had settled on
   * a block that stays put, and no amount of reasoning about the markup was
   * going to reveal which one moves. Watching does.
   *
   * What it finds is learned as a selector for the rest of the run, through
   * the same slot the AI assist writes into. */

  function textHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  function candidateBlocks() {
    const listRoot = window.JDC_SEL.genericListRootAny();
    const out = new Map();
    const nodes = document.querySelectorAll('div, section, article, main');

    for (let i = 0; i < nodes.length && i < 4000; i++) {
      const el = nodes[i];
      if (listRoot && (el === listRoot || el.contains(listRoot) || listRoot.contains(el))) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 200) continue;
      out.set(el, t.length + ':' + textHash(t));
    }
    return out;
  }

  /* The block whose content actually changed.
   *
   * Every ancestor of a change also "changes", so the raw set always includes
   * the pane and its wrappers. The mutation itself is at the deepest changed
   * elements - the ones with no changed descendant - and the block we want is
   * the smallest thing containing all of them. With one changed leaf that is
   * the leaf; with a description split across several child blocks it is their
   * common parent, which is the description. */
  function changedBlock(before) {
    const after = candidateBlocks();
    const changed = [];

    after.forEach(function (sig, el) {
      const was = before.get(el);
      if (was === undefined || was === sig) return;
      changed.push(el);
    });
    if (!changed.length) return null;

    const leaves = changed.filter(function (el) {
      for (let i = 0; i < changed.length; i++) {
        if (changed[i] !== el && el.contains(changed[i])) return false;
      }
      return true;
    });
    if (leaves.length === 1) return leaves[0];

    const holdsAll = function (node) {
      for (let i = 0; i < leaves.length; i++) {
        if (!node.contains(leaves[i])) return false;
      }
      return true;
    };

    const listRoot = window.JDC_SEL.genericListRootAny();
    let node = leaves[0];
    while (node && node !== document.body && !holdsAll(node)) node = node.parentElement;

    /* Walking up far enough to swallow the results list means the changes were
     * scattered across the page rather than concentrated in a pane; the
     * largest single changed leaf is the better answer then. */
    if (!node || node === document.body ||
        (listRoot && (node.contains(listRoot) || node === listRoot))) {
      return leaves.sort(function (a, b) {
        return (b.textContent || '').length - (a.textContent || '').length;
      })[0];
    }
    return node;
  }

  /* A selector that addresses one element, built from whatever it carries.
   * Hashed class names are fine here: this is learned per run, and it is
   * re-checked against the page before anything uses it. */
  function cssPath(el) {
    const parts = [];
    let node = el;

    while (node && node.nodeType === 1 && node !== document.body && parts.length < 8) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      let sel = node.tagName.toLowerCase();
      const cls = (typeof node.className === 'string' ? node.className.trim().split(/\s+/) : [])
        .filter(function (c) { return /^[A-Za-z_-][\w-]*$/.test(c); })
        .slice(0, 2);

      if (cls.length) {
        sel += '.' + cls.join('.');
      } else if (node.parentElement) {
        sel += ':nth-child(' +
          (Array.prototype.indexOf.call(node.parentElement.children, node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /* Returns true if a new description element was learned. */
  async function relearnDescription(before) {
    const el = changedBlock(before);
    if (!el) return false;

    const current = EX.descriptionEl();
    if (current === el) return false;              // already reading the right one

    const path = cssPath(el);
    let matches = [];
    try { matches = Array.prototype.slice.call(document.querySelectorAll(path)); }
    catch (e) { matches = []; }
    if (matches[0] !== el) return false;           // the path does not address it

    const learned = window.JDC_SEL.learn('description', path);
    if (!learned.ok) return false;

    await log('The description was being read from a block that does not change ' +
      'between jobs. Watched what actually changed and switched to it: ' + path +
      ' (' + (el.textContent || '').trim().length.toLocaleString() + ' chars). ' +
      'Jobs collected before this line may carry the wrong description — worth ' +
      'clearing the results and running again.');
    return true;
  }

  /* ---------- AI assist ----------
   *
   * Only ever asked WHERE things are, never what they say. The model gets a
   * structural outline of the page (src/content/aiassist.js) and returns CSS
   * selectors; every one of them is checked against the live DOM before it is
   * used, and none can displace a hand-written selector that still matches.
   * Job facts continue to come out of the DOM through extract.js.
   *
   * It runs only when the page has already defeated the structural fallbacks,
   * and at most `aiMaxCalls` times per run, because the free tier is rate
   * limited and because a page that needs a third opinion needs a diagnostic
   * instead. */

  let assistCalls = 0;
  let cachedPlanApplied = false;

  function aiAvailable() {
    return !!(config && config.aiEnabled && window.JDC_AI && window.JDC_AIPLAN);
  }

  /* Said once per run, and only at a moment where the assist would have been
   * used. A capability that is switched off and never mentioned is, from the
   * outside, indistinguishable from one that does not work. */
  let assistOffAnnounced = false;

  async function announceAssistIsOff() {
    if (assistOffAnnounced || aiAvailable()) return;
    assistOffAnnounced = true;
    await log('AI assist is off, so nothing tried to resolve this page. ' +
      'Settings → AI assist: add an OpenRouter key, tick the box, then use ' +
      '"Resolve the open job page" on this tab.');
  }

  async function applyResolved(res, how) {
    const applied = window.JDC_AI.applyPlan(res.plan);
    await log('AI assist (' + how + '): ' + applied.summary + '.');
    return applied.accepted.length > 0;
  }

  /* A plan resolved on an earlier run for this same page. Costs no API call,
   * so it is tried before anything has gone wrong. */
  async function applyCachedPlan() {
    if (!aiAvailable()) return false;
    const res = await send({
      type: 'JDC_AI_RESOLVE', path: location.pathname, cachedOnly: true
    });
    if (!res || !res.ok || !res.plan) return false;
    cachedPlanApplied = true;
    return applyResolved(res, 'remembered from an earlier run');
  }

  async function maybeAssist(reason) {
    if (!aiAvailable()) return false;

    const budget = Number(config.aiMaxCalls);
    if (assistCalls >= (budget > 0 ? budget : 2)) return false;
    assistCalls++;

    await log('AI assist: ' + reason + '. Reading the page structure…');

    let digest;
    try {
      digest = window.JDC_AI.buildDigest({ reason: reason });
    } catch (e) {
      await log('AI assist: could not read the page — ' + (e && e.message ? e.message : e) + '.');
      return false;
    }

    const res = await send({
      type: 'JDC_AI_RESOLVE',
      path: location.pathname,
      digest: digest,
      reason: reason,
      /* A remembered plan is reused once - but if one was already applied at
       * the start of this run and the page STILL defeated the collector, that
       * plan is stale, so ask the model rather than handing it back. */
      force: assistCalls > 1 || cachedPlanApplied
    });

    if (!res || !res.ok) {
      await log('AI assist: ' + ((res && res.error) || 'no answer from the worker') + '.');
      return false;
    }
    return applyResolved(res, res.cached ? 'remembered plan' : res.model || 'model');
  }

  /* ---------- the field check ----------
   *
   * A model reads ONE job's pane and fills in what the DOM could not. Every
   * value it returns is checked back against the exact text it was shown
   * (src/lib/aiFields.js), so it can only ever point at the page - it cannot
   * invent a salary, and it is never asked what it thinks of the job.
   *
   * Off by default and separate from the selector assist, for two reasons
   * worth stating plainly: it is the only feature that sends posting text out
   * of the browser, and it costs one call per job, which on a free endpoint
   * is the difference between a run and an afternoon. */

  let verifyCalls = 0;
  let verifyStopped = false;

  function verifyAvailable() {
    return !!(config && config.aiEnabled && config.aiVerifyEnabled && window.JDC_AIFIELDS);
  }

  async function fillGapsWithModel(job, header, description) {
    if (!verifyAvailable() || verifyStopped) return job;

    const F = window.JDC_AIFIELDS;
    const missing = F.gaps(job);
    if (!missing.length) return job;

    const budget = Number(config.aiVerifyMaxJobs);
    if (verifyCalls >= (budget > 0 ? budget : 30)) return job;
    verifyCalls++;

    const sample = F.sampleFor(header, description, Number(config.aiVerifySampleChars) || 4000);

    const res = await send({
      type: 'JDC_AI_FIELDS',
      sample: sample,
      missing: missing,
      current: {
        title: job.title, company: job.company, location: job.location,
        workplaceType: job.workplaceType === 'Unknown' ? '' : job.workplaceType,
        employmentType: job.employmentType, seniority: job.seniority,
        payText: job.payRaw,
        applyRoute: job.applyType === 'unknown' ? '' : job.applyType
      }
    });

    if (!res || !res.ok) {
      const why = (res && res.error) || 'no answer';
      stage('FIELD_CHECK_FAILED', { jobId: job.jobId, asked: missing, reason: why });
      /* A rate limit will hit every remaining job in the run too, so stop
       * asking rather than adding a failed call to each one. */
      if (/rate limit|every configured model failed/i.test(why)) {
        verifyStopped = true;
        await log('Field check: ' + why + '. Not asking again this run.');
      }
      return job;
    }

    const accepted = res.accepted || {};
    const names = Object.keys(accepted);

    stage('FIELD_CHECK', {
      jobId: job.jobId,
      model: res.model,
      asked: missing,
      filled: names,
      rejected: (res.rejected || []).map(function (r) { return r.field + ': ' + r.why; })
    });

    if (!names.length) return job;

    /* Applied field by field, and RECORDED. A fact whose source is a model has
     * to be labelled wherever it is read - the row, the export, everywhere -
     * or the extension is quietly claiming the page said something it did
     * not. */
    job.aiFields = job.aiFields || {};

    names.forEach(function (k) {
      const v = accepted[k];
      if (k === 'payText') {
        const pay = window.JDC_PARSE.parsePay(v);
        if (pay.payMin == null) return;
        job.payRaw = pay.payRaw;
        job.payMin = pay.payMin;
        job.payMax = pay.payMax;
        job.payPeriod = pay.payPeriod;
        job.payCurrency = pay.payCurrency;
        job.payMinAnnual = pay.payMinAnnual;
        job.payMaxAnnual = pay.payMaxAnnual;
        job.paySource = 'model';
        job.aiFields.pay = res.model;
        return;
      }
      if (k === 'applyRoute') {
        job.applyType = v;
        job.aiFields.applyType = res.model;
        return;
      }
      job[k] = v;
      job.aiFields[k] = res.model;
    });

    await log('Field check filled ' + names.join(', ') + ' for job ' + job.jobId +
      ' (' + res.model + ').');
    return job;
  }

  /* A job that came back without a description, a title or a company did not
   * fail loudly - it produced a row that looks collected and is useless. That
   * is the second place worth asking for help, and re-extracting afterwards
   * means the job that triggered it is the first one the plan repairs. */
  function thinJob(job) {
    if (!job) return 'nothing extracted';
    if ((job.description || '').length < 200) {
      return 'description was ' + (job.description || '').length + ' characters';
    }
    if (!job.title) return 'no title';
    /* A row can be full and still be wrong. "Get job alerts for this search"
     * and "About the job" were both collected AS job titles on a real run,
     * with a description and a company alongside them - nothing about the row
     * was thin, and nothing about it was true either. */
    if (!window.JDC_SEL.looksLikeATitle(job.title)) {
      return 'the title came out as "' + String(job.title).slice(0, 40) + '"';
    }
    if (!job.company) return 'no company';
    return null;
  }

  async function extractWithAssist(jobId, meta) {
    let job = EX.extractJob(jobId, meta);
    const why = thinJob(job);
    if (why && aiAvailable()) {
      if (await maybeAssist('job ' + jobId + ': ' + why)) {
        job = EX.extractJob(jobId, meta);
      }
    }
    return job;
  }

  /* ---------- pagination ---------- */

  async function goToNextPage() {
    const before = (getCards()[0] && cardJobId(getCards()[0])) || null;

    const next = q(S.nextPage);
    if (next && !next.disabled && next.getAttribute('aria-disabled') !== 'true') {
      next.click();
      const moved = await waitFor(function () {
        const cards = getCards();
        const first = cards[0] ? cardJobId(cards[0]) : null;
        return cards.length > 0 && first && first !== before;
      }, 15000);
      if (moved) return 'ok';
    }

    // No usable next button: drive the start= parameter. This reloads the page,
    // and the resume path picks the run back up.
    const url = new URL(location.href);
    url.searchParams.set('start', String(currentStart() + PAGE_SIZE));
    await log('Paginating via start=' + url.searchParams.get('start') + ' (page reload).');
    location.assign(url.toString());
    return 'navigating';
  }

  /* ---------- persistence of the processed set ---------- */

  async function loadProcessed() {
    const r = await chrome.storage.local.get(PROCESSED_KEY);
    processed = new Set(r[PROCESSED_KEY] || []);
  }

  async function saveProcessed() {
    await chrome.storage.local.set({ [PROCESSED_KEY]: Array.from(processed) });
  }

  async function bgState() {
    const r = await send({ type: 'JDC_IS_ACTIVE' });
    return (r && r.state) || {};
  }

  async function stillActive() {
    const r = await send({ type: 'JDC_IS_ACTIVE' });
    return !!(r && r.active);
  }

  /* Job ids exported in earlier sessions, so a daily run can skip them. */
  async function loadHistory() {
    if (!config.skipSeen) return new Set();
    const r = await chrome.storage.local.get('jdc_history');
    return new Set(Object.keys(r.jdc_history || {}));
  }

  /* Jobs a vetting chat already turned down. The extension forms no opinion of
   * its own - this is someone else's call, read back in and remembered, so the
   * same rejects do not have to be re-read every run. Off unless asked for. */
  async function loadRejected() {
    if (!config.skipRejected) return new Set();
    const r = await chrome.storage.local.get('jdc_verdicts');
    const store = r.jdc_verdicts || {};
    return new Set(Object.keys(store).filter(function (id) {
      return store[id] && store[id].verdict === 'reject';
    }));
  }

  /* ---------- collecting a list whose cards carry no job id ----------
   *
   * On the newer job surfaces a result card is a bare div: no anchor, no data
   * attribute, nothing to identify the posting until it is opened, at which
   * point the id appears in the URL as currentJobId. So walk the list by
   * position, click, and read the identity back afterwards. */

  /* Choose what to click inside a card, without ever clicking a link that goes
   * somewhere other than a job.
   *
   * Picking the first anchor was wrong: job cards also contain links to the
   * hiring manager's profile and the company page, so "open this job" could
   * navigate to /in/someone instead - visiting a stranger's profile on the
   * user's behalf. Only a job link is ever clicked; otherwise a button, and
   * failing that the card element itself, which cannot navigate on its own. */
  function jobClickTarget(card) {
    const anchors = card.querySelectorAll('a[href]');

    for (let i = 0; i < anchors.length; i++) {
      if (window.JDC_SEL.jobIdFromAttrs(anchors[i])) return anchors[i];
    }

    const btn = card.querySelector('button, [role="button"]');
    if (btn) return btn;

    return card;
  }

  async function clickCardAt(card) {
    try { card.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    catch (e) { card.scrollIntoView(); }
    await sleep(120);

    const target = jobClickTarget(card);
    if (!target) return false;
    try { target.click(); } catch (e) { return false; }
    return true;
  }

  async function collectByPosition(count, history, rejected, startCollected, startSkipped) {
    let collected = startCollected;
    let skippedSeen = startSkipped;
    let sinceLongPause = 0;

    for (let i = 0; i < count; i++) {
      if (aborted) return { collected: collected, skippedSeen: skippedSeen, stop: true, reason: 'stopped-by-user' };
      if (!(await stillActive())) {
        aborted = true;
        return { collected: collected, skippedSeen: skippedSeen, stop: true, reason: 'stopped-by-user' };
      }

      // Re-query every iteration: the list re-renders as you click through it.
      const card = getCards()[i];
      if (!card) continue;

      const beforeSig = paneSignature();
      const beforeId = currentJobIdFromUrl();
      /* Hashes of every block that could hold a description, so that if the
       * pane turns out to have changed somewhere we were not looking, we can
       * find out where. */
      const beforeBlocks = candidateBlocks();
      const meta = EX.extractCardMeta(card);

      if (!(await clickCardAt(card))) continue;

      /* Wait for the pane itself to change, not for the URL to say it has.
       *
       * This surface rewrites currentJobId the moment you click, ahead of the
       * pane re-rendering, so "the id moved" was letting the PREVIOUS job's
       * posting be captured under this job's id - five in a row, identically,
       * in a real run.
       *
       * The very first card of a page is the one exception: it is often
       * already open, nothing will change, and there is no earlier job it
       * could be confused with because none has been captured yet. */
      const firstOfPage = i === 0;
      await waitFor(function () {
        const d = EX.descriptionEl();
        if (!d || (d.textContent || '').trim().length <= 120) return false;
        if (paneSignature() !== beforeSig) return true;
        if (!firstOfPage) return false;
        const id = currentJobIdFromUrl();
        return !!(id && id !== beforeId);
      }, 14000);

      /* No description at all: most likely it has not been rendered yet
       * rather than being absent. Scroll the pane the way a reader would and
       * give it one more chance before concluding anything. */
      if (!EX.descriptionEl()) {
        await nudgePaneForLazyContent();
        await waitFor(function () {
          const d = EX.descriptionEl();
          return !!(d && (d.textContent || '').trim().length > 120);
        }, 4000);
      }

      /* The pane we are reading did not move. If the URL did, LinkedIn changed
       * jobs and we are simply looking at the wrong element - which is a thing
       * we can find out rather than guess at. */
      const movedOn = currentJobIdFromUrl() !== beforeId;
      if (paneSignature() === beforeSig && movedOn && !firstOfPage) {
        const fixed = await relearnDescription(beforeBlocks);
        if (!fixed) {
          await log('Card ' + (i + 1) + ': the job changed but no block on the page ' +
            'changed with it — the pane may not have finished rendering.');
          if (!(await maybeAssist('the pane did not change when the job did'))) {
            await announceAssistIsOff();
          }
        }
      }

      const desc = EX.descriptionEl();
      const jobId = currentJobIdFromUrl();
      const hasBody = !!(desc && (desc.textContent || '').trim().length > 120);

      if (!jobId || !hasBody) {
        await progress({ failed: (Number((await bgState()).failed) || 0) + 1 });
        await log('Card ' + (i + 1) + ': no job opened (id=' + (jobId || 'none') +
          ', body=' + (hasBody ? 'yes' : 'no') + ').');
        await sleep(600);
        continue;
      }

      if (processed.has(jobId)) continue;

      if (history.has(jobId)) {
        processed.add(jobId);
        await saveProcessed();
        skippedSeen++;
        await progress({ skippedSeen: skippedSeen });
        continue;
      }

      if (rejected.has(jobId)) {
        processed.add(jobId);
        await saveProcessed();
        skippedSeen++;
        await progress({ skippedSeen: skippedSeen });
        await log('Skipped ' + jobId + ' (turned down in a previous vetting pass).');
        continue;
      }

      const job = await extractWithAssist(jobId, meta);

      /* The pane did not move: this is the previous job's posting about to
       * be stored under this job's id. Skip it and say so - a row that
       * looks collected and is not is the worst outcome available here. */
      const showingInstead = alreadyCollectedAs(job);
      if (showingInstead) {
        processed.add(jobId);
        await saveProcessed();
        await progress({ failed: (Number((await bgState()).failed) || 0) + 1 });
        await log('Skipped ' + jobId + ' — the details pane was still showing job ' +
          showingInstead + ' (byte-identical description). Nothing was stored for it.');
        await maybeAssist('the details pane did not change between jobs');
        await sleep(600);
        continue;
      }

      processed.add(jobId);
      await saveProcessed();
      await send({ type: 'JDC_JOBS', jobs: [job] });
      collected++;
      await progress({ currentTitle: (job.title || '') + ' — ' + (job.company || '') });

      const maxJobs = Number(config.maxJobs) || 0;
      if (maxJobs > 0 && collected >= maxJobs) {
        return { collected: collected, skippedSeen: skippedSeen, stop: true, reason: 'max-jobs-reached' };
      }

      sinceLongPause++;
      const every = Number(config.longPauseEvery) || 0;
      if (every > 0 && sinceLongPause >= every) {
        sinceLongPause = 0;
        await sleep(Number(config.longPauseMs) || 4000);
      } else {
        await sleep(jitter());
      }
    }

    return { collected: collected, skippedSeen: skippedSeen, stop: false };
  }

  /* ---------- the AI job search ----------
   *
   * Its own loop, not a branch inside the classic one. The two surfaces
   * disagree about what a card is, where a job id lives and whether the list
   * is even fully mounted, and every attempt to serve both from one path has
   * produced rows that looked collected and were not.
   *
   * Three things shape it, all of them consequences of the live DOM:
   *
   *   - Ids come from each card's `componentkey`, so they are known BEFORE the
   *     click. The classic loop had to click first and read the URL afterwards,
   *     which is what made a mis-selection indistinguishable from a slow pane.
   *   - Only the selected card exposes /jobs/view/{id}, so the selection is
   *     confirmed against that link or the URL after every click, and nothing
   *     is extracted until one of them names the card we clicked.
   *   - The list is virtualised: cards unmount when they scroll away. So the
   *     run collects as it scrolls, re-finds every card by componentkey at the
   *     moment it needs it, and dedupes on a Set of ids rather than trusting
   *     the list to hold still. */

  const AI_CLICK_TIMEOUT_MS = 8000;
  const AI_DESC_TIMEOUT_MS = 6000;
  const AI_CLICK_RETRIES = 2;
  const AI_BARREN_SCROLLS = 3;

  /* One line per stage, to the page console where it can be read live. Field
   * LENGTHS only - a log line is not the place for 4,800 characters of
   * someone's job posting. */
  function stage(name, data) {
    try {
      if (/FAIL/.test(name)) console.error('[JD] ' + name, data);
      else console.log('[JD] ' + name, data);
    } catch (e) { /* a console that refuses is not a reason to stop */ }
  }

  /* Every job goes through these eight stages, in this order, whether it is
   * one traced job or the four hundredth of a run. Each one records what it
   * saw; a failure records WHY, in the words of whatever actually failed,
   * and never as a bare "Failed". */
  async function collectOneAiJob(A, id, cardMeta) {
    const trace = { jobId: id, status: 'pending', reason: null, stages: [] };

    const mark = function (name, data) {
      const rec = Object.assign({ stage: name, jobId: id }, data || {});
      trace.stages.push(rec);
      stage(name, rec);
      return rec;
    };
    const fail = function (name, reason, data) {
      mark(name, Object.assign({ reason: reason }, data || {}));
      trace.status = 'failed';
      trace.reason = reason;
      return trace;
    };

    /* 1 - card discovered */
    let card = A.cardById(id);
    mark('CARD_DISCOVERED', {
      found: !!card,
      componentkey: card ? card.getAttribute('componentkey') : null
    });
    if (!card) return fail('CARD_FAILED', 'the card unmounted before it could be clicked');

    const meta = cardMeta || EX.extractCardMeta(card);

    /* 2 - card clicked, and 3 - selection synchronised. Retried together:
     * a click that lands while the list is re-rendering selects nothing. */
    let synced = false;
    let clickError = null;

    for (let attempt = 1; attempt <= AI_CLICK_RETRIES && !synced; attempt++) {
      card = A.cardById(id);
      if (!card) return fail('CARD_FAILED', 'the card unmounted between attempts', { attempt: attempt });

      try { card.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      catch (e) { try { card.scrollIntoView(); } catch (e2) { /* not fatal */ } }
      await sleep(120);

      try {
        card.click();
        clickError = null;
      } catch (e) {
        clickError = e && e.message ? e.message : String(e);
      }
      mark('CARD_CLICKED', { attempt: attempt, error: clickError });
      if (clickError) continue;

      synced = await waitFor(function () { return A.showsJob(id); }, AI_CLICK_TIMEOUT_MS);
      mark('SELECTION_SYNCED', {
        attempt: attempt,
        synced: synced,
        currentJobId: currentJobIdFromUrl(),
        selectedLinkId: A.selectedJobId()
      });
    }

    if (!synced) {
      return fail('SELECTION_FAILED',
        clickError ? ('the click threw: ' + clickError)
          : ('the selection never became ' + id + ' (it is ' +
             (A.selectedJobId() || 'none') + ')'),
        { currentJobId: currentJobIdFromUrl(), selectedLinkId: A.selectedJobId() });
    }

    /* 4 - details extracted. The posting paints lazily here: the header and
     * the Apply button arrive first and the description is a blank gap for a
     * moment, so it is waited for and then nudged before being given up on. */
    let ready = await waitFor(function () {
      return A.descriptionText().length > A.DESC_MIN_CHARS;
    }, AI_DESC_TIMEOUT_MS);

    if (!ready) {
      await nudgePaneForLazyContent();
      ready = await waitFor(function () {
        return A.descriptionText().length > A.DESC_MIN_CHARS;
      }, AI_DESC_TIMEOUT_MS);
    }

    const found = A.findDescription();
    const parts = A.parts();

    mark('EXTRACTED', Object.assign({
      headingFound: !!A.descriptionHeading(),
      descriptionVia: found ? found.via : null,
      renderedWithinTimeout: ready
    }, A.lengths(parts)));

    /* 5 - validation. Named fields, never a bare false. */
    const v = A.validate(id, parts);
    if (!v.ok) {
      /* The reason carries what was observable at the moment it failed. A
       * bare "description>100 (got 0)" in the activity log is true and
       * useless: it cannot say whether the heading was missing, the pane was
       * showing another job, or the posting simply had not painted. */
      return fail('VALIDATION_FAILED',
        'required fields missing: ' + v.missing.join('; ') +
        ' [heading: ' + (v.headingFound ? 'found' : 'MISSING') +
        ', via: ' + (found ? found.via : 'none') +
        ', pane: ' + (A.paneRoot() ? (A.paneRoot().textContent || '').trim().length + ' chars' : 'NOT FOUND') +
        ', rendered in time: ' + ready +
        ', url id: ' + currentJobIdFromUrl() +
        ', link id: ' + A.selectedJobId() + ']',
        { missingFields: v.missing, href: v.href, headingFound: v.headingFound,
          descriptionVia: found ? found.via : null, renderedWithinTimeout: ready });
    }
    mark('VALIDATED', { missingFields: [] });

    /* 6 - payload construction */
    let job;
    try {
      job = EX.buildJob(id, parts, meta);
    } catch (e) {
      /* The real error, with its stack. Never a generic failure standing in
       * for something a developer could have read. */
      return fail('PAYLOAD_FAILED',
        'buildJob threw: ' + (e && e.message ? e.message : String(e)),
        { stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : null });
    }

    /* The field check, if it is on: a model reads this pane and fills what
     * the DOM could not, with every value checked back against the page. */
    if (verifyAvailable()) {
      const region = A.headerRegion();
      job = await fillGapsWithModel(job,
        region ? (region.textContent || '') : '', job.description);
    }

    mark('PAYLOAD', {
      fields: Object.keys(job),
      descriptionLength: (job.description || '').length,
      payMinAnnual: job.payMinAnnual,
      workplaceType: job.workplaceType,
      applyType: job.applyType
    });

    const showingInstead = alreadyCollectedAs(job);
    if (showingInstead) {
      return fail('DUPLICATE',
        'its description is identical to job ' + showingInstead +
        ', so the pane had not repainted', { otherJobId: showingInstead });
    }

    /* 7 - save. There is no HTTP API here: the job is handed to the extension's
     * own service worker, which buffers it into chrome.storage. Its reply is
     * the closest thing to a response status, so it is logged as one. */
    const res = await send({ type: 'JDC_JOBS', jobs: [job] });
    mark('SAVE_RESPONSE', {
      status: res ? (res.ok ? 'ok' : 'error') : 'no-response',
      body: res || null
    });
    if (!res || !res.ok) {
      return fail('SAVE_FAILED',
        'the service worker did not accept the job (' +
        (res ? JSON.stringify(res) : 'no response') + ')');
    }

    /* 8 - final status */
    trace.status = 'collected';
    trace.job = job;
    mark('STATUS', { status: 'collected', title: job.title, company: job.company });
    return trace;
  }

  /* The whole pipeline for exactly one job, run on demand from Settings so a
   * surface can be proved out before a run is turned loose on it. */
  async function traceOneAiJob() {
    const A = window.JDC_AISEARCH;
    if (!A) return { ok: false, error: 'the AI-search adapter is not loaded' };
    if (!A.onRoute()) {
      return { ok: false, error: 'not on /jobs/search-results/ (this is ' + location.pathname + ')' };
    }
    if (!A.applies()) {
      return { ok: false, error: 'no ' + A.KNOWN.card + ' cards on this page', report: A.report() };
    }

    const ids = A.mountedIds();
    if (!ids.length) return { ok: false, error: 'no card ids readable', report: A.report() };

    config = config || {};
    const before = seenDescriptions.size;
    const t = await collectOneAiJob(A, ids[0], null);

    const lines = [];
    lines.push(A.report());
    lines.push('');
    lines.push('TRACE OF ONE JOB — ' + t.jobId);
    t.stages.forEach(function (s) {
      const copy = Object.assign({}, s);
      delete copy.stage;
      delete copy.jobId;
      lines.push('  ' + s.stage.padEnd(18) + JSON.stringify(copy));
    });
    lines.push('');
    lines.push('FINAL STATUS: ' + t.status + (t.reason ? ' — ' + t.reason : ''));
    if (t.status === 'collected') {
      lines.push('The job was saved, so it is in Results now. Descriptions seen this ' +
        'session: ' + before + ' before, ' + seenDescriptions.size + ' after.');
    }
    return { ok: true, report: lines.join('\n'), status: t.status, trace: t };
  }

  /* A control that loads the next batch, if this surface has one. Text only -
   * every class on it is a build hash. */
  function aiLoadMoreControl(A) {
    const list = A.listContainer();
    const scope = (list && list.parentElement) || document;
    const nodes = scope.querySelectorAll('button, a[role="button"], [role="button"]');

    for (let i = 0; i < nodes.length && i < 400; i++) {
      const el = nodes[i];
      const label = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
        .replace(/\s+/g, ' ').trim();
      if (!label || label.length > 40) continue;
      if (/^(?:show|see|load|view)\s+more\b|^more results\b|^next\b/i.test(label)) return el;
    }
    return null;
  }

  /* Scroll the list's own container - not the document, which does not move.
   *
   * Returns { grew, more }: `more` says there is still somewhere to go, and it
   * is what stops a run ending in the middle of the list. A run stopped at 25
   * of "99+ results" because a scroll that mounted nothing counted as barren
   * even though the list had another 1,300 pixels below it - three of those in
   * a row and it declared the end. Barren only means anything once there is
   * nothing left to scroll. */
  async function aiScrollForMore(A, seen) {
    const scroller = A.scrollContainer();
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    const pending = function () {
      return A.mountedIds().filter(function (id) { return !seen.has(id); }).length;
    };
    const atBottom = function () {
      if (isDoc) {
        return window.innerHeight + window.scrollY >= document.body.scrollHeight - 8;
      }
      return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    };

    const before = pending();
    const wasAtBottom = atBottom();

    if (isDoc) window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    else {
      scroller.scrollTop = Math.min(
        scroller.scrollTop + Math.max(200, scroller.clientHeight * 0.8),
        scroller.scrollHeight);
    }

    /* Newly mounted cards arrive asynchronously; poll rather than guess at a
     * fixed delay. */
    const grew = await waitFor(function () { return pending() > before; }, 2500, 150);
    if (grew || pending() > 0) return { grew: true, more: true };

    /* Nothing new, but the list has not been walked to the end yet. */
    if (!atBottom()) return { grew: false, more: true };

    /* At the bottom with nothing new. If the surface offers a control to load
     * the next batch, that is the pagination it has. */
    if (!wasAtBottom) return { grew: false, more: true };   // first touch of the bottom

    const more = aiLoadMoreControl(A);
    if (more) {
      stage('LOAD_MORE_CLICKED', { label: (more.textContent || '').trim().slice(0, 40) });
      await log('Reached the end of the mounted list; clicking "' +
        (more.textContent || '').trim().slice(0, 40) + '".');
      try { more.click(); } catch (e) { /* reported by the next round */ }
      const loaded = await waitFor(function () { return pending() > 0; }, 5000, 200);
      return { grew: loaded, more: loaded };
    }

    return { grew: false, more: false };
  }

  async function runAiSearch(history, rejected, startCollected, startSkipped) {
    const A = window.JDC_AISEARCH;
    const seen = new Set();
    let collected = startCollected;
    let skippedSeen = startSkipped;
    let sinceLongPause = 0;
    let barren = 0;
    let failed = 0;
    let duplicates = 0;

    await log('AI job search detected. ' + A.report());

    while (!aborted) {
      if (!(await stillActive())) return { collected: collected, skippedSeen: skippedSeen, reason: 'stopped-by-user' };
      if (!onJobsPath()) return { collected: collected, skippedSeen: skippedSeen, reason: 'left-jobs-area' };

      const pending = A.mountedIds().filter(function (id) { return !seen.has(id); });

      if (!pending.length) {
        const scrolled = await aiScrollForMore(A, seen);
        if (scrolled.grew) {
          barren = 0;
        } else if (!scrolled.more) {
          /* Nothing new AND nowhere left to scroll: this is the end of the
           * list, not a slow render. */
          await log('End of the list: ' + seen.size + ' cards seen, ' +
            collected + ' collected, ' + failed + ' failed.');
          return { collected: collected, skippedSeen: skippedSeen, reason: 'end-of-list' };
        } else {
          barren++;
          if (barren >= AI_BARREN_SCROLLS * 4) {
            await log('Scrolled ' + barren + ' times with nothing new mounting. ' +
              seen.size + ' cards seen, ' + collected + ' collected.');
            return { collected: collected, skippedSeen: skippedSeen, reason: 'end-of-list' };
          }
        }
        continue;
      }

      barren = 0;
      await log('Mounted ' + pending.length + ' new card(s); ' + seen.size +
        ' seen so far, ' + collected + ' collected.');

      for (let i = 0; i < pending.length; i++) {
        if (aborted) return { collected: collected, skippedSeen: skippedSeen, reason: 'stopped-by-user' };
        if (!(await stillActive())) return { collected: collected, skippedSeen: skippedSeen, reason: 'stopped-by-user' };

        const id = pending[i];
        seen.add(id);

        if (processed.has(id)) { duplicates++; continue; }

        if (history.has(id)) {
          processed.add(id);
          await saveProcessed();
          skippedSeen++;
          await progress({ skippedSeen: skippedSeen });
          continue;
        }
        if (rejected.has(id)) {
          processed.add(id);
          await saveProcessed();
          skippedSeen++;
          await progress({ skippedSeen: skippedSeen });
          await log('Skipped ' + id + ' (turned down in a previous vetting pass).');
          continue;
        }

        /* One pipeline, used by the run and by the one-job trace alike, so
         * what a trace proves is what a run does. It never throws: a stage
         * that fails returns the reason that stage actually saw. */
        let t;
        try {
          t = await collectOneAiJob(A, id, null);
        } catch (e) {
          t = {
            jobId: id, status: 'failed',
            reason: 'unhandled error: ' + (e && e.message ? e.message : String(e))
          };
          stage('UNHANDLED', { jobId: id, error: t.reason, stack: e && e.stack });
        }

        if (t.status !== 'collected') {
          processed.add(id);
          await saveProcessed();
          failed++;
          if (t.reason && /identical to job/.test(t.reason)) duplicates++;
          await progress({ failed: (Number((await bgState()).failed) || 0) + 1 });
          /* The reason the stage gave, verbatim. "Failed" on its own tells
           * nobody anything, and it is what made this surface take a week. */
          await log('Job ' + id + ' failed: ' + (t.reason || 'no reason recorded') + '.');
          continue;
        }

        const job = t.job;
        processed.add(id);
        await saveProcessed();
        collected++;
        await progress({ currentTitle: (job.title || '') + ' — ' + (job.company || '') });

        const maxJobs = Number(config.maxJobs) || 0;
        if (maxJobs > 0 && collected >= maxJobs) {
          return { collected: collected, skippedSeen: skippedSeen, reason: 'max-jobs-reached' };
        }

        sinceLongPause++;
        const every = Number(config.longPauseEvery) || 0;
        if (every > 0 && sinceLongPause >= every) {
          sinceLongPause = 0;
          await log('Pausing ' + Math.round((Number(config.longPauseMs) || 0) / 1000) +
            's to stay gentle on LinkedIn.');
          await sleep(Number(config.longPauseMs) || 4000);
        } else {
          await sleep(jitter());
        }
      }

      await progress({ pagesDone: 1 });
    }

    return {
      collected: collected, skippedSeen: skippedSeen, reason: 'stopped-by-user',
      failed: failed, duplicates: duplicates
    };
  }

  /* ---------- the main loop ---------- */

  async function runLoop(cfg, fresh) {
    if (running) return;
    running = true;
    aborted = false;
    stopRequested = false;
    config = cfg;

    if (fresh) {
      processed = new Set();
      seenDescriptions = new Map();
      await saveProcessed();
    } else {
      await loadProcessed();
    }

    await log('Collector build ' + BUILD + ' running on ' + location.pathname + '.');

    const health = EX.selectorHealth();
    if (!health.list || !health.card) {
      await log('WARNING: job list selectors did not match. LinkedIn layout may have changed.');
      /* Free: a plan already resolved for this page on an earlier run. It is
       * re-checked against the DOM before anything uses it, so a stale one
       * from before a deploy is dropped rather than trusted. */
      const cached = await applyCachedPlan();

      /* Nothing cached, and every hand-written selector missed. This is the
       * case the assist exists for, so it runs here rather than waiting for a
       * job to come out wrong first - waiting means the first few jobs of the
       * run are collected badly before anything reacts. */
      if (!cached) {
        if (!(await maybeAssist('no hand-written selector matches this layout'))) {
          await announceAssistIsOff();
        }
      }
    }

    /* Counters continue across a forced reload, otherwise maxPages/maxJobs
     * would reset every time LinkedIn navigates and the run never ends. */
    const prior = fresh ? {} : await bgState();
    let pagesDone = Number(prior.pagesDone) || 0;
    let collected = Number(prior.collected) || 0;
    let skippedSeen = Number(prior.skippedSeen) || 0;
    const history = await loadHistory();
    const rejected = await loadRejected();

    let sinceLongPause = 0;
    let reason = 'done';

    /* ---- which collector is this page? ----
     *
     * The AI job search gets its own adapter. The test is deliberately BOTH
     * the route and the DOM: LinkedIn can serve the classic two-pane layout
     * under a new path, and an adapter that answered on the route alone would
     * find nothing there and report an empty page as a fact. If the adapter
     * does not recognise the page, everything below runs exactly as it did. */
    if (window.JDC_AISEARCH && window.JDC_AISEARCH.applies()) {
      try {
        const out = await runAiSearch(history, rejected, collected, skippedSeen);
        collected = out.collected;
        skippedSeen = out.skippedSeen;
        reason = out.reason || 'done';
      } catch (e) {
        await log('AI job search adapter failed: ' + (e && e.message ? e.message : e));
        reason = 'error';
      }
      if (stopRequested) reason = 'stopped-by-user';
      if (collected === 0 && !stopRequested) {
        let report;
        try { report = diagnose(); }
        catch (e) { report = 'Diagnostic failed: ' + (e && e.message); }
        await log('Collected 0 jobs. Diagnostic follows.\n' + report);
      }
      running = false;
      await send({ type: 'JDC_DONE', reason: reason });
      return;
    }

    if (window.JDC_AISEARCH && window.JDC_AISEARCH.onRoute()) {
      await log('On ' + location.pathname + ' but the AI-search adapter does not ' +
        'recognise this page (no ' + window.JDC_AISEARCH.KNOWN.card + ' cards). ' +
        'Falling back to the structural collector.');
    }

    /* Surfaces that do not honour start= - LinkedIn's AI job search being the
     * one that matters - hand back the same cards after every 'next page',
     * all of them already processed. Without this the run would reload the
     * same list until maxPages ran out, reporting pages it never advanced
     * past. Two barren pages in a row is the signal: one can legitimately be
     * all-duplicates when resuming or when skipSeen is on. */
    let barrenPages = 0;


    try {
      while (!aborted) {
        if (!(await stillActive())) { reason = 'stopped-by-user'; break; }

        /* Hard stop if the run has left the job pages. A misdirected click used
         * to strand the loop on a profile, where it carried on clicking. Never
         * keep automating once we are somewhere we did not intend to be. */
        if (!onJobsPath()) {
          await log('Left the job pages (now at ' + location.pathname + '). Stopping.');
          reason = 'left-jobs-area';
          break;
        }

        if (q(S.noResults)) { reason = 'no-results'; break; }

        await progress({ page: currentPageNumber() });
        await log('Page ' + currentPageNumber() + ': loading job list...');

        let cards = await loadWholeList();

        /* Nothing at all: every hand-written selector missed AND both structural
         * routes came back empty. That is the point where a description of the
         * page is worth more than another heuristic. */
        if (!cards.length && await maybeAssist('no job cards found on page ' + currentPageNumber())) {
          cards = await loadWholeList();
        }

        if (!cards.length) {
          await log('No job cards found on this page.');
          reason = 'no-cards';
          break;
        }
        const collectedAtPageStart = collected;

        /* Snapshot the ids, not the elements - see findCardById. */
        const pageIds = cards.map(cardJobId).filter(Boolean);

        /* Ids that are not PER-CARD are worse than no ids at all.
         *
         * On LinkedIn's AI job search every card links back to the page with the
         * currently-selected job's ?currentJobId=, so eight cards yield eight
         * ids that are all the same one. The loop further down dedupes against
         * `processed`, so it collected exactly one job, silently skipped the
         * other seven, and moved to the next page - which reads from the outside
         * as "it skipped page 1".
         *
         * So the test is how many DISTINCT ids the page produced, not how many
         * ids. Below that bar the page is walked by position instead, resolving
         * each id from the URL after the click. The 3-card floor keeps a
         * genuinely short page from being pushed down the slower path. */
        const distinctIds = new Set(pageIds).size;
        const idsArePerCard = distinctIds >= Math.max(2, Math.ceil(cards.length * 0.6));

        if (!pageIds.length || (cards.length >= 3 && !idsArePerCard)) {
          await log('Page ' + currentPageNumber() + ': ' + cards.length +
            ' cards but only ' + distinctIds + ' distinct job id(s) — collecting by position.');
          const outcome = await collectByPosition(cards.length, history, rejected, collected, skippedSeen);
          collected = outcome.collected;
          skippedSeen = outcome.skippedSeen;
          if (outcome.stop) { reason = outcome.reason || 'done'; break; }
          if (collected === collectedAtPageStart) {
            barrenPages++;
            await log('Page ' + currentPageNumber() + ' added no new jobs (' +
              barrenPages + ' in a row).');
            if (barrenPages >= 2) { reason = 'no-new-jobs'; break; }
          } else {
            barrenPages = 0;
          }

          pagesDone++;
          await progress({ pagesDone: pagesDone });
          const maxPagesA = Number(config.maxPages) || 0;
          if (maxPagesA > 0 && pagesDone >= maxPagesA) { reason = 'max-pages-reached'; break; }
          await log('Moving to the next page...');
          const navA = await goToNextPage();
          if (navA === 'navigating') { running = false; return; }
          if (navA !== 'ok') { reason = 'no-more-pages'; break; }
          await sleep(900);
          continue;
        }

        await log('Page ' + currentPageNumber() + ': ' + pageIds.length + ' cards.');

        for (let i = 0; i < pageIds.length; i++) {
          if (aborted) { reason = 'stopped-by-user'; break; }
          if (!(await stillActive())) { aborted = true; reason = 'stopped-by-user'; break; }

          const jobId = pageIds[i];
          if (processed.has(jobId)) continue;

          if (history.has(jobId)) {
            processed.add(jobId);
            await saveProcessed();
            skippedSeen++;
            await progress({ skippedSeen: skippedSeen });
            continue;
          }

          if (rejected.has(jobId)) {
            processed.add(jobId);
            await saveProcessed();
            skippedSeen++;
            await progress({ skippedSeen: skippedSeen });
            await log('Skipped ' + jobId + ' (turned down in a previous vetting pass).');
            continue;
          }

          const card = await findCardScrolling(jobId);
          if (!card) {
            processed.add(jobId);
            await saveProcessed();
            await progress({ failed: (Number((await bgState()).failed) || 0) + 1 });
            await log('Skipped ' + jobId + ' (card no longer in the list).');
            continue;
          }

          const meta = EX.extractCardMeta(card);
          const cardLink = card.querySelector(S.cardLink.join(','));
          const cardTitle = EX.text(cardLink) || (meta.cardText || '').slice(0, 60);

          /* Remember what we are about to open: if the click turns out to be a
           * full page navigation rather than a pane swap, the resume path picks
           * this job up on the job page and comes back. */
          await chrome.storage.local.set({ jdc_pending: { jobId: jobId, searchUrl: location.href } });

          const opened = await openCard(card, jobId, cardTitle);

          if (!opened) {
            processed.add(jobId);
            await saveProcessed();
            await progress({ failed: (Number((await bgState()).failed) || 0) + 1 });
            await log('Skipped ' + jobId + ' (details pane did not load).');
            await sleep(600);
            continue;
          }

          const job = await extractWithAssist(jobId, meta);

          /* The pane did not move: this is the previous job's posting about to
           * be stored under this job's id. Skip it and say so - a row that
           * looks collected and is not is the worst outcome available here. */
          const showingInstead = alreadyCollectedAs(job);
          if (showingInstead) {
            processed.add(jobId);
            await saveProcessed();
            await progress({ failed: (Number((await bgState()).failed) || 0) + 1 });
            await log('Skipped ' + jobId + ' — the details pane was still showing job ' +
              showingInstead + ' (byte-identical description). Nothing was stored for it.');
            if (!(await maybeAssist('the details pane did not change between jobs'))) {
            await announceAssistIsOff();
          }
            await sleep(600);
            continue;
          }

          processed.add(jobId);
          await saveProcessed();

          await send({ type: 'JDC_JOBS', jobs: [job] });
          collected++;
          await progress({ currentTitle: (job.title || '') + ' — ' + (job.company || '') });

          const maxJobs = Number(config.maxJobs) || 0;
          if (maxJobs > 0 && collected >= maxJobs) {
            reason = 'max-jobs-reached';
            aborted = true;
            break;
          }

          sinceLongPause++;
          const every = Number(config.longPauseEvery) || 0;
          if (every > 0 && sinceLongPause >= every) {
            sinceLongPause = 0;
            await log('Pausing ' + Math.round((Number(config.longPauseMs) || 0) / 1000) + 's to stay gentle on LinkedIn.');
            await sleep(Number(config.longPauseMs) || 4000);
          } else {
            await sleep(jitter());
          }
        }

        if (aborted) break;

        if (collected === collectedAtPageStart) {
          barrenPages++;
          await log('Page ' + currentPageNumber() + ' added no new jobs (' +
            barrenPages + ' in a row).');
          if (barrenPages >= 2) {
            reason = 'no-new-jobs';
            break;
          }
        } else {
          barrenPages = 0;
        }

        pagesDone++;
        await progress({ pagesDone: pagesDone });

        const maxPages = Number(config.maxPages) || 0;
        if (maxPages > 0 && pagesDone >= maxPages) { reason = 'max-pages-reached'; break; }

        await log('Moving to the next page...');
        const nav = await goToNextPage();
        if (nav === 'navigating') {
          // The reload restarts this script; resume() continues the run.
          running = false;
          return;
        }
        if (nav !== 'ok') { reason = 'no-more-pages'; break; }
        await sleep(900);
      }
    } catch (e) {
      await log('Error: ' + (e && e.message ? e.message : String(e)));
      reason = 'error';
    }

    // A stop landing on the final job would otherwise be reported as a
    // normal finish.
    if (stopRequested) reason = 'stopped-by-user';

    /* Collecting nothing is the failure that used to be invisible. Dump the
     * page diagnostic straight into the log so the reason is on screen rather
     * than requiring the user to know a separate tool exists. */
    if (collected === 0 && !stopRequested) {
      let report;
      try { report = diagnose(); }
      catch (e) { report = 'Diagnostic failed: ' + (e && e.message); }
      /* The one case where there is something left to try. Said here rather
       * than left for the user to discover, because a page this diagnostic
       * cannot be read from by hand is exactly what the assist is for. */
      const hint = (config && config.aiEnabled)
        ? ''
        : '\n\nAI assist is off. Settings → AI assist can describe a page like ' +
          'this to a model and resolve selectors for it.';

      // One entry, not one per line: the log is a single storage key and
      // concurrent appends lose all but the last.
      await log('Collected 0 jobs. Diagnostic follows.' + hint + '\n' + report);
    }

    running = false;
    await send({ type: 'JDC_DONE', reason: reason });
  }

  /* ---------- resolving the real apply URL ---------- */

  /* Clicking an external Apply button opens the employer's ATS in a new tab.
   * The content script only performs the click; the background worker watches
   * for the tab that opens, reads its settled URL, and closes it. */
  async function clickApply() {
    /* waitFor bails out while `aborted` is set, and a previously stopped scrape
     * leaves it set. The background only resolves apply URLs when no scrape is
     * running, so clearing it here is safe. */
    aborted = false;

    const ok = await waitFor(function () {
      const b = q(S.applyButton);
      return !!(b && /apply/i.test(EX.text(b) + ' ' + (b.getAttribute('aria-label') || '')));
    }, 12000);
    if (!ok) return { ok: false, error: 'apply-button-not-found' };

    const btn = q(S.applyButton);
    const label = (EX.text(btn) + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();

    // Easy Apply opens an in-page modal; there is no external URL to capture.
    if (/easy apply/.test(label)) return { ok: false, error: 'easy-apply' };

    // Free path: the button is already a link to the employer.
    const href = btn.tagName === 'A' ? btn.getAttribute('href') : null;
    if (href && !/linkedin\.com/i.test(href) && /^https?:/i.test(href)) {
      return { ok: true, url: href, viaLink: true };
    }

    btn.click();
    return { ok: true, clicked: true };
  }

  /* ---------- page diagnostic ---------- */

  /* Describes what this page actually looks like, so an unsupported surface can
   * be targeted precisely instead of guessed at. Emits structure only: tags,
   * classes and counts, never job text or anything identifying. */
  function describe(el, depth) {
    if (!el || !el.tagName) return '(none)';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
      : '';
    const id = el.id ? '#' + el.id : '';
    const attrs = ['data-job-id', 'data-occludable-job-id', 'role', 'aria-label']
      .filter(function (a) { return el.hasAttribute && el.hasAttribute(a); })
      .map(function (a) { return '[' + a + ']'; })
      .join('');
    let line = '  '.repeat(depth || 0) + el.tagName.toLowerCase() + id + cls + attrs;
    if (line.length > 160) line = line.slice(0, 157) + '...';
    return line;
  }

  function outline(el, maxDepth, depth) {
    if (!el || (depth || 0) > (maxDepth || 3)) return [];
    const lines = [describe(el, depth || 0)];
    const kids = Array.prototype.slice.call(el.children || []).slice(0, 4);
    kids.forEach(function (k) {
      lines.push.apply(lines, outline(k, maxDepth, (depth || 0) + 1));
    });
    return lines;
  }

  function diagnose() {
    const SELM = window.JDC_SEL;
    const health = EX.selectorHealth();

    const primaryList = q(S.list);
    const primaryCards = (primaryList ? qa(S.card, primaryList) : qa(S.card))
      .filter(function (c) { return cardJobId(c); });

    const genericRoot = SELM.genericListRoot();
    const genericCards = SELM.genericCards();
    const descEl = EX.descriptionEl();

    const lines = [];
    lines.push('JD COLLECTOR PAGE DIAGNOSTIC');
    lines.push('collector build: ' + BUILD);

    /* Which adapter owns this page, and what it can see. First question worth
     * answering on any surface that is not collecting. */
    if (window.JDC_AISEARCH) {
      lines.push('');
      try { lines.push(window.JDC_AISEARCH.report()); }
      catch (e) { lines.push('AI JOB SEARCH ADAPTER: threw — ' + (e && e.message)); }
      lines.push('');
    }
    lines.push('url: ' + location.origin + location.pathname);
    lines.push('search params: ' + Array.from(new URL(location.href).searchParams.keys()).join(', '));
    lines.push('');

    lines.push('KNOWN SELECTORS');
    Object.keys(health).forEach(function (k) {
      lines.push('  ' + k.padEnd(14) + (health[k] || 'NO MATCH'));
    });
    lines.push('  primary cards found: ' + primaryCards.length);
    lines.push('');

    /* Which of the resolved selectors this page is currently running on. A
     * learned selector sits at the front of the same list a hand-written one
     * would, so without this line the health block above cannot be told apart
     * from a layout that was supported all along. */
    const learned = window.JDC_SEL.learned();
    const learnedKeys = Object.keys(learned);
    lines.push('AI-RESOLVED SELECTORS IN USE: ' + (learnedKeys.length || 'none'));
    learnedKeys.forEach(function (k) {
      let n = 0;
      try { n = document.querySelectorAll(learned[k]).length; } catch (e) { n = -1; }
      lines.push('  ' + k.padEnd(14) + String(n).padStart(3) + ' match(es)  ' + learned[k]);
    });
    lines.push('');

    lines.push('GENERIC FALLBACK');
    lines.push('  job elements on page: ' + SELM.jobAnchors().length);
    lines.push('  inferred list root: ' + describe(genericRoot, 0).trim());
    lines.push('  generic cards found: ' + genericCards.length);
    lines.push('');

    lines.push('DISCOVERY BREAKDOWN (which pattern hits)');
    const breakdown = SELM.discoveryBreakdown();
    Object.keys(breakdown).forEach(function (sel) {
      lines.push('  ' + String(breakdown[sel]).padStart(4) + '  ' + sel);
    });
    lines.push('');

    /* An iframe would explain finding nothing: this script does not run inside
     * one, so results rendered in a frame are invisible to it. */
    const frames = document.querySelectorAll('iframe');
    lines.push('IFRAMES ON PAGE: ' + frames.length);
    Array.prototype.slice.call(frames).slice(0, 6).forEach(function (f) {
      let host = '(no src)';
      try { if (f.src) host = new URL(f.src, location.href).host + new URL(f.src, location.href).pathname; }
      catch (e) { host = '(unparseable src)'; }
      lines.push('  ' + host + '  ' + describe(f, 0).trim());
    });
    lines.push('');

    /* Anything that looks like a results list, by shape rather than by name.
     * This is the bit that tells us what to actually target. */
    lines.push('REPEATED-STRUCTURE CANDIDATES (possible result lists)');
    const groups = new Map();
    const all = document.querySelectorAll('main li, main article, [role="list"] > *, ul > li');
    for (let i = 0; i < all.length && i < 4000; i++) {
      const el = all[i];
      const parent = el.parentElement;
      if (!parent) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length < 40) continue;
      groups.set(parent, (groups.get(parent) || 0) + 1);
    }
    Array.from(groups.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 5)
      .forEach(function (e) {
        /* Whether the shape route would actually ACCEPT this group matters
         * more than its size. A seven-member list that looksLikeJobList
         * rejects is not a fallback, it is a dead end - and knowing which of
         * the two failed is the difference between fixing the grouping and
         * fixing the classifier. */
        let verdict = "";
        try {
          const members = Array.prototype.slice.call(e[0].children);
          verdict = window.JDC_SEL.looksLikeJobList(members) ? '  [accepted as a job list]' : '  [REJECTED by looksLikeJobList]';
        } catch (err) { verdict = '  [could not classify]'; }
        lines.push('  ' + String(e[1]).padStart(3) + ' children  ' + describe(e[0], 0).trim() + verdict);
      });
    lines.push('');

    /* What the shape route returns on its own, which is what genericCards now
     * falls back to when the anchor route collapses. */
    lines.push('SHAPE-BASED DISCOVERY (the fallback when anchors collapse)');
    try {
      const byShape = window.JDC_SEL.genericCardsByShape();
      lines.push('  cards found by shape: ' + byShape.length);
      if (byShape.length) {
        const withId = byShape.filter(function (el) {
          const a = el.querySelector(window.JDC_SEL.JOB_CANDIDATE_SELECTOR) || el;
          return !!window.JDC_SEL.jobIdFromAttrs(a);
        }).length;
        lines.push('  of those, carrying a job id: ' + withId +
          (withId ? '' : '  (they will be walked by position instead)'));
        lines.push('  first one:');
        lines.push.apply(lines, outline(byShape[0], 3, 2));
      }
    } catch (err) {
      lines.push('  threw: ' + (err && err.message ? err.message : err));
    }
    lines.push('');

    lines.push('DESCRIPTION CANDIDATE');
    lines.push('  element: ' + describe(descEl, 0).trim());
    lines.push('  text length: ' + (descEl ? (descEl.textContent || '').trim().length : 0));
    lines.push('');

    if (genericCards.length) {
      lines.push('FIRST CARD STRUCTURE');
      lines.push.apply(lines, outline(genericCards[0], 3, 1));
      lines.push('');
    }

    const applyBtn = q(S.applyButton);
    lines.push('APPLY BUTTON: ' + describe(applyBtn, 0).trim());
    lines.push('BUTTONS ON PAGE MENTIONING APPLY:');
    Array.prototype.slice.call(document.querySelectorAll('button, a[role="button"]'))
      .filter(function (b) { return /apply/i.test(EX.text(b)); })
      .slice(0, 5)
      .forEach(function (b) { lines.push('  ' + describe(b, 0).trim() + '  text="' + EX.text(b).slice(0, 40) + '"'); });

    return lines.join('\n');
  }

  /* ---------- messaging ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'JDC_PING') { sendResponse({ ok: true, build: BUILD }); return; }
    if (msg.type === 'JDC_BEGIN') {
      sendResponse({ ok: true });
      runLoop(msg.config, true);
      return;
    }
    if (msg.type === 'JDC_ABORT') {
      aborted = true;
      stopRequested = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'JDC_DIAGNOSE') {
      let report;
      try { report = diagnose(); }
      catch (e) { report = 'Diagnostic failed: ' + (e && e.message); }
      sendResponse({ ok: true, report: report });
      return;
    }
    /* The two halves of "Resolve this page with AI" in the settings window.
     * The worker owns the network call, so the page only ever describes itself
     * and then checks what comes back. */
    if (msg.type === 'JDC_AI_TRACE') {
      traceOneAiJob().then(sendResponse, function (e) {
        sendResponse({ ok: false, error: 'the trace threw: ' + (e && e.message ? e.message : e) });
      });
      return true; // async
    }

    if (msg.type === 'JDC_AI_DIGEST') {
      try {
        sendResponse({ ok: true, digest: window.JDC_AI.buildDigest({ reason: msg.reason }) });
      } catch (e) {
        sendResponse({ ok: false, error: 'Could not read the page: ' + (e && e.message) });
      }
      return;
    }

    if (msg.type === 'JDC_AI_APPLY') {
      try {
        const applied = window.JDC_AI.applyPlan(msg.plan || {});
        sendResponse({
          ok: true,
          applied: applied,
          report: window.JDC_AI.report(msg.plan || {}, applied)
        });
      } catch (e) {
        sendResponse({ ok: false, error: 'Could not check the plan: ' + (e && e.message) });
      }
      return;
    }

    if (msg.type === 'JDC_CLICK_APPLY') {
      clickApply().then(sendResponse, function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
      return true; // async
    }
  });

  /* ---------- resume after a forced reload ---------- */

  /* Some surfaces open a job as a full page instead of swapping a side pane.
   * That destroys this script's context mid-click, so the job is collected here
   * on the job page and then we navigate back to the search. */
  async function resumeFromJobPage(config) {
    const m = /\/jobs\/view\/(\d+)/.exec(location.pathname);
    if (!m) return false;

    const store = await chrome.storage.local.get('jdc_pending');
    const pending = store.jdc_pending;
    if (!pending || pending.jobId !== m[1] || !pending.searchUrl) return false;

    config = config || {};
    await log('Job opened as a full page; collecting it here, then going back.');

    const ready = await waitFor(function () {
      const d = EX.descriptionEl();
      return !!(d && (d.textContent || '').trim().length > 120);
    }, 12000);

    await loadProcessed();
    if (ready && !processed.has(m[1])) {
      const job = EX.extractJob(m[1], {});
      processed.add(m[1]);
      await saveProcessed();
      await send({ type: 'JDC_JOBS', jobs: [job] });
    } else if (!ready) {
      await log('Could not read the job page for ' + m[1] + '; skipping.');
      processed.add(m[1]);
      await saveProcessed();
    }

    await chrome.storage.local.remove('jdc_pending');
    location.assign(pending.searchUrl);
    return true;
  }

  (async function resume() {
    await sleep(1200);
    const r = await send({ type: 'JDC_IS_ACTIVE' });
    if (!r || !r.active || running) return;

    if (await resumeFromJobPage(r.config)) return;

    /* A run that ended up somewhere unexpected must not restart itself there. */
    if (!onJobsPath()) {
      await log('Page loaded outside the job pages (' + location.pathname + '). Not resuming.');
      await send({ type: 'JDC_DONE', reason: 'left-jobs-area' });
      return;
    }

    await log('Resuming after page load on page ' + currentPageNumber() + '.');
    runLoop(r.config, false);
  })();
})();
