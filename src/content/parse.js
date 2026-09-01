/* JD Collector - text parsers for facts that only live in the description prose.
 *
 * Pure string functions, no DOM. Every parser is built to fail closed: when a
 * signal is ambiguous it returns null rather than a guess, because a wrong
 * number silently drops a good job out of a filter.
 */

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.JDC_PARSE) return;

  /* ================= shared ================= */

  const WRITTEN = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
  };

  function num(v) {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (WRITTEN[s] != null) return WRITTEN[s];
    const n = parseFloat(s.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  function snippet(text, start, end, pad) {
    pad = pad || 40;
    return text
      .slice(Math.max(0, start - pad), Math.min(text.length, end + pad))
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ================= compensation ================= */

  const CURRENCY_CODES = 'USD|CAD|AUD|NZD|EUR|GBP|INR|SGD|CHF';

  const MONEY_RE = new RegExp(
    '(?:(' + CURRENCY_CODES + ')\\s*)?' +                 // 1 currency code
    '([$€£₹])?' +                          // 2 currency symbol
    '\\s?' +
    '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d{1,2})?)' +       // 3 amount
    '\\s*(k|K)?',                                         // 4 thousands suffix
    'g'
  );

  const PERIOD_RE = /\b(annually|annualized|annum|yearly|year|yr|hourly|hour|hr|monthly|month|mo|weekly|week|wk|daily|day)\b/i;

  const PERIOD_MAP = {
    annually: 'year', annualized: 'year', annum: 'year', yearly: 'year', year: 'year', yr: 'year',
    hourly: 'hour', hour: 'hour', hr: 'hour',
    monthly: 'month', month: 'month', mo: 'month',
    weekly: 'week', week: 'week', wk: 'week',
    daily: 'day', day: 'day'
  };

  const PER_YEAR = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

  const PAY_CUE = /salary|salaries|compensation|pay range|pay rate|base pay|base salary|hourly rate|rate of pay|remuneration|total rewards|total compensation|annual(?:ized)? (?:pay|rate)|per year|per hour|\/\s*yr|\/\s*hr|expected pay|target pay|pay band|wage/i;

  /* Numbers that look like money but are not this job's pay. */
  const NOT_PAY_AFTER = /^\s*(?:million|billion|bn\b|mm\b)/i;
  const NOT_PAY_CONTEXT = /revenue|funding|raised|valuation|market cap|budget of|assets under|in sales|grant|award of|deductible|premium of|401\s*\(?k\)?|copay/i;

  function annualize(value, period) {
    if (value == null || !period || !PER_YEAR[period]) return null;
    return Math.round(value * PER_YEAR[period]);
  }

  function plausible(value, period) {
    if (value == null) return false;
    if (period === 'hour') return value >= 7 && value <= 500;
    if (period === 'day') return value >= 50 && value <= 5000;
    const annual = annualize(value, period);
    return annual != null && annual >= 10000 && annual <= 2000000;
  }

  function scanMoney(text) {
    const out = [];
    MONEY_RE.lastIndex = 0;
    let m;
    while ((m = MONEY_RE.exec(text)) !== null) {
      if (m[0].length === 0) { MONEY_RE.lastIndex++; continue; }

      const code = m[1] || '';
      const sym = m[2] || '';
      const raw = m[3];
      const k = !!m[4];
      const commaGrouped = /,/.test(raw);

      // Without a currency marker a bare number is almost always not pay.
      // Comma-grouped numbers are allowed only when a pay cue is nearby.
      if (!sym && !code && !k && !commaGrouped) continue;

      let value = parseFloat(raw.replace(/,/g, ''));
      if (isNaN(value)) continue;
      if (k) value *= 1000;

      out.push({
        start: m.index,
        end: m.index + m[0].length,
        value: value,
        sym: sym,
        code: code,
        marked: !!(sym || code || k),
        commaGrouped: commaGrouped,
        raw: m[0].trim()
      });
    }
    return out;
  }

  function parsePay(text) {
    const empty = {
      payRaw: '', payMin: null, payMax: null, payPeriod: '',
      payCurrency: '', payMinAnnual: null, payMaxAnnual: null
    };
    if (!text) return empty;

    const tokens = scanMoney(text);
    let best = null;

    for (let i = 0; i < tokens.length; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];

      /* "$120,000 - $150,000", "$120K to $150K", and LinkedIn's own pill format
       * "$110,000/yr - $135,000/yr", where the unit sits inside the separator. */
      let isRange = false;
      if (b && b.start - a.end <= 20 &&
          /^\s*(?:\/?\s*(?:yr|year|hr|hour|mo|month|wk|week|day)\s*)?(?:-|–|—|to|through|up to)\s*$/i
            .test(text.slice(a.end, b.start))) {
        isRange = true;
      }

      const tail = isRange ? b.end : a.end;
      const after = text.slice(tail, tail + 30);
      if (NOT_PAY_AFTER.test(after)) continue;

      /* Disqualifying words only count when they sit right against this number.
       * A wide window would veto a genuine salary range merely because the
       * benefits sentence ("...and a 401(k) match") follows it, which is how
       * almost every real posting is written. */
      const veto = text.slice(Math.max(0, a.start - 45), tail + 30);
      if (NOT_PAY_CONTEXT.test(veto)) continue;

      // Positive cues, by contrast, are worth looking further afield for.
      const context = text.slice(Math.max(0, a.start - 160), tail + 90);
      const hasCue = PAY_CUE.test(context);
      if (!a.marked && !hasCue) continue; // comma-grouped number with no cue

      const pm = PERIOD_RE.exec(after);
      let period = pm ? PERIOD_MAP[pm[1].toLowerCase()] : '';
      const explicitPeriod = !!period;

      // No stated period: infer from magnitude, and refuse the ambiguous middle.
      if (!period) {
        const probe = isRange ? Math.max(a.value, b.value) : a.value;
        if (probe >= 1000) period = 'year';
        else if (probe <= 200) period = 'hour';
        else continue;
      }

      const lo = isRange ? Math.min(a.value, b.value) : a.value;
      const hi = isRange ? Math.max(a.value, b.value) : null;
      if (!plausible(lo, period)) continue;
      if (hi != null && !plausible(hi, period)) continue;

      let score = 0;
      if (hasCue) score += 3;
      if (isRange) score += 2;
      if (explicitPeriod) score += 1;
      if (a.sym || a.code) score += 1;

      if (!best || score > best.score) {
        best = {
          score: score,
          min: lo,
          max: hi,
          period: period,
          currency: a.code || a.sym || '',
          raw: text.slice(a.start, pm ? tail + pm.index + pm[1].length : tail).replace(/\s+/g, ' ').trim()
        };
      }
    }

    if (!best) return empty;

    return {
      payRaw: best.raw,
      payMin: best.min,
      payMax: best.max,
      payPeriod: best.period,
      payCurrency: best.currency,
      payMinAnnual: annualize(best.min, best.period),
      payMaxAnnual: annualize(best.max, best.period)
    };
  }

  /* ================= years of experience ================= */

  // Group 1 = floor, group 2 = the "+"/"plus" marker, group 3 = range ceiling.
  const YOE_NUMERIC = /(\d{1,2})\s*(\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2})\s*(?:\+|plus)?\s*)?(?:years?|yrs?\.?)\b/gi;
  const YOE_WRITTEN = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s*(?:\(\s*\d{1,2}\s*\)\s*)?(?:years?|yrs?\.?)\b/gi;

  const YOE_CUE = /experien|background|track record|proven|worked|working|expertise|tenure|minimum of|at least|required|requirement|qualif/i;

  /* "3+ years of independent monitoring" is a requirement with none of the cue
   * words above, and that phrasing is everywhere in real postings. A trailing
   * "of"/"in" (naming the domain) is itself the requirement signal. */
  const YOE_QUALIFIER = /^\s*(?:of|in|as|with|within|working|doing|supporting|managing|monitoring)\b/i;

  const YOE_REJECT = /over the (?:past|last)|(?:past|last|next|coming) (?:\d{1,2}|few|several) years?|in business|founded|anniversary|history|age of|older than|within \d{1,2} years|every \d{1,2} years/i;

  function collectYoe(text, re) {
    const found = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }

      const start = m.index;
      const end = m.index + m[0].length;
      const context = text.slice(Math.max(0, start - 70), end + 100);

      if (YOE_REJECT.test(context)) continue;

      const hasPlus = !!m[2];
      const qualified = YOE_QUALIFIER.test(text.slice(end, end + 20));
      if (!hasPlus && !qualified && !YOE_CUE.test(context)) continue;

      // A range ("3-5 years") states its floor as the requirement.
      const floor = num(m[1]);
      if (floor == null || floor < 0 || floor > 25) continue;

      found.push({ years: floor, snippet: snippet(text, start, end, 45) });
    }
    return found;
  }

  function parseYoe(text) {
    if (!text) return { yoeMin: null, yoeMentions: [] };

    const mentions = collectYoe(text, YOE_NUMERIC)
      .concat(collectYoe(text, YOE_WRITTEN));

    if (!mentions.length) return { yoeMin: null, yoeMentions: [] };

    // Several requirements can be stated at once ("3+ years in research,
    // 5+ years monitoring"). The binding constraint is the largest of them.
    const yoeMin = mentions.reduce((n, m) => Math.max(n, m.years), 0);

    return { yoeMin: yoeMin, yoeMentions: mentions.slice(0, 6) };
  }

  /* ================= eligibility, travel, onsite ================= */

  const FLAG_PATTERNS = {
    needsClearance: /\b(?:security clearance|active clearance|ts\s*\/\s*sci|top secret|secret clearance|public trust|dod clearance|clearance (?:is )?required)\b/i,
    sponsorshipUnavailable: /\b(?:no sponsorship|not (?:able to )?sponsor|cannot sponsor|unable to sponsor|without (?:the need for )?sponsorship|do(?:es)? not (?:offer|provide) sponsorship|must be (?:a )?u\.?s\.?\s*citizen|u\.?s\.?\s*citizenship (?:is )?required|citizenship (?:is )?required|green card holder)\b/i,
    requiresRelocation: /\b(?:must relocate|required to relocate|relocation (?:is )?required|willing(?:ness)? to relocate|able to relocate)\b/i,
    notRemote: /\b(?:not a remote (?:position|role|job)|this (?:position|role) is not remote|no remote work|remote work is not (?:available|an option)|fully on-?site|100%\s*on-?site|must (?:work )?(?:on-?site|in (?:the )?office))\b/i
  };

  const TRAVEL_RES = [
    /travel[^.\n]{0,60}?(\d{1,3})\s*%/gi,
    /(\d{1,3})\s*%[^.\n]{0,40}?travel/gi
  ];

  const ONSITE_RES = [
    /(\d|one|two|three|four|five)\s*(?:-\s*\d\s*)?days?\s*(?:per|a|each|\/)\s*week[^.\n]{0,45}?(?:office|on-?site|onsite|in person|in-person|hq)/gi,
    /(?:office|on-?site|onsite|in person|in-person|hq)[^.\n]{0,45}?(\d|one|two|three|four|five)\s*days?\s*(?:per|a|each|\/)\s*week/gi
  ];

  function maxFromPatterns(text, regexes, cap) {
    let best = null;
    for (const re of regexes) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const n = num(m[1]);
        if (n == null || n < 0 || n > cap) continue;
        if (best == null || n > best) best = n;
      }
    }
    return best;
  }

  function parseFlags(text) {
    const out = {
      needsClearance: false,
      sponsorshipUnavailable: false,
      requiresRelocation: false,
      notRemote: false,
      travelPct: null,
      onsiteDaysPerWeek: null,
      flagSnippets: {}
    };
    if (!text) return out;

    Object.keys(FLAG_PATTERNS).forEach((key) => {
      const m = FLAG_PATTERNS[key].exec(text);
      if (m) {
        out[key] = true;
        out.flagSnippets[key] = snippet(text, m.index, m.index + m[0].length, 45);
      }
    });

    out.travelPct = maxFromPatterns(text, TRAVEL_RES, 100);
    out.onsiteDaysPerWeek = maxFromPatterns(text, ONSITE_RES, 7);

    return out;
  }

  /* ================= combined ================= */

  function parseDescription(text) {
    const pay = parsePay(text);
    const yoe = parseYoe(text);
    const flags = parseFlags(text);
    return Object.assign({}, pay, yoe, flags);
  }

  root.JDC_PARSE = {
    parsePay: parsePay,
    parseYoe: parseYoe,
    parseFlags: parseFlags,
    parseDescription: parseDescription,
    annualize: annualize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.JDC_PARSE;
})();
