/* Tests for the JD prose parsers. These are the highest-risk code in the
 * extension: a false positive silently drops a good job out of a filter, so
 * roughly half these cases are traps that must parse to null. */

const P = require('../src/content/parse.js');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
               '\n          actual   ' + JSON.stringify(actual)));
}

function pay(text) {
  const r = P.parsePay(text);
  return [r.payMin, r.payMax, r.payPeriod, r.payMinAnnual, r.payMaxAnnual];
}

console.log('--- compensation: real ranges ---');
check('annual range with symbols',
  pay('The base salary range is $120,000 - $150,000 per year.'),
  [120000, 150000, 'year', 120000, 150000]);
check('K-suffixed range',
  pay('Compensation: $120K-$150K'),
  [120000, 150000, 'year', 120000, 150000]);
check('range using "to" and "annually"',
  pay('Base salary range: $95,000 to $115,000 annually'),
  [95000, 115000, 'year', 95000, 115000]);
check('hourly range annualizes at 2080h',
  pay('The hourly rate for this position is $60 - $75 per hour.'),
  [60, 75, 'hour', 124800, 156000]);
check('single hourly rate',
  pay('Pay rate: $65/hr'),
  [65, null, 'hour', 135200, null]);
check('no currency symbol but an explicit pay cue',
  pay('Salary: 120,000 - 150,000 per year'),
  [120000, 150000, 'year', 120000, 150000]);
check('currency code form',
  pay('Compensation is USD 130,000 annually.'),
  [130000, null, 'year', 130000, null]);
check('non-dollar currency',
  pay('Salary range of £70,000 - £85,000 per annum'),
  [70000, 85000, 'year', 70000, 85000]);
check('LinkedIn pill format with the unit inside the separator',
  pay('$110,000/yr - $135,000/yr'),
  [110000, 135000, 'year', 110000, 135000]);
check('LinkedIn pill format, hourly',
  pay('$60.00/hr - $75.00/hr'),
  [60, 75, 'hour', 124800, 156000]);
check('LinkedIn pill format, K-suffixed',
  pay('$110K/yr - $135K/yr'),
  [110000, 135000, 'year', 110000, 135000]);
check('monthly pay annualizes',
  pay('Salary of $9,000 per month'),
  [9000, null, 'month', 108000, null]);
check('currency recorded',
  P.parsePay('Salary range of £70,000 - £85,000 per annum').payCurrency, '£');
check('raw text captured',
  P.parsePay('The base salary range is $120,000 - $150,000 per year.').payRaw,
  '$120,000 - $150,000 per year');

console.log('\n--- compensation: traps that must NOT parse ---');
check('headcount / patient volume', pay('We serve 12,000 patients across 30 sites.'),
  [null, null, '', null, null]);
check('funding round', pay('The company raised $50 million in Series B funding.'),
  [null, null, '', null, null]);
check('401(k) match', pay('We offer a 401(k) with a 5% employer match.'),
  [null, null, '', null, null]);
check('sign-on bonus below any plausible salary',
  pay('A $5,000 sign-on bonus is included.'),
  [null, null, '', null, null]);
check('small monthly stipend', pay('Travel reimbursement of up to $500 per month.'),
  [null, null, '', null, null]);
check('bare ambiguous amount', pay('Equipment budget of $500'),
  [null, null, '', null, null]);
check('annual revenue figure', pay('A division with $400,000,000 in annual revenue.'),
  [null, null, '', null, null]);
check('empty input', pay(''), [null, null, '', null, null]);

console.log('\n--- compensation: picks the salary, not the bonus ---');
check('range with a cue beats a nearby bonus',
  pay('Referral bonus of $2,000 available. The base salary range for this role is $120,000 - $140,000.'),
  [120000, 140000, 'year', 120000, 140000]);
check('single cued salary still found',
  pay('Salary is $135,000 annually.'),
  [135000, null, 'year', 135000, null]);

console.log('\n--- years of experience ---');
const yoe = (t) => P.parseYoe(t).yoeMin;
check('plus form', yoe('5+ years of clinical monitoring experience required.'), 5);
check('range takes the floor', yoe('3-5 years of relevant experience.'), 3);
check('written number with digits in parens',
  yoe('Minimum of seven (7) years experience in the industry.'), 7);
check('multiple requirements take the binding one',
  yoe('3+ years in clinical research. 5+ years of monitoring experience.'), 5);
check('"at least" phrasing', yoe('Candidates need at least 2 years experience.'), 2);
check('yrs abbreviation', yoe('Requires 4 yrs experience.'), 4);
check('requirement bullet with no cue word',
  yoe('- 3+ years of independent monitoring'), 3);
check('"years in" phrasing with no cue word',
  yoe('- 4+ years in clinical research'), 4);
check('range with a domain, no cue word',
  yoe('2-4 years of oncology trial work'), 2);

