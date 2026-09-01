/* AI assist: the reply parser, the page outline, and the check that stands
 * between a model's answer and the collector.
 *
 * The model is asked WHERE things are, never what they say, so this suite is
 * weighted the same way the verdict parser's is: most of the cases are answers
 * that must be REFUSED. A selector that matches one card, a "description" that
 * is twelve characters long, `body`, a reply that is a paragraph of prose with
 * a JSON object somewhere inside it - each of those is a plausible thing for a
 * free endpoint to return, and each would quietly wreck a run if it were
 * believed.
 *
 * Two levels:
 *   1. src/lib/aiPlan.js head-less - reply text in, plan out. No DOM.
 *   2. The page side in jsdom, against a page shaped like LinkedIn's AI job
 *      search: hashed class names, cards whose links all carry the same
 *      currentJobId, and no selector anywhere that the hand-written layer
 *      matches.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'content');

let fails = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '\n          expected ' + JSON.stringify(expected) +
      '\n          actual   ' + JSON.stringify(actual)));
}

const AIPLAN = require(path.join(ROOT, 'src', 'lib', 'aiPlan.js'));

/* ------------------------------------------------ the reply parser ------- */

console.log('--- a clean reply parses ---');

const clean = AIPLAN.parsePlan('{"list":"ul.a5b65bc4","card":"li._2e9433c3","description":"div.jd"}');
check('it is accepted', clean.ok, true);
check('and every selector survives', clean.plan,
  { list: 'ul.a5b65bc4', card: 'li._2e9433c3', description: 'div.jd' });

console.log('\n--- the shapes a real model actually returns ---');

const fenced = AIPLAN.parsePlan('Here you go:\n```json\n{"list":"ul.x","card":"li.y"}\n```\nHope that helps.');
check('markdown fences and prose around the JSON', fenced.plan, { list: 'ul.x', card: 'li.y' });

/* MiniMax M2.7 is a reasoning model; its thinking normally arrives in its own
 * field but leaks into the content often enough to be worth handling. */
const thought = AIPLAN.parsePlan(
  '<think>The list is probably ul.x, but {"list":"ul.WRONG"} would be a guess.</think>' +
  '{"list":"ul.RIGHT","card":"li.y"}');
check('a <think> block is stripped, not parsed', thought.plan.list, 'ul.RIGHT');

const cutOff = AIPLAN.parsePlan('{"list":"ul.x"}\n<think>wait, actually');
check('a reply cut off mid-thought keeps what came before it', cutOff.plan, { list: 'ul.x' });

const wrapped = AIPLAN.parsePlan('{"selectors":{"list":"ul.x","card":"li.y"},"notes":"hashed classes"}');
check('a {"selectors": ...} wrapper is unwrapped', wrapped.plan, { list: 'ul.x', card: 'li.y' });
check('and its notes come through', wrapped.notes, 'hashed classes');

const braced = AIPLAN.parsePlan('{"nextPage":"button[aria-label=\\"Next {page}\\"]"}');
check('braces INSIDE a selector do not end the object early',
  braced.plan.nextPage, 'button[aria-label="Next {page}"]');

const arrayed = AIPLAN.parsePlan('{"pills":["span.a","span.b"]}');
check('an array of selectors becomes one CSS selector list', arrayed.plan.pills, 'span.a, span.b');

console.log('\n--- and the ones that must be refused ---');

check('prose with no JSON at all', AIPLAN.parsePlan('I could not work out the layout.').ok, false);
check('truncated JSON', AIPLAN.parsePlan('{"list":"ul.x"').ok, false);
check('a JSON array rather than an object', AIPLAN.parsePlan('["ul.x"]').ok, false);
check('an empty reply', AIPLAN.parsePlan('').ok, false);
check('a null reply', AIPLAN.parsePlan(null).ok, false);
check('an object naming nothing we use', AIPLAN.parsePlan('{"colour":"blue"}').ok, false);
check('nothing but reasoning', AIPLAN.parsePlan('<think>{"list":"ul.x"}</think>').ok, false);

