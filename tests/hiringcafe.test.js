/* The hiringcafe adapter, against a response captured from the live site on
 * 2026-08-24 (tests/fixtures/hiringcafe-search.json, 5 real hits).
 *
 * The rule this suite is built around: a field the source did not state must
 * come out `null`, never 0 and never ''. The panel's numeric filters compare
 * these directly and its flag filters drop a job outright on them, so a guessed
 * value does not merely mislead - it silently deletes valid jobs from the list. */

const fs = require('fs');
const path = require('path');

const HC = require('../src/lib/hiringcafe.js');
const PARSE = require('../src/content/parse.js');

const FIX = path.join(__dirname, 'fixtures');
const search = JSON.parse(fs.readFileSync(path.join(FIX, 'hiringcafe-search.json'), 'utf8'));
const descBody = JSON.parse(fs.readFileSync(path.join(FIX, 'hiringcafe-description.json'), 'utf8'));

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

/* ------------------------------------------------------------ html to text */

console.log('--- html to text, matching extract.js conventions ---');

check('list items become dash-prefixed lines',
  HC.htmlToText('<ul><li>ICH-GCP</li><li>EDC</li></ul>'), '- ICH-GCP\n- EDC');
check('paragraphs are separated by a blank line',
  HC.htmlToText('<p>One</p><p>Two</p>'), 'One\n\nTwo');
check('br becomes a single newline', HC.htmlToText('a<br>b'), 'a\nb');
check('inline tags are dropped, text kept',
  HC.htmlToText('<p>Requires <strong>ICH-GCP</strong> and <em>EDC</em>.</p>'),
  'Requires ICH-GCP and EDC.');
check('script content is discarded',
  HC.htmlToText('<p>Real</p><script>var x = "fake";</script>'), 'Real');
check('style content is discarded',
  HC.htmlToText('<style>p{color:red}</style><p>Real</p>'), 'Real');
check('comments are discarded', HC.htmlToText('<!-- hi --><p>Real</p>'), 'Real');
check('runs of blank lines collapse',
  HC.htmlToText('<div></div><div></div><p>A</p><div></div><div></div><p>B</p>'), 'A\n\nB');
check('empty input', HC.htmlToText(''), '');
check('null input', HC.htmlToText(null), '');
check('plain text passes through', HC.htmlToText('no tags here'), 'no tags here');

console.log('\n--- entities ---');
check('named', HC.decodeEntities('a&amp;b&nbsp;c'), 'a&b c');
check('numeric decimal', HC.decodeEntities('&#8217;'), '’');
check('numeric hex', HC.decodeEntities('&#x2019;'), '’');
check('an unknown entity is left alone', HC.decodeEntities('&notathing;'), '&notathing;');
check('decoded inside html', HC.htmlToText('<p>Sponsor&rsquo;s site</p>'), 'Sponsor’s site');

/* --------------------------------------------------------------- envelope */

console.log('\n--- reading the page ---');

/* The fixture is the saved pageProps, so wrap it the way the real page does. */
const asPage = (props) =>
  '<html><body><script id="__NEXT_DATA__" type="application/json">' +
  JSON.stringify({ props: { pageProps: props } }) +
  '</script></body></html>';

let page = HC.pageFrom(asPage(search));
check('hits found', page.hits.length, 5);
check('page number', page.page, 0);
check('total carried through', page.total, search.ssrTotalCount);
check('not the last page', page.lastPage, false);
check('no error', page.error, null);

console.log('\n--- a broken page degrades, never throws ---');
check('no __NEXT_DATA__ at all', HC.pageFrom('<html><body>nope</body></html>').hits, []);
check('and it says why', /no __NEXT_DATA__/.test(HC.pageFrom('<html></html>').error), true);
check('malformed json inside the tag',
  HC.pageFrom('<script id="__NEXT_DATA__" type="application/json">{oops</script>').hits, []);
