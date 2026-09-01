/* LinkedIn's AI job search, reconstructed from a screenshot of the real page.
 *
 * The layout it captures, and why each part matters:
 *
 *   - Two panes. The list on the left, details on the right, sharing NO class
 *     names with the classic layout - so every known selector misses and the
 *     fallbacks have to carry it.
 *   - Cards link via ?currentJobId= rather than /jobs/view/{id}, and each has
 *     a dismiss "X" button.
 *   - The details pane puts three interstitial cards between the header and the
 *     job description: a profile-match panel, a "personalized tips" upsell and
 *     a Premium upsell. The densest-block heuristic will happily swallow those
 *     into the middle of the description; the "About the job" text anchor will
 *     not. That is the distinction this suite exists to pin.
 *   - The description is CLIPPED with an inline "… more" rather than the
 *     classic footer button. Missing it captures a JD cut off mid-sentence,
 *     which loses exactly the requirements half the vetting depends on.
 *   - The visible "About the job" label can itself be a plain div rather than
 *     a heading, with a separate content-less heading of the same text sitting
 *     elsewhere for screen readers only (a real diagnostic, 2026-08-26). See
 *     pageWithA11yOnlyLabel() below.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'content');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

const JD_VISIBLE =
  'For our client, we are seeking a Director Strategy & Planning to join the team of a ' +
  'leader in the Telecommunications & Hardware space. This role will drive strategic ' +
  'priorities, executive-level problem solving, and cross-functional execution on ' +
  'initiatives that matter most to the business. You will partner with senior leaders ' +
  'and teams across the organization to clarify priorities, coordinate complex work, ' +
  'and turn strategic decisions into measurable action.';

const JD_HIDDEN =
  'Requirements: 10+ years of experience in strategy or consulting. Travel up to 25%. ' +
  'This position offers the opportunity to strengthen operating cadence, decision ' +
  'quality, and enterprise execution across the portfolio.';

/* Deliberately unrecognisable class names: this surface shares none with the
 * classic layout, which is the whole problem. */
