/* JD Collector - the side panel.
 *
 * Collect, filter, export. That is the whole job.
 *
 * There is deliberately no scoring, no ranking and no per-client profile here.
 * Every filter below keys on something read out of the posting - pay, workplace
 * type, clearance, sponsorship, travel, years required, reposted, applicant
 * count, text matches - so the panel can narrow a list but never reorder it by
 * opinion, and never hide a job for a reason it cannot name in the posting's own
 * terms. The judgement is yours to make from the exported batches.
 *
 * Settings and diagnostics live in the manager window; the gear here toggles
 * the handful of controls that belong next to the results they act on. */

const $ = (id) => document.getElementById(id);

const FILTER_KEY = 'jdc_filters';
const MODE_KEY = 'jdc_advanced';
/* The search criteria used to be persisted only inside a client record. With
 * clients gone they need a home of their own, or you would retype them every
 * time the panel opened. */
const SEARCH_KEY = 'jdc_search';

let JOBS = [];
let HISTORY = {};
/* Verdicts read back out of a vetting chat by the Gem scanner. The panel still
 * forms no opinion - this is someone else's call, remembered, and it only ever
 * hides a job when the filter for it is explicitly on. */
let VERDICTS = {};
let CONFIG = {};
let STATE = {};
let BATCHES = [];
let DESELECTED = new Set();

const APPLY_LABEL = {
  external: 'Direct apply',
  easy_apply: 'Easy Apply',
  closed: 'Closed',
  applied: 'Already applied',
  unknown: 'Apply: unknown'
};

const MAX_ROWS = 300;

/* ---------------- helpers ---------------- */

function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || {});
    });
  });
}

function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function banner(text, ok) {
  const el = $('banner');
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.className = 'banner' + (ok ? ' ok' : '');
  el.hidden = false;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url: url, filename: filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    banner((label || 'Copied') + ' — ' + text.length.toLocaleString() + ' chars on the clipboard.', true);
  } catch (e) {
    banner('Copy failed: ' + e.message);
  }
}

async function refreshTabUrl() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tabs[0] && tabs[0].url) || '';
  $('tabUrl').textContent = url ? url.slice(0, 140) : '(none)';
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return url.slice(0, 40);
  }
}

function payTag(j) {
  const k = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
  const cur = j.payCurrency && j.payCurrency.length === 1 ? j.payCurrency : '';
  const range = j.payMax != null ? k(j.payMin) + '-' + cur + k(j.payMax) : k(j.payMin);
  const per = j.payPeriod ? '/' + (j.payPeriod === 'year' ? 'yr' : j.payPeriod === 'hour' ? 'hr' : j.payPeriod) : '';
  return cur + range + per + (j.paySource === 'jd' ? ' (JD)' : '');
}

/* ---------------- the search ---------------- */

const SEARCH_FIELDS = ['sKeywords', 'sLocation', 'sRemote', 'sPosted', 'sLevel', 'sType', 'sSort'];

function readSearch() {
  const out = {};
  SEARCH_FIELDS.forEach((id) => { out[id] = $(id).value; });
  out.sUnder10 = $('sUnder10').checked;
  return out;
}

function writeSearch(s) {
  const v = s || {};
  SEARCH_FIELDS.forEach((id) => {
    if (v[id] !== undefined) $(id).value = v[id];
  });
  $('sUnder10').checked = !!v.sUnder10;
  if (!$('sSort').value) $('sSort').value = 'DD';
}

function saveSearch() {
  return chrome.storage.local.set({ [SEARCH_KEY]: readSearch() });
}

function buildSearchUrl() {
  const u = new URL('https://www.linkedin.com/jobs/search/');
  const p = u.searchParams;
  const kw = $('sKeywords').value.trim();
  const loc = $('sLocation').value.trim();
  if (kw) p.set('keywords', kw);
  if (loc) p.set('location', loc);
  if ($('sRemote').value) p.set('f_WT', $('sRemote').value);
  if ($('sPosted').value) p.set('f_TPR', $('sPosted').value);
  if ($('sLevel').value) p.set('f_E', $('sLevel').value);
  if ($('sType').value) p.set('f_JT', $('sType').value);
  if ($('sUnder10').checked) p.set('f_JIYN', 'true');
  p.set('sortBy', $('sSort').value || 'DD');
  p.set('start', '0');
  return u.toString();
}

/* The shape hiringcafe.js expects. The panel's own fields are the single source
 * of criteria now, so both collectors read from the same place. */
function searchRecord() {
  return {
    name: $('sKeywords').value.trim() || 'Search',
    keywords: $('sKeywords').value.trim(),
    location: $('sLocation').value.trim(),
    remote: $('sRemote').value,
    posted: $('sPosted').value,
    level: $('sLevel').value,
    type: $('sType').value,
    sort: $('sSort').value,
    under10: $('sUnder10').checked
  };
}

/* ---------------- filters ---------------- */