console.log('\n--- years of experience: traps ---');
check('company age', yoe('Our company has been in business for over 20 years.'), null);
check('recency window', yoe('Required: candidates who have worked in the past 3 years.'), null);
check('company history', yoe('A firm with 40 years of history in the sector.'), null);
check('no experience cue at all', yoe('The trial runs for 3 years.'), null);
check('empty input', yoe(''), null);
check('mentions are recorded for review',
  P.parseYoe('5+ years of monitoring experience.').yoeMentions.length, 1);

console.log('\n--- eligibility flags ---');
const flags = (t) => P.parseFlags(t);
check('clearance', flags('An active Secret clearance is required.').needsClearance, true);
check('TS/SCI', flags('Must hold TS/SCI eligibility.').needsClearance, true);
check('no clearance mention', flags('Monitor oncology trials.').needsClearance, false);
check('cannot sponsor', flags('We are unable to sponsor visas at this time.').sponsorshipUnavailable, true);
check('citizenship required', flags('Must be a US citizen.').sponsorshipUnavailable, true);
check('sponsorship offered is not a flag',
  flags('Visa sponsorship is available for this role.').sponsorshipUnavailable, false);
check('relocation required', flags('The candidate must relocate to Boston.').requiresRelocation, true);
check('relocation assistance is not a requirement',
  flags('Relocation assistance is offered.').requiresRelocation, false);
check('not remote', flags('This is not a remote position.').notRemote, true);
check('must work on-site', flags('Employees must work on-site.').notRemote, true);
check('flag snippet captured',
  /Secret clearance/.test(flags('An active Secret clearance is required.').flagSnippets.needsClearance), true);

console.log('\n--- travel ---');
check('travel up to N%', flags('Travel up to 50% is required.').travelPct, 50);
check('N% travel', flags('This role involves 25% travel.').travelPct, 25);
check('travel range takes the ceiling', flags('Travel up to 25-50% domestically.').travelPct, 50);
check('no travel mention', flags('Fully desk-based role.').travelPct, null);
check('unrelated percentage ignored',
  flags('We offer a 5% employer match on retirement.').travelPct, null);

console.log('\n--- onsite days ---');
check('on-site N days per week',
  flags('Employees are expected on-site 3 days per week.').onsiteDaysPerWeek, 3);
check('written days in the office',
  flags('You will work three days a week in the office.').onsiteDaysPerWeek, 3);
check('no onsite requirement',
  flags('Work from anywhere in the US.').onsiteDaysPerWeek, null);

console.log('\n--- combined parseDescription ---');
const combined = P.parseDescription(
  'Senior CRA opening. 5+ years of monitoring experience required. ' +
  'The base salary range is $120,000 - $150,000 per year. ' +
  'Travel up to 40%. Must be a US citizen. Employees are on-site 2 days per week.'
);
check('combined pay', [combined.payMin, combined.payMax], [120000, 150000]);
check('combined yoe', combined.yoeMin, 5);
check('combined travel', combined.travelPct, 40);
check('combined sponsorship', combined.sponsorshipUnavailable, true);
check('combined onsite', combined.onsiteDaysPerWeek, 2);
check('combined clearance stays false', combined.needsClearance, false);

console.log('\n--- a realistic full JD ---');
const JD = [
  'About Acme CRO',
  'Acme has supported sponsors for over 20 years and serves 12,000 patients annually.',
  '',
  'The Role',
  'We are seeking a Clinical Research Associate II to monitor oncology trials.',
  '',
  'Requirements',
  '- Bachelor degree in a life science',
  '- 3+ years of independent on-site monitoring experience',
  '- 5+ years total experience in clinical research',
  '- Strong ICH-GCP knowledge',
  '- Travel up to 60% domestically',
  '',
  'Location',
  'This is a remote role, however you will be expected on-site 1 day per week for team meetings.',
  '',
  'Compensation',
  'The expected base salary range for this position is $110,000 - $135,000 per year,',
  'plus a 10% annual bonus target and a 401(k) with a 4% match.',
  'A $3,000 sign-on bonus is available.',
  '',
  'We are not able to sponsor work visas for this position.'
].join('\n');

const full = P.parseDescription(JD);
check('full JD pay', [full.payMin, full.payMax, full.payPeriod], [110000, 135000, 'year']);
check('full JD annualized', [full.payMinAnnual, full.payMaxAnnual], [110000, 135000]);
check('full JD yoe (binding requirement)', full.yoeMin, 5);
check('full JD travel', full.travelPct, 60);
check('full JD onsite days', full.onsiteDaysPerWeek, 1);
check('full JD sponsorship', full.sponsorshipUnavailable, true);
check('full JD clearance', full.needsClearance, false);
check('full JD relocation', full.requiresRelocation, false);
console.log('  yoe mentions: ' + JSON.stringify(full.yoeMentions.map((m) => m.years)));
console.log('  payRaw: ' + JSON.stringify(full.payRaw));

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