/* Each of these is a field DROPPED from an otherwise fine plan, rather than a
 * whole reply thrown away - the good half is still worth having. */
const partly = AIPLAN.parsePlan(
  '{"list":"ul.x","card":null,"title":"body","company":"","description":"main","pills":"NONE"}');
check('a plan keeps only its usable fields', partly.plan, { list: 'ul.x' });
check('  null is dropped', partly.plan.card, undefined);
check('  "body" is dropped', partly.plan.title, undefined);
check('  an empty string is dropped', partly.plan.company, undefined);
check('  "main" is dropped', partly.plan.description, undefined);
check('  the literal word NONE is dropped', partly.plan.pills, undefined);

check('a selector longer than 300 characters is dropped',
  AIPLAN.cleanSelector('div.' + 'a'.repeat(400)), null);
check('a multi-line value is dropped', AIPLAN.cleanSelector('div.a\ndiv.b'), null);
check('surrounding whitespace is trimmed', AIPLAN.cleanSelector('  div.a  '), 'div.a');

console.log('\n--- the reply is read out of whatever shape OpenRouter sends ---');
check('the ordinary string content',
  AIPLAN.replyText({ choices: [{ message: { content: 'hello' } }] }), 'hello');
check('content split into parts',
  AIPLAN.replyText({ choices: [{ message: { content: [{ text: 'he' }, { text: 'llo' }] } }] }), 'hello');
check('no choices at all', AIPLAN.replyText({}), '');

console.log('\n--- the prompt names every field the collector can use ---');
const prompt = AIPLAN.systemPrompt();
AIPLAN.KEYS.forEach(function (k) {
  check('  the prompt asks for ' + k, prompt.indexOf('"' + k + '"') !== -1, true);
});
check('and it forbids the broad answers', /never answer "body"/i.test(prompt), true);

/* ------------------------------------------------------- the page side --- */

const JD = 'For our client, we are seeking a Director Strategy & Planning to join the team ' +
  'of a leader in the Telecommunications & Hardware space. This role will drive strategic ' +
  'priorities and cross-functional execution on the initiatives that matter most. ' +
  'SECRETPHRASE requirements: ten years of experience, travel up to 25 percent, and a ' +
  'willingness to work from the Boston office two days a week.';

function card(n) {
  return '<li class="_2e9433c3"><a class="_9f0" href="/jobs/search-results/?currentJobId=41010001">' +
    'Director, Strategy &amp; Planning ' + n + '</a>' +
    '<span class="_bb1">Ladders</span><span class="_bb2">United States (Remote)</span>' +
    '<button aria-label="Dismiss">X</button></li>';
}

/* Hashed class names, cards that all carry the SELECTED job's id, and a
 * details pane with an upsell card sitting between the header and the JD -
 * the surface from the README, reduced to what this suite needs. */
function aiSearchPage(extra) {
  return new JSDOM('<!doctype html><html><body>' +
    '<nav id="global-nav"><h2>0 notifications</h2></nav>' +
    '<main class="cc5d114c">' +
    '<div class="_rail"><ul class="a5b65bc4">' + card(1) + card(2) + card(3) + card(4) + '</ul></div>' +
    '<div class="_pane">' +
    '<a class="_co" href="/company/ladders-inc/">Ladders</a>' +
    '<h2 class="_ttl">Director, Strategy &amp; Planning</h2>' +
    '<span class="_pill">$200.6K/yr - $258.4K/yr</span><span class="_pill">Remote</span>' +
    '<a class="_apply" href="https://employer.example/apply">Apply</a>' +
    '<div class="_upsell">Job search faster with Premium</div>' +
    '<div class="_lbl">About the job</div>' +
    '<div class="_jd">' + JD + '</div>' +
    '<span class="_more">… more</span>' +
    '</div></main>' + (extra || '') + '</body></html>', {
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=director'
  });
}

