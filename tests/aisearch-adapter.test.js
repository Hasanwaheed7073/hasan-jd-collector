/* The AI job search adapter (src/content/aisearch.js).
 *
 * The DOM below is built from what was read off the live page, not from a
 * guess at what LinkedIn might be rendering:
 *
 *   route            /jobs/search-results/
 *   list container   [data-testid="lazy-column"][componentkey="SearchResultsMainContent"]
 *   card             [role="button"][componentkey^="job-card-component-ref-"]
 *   job id           the digits in componentkey (job-card-component-ref-4401002774)
 *   selected job     the ONLY a[href*="/jobs/view/"] on the page
 *   description      the container of the h2 whose text is "About the job"
 *
 * Two properties of that shape are what the classic collector could not
 * survive, and they are what most of this suite is about:
 *
 *   1. Cards carry their own id but NOT a link to their job. The classic path
 *      reads ids from links, so it saw ONE id (the selected job's) shared by
 *      every card, fell back to walking by position, and could not tell a
 *      mis-selection from a slow pane.
 *   2. The list is virtualised. Cards unmount when they scroll away, so any
 *      element reference held across a click is a bug, and enumerating the
 *      list up front is impossible.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'content');
const ROOT = path.join(__dirname, '..');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

/* ---------------------------------------------------------------- fixture */

const JD_A =
  'We are looking for a Business Development Manager to own new logo acquisition ' +
  'across the northeast. You will run the full cycle from prospecting through to ' +
  'close, partnering with solutions engineering on technical evaluations and with ' +
  'marketing on campaign follow-up. Requirements: 7+ years of quota-carrying B2B ' +
  'sales experience, and travel up to 30% to customer sites. This role is remote ' +
  'with quarterly onsite planning weeks.';

const JD_B =
  'The Enterprise Account Executive owns a portfolio of strategic accounts in the ' +
  'financial services vertical. You will build multi-year expansion plans, run ' +
  'executive briefings, and coordinate renewals with customer success. ' +
  'Requirements: 10+ years of enterprise software sales, and a track record of ' +
  'six-figure deals. Travel up to 15%.';

/* A card as the live page renders it: a role="button" div carrying its own id
 * in componentkey, with NO link to the job it represents. */
function card(id, title, company, place) {
  return '<div role="button" componentkey="job-card-component-ref-' + id + '" ' +
    'class="a5b65bc4">' +
    '<span class="cc5d114c">' + title + '</span>' +
    '<span class="cc5d114c">' + company + '</span>' +
    '<span class="cc5d114c">' + place + '</span>' +
    '<button aria-label="Dismiss job">X</button>' +
    '</div>';
}

const CARDS = [
  ['4401002774', 'Business Development Manager', 'CapsLock', 'Massachusetts, United States (Remote)'],
  ['4401002775', 'Enterprise Account Executive', 'Phaxis', 'New York, NY (Hybrid)'],
  ['4401002776', 'Sales Lead', 'Anon', 'San Francisco, CA (Remote)'],
  ['4401002777', 'Business Development Executive', '40HRS New York', 'New York (Remote)'],
  ['4401002778', 'Sales Director', 'Popcorn Growth', 'United States (Remote)']
];

function slug(s) { return s.toLowerCase().replace(/\s+/g, '-'); }

/* The details pane for whichever job is selected. Only this job has a
 * /jobs/view/ link anywhere on the page. */
function pane(id, title, company, jd) {
  return '<div class="_2e9433c3">' +
    '<div class="b7c1">' +
      '<a href="/company/' + slug(company) + '/">' + company + '</a>' +
      '<a href="/jobs/view/' + id + '/?eBP=SEMANTIC_SEARCH_LANDING_PAGE">' + title + '</a>' +
      '<div class="d0e1">Massachusetts, United States &middot; 1 month ago &middot; ' +
        '12 people clicked apply</div>' +
      '<span class="f2a3">$90K/yr - $120K/yr</span>' +
      '<span class="f2a3">Remote</span>' +
      '<span class="f2a3">Full-time</span>' +
      '<a class="g4b5" href="https://employer.example/apply/' + id + '">Apply</a>' +
    '</div>' +
    '<div class="h6c7">Your profile and resume are missing some required qualifications. ' +
      'Show match details. BETA - Are these results helpful?</div>' +
    '<div class="i8d9">Job search faster with Premium. Access company insights like ' +
      'strategic priorities, headcount trends and hiring patterns before you apply.</div>' +
    '<h2 class="j0e1">About the job</h2>' +
    '<div class="k2f3">' + jd + '</div>' +
    '<div class="l4g5"><h3>About the company</h3>' +
      '<a href="/company/' + slug(company) + '/">' + company + ' 28,506 followers</a></div>' +
  '</div>';
}

