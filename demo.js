'use strict';

// A fixed board covering every state the page can draw, for showing the tool without
// waiting for real PRs to be in each one. The nodes are shaped like GitHub's answer and go
// through the real classification, so the demo cannot drift from what the board does.

const { baseShape, decorateMine, decorateReview, byActionThenFreshness, mergedSince } = require('./github');

const ME = 'matthv';
const ORG = 'ForestAdmin';
const LINEAR_URL = 'https://linear.app/forestadmin';
const MIN = 60 * 1000;
const ago = minutes => new Date(Date.now() - minutes * MIN).toISOString();

// ForestAdmin members who committed in the last two weeks, with their GitHub ids pinned
// here: the demo makes no call, so it cannot look them up.
const GITHUB_IDS = {
  [ME]: 10195400,
  hercemer42: 19731909,
  PMerlet: 16166196,
  nbouliol: 9134195,
  Scra3: 16675775,
  Tonours: 1331358,
  bexchauveto: 6225107,
  'christophebrun-forest': 272751735,
  ShohanRahman: 29493651,
};

const avatarOf = login => (GITHUB_IDS[login] ? `https://avatars.githubusercontent.com/u/${GITHUB_IDS[login]}?v=4` : null);
const user = login => ({ __typename: 'User', login, avatarUrl: avatarOf(login) });
const bot = login => ({ __typename: 'Bot', login });

let seq = 0;

function node({
  repo,
  number,
  title,
  author = ME,
  createdMin = 3 * 24 * 60,
  commitMin = createdMin,
  committer = author,
  draft = false,
  mergeable = 'MERGEABLE',
  decision = null,
  ci = 'SUCCESS',
  labels = [],
  reviews = [],
  comments = [],
  threads = [],
  requested = [],
  merged = null,
  additions = (number * 37) % 380 + 14,
  deletions = (number * 13) % 90 + 2,
  changedFiles = (number % 11) + 2,
  coAuthors = [],
}) {
  const url = `https://github.com/${repo}/pulls`;
  const id = `DEMO_${repo.split('/')[1]}_${number}`;
  return {
    id,
    number,
    title,
    url,
    state: merged ? 'MERGED' : 'OPEN',
    isDraft: draft,
    createdAt: ago(createdMin),
    updatedAt: ago(Math.min(createdMin, commitMin)),
    mergeable,
    merged: Boolean(merged),
    mergedAt: merged ? ago(merged.min) : null,
    baseRefName: merged?.base ?? 'main',
    mergeCommit: merged ? merged.commit : null,
    reviewDecision: decision,
    additions,
    deletions,
    changedFiles,
    author: user(author),
    repository: {
      nameWithOwner: repo,
      defaultBranchRef: { name: 'main' },
      latestRelease: merged?.release
        ? { tagName: merged.release, url: `https://github.com/${repo}/releases`, publishedAt: ago(merged.min - 5) }
        : null,
    },
    labels: { nodes: labels },
    head: {
      nodes: [{ commit: { committedDate: ago(commitMin), author: { user: user(committer) }, statusCheckRollup: ci ? { state: ci } : null } }],
    },
    recent: { nodes: [author, ...coAuthors, committer].map(login => ({ commit: { author: { user: user(login) } } })) },
    reviews: {
      nodes: reviews.map(([login, state, min, body = '']) => ({
        id: `R_${++seq}`,
        author: login.endsWith('app') ? bot(login) : user(login),
        state,
        body,
        submittedAt: ago(min),
        url,
      })),
    },
    comments: {
      nodes: comments.map(([login, min, body]) => ({ author: user(login), createdAt: ago(min), url, body })),
    },
    reviewRequests: {
      nodes: requested.map(r => ({
        requestedReviewer: r.startsWith('@team/') ? { __typename: 'Team', name: r.slice('@team/'.length) } : { __typename: 'User', login: r },
      })),
    },
    reviewThreads: {
      nodes: threads.map(({ path, line = 42, resolved = false, messages }) => ({
        id: `T_${++seq}`,
        isResolved: resolved,
        isOutdated: false,
        path,
        line,
        comments: {
          totalCount: messages.length,
          nodes: messages.map(([login, min, body]) => ({
            author: login.endsWith('app') ? bot(login) : user(login),
            body,
            createdAt: ago(min),
            url,
          })),
        },
      })),
    },
  };
}

