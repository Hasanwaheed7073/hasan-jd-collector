/* JD Collector - the adapter for LinkedIn's AI job search.
 *
 * A SEPARATE adapter, not another layer of fallbacks on the classic one. The
 * two surfaces disagree about nearly everything that matters - what a card is,
 * where a job id lives, whether the list is even fully mounted - and every
 * attempt so far to make one code path serve both produced rows that looked
 * collected and were not. The classic collector is untouched by this file.
 *
 * WHERE THESE SELECTORS COME FROM. Everything in KNOWN below was read off the
 * live page and reported directly; nothing here is a guess at markup nobody
 * has looked at. The structural rules under it (the description under its
 * heading, the header region around the selected link) are shape-based on
 * purpose, because this surface's class names are build hashes that rotate on
 * every deploy - `div.cc5d114c`, `ul.a5b65bc4` - and are worthless to key on.
 *
 *   route            /jobs/search-results/
 *   list container   [data-testid="lazy-column"][componentkey="SearchResultsMainContent"]
 *   card             [role="button"][componentkey^="job-card-component-ref-"]
 *   job id           the digits in componentkey, e.g. job-card-component-ref-4401002774
 *   selected job     the ONLY a[href*="/jobs/view/"] on the page
 *   description      the container of the h2 whose text is "About the job"
 *
 * Two consequences of that shape drive the whole design.
 *
 * A card carries its own id in `componentkey` but NOT a link to its job: only
 * the selected card exposes /jobs/view/{id}. So ids are enumerated from the
 * cards, and the selection is confirmed against the URL or that one link after
 * each click - never inferred from the card's own href, which does not exist.
 *
 * The list is virtualised: cards unmount as they scroll out of view. Holding
 * element references across a click is therefore a bug waiting to happen, so
 * every card is re-found by its componentkey at the moment it is needed, and
 * the run collects as it scrolls rather than enumerating the list up front.
 */

