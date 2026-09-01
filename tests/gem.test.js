/* Tests for the Gem verdict parser. A false REJECT here silently deletes a
 * valid job from every future run, so - same rule as parse.test.js - roughly
 * half these cases are traps that must yield nothing. */

const GV = require('../src/lib/gemVerdicts.js');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

function verdicts(text) {
  return GV.parseVerdicts(text).matches.map((m) => [m.jobId, m.verdict, m.reason]);
}

function ambiguous(text) {
  return GV.parseVerdicts(text).ambiguous;
}

console.log('--- the strict format ---');
check('accept, no reason',
  verdicts('VERDICT 4266112233 ACCEPT'),
  [['4266112233', 'accept', '']]);
check('reject with a colon reason',
  verdicts('VERDICT 4266112233 REJECT: too junior for the role'),
  [['4266112233', 'reject', 'too junior for the role']]);
check('reject with a dash reason',
  verdicts('VERDICT 4266112233 REJECT - too junior'),
  [['4266112233', 'reject', 'too junior']]);
check('reject with a comma reason',
  verdicts('VERDICT 4266112233 REJECT, too junior'),
  [['4266112233', 'reject', 'too junior']]);
check('case-insensitive keyword and verb',
  verdicts('verdict 4266112233 accept'),
  [['4266112233', 'accept', '']]);
check('alphanumeric id (hiring.cafe style)',
  verdicts('VERDICT ab12cd34 ACCEPT'),
  [['ab12cd34', 'accept', '']]);
check('multiple jobs in one reply',
  verdicts([
    'Here is my read on both:',
    'VERDICT 111111111 ACCEPT',
    'VERDICT 222222222 REJECT: no direct clinical experience'
  ].join('\n')),
  [['111111111', 'accept', ''], ['222222222', 'reject', 'no direct clinical experience']]);

console.log('\n--- the loose fallback ---');
check('id first, colon separator',
  verdicts('4266112233: reject, no direct clinical exp'),
  [['4266112233', 'reject', 'no direct clinical exp']]);
check('verb first, "pass on"',
  verdicts('pass on 4266112233'),
  [['4266112233', 'reject', '']]);
check('verb first with a reason',
  verdicts('reject 4266112233: too senior for the client'),
  [['4266112233', 'reject', 'too senior for the client']]);
check('id first, accept',
  verdicts('4266112233 - accept'),
  [['4266112233', 'accept', '']]);

console.log('\n--- a later verdict for the same job wins ---');
check('reversed decision overwrites the earlier one',
  verdicts([
    'VERDICT 4266112233 ACCEPT',
    'Actually, on reflection:',
    'VERDICT 4266112233 REJECT: changed my mind'
  ].join('\n')),
  [['4266112233', 'reject', 'changed my mind']]);

console.log('\n--- traps that must yield no verdict ---');
check('id mentioned in passing, no verdict word',
  verdicts('This job is similar in scope to 4266112233.'),
  []);
check('"VERDICT" used as prose, not the strict format',
  verdicts('VERDICT: still deciding on 4266112233, will follow up tomorrow.'),
  []);
check('"rejected" is not the word "reject"',
  verdicts('We rejected about 40% of applicants last cycle.'),
  []);
check('two ids on one VERDICT line is malformed, not a call',
  verdicts('VERDICT 111111111 222222222 ACCEPT'),
  []);
check('a short number is not an id',
  verdicts('reject 123'),
  []);
check('none of the traps produce a stray match together',
  verdicts([
    'This job is similar in scope to 4266112233.',
    'We rejected about 40% of applicants last cycle.',
    'The verdict is still out on 5555555555.'
  ].join('\n')),
  []);

console.log('\n--- ambiguous lines are surfaced, never auto-imported ---');
check('two ids plus a verdict word is flagged, not guessed',
  ambiguous('VERDICT 111111111 222222222 ACCEPT'),
  ['VERDICT 111111111 222222222 ACCEPT']);
check('a clean trap produces no ambiguous line either',
  ambiguous('This job is similar in scope to 4266112233.'),
  []);
check('yes/no are excluded from the verdict-word check (too generic)',
  ambiguous('No sponsorship is offered for 4266112233.'),
  []);

console.log('\n--- empty / garbage input ---');
check('empty string', verdicts(''), []);
check('no ids or verdicts at all', verdicts('Thanks, this all looks solid to me.'), []);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
