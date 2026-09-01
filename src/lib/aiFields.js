/* JD Collector - the field check: a model reading one job's pane and filling
 * in what the DOM could not.
 *
 * This is the second thing a model is allowed to do here, and it is a bigger
 * step than resolving selectors, so the rule it runs under is narrower:
 *
 *   THE MODEL MAY ONLY REPEAT WHAT IS ON THE PAGE.
 *
 * Every value it returns is checked back against the exact text it was shown.
 * A company name that does not appear in that text is dropped. A pay figure
 * that does not appear is dropped. "Remote" is accepted only if the word is
 * there to be read. What survives is transcription - the model saying which
 * part of the page is the company name, not what the company is.
 *
 * That distinction is the whole licence for this feature. The extension's
 * premise is that every fact it reports can be traced to a sentence in the
 * posting; a model that invents a plausible salary breaks that premise
 * silently and permanently, because nothing downstream can tell an invented
 * $140,000 from a real one. A model that can only point at text cannot.
 *
 * Three further limits, for the same reason:
 *
 *   - It fills GAPS. A field the DOM already read is never overwritten.
 *   - It never touches a judgement. There is no "is this a good job", no
 *     score, no ranking, no fit - those do not become available because a
 *     model is now in the loop.
 *   - Everything it filled is labelled, in the row and in the export, so a
 *     human reading a batch always knows which facts came from a model.
 *
 * Pure: no DOM, no network. Runs in the service worker via importScripts and
 * head-less in tests/aifields.test.js.
 */

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.JDC_AIFIELDS) return;

  /* The fields a model may fill, what it is told each one is, and how each is
   * checked afterwards.
   *
   *   verbatim  the value must appear in the text the model was shown
   *   oneOf     the value must be one of these, exactly
   *   maxLen    a sanity bound; a "company" of 200 characters is a paragraph
   */
  const FIELDS = {
    title: {
      ask: 'the job title, exactly as written',
      verbatim: true, maxLen: 160
    },
    company: {
      ask: 'the employer name, without any follower count or tagline',
      verbatim: true, maxLen: 120
    },
    location: {
      ask: 'the location line, exactly as written',
      verbatim: true, maxLen: 120
    },
    workplaceType: {
      ask: 'one of Remote, Hybrid, On-site - only if the page says so',
      oneOf: ['Remote', 'Hybrid', 'On-site'], verbatim: true
    },
    employmentType: {
      ask: 'one of Full-time, Part-time, Contract, Temporary, Internship, Volunteer, Other',
      oneOf: ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship',
        'Volunteer', 'Other'],
      verbatim: true
    },
    seniority: {
      ask: 'one of Internship, Entry level, Associate, Mid-Senior level, Director, Executive',
      oneOf: ['Internship', 'Entry level', 'Associate', 'Mid-Senior level',
        'Director', 'Executive'],
      verbatim: true
    },
    payText: {
      ask: 'the pay or salary range exactly as written, e.g. "$90K/yr - $120K/yr"',
      verbatim: true, maxLen: 80
    },
    applyRoute: {
      ask: 'easy_apply if the page shows an "Easy Apply" button, external if it ' +
        'shows a plain Apply that goes to the employer, otherwise unknown',
      oneOf: ['easy_apply', 'external', 'unknown']
    }
  };

  const KEYS = Object.keys(FIELDS);

  /* "Easy Apply" is the evidence for easy_apply; a bare "Apply" is the
   * evidence for external. applyRoute is the one field whose value is a token
   * rather than a quotation, so its verbatim check is written out here. */
  const ROUTE_EVIDENCE = {
    easy_apply: /easy\s*apply/i,
    external: /\bapply\b/i,
    unknown: null
  };

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function normLoose(s) {
    return norm(s).toLowerCase();
  }

  function systemPrompt(missing) {
    const wanted = (missing && missing.length ? missing : KEYS);
    const lines = wanted
      .filter(function (k) { return FIELDS[k]; })
      .map(function (k) { return '  "' + k + '": ' + FIELDS[k].ask; });

    return [
      'You are reading the text of ONE job posting page from a job board.',
      '',
      'Return a JSON object with these fields, copying values out of the text:',
      lines.join('\n'),
      '',
      'Rules:',
      '- Copy, do not paraphrase. Every value must appear in the text above,',
      '  character for character. A value that is not in the text is thrown away',
      '  by the caller, so inventing one achieves nothing.',
      '- Use null for anything the text does not state. A missing field is a',
      '  correct answer; a guess is not.',
      '- Do not summarise the job, rate it, or comment on it. You are being asked',
      '  which part of the page holds each field, nothing else.',
      '- Answer with a single JSON object and no other text.'
    ].join('\n');
  }

  function buildMessages(sample, missing) {
    return [
      { role: 'system', content: systemPrompt(missing) },
      { role: 'user', content: 'JOB PAGE TEXT\n\n' + String(sample || '') }
    ];
  }

  /* ---------------- reading the reply ---------------- */

  function parseFields(text) {
    const AIPLAN = root.JDC_AIPLAN;
    const cleaned = AIPLAN ? AIPLAN.stripReasoning(text) : String(text || '');
    const json = AIPLAN ? AIPLAN.firstJsonObject(cleaned) : null;
    if (!json) return { ok: false, error: 'no JSON object in the reply' };

    let obj;
    try {
      obj = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: 'reply was not valid JSON (' + e.message + ')' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'reply was not a JSON object' };
    }

    const out = {};
    KEYS.forEach(function (k) {
      const v = obj[k];
      if (typeof v === 'string' && norm(v)) out[k] = norm(v);
      else if (typeof v === 'number') out[k] = String(v);
    });

    return { ok: true, fields: out };
  }

  /* ---------------- checking it against the page ---------------- */

  /* Returns { accepted, rejected } - and the rejected list carries WHY, which
   * is what makes a bad model visible instead of merely unhelpful. */
  function verify(fields, sample, current) {
    const haystack = normLoose(sample);
    const have = current || {};
    const accepted = {};
    const rejected = [];

    Object.keys(fields || {}).forEach(function (key) {
      const rule = FIELDS[key];
      const value = norm(fields[key]);

      if (!rule) {
        rejected.push({ field: key, value: value, why: 'not a field the model may fill' });
        return;
      }
      if (!value || /^(null|none|n\/a|unknown|not stated)$/i.test(value)) {
        return;   // a declined field is not a rejection, it is an answer
      }

      /* A field the DOM already read is never overwritten. The page is the
       * better source when it has one; this only fills gaps. */
      if (have[key]) {
        rejected.push({ field: key, value: value, why: 'already read from the page' });
        return;
      }

      if (rule.maxLen && value.length > rule.maxLen) {
        rejected.push({ field: key, value: value, why: 'longer than a ' + key + ' can be' });
        return;
      }

      if (rule.oneOf) {
        const match = rule.oneOf.filter(function (o) {
          return o.toLowerCase() === value.toLowerCase();
        })[0];
        if (!match) {
          rejected.push({ field: key, value: value, why: 'not one of ' + rule.oneOf.join('/') });
          return;
        }
        /* The token has to be earned by something on the page. */
        if (key === 'applyRoute') {
          const evidence = ROUTE_EVIDENCE[match];
          if (evidence && !evidence.test(haystack)) {
            rejected.push({ field: key, value: match, why: 'nothing on the page says so' });
            return;
          }
          accepted[key] = match;
          return;
        }
        if (rule.verbatim && haystack.indexOf(match.toLowerCase()) === -1) {
          rejected.push({ field: key, value: match, why: 'the page does not say it' });
          return;
        }
        accepted[key] = match;
        return;
      }

      /* The rule that makes this safe: it has to be ON THE PAGE. */
      if (rule.verbatim && haystack.indexOf(normLoose(value)) === -1) {
        rejected.push({ field: key, value: value, why: 'not found in the page text' });
        return;
      }

      accepted[key] = value;
    });

    return { accepted: accepted, rejected: rejected };
  }

  /* Which fields are worth asking about for this job: the ones the page did
   * not yield. Asking about fields we already have wastes a call and invites
   * an argument the page always wins anyway. */
  function gaps(job) {
    const j = job || {};
    const out = [];

    if (!j.title) out.push('title');
    if (!j.company) out.push('company');
    if (!j.location) out.push('location');
    if (!j.workplaceType || j.workplaceType === 'Unknown') out.push('workplaceType');
    if (!j.employmentType) out.push('employmentType');
    if (!j.seniority) out.push('seniority');
    if (j.payMinAnnual == null && !j.payRaw) out.push('payText');
    if (!j.applyType || j.applyType === 'unknown') out.push('applyRoute');

    return out;
  }

  /* What the model may see: the header, and enough of the posting to carry the
   * pay and employment lines - not the whole thing. Job text does leave the
   * browser here, which is exactly why there is a cap on how much. */
  function sampleFor(header, description, maxChars) {
    const cap = maxChars || 4000;
    const head = norm(header);
    const body = norm(description);
    const room = Math.max(0, cap - head.length - 2);
    return (head + '\n\n' + body.slice(0, room)).trim();
  }

  root.JDC_AIFIELDS = {
    FIELDS: FIELDS,
    KEYS: KEYS,
    systemPrompt: systemPrompt,
    buildMessages: buildMessages,
    parseFields: parseFields,
    verify: verify,
    gaps: gaps,
    sampleFor: sampleFor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.JDC_AIFIELDS;
})();