/* Same shape as the loader in aisearch.test.js: the content scripts are
 * written for a page, so they are evaluated with the page's globals in
 * scope. */
function boot(dom) {
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;

  const files = [
    path.join(SRC, 'selectors.js'),
    path.join(ROOT, 'src', 'lib', 'aiPlan.js'),
    path.join(SRC, 'aiassist.js'),
    path.join(SRC, 'parse.js'),
    path.join(SRC, 'extract.js')
  ];
  files.forEach(function (f) {
    dom.window.eval(fs.readFileSync(f, 'utf8'));
  });
  return dom.window;
}

console.log('\n--- the outline describes the page without carrying it ---');

let win = boot(aiSearchPage());
const digest = win.JDC_AI.buildDigest({ reason: 'test' });

check('the hashed class names a selector needs are in it',
  /a5b65bc4/.test(digest) && /_2e9433c3/.test(digest), true);
check('so is the job link, with its id',
  /currentJobId=41010001/.test(digest), true);
check('so is a visible label', /About the job/.test(digest), true);

/* The whole point of truncating: a model resolving a layout has no business
 * reading the postings, and this is what keeps the two apart. */
check('the job description is NOT carried into it',
  /SECRETPHRASE/.test(digest), false);

check('repeated cards are collapsed rather than repeated four times',
  /×3 more siblings of the same shape/.test(digest), true);
check('the outline says what the hand-written selectors resolve',
  /NO MATCH/.test(digest), true);
check('and it stays well under the size cap', digest.length < 16000, true);

console.log('\n--- a plan is checked against the page before it is used ---');

check('a card selector matching every card is accepted',
  win.JDC_AI.validateOne('card', 'li._2e9433c3').ok, true);
check('one matching a single card is refused - that is the collapse, not a list',
  win.JDC_AI.validateOne('card', 'ul.a5b65bc4 > li:first-child').ok, false);
check('a description with real text in it is accepted',
  win.JDC_AI.validateOne('description', 'div._jd').ok, true);
check('a "description" holding one line is refused',
  win.JDC_AI.validateOne('description', 'div._upsell').why,
  'first match holds 30 characters, needs 200');
check('a "title" holding a whole pane is refused',
  win.JDC_AI.validateOne('title', 'div._pane').ok, false);
check('body is refused however it is spelled',
  win.JDC_AI.validateOne('description', 'body').ok, false);
check('a selector that is not valid CSS is refused, not thrown',
  win.JDC_AI.validateOne('title', 'h2[').why, 'not valid CSS');
check('a selector matching nothing is refused',
  win.JDC_AI.validateOne('title', 'h7.nope').ok, false);
check('a field the collector does not use is refused',
  win.JDC_AI.validateOne('salaryEstimate', 'div._pill').ok, false);
check('a description overlapping the results list is refused',
  win.JDC_AI.validateOne('description', 'main.cc5d114c').ok, false);

/* The three fields the collector CLICKS are checked on what they say too. A
 * plausible selector for "next page" that actually addresses a Premium upsell
 * would have the collector clicking an ad on the user's own logged-in
 * session, which is worse than collecting nothing. */
check('a "next page" control that says nothing about next pages is refused',
  win.JDC_AI.validateOne('nextPage', 'div._upsell').ok, false);
check('and the reason quotes what it actually says',
  /Job search faster/.test(win.JDC_AI.validateOne('nextPage', 'div._upsell').why), true);
check('an "apply button" that is really the company link is refused',
  win.JDC_AI.validateOne('applyButton', 'a._co').ok, false);
check('the real apply control passes',
  win.JDC_AI.validateOne('applyButton', 'a._apply').ok, true);
check('and the real "… more" passes',
  win.JDC_AI.validateOne('showMore', 'span._more').ok, true);

console.log('\n--- accepted selectors reach the extractor ---');