function page(opts) {
  const o = opts || {};
  const clipped = o.clipped !== false;

  return new JSDOM(`<!doctype html><html><body>
    <div class="srch-shell">

      <div class="srch-rail">
        <ul class="srch-list">
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000001">
              Director, Strategy &amp; Planning</a>
            <span class="srch-card__sub">Ladders</span>
            <span class="srch-card__loc">United States (Remote)</span>
            <span class="srch-card__pay">$200.6K/yr - $258.4K/yr</span>
            <button class="srch-card__dismiss" aria-label="Dismiss">X</button>
          </li>
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000002">
              Director - New Business Sales</a>
            <span class="srch-card__sub">Infosys BPM</span>
            <button class="srch-card__dismiss" aria-label="Dismiss">X</button>
          </li>
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000003">
              SASE Sales Director</a>
            <span class="srch-card__sub">Hewlett Packard Enterprise</span>
            <button class="srch-card__dismiss" aria-label="Dismiss">X</button>
          </li>
        </ul>
        <div class="srch-alerts">Get job alerts for this search</div>
      </div>

      <div class="srch-detail">
        <a class="srch-detail__co" href="/company/ladders-inc/">Ladders</a>
        <h2 class="srch-detail__title">Director, Strategy &amp; Planning</h2>
        <div class="srch-detail__meta">United States · 6 hours ago · 5 people clicked apply</div>
        <div class="srch-detail__pills">
          <span>$200.6K/yr - $258.4K/yr</span><span>Remote</span><span>Full-time</span>
        </div>
        <button class="srch-apply">Apply</button>

        <section class="srch-card-panel">
          <h3>Your profile and resume are missing some required qualifications</h3>
          <button>Show match details</button>
          <p>BETA • Is this information helpful? Lorem ipsum padding text to give this
             interstitial panel enough length that a density heuristic might prefer it,
             repeated so it is not trivially short compared with the real description
             block further down the pane.</p>
        </section>

        <section class="srch-card-panel">
          <h3>Get personalized tips to stand out to hirers</h3>
          <p>Find jobs where you're a top applicant and tailor your resume with the help
             of AI. Try Premium for Rs 0. More padding so this block is not dismissed
             purely on length by any heuristic under test here.</p>
        </section>

        <h2 class="srch-about">About the job</h2>
        <div class="srch-jd">
          <p>${JD_VISIBLE}</p>
          ${clipped
            ? '<span class="srch-jd__clip" role="button">… more</span>'
            : `<p>${JD_HIDDEN}</p>`}
        </div>

        <section class="srch-card-panel">
          <h3>Job search faster with Premium</h3>
          <p>Access company insights like strategic priorities, headcount trends, and
             more. Carl and millions of other members use Premium. Try Premium for Rs 0.
             Padding text so this trailing upsell is a serious density candidate too.</p>
        </section>
      </div>

    </div>
  </body></html>`, { url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4101000001' });
}

/* Reproduced from a real diagnostic (2026-08-26): LinkedIn now renders the
 * visible "About the job" label as a plain, unstyled-by-role <div> for
 * sighted users, and puts a SEPARATE, content-less <h2> with the same text
 * next to it for screen readers only. The old heading-only scan locked onto
 * that empty <h2>, found no qualifying sibling or parent text next to IT, and
 * gave up - falling through to the density heuristic, which happily swallowed
 * the Premium upsells and profile-match nudges into the exported description. */
function pageWithA11yOnlyLabel() {
  return new JSDOM(`<!doctype html><html><body>
    <div class="srch-shell">

      <!-- A real rail, exactly like page() - without it, genericListRootAny()
           falls through to shape discovery, which mistakes the interstitial
           <section> panels below for a repeated job list and excludes the
           whole detail pane. This is what keeps the fixture honest. -->
      <div class="srch-rail">
        <ul class="srch-list">
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000009">
              Director, Strategy &amp; Planning</a>
            <span class="srch-card__sub">Ladders</span>
          </li>
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000010">
              Director - New Business Sales</a>
            <span class="srch-card__sub">Infosys BPM</span>
          </li>
        </ul>
      </div>

      <div class="srch-detail">

        <!-- Screen-reader-only heading: same text, genuinely nothing useful near it. -->
        <div class="a11y-skip"><h2 class="visually-hidden">About the job</h2></div>

        <div class="srch-detail__co">Ladders</div>
        <h1 class="srch-detail__title">Director, Strategy &amp; Planning</h1>
        <button class="srch-apply">Apply</button>

        <section class="srch-card-panel">
          <h3>Your profile and resume are missing some required qualifications</h3>
          <p>BETA • Is this information helpful? Lorem ipsum padding text to give this
             interstitial panel enough length that a density heuristic might prefer it.</p>
        </section>

        <section class="srch-card-panel">
          <h3>Get personalized tips to stand out to hirers</h3>
          <p>Find jobs where you're a top applicant and tailor your resume with the help
             of AI. Try Premium for Rs 0. More padding so this block is not dismissed
             purely on length by any heuristic under test here.</p>
        </section>

        <section class="srch-card-panel">
          <h3>Interested in working with us in the future?</h3>
          <p>Join our talent community so recruiters can reach you about roles like this
             one. Padding text so this panel is a serious density candidate too.</p>
        </section>

        <!-- The REAL, visible label: a plain div, no heading role at all. -->
        <div class="srch-about-visible">About the job</div>
        <div class="srch-jd">
          <p>${JD_VISIBLE}</p>
          <p>${JD_HIDDEN}</p>
        </div>

        <section class="srch-card-panel">
          <h3>Job search faster with Premium</h3>
          <p>Access company insights like strategic priorities, headcount trends, and
             more. Try Premium for Rs 0. Padding text so this trailing upsell is a
             serious density candidate too.</p>
        </section>

      </div>
    </div>
  </body></html>`, { url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4101000009' });
}

/* Verified live: on the AI job search there is no <h1> anywhere on the page,
 * and the global nav renders a real, non-decorative <h2>0 notifications</h2>
 * for the bell icon - the very first heading in document order. A
 * document-wide "first short heading" search locked onto that instead of the
 * job's own title, so every collected job got "0 notifications" as its title. */
function pageWithGlobalNavNotification() {
  return new JSDOM(`<!doctype html><html><body>
    <nav id="global-nav">
      <ul>
        <li><a href="/notifications/"><h2>0 notifications</h2></a></li>
        <li><a href="/messaging/"><h2>3 unread messages</h2></a></li>
      </ul>
    </nav>
    <div class="srch-shell">
      <div class="srch-rail">
        <ul class="srch-list">
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000012">
              Director, Strategy &amp; Planning</a>
            <span class="srch-card__sub">Ladders</span>
          </li>
          <li class="srch-card">
            <a class="srch-card__link" href="/jobs/search-results/?currentJobId=4101000013">
              Director - New Business Sales</a>
            <span class="srch-card__sub">Infosys BPM</span>
          </li>
        </ul>
      </div>
      <div class="srch-detail">
        <a class="srch-detail__co" href="/company/ladders-inc/">Ladders</a>
        <h2 class="srch-detail__title">Director, Strategy &amp; Planning</h2>
        <div class="srch-detail__meta">United States · 6 hours ago · 5 people clicked apply</div>
        <button class="srch-apply">Apply</button>
        <h2 class="srch-about">About the job</h2>
        <div class="srch-jd"><p>${JD_VISIBLE}</p><p>${JD_HIDDEN}</p></div>
      </div>
    </div>
  </body></html>`, { url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4101000012' });
}

function load(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  /* extract.js resolves apply hrefs against location.href; without this the
   * URL constructor throws and a real employer link comes back empty. */
  global.location = dom.window.location;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;

  dom.window.chrome = {
    runtime: { sendMessage: (m, cb) => { if (cb) cb({}); }, onMessage: { addListener: () => {} }, lastError: null },
    storage: { local: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: (o, cb) => (cb ? cb() : Promise.resolve()) } }
  };

  for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
    dom.window.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  }
  return dom.window;
}

/* ------------------------------------------------------------------ list --- */

console.log('--- the card list is found with no known class names ---');

let win = load(page());
let SEL = win.JDC_SEL;
let EX = win.JDC_EX;

const cards = SEL.genericCards();
check('three cards found', cards.length, 3);

/* These cards carry no /jobs/view/ href and no data-job-id - identity is only
 * in the query string, which is the case that used to report "no job id" for a
 * list that was in fact fully identified. */
const ids = cards.map(function (c) {
  const a = c.querySelector(SEL.JOB_CANDIDATE_SELECTOR) || c;
  return SEL.jobIdFromAttrs(a);
});
check('every card yields an id from ?currentJobId=', ids,
  ['4101000001', '4101000002', '4101000003']);

/* ---------------------------------------------------------- description --- */

console.log('\n--- the description comes from the "About the job" anchor ---');

const anchored = SEL.headingAnchoredDescription(SEL.genericListRootAny());
check('an anchored block was found', !!anchored, true);
check('and it is the JD container, not a panel',
  anchored && anchored.className, 'srch-jd');

const el = EX.descriptionEl();
check('descriptionEl picks the same block', el && el.className, 'srch-jd');

const text = EX.htmlToText(el);
check('the real description is in it', /seeking a Director Strategy & Planning/.test(text), true);

/* The point of the anchor: none of the three upsell panels bleed in. */
console.log('\n--- the interstitial panels are excluded ---');
check('no profile-match panel', /missing some required qualifications/.test(text), false);
check('no "personalized tips" upsell', /personalized tips to stand out/.test(text), false);
check('no Premium upsell', /Job search faster with Premium/.test(text), false);
check('no "Try Premium" copy at all', /Try Premium/.test(text), false);
check('no BETA feedback prompt', /Is this information helpful/.test(text), false);

/* Density alone would have picked something wider - that is why the anchor is
 * consulted first. */
console.log('\n--- density alone is not good enough here ---');
const dense = SEL.genericDescription(SEL.genericListRootAny());
check('the density heuristic does find something', !!dense, true);
check('but it reaches wider than the JD',
  dense === el ? 'same block' : 'a different, wider block', 'a different, wider block');
check('and it would have dragged the upsells in',
  /Try Premium/.test(EX.htmlToText(dense)), true);

/* ------------------------------------------------------------ show more --- */

console.log('\n--- the inline "… more" is found, not just the footer button ---');

const more = SEL.genericShowMore(el);
check('an expander was found', !!more, true);
check('it is the inline clip control', more && more.className, 'srch-jd__clip');

check('plain "more"', !!SEL.genericShowMore(
  load(new JSDOM('<div><button>more</button></div>')).document.body), true);
check('"See more"', !!SEL.genericShowMore(
  load(new JSDOM('<div><button>See more</button></div>')).document.body), true);
check('"Show more"', !!SEL.genericShowMore(
  load(new JSDOM('<div><button>Show more</button></div>')).document.body), true);
check('an unrelated button is not an expander', SEL.genericShowMore(
  load(new JSDOM('<div><button>Apply</button></div>')).document.body), null);
check('a long paragraph containing the word "more" is not one', SEL.genericShowMore(
  load(new JSDOM('<div><button>Learn more about our benefits programme</button></div>')).document.body), null);

/* ------------------------------------------------------- expanded state --- */

console.log('\n--- once expanded, the clipped half is captured ---');

win = load(page({ clipped: false }));
EX = win.JDC_EX;
const full = EX.htmlToText(EX.descriptionEl());
check('the visible half is present', /seeking a Director Strategy/.test(full), true);
check('and the previously clipped half too', /10\+ years of experience/.test(full), true);
check('including the travel requirement', /Travel up to 25%/.test(full), true);
check('still no upsell text', /Try Premium/.test(full), false);

/* The clipped half is where the requirements live, so this is the difference
 * between a JD worth vetting and one that is not. */
console.log('\n--- and the parsers can read the recovered half ---');
const PARSE = win.JDC_PARSE;
check('the parse layer is loaded', !!PARSE, true);

/* --------------------------------------------------------------- title ---- */

console.log('\n--- the title and apply control still resolve ---');
win = load(page());
SEL = win.JDC_SEL;
EX = win.JDC_EX;
const title = EX.text(EX.titleEl());
check('a title was found', title.length > 0, true);
check('and it is the job title', /Director, Strategy & Planning/.test(title), true);
check('an apply control was found', !!SEL.genericApplyButton(), true);

/* ------------------------------------------------------------- pills ------ */

/* The reported symptom: turn on every workplace-type filter and every job
 * comes back "Unknown". The pills in this fixture's markup sit right next to
 * each other with no separating whitespace in the source -
 * `<span>$200.6K/yr - $258.4K/yr</span><span>Remote</span><span>Full-time</span>`
 * - which glues into one run, "...yrRemoteFull-time...", when read as a block
 * of text. That defeated the word-boundary fallback regex entirely: a job
 * that plainly said Remote in the pane still came back Unknown. */
console.log('\n--- pills resolve even though the source markup glues them together ---');
win = load(page());
SEL = win.JDC_SEL;
EX = win.JDC_EX;
const pillJob = EX.extractJob('4101000001', {});
check('workplace type is read despite the glued markup', pillJob.workplaceType, 'Remote');
check('employment type too', pillJob.employmentType, 'Full-time');
check('and pay', pillJob.salary, '$200.6K/yr - $258.4K/yr');

/* -------------------------------------------------------------- company --- */

/* The reported symptom: S.company only lists classic-layout class names, none
 * of which exist here, so company was always '' and the panel rendered a
 * literal "?" on every row. A /company/ link is far more durable than a class
 * name and is exactly how a company name is marked up on every layout. */
console.log('\n--- company is captured from a /company/ link, no classic selectors present ---');
check('none of the classic company selectors are on this page',
  win.document.querySelector(SEL.SEL.company.join(', ')), null);
check('company is captured anyway', pillJob.company, 'Ladders');
check('and its URL comes from the link', pillJob.companyUrl,
  'https://www.linkedin.com/company/ladders-inc/');


/* ------------------------------------------------- the collapse case ------ */

/* Reproduced from a real diagnostic of linkedin.com/jobs/search-results/:
 *
 *     KNOWN SELECTORS      every one NO MATCH
 *     job elements on page: 6
 *     generic cards found:  1          <-- the failure
 *     REPEATED-STRUCTURE:   7 children  ul.a5b65bc4._4a49e3b8._917ab9d4
 *
 * Six job links deduped to one card because the page's links mostly carry the
 * SELECTED job's currentJobId rather than one id each - while a seven-member
 * list sat right there. Class names are build hashes, so no selector can be
 * written against them; the only durable route is shape. */

function collapsePage() {
  /* Seven real cards. Their links point at the page itself and carry the
   * currently-selected job id, exactly as the diagnostic showed - so the anchor
   * route sees many links but only one distinct id. */
  const card = function (n) {
    return '<li class="_917ab9d4">' +
      '<p class="baa0bb74 _5a9cee3b">' +
      '<a class="_2e9433c3" href="/jobs/search-results/?currentJobId=4455865679&keywords=x">' +
      'Director of Sales ' + n + '</a>' +
      '<span class="_6ae2743b">Company ' + n + '</span>' +
      '<a class="_2e9433c3" href="/jobs/search-results/?currentJobId=4455865679&keywords=x">' +
      '<span class="b28ccc25" role="button" aria-label="Dismiss">X</span></a>' +
      '</p>' +
      '<span>United States (Remote) · $200K/yr - $258K/yr · 2 days ago · Promoted</span>' +
      '</li>';
  };

  let items = '';
  for (let i = 1; i <= 7; i++) items += card(i);

  return new JSDOM('<!doctype html><html><body><main>' +
    '<div class="cc5d114c f263bf9f _2d2a0d73">' +
    '<ul class="a5b65bc4 _4a49e3b8 _917ab9d4">' + items + '</ul>' +
    '</div>' +
    '<div class="cc5d114c _7e15ae8e d496de50">' +
    '<h2>About the job</h2>' +
    '<div><p>' + JD_VISIBLE + '</p></div>' +
    '<a href="https://employer.example/careers/1234">Apply</a>' +
    '</div>' +
    '</main></body></html>',
    { url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4455865679&keywords=x&origin=SUGGESTION' });
}

console.log('\n--- six anchors, one distinct id: the reported failure ---');

win = load(collapsePage());
SEL = win.JDC_SEL;
EX = win.JDC_EX;

const anchors = SEL.jobAnchors ? SEL.jobAnchors() : [];
check('the page really does have many job links', anchors.length >= 6, true);

const distinct = new Set();
anchors.forEach(function (a) {
  const id = SEL.jobIdFromAttrs(a);
  if (id) distinct.add(id);
});
check('but they collapse to a single distinct id', distinct.size, 1);

/* Before the cross-check this returned 1. */
const found = SEL.genericCards();
check('genericCards recovers all seven anyway', found.length, 7);
check('and they are the list items, not the inner <p>',
  found[0].tagName, 'LI');

console.log('\n--- the shape route is what rescues it ---');
const shaped = SEL.genericCardsByShape();
check('shape discovery finds seven', shaped.length, 7);
check('and looksLikeJobList accepts them', SEL.looksLikeJobList(shaped), true);

/* These cards carry no usable per-card id, which is the documented trigger for
 * collecting by position - resolving each id from the URL after the click. */
const idsFound = found.map(function (el) {
  const a = el.querySelector(SEL.JOB_CANDIDATE_SELECTOR) || el;
  return SEL.jobIdFromAttrs(a);
});
check('every card resolves to the same id, so position-walking applies',
  new Set(idsFound.filter(Boolean)).size <= 1, true);

console.log('\n--- the apply link is found even with no "apply" in the href ---');
const applyEl = SEL.genericApplyButton();
check('an apply control was found', !!applyEl, true);
check('it is the employer link', applyEl && applyEl.getAttribute('href'),
  'https://employer.example/careers/1234');
check('a dismiss button is not mistaken for it',
  applyEl && /dismiss/i.test(applyEl.getAttribute('aria-label') || ''), false);

console.log('\n--- and a genuinely short page is still reported honestly ---');
win = load(new JSDOM('<!doctype html><html><body><main>' +
  '<ul><li><a href="/jobs/view/111">Only job</a><span>Some company, remote, posted today</span></li></ul>' +
  '</main></body></html>', { url: 'https://www.linkedin.com/jobs/search-results/' }));
check('one real job stays one card', win.JDC_SEL.genericCards().length, 1);


/* --------------------------------- ids that are not per-card -------------- */

/* The reported symptom: "it skips page 1 and goes to page 2, and the collected
 * jobs are not even showing".
 *
 * On this surface every card links back to the page carrying the currently
 * SELECTED job's ?currentJobId=, so eight cards yield eight ids that are all the
 * same one. The collector's page loop dedupes against its processed set, so it
 * collected exactly one job, skipped the other seven, and moved on - which from
 * the outside is indistinguishable from skipping the page.
 *
 * The decision the loop makes is reproduced here rather than driving the whole
 * content script: what matters is that DISTINCT ids, not id count, decides
 * whether a page can be walked by id at all. */

function decideRoute(cards, cardIdOf) {
  const pageIds = cards.map(cardIdOf).filter(Boolean);
  const distinctIds = new Set(pageIds).size;
  const idsArePerCard = distinctIds >= Math.max(2, Math.ceil(cards.length * 0.6));
  const byPosition = !pageIds.length || (cards.length >= 3 && !idsArePerCard);
  return { pageIds: pageIds, distinctIds: distinctIds, byPosition: byPosition };
}

console.log('\n--- eight cards sharing one job id must NOT be walked by id ---');

const sameId = new Array(8).fill(0).map(function (_, i) { return { n: i }; });
let route = decideRoute(sameId, function () { return '4455865679'; });
check('all eight produced an id', route.pageIds.length, 8);
check('but only one distinct one', route.distinctIds, 1);
check('so the page is walked by position', route.byPosition, true);

/* What the old logic would have done: eight ids is truthy, so it walked by id,
 * deduped to one, and silently dropped seven jobs. */
check('the old !pageIds.length test would have missed this',
  !route.pageIds.length, false);

console.log('\n--- a normal page is still walked by id ---');
const distinctCards = new Array(25).fill(0).map(function (_, i) { return { n: i }; });
route = decideRoute(distinctCards, function (c) { return '42660000' + c.n; });
check('25 distinct ids', route.distinctIds, 25);
check('walked by id, not position', route.byPosition, false);

console.log('\n--- partial duplication is judged on the ratio ---');
/* 10 cards, 8 distinct: LinkedIn does legitimately show the odd duplicate. */
route = decideRoute(new Array(10).fill(0).map(function (_, i) { return { n: i }; }),
  function (c) { return '4266' + Math.min(c.n, 7); });
check('8 of 10 distinct is still per-card', route.byPosition, false);

/* 10 cards, 3 distinct: that is not duplication, that is a shared id. */
route = decideRoute(new Array(10).fill(0).map(function (_, i) { return { n: i }; }),
  function (c) { return '4266' + (c.n % 3); });
check('3 of 10 distinct is not', route.byPosition, true);

console.log('\n--- a genuinely short page is not pushed down the slow path ---');
/* One card with one id is not a collapsed inference, it is a one-job search. */
route = decideRoute([{ n: 0 }], function () { return '4266000001'; });
check('one card, one id: walked by id', route.byPosition, false);
route = decideRoute([{ n: 0 }, { n: 1 }], function (c) { return '426600000' + c.n; });
check('two cards, two ids: walked by id', route.byPosition, false);

console.log('\n--- no ids at all still goes by position ---');
route = decideRoute(sameId, function () { return null; });
check('nothing to dedupe on', route.pageIds.length, 0);
check('so position it is', route.byPosition, true);

/* The shipped loop must actually contain this test, not just this file. */
console.log('\n--- the shipped collector makes the same decision ---');
const contentSrc = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
check('it counts distinct ids', /new Set\(pageIds\)\.size/.test(contentSrc), true);
check('and gates the by-id route on that',
  /idsArePerCard/.test(contentSrc), true);
check('and says so in the log',
  /distinct job id\(s\) — collecting by position/.test(contentSrc), true);

/* -------------------------------------- a11y-only heading label ----------- */

console.log('\n--- the label is a plain div, not a heading (a real diagnostic, 2026-08-26) ---');

win = load(pageWithA11yOnlyLabel());
SEL = win.JDC_SEL;
EX = win.JDC_EX;

/* Confirm the fixture actually reproduces the reported bug before trusting the
 * fix: the a11y-only heading must genuinely have no qualifying content of its
 * own, or this test proves nothing. */
const contentlessHeading = win.document.querySelector('h2.visually-hidden');
check('the a11y-only heading exists on the page', !!contentlessHeading, true);
check('it has no next sibling of its own', !!contentlessHeading.nextElementSibling, false);
check('and its wrapper is far short of the 200-char floor',
  contentlessHeading.parentElement.textContent.trim().length < 200, true);

const a11yAnchored = SEL.headingAnchoredDescription(SEL.genericListRootAny());
check('an anchored block was still found', !!a11yAnchored, true);
check('and it is the real JD container, not a panel',
  a11yAnchored && a11yAnchored.className, 'srch-jd');

const a11yEl = EX.descriptionEl();
check('descriptionEl agrees', a11yEl && a11yEl.className, 'srch-jd');

const a11yText = EX.htmlToText(a11yEl);
check('the visible half is in it', /seeking a Director Strategy & Planning/.test(a11yText), true);
check('and the previously clipped half too', /10\+ years of experience/.test(a11yText), true);

check('no profile-match panel', /missing some required qualifications/.test(a11yText), false);
check('no "personalized tips" upsell', /personalized tips to stand out/.test(a11yText), false);
check('no talent-community nudge', /Interested in working with us/.test(a11yText), false);
check('no Premium upsell', /Job search faster with Premium/.test(a11yText), false);
check('no "Try Premium" copy at all', /Try Premium/.test(a11yText), false);

/* -------------------------------------- global nav chrome, not a title ---- */

console.log('\n--- the title ignores the notifications bell in the global nav (a real diagnostic, 2026-08-26) ---');

win = load(pageWithGlobalNavNotification());
SEL = win.JDC_SEL;
EX = win.JDC_EX;

/* Confirm the fixture actually reproduces the reported bug before trusting the
 * fix: no <h1> anywhere, and the nav heading really is first in document order. */
check('there is no h1 anywhere on the page', !!win.document.querySelector('h1'), false);
const allHeadings = Array.from(win.document.querySelectorAll('h2, h3, [role="heading"]'));
check('the notifications heading really is first in document order',
  allHeadings[0] && allHeadings[0].textContent.trim(), '0 notifications');

const navTitle = EX.text(EX.titleEl());
check('the title is the job heading, not the notifications bell',
  navTitle, 'Director, Strategy & Planning');
check('and not the unread-messages heading either', /unread messages/.test(navTitle), false);

const navJob = EX.extractJob('4101000012', {});
check('extractJob agrees on the title', navJob.title, 'Director, Strategy & Planning');
check('company still resolves too', navJob.company, 'Ladders');


/* ------------------------------- the whole-page read ---------------------- */

/* Eight rows off a real run, every one of them wrong:
 *
 *   Get job alerts for this search | ?                     | Unknown | $260k-$390k/yr | 3,549 chars
 *   Get job alerts for this search | Experis               | On-site | $260k-$390k/yr | 3,549 chars
 *   Get job alerts for this search | Fenwick & West        | Unknown | $260k-$390k/yr | 3,549 chars
 *   About the job                  | ?                     | On-site | $260k-$390k/yr | 8,351 chars
 *   About the job                  | Tunnel to Towers Foundation 28,506 followers | ...
 *
 * One cause underneath all of it. No selector names the details pane on this
 * surface, so extraction fell back to `document` - and with the whole page in
 * scope the title came off the rail's alerts banner or the description's own
 * label, the company off an unrelated card or the About-the-company section
 * with its follower count attached, and the pay off whichever pill rendered
 * first, which is why one figure appears on every job in the run.
 *
 * Every field below is therefore checked for where it came FROM, not just for
 * being non-empty. The page is built with a decoy for each one.
 */

const PANE_JD =
  'We are hiring a Director of Strategy to lead enterprise planning across the ' +
  'portfolio. You will partner with senior leaders to clarify priorities, run the ' +
  'operating cadence, and turn strategic decisions into measurable action. ' +
  'Requirements: 12+ years of experience in strategy or consulting, and travel up ' +
  'to 20% to regional offices. This role reports to the Chief Strategy Officer.';

/* Enough text that the rail is a genuine contender for "densest block" - which
 * is exactly how it won on the real page. */
function railCard(n, company, pay) {
  return '<li class="_c"><a class="_l" href="/jobs/search-results/?currentJobId=4455865679">' +
    'Sales Director ' + n + '</a>' +
    '<span class="_s">' + company + '</span>' +
    '<span class="_s">United States (Remote)</span>' +
    '<span class="_s">' + pay + '</span>' +
    '<span class="_s">Be an early applicant · 6 hours ago · 12 benefits</span>' +
    '<button aria-label="Dismiss">X</button></li>';
}

function wholePage() {
  return new JSDOM('<!doctype html><html><body>' +
    '<nav id="global-nav"><h2>0 notifications</h2></nav>' +

    /* LinkedIn\'s own filter chips. Plain page furniture, outside any pane -
     * and the source of "Temporary" and "Internship" as the employment type
     * of a director role. */
    '<div class="_chips"><button>Date posted</button><button>Temporary</button>' +
    '<button>Internship</button><button>Under 10 applicants</button></div>' +

    '<main class="cc5d114c">' +

    /* The rail. Its pay pill is the one that ended up on every job, its
     * alerts banner is a real heading, and its combined text is dense enough
     * to beat the pane. */
    '<div class="_rail"><ul class="a5b65bc4">' +
      railCard(1, 'Experis', '$260K/yr - $390K/yr') +
      railCard(2, 'Fenwick &amp; West', '$260K/yr - $390K/yr') +
      railCard(3, 'Arch Capital Group Ltd.', '$260K/yr - $390K/yr') +
      railCard(4, 'US Claro', '$260K/yr - $390K/yr') +
    '</ul>' +
    '<div class="_alerts"><h3>Get job alerts for this search</h3>' +
    '<span>Be the first to know</span></div></div>' +

    '<div class="_pane">' +
      '<a class="_co" href="/company/acme-holdings/">Acme Holdings</a>' +
      '<h2 class="_ttl">Director, Enterprise Strategy</h2>' +
      '<div class="_meta">Boston, Massachusetts, United States · 6 hours ago · ' +
        '5 people clicked apply</div>' +
      '<span class="_pill">$150K/yr - $190K/yr</span><span class="_pill">Hybrid</span>' +
      '<span class="_pill">Full-time</span>' +
      '<a class="_apply" href="https://employer.example/apply/9">Apply</a>' +
      '<div class="_upsell">Job search faster with Premium</div>' +
      '<h3 class="_lbl">About the job</h3>' +
      '<div class="_jd">' + PANE_JD + '</div>' +
      /* The About-the-company card at the foot of the pane: a real /company/
       * link whose text carries a follower count. */
      '<div class="_aboutco"><h3>About the company</h3>' +
        '<a href="/company/acme-holdings/">Acme Holdings 28,506 followers</a></div>' +
    '</div></main></body></html>', {
    url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4455865679'
  });
}

console.log('\n--- every field comes out of the pane, not off the page ---');

win = load(wholePage());
const SELW = win.JDC_SEL;
const EXW = win.JDC_EX;

const paneDesc = EXW.descriptionEl();
check('the description is the posting', /Director of Strategy to lead/.test(EXW.text(paneDesc)), true);
check('and NOT the rail', /Sales Director 1/.test(EXW.text(paneDesc)), false);

const row = EXW.extractJob('4455865679', {});

check('the title is the job, not the rail\'s alerts banner', row.title, 'Director, Enterprise Strategy');
check('and not the description\'s own label', /About the job/.test(row.title), false);

check('the company is the employer', row.company, 'Acme Holdings');
check('with no follower count welded on', /followers/.test(row.company), false);
check('and it is not another card\'s company', /Experis|Fenwick/.test(row.company), false);

check('the pay is this job\'s pill', row.payMinAnnual, 150000);
check('not the rail card\'s figure', row.payMinAnnual === 260000, false);
check('the top of the range came through too', row.payMaxAnnual, 190000);

check('the workplace type is the pane\'s pill', row.workplaceType, 'Hybrid');
check('the employment type is not a filter chip', row.employmentType, 'Full-time');
check('so "Internship" never becomes the seniority of a director role',
  row.seniority, '');

check('the apply route is read', row.applyType, 'external');
check('with the employer url', row.applyUrl, 'https://employer.example/apply/9');

/* The meta line has no selector on this surface either, and without it the
 * posted-within and applicant filters have nothing to work with. */
check('the location came off the meta line', row.location, 'Boston, Massachusetts, United States');
check('so did the posted age', row.postedDaysAgo, 0);
check('and the applicant count', row.applicants, 5);

check('the years-required parse still reads the posting', row.yoeMin, 12);
check('and the travel figure', row.travelPct, 20);

console.log('\n--- the pane is found by structure, and excludes the rail ---');
const pane = SELW.genericDetailsRoot(paneDesc);
check('a pane was inferred', !!pane, true);
check('it holds the title', pane.contains(win.document.querySelector('h2._ttl')), true);
check('it does NOT hold the rail', pane.contains(win.document.querySelector('ul.a5b65bc4')), false);
check('and it is not the whole document', pane === win.document.body, false);

console.log('\n--- the rail can never be the description ---');
const rail = win.document.querySelector('div._rail');
check('a candidate containing the results list is refused',
  SELW.plausibleDescription(rail, SELW.genericListRootAny()), false);
check('the real one is accepted',
  SELW.plausibleDescription(win.document.querySelector('div._jd'), SELW.genericListRootAny()), true);

/* The check above leans on the list root having been inferred. When that
 * inference returns null - cards whose first link is the company logo, a rail
 * shaped in some new way - every guard resting on it stops guarding, and the
 * rail wins the densest-block contest again. A block holding several job
 * links is a list whatever else is known about the page, and that needs no
 * inference at all. */
check('and it is refused with NO list root inferred at all',
  SELW.plausibleDescription(rail, null), false);
check('while the posting is still accepted without one',
  SELW.plausibleDescription(win.document.querySelector('div._jd'), null), true);
check('one job link is not a list - a posting may well link to a job',
  SELW.plausibleDescription(win.document.querySelector('div._pane'), null), true);

console.log('\n--- furniture is never a job title ---');
[
  'Get job alerts for this search',
  'About the job',
  'About the company',
  'Job description',
  '0 notifications',
  'People also viewed',
  /* Collected as the title of all six jobs in a run on 2026-09-01: the
   * feedback prompt above the results. No job title is a question. */
  'Are these results helpful?',
  'Is this information helpful?',
  'How promoted jobs are ranked',
  '99+ results'
].forEach(function (t) {
  check('  refused: "' + t + '"', SELW.looksLikeATitle(t), false);
});
check('a real title passes', SELW.looksLikeATitle('Director, Enterprise Strategy'), true);
check('so does one that merely mentions a job',
  SELW.looksLikeATitle('Senior Job Architect'), true);

console.log('\n--- a follower count is stripped, not kept ---');
[
  ['Tunnel to Towers Foundation 28,506 followers', 'Tunnel to Towers Foundation'],
  ['Federal Reserve Bank of New York 173,145 followers', 'Federal Reserve Bank of New York'],
  ['Acme 12K followers', 'Acme'],
  ['Acme 1 follower', 'Acme'],
  ['Followers Media Group', 'Followers Media Group']
].forEach(function (pair) {
  const el = win.document.createElement('a');
  el.textContent = pair[0];
  check('  "' + pair[0] + '" -> "' + pair[1] + '"', SELW.companyText(el), pair[1]);
});

console.log('\n--- pills come from the header, never the posting ---');
const pills = SELW.genericPills(win.document.querySelector('div._pane'),
  win.document.querySelector('div._jd'));
check('the pane pills are there', pills.indexOf('Hybrid') !== -1, true);
check('the rail\'s pay is not', pills.indexOf('$260K/yr - $390K/yr'), -1);
check('nor is a filter chip', pills.indexOf('Internship'), -1);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