check('valid json, wrong shape', HC.pageFrom(asPage({ somethingElse: 1 })).hits, []);
check('ssrHits present but not an array', HC.pageFrom(asPage({ ssrHits: 'nope' })).hits, []);
check('empty hits reads as the last page', HC.pageFrom(asPage({ ssrHits: [] })).lastPage, true);
check('empty string', HC.pageFrom('').hits, []);
check('null', HC.pageFrom(null).hits, []);
check('the ssrIsLastPage flag is honoured',
  HC.pageFrom(asPage({ ssrHits: [{}], ssrIsLastPage: true })).lastPage, true);

console.log('\n--- the description call ---');
const desc = HC.descriptionFrom(descBody);
check('description extracted', desc.length > 500, true);
check('it is text, not html', /<[a-z]/i.test(desc), false);
check('accepts a raw json string too',
  HC.descriptionFrom(JSON.stringify(descBody)).length, desc.length);
check('a missing description yields empty', HC.descriptionFrom({ job: {} }), '');
check('junk yields empty', HC.descriptionFrom('not json'), '');
check('null yields empty', HC.descriptionFrom(null), '');

/* -------------------------------------------------------------- searchState */

console.log('\n--- building a search from a saved search record ---');

/* The shape the panel now hands over - its search fields, nothing more. */
const saved = {
  keywords: 'clinical research associate',
  location: 'United States',
  remote: '2,3',
  posted: 'r604800'
};

let state = HC.buildSearchState(saved);
check('the query carries over', state.searchQuery, 'clinical research associate');
check('one location', state.locations.length, 1);
check('named', state.locations[0].formatted_address, 'United States');
check('with the right country code', state.locations[0].address_components[0].short_name, 'US');
check('remote+hybrid maps to both', state.workplaceTypes, ['Remote', 'Hybrid']);
check('a week becomes 7 days', state.dateFetchedPastNDays, 7);

check('remote only', HC.buildSearchState({ remote: '2' }).workplaceTypes, ['Remote']);
check('on-site only', HC.buildSearchState({ remote: '1' }).workplaceTypes, ['Onsite']);
check('an unknown code sets nothing',
  HC.buildSearchState({ remote: '9' }).workplaceTypes, undefined);
check('"any" sets nothing', HC.buildSearchState({ remote: '' }).workplaceTypes, undefined);

/* A location is not optional in practice: without one the backend geolocates
 * the caller, and the same query returned 29 non-US results instead of 1,632. */
check('no location means no locations key', HC.buildSearchState({}).locations, undefined);
check('a blank location too', HC.buildSearchState({ location: '  ' }).locations, undefined);
check('an unlisted country still resolves', HC.locationFor('Japan').address_components[0].short_name, 'JA');
check('an empty name yields nothing', HC.locationFor(''), null);

check('posted codes: 24h', HC.daysFromPosted('r86400'), 1);
check('posted codes: 3 days', HC.daysFromPosted('r259200'), 3);
check('posted codes: month', HC.daysFromPosted('r2592000'), 30);
check('"any time" is not a day count', HC.daysFromPosted(''), null);
check('junk is not a day count', HC.daysFromPosted('week'), null);

console.log('\n--- urls ---');
const u = HC.searchUrl({ searchQuery: 'cra' }, 0);
check('search url has no page on the first', /[?&]page=/.test(u), false);
check('and is the right host', u.indexOf('https://hiringcafe.com/?searchState=') , 0);
check('the state is url-encoded json',
  decodeURIComponent(u.split('searchState=')[1]), '{"searchQuery":"cra"}');
check('later pages are numbered', /&page=2$/.test(HC.searchUrl({}, 2)), true);
check('description url encodes the id',
  HC.descriptionUrl('avature___a b___1'),
  'https://hiringcafe.com/api/job-description?id=avature___a%20b___1');

/* --------------------------------------------------------------- normalise */

console.log('\n--- normalising the real fixture ---');

