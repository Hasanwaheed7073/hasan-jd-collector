/* Reproduces LinkedIn's /jobs/search-results/ surface as reported by the page
 * diagnostic: hashed CSS class names, div-based cards with no <li>/<ul>, no job
 * links and no data attributes anywhere on the cards, and job identity present
 * only as currentJobId in the URL after a card is clicked.
 *
 * Every named selector misses here by construction. If these pass, discovery
 * survives a frontend that shares nothing with the layouts we know. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'content');

const CARD = (title, company) =>
  `<div class="_7e15ae8e d496de50">
     <div class="c81ff1be"><span class="a1b2c3d4">${title}</span></div>
     <div class="e5f6a7b8">${company} &middot; Boston, MA (Remote)</div>
     <div class="b9c0d1e2">Promoted &middot; 3 days ago &middot; 12 applicants</div>
   </div>`;

const BODY = `
<body>
  <div class="app-root">
    <main class="cc5d114c">
      <div class="f1e2d3c4">
        <div class="listwrap-9a8b">
          ${CARD('Clinical Research Associate II', 'Acme CRO')}
          ${CARD('Senior Clinical Research Associate', 'Beta Labs')}
          ${CARD('Clinical Trial Manager', 'Gamma Bio')}
          ${CARD('Clinical Research Coordinator', 'Delta Pharma')}
        </div>
      </div>
      <div class="cc5d114c _7e15ae8e d496de50 c81ff1be">
        <h2 class="zz11">Clinical Research Associate II</h2>
        <div class="zz22">
          <p>About the role</p>
          <p>You will monitor oncology trials across 12 sites for a Phase III programme,
             working closely with investigators and study coordinators.</p>
          <p>Requirements include 3+ years of independent monitoring, strong ICH-GCP
             knowledge, EDC experience with Medidata Rave, and travel up to 50%.</p>
          <p>The base salary range for this position is $110,000 - $135,000 per year.</p>
          <p>We are not able to sponsor work visas for this position at this time.</p>
          <p>Extra text so this block is comfortably the densest on the page and clears
             the four hundred character floor the description heuristic requires.</p>
        </div>
      </div>
    </main>
  </div>
</body>`;

function boot(url) {
  const dom = new JSDOM(BODY, { url: url, runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
    eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  }
  return dom;
}

const URL_BASE = 'https://www.linkedin.com/jobs/search-results/?keywords=cra&start=0&currentJobId=4123456789';
const dom = boot(URL_BASE);
const SEL = dom.window.JDC_SEL;
const EX = dom.window.JDC_EX;

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
               '\n          actual   ' + JSON.stringify(actual)));
}

console.log('--- the page is genuinely opaque to every named selector ---');
const health = EX.selectorHealth();
['list', 'card', 'detailsRoot', 'title', 'description', 'applyButton', 'nextPage']
  .forEach((k) => check(k + ' misses', health[k], null));

console.log('\n--- and to every id-based discovery pattern ---');
check('no job elements found by id', SEL.jobAnchors().length, 0);
check('no list root inferred from ids', SEL.genericListRoot(), null);

console.log('\n--- but shape finds the list ---');
const shaped = SEL.genericCardsByShape();
check('four cards found by repeated structure', shaped.length, 4);
check('the cards are the result rows, not the detail pane',
  /Clinical Research Associate II/.test(shaped[0].textContent), true);
check('cards come out in page order',
  shaped.map((c) => c.querySelector('span').textContent),
  ['Clinical Research Associate II', 'Senior Clinical Research Associate',
   'Clinical Trial Manager', 'Clinical Research Coordinator']);
check('genericCards falls through to shape when ids are absent',
  SEL.genericCards().length, 4);

console.log('\n--- the detail pane is still located correctly ---');
const desc = EX.descriptionEl();
check('description found', desc !== null, true);
check('it is the detail body, not a result card',
  /monitor oncology trials/.test(desc.textContent), true);
check('it excludes the results list',
  /Senior Clinical Research Associate/.test(desc.textContent), false);
check('title falls back to the h2 when no h1 exists',
  EX.text(EX.titleEl()), 'Clinical Research Associate II');

console.log('\n--- extraction works end to end on this surface ---');
// The id comes from the URL, which is how the position-based collector gets it.
const jobId = new dom.window.URL(dom.window.location.href).searchParams.get('currentJobId');
check('job id read from currentJobId', jobId, '4123456789');

const job = EX.extractJob(jobId, {});
check('title', job.title, 'Clinical Research Associate II');
check('url built from the id', job.url, 'https://www.linkedin.com/jobs/view/4123456789/');
check('description captured', /Phase III programme/.test(job.description), true);
check('pay parsed from prose', [job.payMin, job.payMax], [110000, 135000]);
check('years parsed', job.yoeMin, 3);
check('travel parsed', job.travelPct, 50);
check('sponsorship flag parsed', job.sponsorshipUnavailable, true);
check('description length is substantial', job.descriptionChars > 400, true);

console.log('\n--- the shape finder does not mistake the detail pane for the list ---');
const groups = SEL.repeatedSiblingGroups(EX.descriptionEl());
check('top group is the card container',
  groups[0].parent.className.indexOf('listwrap') !== -1, true);
check('top group has four members', groups[0].count, 4);

console.log('\n--- a page with prose but no result list yields no cards ---');
const lonely = new JSDOM(
  '<body><main><div class="x"><p>' + 'word '.repeat(200) + '</p></div></main></body>',
  { url: URL_BASE });
global.window = lonely.window;
global.document = lonely.window.document;
global.Node = lonely.window.Node;
global.getComputedStyle = lonely.window.getComputedStyle;
for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
  eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
}
check('no cards invented from a single prose block',
  lonely.window.JDC_SEL.genericCardsByShape().length, 0);

/* ------------------------------------------------------------------
 * The same surface once its results have actually streamed in, taken from a
 * real diagnostic: <ul> lists of <li> cards whose only job identity is a
 * ?currentJobId= href, split across several sibling <ul>s.
 * ------------------------------------------------------------------ */