(function () {
  if (window.JDC_AISEARCH) return;

  const SELM = window.JDC_SEL;
  const EX = window.JDC_EX;

  /* Read off the live page. Change these only against a fresh diagnostic. */
  const KNOWN = {
    route: /^\/jobs\/search-results(\/|$)/,
    list: '[data-testid="lazy-column"][componentkey="SearchResultsMainContent"]',
    listLoose: '[data-testid="lazy-column"]',
    card: '[role="button"][componentkey^="job-card-component-ref-"]',
    cardKey: /job-card-component-ref-(\d+)/,
    selectedLink: 'a[href*="/jobs/view/"]',
    descHeading: /^about the job$/i
  };

  function text(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /* ---------------- route and applicability ---------------- */

  function onRoute() {
    return KNOWN.route.test(location.pathname);
  }

  /* The route alone is not enough to hand a run to this adapter: LinkedIn can
   * serve the classic two-pane layout under a new path, and this adapter would
   * then find nothing and report an empty page as fact. Both have to agree. */
  function applies() {
    return onRoute() && cards().length > 0;
  }

  /* ---------------- the list ---------------- */

  function listContainer() {
    return document.querySelector(KNOWN.list) ||
      document.querySelector(KNOWN.listLoose);
  }

  /* The element that actually scrolls. The lazy column is usually it, but the
   * overflow can sit on a parent - and scrolling the wrong node is why the
   * classic loader only ever mounted the first screenful here: it scrolled the
   * document, which does not move. */
  function scrollContainer() {
    let node = listContainer();
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 40) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|overlay)/.test(style.overflowY)) return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function cards(root) {
    const scope = root || listContainer() || document;
    return Array.prototype.slice.call(scope.querySelectorAll(KNOWN.card));
  }

  function cardId(el) {
    if (!el || !el.getAttribute) return null;
    const m = KNOWN.cardKey.exec(el.getAttribute('componentkey') || '');
    return m ? m[1] : null;
  }

  function cardById(id) {
    return document.querySelector('[componentkey="job-card-component-ref-' + id + '"]');
  }

  /* Every id currently mounted, in list order. */
  function mountedIds() {
    const out = [];
    const seen = Object.create(null);
    cards().forEach(function (el) {
      const id = cardId(el);
      if (id && !seen[id]) { seen[id] = 1; out.push(id); }
    });
    return out;
  }

  /* ---------------- the selected job ---------------- */

  /* The one /jobs/view/ link on the page belongs to whichever job the details
   * pane is showing. It is both the selection signal and, per the live page,
   * where the title text lives. */
  function selectedLink() {
    const links = document.querySelectorAll(KNOWN.selectedLink);
    for (let i = 0; i < links.length; i++) {
      if (SELM.jobIdFromHref(links[i].getAttribute('href') || '')) return links[i];
    }
    return null;
  }

  function selectedJobId() {
    const link = selectedLink();
    if (link) {
      const id = SELM.jobIdFromHref(link.getAttribute('href') || '');
      if (id) return id;
    }
    const fromUrl = new URL(location.href).searchParams.get('currentJobId');
    return fromUrl || null;
  }

  /* Confirmed two ways because either can lag: the URL is rewritten on click
   * before the pane repaints, and the pane can repaint before the URL settles.
   * Agreement from either is enough; agreement from neither is not. */
  function showsJob(id) {
    const wanted = String(id);
    if (new URL(location.href).searchParams.get('currentJobId') === wanted) return true;
    const link = selectedLink();
    return !!(link && SELM.jobIdFromHref(link.getAttribute('href') || '') === wanted);
  }

  /* ---------------- fields ---------------- */

  /* The heading is the anchor, and it must be a real heading with this exact
   * text - not the loose div/span match the generic layer allows, which on
   * this page also hits an accessibility-only copy of the same words. */
  /* Exact match first, then looser ones. A run collected eleven jobs and then
   * failed the next fourteen with an empty description while a full posting
   * sat on screen - and an exact-match heading is a single point of failure
   * for the whole extractor, so it is no longer the only way in. A heading
   * that gains a suffix, or an "About this job", now costs nothing. */
  const HEADING_PATTERNS = [
    { re: /^about the job$/i, via: 'h2 "About the job"' },
    { re: /^about (?:the|this) (?:job|role|position)\b/i, via: 'heading, about-the-job family' },
    { re: /^(?:job|role|position) description$/i, via: 'heading, job-description' },
    { re: /^description$/i, via: 'heading, description' }
  ];

  function findHeading() {
    const heads = document.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
    for (let p = 0; p < HEADING_PATTERNS.length; p++) {
      for (let i = 0; i < heads.length; i++) {
        const t = text(heads[i]);
        if (t.length <= 60 && HEADING_PATTERNS[p].re.test(t)) {
          return { el: heads[i], via: HEADING_PATTERNS[p].via };
        }
      }
    }
    return null;
  }

  function descriptionHeading() {
    const h = findHeading();
    return h ? h.el : null;
  }

  /* The posting is what sits under that heading. Its siblings first, because
   * that is the common shape; failing that the heading's parent, with the
   * heading's own text discounted so a bare wrapper cannot qualify on the
   * label alone. */
  const DESC_MIN_CHARS = 100;

  /* Returns { el, via } so the log can say WHICH route found the posting, or
   * null with nothing found.
   *
   * The heading's siblings are checked first because that is the common shape.
   * On the live page they are empty: the h2 is alone inside its own wrapper,
   * and the posting hangs off the wrapper's PARENT - which is why the first
   * version of this function returned null on every job, and why every job
   * was marked Failed with a full description sitting on screen. So the walk
   * continues outward instead of stopping one level up.
   *
   * Each ancestor is judged on the text it adds BEYOND the heading, so a
   * wrapper that holds nothing but the label cannot qualify, and the walk is
   * bounded and refuses anything that reaches the results list. */
  function findDescription() {
    const heading = findHeading();

    if (heading) {
      const h = heading.el;

      let el = h.nextElementSibling;
      while (el) {
        if (text(el).length >= DESC_MIN_CHARS) {
          return { el: el, via: heading.via + ', sibling' };
        }
        el = el.nextElementSibling;
      }

      const list = listContainer();
      const headingChars = text(h).length;
      let node = h.parentElement;

      for (let depth = 1; depth <= 4 && node && node !== document.body; depth++) {
        if (list && (node === list || node.contains(list))) break;
        if (text(node).length - headingChars >= DESC_MIN_CHARS) {
          return { el: node, via: heading.via + ', ancestor +' + depth };
        }
        node = node.parentElement;
      }
    }

    /* No heading, or a heading with nothing under it. The posting is still the
     * largest block of prose in the pane that is neither the header nor the
     * results list - which is measurable without any heading at all. This
     * layer exists because fourteen jobs in one run failed with an empty
     * description while the posting was plainly on screen: whatever the
     * heading was doing at that moment, the text was there to be read. */
    return byBulk();
  }

  /* The biggest text block in the pane, excluding the header and anything
   * holding job links. Deliberately last: it is a measurement, not a landmark,
   * and a landmark is preferable when one exists. */
  function byBulk() {
    const pane = paneRoot();
    if (!pane) return null;

    /* The header is excluded by the one thing that defines it - it holds the
     * job's own /jobs/view/ link - rather than by asking headerRegion(), which
     * asks for the description, which is what this function is trying to
     * work out. That cycle was a stack overflow, not a subtlety. */
    const link = selectedLink();
    const nodes = pane.querySelectorAll('div, section, article');
    let best = null;
    let bestLen = 0;

    for (let i = 0; i < nodes.length && i < 3000; i++) {
      const el = nodes[i];
      if (link && (el === link || el.contains(link))) continue;
      if (!SELM.plausibleDescription(el, listContainer())) continue;
      const len = text(el).length;
      if (len > bestLen) { best = el; bestLen = len; }
    }

    if (!best || bestLen < DESC_MIN_CHARS) return null;

    /* Prefer the tightest element still holding essentially all of that text,
     * so the answer is the posting rather than the pane around it. */
    let node = best;
    for (let i = 0; i < 4; i++) {
      let only = null;
      for (let k = 0; k < node.children.length; k++) {
        if (text(node.children[k]).length >= bestLen * 0.9) { only = node.children[k]; break; }
      }
      if (!only) break;
      node = only;
    }
    return { el: node, via: 'largest block in the pane (no heading)' };
  }

  /* The details pane: the smallest thing holding BOTH the selected job's link
   * and its description. The header region alone is far too small - it came
   * back as 194 characters on a live page, which is why the Apply control kept
   * coming out "unknown": it simply was not inside. */
  function paneRoot() {
    const link = selectedLink();
    const list = listContainer();

    if (!link) return null;

    /* Anchored on the HEADING, not on the description - asking for the
     * description here would be circular, since finding it is what the pane
     * is needed for. */
    const h = descriptionHeading();
    let node = link.parentElement;
    let widest = node;

    for (let i = 0; i < 12 && node && node !== document.body; i++) {
      if (list && (node === list || node.contains(list))) break;
      widest = node;
      if (h && node.contains(h)) return node;   // smallest block holding both
      node = node.parentElement;
    }
    /* No heading to bound it: the widest block short of the results rail. */
    return widest;
  }

  function descriptionEl() {
    const found = findDescription();
    return found ? found.el : null;
  }

  /* The posting as text, with the label the container carries stripped off -
   * "About the job" is the heading, not the first line of the job. */
  function descriptionText() {
    const el = descriptionEl();
    if (!el) return '';
    return EX.htmlToText(el).replace(/^\s*about the job\s*/i, '').trim();
  }

  /* The block around the selected job's link: title, company, location, pills
   * and the apply control all live in it. Found by widening from the link
   * until the block is substantial but still smaller than the whole pane, and
   * never far enough to swallow the results list. */
  function headerRegion() {
    const link = selectedLink();
    if (!link) return null;

    const list = listContainer();
    /* The header sits above the posting, never around it. Without this the
     * walk widens to the whole pane on any job whose description is short,
     * and then the pills, the meta line and the company are all being read
     * out of the posting's own prose. */
    const desc = descriptionEl();

    let node = link.parentElement;
    let best = link.parentElement;

    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      if (list && (node.contains(list) || node === list)) break;
      if (desc && (node.contains(desc) || node === desc)) break;
      const len = text(node).length;
      if (len > 2000) break;
      if (len >= 40) best = node;
      node = node.parentElement;
    }
    return best;
  }

  function titleEl() {
    return selectedLink();
  }

  function companyEl() {
    const region = headerRegion();
    if (!region) return null;
    const list = listContainer();
    const links = region.querySelectorAll('a[href*="/company/"]');
    for (let i = 0; i < links.length; i++) {
      if (list && list.contains(links[i])) continue;
      if (SELM.companyText(links[i]).length) return links[i];
    }
    return null;
  }

  /* ---------------- one job ---------------- */

  /* The gate. Nothing is extracted, and nothing is saved, until all three
   * hold: the selected link exists, it is THIS job's link, and there is a
   * description worth the name.
   *
   * The href test is done by parsing the id out rather than by substring, so
   * that a link written without the trailing slash - /jobs/view/123?x - is not
   * read as a mismatch. Same condition, one fewer way to fail spuriously; the
   * raw href is reported either way so a real mismatch is visible.
   *
   * It returns the reasons, never a bare false. A validator that cannot say
   * what was missing is how every job on this surface came to be marked
   * "Failed" with a full posting on screen. */
  function validate(jobId, p) {
    const wanted = String(jobId);
    const link = selectedLink();
    const href = link ? link.getAttribute('href') : null;
    const linkId = href ? SELM.jobIdFromHref(href) : null;
    const description = (p && p.description) || '';
    const missing = [];

    if (!link) missing.push('titleLink');
    else if (linkId !== wanted) missing.push('titleLink.href names ' + linkId + ', not ' + wanted);
    if (!(p && p.title)) missing.push('title');
    if (description.length <= DESC_MIN_CHARS) {
      missing.push('description>' + DESC_MIN_CHARS + ' (got ' + description.length + ')');
    }

    return {
      ok: missing.length === 0,
      missing: missing,
      href: href,
      linkId: linkId,
      headingFound: !!descriptionHeading()
    };
  }

  /* Field lengths, never field contents - a log line is not the place for
   * 4,800 characters of someone's job posting. */
  function lengths(p) {
    return {
      titleLength: (p.title || '').length,
      companyLength: (p.company || '').length,
      locationLength: (p.metaLine || '').length,
      descriptionLength: (p.description || '').length,
      pillCount: (p.pills || []).length
    };
  }

  /* The apply route, which came back "unknown" on jobs that plainly showed a
   * blue Apply button or an Easy Apply one.
   *
   * Three things had to be true at once and only one usually was:
   *
   *   - the control has to be IN SCOPE. Scoped to the header region it never
   *     was: that came back as 194 characters on a live page, and the Apply
   *     control sits below it. So: the pane, then the document.
   *   - the rail has to be OUT of scope. Cards carry their own "Easy Apply"
   *     badge, so a document-wide search reports some other job's route as
   *     this one's. Hence the explicit exclusion.
   *   - and when no button matches at all, the words "Easy Apply" sitting in
   *     this job's pane are still a fact about this job. */
  function easyApplyTextIn(scope) {
    if (!scope) return false;
    const list = listContainer();
    const nodes = scope.querySelectorAll('span, div, button, a, p, li');
    for (let i = 0; i < nodes.length && i < 2000; i++) {
      const el = nodes[i];
      if (list && list.contains(el)) continue;
      const t = text(el);
      if (t.length <= 20 && /^easy apply$/i.test(t)) return true;
    }
    return false;
  }

  function applyInfo() {
    const list = listContainer();
    const pane = paneRoot();

    let info = EX.detectApplyType(pane || document, list);
    if (info.applyType === 'unknown' && pane) {
      /* Not in the pane: some layouts float the action bar outside it. The
       * rail stays excluded, so this cannot pick up a card's badge. */
      info = EX.detectApplyType(document, list);
    }
    if (info.applyType === 'unknown' && easyApplyTextIn(pane || document)) {
      info = { applyType: 'easy_apply', applyLabel: 'Easy Apply', applyUrl: '' };
    }
    return info;
  }

  function parts() {
    const descEl = descriptionEl();
    const region = headerRegion();

    const titleElement = titleEl();
    const company = companyEl();

    /* Pills and the meta line come from the header region only, with the
     * description excluded - the same rule the classic path follows, for the
     * same reason: a pill scanned from anywhere else belongs to another job. */
    const pills = region ? SELM.genericPills(region, descEl) : [];
    const metaLine = region ? SELM.genericMetaLine(region, descEl) : '';
    /* Scoped to the PANE, not the header region: the Apply control sits
     * below the title block, so a 194-character header never contained it and
     * every job came back applyType 'unknown'. The pane still excludes the
     * results rail, so this cannot pick up another card's button. */
    const apply = applyInfo();

    return {
      description: descriptionText(),
      title: text(titleElement),
      company: SELM.companyText(company),
      companyUrl: company ? company.href : '',
      metaLine: metaLine,
      topText: text(region),
      pills: pills,
      apply: apply
    };
  }

  function extract(jobId, cardMeta) {
    return EX.buildJob(jobId, parts(), cardMeta);
  }

  /* ---------------- diagnostics ---------------- */

  function report() {
    const lines = [];
    const list = listContainer();
    const scroller = scrollContainer();

    lines.push('AI JOB SEARCH ADAPTER');
    lines.push('  route matches:      ' + onRoute() + '  (' + location.pathname + ')');
    lines.push('  adapter applies:    ' + applies());
    lines.push('  list container:     ' + (list ? list.tagName.toLowerCase() +
      '[componentkey="' + (list.getAttribute('componentkey') || '') + '"]' : 'NOT FOUND'));
    lines.push('  scroll container:   ' + (scroller === document.scrollingElement
      ? 'the document (the list may not be the scrolling element)'
      : scroller.tagName.toLowerCase() + ' ' + scroller.scrollHeight + 'px'));
    lines.push('  cards mounted now:  ' + cards().length);
    lines.push('  ids readable:       ' + mountedIds().length);
    lines.push('  first ids:          ' + mountedIds().slice(0, 5).join(', '));
    lines.push('  selected job id:    ' + (selectedJobId() || 'none'));
    lines.push('  selected job link:  ' + (selectedLink()
      ? selectedLink().getAttribute('href') : 'NOT FOUND'));
    lines.push('  "About the job":    ' + (descriptionHeading() ? 'found' : 'NOT FOUND'));

    const found = findDescription();
    lines.push('  description:        ' + (found
      ? found.el.tagName.toLowerCase() + ', ' + descriptionText().length +
        ' chars, via ' + found.via
      : 'NOT FOUND'));

    const region = headerRegion();
    lines.push('  pane root:          ' + (paneRoot()
      ? paneRoot().tagName.toLowerCase() + ', ' + text(paneRoot()).length + ' chars'
      : 'NOT FOUND'));
    lines.push('  apply control:      ' + (function () {
      const b = SELM.genericApplyButton(paneRoot() || document, listContainer());
      const t = applyInfo();
      return (b ? (b.tagName.toLowerCase() + ' "' + text(b).slice(0, 30) + '"') : 'no button matched') +
        '  -> ' + t.applyType + (t.applyUrl ? ' ' + t.applyUrl.slice(0, 50) : '');
    })());
    lines.push('  header region:      ' + (region
      ? region.tagName.toLowerCase() + ', ' + text(region).length + ' chars' : 'NOT FOUND'));
    lines.push('  company:            ' + (companyEl() ? SELM.companyText(companyEl()) : 'NOT FOUND'));
    lines.push('  title:              ' + (titleEl() ? text(titleEl()) : 'NOT FOUND'));
    return lines.join('\n');
  }

  window.JDC_AISEARCH = {
    KNOWN: KNOWN,
    onRoute: onRoute,
    applies: applies,
    listContainer: listContainer,
    scrollContainer: scrollContainer,
    cards: cards,
    cardId: cardId,
    cardById: cardById,
    mountedIds: mountedIds,
    selectedLink: selectedLink,
    selectedJobId: selectedJobId,
    showsJob: showsJob,
    descriptionHeading: descriptionHeading,
    findHeading: findHeading,
    paneRoot: paneRoot,
    byBulk: byBulk,
    descriptionEl: descriptionEl,
    findDescription: findDescription,
    descriptionText: descriptionText,
    validate: validate,
    lengths: lengths,
    DESC_MIN_CHARS: DESC_MIN_CHARS,
    headerRegion: headerRegion,
    titleEl: titleEl,
    companyEl: companyEl,
    applyInfo: applyInfo,
    easyApplyTextIn: easyApplyTextIn,
    parts: parts,
    extract: extract,
    report: report
  };
})();
