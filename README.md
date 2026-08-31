# PR Radar

A local dashboard for your GitHub pull requests, in two columns:

- **My PRs** — the ones you opened, with whatever is left for you to do on them
  (unaddressed comments, changes requested, red CI, merge conflicts).
- **PRs I review** — the ones you review, telling apart *your move* from
  *waiting on the author to push a fix*.

Each column is grouped by state:

| Group | My PRs | PRs I review |
| --- | --- | --- |
| `On my plate` | unaddressed comments, changes requested, red CI, conflicts | review requested and not done, replies to your comments, new commits since your feedback |
| `Waiting` | you replied — the ball is with the reviewers | your open threads / your changes-requested await a fix |
| `Nothing to report` | everything else | everything else |

## Running it

```bash
cd pr-radar
./pr-radar          # starts the server and opens the browser
# or: yarn start / node server.js
```

No dependencies to install. Authentication reuses your `gh` session
(`gh auth status` must be green). A `GITHUB_TOKEN` in the environment takes
precedence over `gh` if you prefer.

## Configuration

Everything lives in a **`.env`** file at the root (`.env.example` is a commented
copy). A variable already exported in your shell wins over the file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PR_RADAR_ORG` | — | GitHub org to scan (**required**) |
| `PORT` | `4321` | Server port |
| `PR_RADAR_MAX_AGE_DAYS` | `60` | Past that, a PR is ignored |
| `PR_RADAR_REFRESH_SECONDS` | `300` | Auto-refresh interval |
| `GITHUB_TOKEN` | — | Bypasses `gh` |

The server caches its response for **half** of `PR_RADAR_REFRESH_SECONDS`.
Otherwise a poll would land on a barely-valid cache and serve data almost twice
as old as the advertised interval. The **Refresh** button bypasses the cache.

## Where your feedback is looked for

Review feedback does not necessarily live in an inline thread. Three channels are
covered, and all three feed the same classification:

1. **inline threads** — comments on a line of code;
2. **submitted reviews** — `approve` / `request changes`, review body included;
3. the PR's **main conversation**, folded into a synthetic thread.

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

GitHub's `updated_at` will not do: it moves when a label is added, when
`mergeable` is recomputed, or when CI is re-run. A PR with no commit and no
comment for 204 days still claimed it had been "updated 2 days ago". Bot comments
are excluded for the same reason: a linter passing by does not wake a PR up.

That same timestamp drives the age shown on the card and the column ordering.

The coarse pre-filter on `updated_at` is kept, but deliberately loose: it only
avoids fetching the details of PRs that are dead for certain. The number of
dropped PRs stays visible in the header so the filter is never silent.

## Notifications

- The tab title shows the number of pending actions: `(4) PR Radar`.
- A chime plays when that number goes up (**sound** checkbox, remembered).
- Auto-refresh is driven by `PR_RADAR_REFRESH_SECONDS`; the last fetch time sits
  in the header, the exact interval on hover.

## Filters and display

- **needs work** — keep only the cards that ask something of you.
- **hide bots** — ignore threads opened by review bots. The counts, the ordering
  and each card's group are recomputed accordingly: a PR flagged only by a bot
  falls back to "nothing to report".
- **hide drafts**.
- `☾` / `☀` toggles light / dark (light by default, remembered).
- `FR` / `EN` toggles the interface language (French by default, remembered).
  State labels are rendered in the browser: the server only emits `kind` values,
  never a sentence, so no text can escape translation.

Click `▸ N open threads` to read the comments without leaving the page.

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