const suite = (name, status, conclusion, runs = 3) => ({
  status,
  conclusion,
  checkRuns: { totalCount: runs },
  workflowRun: { event: 'push', url: 'https://github.com/ForestAdmin/forestadmin-server/actions', workflow: { name } },
});

const LABEL = {
  bug: { name: 'bug', color: 'd73a4a' },
  feature: { name: 'feature', color: '0e8a16' },
  breaking: { name: 'breaking change', color: 'b60205' },
};

function minePrs() {
  return [
    node({
      repo: 'ForestAdmin/forestadmin', number: 10012,
      title: 'feat(inbox): PRD-812 show the automation status of each inbox in the settings panel',
      createdMin: 26 * 60, commitMin: 5 * 60, decision: 'REVIEW_REQUIRED', labels: [LABEL.feature],
      threads: [
        { path: 'app/features/inbox/settings/component.ts', line: 88, messages: [['christophebrun-forest', 40, 'This sentence reads as an error while the inbox is just paused. Could we soften it and link to the workflow settings?']] },
        { path: 'app/features/inbox/settings/template.hbs', line: 12, resolved: true, messages: [['macroscopeapp', 5 * 60, '🟡 **Medium** missing translation key for the paused state'], [ME, 4 * 60, 'Fixed in the last commit.']] },
      ],
    }),
    node({
      repo: 'ForestAdmin/forestadmin-server', number: 8561,
      title: 'feat(inbox): PRD-812 expose the automation status on the inbox endpoint',
      createdMin: 26 * 60, commitMin: 6 * 60, decision: 'CHANGES_REQUESTED',
      reviews: [['Scra3', 'CHANGES_REQUESTED', 90, 'The status is computed on every list call: it needs to be cached or moved to the detail route.']],
    }),
    node({
      repo: 'ForestAdmin/agent-nodejs', number: 1951,
      title: 'fix(datasource-sql): keep the schema prefix on native query connections',
      createdMin: 2 * 24 * 60, commitMin: 25, decision: 'REVIEW_REQUIRED', ci: 'FAILURE', labels: [LABEL.bug],
      requested: ['hercemer42'],
    }),
    node({
      repo: 'ForestAdmin/agent-ruby', number: 402,
      title: 'feat(rpc): support smart actions on related collections',
      createdMin: 4 * 24 * 60, commitMin: 3 * 24 * 60, mergeable: 'CONFLICTING', decision: 'REVIEW_REQUIRED',
      requested: ['Tonours'],
    }),
    node({
      repo: 'ForestAdmin/forestadmin-server', number: 8557,
      title: 'fix(workflow): release the run lock when the executor times out',
      createdMin: 2 * 24 * 60, commitMin: 30 * 60,
      reviews: [['Scra3', 'APPROVED', 5 * 60]],
      merged: { min: 75, commit: { checkSuites: { nodes: [suite('CI', 'COMPLETED', 'SUCCESS'), suite('Deploy production', 'COMPLETED', 'FAILURE')] } } },
    }),
    node({
      repo: 'ForestAdmin/forestadmin', number: 10008,
      title: 'feat(inbox): confirm before switching an inbox with waiting records to automatic',
      createdMin: 2 * 24 * 60, commitMin: 12, decision: 'APPROVED', ci: 'PENDING',
      reviews: [['christophebrun-forest', 'APPROVED', 2 * 60]],
    }),
    node({
      repo: 'ForestAdmin/agent-nodejs', number: 1948,
      title: 'feat(ai-proxy): skip OAuth connectors the request carries no token for',
      createdMin: 3 * 60, decision: 'REVIEW_REQUIRED', requested: ['ShohanRahman', '@team/agents'],
      additions: 48, deletions: 6, changedFiles: 3,
    }),
    node({
      repo: 'ForestAdmin/forest-rails', number: 826,
      title: 'fix(projection): include the foreign key a smart field preload reads',
      createdMin: 2 * 24 * 60, commitMin: 26 * 60, decision: 'REVIEW_REQUIRED',
      threads: [{ path: 'app/services/forest_liana/resources_getter.rb', line: 214, messages: [['nbouliol', 6 * 60, 'Why not preload the whole association here?'], [ME, 3 * 60, 'It would load every column of the target: only the key is read by the smart field.']] }],
    }),
    node({
      repo: 'ForestAdmin/agent-nodejs', number: 1945,
      title: 'feat(executor): poll up to ten pending runs at once',
      createdMin: 2 * 24 * 60, commitMin: 26 * 60,
      reviews: [['hercemer42', 'APPROVED', 3 * 60]],
      merged: { min: 8, commit: { checkSuites: { nodes: [suite('CI', 'COMPLETED', 'SUCCESS'), suite('Release', 'IN_PROGRESS', null)] } } },
    }),
    node({
      repo: 'ForestAdmin/agent-ruby', number: 395,
      title: 'feat(capabilities): announce native query support',
      createdMin: 3 * 24 * 60, commitMin: 28 * 60,
      reviews: [['PMerlet', 'APPROVED', 22 * 60]],
      merged: { min: 20 * 60, release: 'v1.5.0', commit: { checkSuites: { nodes: [suite('CI', 'COMPLETED', 'SUCCESS'), suite('Release', 'COMPLETED', 'SUCCESS')] } } },
    }),
    node({
      repo: 'ForestAdmin/forestadmin', number: 9990,
      title: 'feat(collaboration): mention a teammate from a record note',
      createdMin: 5 * 24 * 60, commitMin: 2 * 24 * 60, draft: true, ci: null,
    }),
    node({
      repo: 'ForestAdmin/agent-nodejs', number: 1939,
      title: 'fix(express): relay the parsed JSON body when the host app parses first',
      author: 'hercemer42', createdMin: 4 * 24 * 60, commitMin: 50, committer: ME, coAuthors: ['hercemer42'],
      decision: 'REVIEW_REQUIRED', requested: ['Scra3'],
    }),
  ];
}

