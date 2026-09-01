# JD Collector

A Chrome extension that bulk-collects job descriptions from **LinkedIn** and
**hiring.cafe**, filters them on facts stated in the posting, and exports
Claude-ready batches.

It does not score, rank or judge jobs. There is no client profile and no
built-in vetting. Every filter keys on something read out of the posting — pay,
workplace type, clearance, sponsorship, travel, years required, reposted,
applicant count, text matches — so the extension can narrow a list, but it never
reorders one by opinion and never drops a job for a reason the posting does not
state. The reading is yours to do from the exported batches.

The one thing it will remember is a call **you** already made: if you vet
batches in a chat, it can read those accept/reject lines back in so the same
rejects do not resurface every run. That is memory, not judgement — see
[Remembering a vetting pass](#remembering-a-vetting-pass).

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the toolbar icon to open the side panel

Do **not** publish this to the Chrome Web Store. LinkedIn probes for thousands of
known extension IDs on every page load (see [Detection](#detection)); an
unpublished extension has no ID on that list.

## Use it

The side panel is the whole workflow: build a search, collect, filter, export.
Settings and diagnostics live in a separate window — **Settings & diagnostics**
in the Search card.

### 1 · Build the search

Fill in keywords and location, plus workplace type and date posted. The gear in
the top bar reveals experience level, job type, sort order and the
fewer-than-10-applicants filter.

Use LinkedIn's own filters for anything it supports natively — that is far faster
than collecting everything and filtering afterwards.

Your search is remembered between sessions.

### 2 · Collect

**Open search in this tab** navigates to the LinkedIn search you just built.
Then press **Collect**. The extension clicks each card in the results list, waits
for the details pane, and captures the full description plus metadata. Watch
progress in the status bar; **Stop** halts it at any point. Collected jobs
survive stopping, closing the panel, and the reloads LinkedIn forces on
pagination.

**Collect from hiring.cafe** runs the same criteria against
[hiringcafe.com](https://hiringcafe.com) instead — no LinkedIn tab, no login, no
session to get restricted. See [hiring.cafe](#hiringcafe) below.

### 3 · Filter

Filters run on the already-collected set, so you can re-filter freely without
re-collecting. They live behind the gear. In order of usefulness:

- **Application route** — direct-apply vs Easy Apply. Direct-apply postings go to
  the employer's own system, which is usually where a real application lands.
- **Hide reposted / promoted** — reposted roles are often stale; promoted ones are
  paid placements.
- **Min pay** — clears on the **top** of a stated range, so a $110–140k posting
  survives a $130k floor rather than being dropped on its bottom figure.
- **Hide "no sponsorship" / clearance required / relocation required** — each keys
  on an explicit statement in the description.
- **Hide fake remote** — tagged Remote by LinkedIn but the description demands
  office days or says it is not remote.
- **Title / JD text matching** — contains-all, contains-any, and excludes.

Three rules hold throughout.

**An unknown is never a rejection.** A posting with no stated pay survives a pay
filter, one with no stated age survives a posted-within filter, and one whose
workplace type or application route was never stated survives those two —
because absence of a signal is not evidence against the job. On the AI job
search that last one is the difference between a list and an empty box: those
fields come back Unknown often there, and dropping them hid every job
collected. Unlabelled jobs still show their **Unknown** tag in the row, and
ticking **Unknown** on its own still selects only them.

**A hidden filter is announced.** When a filter behind the gear is narrowing the
list, Results says so by name rather than leaving you wondering where the jobs
went.

**An empty list names what emptied it.** If every collected job is filtered out,
Results says which filters did it and how many each one removes — *"All 12
collected jobs are filtered out — title contains (12), min JD length (9). Open
the gear to change them."* Each filter is measured on its own against the whole
set, so the counts overlap; the question being answered is "which one do I turn
off", not how the losses divide up.

### 4 · Export

Select jobs, then copy or download. Each posting is exported as a block with its
parsed facts above the description:

```
--- JOB 1 | ID 4266112233 ---
Title: Clinical Research Associate II
Company: Acme CRO
Location: Boston, MA (Remote)
Posted: 3 days ago
Applicants: 12
Apply route: Direct apply
Source: LinkedIn
URL: https://www.linkedin.com/jobs/view/4266112233/
PARSED FACTS: Pay: $120,000/yr (annualized 120,000-140,000) [source: LinkedIn
pay field] | Years required: 4+ | Travel: up to 25% | Direct apply URL: ...

JOB DESCRIPTION:
...
```

Facts only. The extension states no conclusion about any job, so nothing in the
export tells the model what to think before it reads the posting.

A batch holds **at most 15 postings**, and no more than the character budget set
in **Settings → Prompt & export** — whichever limit bites first. With short
postings the 15-job cap is effectively always the binding one, since the
character budget has a floor of 5,000. A single posting longer than the whole
budget still gets its own batch rather than being dropped.

The prompt that leads every batch is editable in the same place, along with an
optional per-description trim.

**Find real apply links** opens each selected direct-apply posting's Apply button
once, captures the employer's real application URL, and closes the tab. Takes a
few seconds per job, so run it on a shortlist. Jobs from hiring.cafe already
carry one.

**Cross-day dedupe:** **Mark selected as exported** records the ids, and
**Skip jobs already exported** in Settings then skips them on later runs.

## Remembering a vetting pass

If you paste batches into a chat that calls each job for you, the extension can
read those calls back in so you do not re-read the same rejects every week.
**Settings → Vetting feedback → Scan the open chat tab** does it.

This does not make the extension start judging jobs. The call was yours, made
in your own chat; this only gives it a memory, the same way the export history
gives "already exported" one. Nothing is scored, nothing is ranked, and there
is still no client profile anywhere in here.

Two things keep a remembered call from doing damage:

- **Only a shape it trusts is imported.** **Settings → Prompt & export → Vetting
  reply format** asks the chat to end its reply with one machine-readable line
  per job (`VERDICT <ID> REJECT: <reason>`). Anything ambiguous is *listed for
  you to read* rather than guessed at, because a wrong reject would silently
  delete a good job from every future run — the same failure class the
  hiring.cafe adapter's null-vs-false rule exists to avoid.
- **It is inert until you switch it on.** A stored call shows as a tag on the
  job and nothing more. **Hide previously turned down** in the filters, and
  **Skip jobs a previous vetting pass turned down** in Settings → Collection,
  are both off by default; the collector announces each skip by id in the log
  rather than quietly shrinking the run.

Individual calls can be forgotten one at a time, or cleared wholesale, from the
same pane. The reader is read-only: it does not type into the chat, click
anything, or touch the page.

## hiring.cafe

hiring.cafe aggregates postings across dozens of applicant tracking systems.
Collecting from it needs no LinkedIn tab, no login and no account that can be
restricted, and the rows arrive with an employer apply URL already attached.

**Set a location.** This is the one setting that quietly ruins a run: with no
location in the request their backend geolocates the caller. The same query
returned **29 results (Singapore, Sweden)** with no location and **1,632** with a
US one. The panel asks for confirmation before running without one.

### What was verified, and why the public write-ups are wrong

Every third-party scraper and blog post documents `POST /api/search-jobs` with a
`{size, page, searchState}` body. That endpoint **returns 405**. What actually
works, confirmed against the live site on 2026-08-24:

- **The domain moved.** `hiring.cafe` 308-redirects to `hiringcafe.com`. Both are
  in `host_permissions`.
- **Search is server-rendered.** `GET /?searchState=<urlencoded JSON>` returns
  HTML whose `__NEXT_DATA__` carries the results at `props.pageProps.ssrHits`,
  with `ssrPage` / `ssrTotalCount` / `ssrIsLastPage`. Paging is `&page=N`,
  zero-based.
- The adapter reads the **page HTML**, not `/_next/data/{buildId}/index.json`.
  The buildId changes on every deploy; depending on it would break this silently
  every time they ship.
- **`ssrPageSize` lies.** It claims 40; 83–100 rows come back. The array length is
  the only number to trust.
- **The search result has no job description** — only a ~200 character summary.
  The full text needs a second call per posting,
  `GET /api/job-description?id=<id>`. That is the real cost of this source, and
  why descriptions are fetched four at a time with a pause between batches. A
  failed description leaves the summary in place rather than failing the run.

Two things are deliberately **not** inferred, because the panel's flag filters
drop a job outright on them and a false positive there does not merely
mislead — it deletes a valid job:

- **`visa_sponsorship: false`** cannot be told apart from "the posting never
  mentioned it", so it maps to `null`. Only `true` is trusted; `parse.js` still
  reads sponsorship off the prose.
- **`workplace_type: "Field"`** is neither on-site nor remote — for a CRA it
  usually means site visits, often home-based between them. Forcing it into
  On-site would drop it from a remote-only filter, so it stays `Unknown`. The raw
  value is kept on the job.

### The honest risk position

This is an **internal, undocumented** endpoint. Not a published API, and not the
same safety class as the Greenhouse or Lever endpoints companies actively want
crawled — it can change without notice, and hiring.cafe's own terms may prohibit
it. What it does **not** carry is the LinkedIn exposure: no login, no
authenticated session, no account that can be restricted. Lower stakes, not zero.
Pacing is deliberate for the same reason.

## LinkedIn's AI job search

`/jobs/search-results/` gets its **own adapter** — `src/content/aisearch.js` —
not another layer of fallbacks on the classic collector. The two surfaces
disagree about what a card is, where a job id lives and whether the list is
even fully mounted, and every attempt to serve both from one code path
produced rows that looked collected and were not. The classic collector is
untouched by it: the adapter claims a page only when the route **and** the DOM
both agree, and hands back otherwise.

These are read off the live page. Nothing here is a guess at markup nobody has
looked at, and they are the only literal selectors the adapter uses:

| | |
|---|---|
| route | `/jobs/search-results/` |
| list container | `[data-testid="lazy-column"][componentkey="SearchResultsMainContent"]` |
| card | `[role="button"][componentkey^="job-card-component-ref-"]` |
| job id | the digits in `componentkey` — `job-card-component-ref-4401002774` |
| selected job | the **only** `a[href*="/jobs/view/"]` on the page |
| description | the container of the `h2` reading "About the job" |

Everything else — the header region, the pills, the meta line — is found by
shape, because this surface's class names are build hashes (`div.cc5d114c`,
`ul.a5b65bc4`, `a._2e9433c3`) that rotate on every deploy.

Three properties of that DOM drive the whole design:

- **A card carries its own id but no link to its job.** Only the selected card
  exposes `/jobs/view/{id}`. The classic collector reads ids off links, so it
  saw one id — the selected job's — repeated across every card: *"26 cards but
  only 1 distinct job id"*. It then fell back to walking by position and
  resolving the id from the URL **after** the click, which is why a
  mis-selection was indistinguishable from a slow pane. The adapter enumerates
  ids from `componentkey` **before** clicking anything.
- **The selection is confirmed, not assumed.** After each click it waits until
  the URL's `currentJobId` or that single `/jobs/view/{id}` link names the card
  it clicked, then waits again for the description to render, with one retry
  and a scroll nudge in between. Nothing is extracted until both hold.
- **The list is virtualised.** Cards unmount when they scroll out of view, so
  no element reference survives a click: every card is re-found by its
  `componentkey` at the moment it is needed. The run collects as it scrolls
  the lazy column's own scroll container — not the document, which does not
  move — deduping on a `Set` of ids.
- **A scroll that mounts nothing is not the end of the list.** A run stopped at
  25 of “99+ results” because three such scrolls in a row were read as the
  bottom while 1,300 pixels of list sat below. Barren scrolls only count once
  there is nowhere left to scroll; at the true bottom the adapter looks for a
  “Show more results” control and clicks it before concluding anything.

Both adapters build their rows through the same `EX.buildJob`, so pay,
flags, annualisation and the shape of a row cannot drift between surfaces.

### Eight stages, and a job that can say which one failed

Every job goes through the same pipeline, whether it is one traced job or the
four hundredth of a run: **card discovered → clicked → selection synchronised →
extracted → validated → payload built → saved → status.** Each stage logs one
line to the page console under a `[JD]` prefix, carrying field *lengths* and
field *names* — never 4,800 characters of someone's posting:

```
[JD] EXTRACTED     { jobId: "4401002774", headingFound: true,
                     descriptionVia: "heading ancestor +2",
                     titleLength: 28, companyLength: 8,
                     locationLength: 68, descriptionLength: 3182 }
[JD] SAVE_RESPONSE { jobId: "4401002774", status: "ok",
                     body: { ok: true, received: 1, buffered: 1, collected: 6 } }
```

The description has four ways in, tried in order: the exact `h2` “About the
job”, a heading from the same family, a job-description heading, and — when
there is no heading at all — the largest block of prose in the pane that holds
no job links. Fourteen jobs in one run failed with an empty description while
the posting was plainly on screen, which is what an exact-match landmark costs
when it is the only way in. The log names which route found it.

Nothing is extracted until three conditions hold — the selected link exists, it
names **this** job, and the description clears 100 characters — and a job that
fails one is logged with the fields that were missing, by name. A stage that
throws reports its own error and stack. **No job is ever marked "Failed" with
no reason attached**: that state cost a week of debugging on this surface, and
it is now unreachable.

**Settings → Diagnostics → Trace one AI-search job** runs that pipeline against
a single job and prints every stage. Prove a surface on one job before turning
a run loose on four hundred.

### The structural fallbacks, for everything else

They still carry any surface no adapter claims — an unrecognised redesign, or
this one if LinkedIn renames `componentkey` tomorrow:

- **Cards by shape.** Its job links mostly carry the *selected* job's
  `currentJobId` rather than one id each, so the anchor route collapses — six job
  links deduped to one card in a real diagnostic while a seven-member list sat
  right there. Fewer than three cards from six-plus anchors is treated as a
  collapsed inference, and shape discovery takes over.
- **Walking by position, not by id.** For the same reason, the ids on this
  surface are not *per-card*: eight cards yield eight copies of the one selected
  job's id. The page loop dedupes on those, so it used to collect a single job,
  silently skip the other seven and move on — which reads from the outside as
  "it skipped page 1". The route is now chosen on how many **distinct** ids a
  page produced rather than how many ids; below that bar each id is resolved
  from the URL after the click instead. A three-card floor keeps a genuinely
  short page off the slower path.
- **The description by heading — or a plain div standing in for one.** Class
  names change; visible copy does not. The details pane puts the description
  under an **"About the job"** label, anchoring on which is both more durable
  and more precise than the densest-block fallback — that pane is full of
  interstitial cards (a profile-match panel, two Premium upsells) which a
  density measure will happily swallow into the middle of a job description. As
  of a diagnostic run on 2026-08-26 that label is sometimes a plain, unstyled
  `<div>` for sighted users with a **separate, content-less heading of the same
  text** sitting next to it for screen readers only — heading-only anchoring
  locked onto the empty one, found nothing next to it, and gave up onto the
  density fallback anyway. The anchor now also tries a matching div/span's own
  text, and only ever accepts a candidate that actually has content next to it.
- **The inline "… more".** This surface clips the description with an inline
  expander rather than the classic footer button. Missing it captures a
  description cut off mid-sentence, losing exactly the requirements half that
  matters most.
- **Pills read individually, never as one block.** Workplace type, employment
  type, seniority and pay come off short pill elements next to the title.
  Adjacent pills here sit with no separating whitespace in the source —
  `<span>$258K/yr</span><span>Remote</span>` — which glues into one run,
  `...yrRemoteFull-time...`, when captured as a block of text. That silently
  defeated the workplace-type fallback's word-boundary regex: a job that
  plainly said Remote in the pane still came back **Unknown**, and turning on
  every workplace filter just surfaced a list where every job was Unknown. Each
  pill candidate is now read on its own rather than as part of a larger blob.
- **The title, scoped to the pane it actually sits in.** There is no `<h1>`
  anywhere on this surface, and the global nav renders a real, non-decorative
  `<h2>0 notifications</h2>` for the bell icon — the first heading in document
  order. A document-wide "first short heading" search locked onto that instead
  of the job's own title: every collected job got **"0 notifications"** as its
  title, verified live. The fallback now widens outward one ancestor at a time
  from the description element rather than ever searching the whole document,
  and returns nothing sooner than guessing from page chrome that happens to
  sort first.
- **The company, from a `/company/` link near the title.** `S.company` only
  ever listed classic-layout class names, with no fallback at all — on this
  surface all of them miss, so company was always `''` and the panel rendered
  the literal `?` on every row, verified live. A link to a LinkedIn company
  page is exactly how a company name is marked up on every layout and far more
  durable than a class name, so that is what the fallback looks for now,
  scoped the same ancestor-widening way as the title.

- **Every field read from the pane, because `document` is not a fallback.**
  No selector names the details pane here, and the extractor used to widen to
  the whole document when that happened. That is not a smaller mistake than
  having no fallback — it is a worse one, because it always finds *something*.
  A real run produced eight rows in which the title was the rail's **"Get job
  alerts for this search"** banner or the description's own **"About the job"**
  label, the company was another card's employer or `Acme 28,506 followers`
  off the About-the-company section, the employment type came from LinkedIn's
  own **Temporary** and **Internship** filter chips, and the pay was
  `$260K/yr - $390K/yr` on *every single job* because one rail card's pill won
  a document-wide scan. Every row looked collected. Not one was true. The pane
  is now inferred structurally — the outermost ancestor of the description that
  still excludes the rail — and the title, company, pills, meta line and apply
  control are all read from inside it, with the description subtree excluded
  from the pill scan.
- **The rail can never be the description.** It is the densest block on the
  page, so when the density heuristic picked it, jobs came back carrying the
  *rail's* text — and its pay pill, and a feedback heading as their title.
  Both description routes now clear the same check: real length, no overlap
  with the results list, and **no more than one job link inside**. That last
  one is deliberately independent of everything else: the list-root checks are
  only as good as the inference behind them, and when that returns null every
  guard resting on it stops guarding. A block holding twenty job links is a
  list whatever else is known about the page. (The old test only looked for
  `/jobs/view/` hrefs — this surface links its cards with `?currentJobId=`, so
  it saw no job links in the rail at all.)
- **A title is never a question.** Six jobs in one run were collected as
  *"Are these results helpful?"* — the feedback prompt above the results. That
  and its relatives are refused by name, along with anything ending in a
  question mark.
- **The description is rendered lazily.** The header, the Apply button and the
  upsell cards paint immediately; the posting itself is a blank gap until that
  part of the pane is scrolled towards. Reading the pane the moment the header
  appears finds no description and falls through to whatever else is dense —
  which is the rail. When nothing is found, the pane is now scrolled the way a
  reader would scroll it, and given another few seconds.
- **The meta line by shape.** `primaryDesc` and `tertiaryDesc` miss here, so
  location, posted age and applicant count were simply absent — which silently
  disables the posted-within and applicant filters rather than announcing
  anything. The header's middot-separated line is now found by shape.
- **And when every heuristic still picks the wrong block, it watches.** A run
  that got the click right — the URL moved from `4459259331` to `4459238201`,
  so LinkedIn had genuinely switched jobs — still read text that did not
  change, because the label anchor had settled on a panel that stays put. No
  reasoning about markup finds that; measurement does. A job description is,
  by definition, **the block that changes when the job changes**, so the
  collector hashes every candidate block before the click and, if what it is
  reading did not move while the job did, finds the one that did: the smallest
  element containing every changed leaf. That element's path is then learned
  for the rest of the run, through the same slot the AI assist writes into,
  and the switch is announced in the log — including a warning that jobs
  collected before it may carry the wrong description.

The pane is confirmed by the pane, not by the URL. This surface rewrites
`currentJobId` the instant you click, ahead of the pane re-rendering, so "the
URL agrees" was true while the previous job's posting was still on screen —
that is how five jobs came to share one description, each one confirmed by a
URL that had moved on. A pane that **changed** is proof on its own; an
unchanged pane is accepted only when the card's own title says it was already
showing this job, with the URL holding a veto rather than a vote. Behind that
sits a rule that depends on no heuristic at all: **two job ids cannot have the
same description.** When one repeats, the job is skipped and named in the log
rather than stored.

Pagination is the remaining rough edge: none of the next-page selectors match,
because the surface returns one ranked set rather than numbered pages. A run
stops on its own after **two pages that add no new jobs**, which is what keeps it
from reloading the same list until the page limit runs out.

## Unfamiliar pages: the fallback and the diagnostic

When no selector matches, the collector falls back to **structure instead of
class names**. Job links are the one thing that cannot change, so it finds every
`/jobs/view/{id}` and `?currentJobId=` link, infers the list container as the
tightest element holding most of them, and infers the description as the densest
text block outside that list.

`tests/generic.test.js` proves this on a page sharing **no** class names with any
LinkedIn layout. The fallback never invents anything — on a page with no jobs it
returns nothing rather than guessing.

If a page still collects nothing, open **Settings → Diagnostics → Diagnose the
job page**. It prints which selectors matched, how many job links exist, the
inferred list root, whether shape discovery would accept each repeated group, the
description candidate and its length, the first card's DOM outline, and every
apply-looking button. **Structure only** — tags, classes and counts, never job
text or personal data. That output is what a precise adapter gets written from.

A run that collects zero jobs dumps that diagnostic into the activity log
automatically, so the reason is on screen rather than requiring you to know a
separate tool exists.

**Which build is actually running.** Reloading the extension at
`chrome://extensions` does **not** replace a content script already running in
an open LinkedIn tab — that tab keeps yesterday's code until you reload the
tab itself. Every run now logs the collector build twice, once from the tab and
once from the worker:

```
Content script in the tab: build 2026-09-01.4.
Collector build 2026-09-01.4 running on /jobs/search-results/.
```

If those say something older than the code you are reading, reload the tab.
That one line is the difference between "the fix does not work" and "the fix is
not in the tab yet", and it used to cost an afternoon to establish.

**Test hiring.cafe** on the same pane runs that chain one step at a time and
prints each status code, byte count and parsed field.

## AI assist

Off by default. **Settings → AI assist.**

When a page defeats both the hand-written selectors and the structural
fallbacks, the extension can describe that page to a model and ask it **where
things are** — the list, a card, the title, the description — then use the CSS
selectors it gets back. This is the case LinkedIn's AI job search was always
going to be: its class names are build hashes that rotate on every deploy, so
there is nothing durable to write down, and each redesign costs another
diagnostic-and-patch cycle by hand.

It is asked where, never what. The model never sees a job description, never
states a fact about a posting, and nothing it says reaches the export. Every
field still comes out of the DOM through `extract.js` and the same parsers as
always — a plan only changes **which element** those parsers read.

That is not a slogan, it is why this is safe to add to a tool whose whole
premise is facts over verdicts: a wrong selector produces an empty capture the
collector already reports and recovers from, whereas a model asked to read pay
or years-of-experience out of prose produces a confident number nobody can
trace back to a sentence in the posting.

**Nothing it returns is taken on trust.** Every selector is run against the live
page before it is used and dropped unless the elements it matches have the
shape of the thing they claim to be:

- a `card` matching fewer than three elements is refused — that is the same
  collapse the anchor route already fails on, not a list;
- a `description` whose first match holds under 200 characters, or which
  overlaps the results list, is refused;
- a `title` holding a whole pane, an invalid selector, and `body` / `main` /
  `*` in any field are all refused;
- the three fields the collector **clicks** — apply, "… more", next page — are
  checked on what they say as well, so a Premium upsell offered as the
  next-page control is refused on its own text before anything clicks it.
  Reading the wrong element costs a bad row; clicking the wrong one, on your
  own logged-in session, is a different class of mistake;
- and a field whose **hand-written** selector still matches is never
  overridden — a plan can fill a gap, never take over a layout that works.

Accepted selectors go to the front of the same candidate lists everything else
already reads, so a resolved page is reported in the diagnostic under
**AI-RESOLVED SELECTORS IN USE** rather than being indistinguishable from a
layout that was supported all along.

### More than one model

Free endpoints are rate limited hard — a few calls a minute — so one model is
one bad minute away from a run with no assist at all. **Settings → AI assist**
takes a **list**, one per line, tried in order:

```
minimax/minimax-m2.7:free
nvidia/nemotron-3-ultra-550b-a55b:free
z-ai/glm-5.2:free
```

The first *usable* answer wins. A model that is rate limited, down, or that
replies with prose instead of JSON hands over to the next one and the log says
so by name. A rejected **key**, though, stops the walk immediately — it is bad
for every model on the account, and three requests to be told the same thing
help nobody. **Test the connection** reports one line per model, so the answer
is which of them work rather than whether the first one does.

More models buys reliability, not cleverness: the job is naming CSS selectors
from an outline, and a second opinion on that is worth far less than a second
*attempt* when the first endpoint is busy.

### The field check — a model reading each job

Also off by default, and switched on separately from the selector assist,
because it is a different bargain.

When a job comes off the page with gaps &mdash; no pay, workplace type Unknown,
apply route unknown &mdash; a model is shown that job's own pane and asked which
part of it holds each missing field. **MiniMax M3** by default, for its million-
token context.

The rule it runs under is the whole licence for the feature:

> **The model may only repeat what is on the page.**

Every value it returns is checked back against the exact text it was shown. A
company name that does not appear there is dropped. A salary that does not
appear is dropped. `Remote` is accepted only if the word is there to be read,
and `easy_apply` only if the page says “Easy Apply”. What survives is
transcription &mdash; the model saying *which part of the page* is the company
name, never what the company is.

That distinction is not decoration. This extension’s premise is that every
fact it reports can be traced to a sentence in the posting. A model that
invents a plausible salary breaks that permanently and silently, because
nothing downstream can tell an invented $140,000 from a real one. A model that
can only point at text cannot. `tests/aifields.test.js` is mostly answers that
have to be **refused** for exactly this reason — an embellished company name, a
paraphrased location, a workplace type the page contradicts.

Three further limits:

- **It fills gaps.** A field the page already read is never overwritten.
- **It never judges.** No score, no rank, no fit. Those do not become
  available because a model is in the loop, and they are not going to.
- **It is labelled.** Every field it filled shows as an `AI: pay, workplace`
  tag on the row, and the export reads `[source: read off the page by
  minimax/minimax-m3:free]` instead of naming the posting. A fact sourced from
  a model is never presented as one the posting stated.

**What it costs.** This is the only feature that sends posting text out of the
browser &mdash; up to 4,000 characters of the pane per job, capped in Settings.
The selector assist never sends that. It is also one call per job, which on a
free endpoint is a few jobs a minute, so it is capped per run and stops asking
for the rest of the run the moment it is rate limited rather than adding a
failed call to every remaining job.

### Setting it up

1. An OpenRouter key, from openrouter.ai → Keys.
2. **Settings → AI assist**: paste the key, tick the checkbox. The model list
   is prefilled with the three above, all verified free on 2026-09-01.
3. **Test the connection** proves the key and model work at all.
4. Open the job page, then **Resolve the open job page**. It describes the
   page, asks the model, checks every selector against that same page, and
   prints each step — including the ones it threw away and why. Same spirit as
   the hiring.cafe probe: a failure names the step that broke.

### What is sent, and how often

A structural outline: tags, ids, class names, a handful of attributes, and
visible label text truncated to 60 characters, with hidden elements dropped and
repeated cards collapsed to one plus a count. Roughly 8–16 KB. **Job
descriptions are not in it** — `tests/aiplan.test.js` pins that with a phrase
buried in the posting that must not appear in the outline.

That label text is real, though: the job title and company on the first card of
the rail, and the title in the details pane, are exactly the strings a model
needs to tell a job card from a "people also viewed" rail, so they go with it.
Public postings from a public search, truncated — but not nothing, and worth
knowing before switching this on.

Nothing is sent unless a page has already defeated the built-in selectors, and
a run is capped at **two calls** (Settings) — a page that needs a third opinion
needs a diagnostic instead. A resolved page is remembered per URL path, so
later runs on that surface cost nothing at all; when a remembered plan stops
matching after a deploy, the page-side check drops it and the next call
re-resolves it.

The call is made by the service worker, not the content script: a cross-origin
fetch from a content script is the *page's* request, and the key has no
business existing anywhere LinkedIn's own scripts run.

## Detection

<a name="detection"></a>
As of April 2026 LinkedIn ships a ~2.7 MB script that probes for **6,167 Chrome
Web Store extension IDs** on page load, two ways: `fetch()` against
`chrome-extension://{id}/{file}` for anything declared in
`web_accessible_resources`, and a passive DOM walk looking for
`chrome-extension://` strings in text nodes and attributes.

This extension is invisible to both, and that is worth keeping:

| Vector | Status |
|---|---|
| `web_accessible_resources` | **not declared** — the active probe cannot see it |
| `chrome-extension://` in the page | **none** in `src/content/` |
| DOM injection into LinkedIn | **none** — it reads the page, never decorates it |
| network calls from the page | **none** — the AI assist call is made by the service worker |
| ID on LinkedIn's list | **no** — unpacked, unpublished |

What remains detectable is behaviour: request rate, dwell time, click cadence.
The default pacing (1.2s per job plus jitter, a long pause every 25) is the right
shape for that. Reported safe volume for extension-driven LinkedIn work is
roughly 50–100 pages a day.

On the law: `hiQ v. LinkedIn` (9th Cir.) held that scraping **public** data is not
"without authorization" under the CFAA. But that case ended in a **consent
judgment and permanent injunction** against hiQ after LinkedIn won summary
judgment on **breach of contract**. This is a contract exposure, not a
computer-crime one — and collection here runs from an authenticated session,
which is the side of the line hiQ's public-data protection does not reach. The
practical risk is losing the account.

## Pacing and terms of use

LinkedIn's User Agreement prohibits automated collection. Everything here runs in
your own logged-in browser at a human pace, and the defaults are deliberately
gentle. Turn them down further if you are collecting a lot: **Settings →
Collection**.

An empty numeric field means "use the default", not zero — `Number('')` is `0`,
and a 0 ms per-job delay means hammering LinkedIn with no pause at all. The
per-job delay is floored at the 200 ms its own input declares.

## Tests

```
npm install
npm test
```

1,156 checks. The two boot suites run **first**, so a load-time failure is the
first thing you see — two of those shipped during development and neither was
catchable by anything else.

- `tests/assets.test.js` — every path the browser is asked to load, resolved the
  way the **browser** resolves it (not Node): manifest entries, `importScripts`
  against the importing script's own directory, `executeScript` files from the
  extension root, and every `<script src>` / `<link href>` against its own page.
  It also scans shipped source for stray control characters.
- `tests/worker.test.js` — boots `background.js` in a worker-shaped `vm` context
  and asserts it registers, plus a full hiring.cafe collect against a stubbed
  server. The load-bearing case there: three hits with the **middle one expired**,
  proving each job gets its own description rather than the one after it.
- `tests/aisearch-adapter.test.js` — the AI-search adapter against the DOM read
  off the live page: ids from `componentkey` (five cards, five distinct ids,
  where the classic reader finds none), the single `/jobs/view/` link as the
  selection signal, the description under its `h2`, a virtualised list that
  unmounts a card mid-run, and that a classic page is **not** claimed by it.
- `tests/aisearch.test.js` — LinkedIn's AI job search, reconstructed from a real
  diagnostic: hashed class names, seven cards whose links all carry the same
  `currentJobId`, three upsell panels the description must not swallow, and the
  clipped "… more".
- `tests/hiringcafe.test.js` — the adapter against a response captured from the
  live site (`tests/fixtures/`). Weighted toward the null-vs-zero rule and toward
  degrading rather than throwing when the page shape changes.
- `tests/extract.test.js` — selector health, card discovery, every extracted
  field, HTML→text, apply-type variants, date parsing.
- `tests/parse.test.js` — the prose parsers, no DOM needed. Roughly half the cases
  are **traps that must parse to null**: funding rounds, 401(k) matches, sign-on
  bonuses, patient counts, company age, "in the past 3 years".
- `tests/gem.test.js` — the verdict parser, on the same trap-heavy principle: an
  id mentioned in passing, "we rejected 40% of applicants", two ids on one line
  and "VERDICT" used as prose all must yield **nothing** rather than a guess.
- `tests/generic.test.js` — the fallback, on a page with no known class names.
- `tests/pane.test.js` — that the details pane belongs to the job that was clicked,
  including a URL that has moved ahead of the pane it names, and the recovery
  when every heuristic picks a block that never changes: a page built so the
  "About the job" anchor lands on a static panel, where the posting is found
  anyway by watching what moved.
- `tests/searchresults.test.js` — search-results-page handling.
- `tests/panel.test.js` — every filter, sorting, batching, CSV escaping, search-URL
  building, search persistence, the simple/advanced toggle, and that the export
  carries **no** verdict.
- `tests/manager.test.js` — the settings window: one section at a time, config
  saved through the worker's merge, empty-vs-zero, and the log renderer.
- `tests/aifields.test.js` — the field check, and mostly answers that must be
  REFUSED: an embellished company name, a paraphrased location, an invented
  salary, a workplace type the page contradicts. Also that a field the page
  already read is never overwritten, and that "unknown" is the model declining
  rather than a value to write.
- `tests/aiplan.test.js` — the AI assist, weighted the same trap-heavy way as the
  verdict parser: prose with no JSON, a leaked `<think>` block, `body` offered as
  a description, a `card` selector matching once, and a Premium upsell offered as
  the next-page control all have to be **refused**. It also pins that the page
  outline carries a posting's class names but not its text, and that a plan
  cannot override a hand-written selector that still matches.

## File map

```
manifest.json                  MV3 manifest
src/background.js              State owner: storage, counters, message routing,
                               the hiring.cafe collector, the settings window
src/content/selectors.js       Selectors, shape discovery, text anchors,
                               learned (AI-resolved) selectors
src/content/parse.js           Prose parsers: pay, years, flags (pure, no DOM)
src/content/extract.js         Field extraction + HTML→text
src/content/content.js         The driver loop: scroll, click, capture, paginate
src/content/aisearch.js        The AI job search adapter: componentkey ids, the
                               selected-job link, the virtualised list
 src/content/aiassist.js        Page outline for the AI assist, and the check
                               every resolved selector has to pass
src/lib/hiringcafe.js          hiringcafe.com adapter (pure; runs in the worker)
src/lib/gemVerdicts.js         Verdict-line parser (pure; runs in the worker)
src/lib/aiPlan.js              AI prompt, reply parser, plan rules (pure)
src/lib/aiFields.js            The field check: prompt, reply parser, and the
                               verbatim rule every value has to pass (pure)
src/content/gem.js             Read-only reader for a vetting chat page
src/sidepanel/sidepanel.html   The run surface
src/sidepanel/sidepanel.css    Styles (follows the browser light/dark theme)
src/sidepanel/sidepanel.js     Search, filtering, selection, export
src/manager/manager.html       Settings window: collection, prompt, AI assist,
                               diagnostics
src/manager/manager.css        Manager styles (same tokens as the panel)
src/manager/manager.js         Config load/save and the diagnostics
tests/                         jsdom + vm test suites
tests/fixtures/                Responses captured from live sites
```

## Design notes

**Facts, not verdicts.** The extension parses what a posting says and never
concludes anything from it. That is why there is no scoring, no profile and no
learned model: a filter that drops a job has to be able to name the sentence in
the posting that justifies it.

**An unknown is never a rejection.** Missing data leaves a job in the list.
Every parser returns `null` rather than a guess, and every filter is written so
that `null` survives it.

**Degrade, never throw.** A page whose shape changed produces an empty result and
a diagnostic, not an exception. A run that collects nothing says so and explains
itself; it never reports success on an empty pass.

**Structure over class names.** Every selector belongs to someone else's app.
Where a durable anchor exists — a job link, a repeated sibling group, an "About
the job" heading — it is preferred over anything that can be renamed in a deploy.
#   h a s a n - j d - c o l l e c t o r -  
 