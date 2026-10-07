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
| `On my plate` | unaddressed comments, changes requested, red CI, conflicts | a review you owe — requested, or the PR assigned to you — and not done, replies to your comments, new commits since your feedback |
| `Ready to merge` | approved, nothing left open — the one move left is yours | — (the author merges) |
| `Waiting` | you replied — the ball is with the reviewers | your open threads / your changes-requested await a fix |
| `Nothing to report` | drafts, shown as `Drafts` | everything else |

**Ready to merge** sits right under *On my plate* and above the merged group. An approved
PR of yours with nothing left open used to land in *Nothing to report*, green, below
*Recently merged* — and was read as already done, when it only waited for you to merge
it. A CI still running keeps it there (its pill says so); a failing one, a conflict or a
remark sends it back to *On my plate*. Its rail is a gradient, indigo into green: your
move, because it is approved — no new hue, two that already mean exactly that. It has
its own counter in the summary band, so *of my PRs to fix* keeps meaning what to fix, and
it rings and lights its rail when an approval lands, like any card that turns your way.
On my side *Nothing to report* now only ever holds drafts, so it is labelled *Drafts*.

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

### Demo mode

```bash
npm run demo        # http://localhost:4322 (DEMO_PORT to change it)
```

A made-up board showing every state at once, to present the tool without waiting for
real PRs to reach each one. Nothing is fetched: no GitHub, Slack, Claude or git call,
and the real board on 4321 keeps running beside it. Being another port, the demo also
has its own browser state, so snoozes and mute on the real board are left alone.

- The PRs are shaped like GitHub's answer and go through the same classification as
  real ones, so groups, colours and pills are the board's own, and follow when a rule
  changes. `test/demo.test.js` fails if a case stops showing.
- The people are ForestAdmin members who committed recently, avatars included. What
  they say on the cards is invented.
- **Rafraîchir** brings in a new review request, with the sound and the glowing rail;
  the next click takes it back, so the moment can be replayed.
- Standup notes answer at once, with a line written for each PR, and two pieces of work
  told as one: PRD-812 across two repos, PRD-845 across three PRs.
- The PRD-812 and PRD-845 cards link to Linear. Those tickets are made up: the link
  opens whatever Linear has at that number, so do not click it in front of people.
- Two cards carry a note, one with a link. They are written into a browser that has no
  notes yet, so a note typed or deleted while rehearsing stays as you left it.
- The update banner is shown, on made-up commit titles.
- `/intro` is a waiting page for the start of a talk: the logo as a full radar, its
  blips lit as the sweep passes, and the name. Space, Enter, a click or a presenter
  remote's "next" opens the board.

## Configuration

