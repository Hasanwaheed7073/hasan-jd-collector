/* JD Collector - hiringcafe.com as a second source.
 *
 * Why this exists: LinkedIn collection needs a logged-in session, violates the
 * User Agreement, and every selector belongs to someone else's app. hiringcafe
 * aggregates job postings across dozens of applicant tracking systems and hands
 * them over as structured data, with no login and no account to lose.
 *
 * WHAT WAS ACTUALLY VERIFIED (2026-08-24), because the public write-ups are all
 * wrong about this:
 *
 *   - The domain moved. `hiring.cafe` 308-redirects to `hiringcafe.com`.
 *   - `POST /api/search-jobs` returns 405. It is gone. Every third-party
 *     scraper and blog post still documents it.
 *   - Search is server-rendered. `GET /?searchState=<urlencoded JSON>` returns
 *     HTML whose __NEXT_DATA__ carries the results at
 *     props.pageProps.ssrHits, with ssrPage / ssrTotalCount / ssrIsLastPage.
 *   - Paging is `&page=N`, zero-based.
 *   - ssrHits returns MORE rows than ssrPageSize claims (40 claimed, 83-100
 *     observed), so trust the array length and never the page size.
 *   - The search result carries NO job description. Only a ~200 char
 *     requirements_summary. The full text needs a second call per job:
 *     `GET /api/job-description?id=<id>` -> { job: { job_information:
 *     { description: "<html>" } } }.
 *   - Location matters enormously. With no `locations` in searchState the
 *     backend geolocates the caller: the same query returned 29 results
 *     (Singapore, Sweden) with no location and 1,632 with a US one.
 *
 * Reading the page HTML rather than `/_next/data/{buildId}/index.json` is
 * deliberate: the buildId changes on every deploy, and depending on it would
 * break this silently every time they ship.
 *
 * This file is pure. No fetch, no DOM - it runs in the service worker, where
 * there is no DOMParser, which is why htmlToText below is string-based.
 */

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.JDC_HIRINGCAFE) return;

  const BASE = 'https://hiringcafe.com';

  /* ---------------- HTML to text ---------------- */

  /* Same output conventions as extract.js's DOM-walking htmlToText - "\n- " per
   * list item, blank line between blocks - so a hiringcafe description and a
   * LinkedIn one read identically to parse.js and to whoever reads the export. */
  const BLOCK = 'address|article|aside|blockquote|div|dl|dd|dt|fieldset|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hr|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
    mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“',
    rdquo: '”', hellip: '…', bull: '•', middot: '·',
    trade: '™', reg: '®', copy: '©', deg: '°', eacute: 'é'
  };

  function decodeEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
        return String.fromCodePoint(parseInt(h, 16));
      })
      .replace(/&#(\d+);/g, function (_, d) {
        return String.fromCodePoint(parseInt(d, 10));
      })
      .replace(/&([a-z]+);/gi, function (m, name) {
        const k = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
      });
  }

  function htmlToText(html) {
    if (!html) return '';
    let s = String(html);

    // Script and style content is never prose.
    s = s.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');

    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');
    s = s.replace(/<\/li\s*>/gi, '');
    s = s.replace(new RegExp('<(' + BLOCK + ')\\b[^>]*>', 'gi'), '\n');
    s = s.replace(new RegExp('</(' + BLOCK + ')\\s*>', 'gi'), '\n');

    // Anything left is inline; drop the tags and keep the text.
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);

    return s
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  /* ---------------- reading the page ---------------- */

  function extractNextData(html) {
    const m = String(html || '').match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  /* One place for the shape uncertainty. If a redesign moves the hits, this is
   * the only function that has to change - and it returns an empty page rather
   * than throwing, so a collect run reports "0 found" instead of dying. */
  function pageFrom(html) {
    const nd = extractNextData(html);
    const p = nd && nd.props && nd.props.pageProps;
    if (!p) return { hits: [], page: 0, total: null, lastPage: true, error: 'no __NEXT_DATA__ pageProps' };

    const hits = Array.isArray(p.ssrHits) ? p.ssrHits : [];
    return {
      hits: hits,
      page: typeof p.ssrPage === 'number' ? p.ssrPage : 0,
      total: typeof p.ssrTotalCount === 'number' ? p.ssrTotalCount : null,
      /* ssrPageSize under-reports (claims 40, returns 80-100), so an empty page
       * is the only trustworthy end-of-results signal besides the flag. */
      lastPage: p.ssrIsLastPage === true || hits.length === 0,
      error: p.ssrError || null
    };
  }

  function descriptionFrom(body) {
    const b = (typeof body === 'string') ? safeJson(body) : body;
    const d = b && b.job && b.job.job_information && b.job.job_information.description;
    return d ? htmlToText(d) : '';
  }

  function safeJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* ---------------- building a search ---------------- */

  /* The real searchState carries a Google-Places-shaped location object. A
   * country-level one built by hand is enough - verified returning 1,632 US
   * results - and avoids depending on their location lookup endpoint. */
  function locationFor(name) {
    const label = String(name || '').trim();
    if (!label) return null;
    const known = {
      'united states': 'US', 'usa': 'US', 'us': 'US',
      'united kingdom': 'GB', 'uk': 'GB',
      'canada': 'CA', 'australia': 'AU', 'germany': 'DE', 'france': 'FR',
      'india': 'IN', 'ireland': 'IE', 'netherlands': 'NL', 'spain': 'ES'
    };
    const short = known[label.toLowerCase()] || label.slice(0, 2).toUpperCase();

    return {
      formatted_address: label,
      types: ['country'],
      id: 'user_country',
      address_components: [{ long_name: label, short_name: short, types: ['country'] }],
      options: { flexible_regions: ['anywhere_in_continent', 'anywhere_in_world'] }
    };
  }

  /* LinkedIn's workplace codes, as stored on a saved search, mapped onto
   * hiringcafe's vocabulary. '2,3' is the panel's Remote+Hybrid pair. */
  const WORKPLACE_FROM_CODE = { '1': ['Onsite'], '2': ['Remote'], '3': ['Hybrid'], '2,3': ['Remote', 'Hybrid'] };

  /* Posted-within, from the panel's LinkedIn r<seconds> codes. */
  function daysFromPosted(code) {
    const m = /^r(\d+)$/.exec(String(code || ''));
    if (!m) return null;
    return Math.max(1, Math.round(Number(m[1]) / 86400));
  }

  /* buildSearchState(search) - `search` is the panel's own search fields, so
   * both collectors read their criteria from the same place rather than there
   * being a second form to fill in. */
  function buildSearchState(search) {
    const s = search || {};
    const state = {};

    if (s.keywords) state.searchQuery = String(s.keywords);

    const loc = locationFor(s.location);
    if (loc) state.locations = [loc];

    const wp = WORKPLACE_FROM_CODE[String(s.remote || '')];
    if (wp) state.workplaceTypes = wp.slice();

    const days = daysFromPosted(s.posted);
    if (days != null) state.dateFetchedPastNDays = days;

    return state;
  }

  function searchUrl(state, page) {
    const q = 'searchState=' + encodeURIComponent(JSON.stringify(state || {}));
    const p = (page && page > 0) ? '&page=' + page : '';
    return BASE + '/?' + q + p;
  }

  function descriptionUrl(id) {
    return BASE + '/api/job-description?id=' + encodeURIComponent(String(id));
  }

  /* ---------------- normalising a hit ---------------- */

  /* 'Field' is not on-site and not remote - for a CRA it usually means
   * travelling to sites, often home-based between visits. Calling it On-site
   * would wrongly exclude it from a remote-only filter, so it stays Unknown,
   * which the panel's workplace filter treats as its own bucket rather than
   * silently folding into On-site. The raw value is kept. */
  const WORKPLACE = { Onsite: 'On-site', Hybrid: 'Hybrid', Remote: 'Remote' };

  const HOURS_PER_YEAR = 2080;

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /* Only annualise when the currency is one the client's floor is stated in.
   * Comparing a EUR figure against a USD floor silently mis-scores. */
  function payOf(v) {
    const cur = v.listed_compensation_currency;
    if (cur && cur !== 'USD') return { min: null, max: null, raw: '', source: '' };

    let min = num(v.yearly_min_compensation);
    let max = num(v.yearly_max_compensation);
    let source = 'hiringcafe:yearly';

    if (min == null && max == null) {
      const hMin = num(v.hourly_min_compensation);
      const hMax = num(v.hourly_max_compensation);
      if (hMin != null || hMax != null) {
        min = hMin == null ? null : Math.round(hMin * HOURS_PER_YEAR);
        max = hMax == null ? null : Math.round(hMax * HOURS_PER_YEAR);
        source = 'hiringcafe:hourly';
      }
    }

    if (min == null && max == null) return { min: null, max: null, raw: '', source: '' };

    /* The source annualises hourly rates itself and hands back fractions
     * ($89,889.904 seen live). Nobody quotes a salary in tenths of a cent,
     * and an unrounded figure reads as a bug in the fit reasons. */
    if (min != null) min = Math.round(min);
    if (max != null) max = Math.round(max);

    const fmt = function (n) { return n == null ? '' : '$' + n.toLocaleString('en-US'); };
    return {
      min: min, max: max, source: source,
      raw: (min != null && max != null && min !== max)
        ? fmt(min) + ' - ' + fmt(max)
        : fmt(min != null ? min : max)
    };
  }

  /* Travel is an enum, not a percentage. Mapping it to a number would invent
   * precision the source does not have, so only the two ends that clearly mean
   * something are translated and everything else stays null. */
  function travelOf(v) {
    const worst = [v.air_travel_requirement, v.land_travel_requirement]
      .map(function (x) { return String(x || ''); });
    if (worst.some(function (x) { return /^(extensive|frequent|constant)\b/i.test(x); })) return 75;
    if (worst.some(function (x) { return /^(occasional|some|moderate|limited)\b/i.test(x); })) return 25;
    if (worst.every(function (x) { return /^none$/i.test(x) || x === ''; })) {
      return worst.some(function (x) { return /^none$/i.test(x); }) ? 0 : null;
    }
    return null;
  }

  function yoeOf(v) {
    /* Tri-state: the flag is null when unknown, true when the posting did not
     * say, false when it did. Only the last case is a real number. */
    if (v.is_min_industry_and_role_yoe_not_mentioned === false) return num(v.min_industry_and_role_yoe);
    return null;
  }

  function daysAgo(millis, now) {
    const ms = num(millis);
    if (ms == null) return null;
    const d = Math.floor(((now || Date.now()) - ms) / 86400000);
    return d < 0 ? 0 : d;
  }

  function list(v) {
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x.trim(); }) : [];
  }

  /* normalise(hit, opts) -> the same job shape the LinkedIn collector produces,
   * so nothing downstream (parse, score, learn, verdict, reasons, vetrun) needs
   * to know where a job came from.
   *
   * opts.description  full text, fetched separately - the search result has none
   * opts.now          injectable clock, so postedDaysAgo is testable
   */
  function normalise(hit, opts) {
    if (!hit || typeof hit !== 'object') return null;
    const o = opts || {};
    const v = hit.v5_processed_job_data || {};
    const info = hit.job_information || {};
    const co = hit.enriched_company_data || {};

    const id = hit.id || hit.objectID;
    if (!id) return null;

    const pay = payOf(v);
    const certs = list(v.licenses_or_certifications);
    const tools = list(v.technical_tools);
    const activities = list(v.role_activities);

    /* The description arrives from a second call. When it is missing, fall back
     * to the summary rather than an empty string - a short description is still
     * worth reading, nothing is not. The structured lists are appended either
     * way, so the JD text filters and whoever reads the export see the
     * certifications and tools even though they never appear in the prose. */
    const body = String(o.description || '').trim();
    const summary = String(v.requirements_summary || '').trim();
    const extras = [];
    if (certs.length) extras.push('Certifications / licences: ' + certs.join(', '));
    if (tools.length) extras.push('Tools and systems: ' + tools.join(', '));
    if (activities.length) extras.push('Role activities: ' + activities.join(', '));

    const description = [body || summary].concat(extras).filter(Boolean).join('\n\n');

    const wpRaw = v.workplace_type || '';

    return {
      jobId: String(id),
      title: info.title || v.core_job_title || '',
      company: v.company_name || co.name || '',
      location: v.formatted_workplace_location || '',
      workplaceType: WORKPLACE[wpRaw] || 'Unknown',
      workplaceRaw: wpRaw || '',

      /* Every hit carried an apply_url in the sample (158/158), and it points
       * at the employer's own board. That is exactly what the panel's
       * resolve-apply pass opens tabs to discover, so those jobs arrive already
       * resolved. */
      applyType: hit.apply_url ? 'external' : 'unknown',
      applyUrl: hit.apply_url || '',
      url: hit.apply_url || '',

      description: description,
      descriptionChars: description.length,
      descriptionSource: body ? 'hiringcafe:full' : (summary ? 'hiringcafe:summary' : 'none'),

      payRaw: pay.raw,
      payMinAnnual: pay.min,
      payMaxAnnual: pay.max,
      paySource: pay.source,

      yoeMin: yoeOf(v),
      travelPct: travelOf(v),

      needsClearance: v.security_clearance ? !/^none$/i.test(String(v.security_clearance)) : null,

      /* Only `true` is trustworthy here. A `false` cannot be told apart from
       * "the posting never mentioned it", and the panel's "hide no-sponsorship"
       * filter drops a job outright on it - so guessing would silently delete
       * valid jobs. Left null, parse.js still reads it off the prose. */
      sponsorshipUnavailable: v.visa_sponsorship === true ? false : null,
      requiresRelocation: null,
      remoteContradiction: false,

      seniority: v.seniority_level || '',
      employmentType: list(v.commitment).join(', '),
      postedRaw: v.estimated_publish_date || '',
      postedDaysAgo: daysAgo(v.estimated_publish_date_millis, o.now),
      applicants: null,
      reposted: false,
      promoted: false,

      /* hiringcafe-specific, kept for filtering and for the manager's readout. */
      source: 'hiringcafe',
      atsSource: hit.source || '',
      boardToken: hit.board_token || '',
      dedupKey: hit.strict_dedup_cluster_id || String(id),
      isExpired: hit.is_expired === true,
      certifications: certs,
      tools: tools,
      companyWebsite: v.company_website || co.homepage_uri || ''
    };
  }

  /* Expired postings are in the index; they must never reach the shortlist. */
  function normaliseAll(hits, opts) {
    return (hits || [])
      .map(function (h) { return normalise(h, opts); })
      .filter(function (j) { return j && !j.isExpired; });
  }

  root.JDC_HIRINGCAFE = {
    BASE: BASE,
    htmlToText: htmlToText,
    decodeEntities: decodeEntities,
    extractNextData: extractNextData,
    pageFrom: pageFrom,
    descriptionFrom: descriptionFrom,
    buildSearchState: buildSearchState,
    locationFor: locationFor,
    searchUrl: searchUrl,
    descriptionUrl: descriptionUrl,
    normalise: normalise,
    normaliseAll: normaliseAll,
    daysFromPosted: daysFromPosted
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.JDC_HIRINGCAFE;
})();