function aiPage(opts) {
  const o = opts || {};
  const mounted = o.mounted || 3;
  const selected = o.selected || CARDS[0];

  const list = CARDS.slice(0, mounted)
    .map(function (c) { return card(c[0], c[1], c[2], c[3]); }).join('');

  return load(new JSDOM('<!doctype html><html><body>' +
    '<nav id="global-nav"><h2>0 notifications</h2></nav>' +
    '<main>' +
      '<div data-testid="lazy-column" componentkey="SearchResultsMainContent" ' +
        'class="m6h7">' + list + '</div>' +
      pane(selected[0], selected[1], selected[2],
        selected[0] === '4401002775' ? JD_B : JD_A) +
    '</main></body></html>', {
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=sales&currentJobId=' +
      (o.urlId === undefined ? selected[0] : o.urlId),
    runScripts: 'outside-only'
  }));
}

/* The classic surface, so the adapter can be shown to keep its hands off it. */
function classicPage() {
  return load(new JSDOM('<!doctype html><html><body>' +
    '<div class="scaffold-layout__list"><div><ul>' +
      '<li data-occludable-job-id="9001"><a class="job-card-container__link" ' +
        'href="/jobs/view/9001/">Clinical Research Associate II</a></li>' +
      '<li data-occludable-job-id="9002"><a class="job-card-container__link" ' +
        'href="/jobs/view/9002/">Senior Clinical Research Associate</a></li>' +
    '</ul></div></div>' +
    '<div class="jobs-search__job-details--container">' +
      '<div class="job-details-jobs-unified-top-card__container--two-pane">' +
        '<div class="job-details-jobs-unified-top-card__job-title"><h1>' +
          'Clinical Research Associate II</h1></div>' +
        '<div class="job-details-jobs-unified-top-card__company-name">' +
          '<a href="/company/acme-cro/">Acme CRO</a></div>' +
      '</div>' +
      '<div id="job-details"><p>' + JD_A + '</p></div>' +
    '</div></body></html>', {
    url: 'https://www.linkedin.com/jobs/search/?keywords=cra',
    runScripts: 'outside-only'
  }));
}

function load(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;

  [
    path.join(SRC, 'selectors.js'),
    path.join(ROOT, 'src', 'lib', 'aiPlan.js'),
    path.join(SRC, 'aiassist.js'),
    path.join(SRC, 'parse.js'),
    path.join(SRC, 'extract.js'),
    path.join(SRC, 'aisearch.js')
  ].forEach(function (f) {
    dom.window.eval(fs.readFileSync(f, 'utf8'));
  });
  return dom.window;
}

/* ------------------------------------------------------ route detection -- */

console.log('--- 1. which collector owns the page ---');

let win = aiPage();
let A = win.JDC_AISEARCH;

check('the AI route is recognised', A.onRoute(), true);
check('and the adapter claims the page', A.applies(), true);

const classic = classicPage();
check('the classic route is not the AI route', classic.JDC_AISEARCH.onRoute(), false);
check('and the adapter does NOT claim a classic page', classic.JDC_AISEARCH.applies(), false);
check('the classic collector still resolves its own list',
  !!classic.JDC_SEL.q(classic.JDC_SEL.SEL.list), true);
check('and its own description', classic.JDC_EX.descriptionEl().id, 'job-details');

/* Route alone is not enough: LinkedIn can serve the classic layout under a new
 * path, and an adapter that answered on the route would report an empty page
 * as fact rather than handing back to the collector that works. */
const bareRoute = load(new JSDOM('<!doctype html><html><body><main>' +
  '<div>Nothing here yet</div></main></body></html>',
  { url: 'https://www.linkedin.com/jobs/search-results/', runScripts: 'outside-only' }));