function reviewPrs() {
  return [
    [node({
      repo: 'ForestAdmin/forest-rails', number: 830,
      title: 'fix(permissions): serve a smart field named like a hidden relation',
      author: 'nbouliol', createdMin: 35, requested: [ME], additions: 76, deletions: 5, changedFiles: 4,
    }), true],
    [node({
      repo: 'ForestAdmin/agent-nodejs', number: 1943,
      title: 'fix(executor): PRD-845 reject an AI decision outside the declared options',
      author: 'hercemer42', createdMin: 2 * 24 * 60, commitMin: 26 * 60,
      threads: [{ path: 'packages/workflow-executor/src/decision.ts', line: 31, messages: [[ME, 5 * 60, 'What happens to the run when the option is rejected: retried or failed?'], ['hercemer42', 45, 'Failed with a clear reason, and the operator can retry from the inbox.']] }],
    }), false],
    [node({
      repo: 'ForestAdmin/forestadmin-server', number: 8549,
      title: 'feat(inbox): PRD-845 require the On data change trigger on automated workflows',
      author: 'christophebrun-forest', createdMin: 3 * 24 * 60, commitMin: 30,
      reviews: [[ME, 'CHANGES_REQUESTED', 20 * 60, 'The check must also run when the workflow is edited, not only when the inbox is saved.']],
    }), false],
    [node({
      repo: 'ForestAdmin/agent-ruby', number: 404,
      title: 'feat(search): extended search on related string fields',
      author: 'PMerlet', createdMin: 2 * 24 * 60, commitMin: 30 * 60,
      threads: [{ path: 'lib/forest_admin_agent/utils/search.rb', line: 57, messages: [[ME, 4 * 60, 'Should this skip polymorphic relations? They have no target table to join.']] }],
    }), false],
    [node({
      repo: 'ForestAdmin/forestadmin', number: 10004,
      title: 'feat(charts): leaderboard from the parent collection',
      author: 'Scra3', createdMin: 4 * 24 * 60, commitMin: 2 * 24 * 60,
      reviews: [[ME, 'CHANGES_REQUESTED', 26 * 60, 'The join drops the parent columns: the leaderboard needs them to group.']],
    }), false],
    [node({
      repo: 'ForestAdmin/agent-nodejs', number: 1942,
      title: 'feat(inbox): PRD-845 log why an automated inbox route fails',
      author: 'bexchauveto', createdMin: 2 * 24 * 60, commitMin: 28 * 60, decision: 'APPROVED',
      reviews: [[ME, 'APPROVED', 6 * 60]],
    }), false],
    [node({
      repo: 'ForestAdmin/forestadmin-server', number: 8528,
      title: 'fix(ai-proxy): drop token-less OAuth connectors silently',
      author: 'hercemer42', createdMin: 2 * 24 * 60, commitMin: 26 * 60,
      reviews: [[ME, 'APPROVED', 9 * 60]],
      merged: { min: 3 * 60, release: 'v2.214.0', commit: { checkSuites: { nodes: [suite('CI', 'COMPLETED', 'SUCCESS')] } } },
    }), false],
  ];
}

