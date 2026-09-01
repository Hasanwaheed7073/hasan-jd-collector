/* Confirms the details pane belongs to the job we clicked.
 *
 * The original check required the URL's currentJobId to change. On any surface
 * that does not rewrite the URL per selection - LinkedIn's AI job search being
 * the case that prompted this - every job would time out and the run would
 * collect nothing while reporting success. These tests pin the three
 * independent confirmations that replaced it. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'content');

function makeDom(url) {
  const dom = new JSDOM(`
    <body>
      <div class="scaffold-layout__list"><div><ul>
        <li data-occludable-job-id="9001"><a class="job-card-container__link" href="/jobs/view/9001/">Clinical Research Associate II</a></li>
        <li data-occludable-job-id="9002"><a class="job-card-container__link" href="/jobs/view/9002/">Senior Clinical Research Associate</a></li>
      </ul></div></div>
      <div class="jobs-search__job-details--container">
        <div class="job-details-jobs-unified-top-card__container--two-pane">
          <div class="job-details-jobs-unified-top-card__job-title"><h1>PLACEHOLDER</h1></div>
        </div>
        <div id="job-details"><p>PLACEHOLDER BODY</p></div>
      </div>
    </body>`, { url: url, runScripts: 'outside-only' });

  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  /* content.js now runs inside the window context, so its chrome stub has to
   * live on the window rather than on Node's global. */
  dom.window.chrome = {
    runtime: { sendMessage: (m, cb) => { if (cb) cb({}); }, onMessage: { addListener: () => {} }, lastError: null },
    storage: { local: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: (o, cb) => (cb ? cb() : Promise.resolve()) } }
  };

  for (const f of ['selectors.js', 'parse.js', 'extract.js', 'content.js']) {
    dom.window.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  }
  return dom;
}

function setPane(dom, title, body) {
  dom.window.document.querySelector('.job-details-jobs-unified-top-card__job-title h1').textContent = title;
  dom.window.document.querySelector('#job-details').innerHTML = '<p>' + body + '</p>';
}

const LONG = ' Monitor oncology trials across sites with ICH-GCP and EDC, plus enough further text to clear the minimum body length the check requires before it will believe a pane has genuinely rendered a job description.';

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
               '\n          actual   ' + JSON.stringify(actual)));
}

console.log('--- 1. the URL agrees (the classic two-pane case) ---');
let dom = makeDom('https://www.linkedin.com/jobs/search/?currentJobId=9001');
let T = dom.window.__JDC_TEST;
setPane(dom, 'Clinical Research Associate II', 'Body' + LONG);
check('confirmed by matching currentJobId',
  T.paneShowsJob('9001', 'anything|different', 'Clinical Research Associate II'), true);
// "before" must be the pane's actual current signature, otherwise the
// pane-changed check fires and the case under test never runs.
const unchanged = T.paneSignature();
check('a different job id is not confirmed by URL alone',
  T.paneShowsJob('9999', unchanged, 'Totally Unrelated Role'), false);

console.log('\n--- 2. no URL change: the pane content changing is enough ---');
dom = makeDom('https://www.linkedin.com/jobs/ai-search');
T = dom.window.__JDC_TEST;
setPane(dom, 'First Job', 'First body' + LONG);
const before = T.paneSignature();
check('a stale pane is not mistaken for the new job',
  T.paneShowsJob('9002', before, 'Senior Clinical Research Associate'), false);

setPane(dom, 'Senior Clinical Research Associate', 'Second body' + LONG);
check('once the pane swaps, it is confirmed',
  T.paneShowsJob('9002', before, 'Senior Clinical Research Associate'), true);

console.log('\n--- 3. no URL change and no swap: the title still matches ---');
dom = makeDom('https://www.linkedin.com/jobs/ai-search');
T = dom.window.__JDC_TEST;
setPane(dom, 'Clinical Research Associate II', 'Preloaded body' + LONG);
const same = T.paneSignature();
check('preloaded first card is confirmed by title',
  T.paneShowsJob('9001', same, 'Clinical Research Associate II'), true);
