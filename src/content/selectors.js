/* JD Collector - selector layer.
 *
 * LinkedIn renames its CSS classes regularly, so every target is a *list* of
 * candidate selectors tried in order (newest layout first). When LinkedIn ships
 * a redesign, this is the only file that should need editing.
 */

(function () {
  if (window.JDC_SEL) return;

  const SEL = {
    /* the <ul> holding the job cards in the left rail */
    list: [
      'div.scaffold-layout__list > div > ul',
      'div.scaffold-layout__list ul.semantic-search-results-list',
      'ul.scaffold-layout__list-container',
      '.jobs-search-results-list ul',
      '.jobs-search__results-list',
      'div[data-results-list-top-scroll-sentinel] + ul'
    ],

    /* one job card */
    card: [
      'li[data-occludable-job-id]',
      'li.scaffold-layout__list-item',
      'li.jobs-search-results__list-item',
      'div.job-card-container',
      'li div[data-job-id]'
    ],

    /* clickable target inside a card */
    cardLink: [
      'a.job-card-container__link',
      'a.job-card-list__title',
      'a.job-card-list__title--link',
      'a[href*="/jobs/view/"]',
      'a[href*="currentJobId="]'
    ],

    /* right-hand details pane root */
    detailsRoot: [
      '.jobs-search__job-details--container',
      '.jobs-search__job-details',
      '.jobs-details__main-content',
      '.job-view-layout',
      'div.jobs-details'
    ],

    /* job title in the details pane */
    title: [
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      '.t-24.job-details-jobs-unified-top-card__job-title',
      '.jobs-details__main-content h1',
      'h1.topcard__title'
    ],

    company: [
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name',
      '.topcard__org-name-link'
    ],

    /* "Location  ·  2 weeks ago  ·  Over 100 applicants" */
    primaryDesc: [
      '.job-details-jobs-unified-top-card__primary-description-container',
      '.job-details-jobs-unified-top-card__primary-description',
      '.jobs-unified-top-card__primary-description',
      '.jobs-unified-top-card__subtitle-primary-grouping'
    ],

    tertiaryDesc: [
      '.job-details-jobs-unified-top-card__tertiary-description-container',
      '.jobs-unified-top-card__subtitle-secondary-grouping'
    ],

    /* pills: Remote / Full-time / Mid-Senior level / $120K-$150K */
    pills: [
      '.job-details-fit-level-preferences button',
      '.job-details-fit-level-preferences .ui-label',
      '.job-details-preferences-and-skills__pill',
      '.job-details-jobs-unified-top-card__job-insight span[dir="ltr"]',
      '.job-details-jobs-unified-top-card__job-insight',
      '.jobs-unified-top-card__job-insight span',
      'li.job-details-jobs-unified-top-card__job-insight-view-model-secondary'
    ],

    /* the job description body */
    description: [
      '#job-details',
      '.jobs-description__content .jobs-box__html-content',
      '.jobs-description-content__text',
      '.jobs-box__html-content',
      'article.jobs-description__container',
      '.jobs-description__container',
      '.description__text'
    ],

    /* "See more" expander under a clipped description */
    showMore: [
      '.jobs-description__footer-button',
      'button.show-more-less-html__button',
      'footer button[aria-expanded="false"]'
    ],

    /* the apply button (Easy Apply vs external) */
    applyButton: [
      '#jobs-apply-button-id',
      'button.jobs-apply-button',
      'a.jobs-apply-button',
      '.jobs-s-apply button',
      '.jobs-apply-button--top-card button',
      '.jobs-details-top-card__actions button'
    ],

    /* closed / already-applied notices */
    applyNotice: [
      '.jobs-details-top-card__apply-error',
      '.artdeco-inline-feedback--error .artdeco-inline-feedback__message',
      '.post-apply-timeline',
      '.jobs-s-apply__application-status'
    ],

    /* pagination */
    nextPage: [
      '.jobs-search-pagination__button--next',
      'button[aria-label="View next page"]',
      'button[aria-label="Next"]',
      '.artdeco-pagination__button--next'
    ],

    pageState: [
      '.jobs-search-pagination__page-state',
      '.artdeco-pagination__page-state'
    ],

    resultsHeader: [
      '.jobs-search-results-list__subtitle',
      '.jobs-search-results-list__title-heading small',
      'div.jobs-search-results-list header'
    ],

    noResults: [
      '.jobs-search-no-results-banner',
      '.jobs-search-two-pane__no-results-banner--shown'
    ]
  };

  function q(sels, root) {
    root = root || document;
    for (let i = 0; i < sels.length; i++) {
      const el = root.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  function qa(sels, root) {
    root = root || document;
    for (let i = 0; i < sels.length; i++) {
      const els = root.querySelectorAll(sels[i]);
      if (els.length) return Array.prototype.slice.call(els);
    }
    return [];
  }

  /* Which selector in the list actually matched - used by the health check. */
  function which(sels, root) {
    root = root || document;
    for (let i = 0; i < sels.length; i++) {
      if (root.querySelector(sels[i])) return sels[i];
    }
    return null;
  }

  /* ---------------- structure-agnostic fallback ----------------
   *
   * When none of the selectors above match - a redesign, or a surface like the
   * AI job search that was never targeted - fall back to structure rather than
   * class names. Job links are the one thing that cannot change: every job card
   * links to /jobs/view/{id}. From those, infer the list container, and infer
   * the description as the densest text block outside it. */

  /* Ways a LinkedIn surface identifies a job posting. Relying on
   * /jobs/view/{id} hrefs alone was too narrow: a list whose cards are buttons
   * with click handlers, or that carries ids only in data attributes, produced
   * zero anchors and the collector reported "no jobs" on a page full of them. */
  const ID_IN_HREF = [
    /\/jobs\/view\/(\d+)/,          // unambiguous
    /[?&]currentJobId=(\d+)/,       // unambiguous
    /[?&]jobId=(\d+)/,              // unambiguous
    /\/jobs\/(\d{6,})/              // loose, so require a realistic id length
  ];

  function jobIdFromHref(href) {
    const s = href || '';
    for (let i = 0; i < ID_IN_HREF.length; i++) {
      const m = ID_IN_HREF[i].exec(s);
      if (m) return m[1];
    }
    return null;
  }

  /* An id carried by the element itself rather than by a link. */
  function jobIdFromAttrs(el) {
    if (!el || !el.getAttribute) return null;

    const direct = el.getAttribute('data-occludable-job-id') ||
                   el.getAttribute('data-job-id') ||
                   el.getAttribute('data-jobid');
    // A job-id attribute is unambiguous, so no length floor is needed.
    if (direct && /^\d+$/.test(direct.trim())) return direct.trim();

    const urn = el.getAttribute('data-entity-urn') ||
                el.getAttribute('data-urn') ||
                el.getAttribute('data-tracking-urn');
    if (urn) {
      const m = /jobPosting:(\d+)/.exec(urn);
      if (m) return m[1];
    }

    const href = el.getAttribute('href');
    if (href) return jobIdFromHref(href);

    return null;
  }

  const JOB_CANDIDATE_SELECTOR = [
    'a[href*="/jobs/view/"]',
    'a[href*="currentJobId="]',
    'a[href*="jobId="]',
    '[data-occludable-job-id]',
    '[data-job-id]',
    '[data-jobid]',
    '[data-entity-urn*="jobPosting"]',
    '[data-urn*="jobPosting"]',
    '[data-tracking-urn*="jobPosting"]'
  ].join(',');

  /* Every element on the page that identifies a job, however it does so. */
  function jobAnchors(root) {
    const nodes = (root || document).querySelectorAll(JOB_CANDIDATE_SELECTOR);
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      if (jobIdFromAttrs(nodes[i])) out.push(nodes[i]);
    }
    return out;
  }

  /* Which discovery patterns actually hit - reported by the diagnostic so an
   * unsupported surface can be identified from one screenshot of the log. */
  function discoveryBreakdown() {
    const out = {};
    JOB_CANDIDATE_SELECTOR.split(',').forEach(function (sel) {
      let n = 0;
      try {
        const nodes = document.querySelectorAll(sel);
        for (let i = 0; i < nodes.length; i++) if (jobIdFromAttrs(nodes[i])) n++;
      } catch (e) { n = -1; }
      out[sel] = n;
    });
    return out;
  }

  /* The element holding the most job links, preferring the tightest such
   * element so we get the list itself rather than <body>. */
  function genericListRoot() {
    const anchors = jobAnchors();
    if (anchors.length < 2) return null;

    const counts = new Map();
    anchors.forEach(function (a) {
      let node = a.parentElement;
      let depth = 0;
      while (node && node !== document.documentElement && depth < 10) {
        counts.set(node, (counts.get(node) || 0) + 1);
        node = node.parentElement;
        depth++;
      }
    });

    let best = null;
    let bestCount = 0;
    counts.forEach(function (count, el) {
      if (count > bestCount) { best = el; bestCount = count; return; }
      // Same coverage, smaller subtree: that is the real list, not its wrapper.
      if (count === bestCount && best && best.contains(el)) best = el;
    });
    return best;
  }

  function genericCards() {
    const all = jobAnchors();
    const root = genericListRoot();

    /* No ids anywhere on the cards: fall back to finding the list by shape.
     * Those cards get their job id after being clicked, from the URL. */
    if (!all.length) return genericCardsByShape();

    /* Results can be split across several sibling containers, in which case no
     * single inferred root holds them all. Scoping to that root then silently
     * dropped most of the page - 13 job links became 1 card. Only trust the
     * root when it actually covers the bulk of what is on the page. */
    const scoped = root ? jobAnchors(root) : [];
    const use = scoped.length >= Math.max(2, all.length * 0.5) ? scoped : all;

    const seen = new Set();
    const cards = [];

    use.forEach(function (a) {
      const id = jobIdFromAttrs(a);
      if (!id || seen.has(id)) return;
      seen.add(id);
      cards.push(a.closest('li') || a.closest('[data-job-id]') || a.parentElement || a);
    });

    /* Cross-check against shape.
     *
     * The anchor route assumes each card link names its own job. On the AI job
     * search that assumption breaks: every known selector misses, and the
     * page's job links mostly carry the SELECTED job's currentJobId rather
     * than one id each - six job links deduped to a single card while a
     * seven-member repeated group sat right there in the DOM.
     *
     * Fewer than three cards from six-plus anchors is not a short page, it is
     * a collapsed inference. Shape discovery is already written and already
     * guarded by looksLikeJobList, so consult it rather than proceeding with
     * one card and reporting success. */
    if (cards.length < 3) {
      const byShape = genericCardsByShape();
      if (byShape.length > cards.length) return byShape;
    }
    return cards;
  }

  /* ---- shape-based discovery, for lists that carry no ids or links ----
   *
   * LinkedIn's newer job surfaces render result cards as plain divs with hashed
   * class names, no anchors and no data attributes: nothing to key on by name
   * or by id. What they cannot hide is being a run of sibling elements with the
   * same shape and a similar amount of text. That is what this finds. */

  function shapeSignature(el) {
    return el.tagName + ':' + Math.min(8, el.childElementCount);
  }

  function repeatedSiblingGroups(excludeRoot) {
    const groups = [];
    const parents = document.querySelectorAll('div, section, main, ol, ul, [role]');

    for (let i = 0; i < parents.length && i < 6000; i++) {
      const parent = parents[i];
      const kids = parent.children;
      if (kids.length < 3 || kids.length > 60) continue;
      if (excludeRoot && (excludeRoot.contains(parent) || parent.contains(excludeRoot))) continue;

      const bySig = new Map();
      for (let k = 0; k < kids.length; k++) {
        const kid = kids[k];
        const len = (kid.textContent || '').trim().length;
        // A job card is substantial but not an essay.
        if (len < 40 || len > 1200) continue;
        /* A card is composite - title, company, metadata. This is what keeps a
         * run of <p> tags inside a job description from being mistaken for a
         * list of results, since those are flat. */
        if (kid.childElementCount < 1) continue;
        const sig = shapeSignature(kid);
        if (!bySig.has(sig)) bySig.set(sig, []);
        bySig.get(sig).push(kid);
      }

      bySig.forEach(function (members, sig) {
        if (members.length >= 3) {
          groups.push({ parent: parent, sig: sig, members: members, count: members.length });
        }
      });
    }

    /* Most repeats wins; on a tie the tightest container wins, so we get the
     * list itself rather than a wrapper several levels up. */
    groups.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.parent.contains(b.parent) ? 1 : -1;
    });
    return groups;
  }

  /* Find the list FIRST, then the description outside it.
   *
   * The reverse order deadlocks: the description heuristic picks the densest
   * block, which on a two-pane layout can be a wrapper containing both the
   * results and the detail pane. Excluding that wrapper then hides the list.
   * Repeated structure is the stronger signal, so it goes first. */
  /* A repeated group whose members link to people, companies or schools is not
   * a job list - it is "people also viewed", a recruiter rail, or the feed.
   * Without this check the shape finder happily selected such a list and the
   * collector clicked its way through member profiles. */
  const NON_JOB_LINK = /\/(in|company|school|groups|events|posts|feed|learning)\//;

  function looksLikeNonJobCard(el) {
    const a = el.querySelector('a[href]');
    if (!a) return false;
    if (jobIdFromAttrs(a)) return false;          // a job link settles it
    return NON_JOB_LINK.test(a.getAttribute('href') || '');
  }

  function looksLikeJobList(members) {
    let nonJob = 0;
    for (let i = 0; i < members.length; i++) {
      if (looksLikeNonJobCard(members[i])) nonJob++;
    }
    return nonJob < members.length / 2;
  }

  /* Shape matching is the last resort, and it only runs on a jobs page. It is
   * inherently loose, so it must never be the reason the extension starts
   * clicking around an unrelated part of LinkedIn. */
  function onJobsPage() {
    return /^\/jobs(\/|$)/.test(window.location.pathname);
  }

  function genericCardsByShape() {
    if (!onJobsPage()) return [];
    const groups = repeatedSiblingGroups(null);
    for (let i = 0; i < groups.length; i++) {
      if (looksLikeJobList(groups[i].members)) return groups[i].members;
    }
    return [];
  }

  /* The results container however it was found - by id, or by shape. */
  function genericListRootAny() {
    const byId = genericListRoot();
    if (byId) return byId;
    const shaped = genericCardsByShape();
    return shaped.length ? shaped[0].parentElement : null;
  }

  /* Global page chrome a bounded ancestor-walk should never credit as content,
   * even if it somehow ends up in scope - belt and suspenders on top of the
   * walk itself never reaching outside the pane `near` sits in. */
  function inPageChrome(el) {
    return !!(el.closest && el.closest('#global-nav, header[role="banner"], [role="navigation"], nav'));
  }

  /* ---- the details pane, when no selector names it ----
   *
   * Everything below reads fields "near the description". Without a pane to
   * scope that to, `near` is missing and extract.js falls back to `document`,
   * which is not a smaller mistake than having no fallback at all - it is a
   * worse one. A real run against the AI job search produced rows whose title
   * was the rail's "Get job alerts for this search" banner, whose company was
   * a different employer's card, and whose pay was $260k-$390k on every single
   * job because a document-wide pill scan kept finding the same element. Every
   * row looked collected and not one was true.
   *
   * The pane is the outermost ancestor of the description that still excludes
   * the results rail. Outermost, because the header with the title, company
   * and pills sits above the description and has to be inside it; excluding
   * the rail, because the moment it is in scope, every field can come from
   * some other job's card. */
  function genericDetailsRoot(descEl) {
    if (!descEl) return null;
    const listRoot = genericListRootAny();

    let node = descEl;
    let best = descEl;
    let depth = 0;

    while (node.parentElement && node.parentElement !== document.body && depth < 14) {
      node = node.parentElement;
      if (listRoot && (node === listRoot || node.contains(listRoot))) break;
      if (inPageChrome(node)) break;
      best = node;
      depth++;
    }
    return best;
  }

  /* A description candidate that overlaps the results rail is not a
   * description, however dense it is. This is the failure that put the SAME
   * 3,549 characters on five consecutive jobs: the rail does not change when
   * you click through it, so five jobs came back with identical text and
   * nothing downstream could tell. */
  function plausibleDescription(el, listRoot) {
    if (!el) return false;
    if ((el.textContent || '').trim().length < 200) return false;
    if (listRoot && (el === listRoot || el.contains(listRoot) || listRoot.contains(el))) return false;
    if (inPageChrome(el)) return false;

    /* A block holding several job links is a results list, whatever else it
     * looks like - and this test needs no list root to have been inferred
     * first, which is the point. The list-root checks above are only as good
     * as that inference; when it comes back null (cards whose first link is
     * the company logo, an unfamiliar rail, a layout in flux) every guard that
     * depends on it silently stops guarding, and the rail wins the densest-
     * block contest again. It carries 20-odd job links; a posting carries
     * none. */
    if (jobAnchors(el).length >= 2) return false;
    return true;
  }

  /* The job title on a surface whose title selectors all miss. Scoped to the
   * pane around `near` (normally the description element), one ancestor at a
   * time, and NEVER document-wide: LinkedIn's AI job search renders a real,
   * non-decorative <h2>0 notifications</h2> for the nav bell ahead of the job
   * heading in document order, and a document-wide search locked onto that
   * instead - every collected job got "0 notifications" as its title.
   * Widening one ancestor at a time means the closest qualifying heading
   * wins; finding nothing before running out of ancestors returns null rather
   * than guessing from whatever page chrome happens to sort first. */
  /* Headings that are furniture, not the job. Every one of these was observed
   * being collected AS a job title on a real run: the rail's alerts banner,
   * the description's own label, and the pane's company section. A title is
   * the one field with no fallback of its own - a wrong one is carried into
   * the export and read as fact - so these are excluded by name. */
  const NOT_A_TITLE = [
    /\?$/,                       // no job title is a question
    /^get job alerts?\b/i,
    /^job alerts?\b/i,
    /^how promoted jobs are ranked/i,
    /^\d+\+? results?$/i,
    /^about the (job|company|role)$/i,
    /^(job|role) description$/i,
    /^description$/i,
    /^people also viewed$/i,
    /^similar jobs$/i,
    /^more jobs\b/i,
    /^premium\b/i,
    /^\d+\s+notifications?$/i,
    /^your profile\b/i,
    /^meet the (hiring team|team)$/i,
    /^how (you|your profile) match/i
  ];

  function looksLikeATitle(t) {
    if (!t || t.length < 3 || t.length > 120) return false;
    for (let i = 0; i < NOT_A_TITLE.length; i++) {
      if (NOT_A_TITLE[i].test(t)) return false;
    }
    return true;
  }

  /* `stopAt` bounds the outward walk - normally the details pane, so widening
   * can never reach the rail and pick another job's heading. */
  function genericTitle(near, stopAt) {
    const known = q(SEL.title);
    if (known) return known;
    if (!near) return null;

    const listRoot = genericListRootAny();
    const usable = function (el) {
      if (!el || inPageChrome(el)) return false;
      if (listRoot && listRoot.contains(el)) return false;
      return looksLikeATitle((el.textContent || '').replace(/\s+/g, ' ').trim());
    };

    let scope = near.parentElement || near;
    let depth = 0;

    while (scope && scope !== document.body && depth < 12) {
      const h1 = scope.querySelector('h1');
      if (usable(h1)) return h1;

      /* No h1 in this scope yet: the first short heading-ish element, which
       * is where a job title lives on every layout so far. */
      const heads = scope.querySelectorAll('h2, h3, [role="heading"]');
      for (let i = 0; i < heads.length; i++) {
        if (usable(heads[i])) return heads[i];
      }

      if (stopAt && scope === stopAt) break;
      scope = scope.parentElement;
      depth++;
    }
    return null;
  }

  /* The company name on a surface whose company selectors all miss: a link to
   * a LinkedIn company page is far more durable than a class name, in the
   * same spirit as genericTitle/genericApplyButton solving the same problem
   * for other fields. Scoped the same way as genericTitle - one ancestor at a
   * time from `near` (the title element), never document-wide - so a
   * /company/ link belonging to a different card (the results rail, "people
   * also viewed") is never picked up instead of the actual employer. */
  /* "Tunnel to Towers Foundation 28,506 followers" is the pane's About-the-
   * company card, not the employer field. It is a /company/ link with real
   * text, so nothing above rejects it - but a company name never ends in a
   * follower count, and that suffix travelled into the export. */
  const FOLLOWER_SUFFIX = /\s*[\d,.]+[km]?\+?\s*followers?\s*$/i;

  function companyText(el) {
    const t = ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    return t.replace(FOLLOWER_SUFFIX, '').trim();
  }

  function genericCompany(near, stopAt) {
    if (!near) return null;
    const listRoot = genericListRootAny();
    let scope = near.parentElement || near;
    let depth = 0;

    while (scope && scope !== document.body && depth < 12) {
      const links = scope.querySelectorAll('a[href*="/company/"]');
      for (let i = 0; i < links.length; i++) {
        const a = links[i];
        if (listRoot && listRoot.contains(a)) continue;
        if (inPageChrome(a)) continue;
        if (companyText(a).length) return a;
      }
      if (stopAt && scope === stopAt) break;
      scope = scope.parentElement;
      depth++;
    }
    return null;
  }

  /* ---------------- text anchors ----------------
   *
   * Class names are the first thing a redesign changes; visible copy is the
   * last. LinkedIn's AI job search shares almost no class names with the
   * classic layout, but its details pane still puts the description under a
   * plain "About the job" heading. Anchoring on that heading is far more
   * durable than any selector, and it is also more precise than the densest-
   * block heuristic below: that pane is full of interstitial cards (a
   * profile-match panel, two Premium upsells) which the density measure can
   * happily swallow into the middle of a job description. */

  const DESC_HEADINGS = [
    /^about the job$/i,
    /^about this job$/i,
    /^about the role$/i,
    /^job description$/i,
    /^role description$/i,
    /^description$/i
  ];

  function norm(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  /* An element's OWN text, ignoring anything contributed by child elements.
   * Used for the generic div/span candidates below so a wrapping container
   * whose descendants happen to start with "About the job" is never mistaken
   * for the label itself - real headings keep using norm() (full subtree
   * text) exactly as they always did. */
  function ownText(el) {
    if (!el || !el.childNodes) return '';
    let out = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function isHeadingEl(el) {
    return /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
  }

  function matchesDescHeading(label) {
    if (!label || label.length > 40) return false;   // a paragraph, not a label
    for (let k = 0; k < DESC_HEADINGS.length; k++) {
      if (DESC_HEADINGS[k].test(label)) return true;
    }
    return false;
  }

  /* Candidates for the description label. Headings are the reliable case;
   * LinkedIn's AI job search (as of a diagnostic run on 2026-08-26) instead
   * renders the visible label as a plain, unstyled-by-role div/span for
   * sighted users, and puts a SEPARATE, content-less heading with the same
   * text next to it for screen readers only - so heading-only used to lock
   * onto the empty one and give up. Scanning every div for SUBTREE text would
   * be both slow and prone to matching a stray label somewhere else on the
   * page, so a non-heading candidate only ever qualifies on its own text.
   *
   * Deliberately NOT p/li/dt: a one-line prose intro ("About the role" as its
   * own paragraph, ahead of the real body copy in separate paragraphs) reads
   * exactly like a label but is not one - tests/generic.test.js pins the
   * failure that caused: it anchored on that intro line and returned only
   * whichever later paragraph happened to clear the length floor, dropping
   * everything else. div/span are UI label elements in practice; p/li are
   * prose, too often used exactly the way a real label text should not be. */
  const DESC_LABEL_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"], div, span';

  /* The block following a description heading, or - on a surface that renders
   * the visible label as a plain element instead - whichever candidate
   * carries that exact label text on its own AND has real content next to it.
   * A content-less candidate (the a11y-only heading, say) is tried and passed
   * over rather than accepted, so it can never win just for matching first. */
  function headingAnchoredDescription(excludeRoot) {
    const heads = document.querySelectorAll(DESC_LABEL_SELECTOR);

    for (let i = 0; i < heads.length && i < 8000; i++) {
      const h = heads[i];
      if (excludeRoot && (excludeRoot === h || excludeRoot.contains(h))) continue;

      const heading = isHeadingEl(h);
      const label = heading ? norm(h) : ownText(h);
      if (!matchesDescHeading(label)) continue;

      /* Usually the prose is the next sibling block. */
      let el = h.nextElementSibling;
      while (el) {
        if ((el.textContent || '').trim().length >= 200) return el;
        el = el.nextElementSibling;
      }

      /* Some layouts wrap heading and prose in one container instead. */
      const p = h.parentElement;
      if (p && (p.textContent || '').trim().length >= 200) return p;

      // No qualifying content next to THIS candidate - keep looking.
    }
    return null;
  }

  /* The AI job search clips the description and offers an inline "… more"
   * rather than the classic footer button, so a run against it captured a JD
   * cut off mid-sentence - which is worse than useless for vetting, because
   * the requirements are usually in the half that got cut. */
  function genericShowMore(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll(
      'button, a[role="button"], span[role="button"], [aria-expanded="false"]');

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const label = (norm(el) + ' ' + (el.getAttribute('aria-label') || ''))
        .replace(/\s+/g, ' ').trim();
      if (label.length > 30) continue;
      if (/^(?:…|\.\.\.)?\s*(?:see|show|read)?\s*more$/i.test(label)) return el;
      if (/^see more$/i.test(label) || /^show more$/i.test(label)) return el;
    }
    return null;
  }

  /* The workplace/employment/seniority/pay pills on an unfamiliar layout: any
   * short leaf element's OWN text within scope, fed through the same
   * classification extract.js already runs on the known pill selectors - a
   * redesign only ever needs new discovery here, never a new classifier.
   *
   * This reads each candidate's OWN text rather than the scope's combined
   * text on purpose. Adjacent pills sitting in the source markup with no
   * separating whitespace - `<span>$258K/yr</span><span>Remote</span>` - read
   * as one glued run, "...yrRemoteFull-time...", when captured as a block of
   * text together; that silently defeated the word-boundary regexes below it
   * used to fall back on, and workplaceType came back Unknown for a job that
   * plainly said Remote right there in the pane. */
  /* `exclude` keeps the description body out of the scan. Without it the pill
   * classifier reads the posting's own prose - and with no scope at all it
   * read the WHOLE PAGE: LinkedIn's own filter chips supplied "Temporary" and
   * "Internship" as the employment type of a director role, and one rail
   * card's "$260K/yr - $390K/yr" became the pay on every job in the run. A
   * pill has to come from this job's header or it is not this job's pill. */
  function genericPills(scope, exclude) {
    const root = scope || document;
    const listRoot = genericListRootAny();
    const nodes = root.querySelectorAll('span, div, li, button, a, dd, td');
    const out = [];
    const seen = new Set();

    for (let i = 0; i < nodes.length && i < 4000; i++) {
      const el = nodes[i];
      if (exclude && (el === exclude || exclude.contains(el))) continue;
      if (listRoot && listRoot.contains(el)) continue;
      if (inPageChrome(el)) continue;
      const t = ownText(el);
      if (!t || t.length > 40 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  /* "United States · 6 hours ago · 5 people clicked apply" - the line under
   * the title carrying location, age and applicant count. Its own selectors
   * miss on the AI job search, so every collected job came back with no
   * location and no posted date at all, which quietly disables the
   * posted-within and applicant filters rather than announcing anything.
   *
   * Found by shape: the shortest element in the header whose text is a
   * middot-separated run, or failing that one that states an age. */
  const RE_AGE_LINE = /\d+\s*(?:minute|min|hour|hr|day|week|month|year)s?\s+ago/i;

  function genericMetaLine(scope, exclude) {
    if (!scope) return '';
    const nodes = scope.querySelectorAll('div, span, p, li, ul, section');
    let best = '';
    let bestParts = 0;

    for (let i = 0; i < nodes.length && i < 2000; i++) {
      const el = nodes[i];
      if (exclude && (el === exclude || exclude.contains(el) || el.contains(exclude))) continue;
      if (inPageChrome(el)) continue;

      const t = norm(el);
      if (!t || t.length > 200) continue;

      const parts = t.split(/\s*[·•]\s*/).filter(Boolean).length;
      const scored = parts > 1 ? parts : (RE_AGE_LINE.test(t) ? 1 : 0);
      if (!scored) continue;

      /* More separators wins; on a tie the shorter text wins, which is how the
       * line itself beats the container that wraps it. */
      if (scored > bestParts || (scored === bestParts && t.length < best.length)) {
        best = t;
        bestParts = scored;
      }
    }
    return best;
  }

  /* The densest text block that is not part of the list. Among candidates
   * holding most of the text, the deepest one wins, which trims the page
   * chrome off the description. */
  function genericDescription(excludeRoot) {
    const nodes = document.querySelectorAll('div, section, article, main');
    const candidates = [];

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (excludeRoot && (excludeRoot === el || excludeRoot.contains(el) || el.contains(excludeRoot))) continue;
      /* Every way this surface identifies a job, not just /jobs/view/ hrefs.
       * The AI job search links its cards with ?currentJobId=, so the old
       * check saw no job links in the rail at all and happily returned it as
       * the densest block on the page. */
      if (jobAnchors(el).length >= 2) continue;
      const len = (el.textContent || '').trim().length;
      if (len >= 400) candidates.push({ el: el, len: len });
    }
    if (!candidates.length) return null;

    const maxLen = candidates.reduce(function (n, c) { return Math.max(n, c.len); }, 0);
    const dense = candidates.filter(function (c) { return c.len >= maxLen * 0.85; });

    let best = dense[0];
    dense.forEach(function (c) { if (best.el.contains(c.el)) best = c; });
    return best.el;
  }

  /* The apply control on an unfamiliar layout: a short button or link whose
   * text is "Apply" or "Easy Apply", outside the results list. Without this the
   * fallback cannot tell direct apply from Easy Apply, which is one of the
   * distinctions the whole tool exists to make. */
  function genericApplyButton(scope, exclude) {
    const listRoot = genericListRootAny();
    /* The apply control on the AI job search is a bare <a> pointing at the
     * employer's own host - no role="button", and no "apply" anywhere in the
     * href - so the old node set never saw it and applyType came back
     * "unknown" for every job. Widened to any link or button, with the text
     * match below doing the real filtering. */
    const nodes = (scope || document).querySelectorAll('button, a[href], a[role="button"], [role="button"]');
    let candidate = null;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (listRoot && listRoot.contains(el)) continue;
      /* An explicit exclusion from the caller. The AI job search shows an
       * "Easy Apply" badge on the CARDS, so a search that reaches the rail
       * reports the badge of some other job as this job's apply route. */
      if (exclude && (el === exclude || exclude.contains(el))) continue;

      /* Text and aria-label are tested SEPARATELY, each with its own length
       * limit. Concatenating them and capping the pair at 40 characters
       * rejected every real Easy Apply button on LinkedIn, because its
       * aria-label names the job and the employer - "Easy Apply to Senior
       * Corporate Counsel at Delaware North" is 53 characters before the
       * button's own text is even added. A whole run came back applyType
       * "unknown" on that arithmetic. */
      const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

      const shortOwn = own.length <= 40 ? own : '';
      const shortAria = aria.length <= 120 ? aria : '';

      const easy = /^easy apply\b/i.test(shortOwn) || /^easy apply\b/i.test(shortAria);
      const apply = /^apply\b/i.test(shortOwn) || /^apply\b/i.test(shortAria);
      if (!easy && !apply) continue;

      // An explicit Easy Apply beats a bare Apply if both are present.
      if (easy) return el;
      if (!candidate) candidate = el;
    }
    return candidate;
  }

  /* ---------------- learned selectors ----------------
   *
   * A selector the AI assist resolved for a layout nobody has written an
   * adapter for (src/content/aiassist.js). Learned selectors go to the FRONT
   * of the same candidate lists everything else already reads, so every call
   * site downstream - getCards, extract.js, the apply resolver - picks them up
   * without knowing they exist.
   *
   * Two rules keep that from being dangerous. A key whose hand-written
   * selectors still match is refused outright, so a plan can only ever fill a
   * gap and never take over a layout that works. And one learned selector per
   * key is kept, replacing rather than stacking, so a re-resolve after a
   * deploy cannot leave a trail of stale guesses ahead of the real list. */
  const LEARNED = {};

  function learn(key, sel) {
    if (!Object.prototype.hasOwnProperty.call(SEL, key)) {
      return { ok: false, why: 'not a selector the collector uses' };
    }
    if (typeof sel !== 'string' || !sel.trim()) {
      return { ok: false, why: 'empty selector' };
    }
    if (LEARNED[key] === sel) return { ok: true, already: true };

    const known = which(SEL[key].filter(function (s) { return s !== LEARNED[key]; }));
    if (known) {
      return { ok: false, why: 'the hand-written selector already matches (' + known + ')' };
    }

    if (LEARNED[key]) {
      const i = SEL[key].indexOf(LEARNED[key]);
      if (i !== -1) SEL[key].splice(i, 1);
    }
    LEARNED[key] = sel;
    SEL[key].unshift(sel);
    return { ok: true };
  }

  function learned(key) {
    if (key) return LEARNED[key] || null;
    return Object.assign({}, LEARNED);
  }

  function forgetLearned() {
    Object.keys(LEARNED).forEach(function (key) {
      const i = SEL[key].indexOf(LEARNED[key]);
      if (i !== -1) SEL[key].splice(i, 1);
      delete LEARNED[key];
    });
  }

  window.JDC_SEL = {
    SEL: SEL, q: q, qa: qa, which: which,
    learn: learn, learned: learned, forgetLearned: forgetLearned,
    genericApplyButton: genericApplyButton,
    jobIdFromHref: jobIdFromHref,
    jobIdFromAttrs: jobIdFromAttrs,
    jobAnchors: jobAnchors,
    discoveryBreakdown: discoveryBreakdown,
    JOB_CANDIDATE_SELECTOR: JOB_CANDIDATE_SELECTOR,
    genericListRoot: genericListRoot,
    genericCards: genericCards,
    genericCardsByShape: genericCardsByShape,
    looksLikeNonJobCard: looksLikeNonJobCard,
    looksLikeJobList: looksLikeJobList,
    genericListRootAny: genericListRootAny,
    genericTitle: genericTitle,
    genericCompany: genericCompany,
    companyText: companyText,
    looksLikeATitle: looksLikeATitle,
    genericDetailsRoot: genericDetailsRoot,
    plausibleDescription: plausibleDescription,
    repeatedSiblingGroups: repeatedSiblingGroups,
    genericDescription: genericDescription,
    genericMetaLine: genericMetaLine,
    headingAnchoredDescription: headingAnchoredDescription,
    genericShowMore: genericShowMore,
    genericPills: genericPills,
    DESC_HEADINGS: DESC_HEADINGS
  };
})();