function readFilters() {
  const checked = (cls) =>
    Array.prototype.slice.call(document.querySelectorAll('.' + cls))
      .filter((c) => c.checked)
      .map((c) => c.value);

  return {
    q: $('fSearch').value,
    workplace: checked('fWorkplace'),
    apply: checked('fApply'),
    noRepost: $('fNoRepost').checked,
    noPromoted: $('fNoPromoted').checked,
    noSeen: $('fNoSeen').checked,
    noRejected: $('fNoRejected').checked,
    noClearance: $('fNoClearance').checked,
    noSponsor: $('fNoSponsor').checked,
    noReloc: $('fNoReloc').checked,
    noFakeRemote: $('fNoFakeRemote').checked,
    hasPay: $('fHasPay').checked,
    minPay: $('fMinPay').value,
    maxYoe: $('fMaxYoe').value,
    maxTravel: $('fMaxTravel').value,
    sort: $('fSort').value,
    maxDays: $('fMaxDays').value,
    maxApplicants: $('fMaxApplicants').value,
    titleAny: $('fTitleAny').value,
    titleNot: $('fTitleNot').value,
    jdAll: $('fJdAll').value,
    jdAny: $('fJdAny').value,
    jdNot: $('fJdNot').value,
    companyNot: $('fCompanyNot').value,
    minChars: $('fMinChars').value
  };
}

function writeFilters(f) {
  f = f || {};
  const apply = (cls, values) => {
    const set = new Set(values || []);
    document.querySelectorAll('.' + cls).forEach((c) => { c.checked = set.has(c.value); });
  };
  $('fSearch').value = f.q || '';
  apply('fWorkplace', f.workplace);
  apply('fApply', f.apply);
  $('fNoRepost').checked = !!f.noRepost;
  $('fNoPromoted').checked = !!f.noPromoted;
  $('fNoSeen').checked = !!f.noSeen;
  $('fNoRejected').checked = !!f.noRejected;
  $('fNoClearance').checked = !!f.noClearance;
  $('fNoSponsor').checked = !!f.noSponsor;
  $('fNoReloc').checked = !!f.noReloc;
  $('fNoFakeRemote').checked = !!f.noFakeRemote;
  $('fHasPay').checked = !!f.hasPay;
  $('fMinPay').value = f.minPay || '';
  $('fMaxYoe').value = f.maxYoe || '';
  $('fMaxTravel').value = f.maxTravel || '';
  $('fSort').value = f.sort || 'collected';
  $('fMaxDays').value = f.maxDays || '';
  $('fMaxApplicants').value = f.maxApplicants || '';
  $('fTitleAny').value = f.titleAny || '';
  $('fTitleNot').value = f.titleNot || '';
  $('fJdAll').value = f.jdAll || '';
  $('fJdAny').value = f.jdAny || '';
  $('fJdNot').value = f.jdNot || '';
  $('fCompanyNot').value = f.companyNot || '';
  $('fMinChars').value = f.minChars || '';
}

/* ---------------- search ----------------
 *
 * The problem this solves: a vetting pass comes back approving four jobs out
 * of four hundred, and finding those four means scrolling. Typing the company
 * should put the job on top.
 *
 * So it RANKS as well as filters. Every term has to match somewhere - that is
 * what people mean by a search box - but where it matched decides the order:
 * a company called Acme beats a posting that mentions Acme in passing, and an
 * exact job id beats everything, because an id is only ever pasted when you
 * know precisely which job you want.
 */

const SEARCH_FIELDS_RANKED = [
  { key: 'jobId', weight: 100, exactOnly: true },
  { key: 'company', weight: 40 },
  { key: 'title', weight: 30 },
  { key: 'location', weight: 12 },
  { key: 'companyUrl', weight: 6 },
  { key: 'description', weight: 3 }
];

