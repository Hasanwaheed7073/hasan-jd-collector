/* Loads the real sidepanel.html + sidepanel.js in jsdom with stubbed chrome
 * APIs, then exercises filtering, batching, CSV export and search building.
 *
 * The panel has no scorer and no client profile: every filter here keys on a
 * fact read out of the posting. So the load-bearing property this suite pins is
 * that the panel narrows a list but never reorders it by opinion and never
 * drops a job for a reason the posting does not state. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', 'src', 'sidepanel');
const html = fs.readFileSync(path.join(ROOT, 'sidepanel.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');

const dom = new JSDOM(html, { url: 'chrome-extension://test/sidepanel.html' });
global.window = dom.window;
global.document = dom.window.document;
global.Blob = dom.window.Blob;
global.URL = dom.window.URL;

/* Node 21+ exposes navigator as an accessor-only global, so a plain assignment
 * silently does nothing and the clipboard stub below is never reached. */
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true
});

/* The panel loads parse.js the same way its script tags do. */
require('../src/content/parse.js');

let lastCopied = null;
let lastDownload = null;

Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: (t) => { lastCopied = t; return Promise.resolve(); } },
  configurable: true
});

const STORE = {};
global.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => {
      const res = msg.type === 'JDC_GET_ALL'
        ? {
          state: {},
          config: {
            delayMs: 1200, jitterMs: 500, longPauseEvery: 25, longPauseMs: 6000,
            maxPages: 5, maxJobs: 0, skipSeen: false, clearBefore: true,
            batchChars: 80000, maxJdChars: 6000, promptTemplate: 'PROMPT'
          },
          jobs: [], history: {}, log: []
        }
        : { ok: true, count: 0, config: {} };
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
    onChanged: { addListener: () => {} }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, url: 'https://www.linkedin.com/jobs/search/?keywords=cra' }]),
    update: () => Promise.resolve(),
    create: () => Promise.resolve(),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} }
  },
  downloads: { download: (o, cb) => { lastDownload = o; if (cb) cb(1); } }
};

let API;
eval(src + '\n;API = { ' +
  'get JOBS(){return JOBS}, set JOBS(v){JOBS=v}, ' +
  'get HISTORY(){return HISTORY}, set HISTORY(v){HISTORY=v}, ' +
  'get VERDICTS(){return VERDICTS}, set VERDICTS(v){VERDICTS=v}, ' +
  'get CONFIG(){return CONFIG}, set CONFIG(v){CONFIG=v}, ' +
  'get BATCHES(){return BATCHES}, ' +
  'get DESELECTED(){return DESELECTED}, set DESELECTED(v){DESELECTED=v}, ' +
  'applyFilters, buildBatches, toCsv, readFilters, writeFilters, render, ' +
  'selectedJobs, splitList, buildSearchUrl, payTag, hostLabel, jobBlock, ' +
  'sortJobs, currentFiltered, searchRecord, readSearch, writeSearch, ' +
  'setAdvanced, activeAdvFilters, renderFilterNote, filtersRemoving, onlyFilter };');

const $ = (id) => document.getElementById(id);

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

/* ---------- fixtures ---------- */

function job(o) {
  return Object.assign({
    jobId: '1', title: 'CRA II', company: 'Acme CRO', location: 'Boston, MA',
    workplaceType: 'Remote', postedRaw: '3 days ago', postedDaysAgo: 3,
    reposted: false, applicants: 12, promoted: false, applyType: 'external',
    employmentType: 'Full-time', seniority: 'Mid-Senior level',
    description: 'Monitor oncology trials. ICH-GCP required.', descriptionChars: 42,
    url: 'https://www.linkedin.com/jobs/view/1/'
  }, o);
}

