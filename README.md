# PR Radar

A local dashboard for your GitHub pull requests, in two columns:

- **My PRs** — the ones you opened, with whatever is left for you to do on them
  (unaddressed comments, changes requested, red CI, merge conflicts).
- **PRs I review** — the ones you review, telling apart *your move* from
  *waiting on the author to push a fix*.

Each column is grouped by state:

A PR lands in **My PRs** when you opened it **or** when you authored its head
commit — taking over someone else's PR makes the next move yours. Such a card is
marked `taken over from <author>`. As soon as the original author pushes again the
head commit changes and the PR goes back to the review column, so the split
follows reality without any manual step.

| Group | My PRs | PRs I review |
| --- | --- | --- |
| `On my plate` | unaddressed comments, changes requested, red CI, conflicts | review requested and not done, replies to your comments, new commits since your feedback |
| `Waiting` | you replied — the ball is with the reviewers | your open threads / your changes-requested await a fix |
| `Nothing to report` | everything else | everything else |

## Running it

```bash
cd pr-radar
./pr-radar          # starts the server and opens the browser
# or: node server.js
```

No dependencies to install, and nothing to install them with: **use `node`, not
`yarn`**. Yarn 4 refuses to run a script without a lockfile, so `yarn start` would
first want an install — a lockfile, a `.yarnrc.yml`, a `.yarn/` — to manage no
packages at all. `npm test` and `npm start` do work, npm not asking for one.

Authentication reuses your `gh` session (`gh auth status` must be green). A
`GITHUB_TOKEN` in the environment takes precedence over `gh` if you prefer.

## Configuration