Everything lives in a **`.env`** file at the root (`.env.example` is a commented
copy). A variable already exported in your shell wins over the file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PR_RADAR_ORG` | — | GitHub org to scan (**required**) |
| `PR_RADAR_EXTRA_REPOS` | — | Repos outside that org to scan too, `owner/name`, comma-separated (`matthv/pr-radar`); their chip shows the owner — see [Repos outside the org](#repos-outside-the-org) |
| `PORT` | `4321` | Server port |
| `PR_RADAR_MAX_AGE_DAYS` | `60` | Past that, a PR is ignored |
| `PR_RADAR_REFRESH_SECONDS` | `300` | Full search interval — see [How fresh the board is](#how-fresh-the-board-is) |
| `PR_RADAR_CHECK_SECONDS` | `60` | Free change checks between two full searches; `0` goes back to a full refresh every `PR_RADAR_REFRESH_SECONDS` and nothing else |
| `PR_RADAR_CLAUDE_SESSIONS` | `false` | macOS: a button that resumes the PR's Claude Code session — see [The Claude session](#the-claude-session) |
| `PR_RADAR_TERMINAL` | `Terminal` | Where a session not already running opens: `Terminal`, `iTerm` or `Ghostty` |
| `PR_RADAR_HIDE_DRAFTS` | `false` | Keep draft PRs off the board |
| `PR_RADAR_WEBHOOK_URL` | — | POSTs the status changes to that URL, one call per status with every PR that reached it — see [The webhook](#the-webhook). Empty, no call |
| `PR_RADAR_WEBHOOK_STATUSES` | — | Statuses the webhook sends, comma-separated (`mine.action,reviews.action`); empty sends them all |
| `PR_RADAR_SOUND` | — | Path to a local audio file played instead of the chime, in full; `~` allowed |
| `PR_RADAR_GITDECK_URL` | `http://localhost:4567` | Link to [gitdeck](https://github.com/matthv/gitdeck), a separate personal tool, in the header; empty hides it — `.env.example` ships it empty |
| `PR_RADAR_LINEAR_URL` | — | Linear workspace (`https://linear.app/forestadmin`); a ticket key in a PR's title or branch becomes a link to it, beside the Slack one — see [The Linear ticket](#the-linear-ticket). Empty, no link |
| `PR_RADAR_SLACK_CHANNEL` | — | Channel where the team announces its PRs; each announced card gets a link to its message, read through Claude — see [The Slack announcement link](#the-slack-announcement-link) |
| `PR_RADAR_SLACK_TOKEN` | — | Optional bot token: reads that channel through the Slack API instead of Claude |
| `PR_RADAR_SLACK_WORKSPACE` | `https://forestadmin.slack.com/` | Workspace URL the message links are built on (Claude path) |
| `PR_RADAR_UPDATE_HOURS` | `2` | How often the server checks `origin/main` for newer commits; `0` turns it off — see [When the tool itself is behind](#when-the-tool-itself-is-behind) |
| `PR_RADAR_DAILY_NOTES_FROM` / `_UNTIL` | `07:30` / `09:30` | Window in which the standup notes get re-warmed; read fresh on every run, see [Warming them before you look](#warming-them-before-you-look) |
| `PR_RADAR_DAILY_NOTES_INTERVAL_MINUTES` | `10` | How often within that window; baked into the `launchd` job by `daily-notes-install.sh` |
| `GITHUB_TOKEN` | — | Bypasses `gh` |

The **Refresh** button always runs a full search. With `PR_RADAR_CHECK_SECONDS=0`, the server
caches its response for **half** of `PR_RADAR_REFRESH_SECONDS`: otherwise a poll would land
on a barely-valid cache and serve data almost twice as old as the advertised interval.

## How fresh the board is

The mechanism, with diagrams, is in [docs/live-refresh.md](docs/live-refresh.md).

A full search — eight GitHub searches, the event feed, every PR's details — runs every
`PR_RADAR_REFRESH_SECONDS`, and is the only way to find a **new** PR. In between, the server
keeps the board fresh with requests GitHub answers for free when nothing changed:

| Every | What | Cost |
| --- | --- | --- |
| `PR_RADAR_CHECK_SECONDS` (60 s, never under `/notifications`' `X-Poll-Interval`) | one `GET pulls/{n}` per card with `If-None-Match`, and `GET /notifications` with `If-Modified-Since` | a `304` costs nothing; a change costs one request, then a reload of **that PR only** |
| 30 s, only while something is in flight | a reload of the cards whose head CI is pending or whose release is running | a few PRs, only while they exist |
| `PR_RADAR_REFRESH_SECONDS` | the full search | unchanged |

- **Searches, the scarce quota** (30 a minute, and a secondary limit hit once already),
  never run more often than before. A notification on a PR missing from the board brings
  the next full search forward, but no sooner than 90 s after the last one, so a burst of
  them cannot loop the searches.
- **Your own moves show at once**: a PR made or opened in a Claude session, read from the
  same transcripts as [The Claude session](#the-claude-session), when that feature is on.
  So does a return to the tab after a minute away, likely from GitHub itself.
- **The checks only run while a page is looking.**
  - Each poll of the page renews a ten-minute lease, and a hidden tab spaces the checks
    to five minutes.
  - With no page, the server calls GitHub not at all; the next page to open runs a full
    search.
  - A [webhook](#the-webhook) is the exception: while `PR_RADAR_WEBHOOK_URL` is set the
    checks never stop, and keep their regular pace even behind a hidden tab. With no page,
    the full search spaces out to every 15 minutes.
- **The page asks the server every 20 s.** It is answered from the cache, without a GitHub
  call, and redraws only when the board actually changed: an unchanged board would close a
  note being edited.
- **A reload is reshaped into the board** from the last search's sources (`shapeBoard`).
  A PR the reload does not return is kept as it was, since a lost batch is not a closed PR,
  and the next full search settles it.

`gh api -i` exits with code 1 on a `304`, with the headers on stdout: `watch.js` reads that
as an answer, not a failure. A check that genuinely fails is logged on the server, and the
5-minute full search stays the safety net.

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

Two more review bodies are left out, both found on agent-ruby#398, where a reviewer's
"Spec (PRD-1404): conforms." sat in "to fix" for a day:

- a **commented review that asks nothing** — its body carries a verdict (`conforms`,
  `LGTM`, `looks good`, `nothing to add`…) and none of the words a request is made of
  (`should`, `must`, `missing`, `contradicts`, a question mark…). Code spans are dropped
  before reading, so a `` `can?` `` method name is not a question. It is read
  conservatively: a body with no verdict, or with any such word, stays pending — a glance
  costs less than a missed remark;
- a **review body answered inline** — when you replied, after the review, inside one of
  that review's own inline threads. The body could only be answered at PR level, which
  nobody does when the remark sits on a line; the conversation went where the remark was.

Discovery uses five searches — `author:@me`, `reviewed-by:@me`,
`review-requested:@me`, `assignee:@me`, `commenter:@me` — plus the account's **event
feed**.

`assignee:` is there because a PR does not always carry a formal review request: this
org also hands a review off through the assignees field. agent-nodejs#1912, opened by an
automated author with its human owner only assigned, sat in "nothing to report" until
that search was added; an assignee with no review yet owes one just as a requested
reviewer does.

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

It fires when someone else pushed after your last word, and one of these holds:
- a remark of yours still waits on the author;
- your last verdict requested changes;
- you raised remarks on it and have not approved since. A passing comment does not count
  here: it should not ring on every push.

The last case is forestadmin-server#8561. The author answered all three remarks, the
reviewer resolved them, then new commits came. With nothing left open and a verdict of only
"commented", the card sat in "nothing to report" while the PR waited on that reviewer's
approval.

GitHub's `updated_at` will not do: it moves when a label is added, when
`mergeable` is recomputed, or when CI is re-run. A PR with no commit and no
comment for 204 days still claimed it had been "updated 2 days ago". Bot comments
are excluded for the same reason: a linter passing by does not wake a PR up.

That same timestamp drives the age shown on the card and the column ordering.

The coarse pre-filter on `updated_at` is kept, but deliberately loose: it only
avoids fetching the details of PRs that are dead for certain. The number of
dropped PRs stays visible in the header so the filter is never silent.

## When GitHub only half answers

Each discovery source is independent, so one timing out no longer wipes the others:
what answered is kept and an amber banner names what is missing. That
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

## When the tool itself is behind

The tool has no version number; the commit is the version. Every
`PR_RADAR_UPDATE_HOURS` hours (2 by default, `0` turns it off) the server runs
`git fetch` and counts the commits between its own `HEAD` and `origin/main`. When it is
behind, the page shows an indigo banner — not amber, since nothing is wrong with the
data — with the count, the titles of the commits missed (the first eight, then "and N
more"), and `git pull` to copy. A `×` hides it for that exact remote commit; the next
push brings it back.

Only *behind* counts: being ahead, with commits not pushed yet, is the author's normal
state while working, and a banner there would be noise. Nothing pulls or reloads on its
own — a colleague's clone may carry local changes, and a restart is needed anyway — which
is also why this is a banner and not a modal: the button such a modal would carry could
not do the update, only send you to a terminal.

A failed check (no `git`, a folder downloaded as a zip, no network) is not board data:
it never reaches the warning banner. The page just says nothing about versions, one line
goes to the server's console, and the next tick tries again.

## Tests

```bash
node --test         # or: npm test
```

Node's built-in runner, no dependency. One file per module, each testing the pure functions
that module exports and none of its network calls:

- `test/classification.test.js` — the board's rules, where most bugs have lived:
  `updated_at` overstating freshness, bot comments faking activity, feedback left in the
  PR conversation, commits you pushed yourself flagged for your own re-check, a
  superseded changes-requested still counting, a continue-on-error job failing a release,
  a review body that asks nothing or was answered inline;
- `test/digest.test.js` — shaping a board into what the standup notes take;
- `test/slack.test.js` — reading PR links out of Slack messages, the oldest-wins merge,
  permalinks, the model's transcription, and the retry schedule;
- `test/claude-sessions.test.js` — finding a PR's session in the transcripts, read
  incrementally, a running copy and the terminal it runs in, and the route with its guards;
- `test/update.test.js` — reading `git` output into "behind by N";
- `test/colors.test.js` — a picked colour turned into a repo's tint: sRGB to OKLCH, the hue
  kept and the intensity capped, no ready-made hue reading as a state, the warning for one
  that does;
- `test/order.test.js` — the section order: a saved one read back safely from storage, unknown,
  duplicate and new buckets, and moves before or after;
- `test/watch.test.js` — change detection against a faked `gh`: the first answer as a
  baseline, `304` and `200`, a failed reload read as changed again, notifications in and out
  of scope, `X-Poll-Interval`, the cards in flight, the gap between two searches;
- `test/fetch.test.js` — spending less: a search reusing the PRs it holds, the light status
  read of a running CI, the event feed read again only when it changed;
- `test/scope.test.js` — `PR_RADAR_EXTRA_REPOS` and the search scope it builds;
- `test/demo.test.js` — the demo board still showing every case;
- `test/since.test.js` — what a card says moved since you looked: others' comments, reviews and
  commits but never yours or a bot's, a CI reaching an outcome, a conflict, a merge, a release.

Every real case named in this file has its fixture there, under its PR number.

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

**The outcome is read off the check suites, not the commit's rollup.** A suite's own
conclusion already accounts for `continue-on-error`: it is `SUCCESS` as soon as every
required job passed, even when an optional one failed. The coarse `statusCheckRollup`
does not — it flags the whole commit `FAILURE` because one check run inside a passing
suite failed, which is exactly what a flaky optional test looks like. agent-nodejs#1918
wore red for a day that way, its release job run and published, because its "LLM
Integration Tests" are allowed to fail. Any suite still short of `COMPLETED` means
running; any suite concluded `FAILURE`, `TIMED_OUT` or `STARTUP_FAILURE` means failed.
Suites with zero check runs — apps that only listen for pull-request events and never
fired on this push — are not a signal either way, unless the suite is a GitHub Actions run
not finished yet: a workflow just queued has no job for a minute or two, and taking it for
an app that never fires sent forestadmin-server#8534 straight to settled green two minutes
after its merge, its deploy about to start. The rollup is only the fallback when no suite
data is there.

**Only the commit's own pipeline counts.** A workflow triggered by `workflow_run` reacts
to another workflow finishing, and a `schedule` cron happens to land on whatever the
branch tip is: neither is what this merge set off, so their suites are left out.
forestadmin-server#8542 wore red — and sat back on its author's plate — for a deploy that
had passed, because "Notify CI Failure on Main", a `workflow_run` reaction broken for a
year, had failed beside it. When a pipeline does fail, the red pill names the workflow and
opens its run: "Build, Test and Deploy failed" and "release failed" are not the same news.
A pill reads as a label, so the few that open something — this one, and the release tag —
wear a `↗` after their text, and their outline firms up on hover — an underline broke at the gap before the arrow — with a tooltip saying where they lead.

**Amber only while something is genuinely in flight.** With no check suite and no rollup
at all — nothing was ever posted to the merge commit, as when merging into a branch with
no CI configured on push, a stacked feature branch used only to collect other PRs — that
is permanent, not a gap before the real answer arrives, so it settles straight to green
rather than breathing forever for a decision that is never coming — seen on
forest-rails#796 and #795, stuck amber for good until this was caught.

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

## Repos outside the org

`PR_RADAR_EXTRA_REPOS=matthv/pr-radar,matthv/gitdeck` puts the PRs of a few repos outside
`PR_RADAR_ORG` on the board, the tool's own repo for one. Each is added to every search as a
`repo:` qualifier beside `org:`, which GitHub ORs: no extra call. The recent-activity feed
stays on the org, which the searches already cover.

GitHub refuses a query over 256 characters, which leaves room for five or six repos; the
server refuses at startup a list that would not fit, or an entry that is not `owner/name`,
rather than failing on every refresh. Listing repos one by one rather than `user:` keeps a
personal account's other repos, and their dependency bots, off the board.

Their chip looks like any other and carries the owner, `matthv/pr-radar #1`: without it,
`pr-radar` would read as one of the org's repos.

## The Linear ticket

With `PR_RADAR_LINEAR_URL` set, a card whose PR names a ticket gets a link to it in its
bottom-right corner, beside the Slack one: the Linear mark and the key, `PRD-812`, opening
`<workspace>/issue/PRD-812`. The key is the one the standup notes already group by
(`ticket.js`): the title first, then the branch (`feature/prd-1184-…`, where the team's
tickets mostly live). Not the description, which the notes also read: the board's query
leaves it out, for the weight it would add to every refresh.

It started as a pill in the card's row and moved: that row says where a PR stands, and a
ticket says what it is about. Down with Slack, the two ways out of a card sit together.
The key stays written next to the mark, since it mostly comes from the branch and appears
nowhere else on the card. The mark is Linear's indigo, white in dark mode.

## The Claude session

macOS only. With `PR_RADAR_CLAUDE_SESSIONS=true`, a card whose PR was created or opened in a
Claude Code session gets a button beside the Linear one. When that session is already running,
a click brings it forward; otherwise it opens a new `PR_RADAR_TERMINAL` window and types
`cd <session dir> && claude --resume <id>` into your shell. Elsewhere than macOS, or with an
unknown `PR_RADAR_TERMINAL`, the startup line says it is off and no button shows.

The link is not guessed. Claude Code appends a `pr-link` record to a session's transcript
(`~/.claude/projects/*/*.jsonl`) for every PR made or viewed in it, and that is what is read.
A branch would not do: a session started from a folder above the repositories records none.
When several sessions touched the same PR, the most recently active one wins.

Transcripts reach a hundred megabytes, so each is read once, then only from where the last
scan stopped. Only sessions active within `PR_RADAR_MAX_AGE_DAYS` are read. A refresh waits
two seconds for the scan at most: the first one on a big `~/.claude` can take longer, and marks
its cards once done. A transcript that cannot be read is skipped, and the banner says some
buttons may be missing.

A running session is found in Claude Code's own registry, `~/.claude/sessions/<pid>.json`, by
its current id only: after a `/clear` the same window holds another conversation. A registry
that cannot be read is an error rather than "not running", which would open a second copy and
fork the session. Where it runs is read from its process ancestry, once `ps` confirms the
pid is still a `claude`:

| Running in | A click |
| --- | --- |
| herdr | focuses its pane (`herdr agent focus`), then the terminal app herdr runs in; a pane it cannot find brings that app forward and says so |
| Terminal, iTerm | selects the tab whose tty is the session's |
| a plain Ghostty tab | only brings Ghostty forward: its AppleScript dictionary names no tty |
| anything else | says it is open elsewhere, rather than opening a second copy |

The endpoint only resumes a session linked to a PR already on the board, and only for a
request from this machine, addressed to `localhost`, with a JSON body: the network, a DNS
rebinding and a page from another site are each turned away. A session whose folder is gone,
a removed worktree, says so instead of opening a terminal that fails. A terminal macOS has
not let PR Radar control (error -1743) points to System Settings › Privacy & Security ›
Automation.

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

## Settings

The ⚙ button in the header opens a panel of personal settings. They are kept in this browser
only, like the notes. It has two sections: **repo colours** and **section order**.

- **Each repo can take its own colour** on its chip: the cards, the orbit view's peek, the
  project picker and the standup notes all follow. The panel lists the repos on the board
  and those already coloured. A colour stays when its repo leaves the board, so it is there
  when the repo comes back.
- **Eight ready-made hues**, or **other…** for any colour from the native picker. **default**
  goes back to the cyan.
- **The hue and its intensity are yours; the lightness is the theme's.** A picked colour is
  read as OKLCH: its lightness is thrown away and recomputed, a pale background and a dark
  text in light mode, the reverse in dark. So any colour stays readable. Even a bright yellow
  keeps a contrast of 6.5:1, against the 4.5:1 that text needs. The intensity is capped
  between grey and fluorescent (`public/colors.js`, `toTint`).
- **A hue close to a state colour gets a warning, not a refusal.** Indigo, amber, green and
  red already say "your move", "waiting", "done" and "failing", so a red repo beside a
  failing CI would blur the reading. The ready-made hues all stay clear of them, and a test
  holds them to it.
- **Each column orders its sections its own way.** Under **section order**, drag a section,
  or move it with ▲/▼ from the keyboard. **My PRs** and **PRs I review** each have their own
  order. **default** shows once a column differs from the default and puts it back. The order
  is kept in `pr-radar:groupOrder`, only for a column that differs from the default. A saved
  order drops buckets that no longer exist, and a new bucket takes its default place
  (`public/order.js`, `normalize`).

## Since you looked

A card that moved since you last looked at it says what moved, in one discreet line:
`◦ since you looked: Scra3 commented · CI turned red · new commits from Alban`.

- **What it reports**:
  - a comment or a review from someone else;
  - commits pushed by someone else;
  - a CI reaching an outcome (green or red, not starting again);
  - a conflict appearing;
  - the merge;
  - the release published or failed.
- **What it ignores**: your own moves and bots, which already have their own pill.
- **What shows**: the two most pressing changes, what asks for something first. When there
  are more, **▸ N more** opens the full list under the line, latest first, each with when.
  Without more, the times are in the line's tooltip.
- **How it knows**: the browser keeps a photo of each card as you saw it (`localStorage`,
  `pr-radar:seen`), and the line is the difference with the card now. No GitHub call of its
  own: it reads what the board already loaded. A card met for the first time is a baseline,
  not news; it already gets the chime and the glowing rail when it asks for something.
- **One block with the reasons.** What moved is the last entry of the card's reasons block,
  in its colour and with its bar, not a second line beside it.
  - **When a reason already says it word for word** (a change request, a re-check), the
    reason gets a **new** badge instead of being said twice.
  - **A pill only gives the state.** So a red CI, a conflict or a failed release is still
    said on the line, and its pill gets a dot in its own colour to point at it.

  Once you have seen it, the mark goes and the reason or the pill stays: it is why the card
  is here.
- **When it goes**, and nothing else clears it:
  - opening the PR from the card, a middle click included;
  - **mark all as seen** in the band, after an absence.

  A hover does not count: moving the mouse across the board would wipe what the line is
  there to keep.

The logic is a small pure module, `public/since.js`, loaded by the page and tested by
`node --test`; the details are in [docs/live-refresh.md](docs/live-refresh.md#since-you-looked).
In the demo, a few cards start with older photos, written again whenever the
demo server restarts, since its dates start from the restart.

## A note on a card

Every card takes one private note — the Slack thread where someone asked you to look, a
reminder for later. A colleague the board was shared with asked for it; the note button
sits in the card's bottom row next to snooze, visible on hover and permanently once a
note exists.

It lives in this browser only (`localStorage`, key `pr-radar:notes`): never sent to
GitHub, never seen by anyone else opening the same board. Bare `http(s)://` URLs in it
become links; everything else is escaped first, so pasting raw HTML does nothing
executable — the only markup ever produced is the anchor built around a URL.

It saves itself when you leave it: a click anywhere else, `Escape`, or focus moving on.
The click that leaves it also closes it back to display mode, since a textarea that
silently kept its text but stayed open read as "did that save at all".

Unlike a snooze, ordinary activity on the PR does not clear it — that is not what a note
is for. It goes only when the PR itself leaves the board (merged and aged out, closed),
pruned on the same render pass as a stale snooze.

## The Slack announcement link

When the team announces its PRs in a Slack channel — one message, a handful of
`github.com/…/pull/…` links — a card whose PR was announced there grows a Slack logo at
the far right of its bottom row, opening that very message. Unlike the note and snooze
buttons it is always visible, and being last it never shifts when they appear on hover.
It is where the PR is actually discussed, and the board is where you notice you need it.

```bash
PR_RADAR_SLACK_CHANNEL=C0C4S34GD7H   # #tech-pr; empty turns the feature off
PR_RADAR_SLACK_TOKEN=                # optional, see below
```

### Two ways to read the channel

**Through Claude, the default.** With no token, the server runs `claude -p` with your
own Slack connector — the one Claude Code already has when you are signed in — and the
single `slack_read_channel` tool allowed, built-in tools off but `ToolSearch` (with many
connectors, their tools are only loaded on demand). Nothing to install, nothing to ask an
admin for. It needs the `claude` CLI, like the standup notes.

It runs from this repo's folder, not the temp directory the standup notes use: a
colleague's Claude loaded no connector at all from `/tmp`, whatever the model, and all of
them from here. Haiku is tried first, then Sonnet as a fallback; whichever sees the tool
is kept for the session. Only when both say there is no Slack tool does the warning banner
say so, and the lookup stays off until the server restarts.

The model only *transcribes*: it copies each message's timestamp and text as JSON, and
matching a PR to its message is done in code, on that copy. A timestamp out of shape is
dropped rather than turned into a link to nowhere, and an answer that is not JSON counts
as a failed read, never as an empty channel.

**Through the Slack API, when a token is set.** A bot token wins over Claude. It comes
from a Slack app with the single `channels:history` scope: at
[api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **OAuth &
Permissions** → *Bot Token Scopes* `channels:history` → **Install to Workspace** → copy
the *Bot User OAuth Token*, then `/invite @<your app>` in the channel (`not_in_channel`
in the warning banner is what forgetting that looks like). Installing an app may need a
workspace admin — on Forest it does, which is why the Claude path exists.

### When the channel is read

A read through Claude takes a dozen seconds, so it is only made when it can find
something:

- **A PR new to the board, with no link yet, is due at once.** Nothing new on the board
  means no call at all.
- **A miss is retried twice**, 30 minutes and then 2 hours later — a PR is often opened
  before it is announced. After a third miss, that PR is no longer a reason to read.
- **A failed read is not a miss.** A read that did not work (no connector, an answer
  that is not JSON) says nothing about the PRs, so it spends none of their tries: the
  next read simply waits 30 minutes, and the warning stays in the banner until a read
  succeeds. A missing connector stays reported until the server restarts.
- **One read serves every PR.** Whatever PRs are due, a single call is made, in the
  background: the board is answered straight away, and the button shows up on the next
  refresh (or at once with *Refresh*).
- **Each read is incremental**: only messages after the newest one already seen (the
  board's own `PR_RADAR_MAX_AGE_DAYS` window the very first time). So a PR given up on is
  still linked the day its announcement shows up, as soon as another new PR triggers a
  read.

The Slack API path is cheap enough to read on every refresh, with the same incremental
rule.

What has been read, and each PR's tries, persist in `.slack-links.json` (ignored by
git): a restart does not re-read the channel. Delete the file to start over.

### Matching, and what it misses

A PR is matched on its link, wherever it sits in the message and in whatever casing the
URL was pasted. When the same PR is posted twice the **oldest** message wins: that is the
announcement, the later one a re-post. The message link is built on the workspace URL's
origin alone: a `PR_RADAR_SLACK_WORKSPACE` pasted out of Slack once arrived with a stray
`]` after the slash, and every link built on it pointed nowhere. Reading forward only has its limits: an older
message *edited* to add a link is not seen again (its timestamp does not move), replies
inside threads are not read, and on the Claude path a read returns at most 100 messages,
so a burst larger than that between two reads loses its oldest ones.

A Slack failure lands in the warning banner under the source `slack`, and the board
itself is unaffected.

## Standup notes

A button in the summary band turns the board into notes you can read out at a standup:
one bullet per piece of work, in two sections — your own, then the ones you review, where
the second sentence says where each stands so you know what to say about it.

**One bullet per piece of work, not per pull request.** A standup is told by what you
worked on, and the back and the front of one change are one thing to say — the feedback
came from a colleague, on forestadmin#9977 and forestadmin-server#8522, which gave two
bullets saying the same thing. The grouping is decided in code, from what can be checked:
the same ticket key (`PRD-1271`) in the title, the branch (`feature/prd-1184-…`) or the
description, or the very same title once its conventional prefix is gone. At least two
digits make a ticket, so a `UTF-8` in a title does not glue two PRs together. The model
receives each group and words it as one bullet; it may also join two lone pull requests
that are visibly one effort. Either way a bullet starts with every number it covers, so
the page keeps a link, a state and a drop button per line. Grouping never crosses the two
sections: what you wrote and what you review are two roles, two bullets.

On screen a grouped bullet stacks its pull requests in the same cell, each its own link,
tied by a thin bracket in the gutter; it shows one state pill when every part stands in
the same place and one per part otherwise ("back merged, front awaiting review" is the
news), and the time of the most recent. The copied line reads
`forestadmin #9977 + forestadmin-server #8522 (merged, waiting) …`.

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

Each line carries **the time of that PR's real activity, its repo and number, and its
state**, in four fixed columns so the day reads down the edge of the panel. The repo is
there because the notes span the whole org: a bare `#1918` said nothing about which
project it belonged to. The cell is sized for the longest name actually in use
(`forestadmin-server #8516`) and ellipsised past that, rather than stretching every other
line to fit a rare outlier. The state is read off the
board, never asked of the model: the bucket is already computed, and prose would freeze it
at the moment of writing and let it go stale. The weekday is on every line, today's
included — dropping it there read as an oversight and left the column ragged.

The bullets are ordered **oldest activity first**, the way the day happened rather than
the board's order of urgency, and sorted before the request rather than after the answer,
since the model words each bullet against the order it is given.

Copying gives plain markdown with the headings, the state word included — "merged" is half
of what a standup line says. On screen each `repo #number` links to the pull request it
summarises.

The group markers the model emits are matched as a whole line holding nothing but the
token, hashes or bold optional: it has been seen writing `## MINE`, `MINE` and `**MINE**`
for the same request, and a stricter pattern let the raw marker through as a bullet. The
bullets are read just as loosely: English answers write `#812 Fixes…`, French ones
`#812: Corrige…` with the colon against the digits, and a pattern that required a space
there once dropped every French line to the plain fallback — no time, no repo, no pill.

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

For a standup at 9:30, for instance:

```bash
PR_RADAR_DAILY_NOTES_FROM=08:45
PR_RADAR_DAILY_NOTES_UNTIL=09:25   # five minutes early: a late run must finish in time
```

The end sits a few minutes before the meeting on purpose. Runs do not land on round
minutes — `StartInterval` counts from when the job was loaded, not from midnight — and a
generation already started goes to its end (30 to 100 seconds) regardless of the window,
so an `UNTIL` right on the hour could still be writing when the standup begins.
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
- A chime plays when that number goes up (the **speaker** button, remembered — filled
  indigo while on, plain when muted). It
  follows the counter, not activity: a PR you just opened yourself lands in
  *waiting on the reviewers* and asks nothing of you, so it stays silent — you came
  from `gh pr create` and know it exists. It rings when a reviewer turns it into
  your move. The first render after opening the page is silent too, or every reload
  would chime.
- **Your own sound**: `PR_RADAR_SOUND=~/Music/ding.mp3` replaces the chime with that
  file, played in full — no cap, it is your sound. The server serves that one path, at a
  fixed `/sound` route, and nothing else: the page never names a file. If the browser
  cannot play it (moved, a format it does not read — `.aiff` among them), the chime plays
  instead. Like the chime, it only sounds once you have interacted with the page.
- **The cards that rang light up.** The chime says something landed on your plate, not
  which card: those that just entered *to act* keep their left rail glowing — wider, a
  slow pulse throwing soft indigo onto the card — for two minutes, then fade. Same rule
  as the chime, per card: filters apply, nothing lights on the first render. It does not
  depend on the mute button; a silent board is where it helps most. If the tab was in the
  background, the two minutes start when you come back to it, or the glow would be over
  before anyone looked. Hovering or clicking the card puts it out. With reduced motion
  set in the OS, the rail is simply wider and brighter, without pulsing. It lives in
  memory: a reload clears it, the way a reload does not replay the chime.
  The light goes inwards because the card clips anything left of its edge, and every
  render rebuilds the cards, so the pulse resumes from a negative delay rather than
  restarting at its first frame on each refresh.
- The time in the header is the last check, free or not; see
  [How fresh the board is](#how-fresh-the-board-is).

### The webhook

`PR_RADAR_WEBHOOK_URL` makes the server POST the status changes to that URL, for a Slack
workflow, an n8n flow or anything else that takes JSON:

```json
{
  "status": "reviews.action",
  "url": "https://github.com/ForestAdmin/agent-nodejs/pull/1912",
  "project": "ForestAdmin/agent-nodejs",
  "pr_number": 1912,
  "prs": [
    { "url": "https://github.com/ForestAdmin/agent-nodejs/pull/1912", "project": "ForestAdmin/agent-nodejs", "pr_number": 1912 },
    { "url": "https://github.com/ForestAdmin/agent-ruby/pull/402", "project": "ForestAdmin/agent-ruby", "pr_number": 402 }
  ]
}
```

- **The status** is the column and the group the card sits in, `side.bucket`:
  `mine.action`, `mine.ready`, `mine.waiting`, `mine.idle`, `mine.merged`,
  `reviews.action`, `reviews.waiting`, `reviews.idle`, `reviews.merged`. The side is
  part of it: a PR to fix and a review to do are not the same news.
- **`project`** is the repo as `owner/name`, so a repo from `PR_RADAR_EXTRA_REPOS` is
  told apart from the org's own; **`pr_number`** is the number, as an integer.
- **An event** is a PR whose status changed since the previous refresh, or that just
  appeared on the board. The first refresh after startup only takes a picture, the way
  the first render does not chime.
- **One call per status.** When several PRs reach the same status in one refresh, they
  all go in `prs`, in board order, and the first one is also at the top level: a receiver
  that reads one PR reads that one, and none is lost to one that reads them all. Two
  review requests in a row, a stack or a Dependabot batch often land in one refresh.
- **`PR_RADAR_WEBHOOK_STATUSES`** keeps only the listed statuses. An unknown value stops the server at startup rather than
  silently sending nothing.
- It is the server's view: `PR_RADAR_HIDE_DRAFTS` applies, but snoozes, "hide bots"
  and the search filter live in the browser and do not.
- **It follows the live refresh.** A change found by the checks is sent within
  `PR_RADAR_CHECK_SECONDS`, a new PR with the next full search. With
  `PR_RADAR_CHECK_SECONDS=0`, the server runs that full search on its own instead.
- **It runs around the clock, and that has a cost.** While the URL is set the checks never
  stop, so calls go out with no tab open. They are free when nothing moved, but with no
  page the full search still runs every 15 minutes: roughly 50 counted GitHub calls an
  hour at a quiet time, about 1,200 a day, where a closed tab used to cost none. A new PR
  then waits up to 15 minutes; the cards already on the board stay as fresh. See
  [What it costs](docs/live-refresh.md#what-it-costs).
- **A board missing PRs is not trusted.** That is a failed search, a failed batch of
  details or a failed event-feed lookup; a truncated thread list or an unknown
  mergeability leaves every PR on the board and does not count.
  - Only a complete board becomes the first picture, or the PRs it missed would go out as
    new on the next one.
  - An incomplete board sends the PRs new to it only. The PRs it lost keep their last
    status, and a status change waits for the next complete board.
- **A PR of mine whose mergeability GitHub has not computed** — or failed to give — keeps
  its last status: its bucket cannot show a conflict yet, and it would go out as ready,
  then as action. It is sent once GitHub knows.
- A failed call (timeout at 5 s, non-2xx) is logged, never retried, and never touches the
  board. The startup line only shows the URL's host, since hook URLs often carry a secret.
  The demo never calls it.

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

- 🔊 mutes the chime (remembered). The button is filled indigo while the chime is on,
  the same "this is active" language as the `FR`/`EN` pill: two people independently read
  the plain icon swap as "is this even on right now".
- `☾` / `☀` toggles light / dark (light by default, remembered).
- A **gitdeck** button in the header opens [gitdeck](https://github.com/matthv/gitdeck), a
  separate personal repo (a local web git client), carrying gitdeck's own branch mark so it
  is recognisable at a glance. It is the mirror of
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
  `conversation`, a repo badge, a branch badge). Never a state: it is a navigation accent.

The one exception is the Slack logo on a card, drawn in Slack's own four colours: the
only place the board wears a brand's palette rather than its own, because the logo is what
makes that button readable at a glance where a monochrome mark did not.

Each column carries its own title hue (indigo on the left, cyan on the right) so
you can tell them apart at a glance while scrolling.

Pills carry the state; a reason line only appears for what no pill already says
(the name of the reviewer who requested changes, new commits to re-check).

## Implementation notes

- `assets/` holds the mark as source: `pr-radar-tile.svg` is the favicon, inlined as a data
  URI in `public/index.html` and `demo-intro.html`, so a change there means re-inlining it.
  The two 128px PNGs are the Slack emoji, transparent, ready to upload; the plain
  `pr-radar.svg` is the radar alone, without its tile.
- The PR list goes through the **REST search**: the GraphQL search times out
  (HTTP 499) on a large org. The `node_id` it returns is directly the GraphQL id
  of the `PullRequest`, then loaded in batches of 6.
- The GraphQL body is written to a temporary file: `gh api --input -` does not
  correctly receive a body piped from Node with `gh <= 2.7` — the request goes out
  malformed and GitHub cuts it off. From a shell pipe it works, which makes the
  bug misleading. (`gh auth token` also does not exist before 2.16.)
- Reviews requested **through a team** do not show up: GitHub search requires
  `team-review-requested:org/team`, which is not covered here.
- The synthetic conversation thread excludes bots. Review bodies that ask nothing are
  filtered out (see [Where your feedback is looked for](#where-your-feedback-is-looked-for)),
  but a plain **conversation comment** is not read: on your own PRs, a trailing "LGTM 🎉"
  left as a comment rather than a review still counts as something to address.