check('the route with no cards is not claimed', bareRoute.JDC_AISEARCH.applies(), false);
check('though the route itself still matches', bareRoute.JDC_AISEARCH.onRoute(), true);

/* ---------------------------------------------------------- card and id -- */

console.log('\n--- 2. ids come from componentkey, one per card ---');

win = aiPage({ mounted: 5 });
A = win.JDC_AISEARCH;

check('the list container is found', !!A.listContainer(), true);
check('every mounted card is seen', A.cards().length, 5);
check('and each carries its OWN id',
  A.mountedIds(), ['4401002774', '4401002775', '4401002776', '4401002777', '4401002778']);
check('five cards, five distinct ids', new Set(A.mountedIds()).size, 5);

/* The exact failure this adapter exists for. The classic reader looks for ids
 * on links; these cards have none, so it found the one selected job's id
 * repeated - "26 cards but only 1 distinct job id". */
const viaClassicReader = A.cards()
  .map(function (el) { return win.JDC_SEL.jobIdFromAttrs(el); });
check('the classic id reader finds nothing on these cards',
  viaClassicReader, [null, null, null, null, null]);

check('a card is re-findable by id after the list re-renders',
  A.cardById('4401002776').getAttribute('componentkey'), 'job-card-component-ref-4401002776');
check('and an unmounted id simply returns nothing', A.cardById('9999999'), null);
check('a card with no componentkey yields no id',
  A.cardId(win.document.querySelector('nav')), null);

/* ------------------------------------------------------------ selection -- */

console.log('\n--- 3. only the selected job exposes /jobs/view/ ---');

check('exactly one such link on the page',
  win.document.querySelectorAll('a[href*="/jobs/view/"]').length, 1);
check('the selected id is read from it', A.selectedJobId(), '4401002774');
check('the selected card is confirmed', A.showsJob('4401002774'), true);
check('a card that is NOT selected is not', A.showsJob('4401002775'), false);
check('nor is one that is not on the page at all', A.showsJob('9999999'), false);

/* The URL and the link can disagree for a moment - the URL is rewritten on
 * click, the pane repaints after. Either naming the job is enough. */
const urlOnly = aiPage({ selected: CARDS[0], urlId: '4401002775' });
check('the URL alone can confirm a job', urlOnly.JDC_AISEARCH.showsJob('4401002775'), true);
check('and so can the link alone', urlOnly.JDC_AISEARCH.showsJob('4401002774'), true);
check('a job named by neither is refused', urlOnly.JDC_AISEARCH.showsJob('4401002776'), false);

/* ---------------------------------------------------------------- fields -- */

console.log('\n--- 4. the fields, from structure rather than hashed classes ---');

win = aiPage({ mounted: 5 });
A = win.JDC_AISEARCH;

check('the "About the job" heading is found', !!A.descriptionHeading(), true);
check('it is a real heading, not a div that says the words',
  A.descriptionHeading().tagName, 'H2');

const desc = A.descriptionEl();
check('the description is the block under it',
  /own new logo acquisition/.test(desc.textContent), true);
check('it is not the Premium upsell', /Job search faster/.test(desc.textContent), false);
check('nor the profile-match panel', /missing some required/.test(desc.textContent), false);
check('nor the results list', /Enterprise Account Executive/.test(desc.textContent), false);

check('the title comes from the selected /jobs/view/ link',
  win.JDC_EX.text(A.titleEl()), 'Business Development Manager');
check('the company comes from the header region', A.companyEl().textContent, 'CapsLock');
check('with no follower count', /followers/.test(win.JDC_SEL.companyText(A.companyEl())), false);

const region = A.headerRegion();
check('the header region holds the title', region.contains(A.titleEl()), true);
check('and does not hold the results list', region.contains(A.listContainer()), false);
check('nor the description', region.contains(desc), false);

/* ------------------------------------------------------------ the job ----- */

console.log('\n--- 5. the assembled job ---');

const job = A.extract('4401002774', {});