const applied = win.JDC_AI.applyPlan({
  list: 'ul.a5b65bc4',
  card: 'li._2e9433c3',
  cardLink: 'li._2e9433c3 a._9f0',
  title: 'h2._ttl',
  company: 'a._co',
  description: 'div._jd',
  showMore: 'span._more',
  pills: 'span._pill',
  applyButton: 'a._apply',
  nextPage: 'div._upsell'          // not a next-page control; must be refused
});

check('the good ones are accepted', applied.accepted.map(function (a) { return a.key; }),
  ['list', 'card', 'title', 'company', 'description', 'showMore', 'pills', 'applyButton']);
check('the upsell offered as a next-page control is not',
  applied.rejected.map(function (r) { return r.key; }), ['nextPage']);

/* cardLink is not rejected - it is not needed. One of the hand-written card
 * link selectors (a[href*="currentJobId="]) still matches this surface, and a
 * field that already resolves is never handed over to a plan. */
check('the field that already resolves is skipped, not overridden',
  applied.skipped.map(function (s) { return s.key; }), ['cardLink']);
check('and the summary is one line fit for the log',
  /using list, card/.test(applied.summary) &&
  /dropped 1/.test(applied.summary) &&
  /1 already handled/.test(applied.summary), true);

check('the selector layer is now using them',
  Object.keys(win.JDC_SEL.learned()).length, 8);
check('the list resolves', !!win.JDC_SEL.q(win.JDC_SEL.SEL.list), true);
check('four cards resolve', win.JDC_SEL.qa(win.JDC_SEL.SEL.card).length, 4);

const job = win.JDC_EX.extractJob('41010001', {});
check('the title comes out of the pane, not the nav bell', job.title, 'Director, Strategy & Planning');
check('the company comes through', job.company, 'Ladders');
check('the description is the JD and not the upsell',
  /SECRETPHRASE/.test(job.description) && !/Premium/.test(job.description), true);
check('the pay pill was read', job.payMinAnnual, 200600);
check('the workplace type was read', job.workplaceType, 'Remote');
check('and the apply route is the employer, not Easy Apply',
  [job.applyType, job.applyUrl], ['external', 'https://employer.example/apply']);

console.log('\n--- a plan can fill a gap, never take over ---');

/* Same page, plus a details pane the hand-written selectors DO match. */
win = boot(aiSearchPage('<div id="job-details">' + JD + '</div>'));
const guarded = win.JDC_AI.applyPlan({ description: 'div._jd', title: 'h2._ttl' });
check('the field with a working hand-written selector is skipped',
  guarded.skipped.map(function (s) { return s.key; }), ['description']);
check('and the reason names the selector that already works',
  /#job-details/.test(guarded.skipped[0].why), true);
check('the field with no working selector is still learned',
  guarded.accepted.map(function (a) { return a.key; }), ['title']);
check('the description still resolves the hand-written way',
  win.JDC_SEL.q(win.JDC_SEL.SEL.description).id, 'job-details');

console.log('\n--- learning twice replaces rather than stacks ---');

win = boot(aiSearchPage());
win.JDC_SEL.learn('title', 'h2._ttl');
win.JDC_SEL.learn('title', 'a._co');
check('only the newest is in front', win.JDC_SEL.SEL.title[0], 'a._co');
check('the old one is gone, not buried', win.JDC_SEL.SEL.title.indexOf('h2._ttl'), -1);
check('and learned() reports the current one', win.JDC_SEL.learned('title'), 'a._co');

win.JDC_SEL.forgetLearned();
check('forgetting removes it from the candidate list',
  win.JDC_SEL.SEL.title.indexOf('a._co'), -1);
check('and empties the record', win.JDC_SEL.learned(), {});
check('an unknown key is refused', win.JDC_SEL.learn('nonsense', 'div').ok, false);
check('an empty selector is refused', win.JDC_SEL.learn('title', '  ').ok, false);

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
