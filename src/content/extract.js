/* JD Collector - field extraction from the LinkedIn job details pane. */

(function () {
  if (window.JDC_EX) return;
  const S = window.JDC_SEL.SEL;
  const q = window.JDC_SEL.q;
  const qa = window.JDC_SEL.qa;
  const PARSE = window.JDC_PARSE;

  const BLOCK = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'TABLE'
  ]);

  /* innerText is clipped by CSS line-clamp on collapsed descriptions, and
   * textContent throws away all structure. Walk the tree instead so bullets and
   * paragraph breaks survive regardless of collapsed state. */
  function htmlToText(root) {
    if (!root) return '';
    const out = [];

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.nodeValue.replace(/\s+/g, ' ');
        if (t.trim()) out.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;

      if (tag === 'BR') { out.push('\n'); return; }

      // List items get a single leading newline so bullets stay on consecutive
      // lines instead of being double-spaced - meaningful token savings over
      // hundreds of descriptions.
      const isLi = tag === 'LI';
      if (isLi) out.push('\n- ');
      else if (BLOCK.has(tag)) out.push('\n');

      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);

      if (!isLi && BLOCK.has(tag)) out.push('\n');
    }

    walk(root);

    return out
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function text(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /* ---------- parsers for the top-card metadata line ---------- */

  const RE_AGO = /(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago/i;
  const RE_APPLICANTS = /(over\s+)?([\d,]+)\+?\s*(applicant|people clicked apply|people have clicked)/i;
  const RE_WORKPLACE = /^(remote|hybrid|on-?site)$/i;
  const RE_EMPLOYMENT = /^(full-?time|part-?time|contract|temporary|internship|volunteer|other)$/i;
  const RE_SENIORITY = /^(internship|entry level|associate|mid-senior level|director|executive|not applicable)$/i;
  const RE_PAY = /(\$|€|£|₹)\s?[\d,]+(\.\d+)?\s*(k|K)?(\s*\/\s*(yr|year|hr|hour|mo|month))?/;

  function agoToDays(str) {
    const m = RE_AGO.exec(str || '');
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit === 'minute' || unit === 'min' || unit === 'hour' || unit === 'hr') return 0;
    if (unit === 'day') return n;
    if (unit === 'week') return n * 7;
    if (unit === 'month') return n * 30;
    if (unit === 'year') return n * 365;
    return null;
  }

  function parseApplicants(str) {
    const m = RE_APPLICANTS.exec(str || '');
    if (!m) return null;
    return parseInt(m[2].replace(/,/g, ''), 10);
  }

  function normalizeWorkplace(v) {
    if (!v) return '';
    const s = v.toLowerCase().replace(/\s+/g, '');
    if (s === 'remote') return 'Remote';
    if (s === 'hybrid') return 'Hybrid';
    if (s === 'onsite' || s === 'on-site') return 'On-site';
    return '';
  }

  /* ---------- apply type ---------- */

  /* Some LinkedIn variants render an external apply as a plain <a> straight to
   * the employer's ATS. When they do, the real apply URL is free - no click
   * needed. Otherwise it stays empty and the panel can resolve it on demand. */
  function directApplyHref(btn) {
    if (!btn) return '';
    const a = btn.tagName === 'A' ? btn : btn.querySelector('a[href]');
    const href = a && a.getAttribute('href');
    if (!href || /^[#/]/.test(href)) return '';
    try {
      const u = new URL(href, location.href);
      if (/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
      return u.toString();
    } catch (e) {
      return '';
    }
  }

  function detectApplyType(root, exclude) {
    const notice = text(q(S.applyNotice, root)).toLowerCase();
    if (/no longer accepting|closed/.test(notice)) {
      return { applyType: 'closed', applyLabel: text(q(S.applyNotice, root)), applyUrl: '' };
    }

    const btn = q(S.applyButton, root) || window.JDC_SEL.genericApplyButton(root, exclude);
    if (!btn) return { applyType: 'unknown', applyLabel: '', applyUrl: '' };

    const label = (
      text(btn) + ' ' +
      (btn.getAttribute('aria-label') || '')
    ).toLowerCase();

    if (/easy apply/.test(label)) {
      return { applyType: 'easy_apply', applyLabel: text(btn), applyUrl: '' };
    }
    if (/applied/.test(label)) {
      return { applyType: 'applied', applyLabel: text(btn), applyUrl: '' };
    }
    if (/apply/.test(label)) {
      return { applyType: 'external', applyLabel: text(btn), applyUrl: directApplyHref(btn) };
    }
    return { applyType: 'unknown', applyLabel: text(btn), applyUrl: '' };
  }

  /* ---------- top card ---------- */

  function findTopCard(root, titleFallback) {
    const known = q([
      '.job-details-jobs-unified-top-card__container--two-pane',
      '.job-details-jobs-unified-top-card',
      '.jobs-unified-top-card'
    ], root);
    if (known) return known;

    /* The smallest sensible ancestor of the title. `titleFallback` is passed
     * in rather than re-derived: genericTitle needs an element to anchor on,
     * and calling it with nothing here returned null, which left the top card
     * as the whole page. */
    const h1 = q(S.title, root) || titleFallback || null;
    if (!h1) return root;
    let node = h1;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const len = (node.textContent || '').length;
      if (len > 80 && len < 2000) return node;
    }
    return h1.parentElement || root;
  }

  /* ---------- main ---------- */

  /* Known selectors first; otherwise the densest text block outside the job
   * list, so an unfamiliar layout still yields a description. */
  /* Known selectors, then the "About the job" text anchor, then density.
   * The anchor sits in the middle on purpose: it is more precise than the
   * density heuristic (which can swallow the Premium upsell cards that sit
   * beside the description on the AI job search) but less specific than a
   * selector written for a layout we actually recognise. */
  function descriptionEl(root) {
    const known = q(S.description, root || document);
    if (known) return known;

    const SELM = window.JDC_SEL;
    const listRoot = SELM.genericListRootAny();

    /* Both routes are checked the same way before being handed back. The
     * anchor can land on a container that swallows the rail, and the density
     * measure can pick the rail outright - and the rail does not change when
     * you click through it, so that mistake writes the same description onto
     * every job in the run rather than failing. */
    const anchored = SELM.headingAnchoredDescription(listRoot);
    if (SELM.plausibleDescription(anchored, listRoot)) return anchored;

    const dense = SELM.genericDescription(listRoot);
    return SELM.plausibleDescription(dense, listRoot) ? dense : null;
  }

  /* The details pane, so every other field can be read from inside it.
   *
   * `document` used to stand in when no selector named the pane. It is a much
   * worse default than it looks: with the whole page in scope the title came
   * off the rail's alerts banner, the company off a different card, and the
   * pay off whichever pill the page happened to render first - the same figure
   * on every job. Nothing about those rows announced itself as wrong. */
  function paneRoot(root) {
    const known = q(S.detailsRoot, root || document);
    if (known) return known;
    return window.JDC_SEL.genericDetailsRoot(descriptionEl(root)) || root || document;
  }

  /* Known title selectors first, then any heading near the description. On the
   * newer surfaces every named title selector misses. */
  function titleEl(root, pane) {
    return q(S.title, root || document) ||
      window.JDC_SEL.genericTitle(descriptionEl(root), pane || paneRoot(root));
  }

  function extractJob(jobId, cardMeta) {
    return buildJob(jobId, resolveParts(), cardMeta);
  }

  function resolveParts() {
    /* Order matters. The description locates the pane, the pane bounds the
     * title, and the title bounds the top card - so every field below is read
     * from inside this job's own pane rather than from wherever on the page a
     * matching-looking element happens to sit. */
    const descEl = descriptionEl();
    const root = paneRoot();
    const description = htmlToText(descEl);

    /* Captured once so the company fallback can anchor on the SAME element
     * titleEl() resolved, rather than re-deriving it and risking a different
     * answer the second time. */
    const titleElement = titleEl(root, root);
    const title = text(titleElement);

    const topCard = findTopCard(root, titleElement);
    const topText = text(topCard);

    const companyEl = q(S.company, root) ||
      window.JDC_SEL.genericCompany(titleElement || descEl, root);
    const company = window.JDC_SEL.companyText(companyEl);
    const companyUrl = companyEl && companyEl.tagName === 'A' ? companyEl.href : '';

    /* Split the "City · 3 weeks ago · 42 applicants" line into typed parts. */
    let metaLine = [text(q(S.primaryDesc, root)), text(q(S.tertiaryDesc, root))]
      .filter(Boolean)
      .join(' · ');

    /* No named meta line on this layout: find it by shape inside the header,
     * so location, posted age and applicant count are not simply absent - an
     * absent posted date silently disables the posted-within filter. */
    if (!metaLine) metaLine = window.JDC_SEL.genericMetaLine(topCard, descEl);

    const apply = detectApplyType(root);

    const pills = qa(S.pills, root).map(text).filter(Boolean);
    if (!pills.length) {
      /* The description is excluded: a pill is a label in this job's header,
       * never a short line lifted out of the posting's own prose. */
      pills.push.apply(pills, window.JDC_SEL.genericPills(topCard, descEl));
    }

    return {
      description: description,
      title: title,
      company: company,
      companyUrl: companyUrl,
      metaLine: metaLine,
      topText: topText,
      pills: pills,
      apply: apply
    };
  }

  /* Everything downstream of "which element holds which field". Shared by the
   * classic path above and by the AI-search adapter, which finds the same
   * fields in a completely different DOM. */
  function buildJob(jobId, p, cardMeta) {
    const description = p.description || '';
    const title = p.title || '';
    const company = p.company || '';
    const companyUrl = p.companyUrl || '';
    const metaLine = p.metaLine || '';
    const topText = p.topText || '';
    const pills = p.pills || [];
    const apply = p.apply || { applyType: 'unknown', applyLabel: '', applyUrl: '' };

    let location = '';
    let postedRaw = '';
    let applicants = null;
    let workplaceType = '';

    metaLine.split(/\s*[·•]\s*/).forEach(function (partRaw) {
      const part = partRaw.trim();
      if (!part) return;
      if (RE_AGO.test(part)) { if (!postedRaw) postedRaw = part; return; }
      if (RE_APPLICANTS.test(part)) { if (applicants === null) applicants = parseApplicants(part); return; }
      const wp = normalizeWorkplace(part);
      if (wp) { workplaceType = workplaceType || wp; return; }
      if (part === company) return;
      if (!location && part.length < 90) location = part;
    });

    /* Pills carry workplace type, employment type, seniority and pay; they
     * were resolved by whichever adapter produced these parts. */
    let employmentType = '';
    let seniority = '';
    let salary = '';

    pills.forEach(function (p) {
      const clean = p.replace(/\s+/g, ' ').trim();
      const wp = normalizeWorkplace(clean);
      if (wp) { workplaceType = workplaceType || wp; return; }
      if (RE_EMPLOYMENT.test(clean)) { employmentType = employmentType || clean; return; }
      if (RE_SENIORITY.test(clean)) { seniority = seniority || clean; return; }
      if (RE_PAY.test(clean) && clean.length < 60) { salary = salary || clean; return; }
    });

    /* Last resort for workplace type: the word appears as its own token in the
     * top card, or the location string itself says Remote. */
    if (!workplaceType) {
      const m = /\b(remote|hybrid|on-?site)\b/i.exec(topText);
      if (m) workplaceType = normalizeWorkplace(m[1]);
    }
    if (!workplaceType && /\bremote\b/i.test(location)) workplaceType = 'Remote';

    if (!postedRaw) {
      const m = RE_AGO.exec(topText);
      if (m) postedRaw = m[0];
    }
    if (applicants === null) applicants = parseApplicants(topText);

    /* "Reposted 2 weeks ago" is the only reliable repost signal LinkedIn gives. */
    const reposted = /reposted/i.test(metaLine) || /reposted/i.test(topText);

    const meta = cardMeta || {};

    /* Facts that only exist in the prose: comp, years of experience,
     * eligibility gates, travel and onsite expectations. */
    const parsed = PARSE.parseDescription(description);

    /* Comp from the top-card pill is more precise than prose, so prefer it and
     * record which source won. */
    const pillPay = PARSE.parsePay(salary);
    const pay = pillPay.payMin != null ? pillPay : parsed;
    const paySource = pillPay.payMin != null ? 'pill' : (parsed.payMin != null ? 'jd' : '');

    /* A "Remote" pill whose description demands office days is the single most
     * useful contradiction to surface - it is a wasted application otherwise. */
    const remoteContradiction = (workplaceType || '') === 'Remote' &&
      (parsed.notRemote || (parsed.onsiteDaysPerWeek || 0) >= 1);

    return {
      jobId: String(jobId),
      url: 'https://www.linkedin.com/jobs/view/' + jobId + '/',
      title: title,
      company: company,
      companyUrl: companyUrl,
      location: location,
      workplaceType: workplaceType || 'Unknown',
      postedRaw: postedRaw,
      postedDaysAgo: agoToDays(postedRaw),
      reposted: reposted,
      applicants: applicants,
      promoted: !!meta.promoted,
      viewed: !!meta.viewed,
      applyType: apply.applyType,
      applyLabel: apply.applyLabel,
      applyUrl: apply.applyUrl || '',
      applyUrlStatus: apply.applyUrl ? 'from-link' : '',
      employmentType: employmentType,
      seniority: seniority,
      salary: salary,

      /* parsed from the description (or the pill, for pay) */
      payRaw: pay.payRaw,
      payMin: pay.payMin,
      payMax: pay.payMax,
      payPeriod: pay.payPeriod,
      payCurrency: pay.payCurrency,
      payMinAnnual: pay.payMinAnnual,
      payMaxAnnual: pay.payMaxAnnual,
      paySource: paySource,
      yoeMin: parsed.yoeMin,
      yoeMentions: parsed.yoeMentions,
      needsClearance: parsed.needsClearance,
      sponsorshipUnavailable: parsed.sponsorshipUnavailable,
      requiresRelocation: parsed.requiresRelocation,
      notRemote: parsed.notRemote,
      travelPct: parsed.travelPct,
      onsiteDaysPerWeek: parsed.onsiteDaysPerWeek,
      remoteContradiction: remoteContradiction,
      flagSnippets: parsed.flagSnippets,

      description: description,
      descriptionChars: description.length,
      topCardText: topText.slice(0, 400),
      collectedAt: Date.now()
    };
  }

  /* Reads the card itself (before clicking) for signals that only live there. */
  function extractCardMeta(card) {
    const t = text(card);
    return {
      promoted: /\bPromoted\b/.test(t),
      viewed: /\bViewed\b/.test(t),
      cardText: t.slice(0, 300)
    };
  }

  /* Reports which selectors are currently resolving - shown in the panel so a
   * LinkedIn redesign is diagnosable instead of just "0 results". */
  function selectorHealth() {
    const which = window.JDC_SEL.which;
    return {
      list: which(S.list),
      card: which(S.card),
      detailsRoot: which(S.detailsRoot),
      title: which(S.title),
      description: which(S.description),
      applyButton: which(S.applyButton),
      nextPage: which(S.nextPage)
    };
  }

  window.JDC_EX = {
    extractJob: extractJob,
    buildJob: buildJob,
    detectApplyType: detectApplyType,
    paneRoot: paneRoot,
    descriptionEl: descriptionEl,
    titleEl: titleEl,
    extractCardMeta: extractCardMeta,
    htmlToText: htmlToText,
    text: text,
    selectorHealth: selectorHealth,
    agoToDays: agoToDays
  };
})();
