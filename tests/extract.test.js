/* Exercises selectors.js + extract.js against a DOM shaped like the current
 * LinkedIn two-pane job search, to verify the extraction pipeline end to end. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = require('path').join(__dirname, '..', 'src', 'content');

const HTML = `
<body>
<div class="scaffold-layout__list"><div><ul>
  <li data-occludable-job-id="4001">
    <div class="job-card-container" data-job-id="4001">
      <a class="job-card-container__link" href="/jobs/view/4001/?eBP=x"><span>Clinical Research Associate II</span></a>
      <div class="job-card-container__footer-wrapper">Promoted</div>
    </div>
  </li>
  <li data-occludable-job-id="4002">
    <div class="job-card-container" data-job-id="4002">
      <a class="job-card-container__link" href="/jobs/view/4002/"><span>Senior CRA</span></a>
      <div>Viewed</div>
    </div>
  </li>
  <li class="scaffold-layout__list-item"><div class="job-card-container--placeholder"></div></li>
</ul></div></div>

<div class="jobs-search__job-details--container">
  <div class="job-details-jobs-unified-top-card__container--two-pane">
    <div class="job-details-jobs-unified-top-card__job-title"><h1><a>Clinical Research Associate II</a></h1></div>
    <div class="job-details-jobs-unified-top-card__company-name"><a href="https://www.linkedin.com/company/acme-cro/">Acme CRO</a></div>
    <div class="job-details-jobs-unified-top-card__primary-description-container">
      <span>Boston, MA</span><span class="white-space-pre"> &middot; </span><span>Reposted 3 weeks ago</span><span class="white-space-pre"> &middot; </span><span>Over 100 applicants</span>
    </div>
    <div class="job-details-fit-level-preferences">
      <button><strong>Remote</strong></button>
      <button><strong>Full-time</strong></button>
      <button><strong>Mid-Senior level</strong></button>
      <button><strong>$110,000/yr - $135,000/yr</strong></button>
    </div>
    <div class="jobs-apply-button--top-card">
      <button class="jobs-apply-button" id="jobs-apply-button-id" aria-label="Apply to Clinical Research Associate II on company website">
        <span>Apply</span><li-icon type="link-external"></li-icon>
      </button>
    </div>
  </div>

  <div class="jobs-description__content">
    <div id="job-details">
      <p>About the role</p>
      <p>You will monitor oncology trials across 12 sites.</p>
      <ul>
        <li>3+ years of independent monitoring</li>
        <li>Strong ICH-GCP knowledge</li>
      </ul>
      <p>Travel up to 50%.<br/>Reports to the Lead CRA.</p>
      <p>You will be expected on-site 2 days per week for site visits.</p>
      <p>We are not able to sponsor work visas for this position.</p>
      <span aria-hidden="true">HIDDEN_TRACKING_TEXT</span>
      <script>var x = 'should not appear';</script>
    </div>
  </div>
</div>

<div class="jobs-search-pagination">
  <button class="jobs-search-pagination__button--next" aria-label="View next page">Next</button>
</div>
</body>`;

const dom = new JSDOM(HTML, { url: 'https://www.linkedin.com/jobs/search/?keywords=cra&currentJobId=4001&start=0' });

global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;

for (const f of ['selectors.js', 'parse.js', 'extract.js']) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
}

const EX = dom.window.JDC_EX;
const SELM = dom.window.JDC_SEL;

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) + '\n          actual   ' + JSON.stringify(actual)));
}

console.log('--- selector health ---');
const health = EX.selectorHealth();
Object.keys(health).forEach((k) => {
  const ok = !!health[k];
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + k + ' -> ' + health[k]);
});

console.log('\n--- card discovery ---');
const list = SELM.q(SELM.SEL.list);
const cards = SELM.qa(SELM.SEL.card, list);
// qa() returns the first selector in the list that matches anything, so the
// class-only placeholder <li> is correctly excluded from the card set.
check('cards found (rendered only)', cards.length, 2);

function cardJobId(card) {
  const direct = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id');
  if (direct && /^\d+$/.test(direct)) return direct;
  const inner = card.querySelector('[data-job-id]');
  const innerId = inner && inner.getAttribute('data-job-id');
  if (innerId && /^\d+$/.test(innerId)) return innerId;
  const a = card.querySelector('a[href*="/jobs/view/"]');
  if (a) { const m = /\/jobs\/view\/(\d+)/.exec(a.getAttribute('href') || ''); if (m) return m[1]; }
  return null;
}
check('real job ids after filtering placeholders',
  cards.map(cardJobId).filter(Boolean), ['4001', '4002']);
check('card meta detects Promoted', EX.extractCardMeta(cards[0]).promoted, true);
check('card meta detects Viewed', EX.extractCardMeta(cards[1]).viewed, true);

console.log('\n--- field extraction ---');
const job = EX.extractJob('4001', EX.extractCardMeta(cards[0]));

check('jobId', job.jobId, '4001');
check('url', job.url, 'https://www.linkedin.com/jobs/view/4001/');
check('title', job.title, 'Clinical Research Associate II');
check('company', job.company, 'Acme CRO');
check('location', job.location, 'Boston, MA');
check('workplaceType', job.workplaceType, 'Remote');
check('postedRaw', job.postedRaw, 'Reposted 3 weeks ago');
check('postedDaysAgo', job.postedDaysAgo, 21);
check('reposted', job.reposted, true);
check('applicants', job.applicants, 100);
check('promoted', job.promoted, true);
check('applyType (external -> direct apply)', job.applyType, 'external');
check('employmentType', job.employmentType, 'Full-time');
check('seniority', job.seniority, 'Mid-Senior level');
check('salary', job.salary, '$110,000/yr - $135,000/yr');

console.log('\n--- fields parsed out of the prose ---');
check('pay comes from the top-card pill when present', job.paySource, 'pill');
check('pay range from the pill', [job.payMin, job.payMax, job.payPeriod], [110000, 135000, 'year']);
check('pay annualized', [job.payMinAnnual, job.payMaxAnnual], [110000, 135000]);
check('years of experience from a requirement bullet', job.yoeMin, 3);
check('travel percentage', job.travelPct, 50);
check('onsite days per week', job.onsiteDaysPerWeek, 2);
check('sponsorship unavailable', job.sponsorshipUnavailable, true);
check('clearance not required', job.needsClearance, false);
check('relocation not required', job.requiresRelocation, false);
// The pill says Remote but the body demands two office days a week.
check('remote contradiction detected', job.remoteContradiction, true);
check('apply url empty until resolved (button is not a link)', job.applyUrl, '');

console.log('\n--- description text ---');
const jd = job.description;
check('bullets preserved', /- 3\+ years of independent monitoring/.test(jd), true);
check('second bullet preserved', /- Strong ICH-GCP knowledge/.test(jd), true);
check('br becomes newline', /50%\.\nReports to the Lead CRA\./.test(jd), true);
check('script content excluded', /should not appear/.test(jd), false);
check('aria-hidden excluded', /HIDDEN_TRACKING_TEXT/.test(jd), false);
check('no runs of 3+ newlines', /\n{3,}/.test(jd), false);
check('descriptionChars matches', job.descriptionChars, jd.length);
check('bullets single-spaced',
  /- 3\+ years of independent monitoring\n- Strong ICH-GCP knowledge/.test(jd), true);
console.log('  --- rendered JD ---');
console.log(jd.split('\n').map((l) => '  | ' + l).join('\n'));

console.log('\n--- easy apply variant ---');
const btn = document.getElementById('jobs-apply-button-id');
btn.setAttribute('aria-label', 'Easy Apply to Clinical Research Associate II');
btn.innerHTML = '<span>Easy Apply</span>';
check('applyType easy_apply', EX.extractJob('4001', {}).applyType, 'easy_apply');

btn.parentElement.innerHTML = '<div class="jobs-details-top-card__apply-error">No longer accepting applications</div>';
check('applyType closed', EX.extractJob('4001', {}).applyType, 'closed');

console.log('\n--- agoToDays ---');
check('45 minutes ago', EX.agoToDays('45 minutes ago'), 0);
check('2 hours ago', EX.agoToDays('2 hours ago'), 0);
check('5 days ago', EX.agoToDays('5 days ago'), 5);
check('Reposted 2 weeks ago', EX.agoToDays('Reposted 2 weeks ago'), 14);
check('1 month ago', EX.agoToDays('1 month ago'), 30);
check('garbage', EX.agoToDays('recently'), null);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