function searchTerms(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/* -1 means "no match, drop it"; anything higher sorts first. */
function searchScore(job, terms) {
  if (!terms.length) return 0;

  let total = 0;

  for (let t = 0; t < terms.length; t++) {
    const term = terms[t];
    let best = 0;

    for (let i = 0; i < SEARCH_FIELDS_RANKED.length; i++) {
      const spec = SEARCH_FIELDS_RANKED[i];
      const value = String(job[spec.key] == null ? '' : job[spec.key]).toLowerCase();
      if (!value) continue;

      if (spec.exactOnly) {
        if (value === term) best = Math.max(best, spec.weight);
        continue;
      }

      const at = value.indexOf(term);
      if (at === -1) continue;

      /* Whole field, then start of field, then anywhere: "acme" should find
       * Acme CRO ahead of a posting that name-drops Acme in paragraph nine. */
      let score = spec.weight;
      if (value === term) score += spec.weight * 2;
      else if (at === 0) score += spec.weight;
      best = Math.max(best, score);
    }

    // Every term has to land somewhere, or this is not the job being looked for.
    if (!best) return -1;
    total += best;
  }

  return total;
}

function applyFilters(jobs, f) {
  const titleAny = splitList(f.titleAny);
  const titleNot = splitList(f.titleNot);
  const jdAll = splitList(f.jdAll);
  const jdAny = splitList(f.jdAny);
  const jdNot = splitList(f.jdNot);
  const companyNot = splitList(f.companyNot);
  const maxDays = f.maxDays === '' ? null : Number(f.maxDays);
  const maxApp = f.maxApplicants === '' ? null : Number(f.maxApplicants);
  const minChars = Number(f.minChars) || 0;
  const minPay = f.minPay === '' ? null : Number(f.minPay);
  const maxYoe = f.maxYoe === '' ? null : Number(f.maxYoe);
  const maxTravel = f.maxTravel === '' ? null : Number(f.maxTravel);

  const terms = searchTerms(f.q);

  return jobs.filter((j) => {
    // The search is the cheapest way to eliminate a job, so it goes first.
    if (terms.length && searchScore(j, terms) < 0) return false;

    /* An unknown is never a rejection - the rule every numeric filter below
     * already follows, and the one these two were quietly breaking.
     *
     * On LinkedIn's AI job search both fields come back Unknown often enough
     * that this emptied the whole list: 12 collected, 0 shown, and nothing on
     * screen saying which filter did it. A posting that never stated its
     * workplace type has no sentence in it that justifies dropping the job -
     * which is the test every filter in here has to pass. */
    const wp = j.workplaceType || 'Unknown';
    if (f.workplace.length && wp !== 'Unknown' && f.workplace.indexOf(wp) === -1) return false;

    const route = j.applyType || 'unknown';
    if (f.apply.length && route !== 'unknown' && f.apply.indexOf(route) === -1) return false;
    if (f.noRepost && j.reposted) return false;
    if (f.noPromoted && j.promoted) return false;
    if (f.noSeen && HISTORY[j.jobId]) return false;
    if (f.noRejected && VERDICTS[j.jobId] && VERDICTS[j.jobId].verdict === 'reject') return false;

    if (f.noClearance && j.needsClearance) return false;
    if (f.noSponsor && j.sponsorshipUnavailable) return false;
    if (f.noReloc && j.requiresRelocation) return false;
    if (f.noFakeRemote && j.remoteContradiction) return false;
    if (f.hasPay && j.payMinAnnual == null) return false;

    // Unknown posted age is kept: absence of a signal is not a rejection.
    if (maxDays !== null && j.postedDaysAgo != null && j.postedDaysAgo > maxDays) return false;
    if (maxApp !== null && j.applicants != null && j.applicants > maxApp) return false;
    if (minChars && (j.descriptionChars || 0) < minChars) return false;

    /* Pay clears the floor if the TOP of the stated range does. Using the
     * bottom would reject a $110-140k job for a $130k floor. */
    if (minPay !== null) {
      const ceiling = j.payMaxAnnual != null ? j.payMaxAnnual : j.payMinAnnual;
      if (ceiling != null && ceiling < minPay) return false;
    }
    if (maxYoe !== null && j.yoeMin != null && j.yoeMin > maxYoe) return false;
    if (maxTravel !== null && j.travelPct != null && j.travelPct > maxTravel) return false;

    const title = (j.title || '').toLowerCase();
    const company = (j.company || '').toLowerCase();
    const jd = (j.description || '').toLowerCase();

    if (titleAny.length && !titleAny.some((k) => title.includes(k))) return false;
    if (titleNot.some((k) => title.includes(k))) return false;
    if (companyNot.some((k) => company.includes(k))) return false;
    if (jdAll.length && !jdAll.every((k) => jd.includes(k))) return false;
    if (jdAny.length && !jdAny.some((k) => jd.includes(k))) return false;
    if (jdNot.some((k) => jd.includes(k))) return false;

    return true;
  });
}

/* Sorting runs after filtering so the comparator only sees survivors. There is
 * no "by fit" mode: the panel does not rank jobs. */
function sortJobs(jobs, mode, terms) {
  const out = jobs.slice();
  const num = (v, fallback) => (v == null ? fallback : Number(v));

  if (mode === 'posted') {
    out.sort((a, b) => num(a.postedDaysAgo, 9999) - num(b.postedDaysAgo, 9999));
  } else if (mode === 'pay') {
    out.sort((a, b) => num(b.payMaxAnnual != null ? b.payMaxAnnual : b.payMinAnnual, -1) -
                       num(a.payMaxAnnual != null ? a.payMaxAnnual : a.payMinAnnual, -1));
  } else if (mode === 'applicants') {
    out.sort((a, b) => num(a.applicants, 1e9) - num(b.applicants, 1e9));
  }

  /* Relevance wins while a search is running - "the job I typed should be at
   * the top" is the entire point of typing it. The chosen sort survives as
   * the tiebreak, because the sort above has already been applied and this is
   * a stable sort. */
  if (terms && terms.length) {
    out.sort((a, b) => searchScore(b, terms) - searchScore(a, terms));
  }
  return out;
}

function currentFiltered() {
  const f = readFilters();
  return sortJobs(applyFilters(JOBS, f), f.sort, searchTerms(f.q));
}

function selectedJobs(filtered) {
  return filtered.filter((j) => !DESELECTED.has(j.jobId));
}

/* ---------------- simple / advanced ---------------- */

const ADV_FILTER_LABELS = {
  workplace: 'workplace type',
  apply: 'application route',
  noRepost: 'hide reposted',
  noPromoted: 'hide promoted',
  noSeen: 'hide already exported',
  noRejected: 'hide previously turned down',
  noClearance: 'hide clearance required',
  noSponsor: 'hide no-sponsorship',
  noReloc: 'hide relocation required',
  noFakeRemote: 'hide fake remote',
  hasPay: 'pay found only',
  minPay: 'min pay',
  maxYoe: 'max years required',
  maxTravel: 'max travel',
  maxDays: 'posted within',
  maxApplicants: 'max applicants',
  titleAny: 'title contains',
  titleNot: 'title excludes',
  jdAll: 'JD contains all of',
  jdAny: 'JD contains any of',
  jdNot: 'JD excludes',
  companyNot: 'excluded companies',
  minChars: 'min JD length'
};

function activeAdvFilters(f) {
  return Object.keys(ADV_FILTER_LABELS).filter((k) => {
    const v = f[k];
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'boolean') return v;
    if (k === 'minChars') return Number(v) > 0;
    return String(v == null ? '' : v).trim() !== '';
  });
}

/* The same filter set with everything but one key blanked. The shape is taken
 * from the filters object itself rather than written out again, so a filter
 * added later cannot be silently left out of the measurement below. */