Everything lives in a **`.env`** file at the root (`.env.example` is a commented
copy). A variable already exported in your shell wins over the file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PR_RADAR_ORG` | — | GitHub org to scan (**required**) |
| `PORT` | `4321` | Server port |
| `PR_RADAR_MAX_AGE_DAYS` | `60` | Past that, a PR is ignored |
| `PR_RADAR_REFRESH_SECONDS` | `300` | Auto-refresh interval |
| `PR_RADAR_HIDE_DRAFTS` | `false` | Keep draft PRs off the board |
| `PR_RADAR_GITDECK_URL` | `http://localhost:4567` | Link to gitdeck in the header; empty hides it — `.env.example` ships it empty |
| `PR_RADAR_DAILY_NOTES_FROM` / `_UNTIL` | `07:30` / `09:30` | Window in which the standup notes get re-warmed; read fresh on every run, see [Warming them before you look](#warming-them-before-you-look) |
| `PR_RADAR_DAILY_NOTES_INTERVAL_MINUTES` | `10` | How often within that window; baked into the `launchd` job by `daily-notes-install.sh` |
| `GITHUB_TOKEN` | — | Bypasses `gh` |

The server caches its response for **half** of `PR_RADAR_REFRESH_SECONDS`.
Otherwise a poll would land on a barely-valid cache and serve data almost twice
as old as the advertised interval. The **Refresh** button bypasses the cache.

## Where your feedback is looked for

Review feedback does not necessarily live in an inline thread. Three channels are
covered, and all three feed the same classification:

1. **inline threads** — comments on a line of code, each with its own turn and its own
   resolution;
2. **the verdict of a submitted review** — `approve` / `request changes`;
3. **the PR-level discussion** — review bodies and conversation comments, merged
   chronologically into one synthetic thread.

Channel 3 held two bugs in a row, both worth remembering. Its review-body half was
claimed here long before it worked: the query never asked for a review's `body`, and
`awaitingFix` only looked at inline threads and verdicts, so a review saying "a few
things before merge" with no inline comment produced no reason at all and left the PR in
"nothing to report".

Reading it as a *separate* thread was then wrong in the other direction. GitHub shows
review bodies and comments in one timeline because that is what they are — two forms of
the same discussion — so a remark answered in the other form stayed pending for ever: a
reviewer asking for a fix in their review body and the author answering in the
conversation showed up as both "to fix" and "awaiting a reply", one exchange counted
twice. They are one thread now, named after the form the last word took, since that is
the message the excerpt shows.

An **approval's** body is left out of it: a courtesy, not a request, and letting it in
would make approving look like feedback still pending.

Discovery uses four searches — `author:@me`, `reviewed-by:@me`,
`review-requested:@me`, `commenter:@me` — plus the account's **event feed**.

`commenter:` is essential because `reviewed-by:` only matches a **formally
submitted** review, so a PR where you merely wrote in the conversation never shows
up there.

The event feed is there because **GitHub's search index is not reliable**: an
issue comment three days old was observed missing from both `commenter:` and
`involves:` for an open PR, while `repo:… <number>` found the PR fine.
`/users/{me}/events` does not go through that index, so it plugs those holes.
Its window is short by design (300 events, 90 days), and the PRs it yields have
not been through a search filter — so their state and author are checked after
the details are fetched: anything not `OPEN` is dropped, and the rest is split
between the two columns on the real author.

## Ignored PRs

A PR with no real activity for more than `PR_RADAR_MAX_AGE_DAYS` days is dropped.

The criterion is **neither** the creation date **nor** `updated_at`, but the last
real activity: last commit, last human comment, last review. In short,
`max(createdAt, last commit, last non-bot comments and reviews)`.

"New commits since my feedback" ignores commits **you** authored. Without that
guard, a PR you have taken over asks you to re-check your own work.

GitHub's `updated_at` will not do: it moves when a label is added, when
`mergeable` is recomputed, or when CI is re-run. A PR with no commit and no
comment for 204 days still claimed it had been "updated 2 days ago". Bot comments
are excluded for the same reason: a linter passing by does not wake a PR up.

That same timestamp drives the age shown on the card and the column ordering.

The coarse pre-filter on `updated_at` is kept, but deliberately loose: it only
avoids fetching the details of PRs that are dead for certain. The number of
dropped PRs stays visible in the header so the filter is never silent.

## When GitHub only half answers

The five discovery sources are independent, so one timing out no longer wipes the
other four: what answered is kept and an amber banner names what is missing. That
matters most for `author` — a silent gap there would read as "you have no open PRs".
A failing detail batch costs only its six PRs. Only a total outage raises an error.

`mergeable` gets a second pass. GitHub computes it lazily and answers `UNKNOWN`
meanwhile, which the code used to read as "no conflict" — the conflict pill vanished
while nothing had changed on the PR. Pending PRs are re-queried after a short delay.

## When the open page is behind

Refresh fetches data, it does not reload the page, so a tab left open keeps running
the assets it booted with. Every response carries an `X-PR-Radar-Version` header
hashed from the asset mtimes; when it stops matching the one seen at boot, a
**Reload** button appears in the header. Nothing reloads on its own — you may be
mid-read.

The timestamp in the header turns amber past twice the refresh interval: a failed
fetch raises the banner, but a merely late one would otherwise age in silence. It is
re-checked on its own clock rather than at render time, since a render follows its
fetch by milliseconds and the mark would never show. And the page refetches when the
tab becomes visible again — a laptop waking from sleep leaves `setInterval` far
behind.

## Tests

```bash
node --test         # or: npm test
```

Node's built-in runner, no dependency. The suite covers the classification logic,
which is where every bug so far has lived: `updated_at` overstating freshness, bot
comments faking activity, feedback left in the PR conversation, commits you pushed
yourself being flagged as needing your re-check, and a superseded changes-requested
still counting as the latest verdict.

## Watching a merge

A PR leaves the board the moment it is merged — which is the moment its release
pipeline starts. Merges therefore stay in a **Recently merged** group, carrying the
status of the **merge commit**, not of the PR head: what runs after a squash is the
release job on the base branch.

**The window is the previous working day, not a count of hours.** It was twelve rolling
hours, which cannot survive a night: a merge at five in the afternoon was gone by five in
the morning, before anyone could mention it at a standup — and on a Monday no number of
hours reaches Friday. Merges since the start of the previous working day, then, the same
window the standup notes use. `PR_RADAR_MERGED_HOURS` is gone with it.

**A PR you reviewed stays too.** It used to vanish the instant it merged, though "the one
I reviewed shipped" is a line worth having. Other people's merges were kept off the board
because the review side had no notion of a merge and would claim a reply was waiting for
you on something closed; it drops every pending state on a merge now, the way your own
PRs already did, so they can be shown. Only a *submitted review* counts: for a PR you
merely commented on, its landing is not really your news.

The outcome paints the whole card, because after a merge it is the only thing left to
know. Amber while it runs — the outcome is unknown, and green would announce a success
that has not happened — with the card breathing to say the decision is live. Green with
the version tag once published, red and back on your plate if it failed.

**Amber only while something is genuinely in flight.** GitHub's rollup for a merge commit
is `null`, not `PENDING`, when no check was ever posted to it at all — merging into a
branch with no CI configured on push, a stacked feature branch used only to collect other
PRs, say. That is permanent, not a gap before the real answer arrives, so it settles
straight to green rather than breathing forever for a decision that is never coming
— seen on forest-rails#796 and #795, stuck amber for good until this was caught.

**A merge into anything but the repo's default branch wears a small branch badge**, the
same recipe as a thread's file-path chip: a location fact, shown whole, never edited down
(a stripped `feature/` prefix would silently misrepresent a `hotfix/` or `release/` branch
the same shortcut does not cover). It says the code has not shipped the way a merge into
main has, whatever the pipeline outcome claims — a stacked branch can have its own checks
pass clean and still be nowhere near production.

The version comes from the repo's latest release, kept only when it was published after
the merge *and* the merge landed on the default branch — a release is cut from there, so
a merge stacked on a side branch cannot be in it yet. Skipping that check once had
forest-rails#803 wearing a real version tag for code main had not received. It is a
correlation regardless, not something GitHub states outright: two merges minutes apart
would point at the same tag, hence the "latest release since the merge" wording and the
plain "released" fallback for repos that do not tag every merge.

"Mine" means the same here as everywhere on the board: opened by you, or taken over by
you. A colleague's merge is their business — and letting theirs through once had the
review side claiming a reply was waiting for you on a closed PR.

A merged card, like any other, can be dropped with the snooze control: no further
activity will wake it, so there it amounts to dismissing it.

## Snoozing a card

Any card can be snoozed, actionable ones included. Snoozing records the last
activity timestamp seen at that moment, and the card stays hidden only while that
timestamp holds: a new commit, comment or review brings it straight back. It means
*not until something moves*, never *forget this*.

That the guard is activity and not a delay is what makes it safe to offer on a card
that asks something of you: nothing else would bring it back. So the count sits in
the summary band, next to the counters, with the snoozed cards one click away and a
**wake all** next to them. Entries whose PR has moved on are pruned on every render,
so the store cannot drift out of sync with the board.

## Standup notes

A button in the summary band turns the board into notes you can read out at a standup:
one bullet per pull request, in two sections — your own, then the ones you review, where
the second sentence says where each stands so you know what to say about it.

The model is reached through the **`claude` CLI**, so the tool holds no model key — the
same reason GitHub access goes through `gh`. Without that CLI on the PATH the button
never appears rather than failing on click. Summarising needs no tools, no MCP server and
no project context, and loading them cost more than the model call itself, so they are
switched off and the CLI runs from the temp directory.

**One call for the whole board**, not one per pull request: it costs a single wait, and
the model sees the set, so pull requests that are part of one effort read as one. The
description and file list it works from are fetched only then — putting them in the
board's own query would weigh on every refresh for something read once a morning.

Expect **30 to 100 seconds** cold, and nothing at all afterwards: a digest reads the last
board already served rather than refetching one, so it describes what is on screen instead
of something newer, and costs no GitHub round trip. The answer is cached in `.digest-cache.json`, keyed on
the last activity of every pull request in the set, the language, and the prompt itself: a
board that moved earns fresh notes, a second click the same morning is free, and rewording
the prompt invalidates everything, since stored notes would answer a question no longer
being asked.

The notes are prose, not labels, so the `FR` / `EN` toggle rewrites them rather than
translating strings. The other language is written in the background as soon as the first
answer is on screen, which is why switching is instant: generating both at once would
have doubled the wait you actually sit through, for a language you may never ask for.
While a rewrite is in flight the panel dims, since what is on screen still belongs to the
previous answer.

Two ways to narrow what they cover, because they answer different problems:

- **the window**, shown and remembered next to the title, covers the previous working day
  by default — Monday looks back to Friday, and the weekend is included, so nothing pushed
  on a Saturday goes unmentioned. It narrows what is *sent*, never what the board shows:
  the board answers "what needs me now", and hiding a card that asks something of you
  because it is a day old would break that. It knows nothing of public holidays or
  time off; one click widens it to the whole board.
- **dropping a line by hand**, since no filter knows what you will actually mention. The
  clipboard is rebuilt from what is left, and a section emptied that way stops being
  announced.

Each line carries **the time of that PR's real activity, its number and its state**, in
four fixed columns so the day reads down the edge of the panel. The state is read off the
board, never asked of the model: the bucket is already computed, and prose would freeze it
at the moment of writing and let it go stale. The weekday is on every line, today's
included — dropping it there read as an oversight and left the column ragged.

The bullets are ordered **oldest activity first**, the way the day happened rather than
the board's order of urgency, and sorted before the request rather than after the answer,
since the model words each bullet against the order it is given.

Copying gives plain markdown with the headings, the state word included — "merged" is half
of what a standup line says. On screen each PR number links to the pull request it
summarises.

The group markers the model emits are matched as a whole line holding nothing but the
token, hashes or bold optional: it has been seen writing `## MINE`, `MINE` and `**MINE**`
for the same request, and a stricter pattern let the raw marker through as a bullet.

### Warming them before you look

```bash
./daily-notes-install.sh    # schedules the pre-warm, weekday mornings
./daily-notes-uninstall.sh  # and to undo it
node daily-notes.js         # runs it once, right now, to check it works
```

The 30-to-100-second wait is only ever paid once — the point of this script is to pay it
before you open the tab. `daily-notes.js` runs standalone: it never starts the HTTP
server and does not need one running, it only shares the same on-disk
`.digest-cache.json` the server's `/api/digest` reads and writes. Whichever process gets
there first, warm or cold, the other one just finds the cache the first one left —
verified by running the script once, then hitting the live server's endpoint with the
same pull requests: a 0.02s response, `cached: true`.

It pre-warms the full board's default view — both sides, the previous working day, oldest
first — since there is no browser filter to read from an unattended job. **This can only
save time, never make the notes wrong**: if the board moved since the most recent run, or
you had a project filter active, the cache key simply misses and it regenerates at full
cost, exactly as it would with no script installed at all. Both languages are written
every time, since nothing here knows which one you will open to.

**It fires every few minutes through the whole window, not once.** A single fixed time
was tried first and went stale the first real morning it ran: `launchd` fired it right on
schedule — a locked screen does not stop a `LaunchAgent`, only real sleep does, confirmed
from the job's own run log — it wrote the cache, and forty-three ordinary minutes between
that run and the actual click were enough to move the board and miss the cache key
anyway. Repeating narrows that gap to the interval instead of betting everything on one
moment chosen in advance; a run outside the window costs nothing at all, exiting before
any GitHub call, and one inside it still fetches the board but skips the expensive part —
the `claude` spawn — whenever nothing has changed since the last one.

The schedule is a `launchd` **LaunchAgent**
(`~/Library/LaunchAgents/local.pr-radar.daily-notes.plist`), not `cron`, which has no
notion of "asleep right now" at all. `PR_RADAR_DAILY_NOTES_FROM` / `_UNTIL` (`07:30` /
`09:30` by default) and `PR_RADAR_DAILY_NOTES_INTERVAL_MINUTES` (`10`) in `.env` control
it. Only the interval is baked into the plist itself — change it and re-run
`daily-notes-install.sh`. The window is read fresh by `daily-notes.js` on every single
run, so narrowing or widening it needs only an edit to `.env`, no re-install; running it
by hand outside the window would otherwise silently do nothing, which is why
`node daily-notes.js --force` exists, skipping the window check for a manual test.
`node`, `claude` and `gh` are resolved from your own shell at install time and written
into the job as absolute paths, since launchd's own PATH is too bare to find any of them.
A run's own log lands in `.daily-notes.log` — empty runs outside the window write nothing
to it, so it stays readable rather than filling up with a "skipped" line every few minutes
for twenty-two hours a day.

The shaping this needed — turning a handful of ids plus a board into what `standupNotes`
takes — used to live inline in `server.js`'s HTTP handler. It is `digest.pickForDigest`
now, shared by the endpoint and this script, so a change to what a "situation" means
cannot update one caller and quietly leave the other stale.

## Notifications

- The tab title shows the number of pending actions: `(4) PR Radar`.
- A chime plays when that number goes up (**sound** checkbox, remembered). It
  follows the counter, not activity: a PR you just opened yourself lands in
  *waiting on the reviewers* and asks nothing of you, so it stays silent — you came
  from `gh pr create` and know it exists. It rings when a reviewer turns it into
  your move. The first render after opening the page is silent too, or every reload
  would chime.
- Auto-refresh is driven by `PR_RADAR_REFRESH_SECONDS`; the last fetch time sits
  in the header, the exact interval on hover.

## The summary band

**Standup notes** comes first, cut off from the rest by a rule: it writes something,
where everything to its right narrows what is already there. Then the **project
picker**, a searchable list holding only the projects actually on the board, each with
its card count, so it can never offer an empty result — it filters rather than sorts,
since with a dozen repositories in play, grouping them still leaves you scrolling past
the ones you are not working on. Then the count of snoozed cards, then three counters —
your PRs to fix, reviews to handle, PRs awaiting a fix — and the count of PRs the age
window dropped.

The counters **report, they are not controls**. Two of them used to filter, and both
were the `needs work` checkbox with one column collapsed: server-side a PR's `action`
bucket *is* its `needsAction`, so they filtered on the same condition, one column at a
time where the checkbox does both. The third, "awaiting a fix", showed the opposite —
cards that ask nothing of you — and combining it with that checkbox gave a permanently
empty list, which needed a precedence rule to arbitrate. Two controls needing an
arbiter to stop contradicting each other is the sign one of them is surplus.

They still earn their place unclicked: they are the same numbers as the tab title and
the chime, the answer to "is there anything for me" without reading a column. They sit
in the body rather than the header because of that — they summarise the content below,
they are not controls of the tool. The header stays a toolbar and stays pinned; the
summary scrolls away with what it describes.

## Filters and display

The board's own controls live in the summary band; the header holds the tool's, and
nothing else. Three checkboxes used to sit there and were removed rather than moved:

- **needs work** duplicated the grouping. Actionable cards are already gathered at the
  top of each column, so filtering to them only collapsed the groups underneath.
- **hide bots** ignored threads opened by review bots, recomputing each card's group so
  a PR flagged only by a bot fell back to "nothing to report". It was the last reason
  the browser reclassified anything — dropping it let the render layer stop keeping a
  second copy of the server's rules.
- **hide drafts** became `PR_RADAR_HIDE_DRAFTS`: whether drafts belong on the board is
  decided once, not per session.

- 🔊 mutes the chime (remembered).
- `☾` / `☀` toggles light / dark (light by default, remembered).
- A **gitdeck** button in the header opens the local web git client, carrying
  gitdeck's own branch mark so it is recognisable at a glance. It is the mirror of
  PR Radar's own button over there: each tool points at the other with the same
  soft-tinted pill in the host's accent, and the whole toolbar shares gitdeck's
  metrics — one height for every control, so alignment never depends on what a
  control contains.
  It points at `PR_RADAR_GITDECK_URL`; leave that empty and the button disappears,
  so there is no dead control for anyone who does not run gitdeck. `.env.example`
  ships the value empty rather than defaulting to the localhost URL, since an
  unset variable falls back to that default and would show a dead button to
  anyone who never edits this line. No separate boolean flag: the URL already
  carries both the destination and whether to show it, and two variables for
  one decision can contradict each other.
  It is a single global link rather than one per card, because gitdeck keeps the
  selected repo in internal state rather than in the URL, so there is nothing to
  deep-link to.
- `FR` / `EN` toggles the interface language (English by default, remembered).
  State labels are rendered in the browser: the server only emits `kind` values,
  never a sentence, so no text can escape translation.

Click `▸ N open threads` to read the comments without leaving the page. An excerpt
stops at 320 characters, and the ellipsis then carries a **read the rest** link
pointing at the comment anchor rather than the PR, so you land where the excerpt
stopped.

Both columns show who is involved, as a stack of overlapping avatars followed by
the names, comma-separated: the PR author first, then whoever pushed commits, in
the order they entered the PR. A PR you took over therefore reads `its author,
you`. Hovering gives the full chain. Past four people the extra ones collapse into
a `+N`.

Each card carries two ages, both labelled so they cannot be confused: **"opened
X ago"** in the top right (exact date on hover) and **"active Y ago"** in the
state line, which is the real last activity and doubles as the sort key.

## Reading the colours

Colour encodes priority, not severity:

- **indigo → violet** — your move (comments to address, review requested, replies
  for you). Card rail, gradient background, group header and counter.
- **amber** — you are waiting on someone (your open threads, your changes
  requested).
- **emerald** — approved, green CI.
- **brick** — actually broken, and only that: failing CI, merge conflicts.
- **cyan** — the review column's marker and a thread's location (`file.rb:42`,
  `conversation`). Never a state: it is a navigation accent.

Each column carries its own title hue (indigo on the left, cyan on the right) so
you can tell them apart at a glance while scrolling.

Pills carry the state; a reason line only appears for what no pill already says
(the name of the reviewer who requested changes, new commits to re-check).

## Implementation notes

- The PR list goes through the **REST search**: the GraphQL search times out
  (HTTP 499) on a large org. The `node_id` it returns is directly the GraphQL id
  of the `PullRequest`, then loaded in batches of 6.
- The GraphQL body is written to a temporary file: `gh api --input -` does not
  correctly receive a body piped from Node with `gh <= 2.7` — the request goes out
  malformed and GitHub cuts it off. From a shell pipe it works, which makes the
  bug misleading. (`gh auth token` also does not exist before 2.16.)
- Reviews requested **through a team** do not show up: GitHub search requires
  `team-review-requested:org/team`, which is not covered here.
- The synthetic conversation thread excludes bots, but cannot tell a real piece of
  feedback from an "LGTM 🎉": on your own PRs, a trailing congratulatory comment
  counts as something to address.
