# Live refresh

How PR Radar shows a change within about a minute instead of five, without asking GitHub
for more. The settings and the guards are summed up in the README,
[How fresh the board is](../README.md#how-fresh-the-board-is); this page explains the
mechanism.

## The problem

The board used to redo everything every `PR_RADAR_REFRESH_SECONDS` (300 s), whether anything
had happened or not:
- eight GitHub searches;
- the event feed;
- every PR's details.

Two problems came out of this:
- A change took up to five minutes to show.
- Every hour cost the same, about 22 to 24 calls per refresh. Most of them were searches,
  the scarce quota: 30 a minute, and a secondary rate limit already hit once.

Webhooks would fix the delay, but they need an org admin to set up, and would send the
private repos' activity to a server. Everything here stays local and goes through the user's
own `gh`.

## The idea: ask, for free, whether anything changed

GitHub supports conditional requests:
- **The PR itself.** `GET /repos/{owner}/{repo}/pulls/{n}` sent with the `ETag` of the last
  answer (`If-None-Match`) returns `304 Not Modified` when the PR has not changed.
- **The notifications.** `GET /notifications` sent with `If-Modified-Since` returns `304` the
  same way.

A `304` does not count against the rate limit. So the board can ask every card "have you
changed?" every minute, at no cost while nothing happens, and reload only the cards that
answer yes.

## Three cadences

```mermaid
flowchart LR
  subgraph check["every 60 s"]
    A["one conditional GET per card<br/>+ GET /notifications"]
  end
  subgraph flight["every 30 s, only if needed"]
    B["cards with a running CI<br/>or a running release"]
  end
  subgraph full["every PR_RADAR_REFRESH_SECONDS"]
    C["full search:<br/>finds new PRs"]
  end
  A -- "304" --> N["nothing to do<br/>(free)"]
  A -- "200 on a card" --> R["reload that PR only"]
  A -- "notification on a PR<br/>missing from the board" --> C
  B --> R
  C --> S["board rebuilt"]
  R --> S
```

| Cadence | Why it exists |
| --- | --- |
| **Checks, every 60 s** | Catch any human change on a card already on the board: a comment, a review, a push, a merge. `60` is also the floor `/notifications` sets through `X-Poll-Interval`. |
| **In flight, every 30 s** | A running CI or release changes state with no human event. A PR's `ETag` does not move when its checks finish, so these cards are reloaded directly, for 30 minutes at most each. |
| **Full search** | The only way to discover a **new** PR, such as one just opened or a review just requested. A notification about a PR missing from the board brings it forward, but never sooner than 90 s after the previous one. |

## The path of a change

```mermaid
sequenceDiagram
  participant GH as GitHub
  participant S as PR Radar server
  participant P as Page
  Note over GH: someone comments on a PR of the board
  S->>GH: GET pulls/{n} (If-None-Match)
  GH-->>S: 200 + new ETag
  S->>GH: GraphQL: reload that PR only
  GH-->>S: its details
  Note over S: reshaped into the board with the<br/>same rules as a full search
  P->>S: GET /api/prs (every 20 s, no GitHub call)
  S-->>P: the updated board
  Note over P: redrawn only if the board changed:<br/>group, colour, chime, glowing rail
```

Two shortcuts make your own moves show at once:
- **A PR made or opened in a Claude session.** It is read from the same transcripts as the
  Claude session button, when that feature is on.
- **A return to the tab after a minute away**, most likely from GitHub itself. It asks for a
  check right away.

## Reshaping a reloaded PR into the board

A reloaded PR has to land exactly where a full search would have put it: its side (mine or
review), its group and its pills. `github.js` splits the work in three:
- `discover()` runs the searches and keeps what they told: who I am, which source found each
  PR (review requested, assigned, merged and reviewed by me…), and the time windows.
- `loadNodes()` loads PR details.
- `shapeBoard()` is pure. It builds the board from the loaded PRs and the discovery context,
  and starts from copies of the context's sets every time. So a PR moved by the taken-over
  rule goes back to the review side once its author pushes, even between two searches.

A full search is `discover` + `loadNodes` + `shapeBoard`. A partial reload replaces a few PRs
in the stored set and calls `shapeBoard` again. A PR the reload does not return is kept as it
was: a lost batch is not a closed PR, and the next full search settles it.

## What it costs

Per hour, with a tab open. A full search costs about 22 to 24 calls on a board of a dozen PRs.

| Setup | Calls counted per hour | Time to see a change on a card |
| --- | --- | --- |
| Before: everything every 5 min | ~280 | up to 5 min |
| Live refresh, full search every 5 min | ~280 + targeted reloads | ~1 min |
| Live refresh, full search every 15 min | ~95 + targeted reloads | ~1 min |

- **The free checks are not in this table**: about 7 per minute on a 6-PR board, all `304`
  on a quiet hour.
- **Targeted reloads grow with activity**, but one PR at a time. A quiet hour has almost none.
- **The full search stays the main cost.** With the checks in place it no longer needs to run
  often: spacing it from 5 to 15 minutes divides the cost by three. PRs already on the board
  stay just as fresh. Only discovering a brand-new PR waits longer, except for a review
  request, which the notifications report.

## Guards

| Situation | What happens |
| --- | --- |
| A burst of notifications | At most one full search brought forward, 90 s after the previous one at the earliest |
| A CI stuck in a queue | Followed for 30 minutes, then left to the regular cadence |
| A reload fails | The card reads as changed on the next round, so the change is not lost |
| The tab is hidden | Checks every 5 minutes |
| No page for 10 minutes | No GitHub call at all; the next page opened runs a full search |
| A note being edited | The page redraws only when the board changed, so the editor stays open |
| `gh` exits 1 on a `304` | Read as an answer, not an error (`watch.js`, `parseResponse`) |
| A check genuinely fails | Logged on the server; the full search stays the safety net |

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PR_RADAR_CHECK_SECONDS` | `60` | Free checks between two full searches. `0` goes back to a full refresh every `PR_RADAR_REFRESH_SECONDS` and nothing else. |
| `PR_RADAR_REFRESH_SECONDS` | `300` | Full search interval. |

## Code map

- **`watch.js`**:
  - `createWatcher` holds the `ETag`s and the notifications' `Last-Modified`;
  - `inFlight` and `toFollow` pick the cards to follow;
  - `nextDiscoveryAt` enforces the gap between full searches.
- **`github.js`**: `discover`, `loadNodes`, `shapeBoard`, `fetchBoard`.
- **`server.js`**:
  - `patchPrs` reloads a few PRs into the cached board;
  - `liveStep` and `liveTick` run the loop;
  - the `/api/prs` route renews the page lease.
- **`claude-sessions.js`**: `scan()` returns the PR links new since the last scan (`touched`).
- **Tests**: `test/watch.test.js`, and the reshaping case in `test/classification.test.js`.