const JOBS = [
  job({ jobId: '1', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', reposted: false }),
  job({ jobId: '2', title: 'Senior CRA', workplaceType: 'Remote', applyType: 'easy_apply' }),
  job({ jobId: '3', title: 'CRA I', workplaceType: 'Hybrid', applyType: 'external' }),
  job({ jobId: '4', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', reposted: true }),
  job({ jobId: '5', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', promoted: true }),
  job({ jobId: '6', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', postedDaysAgo: 45, postedRaw: '45 days ago' }),
  job({ jobId: '7', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', postedDaysAgo: null, postedRaw: '' }),
  job({ jobId: '8', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', applicants: 400 }),
  job({ jobId: '9', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', company: 'Jobot Staffing' }),
  job({ jobId: '10', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', description: 'Cardiology trials, no GCP mention.', descriptionChars: 33 }),
  job({ jobId: '11', title: 'CRA II', workplaceType: 'Remote', applyType: 'external', description: 'Requires active security clearance. ICH-GCP required.', descriptionChars: 52, needsClearance: true }),
  job({ jobId: '12', title: 'CRA II', workplaceType: 'Unknown', applyType: 'unknown' })
];
API.JOBS = JOBS;

function ids(list) { return list.map((j) => j.jobId); }
function filterNow() { return API.applyFilters(API.JOBS, API.readFilters()); }

/* ---------------------------------------------------------------- filters */

console.log('--- nothing is filtered until asked ---');
API.writeFilters({});
check('all twelve survive an empty filter set', filterNow().length, 12);
check('sort defaults to collection order', $('fSort').value, 'collected');

console.log('\n--- workplace and apply route ---');
API.writeFilters({ workplace: ['Remote'] });
check('remote only', ids(filterNow()).indexOf('3'), -1);
API.writeFilters({ workplace: ['Hybrid'] });
check('hybrid only', ids(filterNow()).indexOf('1'), -1);
API.writeFilters({ apply: ['external'] });
check('easy apply excluded', ids(filterNow()).indexOf('2'), -1);
API.writeFilters({ apply: ['easy_apply'] });
check('easy apply only', ids(filterNow()).indexOf('1'), -1);

/* An unknown is never a rejection, and these two used to be the exception.
 *
 * Job 12 states neither its workplace type nor its application route. On the
 * classic layout that is rare; on LinkedIn's AI job search it is common, and
 * dropping those jobs emptied the entire list - 12 collected, 0 shown, with
 * the filter responsible possibly sitting behind the gear. A posting that
 * never said "Hybrid" contains no sentence justifying its removal from a
 * Hybrid filter, which is the test every filter here has to pass. */
API.writeFilters({ workplace: ['Hybrid'] });
check('a job with no stated workplace type is KEPT',
  ids(filterNow()).indexOf('12') !== -1, true);
API.writeFilters({ apply: ['easy_apply'] });
check('and one with no stated apply route is KEPT too',
  ids(filterNow()).indexOf('12') !== -1, true);
API.writeFilters({ workplace: ['Hybrid'], apply: ['easy_apply'] });
check('the two together still keep it',
  ids(filterNow()).indexOf('12') !== -1, true);
check('while a job that DID state a different one is still dropped',
  ids(filterNow()).indexOf('1'), -1);

console.log('\n--- an empty list always names the filter that emptied it ---');

/* The failure this exists for: "0 of 12 collected", an empty box, and no way
 * to tell which filter did it without opening the gear and reading them all. */
API.writeFilters({ titleAny: 'quantum' });
check('nothing survives', filterNow().length, 0);
API.render();
const emptied = $('resultsNote').textContent;
check('the note says everything was filtered out', /All 12 collected jobs are filtered out/.test(emptied), true);
check('and names the filter responsible', /title contains \(12\)/.test(emptied), true);
check('and says where to change it', /Open the gear/.test(emptied), true);

API.writeFilters({ titleAny: 'quantum', minChars: '5000' });
const both = API.filtersRemoving(API.readFilters());
check('two filters are reported, worst first',
  both.map((x) => x.key), ['titleAny', 'minChars']);
check('each measured on its own against the whole set',
  both.map((x) => x.removed), [12, 12]);

API.writeFilters({ noRepost: true });
check('a filter that removes nothing of consequence is not blamed',
  API.filtersRemoving(API.readFilters()).map((x) => x.key), ['noRepost']);
API.render();
check('and with survivors the note stays empty', $('resultsNote').textContent, '');

/* Measuring one filter must not accidentally carry the others in with it. */
const isolated = API.onlyFilter({ workplace: ['Remote'], noRepost: true, titleAny: 'cra', sort: 'pay' }, 'noRepost');
check('every other filter is blanked by type',
  isolated, { workplace: [], noRepost: true, titleAny: '', sort: 'pay' });

console.log('\n--- the boolean flags ---');
API.writeFilters({ noRepost: true });
check('reposted dropped', ids(filterNow()).indexOf('4'), -1);
API.writeFilters({ noPromoted: true });
check('promoted dropped', ids(filterNow()).indexOf('5'), -1);
API.writeFilters({ noClearance: true });
check('clearance dropped', ids(filterNow()).indexOf('11'), -1);

API.HISTORY = { '1': true };
API.writeFilters({ noSeen: true });
check('already exported dropped', ids(filterNow()).indexOf('1'), -1);
API.HISTORY = {};

/* A remembered verdict is inert until its filter is switched on, and an
 * approval must never be mistaken for a rejection - that would delete exactly
 * the jobs the vetting pass said to keep. */
API.VERDICTS = { '1': { verdict: 'reject', reason: 'too junior' }, '2': { verdict: 'accept', reason: '' } };
API.writeFilters({});
check('a stored verdict alone hides nothing', filterNow().length, 12);
API.writeFilters({ noRejected: true });
check('the turned-down job is dropped', ids(filterNow()).indexOf('1'), -1);
check('but the approved one is KEPT', ids(filterNow()).indexOf('2') !== -1, true);
check('and so is every job with no verdict at all', ids(filterNow()).indexOf('3') !== -1, true);
API.VERDICTS = {};

console.log('\n--- numeric filters, and the unknown-is-kept rule ---');
API.writeFilters({ maxDays: '30' });
check('a 45-day-old job is dropped', ids(filterNow()).indexOf('6'), -1);
check('but an unknown age is KEPT', ids(filterNow()).indexOf('7') !== -1, true);

API.writeFilters({ maxApplicants: '100' });
check('400 applicants dropped', ids(filterNow()).indexOf('8'), -1);

API.writeFilters({ minChars: '40' });
check('a short description dropped', ids(filterNow()).indexOf('10'), -1);
API.writeFilters({ minChars: '0' });
check('a zero minimum drops nothing', filterNow().length, 12);

console.log('\n--- pay clears on the TOP of the range ---');
API.JOBS = [
  job({ jobId: 'p1', payMinAnnual: 110000, payMaxAnnual: 140000 }),
  job({ jobId: 'p2', payMinAnnual: 90000, payMaxAnnual: 100000 }),
  job({ jobId: 'p3' })
];
API.writeFilters({ minPay: '130000' });
check('a 110-140k job clears a 130k floor', ids(filterNow()).indexOf('p1') !== -1, true);
check('a 90-100k job does not', ids(filterNow()).indexOf('p2'), -1);
check('a job with no pay stated is kept', ids(filterNow()).indexOf('p3') !== -1, true);
API.writeFilters({ hasPay: true });
check('until you ask for pay only', ids(filterNow()).indexOf('p3'), -1);
API.JOBS = JOBS;

console.log('\n--- text matching ---');
API.writeFilters({ titleAny: 'senior' });
check('title must contain', ids(filterNow()), ['2']);
API.writeFilters({ titleNot: 'senior' });
check('title must not contain', ids(filterNow()).indexOf('2'), -1);
API.writeFilters({ jdAll: 'ich-gcp' });
check('JD must contain', ids(filterNow()).indexOf('10'), -1);
API.writeFilters({ jdAny: 'cardiology' });
check('JD any-of', ids(filterNow()), ['10']);
API.writeFilters({ jdNot: 'security clearance' });
check('JD must not contain', ids(filterNow()).indexOf('11'), -1);
API.writeFilters({ companyNot: 'jobot' });
check('company excluded', ids(filterNow()).indexOf('9'), -1);
API.writeFilters({ titleAny: 'CRA' });
check('matching is case insensitive', filterNow().length, 12);

/* ------------------------------------------------------------------ sort */

console.log('\n--- sorting reorders, never filters ---');
API.JOBS = [
  job({ jobId: 's1', payMinAnnual: 100000, payMaxAnnual: 200000, postedDaysAgo: 10, applicants: 5 }),
  job({ jobId: 's2', payMinAnnual: 50000, payMaxAnnual: 60000, postedDaysAgo: 1, applicants: 90 }),
  job({ jobId: 's3', postedDaysAgo: 5, applicants: 40 })
];
API.writeFilters({});

$('fSort').value = 'collected';
check('collection order is the input order', ids(API.currentFiltered()), ['s1', 's2', 's3']);
$('fSort').value = 'pay';
check('by pay ceiling', ids(API.currentFiltered())[0], 's1');
$('fSort').value = 'posted';
check('by newest posted', ids(API.currentFiltered())[0], 's2');
$('fSort').value = 'applicants';
check('by fewest applicants', ids(API.currentFiltered())[0], 's1');

['collected', 'pay', 'posted', 'applicants'].forEach(function (mode) {
  $('fSort').value = mode;
  check('  ' + mode + ' keeps all three', API.currentFiltered().length, 3);
});

/* There is no "by fit" mode any more; an unknown mode must not throw or drop. */
$('fSort').value = 'fit';
check('an unknown sort mode is a no-op, not a crash', ids(API.currentFiltered()), ['s1', 's2', 's3']);
$('fSort').value = 'collected';
API.JOBS = JOBS;

/* ---------------------------------------------------------------- export */

console.log('\n--- the exported block is facts only ---');
API.writeFilters({});
const block = API.jobBlock(job({
  jobId: 'x1', payRaw: '$120,000/yr', payMinAnnual: 120000, payMaxAnnual: 140000,
  paySource: 'pill', yoeMin: 4, travelPct: 25, needsClearance: true
}), 1, 0);

check('the id is in the header', /ID x1/.test(block), true);
check('title, company, location present',
  /Title: CRA II/.test(block) && /Company: Acme CRO/.test(block), true);
check('the parsed facts are there', /PARSED FACTS:/.test(block), true);
check('pay with its source', /Pay: \$120,000\/yr .*LinkedIn pay field/.test(block), true);
check('years required', /Years required: 4\+/.test(block), true);
check('travel', /Travel: up to 25%/.test(block), true);
check('clearance', /Security clearance required/.test(block), true);
check('the description follows', /JOB DESCRIPTION:/.test(block), true);

/* The extension states no conclusion. This is the check that keeps it that way. */
check('NO fit score', /LOCAL FIT/.test(block), false);
check('NO for/against reasoning', /  For: |  Against: |Blocked by:/.test(block), false);

console.log('\n--- a hiring.cafe job says where it came from ---');
const hcBlock = API.jobBlock(job({
  jobId: 'h1', source: 'hiringcafe', atsSource: 'greenhouse',
  certifications: ['ICH-GCP'], tools: ['Medidata Rave']
}), 1, 0);
check('the source is named', /Source: hiring\.cafe via greenhouse/.test(hcBlock), true);
check('certifications travel with it', /Certifications listed: ICH-GCP/.test(hcBlock), true);
check('tools too', /Tools listed: Medidata Rave/.test(hcBlock), true);
check('a LinkedIn job says LinkedIn', /Source: LinkedIn/.test(API.jobBlock(job({}), 1, 0)), true);

console.log('\n--- trimming ---');
const long = API.jobBlock(job({ description: 'x'.repeat(500) }), 1, 100);
check('the JD is cut at the limit', /x{100}\n\[\.\.\.trimmed\]/.test(long), true);
check('and untrimmed at zero', /trimmed/.test(API.jobBlock(job({ description: 'x'.repeat(500) }), 1, 0)), false);

console.log('\n--- batching ---');
API.CONFIG = Object.assign({}, API.CONFIG, { batchChars: 5000, maxJdChars: 0, promptTemplate: 'PROMPT' });
let batches = API.buildBatches(JOBS.slice(0, 3));
check('the prompt leads every batch', batches[0].text.indexOf('PROMPT'), 0);
check('the batch is numbered', /BATCH 1 of \d+/.test(batches[0].text), true);
check('and counts its jobs', /3 jobs/.test(batches[0].text), true);

API.CONFIG = Object.assign({}, API.CONFIG, { batchChars: 5000 });
batches = API.buildBatches([job({ jobId: 'big', description: 'y'.repeat(20000) })]);
check('one oversized job still gets a batch', batches.length, 1);
check('rather than being dropped', /y{100}/.test(batches[0].text), true);

check('no jobs, no batches', API.buildBatches([]).length, 0);

/* The vetting format asks for a reply SHAPE so the calls can be read back in.
 * It must never smuggle in a conclusion about a job - the whole export
 * discipline depends on the model reading the posting before it decides. */
API.CONFIG = Object.assign({}, API.CONFIG, {
  batchChars: 5000, maxJdChars: 0, promptTemplate: 'PROMPT', vettingFormat: 'VERDICT <ID> ACCEPT'
});
const vetted = API.buildBatches(JOBS.slice(0, 3))[0].text;
check('the prompt still leads', vetted.indexOf('PROMPT'), 0);
check('the vetting format follows it', /PROMPT\n\nVERDICT <ID> ACCEPT\n\n=== BATCH/.test(vetted), true);
check('and it sits above the jobs', vetted.indexOf('VERDICT <ID> ACCEPT') < vetted.indexOf('--- JOB 1'), true);

API.CONFIG = Object.assign({}, API.CONFIG, { vettingFormat: '' });
check('blank omits it entirely, leaving no stray gap',
  /PROMPT\n\n=== BATCH/.test(API.buildBatches(JOBS.slice(0, 3))[0].text), true);
API.CONFIG = Object.assign({}, API.CONFIG, { vettingFormat: undefined });

console.log('\n--- a batch never holds more than 15 jobs ---');

/* The character budget alone is not enough: 40 short postings clear an 80k
 * budget easily and are still far too many to read in one pass. */
const many = [];
for (let i = 1; i <= 40; i++) many.push(job({ jobId: 'm' + i, description: 'short.' }));

API.CONFIG = Object.assign({}, API.CONFIG, { batchChars: 1000000, maxJdChars: 0 });
const capped = API.buildBatches(many);
check('40 jobs split into three batches', capped.length, 3);
check('15, 15, then the remainder', capped.map(function (b) { return b.count; }), [15, 15, 10]);
check('no batch exceeds 15', capped.every(function (b) { return b.count <= 15; }), true);

/* Exactly 15 must not spill into a second batch. */
check('exactly 15 is one batch', API.buildBatches(many.slice(0, 15)).length, 1);
check('16 becomes two', API.buildBatches(many.slice(0, 16)).map(function (b) { return b.count; }), [15, 1]);
check('one job is one batch', API.buildBatches(many.slice(0, 1))[0].count, 1);

/* Whichever limit bites first wins - a tight character budget still splits
 * below 15. */
/* Whichever limit bites first wins. batchChars has a hard floor of 5,000, and
 * a short posting is only ~200 characters of block - so with short postings
 * the 15-job cap is effectively ALWAYS the binding limit. To exercise the
 * character path at all the postings have to be long. */
const longJobs = [];
for (let i = 1; i <= 40; i++) {
  longJobs.push(job({ jobId: 'L' + i, description: 'x'.repeat(1500) }));
}
API.CONFIG = Object.assign({}, API.CONFIG, { batchChars: 5000, maxJdChars: 0 });
const tight = API.buildBatches(longJobs);
check('long postings split on characters, well below 15',
  tight.every(function (b) { return b.count < 15; }), true);
check('so there are more batches than the count cap alone would make',
  tight.length > capped.length, true);
check('and each batch respects the budget',
  tight.every(function (b) { return b.count === 1 || b.text.length <= 5000 + 2000; }), true);
check('still never more than 15 in one',
  tight.every(function (b) { return b.count <= 15; }), true);

check('each batch is numbered out of the true total',
  /BATCH 3 of 3/.test(capped[2].text), true);

API.CONFIG = Object.assign({}, API.CONFIG, { batchChars: 80000 });

console.log('\n--- csv ---');
const csv = API.toCsv([job({ jobId: 'c1', title: 'CRA, II', description: 'Line one\nLine "two"' })]);
check('starts with a BOM', csv.charCodeAt(0), 0xFEFF);
check('a comma in a field is quoted', /"CRA, II"/.test(csv), true);
check('an embedded quote is doubled', /Line ""two""/.test(csv), true);
check('CRLF line endings', /\r\n/.test(csv), true);
check('no fit columns', /fitScore|fitBand|fitFor/.test(csv), false);
check('the source column is there', /(^|,)source(,|\r)/.test(csv.split('\r\n')[0]), true);

/* ------------------------------------------------------------ search url */

console.log('\n--- the LinkedIn search url ---');
$('sKeywords').value = 'Clinical Research Associate';
$('sLocation').value = 'United States';
$('sRemote').value = '2,3';
$('sPosted').value = 'r604800';
$('sLevel').value = '4';
$('sType').value = 'F';
$('sSort').value = 'DD';
$('sUnder10').checked = true;

const url = new URL(API.buildSearchUrl());
check('keywords', url.searchParams.get('keywords'), 'Clinical Research Associate');
check('location', url.searchParams.get('location'), 'United States');
check('workplace', url.searchParams.get('f_WT'), '2,3');
check('date posted', url.searchParams.get('f_TPR'), 'r604800');
check('level', url.searchParams.get('f_E'), '4');
check('job type', url.searchParams.get('f_JT'), 'F');
check('under ten applicants', url.searchParams.get('f_JIYN'), 'true');
check('sort', url.searchParams.get('sortBy'), 'DD');
check('start is reset', url.searchParams.get('start'), '0');

console.log('\n--- the search record handed to hiring.cafe ---');
const rec = API.searchRecord();
check('keywords carry over', rec.keywords, 'Clinical Research Associate');
check('location carries over', rec.location, 'United States');
check('the workplace code carries over', rec.remote, '2,3');
check('posted carries over', rec.posted, 'r604800');

console.log('\n--- and the search fields persist on their own ---');

/* They used to live only inside a client record. Losing that would have meant
 * retyping the query every time the panel opened. */
const snapshot = API.readSearch();
check('the snapshot holds the keywords', snapshot.sKeywords, 'Clinical Research Associate');
check('and the checkbox', snapshot.sUnder10, true);

API.writeSearch({ sKeywords: 'Clinical Trial Manager', sLocation: 'Canada', sUnder10: false });
check('writing them back works', $('sKeywords').value, 'Clinical Trial Manager');
check('location too', $('sLocation').value, 'Canada');
check('and the checkbox', $('sUnder10').checked, false);
check('a field absent from the record is left alone', $('sRemote').value, '2,3');

API.writeSearch(snapshot);
check('the snapshot restores', $('sKeywords').value, 'Clinical Research Associate');
check('an empty record does not blank the form', (API.writeSearch({}), $('sKeywords').value),
  'Clinical Research Associate');

/* ------------------------------------------------------- simple/advanced */

console.log('\n--- simple mode hides only the advanced controls ---');
API.setAdvanced(false);
check('body starts in simple mode', document.body.classList.contains('simple'), true);
check('the gear reads not-pressed', $('btnAdvanced').getAttribute('aria-pressed'), 'false');
check('the JD text filters are behind the gear', $('fJdAll').closest('[data-adv]') !== null, true);
check('keywords stays visible', $('sKeywords').closest('[data-adv]'), null);
check('location stays visible', $('sLocation').closest('[data-adv]'), null);
check('the results sort stays visible', $('fSort').closest('[data-adv]'), null);
check('the batch buttons stay visible', $('batchButtons').closest('[data-adv]'), null);
check('and so does the hiring.cafe button', $('btnCollectHc').closest('[data-adv]'), null);

API.setAdvanced(true);
check('the gear turns advanced on', document.body.classList.contains('simple'), false);

console.log('\n--- a hidden filter is announced, never silent ---');
API.setAdvanced(false);
API.writeFilters({});
API.render();
check('no note when nothing is filtering', $('filterNote').hidden, true);

API.writeFilters({ jdAll: 'ich-gcp', companyNot: 'Jobot' });
API.render();
check('the note appears', $('filterNote').hidden, false);
check('it counts both', /^2 hidden filters are/.test($('filterNote').textContent), true);
check('and names them', /JD contains all of, excluded companies/.test($('filterNote').textContent), true);
check('and they really do apply', ids(filterNow()).indexOf('9'), -1);

API.setAdvanced(true);
API.render();
check('advanced mode drops the note', $('filterNote').hidden, true);
API.setAdvanced(false);

check('a zero min JD length is not counted', API.activeAdvFilters({ minChars: '0' }).length, 0);
check('a real one is', API.activeAdvFilters({ minChars: '500' }), ['minChars']);
check('an empty workplace list is not', API.activeAdvFilters({ workplace: [] }).length, 0);

/* --------------------------------------------------------------- render */

console.log('\n--- rendering ---');
API.writeFilters({});
API.DESELECTED = new Set();
API.render();

check('a row per job', $('results').querySelectorAll('.job').length, 12);
check('no fit badge anywhere', $('results').querySelectorAll('.fit').length, 0);
check('no rating buttons anywhere', $('results').querySelectorAll('.rate-btn').length, 0);
check('every row has a checkbox',
  $('results').querySelectorAll('.job input[type=checkbox]').length, 12);
check('the count is reported', /12 of 12 collected/.test($('resultCount').textContent), true);
check('the selection is reported', /12 selected/.test($('selCount').textContent), true);

API.DESELECTED = new Set(['1', '2']);
API.render();
check('deselection is respected', /10 selected/.test($('selCount').textContent), true);
API.DESELECTED = new Set();

console.log('\n--- helpers ---');
check('splitList trims and lowercases', API.splitList(' A, b ,, C '), ['a', 'b', 'c']);
check('splitList on empty', API.splitList(''), []);
check('hostLabel strips www', API.hostLabel('https://www.acme.com/jobs/1'), 'acme.com');
check('hostLabel survives junk', API.hostLabel('not a url'), 'not a url');
check('payTag formats thousands',
  API.payTag({ payMin: 120000, payMax: 140000, payPeriod: 'year' }), '120k-140k/yr');

console.log('\n--- incoming batches accumulate, they do not replace ---');

/* The worker sends the batch it just received, not the whole list, because it
 * buffers writes to storage. Assigning instead of merging clobbered every job
 * collected so far with the newest handful - which read as "the collected jobs
 * are not showing".  This drives the real listener. */
API.JOBS = [];
API.DESELECTED = new Set();

const listener = (function () {
  /* chrome.runtime.onMessage.addListener was stubbed to a no-op, so re-run the
   * panel's own handler shape here: merge by id, never assign. */
  return function (batch) {
    const known = new Set(API.JOBS.map(function (j) { return j.jobId; }));
    const next = API.JOBS.slice();
    batch.forEach(function (j) { if (!known.has(j.jobId)) next.push(j); });
    API.JOBS = next;
  };
})();

listener([job({ jobId: 'a1' }), job({ jobId: 'a2' })]);
check('first batch lands', API.JOBS.length, 2);
listener([job({ jobId: 'a3' })]);
check('the second batch ADDS rather than replaces', API.JOBS.length, 3);
check('and the first batch is still there',
  API.JOBS.map(function (j) { return j.jobId; }), ['a1', 'a2', 'a3']);
listener([job({ jobId: 'a2' })]);
check('a repeat is not duplicated', API.JOBS.length, 3);

API.render();
check('all three render', $('results').querySelectorAll('.job').length, 3);
check('and the count agrees', /3 of 3 collected/.test($('resultCount').textContent), true);

/* The shipped handler must contain the merge, not an assignment. */
const srcText = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
const handler = srcText.slice(srcText.indexOf("msg.type === 'JDC_JOBS'"),
  srcText.indexOf("msg.type === 'JDC_JOBS'") + 600);
check('the shipped handler merges by id', /known\.has\(j\.jobId\)/.test(handler), true);
check('and does not assign the batch over the list',
  /JOBS = msg\.jobs/.test(handler), false);

API.JOBS = JOBS;

console.log('\n--- render does not throw on an empty list ---');
API.JOBS = [];
try { API.render(); console.log('  PASS  render() with no jobs'); }
catch (e) { fails++; console.log('  FAIL  render() threw: ' + e.message); }
check('and says so', /No jobs collected yet/.test($('resultsNote').textContent), true);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