check('title matching is tolerant of punctuation and case',
  T.paneShowsJob('9001', same, 'clinical research associate  ii'), true);
check('a genuinely different title is not confirmed',
  T.paneShowsJob('9001', same, 'Warehouse Operative'), false);

console.log('\n--- it never confirms an empty or stub pane ---');
dom = makeDom('https://www.linkedin.com/jobs/search/?currentJobId=9001');
T = dom.window.__JDC_TEST;
setPane(dom, 'Clinical Research Associate II', 'Too short.');
check('a body under the length floor is rejected even with a matching URL',
  T.paneShowsJob('9001', 'x|y', 'Clinical Research Associate II'), false);

dom.window.document.querySelector('#job-details').remove();
check('a missing description element is rejected',
  T.paneShowsJob('9001', 'x|y', 'Clinical Research Associate II'), false);

console.log('\n--- title normalisation ---');
check('punctuation and case stripped', T.normTitle('Sr. Clinical Research Associate (II)'),
  'sr clinical research associate ii');
check('empty input', T.normTitle(''), '');
check('null input', T.normTitle(null), '');

console.log('\n--- 4. a URL that has moved ahead of the pane confirms nothing ---');

/* The failure this rule exists for. LinkedIn's AI job search rewrites
 * currentJobId the instant you click, before the pane behind it re-renders,
 * so "the URL agrees" was true while the pane still showed the PREVIOUS job.
 * A real run captured five consecutive jobs with byte-identical descriptions
 * that way, each one confirmed by a URL that had already moved on. */
dom = makeDom('https://www.linkedin.com/jobs/search-results/?currentJobId=9002');
T = dom.window.__JDC_TEST;
setPane(dom, 'Clinical Research Associate II', 'The FIRST job body' + LONG);
const stale = T.paneSignature();
check('the url says 9002, the pane still shows 9001: refused',
  T.paneShowsJob('9002', stale, 'Senior Clinical Research Associate'), false);

setPane(dom, 'Senior Clinical Research Associate', 'The SECOND job body' + LONG);
check('and accepted the moment the pane catches up',
  T.paneShowsJob('9002', stale, 'Senior Clinical Research Associate'), true);

console.log('\n--- the signature tells near-identical postings apart ---');

/* Two postings for the same role at the same company share their opening
 * paragraph. A signature built from the first 140 characters alone read the
 * second one as "the pane did not change" and skipped a real job. */
dom = makeDom('https://www.linkedin.com/jobs/search-results/');
T = dom.window.__JDC_TEST;
const SHARED = 'Monitor oncology trials across sites with ICH-GCP and EDC experience required for this position at our organisation and its partners. ';
setPane(dom, 'CRA II', SHARED + 'The Texas posting adds this closing paragraph.');
const first = T.paneSignature();
setPane(dom, 'CRA II', SHARED + 'The North Carolina posting adds a different closing paragraph entirely.');
check('same title, same opening, different posting: the signature moves',
  T.paneSignature() !== first, true);

console.log('\n--- when nothing we read changes, find what did ---');

/* The run that prompted this:
 *
 *   Page 1: 26 cards but only 1 distinct job id(s) — collecting by position.
 *   Skipped 4459238201 — the details pane was still showing job 4459259331.
 *   Skipped 4461277527 — the details pane was still showing job 4459259331.
 *
 * The click worked: the URL moved from one job id to the next, so LinkedIn had
 * genuinely switched jobs. What did not move was the text we were reading. No
 * amount of reasoning about class names finds that block - but a job
 * description is, by definition, the thing that changes when the job changes,
 * and that can simply be measured.
 *
 * The page below is built so every heuristic picks the wrong block: the
 * "About the job" label sits above a static panel, and the real posting is
 * somewhere else entirely. */