const hits = search.ssrHits;
const jobs = HC.normaliseAll(hits, { now: Date.UTC(2026, 7, 24) });
check('every hit normalised', jobs.length, hits.length);
check('all have an id', jobs.every((j) => !!j.jobId), true);
check('all have a title', jobs.every((j) => !!j.title), true);
check('all have a company', jobs.every((j) => !!j.company), true);
check('all tagged with the source', jobs.every((j) => j.source === 'hiringcafe'), true);
check('all carry an apply url', jobs.every((j) => !!j.applyUrl), true);
check('so all are direct-apply', jobs.every((j) => j.applyType === 'external'), true);
check('the ATS behind each is recorded', jobs.every((j) => typeof j.atsSource === 'string'), true);

console.log('\n--- unknowns stay null, never zero or empty ---');
const noData = HC.normalise({
  id: 'x1', apply_url: 'https://example.com/a', job_information: { title: 'CRA II' },
  v5_processed_job_data: { company_name: 'Acme' }
});
check('pay min', noData.payMinAnnual, null);
check('pay max', noData.payMaxAnnual, null);
check('pay raw is empty, not "$0"', noData.payRaw, '');
check('years of experience', noData.yoeMin, null);
check('travel', noData.travelPct, null);
check('clearance', noData.needsClearance, null);
check('sponsorship', noData.sponsorshipUnavailable, null);
check('applicants', noData.applicants, null);
check('posted days', noData.postedDaysAgo, null);
check('workplace falls back to Unknown', noData.workplaceType, 'Unknown');

console.log('\n--- years of experience is tri-state ---');
const yoe = (v) => HC.normalise({ id: 'y', v5_processed_job_data: v }).yoeMin;
check('stated', yoe({ min_industry_and_role_yoe: 5, is_min_industry_and_role_yoe_not_mentioned: false }), 5);
check('explicitly not mentioned', yoe({ min_industry_and_role_yoe: 5, is_min_industry_and_role_yoe_not_mentioned: true }), null);
check('flag unknown means do not trust the number',
  yoe({ min_industry_and_role_yoe: 5, is_min_industry_and_role_yoe_not_mentioned: null }), null);
check('a stated zero survives',
  yoe({ min_industry_and_role_yoe: 0, is_min_industry_and_role_yoe_not_mentioned: false }), 0);

console.log('\n--- compensation ---');
const pay = (v) => HC.normalise({ id: 'p', v5_processed_job_data: v });
let p = pay({ yearly_min_compensation: 95000, yearly_max_compensation: 120000, listed_compensation_currency: 'USD' });
check('a yearly range', [p.payMinAnnual, p.payMaxAnnual], [95000, 120000]);
check('formatted for the panel', p.payRaw, '$95,000 - $120,000');
check('source recorded', p.paySource, 'hiringcafe:yearly');

p = pay({ hourly_min_compensation: 50, hourly_max_compensation: 60, listed_compensation_currency: 'USD' });
check('hourly is annualised at 2080h', [p.payMinAnnual, p.payMaxAnnual], [104000, 124800]);
check('and says so', p.paySource, 'hiringcafe:hourly');

/* A EUR figure compared against a USD floor would mis-score silently. */
p = pay({ yearly_min_compensation: 60000, listed_compensation_currency: 'EUR' });
check('a non-USD figure is refused', p.payMinAnnual, null);
check('rather than converted', p.payRaw, '');

p = pay({ yearly_min_compensation: 110000, listed_compensation_currency: 'USD' });
check('a single figure formats alone', p.payRaw, '$110,000');
/* The source annualises hourly itself and returns fractions - seen live as
 * $89,889.904 - which then showed up inside a fit reason. */
check('a fractional yearly figure is rounded to whole dollars',
  pay({ yearly_min_compensation: 70304, yearly_max_compensation: 89889.904,
    listed_compensation_currency: 'USD' }).payMaxAnnual, 89890);
check('and formats without decimals',
  pay({ yearly_min_compensation: 89889.904, listed_compensation_currency: 'USD' }).payRaw,
  '$89,890');