function onlyFilter(f, key) {
  const out = {};
  Object.keys(f).forEach((k) => {
    const v = f[k];
    if (k === key || k === 'sort') { out[k] = v; return; }
    out[k] = Array.isArray(v) ? [] : (typeof v === 'boolean' ? false : '');
  });
  return out;
}

/* Which filters are actually removing jobs, worst first.
 *
 * Each is measured ALONE against the whole collected set, so the numbers
 * overlap - two filters can each claim the same job. That is the right way
 * round for the question being asked, which is "which one do I turn off to
 * get my list back", not "how do these divide the losses between them". */
function filtersRemoving(f, jobs) {
  const list = jobs || JOBS;
  return activeAdvFilters(f)
    .map((k) => ({ key: k, removed: list.length - applyFilters(list, onlyFilter(f, k)).length }))
    .filter((x) => x.removed > 0)
    .sort((a, b) => b.removed - a.removed);
}

/* An empty list under a full set of collected jobs is the one state the panel
 * used to leave completely unexplained: "0 of 12 collected" and an empty box,
 * with the filter doing it possibly behind the gear. Name it. */
function emptyByFilterNote(f) {
  /* The search is not behind the gear, but it is still the likeliest reason a
   * list is empty, so it is named first and by name. */
  if (searchTerms(f.q).length) {
    return 'Nothing matches "' + String(f.q).trim() + '". It searches company, ' +
      'title, location and job id — clear it to see all ' + JOBS.length + ' again.';
  }

  const by = filtersRemoving(f);
  if (!by.length) {
    return 'All ' + JOBS.length + ' collected jobs are hidden, but no filter is set. ' +
      'That is a bug — copy the activity log from Settings → Diagnostics.';
  }
  const names = by.slice(0, 3).map((x) => ADV_FILTER_LABELS[x.key] + ' (' + x.removed + ')');
  return 'All ' + JOBS.length + ' collected jobs are filtered out — ' +
    names.join(', ') + (by.length > 3 ? ' and ' + (by.length - 3) + ' more' : '') +
    '. Open the gear to change them, or Reset filters to clear them all.';
}

/* A hidden filter thinning the list is the one way simple mode can mislead
 * rather than help, so it is stated outright. */
function renderFilterNote(f) {
  const note = $('filterNote');
  if (!note) return;
  const active = activeAdvFilters(f);

  if (!document.body.classList.contains('simple') || !active.length) {
    note.hidden = true;
    note.textContent = '';
    return;
  }

  const names = active.map((k) => ADV_FILTER_LABELS[k]);
  const head = names.slice(0, 3).join(', ');
  const rest = names.length > 3 ? ' and ' + (names.length - 3) + ' more' : '';
  note.textContent =
    active.length + (active.length === 1 ? ' hidden filter is' : ' hidden filters are') +
    ' narrowing this list: ' + head + rest + '. Open the gear to change them.';
  note.hidden = false;
}

function setAdvanced(on) {
  document.body.classList.toggle('simple', !on);
  const btn = $('btnAdvanced');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Hide advanced settings' : 'Show advanced settings';
  renderFilterNote(readFilters());
}

/* ---------------- export ---------------- */

function jobBlock(j, index, maxJd) {
  let jd = j.description || '(no description captured)';
  let trimmed = false;
  if (maxJd > 0 && jd.length > maxJd) { jd = jd.slice(0, maxJd); trimmed = true; }

  const bits = [];
  if (j.employmentType) bits.push(j.employmentType);
  if (j.seniority) bits.push(j.seniority);

  /* The parsed facts travel alongside the prose so whoever reads this does not
   * have to re-derive comp, seniority or dealbreakers from the description.
   * Facts only - the extension states no conclusion about the job. */
  const facts = [];
  if (j.payRaw) {
    facts.push('Pay: ' + j.payRaw +
      (j.payMinAnnual != null ? ' (annualized ' + j.payMinAnnual.toLocaleString() +
        (j.payMaxAnnual != null ? '-' + j.payMaxAnnual.toLocaleString() : '') + ')' : '') +
      ' [source: ' + (j.paySource === 'pill' ? 'LinkedIn pay field'
        : j.paySource === 'model' ? 'read off the page by ' + ((j.aiFields && j.aiFields.pay) || 'a model')
        : 'description text') + ']');
  }
  if (j.yoeMin != null) facts.push('Years required: ' + j.yoeMin + '+');
  if (j.travelPct != null) facts.push('Travel: up to ' + j.travelPct + '%');
  if (j.onsiteDaysPerWeek != null) facts.push('Onsite: ' + j.onsiteDaysPerWeek + ' day(s)/week');
  if (j.needsClearance) facts.push('Security clearance required');
  if (j.sponsorshipUnavailable) facts.push('Visa sponsorship NOT available');
  if (j.requiresRelocation) facts.push('Relocation required');
  if (j.remoteContradiction) facts.push('WARNING: tagged Remote but the description requires onsite presence');
  if (j.certifications && j.certifications.length) facts.push('Certifications listed: ' + j.certifications.join(', '));
  if (j.tools && j.tools.length) facts.push('Tools listed: ' + j.tools.join(', '));
  if (j.applyUrl) facts.push('Direct apply URL: ' + j.applyUrl);

  return [
    '--- JOB ' + index + ' | ID ' + j.jobId + ' ---',
    'Title: ' + (j.title || ''),
    'Company: ' + (j.company || ''),
    'Location: ' + (j.location || '') + ' (' + j.workplaceType + ')',
    'Posted: ' + (j.postedRaw || 'unknown') + (j.reposted ? ' [REPOSTED]' : ''),
    'Applicants: ' + (j.applicants == null ? 'unknown' : j.applicants),
    'Apply route: ' + (APPLY_LABEL[j.applyType] || j.applyType) + (j.promoted ? ' [PROMOTED]' : ''),
    bits.length ? 'Details: ' + bits.join(' | ') : null,
    'Source: ' + (j.source === 'hiringcafe' ? 'hiring.cafe' + (j.atsSource ? ' via ' + j.atsSource : '') : 'LinkedIn'),
    'URL: ' + j.url,
    facts.length ? 'PARSED FACTS: ' + facts.join(' | ') : null,
    '',
    'JOB DESCRIPTION:',
    jd + (trimmed ? '\n[...trimmed]' : ''),
    ''
  ].filter((l) => l !== null).join('\n');
}

