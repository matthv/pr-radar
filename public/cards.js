// The board's cards: a PR's threads, pills, reasons, reviewers and what changed since you
// looked. A plain script sharing the page's globals (state, t, escapeHtml, pill), loaded
// before the page's own script; nothing here runs until a card is drawn.

function threadHtml(thread) {
  const file = thread.path ? thread.path.split('/').pop() : null;
  // Three channels, three places a remark can live: a line of code, the review itself,
  // or the PR conversation. Both synthetic ones have no path, so the channel says which.
  const label = file
    ? escapeHtml(file) + (thread.line ? ':' + thread.line : '')
    : t(thread.channel === 'review' ? 'reviewNote' : 'conversation');
  return `
    <div class="thread">
      <div class="thread-head">
        <span class="thread-author">${escapeHtml(thread.author)}</span>
        <a class="thread-path" href="${escapeHtml(thread.url)}" target="_blank" rel="noreferrer"
           title="${escapeHtml(thread.path || '')}">${label}</a>
        ${thread.isOutdated ? pill('', t('outdated')) : ''}
        ${thread.commentCount > 1 ? `<span>${t('messages', { n: thread.commentCount })}</span>` : ''}
        <span>${t('lastWord', {
          who: escapeHtml(thread.lastByMe ? t('me') : thread.lastAuthor),
          ago: since(thread.lastAt),
        })}</span>
      </div>
      <div class="thread-body">${escapeHtml(thread.excerpt)}${
        thread.excerptTruncated
          ? ` <a class="thread-more" href="${escapeHtml(thread.url)}" target="_blank" rel="noopener">${t('readRest')}</a>`
          : ''
      }</div>
    </div>`;
}

// On a merged PR the release outcome owns the card's colour, overriding the bucket:
// the bucket says whose move it is, but here what matters is whether the release landed.
// pipelineOutcome is computed server-side (github.js), not re-derived here, so this and
// the sort order in byActionThenFreshness cannot read the same commit two different ways.
function pipelineClass(pr) {
  if (!pr.merged) return '';
  if (pr.pipelineOutcome === 'failed') return ' pipeline-failed';
  if (pr.pipelineOutcome === 'done') return ' pipeline-done';
  if (pr.pipelineOutcome === 'running') return ' pipeline-running';
  // 'none': no check was ever posted to this merge commit, and none ever will be —
  // merging into a branch with no CI on push, say. `.card.merged` alone is amber, meant
  // as a transient default always meant to be overridden — left unstyled here it read as
  // "still waiting on someone", the opposite of settled. Painted the same green as a
  // landed release: nothing is pending either way, only the pill beside it differs.
  return ' pipeline-none';
}

// The chime says something landed on your plate, not which card: those that just did keep
// their rail glowing for two minutes, so a glance finds them. Same rule as the chime, per
// card — entered "to act" since the last render, filters applied, never on the first
// render. Independent of the mute button: a silent board is where it helps most.
const GLOW_MS = 2 * 60 * 1000;
const GLOW_FADE_MS = 10 * 1000;
const GLOW_PULSE_S = 2.4;
let glowTimer = null;

function trackGlow(actionIds) {
  const now = Date.now();
  const current = new Set(actionIds);
  const arrived = new Set();
  if (state.lastActionIds) {
    for (const id of current) {
      if (state.lastActionIds.has(id)) continue;
      state.glow.set(id, document.hidden ? null : now + GLOW_MS);
      arrived.add(id);
    }
  }
  // A card that left "to act" — you answered — has nothing left to point at.
  for (const id of state.glow.keys()) if (!current.has(id)) state.glow.delete(id);
  state.lastActionIds = current;
  scheduleGlowExpiry();
  return arrived;
}

function scheduleGlowExpiry() {
  clearTimeout(glowTimer);
  const ends = [...state.glow.values()].filter(Boolean);
  if (!ends.length) return;
  const next = Math.min(...ends);
  // Wake once to start the fade, once more to drop the class: no timer runs in between.
  const fadeAt = next - GLOW_FADE_MS;
  glowTimer = setTimeout(() => {
    const now = Date.now();
    for (const [id, until] of state.glow) if (until && until <= now) state.glow.delete(id);
    render();
  }, Math.max(0, (Date.now() < fadeAt ? fadeAt : next) - Date.now()) + 20);
}