check('yearly wins over hourly when both exist',
  pay({ yearly_min_compensation: 100000, hourly_min_compensation: 9,
    listed_compensation_currency: 'USD' }).payMinAnnual, 100000);

console.log('\n--- clearance and sponsorship polarity ---');
const flag = (v) => HC.normalise({ id: 'f', v5_processed_job_data: v });
check('"None" is not a clearance requirement', flag({ security_clearance: 'None' }).needsClearance, false);
check('anything else is', flag({ security_clearance: 'Secret' }).needsClearance, true);
check('absent stays null', flag({}).needsClearance, null);
check('sponsorship offered is a known negative',
  flag({ visa_sponsorship: true }).sponsorshipUnavailable, false);
/* false cannot be told apart from "never mentioned", and the "hide
 * no-sponsorship" filter drops a job outright on it - so it must not become
 * true. */
check('sponsorship false is NOT read as unavailable',
  flag({ visa_sponsorship: false }).sponsorshipUnavailable, null);

console.log('\n--- workplace type ---');
const wp = (t) => HC.normalise({ id: 'w', v5_processed_job_data: { workplace_type: t } });
check('Onsite', wp('Onsite').workplaceType, 'On-site');
check('Remote', wp('Remote').workplaceType, 'Remote');
check('Hybrid', wp('Hybrid').workplaceType, 'Hybrid');
/* Field work for a CRA is site visits, often home-based between them. Calling
 * it On-site would drop it from a remote-only filter. */
check('Field is not forced into a bucket', wp('Field').workplaceType, 'Unknown');
check('but the raw value is kept', wp('Field').workplaceRaw, 'Field');

console.log('\n--- travel is an enum, not a percentage ---');
const trav = (a, l) => HC.normalise({ id: 't', v5_processed_job_data: { air_travel_requirement: a, land_travel_requirement: l } }).travelPct;
check('none at all is zero', trav('None', 'None'), 0);
check('occasional maps to a low band', trav('None', 'Occasional'), 25);
check('extensive maps to a high band', trav('Extensive', 'None'), 75);
check('the worse of the two wins', trav('Extensive', 'Occasional'), 75);
check('unrecognised wording stays null', trav('Sometimes maybe', ''), null);
check('absent stays null', HC.normalise({ id: 't2', v5_processed_job_data: {} }).travelPct, null);

console.log('\n--- posted age ---');
const NOW = Date.UTC(2026, 7, 24);
const age = (ms) => HC.normalise({ id: 'a', v5_processed_job_data: { estimated_publish_date_millis: ms } }, { now: NOW }).postedDaysAgo;
check('three days ago', age(NOW - 3 * 86400000), 3);
check('today', age(NOW), 0);
check('a future date clamps to zero', age(NOW + 86400000), 0);
check('missing stays null', age(null), null);

console.log('\n--- certifications and tools reach the description ---');

/* The JD text filters match against the description, and so does whoever reads
 * the export, so structured lists that never appear in the prose have to be
 * appended or they are invisible to both. */
const withLists = HC.normalise({
  id: 'c1', apply_url: 'https://x/a',
  job_information: { title: 'CRA II' },
  v5_processed_job_data: {
    company_name: 'Acme CRO',
    requirements_summary: 'Monitor oncology trials.',
    licenses_or_certifications: ['ICH-GCP', 'ACRP'],
    technical_tools: ['Medidata Rave', 'Veeva Vault'],
    role_activities: ['site monitoring']
  }
});
check('the certifications are in the text', /ICH-GCP, ACRP/.test(withLists.description), true);
check('the tools are too', /Medidata Rave, Veeva Vault/.test(withLists.description), true);
check('and the activities', /site monitoring/.test(withLists.description), true);
check('they are also kept structured', withLists.certifications, ['ICH-GCP', 'ACRP']);
check('tools too', withLists.tools, ['Medidata Rave', 'Veeva Vault']);
check('descriptionChars matches the text', withLists.descriptionChars, withLists.description.length);
check('the summary was used as the body', withLists.descriptionSource, 'hiringcafe:summary');