check('id', job.jobId, '4401002774');
check('title', job.title, 'Business Development Manager');
check('company', job.company, 'CapsLock');
check('url', job.url, 'https://www.linkedin.com/jobs/view/4401002774/');
check('location, off the meta line', job.location, 'Massachusetts, United States');
check('posted age', job.postedDaysAgo, 30);
check('applicants', job.applicants, 12);
check('workplace type, from the pill', job.workplaceType, 'Remote');
check('employment type', job.employmentType, 'Full-time');
check('pay, from the pill and not the posting', job.payMinAnnual, 90000);
check('top of the range', job.payMaxAnnual, 120000);
check('pay source is the pill', job.paySource, 'pill');
check('apply route', job.applyType, 'external');
check('apply url', job.applyUrl, 'https://employer.example/apply/4401002774');
check('years required, parsed from the posting', job.yoeMin, 7);
check('travel, parsed from the posting', job.travelPct, 30);
check('the description is the posting', /quota-carrying B2B sales/.test(job.description), true);
check('and nothing else', /Premium|notifications|Dismiss/.test(job.description), false);

/* The same builder the classic path uses, so the two can never drift on pay,
 * flags or the shape of a row. */
check('the row has the same keys a classic row does',
  ['jobId', 'title', 'company', 'description', 'payMinAnnual', 'applyType',
    'workplaceType', 'collectedAt'].every(function (k) { return k in job; }), true);

/* ------------------------------------------------------- virtualisation --- */

console.log('\n--- 6. the virtualised list ---');

win = aiPage({ mounted: 3 });
A = win.JDC_AISEARCH;
const seen = new Set();

A.mountedIds().forEach(function (id) { seen.add(id); });
check('three cards mounted to begin with', seen.size, 3);

/* Scrolling mounts two more and unmounts the first - which is exactly why no
 * element reference may be held across a click. */
const list = win.document.querySelector('[componentkey="SearchResultsMainContent"]');
list.removeChild(list.firstElementChild);
list.insertAdjacentHTML('beforeend', card(CARDS[3][0], CARDS[3][1], CARDS[3][2], CARDS[3][3]));
list.insertAdjacentHTML('beforeend', card(CARDS[4][0], CARDS[4][1], CARDS[4][2], CARDS[4][3]));

const after = A.mountedIds();
check('the first card is gone', after.indexOf('4401002774'), -1);
check('two new ones arrived',
  after.indexOf('4401002777') !== -1 && after.indexOf('4401002778') !== -1, true);

const fresh = after.filter(function (id) { return !seen.has(id); });
check('only the new ids are pending', fresh, ['4401002777', '4401002778']);
fresh.forEach(function (id) { seen.add(id); });
check('the Set has every id seen across both states', seen.size, 5);
check('and a second pass finds nothing new',
  A.mountedIds().filter(function (id) { return !seen.has(id); }), []);

console.log('\n--- 7. the scroll container is the list, not the document ---');

/* jsdom reports every element as zero-height, so the real measurement is
 * stubbed - what is under test is that the lazy column is preferred over the
 * document when it is the thing that scrolls. */
Object.defineProperty(list, 'scrollHeight', { value: 4000, configurable: true });
Object.defineProperty(list, 'clientHeight', { value: 800, configurable: true });
list.style.overflowY = 'auto';
check('the lazy column is chosen', A.scrollContainer(), list);

Object.defineProperty(list, 'scrollHeight', { value: 0, configurable: true });
check('and the document is the fallback, never a silent failure',
  A.scrollContainer() === win.document.scrollingElement ||
  A.scrollContainer() === win.document.documentElement, true);

/* ---------------------------------------------------------- diagnostics -- */

console.log('\n--- 8. the diagnostic names every step ---');

win = aiPage({ mounted: 5 });
const report = win.JDC_AISEARCH.report();
[
  'route matches:',
  'adapter applies:',
  'list container:',
  'scroll container:',
  'cards mounted now:',
  'selected job id:',
  '"About the job":',
  'description:',
  'header region:'
].forEach(function (label) {
  check('  reports ' + JSON.stringify(label), report.indexOf(label) !== -1, true);
});
check('and it degrades rather than throwing on a bare page',
  typeof bareRoute.JDC_AISEARCH.report(), 'string');

/* ------------------------------------- the heading's grandparent --------- */

console.log('\n--- 9. the posting is not always the heading\'s sibling ---');