function decoyDom() {
  const dom = new JSDOM(`
    <body>
      <main>
        <div class="rail"><ul>
          <li class="c"><a class="l" href="/jobs/search-results/?currentJobId=4459259331">Sales Director</a></li>
          <li class="c"><a class="l" href="/jobs/search-results/?currentJobId=4459259331">Sales Director II</a></li>
          <li class="c"><a class="l" href="/jobs/search-results/?currentJobId=4459259331">Sales Director III</a></li>
        </ul></div>
        <div class="pane">
          <h2 class="ttl">Sales Director</h2>
          <div class="lbl">About the job</div>
          <div class="fixedpanel">Your profile and resume are missing some required
            qualifications for this role. Show match details. Job search faster with
            Premium: access company insights like strategic priorities, headcount
            trends and hiring patterns, plus see how you compare with other
            applicants before you apply to any of these roles today.</div>
          <div class="body">ORIGINAL POSTING. Lead enterprise sales across the region,
            owning a portfolio of strategic accounts and partnering with solution
            engineering on complex deals from qualification through to close and
            renewal, with quota responsibility from day one.</div>
        </div>
      </main>
    </body>`, {
    url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4459259331',
    /* Same as makeDom: content.js runs inside the window, so its chrome stub
     * has to be reachable from there. */
    runScripts: 'outside-only'
  });

  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  dom.window.chrome = {
    runtime: { sendMessage: (m, cb) => { if (cb) cb({}); }, onMessage: { addListener: () => {} }, lastError: null },
    storage: { local: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: (o, cb) => (cb ? cb() : Promise.resolve()) } }
  };
  for (const f of ['selectors.js', 'parse.js', 'extract.js', 'content.js']) {
    dom.window.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  }
  return dom;
}

(async function () {
  dom = decoyDom();
  T = dom.window.__JDC_TEST;
  const doc = dom.window.document;
  const EX = dom.window.JDC_EX;
  const SELM = dom.window.JDC_SEL;

  const decoy = doc.querySelector('.fixedpanel');
  const real = doc.querySelector('.body');

  check('the label anchor lands on the static panel, as it did on the real page',
    EX.descriptionEl(), decoy);

  /* Selecting the next job: the URL moves, the panel does not, the posting does. */
  const before = T.candidateBlocks();
  doc.querySelector('.ttl').textContent = 'Sales Director II';
  real.textContent = 'SECOND POSTING. Own a book of enterprise accounts in the ' +
    'northeast, working alongside partner teams on multi-year agreements and ' +
    'renewals, carrying a quota and reporting to the regional vice president.';

  const found = T.changedBlock(before);
  check('the block that changed is the posting', found, real);
  check('not the static panel', found === decoy, false);
  check('and not the whole pane around it', found === doc.querySelector('.pane'), false);

  const p = T.cssPath(real);
  check('a path was built for it', typeof p === 'string' && p.length > 0, true);
  check('and it addresses exactly that element', doc.querySelectorAll(p)[0], real);
  check('uniquely', doc.querySelectorAll(p).length, 1);

  const relearned = await T.relearnDescription(before);
  check('the description element is relearned', relearned, true);
  check('the selector layer now carries it', SELM.learned('description'), p);
  check('and the extractor reads the posting from here on', EX.descriptionEl(), real);
  check('which is the text that actually changed',
    /SECOND POSTING/.test(EX.text(EX.descriptionEl())), true);

  /* It must stay quiet when there is nothing to fix. */
  const steady = T.candidateBlocks();
  check('nothing changed: no block is reported', T.changedBlock(steady), null);
  check('and nothing is relearned', await T.relearnDescription(steady), false);

  console.log('\n--- a path is built from whatever the element carries ---');
  const withId = doc.createElement('div');
  withId.id = 'job-details';
  doc.body.appendChild(withId);
  check('an id wins outright', T.cssPath(withId), '#job-details');

  const bare = doc.createElement('div');
  doc.body.appendChild(bare);
  check('a bare element falls back to position',
    /nth-child\(\d+\)/.test(T.cssPath(bare)), true);

  console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
  process.exit(fails ? 1 : 0);
})();