const withFull = HC.normalise({
  id: 'c2', v5_processed_job_data: { requirements_summary: 'Short.', technical_tools: ['EDC'] }
}, { description: 'The full posting text, several paragraphs long.' });
check('a fetched description wins over the summary',
  /full posting text/.test(withFull.description), true);
check('and is reported as full', withFull.descriptionSource, 'hiringcafe:full');
check('with the lists still appended', /Tools and systems: EDC/.test(withFull.description), true);
check('no text at all is reported honestly',
  HC.normalise({ id: 'c3', v5_processed_job_data: {} }).descriptionSource, 'none');

console.log('\n--- expired postings never reach the shortlist ---');
check('an expired hit is dropped',
  HC.normaliseAll([{ id: 'e1', is_expired: true, v5_processed_job_data: {} }]).length, 0);
check('a live one is kept',
  HC.normaliseAll([{ id: 'e2', is_expired: false, v5_processed_job_data: {} }]).length, 1);
check('a junk row is dropped, not thrown on', HC.normaliseAll([null, 5, {}]).length, 0);
check('a hit with no id is dropped', HC.normalise({ v5_processed_job_data: {} }), null);
check('an empty list is fine', HC.normaliseAll([]), []);
check('null is fine', HC.normaliseAll(null), []);

/* ------------------------------------------------- downstream compatibility */

console.log('\n--- the rest of the pipeline accepts these jobs unchanged ---');

/* There is no scorer any more, so what matters is that every field the panel
 * filters and exports on is present and of the right type. A normalised
 * hiringcafe job has to be indistinguishable from a LinkedIn one downstream. */
const REQUIRED = ['jobId', 'title', 'company', 'location', 'workplaceType',
  'applyType', 'url', 'description', 'descriptionChars'];
let complete = 0;
jobs.forEach(function (j) {
  if (REQUIRED.every(function (k) { return j[k] !== undefined; })) complete++;
});
check('every job carries the fields the panel needs', complete, jobs.length);
check('ids are strings', jobs.every(function (j) { return typeof j.jobId === 'string'; }), true);
check('descriptionChars matches the text',
  jobs.every(function (j) { return j.descriptionChars === j.description.length; }), true);

/* The nullable facts must be null or a number - never a string, never NaN,
 * because the panel's filters compare them numerically. */
['payMinAnnual', 'payMaxAnnual', 'yoeMin', 'travelPct', 'postedDaysAgo'].forEach(function (k) {
  const bad = jobs.filter(function (j) {
    return !(j[k] === null || (typeof j[k] === 'number' && !isNaN(j[k])));
  });
  check('  ' + k + ' is null or a real number', bad.length, 0);
});

check('the tri-state flags are null or boolean',
  jobs.every(function (j) { return j.needsClearance === null || typeof j.needsClearance === 'boolean'; }), true);

/* parse.js still owns the prose-only signals: a "Remote" tag can contradict a
 * description that demands office days, and only the text shows that. */
check('the adapter does not pre-decide contradiction',
  HC.normalise({ id: 'r1', v5_processed_job_data: { workplace_type: 'Remote' } }).remoteContradiction,
  false);
check('parse.js is still loadable', typeof PARSE === 'object' && PARSE !== null, true);

console.log('\n--- a full page walks end to end ---');
page = HC.pageFrom(asPage(search));
const walked = HC.normaliseAll(page.hits, { now: NOW });
check('page to jobs', walked.length, 5);
check('all have an id and a title',
  walked.every(function (j) { return !!j.jobId && !!j.title; }), true);
check('all have description text', walked.every((j) => j.descriptionChars > 0), true);
console.log('  sample: ' + JSON.stringify(walked[0].title) + ' @ ' +
  JSON.stringify(walked[0].company) + ' | ' + walked[0].workplaceType +
  ' | ats=' + walked[0].atsSource + ' | ' + walked[0].descriptionChars + ' chars');

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