console.log('\n--- cards identified only by ?currentJobId= hrefs ---');

const LI = (id, title) =>
  `<li><div class="e712002f _917ab9d4"><div class="cc5d114c" role="group">
     <a href="/jobs/search-results/?currentJobId=${id}&keywords=cra">${title}</a>
     <div>Acme CRO &middot; Boston, MA (Remote)</div>
     <div>3 days ago &middot; 12 applicants</div>
   </div></div></li>`;

/* Deliberately split across two lists, as the diagnostic showed. */
const STREAMED = `
<body><main>
  <div class="wrap">
    <ul class="a5b65bc4 _4a49e3b8">
      ${LI('4452824485', 'Clinical Research Associate II')}
      ${LI('4452824486', 'Senior Clinical Research Associate')}
      ${LI('4452824487', 'Clinical Trial Manager')}
    </ul>
    <ul class="a5b65bc4 _4a49e3b8">
      ${LI('4452824488', 'Clinical Research Coordinator')}
      ${LI('4452824489', 'Clinical Data Manager')}
    </ul>
  </div>
  <div class="detailpane">
    <h2>Clinical Research Associate II</h2>
    <div><p>You will monitor oncology trials across 12 sites for a Phase III programme.</p>
    <p>Requires 3+ years of independent monitoring and strong ICH-GCP knowledge.</p>
    <p>The base salary range is $110,000 - $135,000 per year. Travel up to 50%.</p>
    <p>Padding text so this block is unambiguously the densest region on the page and
       clears the four hundred character floor the description heuristic applies.</p></div>
  </div>
</main></body>`;

const dom2 = new JSDOM(STREAMED,
  { url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4452824485&start=0' });
global.window = dom2.window;
global.document = dom2.window.document;
global.Node = dom2.window.Node;
global.getComputedStyle = dom2.window.getComputedStyle;
for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
  eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
}
const SEL2 = dom2.window.JDC_SEL;
const EX2 = dom2.window.JDC_EX;

check('all five job links discovered', SEL2.jobAnchors().length, 5);

/* This is the regression that mattered: results split across sibling lists
 * meant the inferred root held only some of them, and scoping to it dropped
 * the rest - 13 links became 1 card on the real page. */
check('every card is returned, not just those under one inferred root',
  SEL2.genericCards().length, 5);

check('ids read off the currentJobId hrefs',
  SEL2.genericCards().map((c) => SEL2.jobIdFromAttrs(c.querySelector('a'))),
  ['4452824485', '4452824486', '4452824487', '4452824488', '4452824489']);

/* cardJobId lives in content.js; this mirrors it to prove the same id is
 * reachable from the card element the collector actually holds. */
function cardJobIdLike(card) {
  const own = SEL2.jobIdFromAttrs(card);
  if (own) return own;
  const inner = card.querySelector(SEL2.JOB_CANDIDATE_SELECTOR);
  return inner ? SEL2.jobIdFromAttrs(inner) : null;
}
check('the collector can read an id off each card element',
  SEL2.genericCards().map(cardJobIdLike).filter(Boolean).length, 5);
check('no card is left unidentified',
  SEL2.genericCards().every((c) => cardJobIdLike(c) !== null), true);

console.log('\n--- the detail pane is still separated from the lists ---');
const d2 = EX2.descriptionEl();
check('description found', d2 !== null, true);
check('it holds the job body', /Phase III programme/.test(d2.textContent), true);
check('it excludes the result rows', /Clinical Data Manager/.test(d2.textContent), false);

const job2 = EX2.extractJob('4452824485', {});
check('pay parsed', [job2.payMin, job2.payMax], [110000, 135000]);
check('years parsed', job2.yoeMin, 3);
check('travel parsed', job2.travelPct, 50);

/* ------------------------------------------------------------------
 * Never click through to people.
 *
 * The shape finder has no idea what a job is - it matches repeated structure.
 * On a page where the job list had not rendered, it selected a "people you may
 * know" style rail and the collector clicked its way through member profiles,
 * registering profile views on strangers' accounts. These are the guards.
 * ------------------------------------------------------------------ */

console.log('\n--- a people list is never mistaken for a job list ---');

const PERSON = (slug, name) =>
  `<li><div class="card"><a href="/in/${slug}">${name}</a>
     <div>Senior Recruiter at Acme</div>
     <div>500+ connections &middot; Greater Boston Area</div></div></li>`;

const PEOPLE_PAGE = `
<body><main>
  <ul class="rail">
    ${PERSON('jane-doe-1', 'Jane Doe')}
    ${PERSON('john-smith-2', 'John Smith')}
    ${PERSON('amy-lee-3', 'Amy Lee')}
    ${PERSON('raj-patel-4', 'Raj Patel')}
  </ul>
</main></body>`;

function bootAt(html, url) {
  const d = new JSDOM(html, { url: url });
  global.window = d.window;
  global.document = d.window.document;
  global.Node = d.window.Node;
  global.getComputedStyle = d.window.getComputedStyle;
  for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
    eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  }
  return d;
}