// Held back until the first manual refresh: something has to arrive while the audience
// watches, or the sound and the glowing rail never show. Every manual refresh after that
// takes it away or brings it back, so the moment can be replayed.
const surprise = () => [node({
  repo: 'ForestAdmin/agent-nodejs', number: 1955,
  title: 'feat(workflow): resume a paused run from the inbox',
  author: 'Scra3', createdMin: 1, requested: [ME], additions: 214, deletions: 18, changedFiles: 9,
}), true];

let surpriseShown = false;

function payload(force) {
  if (force) surpriseShown = !surpriseShown;

  const mine = minePrs().map(pr => decorateMine(baseShape(pr, ME))).sort(byActionThenFreshness);
  const reviews = [...(surpriseShown ? [surprise()] : []), ...reviewPrs()]
    .map(([pr, owed]) => decorateReview(baseShape(pr, ME), ME, owed))
    .sort(byActionThenFreshness);

  // Not every PR gets announced: a draft, a review requested a minute ago, a few others.
  const unannounced = new Set([1955, 8561]);
  const announced = pr => !pr.isDraft && !unannounced.has(pr.number);
  const withSlack = pr => ({ ...pr, slackUrl: announced(pr) ? 'https://app.slack.com/client' : null });
  // Your own PRs are the ones written in a Claude session; a review seldom is.
  const withLinks = pr => ({ ...withSlack(pr), claudeSession: pr.side === 'mine' });

  return {
    me: ME,
    org: ORG,
    maxAgeDays: 60,
    mergedSince: new Date(mergedSince()).toISOString(),
    warnings: [],
    fetchedAt: new Date().toISOString(),
    demoNotes: {
      'DEMO_forestadmin_10008': 'Merger après la démo produit de vendredi : Christophe veut la montrer avant.',
      'DEMO_forestadmin-server_8549': 'Demandé en DM, à repasser dès son push : https://app.slack.com/client',
    },
    mine: mine.map(withLinks),
    reviews: reviews.map(withLinks),
    counts: {
      hiddenStale: 7,
      seenTotal: mine.length + reviews.length + 7,
      mineTotal: mine.length,
      mineAction: mine.filter(p => p.needsAction).length,
      reviewsTotal: reviews.length,
      reviewsAction: reviews.filter(p => p.needsAction).length,
      reviewsWaitingFix: reviews.filter(p => p.bucket === 'waiting').length,
    },
  };
}

const update = {
  behind: 2,
  current: 'demo000',
  latest: 'demo-update',
  titles: ['feat(board): ready to merge, a group of its own', 'feat(sound): your own notification sound'],
};