function stopGlow(card) {
  if (!card || !(state.glow.has(card.dataset.id) || twinGlow.has(card.dataset.id))) return;
  state.glow.delete(card.dataset.id);
  twinGlow.delete(card.dataset.id);
  card.classList.remove('glow', 'glow-ending');
  scheduleGlowExpiry();
}

// Rendered as negative delays: render() rebuilds every card, and an animation restarting
// at its first frame on each refresh would visibly jump.
function glowAttrs(pr) {
  const until = state.glow.get(pr.id) ?? twinGlow.get(pr.id);
  if (!until) return { cls: '', style: '' };
  const left = until - Date.now();
  const elapsed = GLOW_MS - left;
  if (left <= GLOW_FADE_MS) {
    return { cls: ' glow glow-ending', style: ` style="--glow-fade-elapsed: -${((GLOW_FADE_MS - left) / 1000).toFixed(2)}s"` };
  }
  return { cls: ' glow', style: ` style="--glow-elapsed: -${((elapsed / 1000) % GLOW_PULSE_S).toFixed(2)}s"` };
}

// The board's own org needs no owner; a repo added through PR_RADAR_EXTRA_REPOS does, or
// `pr-radar` would read as one of the org's.
// GitHub's `org:` ignores case, `pr.repo` carries the org's own spelling.
const isExternal = repo =>
  Boolean(state.data?.org) && !repo.toLowerCase().startsWith(`${state.data.org.toLowerCase()}/`);
