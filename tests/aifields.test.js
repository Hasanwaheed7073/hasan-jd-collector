/* The field check (src/lib/aiFields.js).
 *
 * A model reading one job's pane and filling in what the DOM could not. This
 * is the only place a model's output becomes a FACT in an exported row, so the
 * suite is weighted the way the verdict parser's is: most of it is answers
 * that must be refused.
 *
 * The rule under test throughout: the model may only repeat what is on the
 * page. A company name that is not in the text it was shown is dropped. A
 * salary that is not in the text is dropped. "Remote" is accepted only if the
 * word is there to be read. Anything else and the extension would be quietly
 * claiming the posting said something it did not - and nothing downstream
 * could tell an invented $140,000 from a real one.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

/* aiFields leans on aiPlan for the reply-unwrapping it already does well
 * (fences, <think> blocks, brace matching), so both load. */
require(path.join(ROOT, 'src', 'lib', 'aiPlan.js'));
const F = require(path.join(ROOT, 'src', 'lib', 'aiFields.js'));

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

/* The text a model would actually be shown: a header and the start of a
 * posting, nothing more. */
const SAMPLE = [
  'CapsLock',
  'Business Development Manager',
  'Massachusetts, United States · 1 month ago · 12 people clicked apply',
  '$90K/yr - $120K/yr  Remote  Full-time',
  'Easy Apply    Save',
  '',
  'About the job',
  'We are looking for a Business Development Manager to own new logo',
  'acquisition across the northeast. Requirements: 7+ years of quota-carrying',
  'B2B sales experience, and travel up to 30% to customer sites.'
].join('\n');

/* ------------------------------------------------------------ the ask ---- */

console.log('--- what the model is asked for ---');

const prompt = F.systemPrompt(['company', 'payText']);
check('only the missing fields are asked about',
  /"company"/.test(prompt) && /"payText"/.test(prompt), true);
check('and the others are left out', /"seniority"/.test(prompt), false);
check('it is told to copy, not paraphrase', /Copy, do not paraphrase/.test(prompt), true);
check('and that a guess buys nothing', /thrown away/.test(prompt), true);
check('it is never asked to judge the job',
  /rate it|score|fit|good/i.test(prompt.replace('Do not summarise the job, rate it, or comment on it.', '')), false);

const msgs = F.buildMessages(SAMPLE, ['company']);
check('the page text is what it sees', /Business Development Manager/.test(msgs[1].content), true);
check('two messages, system then user', msgs.map(function (m) { return m.role; }), ['system', 'user']);

/* --------------------------------------------------------- the reply ----- */

console.log('\n--- reading the reply ---');

check('a clean object parses',
  F.parseFields('{"company":"CapsLock","payText":"$90K/yr - $120K/yr"}').fields,
  { company: 'CapsLock', payText: '$90K/yr - $120K/yr' });
check('fences and a think block are handled',
  F.parseFields('<think>hmm</think>```json\n{"company":"CapsLock"}\n```').fields,
  { company: 'CapsLock' });
check('nulls are dropped rather than kept as "null"',
  F.parseFields('{"company":"CapsLock","seniority":null}').fields, { company: 'CapsLock' });
check('prose is refused', F.parseFields('I think the company is CapsLock.').ok, false);
check('an empty reply is refused', F.parseFields('').ok, false);
check('a field we never asked about is not carried',
  F.parseFields('{"salaryOpinion":"generous"}').fields, {});

/* ------------------------------------------------ the check that matters -- */

console.log('\n--- a value that is on the page is kept ---');

let v = F.verify({
  company: 'CapsLock',
  payText: '$90K/yr - $120K/yr',
  workplaceType: 'Remote',
  employmentType: 'Full-time',
  applyRoute: 'easy_apply'
}, SAMPLE, {});

check('all five survive', Object.keys(v.accepted).sort(),
  ['applyRoute', 'company', 'employmentType', 'payText', 'workplaceType']);
check('with their values intact', v.accepted.payText, '$90K/yr - $120K/yr');
check('and nothing rejected', v.rejected, []);

console.log('\n--- and a value that is NOT on the page is thrown away ---');

/* Each of these is a plausible, helpful-looking answer. Each is a fabrication,
 * and each would be indistinguishable from a real fact once it reached a row. */
const invented = F.verify({
  company: 'CapsLock Technologies Inc.',      // embellished
  payText: '$140,000 - $180,000',             // invented outright
  workplaceType: 'Hybrid',                    // the page says Remote
  seniority: 'Director',                      // not stated anywhere
  location: 'Boston, MA'                      // paraphrased, not quoted
}, SAMPLE, {});