// One line per PR the page asks about, the way the model answers: numbers first, then what
// the change does and what it changes. PRD-812 spans two repos and PRD-845 three PRs,
// each sharing one line, as a ticket does in real notes.
const SUMMARIES = {
  10012: ['Chaque boîte de réception affiche son état d\'automatisation dans les réglages, calculé côté serveur. Les opérateurs voient tout de suite pourquoi une boîte ne démarre pas toute seule.',
    'Each inbox shows its automation status in the settings, computed on the server. Operators see at once why an inbox does not start on its own.'],
  1951: ['Le préfixe de schéma est conservé sur les connexions de requêtes natives. Les requêtes SQL brutes visent la bonne base quand plusieurs schémas coexistent.',
    'The schema prefix is kept on native query connections. Raw SQL queries hit the right database when several schemas coexist.'],
  402: ['Les smart actions deviennent disponibles sur les collections liées via RPC. Une action se lance depuis une fiche liée sans repasser par la collection d\'origine.',
    'Smart actions become available on related collections through RPC. An action runs from a related record without going back to its own collection.'],
  8557: ['Le verrou d\'un run est libéré quand l\'exécuteur dépasse son délai. Plus aucun run ne reste bloqué jusqu\'à l\'expiration du verrou.',
    'A run lock is released when the executor times out. No run stays stuck until its lock expires any more.'],
  10008: ['Passer une boîte en automatique annonce combien de dossiers en attente vont démarrer, et demande confirmation au-delà de 100. L\'administrateur mesure l\'impact avant de valider.',
    'Switching an inbox to automatic says how many waiting records will start, and asks for confirmation above 100. The admin weighs the impact before committing.'],
  1948: ['Les connecteurs OAuth sans jeton sont ignorés par le proxy IA. Les logs ne remontent plus d\'échecs d\'authentification qui n\'en sont pas.',
    'The AI proxy skips OAuth connectors that carry no token. Logs no longer report authentication failures that are not real ones.'],
  826: ['La projection inclut la clé étrangère que lit le préchargement d\'un smart field. Les smart fields qui passent par une relation affichée fonctionnent de nouveau.',
    'The projection includes the foreign key a smart field preload reads. Smart fields reading through a displayed relation work again.'],
  1945: ['L\'exécuteur traite jusqu\'à dix runs en attente à la fois. Les boîtes automatisées se vident plusieurs fois plus vite.',
    'The executor handles up to ten pending runs at once. Automated inboxes drain several times faster.'],
  395: ['L\'agent annonce qu\'il sait exécuter des requêtes natives. Le front active la fonctionnalité sans deviner selon la version.',
    'The agent announces it supports native queries. The front enables the feature without guessing from the version.'],
  9990: ['Brouillon : mentionner un collègue depuis une note de fiche. Il reçoit une notification avec le lien vers la fiche.',
    'Draft: mention a teammate from a record note. They get a notification linking to the record.'],
  1939: ['L\'agent relaie le corps JSON déjà parsé quand l\'application hôte le lit avant lui. Les identifiants OAuth et les confirmations d\'étapes arrivent de nouveau.',
    'The agent relays the parsed JSON body when the host app reads it first. OAuth credentials and step confirmations get through again.'],
  830: ['Un smart field qui porte le nom d\'une relation masquée est de nouveau servi. Revue demandée, à regarder aujourd\'hui.',
    'A smart field named like a hidden relation is served again. Review requested, to look at today.'],
  8549: ['Les boîtes automatisées deviennent plus sûres : le workflow doit déclarer le déclencheur « On data change », une décision IA hors des options est rejetée, et chaque échec de route dit pourquoi. Le log est approuvé ; le déclencheur a un nouveau commit à revérifier et la décision IA une réponse à relire.',
    'Automated inboxes get safer: the workflow must declare the On data change trigger, an AI decision outside the options is rejected, and each failing route says why. The logging is approved; the trigger has a new commit to re-check and the AI decision an answer to read.'],
  404: ['La recherche étendue couvre les champs texte des relations. J\'attends une réponse sur les relations polymorphes.',
    'Extended search covers the string fields of relations. Waiting on the author about polymorphic relations.'],
  10004: ['Le leaderboard se construit depuis la collection parente. J\'attends un correctif sur les colonnes perdues dans la jointure.',
    'The leaderboard is built from the parent collection. Waiting on a fix for the columns lost in the join.'],
  8528: ['Les connecteurs OAuth sans jeton sont ignorés en silence. Fusionnée, publiée en v2.214.0.',
    'Token-less OAuth connectors are dropped silently. Merged, released in v2.214.0.'],
  1955: ['Un run en pause reprend depuis la boîte de réception. Revue demandée à l\'instant.',
    'A paused run resumes from the inbox. Review requested just now.'],
};
const SHARED_LINE = { 8561: 10012, 1942: 8549, 1943: 8549 };

function notesText(board, ids, lang) {
  const index = lang === 'fr' ? 0 : 1;
  const byId = new Map([...board.mine, ...board.reviews].map(pr => [pr.id, pr]));
  const section = (name, list) => {
    const numbers = (Array.isArray(list) ? list : []).map(id => byId.get(id)?.number).filter(Boolean);
    const lines = [];
    const done = new Set();
    for (const number of numbers) {
      const lead = SHARED_LINE[number] ?? number;
      if (done.has(lead) || !SUMMARIES[lead]) continue;
      done.add(lead);
      const covered = [lead, ...Object.keys(SHARED_LINE).map(Number).filter(n => SHARED_LINE[n] === lead)]
        .filter(n => numbers.includes(n));
      lines.push(`- ${covered.map(n => `#${n}`).join(' ')} ${SUMMARIES[lead][index]}`);
    }
    return lines.length ? [`## ${name}`, ...lines, ''] : [];
  };
  return [...section('MINE', ids.mine), ...section('REVIEWS', ids.reviews)].join('\n').trim();
}

async function notes(body) {
  const board = payload(false);
  const count = list => (Array.isArray(list) ? list.length : 0);
  return {
    text: notesText(board, body, body.lang === 'fr' ? 'fr' : 'en'),
    cached: false,
    counts: { mine: count(body.mine), reviews: count(body.reviews) },
  };
}

module.exports = { payload, update, notes, ORG, LINEAR_URL };