/* Hard ceiling on jobs per batch. A batch that clears the character budget can
 * still be too many postings to read in one pass, so the count caps it
 * independently - whichever limit bites first wins. */
const MAX_JOBS_PER_BATCH = 15;

function buildBatches(jobs) {
  const maxJd = Number(CONFIG.maxJdChars) || 0;
  const budget = Math.max(5000, Number(CONFIG.batchChars) || 80000);
  const prompt = String(CONFIG.promptTemplate == null ? '' : CONFIG.promptTemplate);

  /* Appended after the prompt, so the reply comes back in a shape the Gem
   * scanner can read. It asks for a format, never for a conclusion. */
  const vetting = String(CONFIG.vettingFormat == null ? '' : CONFIG.vettingFormat).trim();

  const blocks = jobs.map((j, i) => jobBlock(j, i + 1, maxJd));
  const chunks = [];
  let cur = [];
  let curLen = 0;

  blocks.forEach((b) => {
    /* Split on either limit. A single oversized block still gets its own batch
     * rather than being dropped. */
    const overChars = curLen + b.length > budget;
    const overCount = cur.length >= MAX_JOBS_PER_BATCH;
    if (cur.length && (overChars || overCount)) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(b);
    curLen += b.length;
  });
  if (cur.length) chunks.push(cur);

  return chunks.map((c, i) => {
    const header = (prompt ? prompt + '\n\n' : '') +
      (vetting ? vetting + '\n\n' : '') +
      '=== BATCH ' + (i + 1) + ' of ' + chunks.length +
      ' — ' + c.length + ' jobs ===\n\n';
    return { text: header + c.join('\n'), count: c.length };
  });
}

function renderBatches(selected) {
  BATCHES = selected.length ? buildBatches(selected) : [];
  const info = $('batchInfo');
  const box = $('batchButtons');
  box.textContent = '';

  if (!BATCHES.length) {
    info.textContent = 'Select at least one job to build a batch.';
    return;
  }

  const total = BATCHES.reduce((n, b) => n + b.text.length, 0);
  info.textContent = BATCHES.length + ' batch' + (BATCHES.length > 1 ? 'es' : '') +
    ' · ' + selected.length + ' jobs · ' + total.toLocaleString() + ' chars total';

  BATCHES.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Copy batch ' + (i + 1) + ' (' + b.count + ')';
    btn.addEventListener('click', () => copy(b.text, 'Batch ' + (i + 1)));
    box.appendChild(btn);
  });
}

function toCsv(jobs) {
  const cols = ['jobId', 'title', 'company', 'location', 'workplaceType', 'applyType',
    'reposted', 'promoted', 'postedRaw', 'postedDaysAgo', 'applicants', 'employmentType',
    'seniority', 'payRaw', 'payMinAnnual', 'payMaxAnnual', 'payPeriod', 'paySource',
    'yoeMin', 'travelPct', 'onsiteDaysPerWeek', 'needsClearance', 'sponsorshipUnavailable',
    'requiresRelocation', 'remoteContradiction', 'applyUrl',
    'source', 'atsSource', 'descriptionChars', 'url', 'description'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(',')];
  jobs.forEach((j) => rows.push(cols.map((c) => cell(j[c])).join(',')));
  return '﻿' + rows.join('\r\n');
}

/* ---------------- rendering ---------------- */