const repoName = repo => (isExternal(repo) ? repo : repo.replace(/^.*\//, ''));
// The class and inline variables a repo's coloured element takes; empty for the default cyan.
function repoTint(repo) {
  const tint = repoColors.get(repo);
  return tint ? { cls: ' tinted', style: ` style="--repo-h:${Number(tint.h)};--repo-c:${Number(tint.c)}"` } : { cls: '', style: '' };
}
const repoDot = repo => {
  const tint = repoTint(repo);
  return tint.cls ? `<span class="repo-dot"${tint.style}></span>` : '';
};

const repoChip = pr => {
  const tint = repoTint(pr.repo);
  return `<span class="repo${tint.cls}"${tint.style}>${escapeHtml(repoName(pr.repo))} #${pr.number}</span>`;
};

const changesOf = pr => PRRadarSince.changesSince(state.seen?.[pr.id], pr, state.data.me);

// A change a reason already says word for word: marked new on the reason instead of said
// twice. The reason stays once seen — it is why the card is here — and only its mark goes.
const SAID_BY_REASON = {
  changesRequested: pr => pr.side === 'mine' && pr.reasons.some(r => r.kind === 'changes-requested'),
  pushed: pr => pr.side === 'review' && pr.reasons.some(r => r.kind === 'recheck'),
};
// A pill only gives the state; that it is news is still said on the line, and the pill gets
// a dot in its own colour to point at it.
const SHOWN_BY_PILL = {
  ciFailed: pr => !pr.merged && (pr.ciState === 'FAILURE' || pr.ciState === 'ERROR'),
  conflict: pr => pr.side === 'mine' && pr.mergeable === 'CONFLICTING',
  releaseFailed: pr => pr.merged && pr.pipelineOutcome === 'failed',
};
const freshOn = (pr, kind) =>
  Boolean((SAID_BY_REASON[kind] ?? SHOWN_BY_PILL[kind])?.(pr)) && changesOf(pr).some(change => change.kind === kind);
const freshBadge = () => `<span class="fresh-badge">${escapeHtml(t('sinceFresh'))}</span>`;

function sincePhrase(change) {
  const who = (change.who ?? []).join(', ');
  switch (change.kind) {
    case 'commented': return tn('sinceCommented', change.who.length, { who });
    case 'approved': return t('sinceApproved', { who });
    case 'changesRequested': return t('sinceChangesRequested', { who });
    case 'pushed': return t('sincePushed', { who });
    case 'ciFailed': return t('sinceCiFailed');
    case 'ciPassed': return t('sinceCiPassed');
    case 'conflict': return t('sinceConflict');
    case 'merged': return t('sinceMerged');
    case 'released': return t('sinceReleased', { tag: change.tag });
    case 'releaseFailed': return t('sinceReleaseFailed');
    default: return change.kind;
  }
}

const SINCE_SHOWN = 2;

// One block for why the card is here and what moved on it: the reasons first, then what is
// new since you looked as its last entry. What asks for something leads that entry; the
// list under it says everything, latest first, with when. A CI or a conflict has no moment
// of its own in the data: it heads the list as is.
function reasonsHtml(pr) {
  const fresh = freshOn(pr, 'changesRequested') || freshOn(pr, 'pushed');
  const rows = pr.displayReasons.map(r => `<div class="reason">${escapeHtml(r)}${fresh ? freshBadge() : ''}</div>`);

  const changes = changesOf(pr).filter(change => !SAID_BY_REASON[change.kind]?.(pr));
  if (changes.length) {
    const hidden = changes.length - SINCE_SHOWN;
    const open = hidden > 0 && state.sinceOpen.has(pr.id);
    const when = change => (change.at ? `${sincePhrase(change)} — ${t('sinceAgo', { v: ago(change.at) })}` : sincePhrase(change));
    const toggle = hidden > 0
      ? ` <button type="button" class="since-toggle" data-since="${escapeHtml(pr.id)}" aria-expanded="${open}">`
        + `${open ? '▾' : '▸'} ${escapeHtml(t('sinceMore', { n: hidden }))}</button>`
      : '';
    rows.push(`<div class="reason since" title="${escapeHtml(changes.map(when).join('\n'))}"><span>`
      + `<span class="since-lead">${escapeHtml(t('sinceLead'))}</span> `
      + `<span class="since-text">${changes.slice(0, SINCE_SHOWN).map(change => escapeHtml(sincePhrase(change))).join(' · ')}</span>${toggle}</span></div>`);
    if (open) {
      const byTime = [...changes].sort((a, b) => (b.at ?? '\uffff').localeCompare(a.at ?? '\uffff'));
      rows.push(`<ul class="since-list">${byTime.map(change => `<li><span>${escapeHtml(sincePhrase(change))}</span>`
        + `<span class="since-at">${change.at ? escapeHtml(t('sinceAgo', { v: ago(change.at) })) : ''}</span></li>`).join('')}</ul>`);
    }
  }
  return rows.length ? `<div class="reasons">${rows.join('')}</div>` : '';
}

function linearLink(pr) {
  const base = state.data?.linearUrl;
  if (!pr.ticket || !base) return '';
  return `<a class="linear-link" href="${escapeHtml(`${base}/issue/${encodeURIComponent(pr.ticket)}`)}"`
    + ` target="_blank" rel="noopener" title="${escapeHtml(t('ticketTitle', { key: pr.ticket }))}">`
    + `${LINEAR_ICON}<span>${escapeHtml(pr.ticket)}</span></a>`;
}

// What the plugins in PR_RADAR_PLUGINS add to a card. The server already vetted the kind and the
// URL; the text is the plugin's, so it is escaped like anything else.
function pluginPills(pr) {
  return (pr.plugins?.pills ?? []).map(({ text, kind, title, url, running }) => {
    const cls = `pill${kind ? ` ${kind}` : ''}${running ? ' running' : ''}`;
    const tip = title ? ` title="${escapeHtml(title)}"` : '';
    return url
      ? `<a class="${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener"${tip}>${escapeHtml(text)}</a>`
      : `<span class="${cls}"${tip}>${escapeHtml(text)}</span>`;
  });
}

// By PR and label rather than on the button: a refresh redraws the card mid-request.
const labelling = new Set();

function labelButtons(pr) {
  return (pr.plugins?.labels ?? []).map(({ name, text, title }) => `<button type="button"`
    + ` class="label-btn${labelling.has(`${pr.id} ${name}`) ? ' busy' : ''}" data-plugin-label="${escapeHtml(name)}"`
    + ` data-pr="${escapeHtml(pr.id)}" title="${escapeHtml(title ?? t('labelTitle', { label: name }))}">${escapeHtml(text)}</button>`).join('');
}

function twinsPill(pr) {
  if (!pr.twins?.length) return '';
  const list = pr.twins.map(twin => `${twin.repo.split('/')[1]}#${twin.number}`).join(', ');
  return `<button type="button" class="pill twins" data-twins="${escapeHtml(pr.id)}"`
    + ` title="${escapeHtml(t('pillTwinsTitle', { list }))}">${ICONS.link}${escapeHtml(tn('pillTwins', pr.twins.length))}</button>`;
}

// The twins blink where they are, like a card that just arrived: no scroll, so the board
// stays where you were reading it. Folded groups and columns open, and a counter isolating
// one column lets go, so they can be seen.
const TWIN_GLOW_MS = GLOW_FADE_MS + 6000;
const twinGlow = new Map();
let twinGlowTimer = null;

function glowTwins(id) {
  const twins = prById(id)?.twins ?? [];
  if (!twins.length) return;
  expandGroups(twins.map(twin => `${twin.side === 'mine' ? 'mine' : 'reviews'}:${prById(twin.id)?.bucket}`));
  state.focus = null;
  const until = Date.now() + TWIN_GLOW_MS;
  for (const twin of twins) twinGlow.set(twin.id, until);
  render();
  const shown = twins.filter(twin => viewRoot().querySelector(`.card[data-id="${CSS.escape(twin.id)}"]`)?.offsetParent);
  // Filtered out, snoozed and hidden, or a view with no cards: the PR itself is the next best place.
  if (!shown.length) window.open(twins[0].url, '_blank', 'noopener');
  clearTimeout(twinGlowTimer);
  twinGlowTimer = setTimeout(() => {
    render();
    twinGlowTimer = setTimeout(() => {
      for (const [twinId, end] of twinGlow) if (end <= Date.now()) twinGlow.delete(twinId);
      render();
    }, GLOW_FADE_MS + 20);
  }, TWIN_GLOW_MS - GLOW_FADE_MS);
}

const REVIEWER_BADGES = { approved: '✓', changes: '✕', dismissed: '↺', commented: '…', pending: '' };

function reviewersHtml(pr) {
  if (pr.side !== 'mine' || pr.state !== 'OPEN' || !pr.reviewers?.length) return '';
  const shown = pr.reviewers.slice(0, MAX_FACES);
  const hidden = pr.reviewers.slice(MAX_FACES);
  const faces = shown
    .map(person =>
      `<a class="reviewer ${person.state}" href="https://github.com/${encodeURIComponent(person.login)}" target="_blank" rel="noopener"`
      + ` title="${escapeHtml(t(`reviewer_${person.state}`, { login: person.login }))}">`
      + `<img src="${escapeHtml(avatarSrc(person, 48))}" alt="" loading="lazy">`
      + `<span class="reviewer-badge">${REVIEWER_BADGES[person.state]}</span></a>`)
    .join('');
  const more = hidden.length
    ? `<span class="reviewers-more" title="${escapeHtml(hidden.map(person => t(`reviewer_${person.state}`, { login: person.login })).join('\n'))}">+${hidden.length}</span>`
    : '';
  return `<span class="sep reviewers"><span class="reviewers-label">${escapeHtml(t('reviewersLabel'))}</span>`
    + `<span class="reviewers-faces">${faces}</span>${more}</span>`;
}

// Whoever the PR waits on: its author from the review side, the reviewers yet to approve from mine.
// Shown only once one of them is online, by refreshNudges().
function nudgeButton(pr) {
  if (pr.state !== 'OPEN') return '';
  const who = pr.side === 'mine'
    ? (pr.reviewers ?? []).filter(person => !['approved', 'dismissed'].includes(person.state)).map(person => person.login)
    : [pr.author];
  const others = who.filter(login => login && login.toLowerCase() !== String(state.data?.me ?? '').toLowerCase());
  if (!others.length) return '';
  return `<button type="button" class="nudge-btn" data-nudge-who="${escapeHtml(others.join(','))}" hidden>${ICONS.bell}</button>`;
}

function cardHtml(pr, threadsToShow, extraPills) {
  const open = state.open.has(pr.id) ? ' open' : '';
  const count = threadsToShow.length;
  const note = cardNotes.get(pr.id);
  const editingNote = state.editingNote === pr.id;
  const glow = glowAttrs(pr);
  const expander = extra => `<button type="button" class="expander${extra}">${open ? '▾' : '▸'} ${tn('threads', count)}</button>`;

  return `
    <div class="card ${pr.bucket}${pipelineClass(pr)}${pr.approved ? ' approved' : ''}${state.snoozed.has(pr.id) ? ' snoozed' : ''}${editingNote ? ' editing-note' : ''}${(hubNudged.get(pr.url) ?? 0) > Date.now() ? ' wizzed' : ''}${glow.cls}${open}" data-id="${pr.id}" data-pr-url="${escapeHtml(pr.url)}"${glow.style}>
      <div class="card-top">
        ${repoChip(pr)}
        <a class="title" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(pr.title)}</a>
        <span class="age" title="${t('openedTitle', { date: onDate(pr.createdAt) })}">${t('opened', { v: ago(pr.createdAt) })}</span>
        <span class="age active-top" title="${t('openedTitle', { date: onDate(pr.createdAt) })}">${t('activeAgo', { v: ago(pr.lastActivityAt) })}</span>
      </div>
      <div class="meta">
        ${pr.isDraft ? pill('draft', t('pillDraft')) : ''}
        ${extraPills.join('')}
        ${twinsPill(pr)}
        ${ciPill(pr)}
        ${pr.side === 'mine' && pr.mergeable === 'CONFLICTING'
          ? (freshOn(pr, 'conflict') ? pill('alert fresh', t('pillConflicts'), t('sinceFreshTitle')) : pill('alert', t('pillConflicts')))
          : ''}
        <span>+${pr.additions}/−${pr.deletions} · ${t('files', { n: pr.changedFiles })}</span>
        <span class="sep activity" title="${t('agoTitle')}">${t('activeAgo', { v: ago(pr.lastActivityAt) })}</span>
        ${whoHtml(pr)}
        ${reviewersHtml(pr)}
        ${count ? expander(' in-meta') : ''}
      </div>
      ${reasonsHtml(pr)}
      <div class="card-foot">
        ${count ? expander('') : '<span></span>'}
        <div class="card-actions">
          <button type="button" class="note-btn${note ? ' has-note' : ''}"
            title="${escapeHtml(t(note ? 'noteTitleEdit' : 'noteTitleAdd'))}" data-note="${pr.id}">${NOTE_ICON}</button>
          <button type="button" class="copy-btn" title="${escapeHtml(t('copyLinkTitle'))}" data-copy-link="${pr.id}">${COPY_ICON}</button>
          ${nudgeButton(pr)}
          <button type="button" class="snooze" title="${t('snooze')}" data-snooze="${pr.id}">${state.snoozed.has(pr.id) ? `${PAUSE} ${t('snoozedBadge')}` : PAUSE}</button>
          ${labelButtons(pr)}
          ${linearLink(pr)}
          ${pr.claudeSession
            ? `<button type="button" class="claude-link${resuming.has(pr.id) ? ' busy' : ''}" data-claude="${pr.id}" title="${escapeHtml(t('claudeTitle'))}">${CLAUDE_ICON}</button>`
            : ''}
          ${pr.slackUrl
            ? `<a class="slack-link" href="${escapeHtml(pr.slackUrl)}" target="_blank" rel="noopener"`
              + ` title="${escapeHtml(t('slackTitle'))}">${SLACK_ICON}</a>`
            : ''}
        </div>
      </div>
      ${editingNote
        ? `<div class="note-editor"><textarea placeholder="${escapeHtml(t('notePlaceholder'))}">${escapeHtml(note)}</textarea></div>`
        : note
          ? `<div class="note-text">${linkifyNote(note)}</div>`
          : ''}
      ${count ? `<div class="threads">${threadsToShow.map(threadHtml).join('')}</div>` : ''}
    </div>`;
}

// Classification belongs to the server; these two add only what needs the chosen
// language or the palette. They used to recompute `needsAction` and `bucket` because the
// "hide bots" filter changed the inputs underneath — without it, recomputing would be a
// second copy of the same rules, free to drift from the first.
function resolveMine(pr) {
  return {
    ...pr,
    waiting: pr.waitingOnThem,
    // The pills already say the remark count, the CI and the conflicts: only the name of
    // the reviewer who requested changes adds something found nowhere else.
    displayReasons: pr.reasons
      .filter(r => r.kind === 'changes-requested')
      .map(r => t('reasonChangesRequested', { authors: r.authors.join(', ') })),
    // My approved PRs have their own group now ("ready to merge"), never a green "idle".
    approved: false,
  };
}

function resolveReview(pr) {
  // Bot threads never enter answered/awaiting — I have not taken part in them — so on the
  // review side they would be entirely invisible. Grouped per bot: 29 remarks from a
  // linter and 29 from a review bot do not call for the same thing.
  const botsByLogin = new Map();
  for (const thread of pr.threads) {
    if (!thread.fromBot || thread.isResolved) continue;
    const login = thread.author.replace(/\[bot\]$/, '');
    botsByLogin.set(login, (botsByLogin.get(login) ?? 0) + 1);
  }

  return {
    ...pr,
    answered: pr.answeredToMe,
    awaiting: pr.awaitingAuthor,
    bots: [...botsByLogin.entries()]
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count),
    displayReasons: pr.reasons.some(r => r.kind === 'recheck') ? [t('reasonRecheck')] : [],
    approved: pr.bucket === 'idle' && pr.myLatestVerdict === 'APPROVED',
  };
}

// A merge into anything but the repo's default branch has not shipped, whatever the
// pipeline says — a stacked feature branch can carry a green, settled-looking outcome of
// its own. `mergeTarget` is only ever the branch name, computed server-side, and only
// when it differs from the default; shared by both sides so a reviewed PR's card cannot
// say something different from one's own.
function mergeTargetBadge(pr) {
  if (!pr.merged || !pr.mergeTarget) return '';
  // The raw name, unedited — a thread's file path never gets rewritten either, and a
  // stripped `feature/` prefix would silently misrepresent a `hotfix/` or `release/`
  // branch the same shortcut does not apply to.
  return `<span class="branch-badge" title="${escapeHtml(t('mergedIntoTitle', { branch: pr.mergeTarget }))}">`
    + `${escapeHtml(pr.mergeTarget)}</span>`;
}

// The pills a card wears, extracted so the orbit view's hover card cannot drift from
// them: one PR, one set of pills, whichever view is drawing it.
// Shared by both sides: a merge's outcome is the same fact whichever column shows it, and
// this used to exist only in minePills — a reviewed PR's card had nothing to read once
// ciPill stopped covering for it, just a background breathing amber with no word for why.
function mergeOutcomePills(pr) {
  const pills = [
    `<span title="${escapeHtml(t('mergedTitle', { date: onDate(pr.mergedAt) }))}">`
    + `${t('pillMergedAgo', { v: ago(pr.mergedAt) })}</span>${mergeTargetBadge(pr)}`,
  ];
  // Four outcomes: broken, published, still running, or no signal at all. That last
  // one is not "running" — nothing was ever posted to this merge commit, and nothing
  // ever will be, so no pill claims a decision is imminent when none is coming. And on
  // a stacked branch, "done" only ever means the branch's own checks passed, never that
  // a release went out — forest-rails#803 had real green checks yet sat nowhere near
  // main, so the badge above already says what needs saying and this pill stays quiet.
  if (pr.pipelineOutcome === 'failed') {
    // Named after the workflow that broke, linking to its run: "release failed" said the
    // same thing of a broken notifier and of a broken deploy.
    const failure = pr.pipelineFailure;
    const label = failure?.workflow ? t('pipelineFailedNamed', { workflow: failure.workflow }) : t('pipelineFailed');
    pills.push(failure?.url
      ? `<a class="pill alert${freshOn(pr, 'releaseFailed') ? ' fresh' : ''}" href="${escapeHtml(failure.url)}" target="_blank" rel="noopener"`
        + ` title="${escapeHtml(t('pipelineFailedTitle'))}">${escapeHtml(label)}</a>`
      : pill(freshOn(pr, 'releaseFailed') ? 'alert fresh' : 'alert', escapeHtml(label)));
  } else if (pr.pipelineOutcome === 'done' && !pr.mergeTarget) {
    pills.push(
      pr.release
        ? `<a class="pill good" href="${escapeHtml(pr.release.url)}" target="_blank" rel="noopener"`
          + ` title="${escapeHtml(t(pr.release.exact ? 'releaseTagExact' : 'releaseTag'))}">${escapeHtml(pr.release.tag)}</a>`
        : pill('good', t('pipelineDone')),
    );
  } else if (pr.pipelineOutcome === 'running') {
    pills.push(`<span class="pill pending running">${t('pipelineRunning')}</span>`);
  }
  return pills;
}

function minePills(pr) {
  const pills = pr.merged ? mergeOutcomePills(pr) : [];
  // A PR opened by someone else only lands here because I took it over: unsaid, its
  // presence in "my PRs" is unexplainable.
  if (pr.author !== state.data.me) pills.push(pill('', t('pillTakenOver', { author: pr.author })));
  if (!pr.merged && pr.toFix.length) pills.push(pill('todo', t('pillToFix', { n: pr.toFix.length })));
  if (!pr.merged && pr.reviewDecision === 'APPROVED') pills.push(pill('good', t('pillApproved')));
  if (!pr.merged && pr.waiting.length) pills.push(pill('pending', t('pillWaitingReply', { n: pr.waiting.length })));
  return [...pills, ...pluginPills(pr)];
}

function mineCard(pr) {
  return cardHtml(pr, [...pr.toFix, ...pr.waiting], minePills(pr));
}

function reviewPills(pr) {
  // Same outcome pills as my own merges — a merge commit's pipeline is the same fact
  // whichever side reviews it. Used to stop at the age line here, on the idea that a
  // verdict pill ("I approved") still said something once merged; it never said whether
  // the release had landed, so a card could only breathe amber with no word for why.
  const pills = pr.merged ? mergeOutcomePills(pr) : [];
  if (pr.claimed) pills.push(pill('', t('pillClaimed'), t('pillClaimedTitle')));
  for (const reason of pr.reasons.filter(r => r.kind === 'claim')) pills.push(pill('todo', reason.text ? escapeHtml(reason.text) : t('pillToReview')));
  if (pr.reviewOwedByMe && !pr.iHaveReviewed) pills.push(pill('todo', t('pillToReview')));
  if (pr.reRequested) pills.push(pill('todo', t('pillReRequested')));
  if (pr.answered.length) pills.push(pill('todo', tn('pillAnswers', pr.answered.length)));
  if (pr.awaiting.length) pills.push(pill('pending', t('pillAwaitingFix', { n: pr.awaiting.length })));
  if (pr.myLatestVerdict === 'CHANGES_REQUESTED') pills.push(pill('pending', t('pillIRequested')));
  if (pr.myLatestVerdict === 'APPROVED') pills.push(pill('good', t('pillIApproved')));
  // When the card already carries the "new commits…" line, the pill merely repeats it.
  if (pr.pushedSinceMyFeedback && !pr.displayReasons.length) pills.push(pill('', t('pillPushed')));
  // Neutral: a bot having plenty to say is context, not something asked of me.
  for (const bot of pr.bots.slice(0, MAX_BOT_PILLS)) {
    pills.push(pill(
      '',
      `${escapeHtml(bot.login)} ${bot.count}`,
      tn('pillBotTitle', bot.count, { login: bot.login }),
    ));
  }
  return [...pills, ...pluginPills(pr)];
}

function reviewCard(pr) {
  return cardHtml(pr, [...pr.answered, ...pr.awaiting], reviewPills(pr));
}
