/* Verifies the structure-agnostic fallback on a page that shares NO class names
 * with the LinkedIn layouts the selectors target. This is the stand-in for
 * LinkedIn's AI job search and for any future redesign: if this passes, the
 * extension degrades to "still collects" instead of "silently returns zero". */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'content');

/* Deliberately obfuscated class names - nothing the selector lists know. */
const HTML = `
<body>
<div class="app">
  <header class="xh1"><span>Job search</span></header>
  <main class="xm2">
    <div class="pane-a">
      <div class="rowset">
        <article class="c-9f2"><a class="k1" href="/jobs/view/5001/?ref=ai">Clinical Research Associate II</a><span>Acme CRO</span></article>
        <article class="c-9f2"><a class="k1" href="/jobs/view/5002/">Senior CRA</a><span>Beta Labs</span></article>
        <article class="c-9f2"><a class="k1" href="/jobs/view/5003/">Clinical Trial Manager</a><span>Gamma Bio</span></article>
      </div>
    </div>
    <div class="pane-b">
      <div class="zz-top"><h1 class="hh">Clinical Research Associate II</h1><span>Acme CRO</span></div>
      <div class="zz-body">
        <p>About the role</p>
        <p>You will monitor oncology trials across 12 sites for a Phase III programme.</p>
        <p>Requirements include 3+ years of independent monitoring, strong ICH-GCP knowledge,
           EDC experience with Medidata Rave, and the ability to travel up to 50%.</p>
        <p>The base salary range for this position is $110,000 - $135,000 per year.</p>
        <p>We are not able to sponsor work visas for this position at this time.</p>
        <p>Additional detail to make this comfortably the densest block of text on the page,
           well past the four hundred character threshold that the fallback requires before it
           will treat an element as the job description rather than page furniture.</p>
      </div>
      <div class="zz-actions"><button class="bb">Apply</button></div>
    </div>
  </main>
  <footer class="xf3"><a href="/legal">Terms</a></footer>
</div>
</body>`;

const dom = new JSDOM(HTML, { url: 'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=5001' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;

for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
  eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
}

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

console.log('--- known selectors genuinely do not match this page ---');
const health = EX.selectorHealth();
check('list selector misses', health.list, null);
check('card selector misses', health.card, null);
check('description selector misses', health.description, null);
check('title selector misses', health.title, null);

console.log('\n--- but the fallback still finds the jobs ---');
check('job links discovered', SEL.jobAnchors().length, 3);
check('inferred list root is the row container',
  SEL.genericListRoot().className, 'rowset');
check('one card per job', SEL.genericCards().length, 3);
check('cards carry the right ids',
  SEL.genericCards().map((c) => SEL.jobIdFromHref(c.querySelector('a').getAttribute('href'))),
  ['5001', '5002', '5003']);

console.log('\n--- and the description ---');
const desc = EX.descriptionEl();
check('description element found', desc !== null, true);
check('it is the body block, not the whole page', desc.className, 'zz-body');
check('it excludes the job list', /Senior CRA/.test(desc.textContent), false);
check('it excludes the footer', /Terms/.test(desc.textContent), false);

console.log('\n--- extraction still works through the fallback ---');
const job = EX.extractJob('5001', {});
check('description captured', /monitor oncology trials/.test(job.description), true);
check('pay parsed from the description', [job.payMin, job.payMax], [110000, 135000]);
check('years parsed', job.yoeMin, 3);
check('travel parsed', job.travelPct, 50);
check('sponsorship flag parsed', job.sponsorshipUnavailable, true);
check('apply type detected', job.applyType, 'external');
check('url built from the id', job.url, 'https://www.linkedin.com/jobs/view/5001/');

console.log('\n--- the fallback does not fight the primary path ---');
// Add a real LinkedIn-shaped list; the known selectors must win.
document.body.insertAdjacentHTML('afterbegin',
  '<div class="scaffold-layout__list"><div><ul>' +
  '<li data-occludable-job-id="7001"><a class="job-card-container__link" href="/jobs/view/7001/">Real card</a></li>' +
  '</ul></div></div>');
check('known list selector now matches', EX.selectorHealth().list !== null, true);
check('primary cards found', SEL.qa(SEL.SEL.card, SEL.q(SEL.SEL.list)).length, 1);

console.log('\n--- jobs identified WITHOUT /jobs/view/ links ---');
/* The failure that prompted this: a results list whose cards are buttons or
 * divs carrying the job id in a data attribute, with no anchor anywhere. The
 * old detector counted zero links and reported an empty page. */
function idsFrom(html, url) {
  const d = new JSDOM('<body>' + html + '</body>', { url: url || 'https://www.linkedin.com/jobs/search/' });
  global.window = d.window;
  global.document = d.window.document;
  global.Node = d.window.Node;
  global.getComputedStyle = d.window.getComputedStyle;
  for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
    eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  }
  const S2 = d.window.JDC_SEL;
  return S2.jobAnchors().map((el) => S2.jobIdFromAttrs(el));
}

check('data-job-id on a button, no anchor',
  idsFrom('<div><button data-job-id="4123456789">A</button><button data-job-id="4123456790">B</button></div>'),
  ['4123456789', '4123456790']);

check('data-entity-urn job posting urn',
  idsFrom('<div><div data-entity-urn="urn:li:jobPosting:4111111111">A</div>' +
          '<div data-entity-urn="urn:li:jobPosting:4222222222">B</div></div>'),
  ['4111111111', '4222222222']);

check('currentJobId in the href',
  idsFrom('<div><a href="/jobs/collections/recommended/?currentJobId=4333333333">A</a></div>'),
  ['4333333333']);

check('jobId query parameter',
  idsFrom('<div><a href="/jobs/search-results/?jobId=4444444444">A</a></div>'),
  ['4444444444']);

check('data-tracking-urn variant',
  idsFrom('<div><li data-tracking-urn="urn:li:jobPosting:4555555555">A</li></div>'),
  ['4555555555']);

check('non-job urns are ignored',
  idsFrom('<div><div data-entity-urn="urn:li:member:12345">A</div></div>'), []);

check('a short bare /jobs/ number is not treated as an id',
  idsFrom('<div><a href="/jobs/12">A</a></div>'), []);

check('the same job found twice is one card',
  (function () {
    const d = new JSDOM('<body><div>' +
      '<li data-job-id="4666666666"><a href="/jobs/view/4666666666/">A</a></li>' +
      '<li data-job-id="4777777777"><a href="/jobs/view/4777777777/">B</a></li>' +
      '</div></body>', { url: 'https://www.linkedin.com/jobs/search/' });
    global.window = d.window; global.document = d.window.document;
    global.Node = d.window.Node; global.getComputedStyle = d.window.getComputedStyle;
    for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
      eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
    }
    return d.window.JDC_SEL.genericCards().length;
  })(), 2);

console.log('\n--- a page with no jobs at all ---');
const empty = new JSDOM('<body><div><p>Nothing here</p></div></body>',
  { url: 'https://www.linkedin.com/jobs/search/' });
global.window = empty.window;
global.document = empty.window.document;
global.Node = empty.window.Node;
global.getComputedStyle = empty.window.getComputedStyle;
for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
  eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
}
check('no cards invented', empty.window.JDC_SEL.genericCards().length, 0);
check('no list root invented', empty.window.JDC_SEL.genericListRoot(), null);
check('no description invented', empty.window.JDC_EX.descriptionEl(), null);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