function render() {
  const f = readFilters();
  const filtered = sortJobs(applyFilters(JOBS, f), f.sort, searchTerms(f.q));
  const selected = selectedJobs(filtered);

  const searching = searchTerms(f.q).length > 0;
  $('resultCount').textContent =
    filtered.length + ' of ' + JOBS.length + ' collected' +
    (searching ? ' · matching "' + f.q.trim() + '", best first' : '');
  $('selCount').textContent = selected.length + ' selected';
  renderFilterNote(f);

  const box = $('results');
  box.textContent = '';

  const shown = filtered.slice(0, MAX_ROWS);
  const frag = document.createDocumentFragment();

  shown.forEach((j) => {
    const row = document.createElement('div');
    row.className = 'job';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !DESELECTED.has(j.jobId);
    cb.addEventListener('change', () => {
      if (cb.checked) DESELECTED.delete(j.jobId);
      else DESELECTED.add(j.jobId);
      render();
    });

    const main = document.createElement('div');
    main.className = 'job-main';
    main.innerHTML =
      '<div class="job-title"><a href="' + esc(j.url) + '" target="_blank" rel="noreferrer">' +
      esc(j.title || '(untitled)') + '</a></div>' +
      '<div class="job-sub">' + esc(j.company || '?') +
      (j.location ? ' &middot; ' + esc(j.location) : '') +
      (j.postedRaw ? ' &middot; ' + esc(j.postedRaw) : '') +
      (j.applicants != null ? ' &middot; ' + j.applicants + ' applicants' : '') +
      '</div>';

    const tags = document.createElement('div');
    tags.className = 'tags';
    const add = (text, cls) => {
      const t = document.createElement('span');
      t.className = 'tag' + (cls ? ' ' + cls : '');
      t.textContent = text;
      tags.appendChild(t);
    };
    add(j.workplaceType, j.workplaceType === 'Remote' ? 'remote' : '');
    add(APPLY_LABEL[j.applyType] || j.applyType,
      j.applyType === 'external' ? 'direct' : (j.applyType === 'easy_apply' ? 'easy' : ''));
    if (j.source === 'hiringcafe') add('hiring.cafe' + (j.atsSource ? ' · ' + j.atsSource : ''));
    if (j.reposted) add('Reposted', 'repost');
    if (j.promoted) add('Promoted');
    if (j.remoteContradiction) add('Fake remote', 'repost');
    if (j.employmentType) add(j.employmentType);
    if (j.seniority) add(j.seniority);
    if (j.payRaw) add(payTag(j), 'pay');
    if (j.yoeMin != null) add(j.yoeMin + '+ yrs req');
    if (j.travelPct != null) add(j.travelPct + '% travel');
    if (j.onsiteDaysPerWeek != null) add(j.onsiteDaysPerWeek + 'd/wk onsite');
    if (j.needsClearance) add('Clearance', 'repost');
    if (j.sponsorshipUnavailable) add('No sponsorship', 'repost');
    if (j.requiresRelocation) add('Relocation', 'repost');
    if (j.applyUrl) add('Apply link', 'direct');
    if (HISTORY[j.jobId]) add('Exported before');

    /* Which fields a model filled in, if any. A fact whose source is a model
     * is labelled wherever it is read - the extension does not get to claim
     * the page said something it did not. */
    const aiNames = Object.keys(j.aiFields || {});
    if (aiNames.length) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = 'AI: ' + aiNames.join(', ');
      t.title = 'Read off the page by ' + j.aiFields[aiNames[0]] +
        ', checked to appear verbatim in the posting.';
      tags.appendChild(t);
    }

    /* What the vetting chat said about this job, if anything. Shown so a
     * previous decision is visible without leaving the panel - and it is only
     * ever shown, never acted on unless the matching filter is switched on. */
    const v = VERDICTS[j.jobId];
    if (v) {
      const t = document.createElement('span');
      t.className = 'tag' + (v.verdict === 'reject' ? ' repost' : ' direct');
      t.textContent = v.verdict === 'reject' ? 'Turned down' : 'Approved';
      if (v.reason) t.title = v.reason;
      tags.appendChild(t);
    }

    add((j.descriptionChars || 0).toLocaleString() + ' chars');

    main.appendChild(tags);

    if (j.applyUrl) {
      const line = document.createElement('div');
      line.className = 'job-sub';
      line.innerHTML = '&#8599; <a href="' + esc(j.applyUrl) + '" target="_blank" rel="noreferrer">' +
        esc(hostLabel(j.applyUrl)) + '</a>';
      main.appendChild(line);
    }

    row.appendChild(cb);
    row.appendChild(main);
    frag.appendChild(row);
  });

  box.appendChild(frag);

  let note = '';
  if (filtered.length > MAX_ROWS) {
    note = 'Showing the first ' + MAX_ROWS + ' rows. Export includes all ' +
      filtered.length + ' selected matches.';
  } else if (!JOBS.length) {
    note = 'No jobs collected yet. Set up the search above, then press Collect.';
  } else if (!filtered.length) {
    note = emptyByFilterNote(f);
  }
  $('resultsNote').textContent = note;

  renderBatches(selected);
}

function renderStatus() {
  const running = !!STATE.active;
  const resolving = !!STATE.resolving;
  $('btnStart').hidden = running;
  $('btnStop').hidden = !running;
  $('btnResolveApply').hidden = resolving;
  $('btnStopResolve').hidden = !resolving;
  $('btnResolveApply').disabled = running;
  $('resolveInfo').textContent = resolving
    ? 'Resolving ' + (STATE.resolveDone || 0) + ' / ' + (STATE.resolveTotal || 0)
    : '';

  const reasonText = {
    'done': 'Finished',
    'stopped-by-user': 'Stopped',
    'max-pages-reached': 'Finished (page limit)',
    'max-jobs-reached': 'Finished (job limit)',
    'no-more-pages': 'Finished (last page)',
    'no-results': 'No results on this search',
    'no-cards': 'Finished (no more cards)',
    'no-new-jobs': 'Finished (the list stopped producing new jobs)',
    'tab-closed': 'Stopped (tab closed)',
    'error': 'Stopped on an error - see the log in Settings',
    'left-jobs-area': 'Stopped: the page left the job listings'
  };

  /* The hiringcafe run reports through the same state, so its buttons follow
   * the same active flag rather than tracking their own. */
  $('btnCollectHc').disabled = !!running;
  $('btnStopHc').hidden = !running;

  $('statusText').textContent = running
    ? 'Collecting — page ' + (STATE.page || 1)
    : (STATE.reason ? reasonText[STATE.reason] || STATE.reason : 'Idle');

  const parts = [(STATE.collected || 0) + ' collected'];
  if (STATE.skippedSeen) parts.push(STATE.skippedSeen + ' skipped');
  if (STATE.failed) parts.push(STATE.failed + ' failed');
  $('statusCounts').textContent = parts.join(' · ');

  $('currentJob').textContent = running ? (STATE.currentTitle || '') : '';

  /* With an explicit job or page limit the bar shows overall progress; with no
   * limit there is no known total, so it shows progress through the current
   * page instead of sitting at zero and looking broken. */
  const collected = STATE.collected || 0;
  const target = Number(CONFIG.maxJobs) || (Number(CONFIG.maxPages) || 0) * 25;
  const pct = target
    ? Math.min(100, Math.round((collected / target) * 100))
    : Math.round(((collected % 25) / 25) * 100);
  $('barFill').style.width = (running ? pct : (STATE.reason ? 100 : 0)) + '%';

  $('historyInfo').textContent = Object.keys(HISTORY).length +
    ' job ids in the export history (used by "skip already exported").';
}