/* The reported failure, exactly: cards discovered, clicks working,
 * currentJobId matching the selected /jobs/view/ link, title present, "About
 * the job" present, 2,500-4,800 characters of description on screen - and
 * every job marked Failed.
 *
 * The h2 is alone inside its own wrapper. Its siblings are empty and its
 * parent holds nothing but the label, so a search that stops one level up
 * finds nothing and the job never reaches extraction. The posting hangs off
 * the wrapper's PARENT. */
function nestedPage(opts) {
  return load(new JSDOM('<!doctype html><html><body><main>' +
    '<div data-testid="lazy-column" componentkey="SearchResultsMainContent">' +
      card('4401002774', 'Business Development Manager', 'CapsLock', 'Remote') +
      card('4401002775', 'Enterprise Account Executive', 'Phaxis', 'Hybrid') +
      card('4401002776', 'Sales Lead', 'Anon', 'Remote') +
    '</div>' +
    '<div class="pane">' +
      '<div class="hdr">' +
        '<a href="/company/capslock/">CapsLock</a>' +
        '<a href="/jobs/view/4401002774/?eBP=SEMANTIC_SEARCH_LANDING_PAGE">' +
          'Business Development Manager</a>' +
        '<div>Massachusetts, United States &middot; 1 month ago &middot; ' +
          '12 people clicked apply</div>' +
        '<span>$90K/yr - $120K/yr</span><span>Remote</span><span>Full-time</span>' +
      '</div>' +
      /* Deliberately OUTSIDE the header region, which is where it sits on the
       * live page - the header came back as 194 characters there and did not
       * contain the Apply control at all. */
      '<div class="actions">' + (opts && opts.easyApply
        ? '<button aria-label="Easy Apply to Business Development Manager">Easy Apply</button>'
        : '<a href="https://employer.example/apply/1">Apply</a>') + '</div>' +
      '<div class="descroot">' +
        '<div class="headingwrap"><h2>About the job</h2></div>' +
        '<div class="bodywrap"><p>' + JD_A + '</p></div>' +
      '</div>' +
    '</div></main></body></html>', {
    url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4401002774',
    runScripts: 'outside-only'
  }));
}

const nested = nestedPage();
const N = nested.JDC_AISEARCH;

check('the heading is found', !!N.descriptionHeading(), true);
check('it has no useful siblings',
  N.descriptionHeading().nextElementSibling, null);
check('and its parent holds nothing but the label',
  nested.JDC_EX.text(N.descriptionHeading().parentElement), 'About the job');

/* This is the line that failed for every job. */
const nestedFound = N.findDescription();
check('the posting is still found, one level further out', !!nestedFound, true);
check('via the ancestor walk', nestedFound.via, 'h2 "About the job", ancestor +2');
check('and it is the whole posting',
  /own new logo acquisition/.test(N.descriptionText()) &&
  /quota-carrying B2B sales/.test(N.descriptionText()), true);
check('with the label stripped off the front',
  /^About the job/i.test(N.descriptionText()), false);
check('at a realistic length', N.descriptionText().length > 300, true);

/* And the walk still refuses to widen into the results list. */
check('it never reaches the rail',
  /Enterprise Account Executive/.test(N.descriptionText()), false);

console.log('\n--- 10. the validator names what is missing ---');