const peopleDom = bootAt(PEOPLE_PAGE, 'https://www.linkedin.com/jobs/search-results/?keywords=cra');
check('a rail of profile links yields no cards',
  peopleDom.window.JDC_SEL.genericCardsByShape().length, 0);
check('individual profile cards are recognised as non-jobs',
  peopleDom.window.JDC_SEL.looksLikeNonJobCard(peopleDom.window.document.querySelector('li')), true);
check('a group of them fails the job-list test',
  peopleDom.window.JDC_SEL.looksLikeJobList(
    Array.prototype.slice.call(peopleDom.window.document.querySelectorAll('li'))), false);

console.log('\n--- shape matching only runs on job pages ---');
const offJobs = bootAt(STREAMED, 'https://www.linkedin.com/feed/');
check('an identical layout off /jobs/ yields nothing by shape',
  offJobs.window.JDC_SEL.genericCardsByShape().length, 0);
const onJobs = bootAt(STREAMED, 'https://www.linkedin.com/jobs/search-results/');
check('the same layout under /jobs/ still works',
  onJobs.window.JDC_SEL.genericCards().length, 5);

console.log('\n--- a job card containing a profile link still opens the job ---');
/* Real job cards link to the hiring manager and the company as well. The click
 * target must be the job link, never the first anchor in the card. */
const MIXED = `
<body><main><ul>
  <li><div>
    <a href="/in/hiring-manager">Posted by Jane Doe</a>
    <a href="/company/acme-cro">Acme CRO</a>
    <a href="/jobs/search-results/?currentJobId=4452824490">Clinical Research Associate II</a>
  </div></li>
</ul></main></body>`;
const mixed = bootAt(MIXED, 'https://www.linkedin.com/jobs/search-results/');
const MS = mixed.window.JDC_SEL;

function jobClickTargetLike(card) {
  const anchors = card.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length; i++) {
    if (MS.jobIdFromAttrs(anchors[i])) return anchors[i];
  }
  const btn = card.querySelector('button, [role="button"]');
  if (btn) return btn;
  return card;
}

const mixedCard = mixed.window.document.querySelector('li');
const target = jobClickTargetLike(mixedCard);
check('the job link is chosen, not the profile link',
  target.getAttribute('href'), '/jobs/search-results/?currentJobId=4452824490');
check('the chosen target is never a profile link',
  /\/in\//.test(target.getAttribute('href') || ''), false);

console.log('\n--- a card with only foreign links falls back to the card itself ---');
const FOREIGN = `<body><main><ul><li id="c"><div>
  <a href="/in/someone">Someone</a><a href="/company/acme">Acme</a>
</div></li></ul></main></body>`;
const foreign = bootAt(FOREIGN, 'https://www.linkedin.com/jobs/search-results/');
const foreignCard = foreign.window.document.getElementById('c');
const FS = foreign.window.JDC_SEL;
function pick(card) {
  const anchors = card.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length; i++) if (FS.jobIdFromAttrs(anchors[i])) return anchors[i];
  const btn = card.querySelector('button, [role="button"]');
  if (btn) return btn;
  return card;
}
check('falls back to the card element, which cannot navigate',
  pick(foreignCard).tagName, 'LI');

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