/* ---------------- init ---------------- */

async function init() {
  const all = await bg({ type: 'JDC_GET_ALL' });
  JOBS = all.jobs || [];
  HISTORY = all.history || {};
  VERDICTS = all.verdicts || {};
  CONFIG = all.config || {};
  STATE = all.state || {};

  const stored = await chrome.storage.local.get([FILTER_KEY, MODE_KEY, SEARCH_KEY]);
  writeFilters(stored[FILTER_KEY]);
  writeSearch(stored[SEARCH_KEY]);

  renderStatus();
  render();
  refreshTabUrl();

  setAdvanced(!!stored[MODE_KEY]);

  $('btnAdvanced').addEventListener('click', async () => {
    const on = $('btnAdvanced').getAttribute('aria-pressed') !== 'true';
    setAdvanced(on);
    await chrome.storage.local.set({ [MODE_KEY]: on });
  });

  /* ---- the search ---- */

  SEARCH_FIELDS.forEach((id) => {
    $(id).addEventListener('change', saveSearch);
    $(id).addEventListener('input', saveSearch);
  });
  $('sUnder10').addEventListener('change', saveSearch);

  $('btnOpenSearch').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) await chrome.tabs.update(tabs[0].id, { url: buildSearchUrl() });
    refreshTabUrl();
  });

  $('btnNewTab').addEventListener('click', async () => {
    await chrome.tabs.create({ url: buildSearchUrl() });
  });

  $('btnSettings').addEventListener('click', async () => {
    const res = await bg({ type: 'JDC_OPEN_MANAGER' });
    if (!res.ok) banner(res.error || 'Could not open settings.');
  });

  /* ---- collecting ---- */

  $('btnStart').addEventListener('click', async () => {
    banner('');
    const res = await bg({ type: 'JDC_START' });
    if (!res.ok) return banner(res.error || 'Could not start.');
    STATE = (await bg({ type: 'JDC_GET_ALL' })).state;
    renderStatus();
  });

  $('btnStop').addEventListener('click', async () => {
    await bg({ type: 'JDC_STOP' });
  });

  $('btnCollectHc').addEventListener('click', async () => {
    banner('');
    const s = searchRecord();
    if (!s.keywords) return banner('Enter job title / keywords first.');

    /* Without a location hiring.cafe geolocates the request, which in testing
     * returned 29 mostly-foreign results instead of 1,632. */
    if (!s.location) {
      if (!confirm('No location set.\n\nhiring.cafe will guess one from your ' +
        'connection, which usually means far fewer and mostly foreign results.' +
        '\n\nCollect anyway?')) return;
    }

    const res = await bg({ type: 'JDC_HC_COLLECT', search: s });
    if (!res.ok) return banner(res.error || 'Could not start.');
    banner('Collecting from hiring.cafe. This runs in the background — the panel can be closed.', true);
    STATE = (await bg({ type: 'JDC_GET_ALL' })).state;
    renderStatus();
  });

  $('btnStopHc').addEventListener('click', async () => {
    await bg({ type: 'JDC_HC_STOP' });
    banner('Stopping after the current page.');
  });

  /* ---- filters ---- */

  const onFilterChange = async () => {
    /* Everything except the search, which is deliberately transient - see the
     * note on its own listener below. */
    await chrome.storage.local.set({
      [FILTER_KEY]: Object.assign({}, readFilters(), { q: '' })
    });
    render();
  };

  document.querySelectorAll('.fWorkplace, .fApply').forEach((el) => {
    el.addEventListener('change', onFilterChange);
  });
  ['fNoRepost', 'fNoPromoted', 'fNoSeen', 'fNoRejected', 'fNoClearance', 'fNoSponsor', 'fNoReloc',
    'fNoFakeRemote', 'fHasPay', 'fMinPay', 'fMaxYoe', 'fMaxTravel', 'fSort',
    'fMaxDays', 'fMaxApplicants', 'fTitleAny', 'fTitleNot', 'fJdAll', 'fJdAny',
    'fJdNot', 'fCompanyNot', 'fMinChars'].forEach((id) => {
    $(id).addEventListener('change', onFilterChange);
    $(id).addEventListener('input', onFilterChange);
  });

  /* The search renders as you type but is NOT persisted: a saved search that
   * silently narrows the list on next open is the same trap as a hidden
   * filter, and this one would be reinstated before you had a reason for it. */
  $('fSearch').addEventListener('input', render);
  $('fSearch').addEventListener('search', render);
  $('fSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('fSearch').value = ''; render(); }
  });
  $('btnSearchClear').addEventListener('click', () => {
    $('fSearch').value = '';
    $('fSearch').focus();
    render();
  });

  $('btnResetFilters').addEventListener('click', async () => {
    writeFilters({});
    DESELECTED = new Set();
    await onFilterChange();
  });

  /* ---- selection ---- */

  $('btnSelectAll').addEventListener('click', () => { DESELECTED = new Set(); render(); });
  $('btnSelectNone').addEventListener('click', () => {
    currentFiltered().forEach((j) => DESELECTED.add(j.jobId));
    render();
  });

  /* ---- apply links ---- */

  $('btnResolveApply').addEventListener('click', async () => {
    banner('');
    const sel = selectedJobs(currentFiltered());
    const targets = sel.filter((j) => j.applyType === 'external' && !j.applyUrl);
    if (!targets.length) {
      return banner('No unresolved direct-apply jobs in the current selection.');
    }
    const res = await bg({ type: 'JDC_RESOLVE_APPLY', ids: targets.map((j) => j.jobId) });
    if (!res.ok) return banner(res.error || 'Could not start.');
    banner('Resolving ' + res.count + ' apply links. Leave the LinkedIn tab open.', true);
    STATE = (await bg({ type: 'JDC_GET_ALL' })).state;
    renderStatus();
  });

  $('btnStopResolve').addEventListener('click', async () => {
    await bg({ type: 'JDC_STOP_RESOLVE' });
  });

  /* ---- export ---- */

  $('btnCopyAll').addEventListener('click', () => {
    if (!BATCHES.length) return banner('Nothing selected.');
    copy(BATCHES.map((b) => b.text).join('\n\n'), 'All batches');
  });

  $('btnDownloadMd').addEventListener('click', () => {
    if (!BATCHES.length) return banner('Nothing selected.');
    download('jd-collector-' + stamp() + '.md', BATCHES.map((b) => b.text).join('\n\n'), 'text/markdown');
  });

  $('btnDownloadCsv').addEventListener('click', () => {
    const sel = selectedJobs(currentFiltered());
    if (!sel.length) return banner('Nothing selected.');
    download('jd-collector-' + stamp() + '.csv', toCsv(sel), 'text/csv');
  });

  $('btnDownloadJson').addEventListener('click', () => {
    const sel = selectedJobs(currentFiltered());
    if (!sel.length) return banner('Nothing selected.');
    download('jd-collector-' + stamp() + '.json', JSON.stringify(sel, null, 2), 'application/json');
  });

  $('btnMarkExported').addEventListener('click', async () => {
    const sel = selectedJobs(currentFiltered());
    if (!sel.length) return banner('Nothing selected.');
    const res = await bg({ type: 'JDC_MARK_EXPORTED', ids: sel.map((j) => j.jobId) });
    HISTORY = (await bg({ type: 'JDC_GET_ALL' })).history || {};
    render();
    renderStatus();
    banner('Marked ' + (res.count || sel.length) + ' jobs as exported.', true);
  });

  $('btnClearJobs').addEventListener('click', async () => {
    if (!confirm('Clear all collected jobs?')) return;
    await bg({ type: 'JDC_CLEAR_JOBS' });
    JOBS = [];
    DESELECTED = new Set();
    render();
    renderStatus();
  });

  $('btnClearHistory').addEventListener('click', async () => {
    if (!confirm('Clear the export history? "Skip already exported" will stop working until it refills.')) return;
    await bg({ type: 'JDC_CLEAR_HISTORY' });
    HISTORY = {};
    render();
    renderStatus();
  });

  /* ---- messages from the worker ---- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'JDC_JOBS') {
      /* The worker sends the batch it just received, not the whole list - it
       * buffers writes to storage, so the accumulated list is not there yet.
       * Merging by id is what keeps earlier pages on screen; assigning would
       * clobber everything collected so far with the newest handful. */
      const known = new Set(JOBS.map((j) => j.jobId));
      (msg.jobs || []).forEach((j) => { if (!known.has(j.jobId)) JOBS.push(j); });
      if (msg.state) STATE = msg.state;
      render();
      renderStatus();
      return;
    }
    if (msg.type === 'JDC_PROGRESS' || msg.type === 'JDC_STATE' || msg.type === 'JDC_DONE') {
      if (msg.state) STATE = msg.state;
      else bg({ type: 'JDC_GET_ALL' }).then((all) => {
        JOBS = all.jobs || JOBS;
        HISTORY = all.history || HISTORY;
        VERDICTS = all.verdicts || VERDICTS;
        STATE = all.state || STATE;
        render();
        renderStatus();
      });
      renderStatus();
      if (msg.type === 'JDC_DONE') {
        bg({ type: 'JDC_GET_ALL' }).then((all) => {
          JOBS = all.jobs || JOBS;
          render();
        });
      }
      return;
    }
    if (msg.type === 'JDC_APPLY_RESOLVED') {
      const j = JOBS.filter((x) => x.jobId === msg.jobId)[0];
      if (j && msg.url) j.applyUrl = msg.url;
      render();
      return;
    }
  });

  /* Settings changed in the manager window - pick them up so batch sizing and
   * the prompt stay in step. */
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    /* A Gem scan runs in the manager window, so the panel only learns about
     * new verdicts this way. Without it the badges stay stale until reopen. */
    if (changes.jdc_verdicts) VERDICTS = changes.jdc_verdicts.newValue || VERDICTS;
    if (changes.jdc_config) CONFIG = changes.jdc_config.newValue || CONFIG;
    if (!changes.jdc_config && !changes.jdc_verdicts) return;
    render();
    renderStatus();
  });

  chrome.tabs.onActivated.addListener(() => refreshTabUrl());
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.url) refreshTabUrl(); });
}

init();