const goodParts = N.parts();
const okv = N.validate('4401002774', goodParts);
check('a complete job validates', okv.ok, true);
check('with nothing missing', okv.missing, []);
check('and reports the href it checked',
  /\/jobs\/view\/4401002774\//.test(okv.href), true);

const wrongJob = N.validate('4401002775', goodParts);
check('the selected link naming another job fails', wrongJob.ok, false);
check('and says which', wrongJob.missing,
  ['titleLink.href names 4401002774, not 4401002775']);

const noDesc = N.validate('4401002774', { title: 'x', description: 'too short' });
check('a description under the floor fails', noDesc.ok, false);
check('and reports the length it got', noDesc.missing, ['description>100 (got 9)']);

const nothing = N.validate('4401002774', {});
check('an empty extraction names every missing field',
  nothing.missing, ['title', 'description>100 (got 0)']);

console.log('\n--- 11. lengths are reported, never contents ---');
const L = N.lengths(goodParts);
check('the keys are the ones the log promises',
  Object.keys(L).sort(),
  ['companyLength', 'descriptionLength', 'locationLength', 'pillCount', 'titleLength']);
check('title length', L.titleLength, 'Business Development Manager'.length);
check('description length is real', L.descriptionLength > 300, true);
check('and no field carries the text itself',
  Object.keys(L).every(function (k) { return typeof L[k] === 'number'; }), true);

/* -------------------------------------------- one job, all eight stages -- */

console.log('\n--- 12. one job, traced through every stage ---');

(async function () {
  const dom = new JSDOM(nested.document.documentElement.outerHTML, {
    url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4401002774',
    runScripts: 'outside-only'
  });

  const SENT = [];
  dom.window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: function () {} },
      sendMessage: function (msg, cb) {
        SENT.push(msg);
        if (!cb) return;
        if (msg.type === 'JDC_JOBS') return cb({ ok: true, received: msg.jobs.length, buffered: 1, collected: 1 });
        /* Not active: content.js resumes a run on load if the worker says one
         * is in progress, and a whole collection starting up underneath this
         * test would send saves of its own. */
        if (msg.type === 'JDC_IS_ACTIVE') return cb({ active: false, state: {}, config: {} });
        cb({ ok: true });
      }
    },
    storage: {
      local: {
        get: function (k, cb) { return cb ? cb({}) : Promise.resolve({}); },
        set: function (o, cb) { return cb ? cb() : Promise.resolve(); }
      }
    }
  };

  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;

  [
    path.join(SRC, 'selectors.js'),
    path.join(ROOT, 'src', 'lib', 'aiPlan.js'),
    path.join(SRC, 'aiassist.js'),
    path.join(SRC, 'parse.js'),
    path.join(SRC, 'extract.js'),
    path.join(SRC, 'aisearch.js'),
    path.join(SRC, 'content.js')
  ].forEach(function (f) { dom.window.eval(fs.readFileSync(f, 'utf8')); });

  const T = dom.window.__JDC_TEST;
  const A2 = dom.window.JDC_AISEARCH;

  const t = await T.collectOneAiJob(A2, '4401002774', {});

  check('the job is collected, not failed', t.status, 'collected');
  check('with no reason to report', t.reason, null);

  const names = t.stages.map(function (s) { return s.stage; });
  ['CARD_DISCOVERED', 'CARD_CLICKED', 'SELECTION_SYNCED', 'EXTRACTED',
    'VALIDATED', 'PAYLOAD', 'SAVE_RESPONSE', 'STATUS'].forEach(function (name) {
    check('  stage ' + name, names.indexOf(name) !== -1, true);
  });

  const by = {};
  t.stages.forEach(function (s) { by[s.stage] = s; });

  check('the card was found by componentkey',
    by.CARD_DISCOVERED.componentkey, 'job-card-component-ref-4401002774');
  check('the selection synchronised', by.SELECTION_SYNCED.synced, true);
  check('and both signals agree',
    [by.SELECTION_SYNCED.currentJobId, by.SELECTION_SYNCED.selectedLinkId],
    ['4401002774', '4401002774']);

  check('EXTRACTED reports lengths, not text',
    typeof by.EXTRACTED.descriptionLength, 'number');
  check('  and a real description length', by.EXTRACTED.descriptionLength > 300, true);
  check('  and which route found it', by.EXTRACTED.descriptionVia, 'h2 "About the job", ancestor +2');
  check('  it carries no description text',
    JSON.stringify(by.EXTRACTED).indexOf('quota-carrying') , -1);

  check('PAYLOAD lists field names', by.PAYLOAD.fields.indexOf('jobId') !== -1, true);
  check('  including the description', by.PAYLOAD.fields.indexOf('description') !== -1, true);
  check('  but not the description itself',
    JSON.stringify(by.PAYLOAD).indexOf('quota-carrying'), -1);

  check('SAVE_RESPONSE reports a status', by.SAVE_RESPONSE.status, 'ok');
  check('  and the response body', by.SAVE_RESPONSE.body,
    { ok: true, received: 1, buffered: 1, collected: 1 });

  const saved = SENT.filter(function (m) { return m.type === 'JDC_JOBS'; });
  check('exactly one job was sent to the worker', saved.length, 1);
  check('and it is the one that was traced', saved[0].jobs[0].jobId, '4401002774');

  console.log('\n--- 13. a failure names its stage and its reason ---');

  /* Same pipeline, description removed: the failure must say what was missing
   * rather than becoming a bare "Failed". */
  dom.window.document.querySelector('.bodywrap').remove();
  const bad = await T.collectOneAiJob(A2, '4401002775', {});

  check('it fails', bad.status, 'failed');
  check('at validation, or before extraction can help it',
    ['VALIDATION_FAILED', 'SELECTION_FAILED'].indexOf(
      bad.stages[bad.stages.length - 1].stage) !== -1, true);
  check('and the reason is specific, not "Failed"',
    /missing|selection never became/.test(bad.reason), true);
  check('nothing was saved for it',
    SENT.filter(function (m) { return m.type === 'JDC_JOBS'; }).length, 1);

  console.log('\n--- 14. the description survives the heading changing ---');

  /* Fourteen jobs in one run failed with an empty description while a full
   * posting was on screen. Whatever the heading was doing at that moment, an
   * exact-match h2 was the single point of failure for the whole extractor. */

  const suffixed = nestedPage();
  suffixed.document.querySelector('.headingwrap h2').textContent = 'About the job ';
  check('a heading with trailing space still matches',
    !!suffixed.JDC_AISEARCH.findHeading(), true);

  suffixed.document.querySelector('.headingwrap h2').textContent = 'About this role';
  const family = suffixed.JDC_AISEARCH.findDescription();
  check('so does a heading from the same family', !!family, true);
  check('and it is reported as such', family.via, 'heading, about-the-job family, ancestor +2');

  /* The heading gone entirely - the case no landmark can survive. */
  const headless = nestedPage();
  headless.document.querySelector('.headingwrap').remove();
  check('no heading at all', !!headless.JDC_AISEARCH.findHeading(), false);

  const bulk = headless.JDC_AISEARCH.findDescription();
  check('the posting is found anyway', !!bulk, true);
  check('by measurement rather than by landmark',
    bulk.via, 'largest block in the pane (no heading)');
  check('and it is the posting, not the header',
    /quota-carrying B2B sales/.test(headless.JDC_AISEARCH.descriptionText()), true);
  check('nor the results rail',
    /Enterprise Account Executive/.test(headless.JDC_AISEARCH.descriptionText()), false);
  check('so the job still validates',
    headless.JDC_AISEARCH.validate('4401002774', headless.JDC_AISEARCH.parts()).ok, true);

  console.log('\n--- 15. the apply route, from the pane and not the header ---');

  /* The header region came back as 194 characters on the live page and did not
   * contain the Apply control, so every job reported applyType "unknown". */
  const direct = nestedPage();
  const D = direct.JDC_AISEARCH;
  check('the header region really is too small to hold it',
    D.headerRegion().querySelector('a[href*="employer.example"]'), null);
  check('but the pane holds it',
    !!D.paneRoot().querySelector('a[href*="employer.example"]'), true);

  const directJob = D.extract('4401002774', {});
  check('a direct apply is recognised', directJob.applyType, 'external');
  check('with the employer url', directJob.applyUrl, 'https://employer.example/apply/1');

  const easy = nestedPage({ easyApply: true });
  const easyJob = easy.JDC_AISEARCH.extract('4401002774', {});
  check('Easy Apply is told apart from it', easyJob.applyType, 'easy_apply');
  check('and carries no employer url', easyJob.applyUrl, '');

  console.log('\n--- 16. a control that loads more results is found by text ---');

  const T2 = dom.window.__JDC_TEST;
  const listEl = dom.window.document.querySelector('[componentkey="SearchResultsMainContent"]');
  const wrap = listEl.parentElement;

  check('nothing to click when there is nothing', T2.aiLoadMoreControl(A2), null);

  wrap.insertAdjacentHTML('beforeend', '<button>Dismiss</button>');
  check('an unrelated button is not it', T2.aiLoadMoreControl(A2), null);

  wrap.insertAdjacentHTML('beforeend', '<button>Show more results</button>');
  const moreBtn = T2.aiLoadMoreControl(A2);
  check('but a "Show more results" control is',
    moreBtn && moreBtn.textContent, 'Show more results');

  console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
})();