check('nothing is accepted', v2Keys(invented), []);
check('the embellished company is named',
  reasonFor(invented, 'company'), 'not found in the page text');
check('so is the invented salary',
  reasonFor(invented, 'payText'), 'not found in the page text');
check('a workplace type the page contradicts',
  reasonFor(invented, 'workplaceType'), 'the page does not say it');
check('a seniority nobody wrote down',
  reasonFor(invented, 'seniority'), 'the page does not say it');
check('and a paraphrased location',
  reasonFor(invented, 'location'), 'not found in the page text');

function v2Keys(res) { return Object.keys(res.accepted); }
function reasonFor(res, field) {
  const hit = res.rejected.filter(function (r) { return r.field === field; })[0];
  return hit ? hit.why : '(not rejected)';
}

console.log('\n--- the page always wins ---');

const overwrite = F.verify(
  { company: 'CapsLock', workplaceType: 'Remote' },
  SAMPLE,
  { company: 'CapsLock', workplaceType: 'Remote' });
check('a field the page already read is not touched', overwrite.accepted, {});
check('and the reason says why',
  reasonFor(overwrite, 'company'), 'already read from the page');

const partial = F.verify(
  { company: 'CapsLock', employmentType: 'Full-time' },
  SAMPLE,
  { company: 'Acme' });
check('while a genuine gap beside it is still filled',
  partial.accepted, { employmentType: 'Full-time' });

console.log('\n--- tokens have to be earned ---');

check('easy_apply needs the words on the page',
  F.verify({ applyRoute: 'easy_apply' }, SAMPLE, {}).accepted.applyRoute, 'easy_apply');
check('and is refused when they are not',
  reasonFor(F.verify({ applyRoute: 'easy_apply' }, 'Apply on company website', {}), 'applyRoute'),
  'nothing on the page says so');
check('external needs an Apply of some kind',
  F.verify({ applyRoute: 'external' }, 'Apply on company website', {}).accepted.applyRoute,
  'external');
check('a made-up route is refused',
  reasonFor(F.verify({ applyRoute: 'call them' }, SAMPLE, {}), 'applyRoute'),
  'not one of easy_apply/external/unknown');
/* "unknown" is the model declining, not a value to write: the field is
 * already unknown, and recording that a model agreed adds nothing but a
 * misleading AI label on the row. */
const declinedRoute = F.verify({ applyRoute: 'unknown' }, '', {});
check('"unknown" is treated as declining, not as an answer',
  [Object.keys(declinedRoute.accepted).length, declinedRoute.rejected.length], [0, 0]);

console.log('\n--- declining is a correct answer ---');
[null, '', 'null', 'None', 'N/A', 'unknown', 'not stated'].forEach(function (value) {
  const res = F.verify({ company: value }, SAMPLE, {});
  check('  ' + JSON.stringify(value) + ' is neither accepted nor rejected',
    [Object.keys(res.accepted).length, res.rejected.length], [0, 0]);
});

console.log('\n--- sanity bounds ---');
const essay = 'CapsLock ' + 'and its many subsidiaries '.repeat(20);
check('a company the length of a paragraph is refused',
  reasonFor(F.verify({ company: essay }, SAMPLE + essay, {}), 'company'),
  'longer than a company can be');

console.log('\n--- which gaps are worth asking about ---');

check('a complete job asks nothing', F.gaps({
  title: 'BDM', company: 'CapsLock', location: 'Boston', workplaceType: 'Remote',
  employmentType: 'Full-time', seniority: 'Director', payMinAnnual: 90000,
  applyType: 'external'
}), []);

check('an empty job asks about everything', F.gaps({}).sort(),
  ['applyRoute', 'company', 'employmentType', 'location', 'payText', 'seniority',
    'title', 'workplaceType']);

check('"Unknown" counts as missing, not as an answer',
  F.gaps({ workplaceType: 'Unknown', applyType: 'unknown' })
    .filter(function (k) { return k === 'workplaceType' || k === 'applyRoute'; }),
  ['workplaceType', 'applyRoute']);

check('pay already parsed is not asked about',
  F.gaps({ payMinAnnual: 90000 }).indexOf('payText'), -1);
check('but pay found nowhere is', F.gaps({}).indexOf('payText') !== -1, true);

console.log('\n--- how much of the posting leaves the browser ---');

const long = 'x'.repeat(20000);
const sample = F.sampleFor('HEADER LINE', long, 4000);
check('the cap is respected', sample.length <= 4000, true);
check('the header always survives it', /HEADER LINE/.test(sample), true);
check('a short posting is not padded',
  F.sampleFor('H', 'short body', 4000), 'H\n\nshort body');
check('and the default cap is 4,000',
  F.sampleFor('H', long).length <= 4000, true);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
