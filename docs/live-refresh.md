# Live refresh

How PR Radar shows a change within about a minute instead of five, without asking GitHub
for more, and how a card then says what changed since you last looked at it. The settings and the guards are summed up in the README,
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
| **In flight, every 30 s** | A running CI or release changes state with no human event. A PR's `ETag` does not move when its checks finish, so these cards have their **status only** read directly, for 30 minutes at most each, and are reloaded in full once it moves. |
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

Measured behind a `gh` that logs every call, on a real board, a tab open. The counted calls are
the ones that spend the API quota; a `304` does not.

| Setup | Counted per hour | of which searches | Free `304` per hour | Time to see a change |
| --- | --- | --- | --- | --- |
| Before: everything every 5 min (Oct 5, 11h–12h) | ~290 | ~80 | ~10 | up to 5 min |
| Live refresh, without the savings below (Oct 5, 15h–17h) | ~400 | ~80 | ~190 | ~1 min |
| Live refresh, as it stands (Oct 6, 9h–12h) | ~295 | ~85 | ~230 | ~1 min |

A full search costs about 12 calls, against about 24 before PRs were reused (measured
overnight, with nothing else running).

- **The searches are now the main cost**: about 12 full searches an hour, of 7 search calls
  each, the same in every setup. Spacing them from 5 to 10 minutes would save about 40 calls
  an hour. PRs already on the board stay just as fresh; only a brand-new one waits longer. A
  review request I add myself sends me no notification, so it waits for the next full search.
- **A webhook keeps it running around the clock.** With no page, the full search spaces out
  to every 15 minutes: about 4 an hour of about 12 calls, so roughly **50 counted calls an
  hour** at a quiet time, plus the reloads of whatever moves — around 1,200 a day overnight
  and on weekends, instead of none. That is an estimate from the figures above, not a
  measurement. With a page open, the cost is the table's.
- **Targeted reloads grow with activity**, one PR at a time, and a CI in flight is read every
  30 s. The Oct 6 morning included a release run re-run after a flaky test.

## Guards

| Situation | What happens |
| --- | --- |
| A burst of notifications | At most one full search brought forward, 90 s after the previous one at the earliest |
| A CI stuck in a queue | Followed for 30 minutes, then left to the regular cadence |
| A reload fails | The card reads as changed on the next round, so the change is not lost |
| The tab is hidden | Checks every 5 minutes |
| No page for 10 minutes | No GitHub call at all; the next page opened runs a full search. Not with a webhook set, see the next line |
| `PR_RADAR_WEBHOOK_URL` set | The checks never stop, at their regular pace even behind a hidden tab: the webhook is always looking. With no page for 10 minutes, the full search spaces out to every 15 minutes (`searchEveryMs`); a page coming back runs the overdue one at once |
| A note being edited | The page redraws only when the board changed, so the editor stays open |
| `gh` exits 1 on a `304` | Read as an answer, not an error (`watch.js`, `parseResponse`) |
| A check genuinely fails | Logged on the server; the full search stays the safety net |

## Since you looked

Live refresh makes a card change within a minute, but the card itself only shows its new
state. It doesn't say what moved. Coming back from a meeting, you would have to open each PR
to find out. So a card that moved since you last looked at it says so, in one line:

`◦ since you looked: Scra3 commented · CI turned red · ▸ 1 more`

### How it knows what you saw

```mermaid
sequenceDiagram
  participant B as Board data
  participant P as Page
  participant L as localStorage (pr-radar:seen)
  Note over P,L: first sight of a card
  P->>L: photo of the card, no line
  Note over B: later: a comment, a push, the CI…
  B->>P: the card's new state (live refresh)
  P->>L: read the photo
  Note over P: line = difference between the photo and now
  Note over P: you open the PR, or "mark all as seen"
  P->>L: new photo, the line goes
```

- **A photo per card.** The page keeps, in the browser only, the few fields that tell what
  moved: each thread's last date and count, the reviews, the last commit, the CI, the
  mergeability, the merge, the release.
- **The line is the difference** between that photo and the card now. It runs entirely in
  the page, on data the board already loaded: no GitHub call of its own, and the server
  doesn't know about it.
- **A card met for the first time is a baseline, not news.** Its photo is taken silently. A
  new PR already gets the chime and the glowing rail when it asks for something.

### What it reports

| Change | Reported when |
| --- | --- |
| A comment | a thread is new or grew, and its last word is someone else's, not a bot's |
| A review | someone else approved or requested changes. A commented review counts as a comment. |
| Commits | the head commit moved and was not pushed by you |
| The CI | it reached an outcome, green or red. Starting again comes with a push, already said. |
| A conflict | the PR became unmergeable |
| The merge, the release | the PR merged, a release was published, or the release failed |

Your own moves and bots are left out: they are not news to you, and bots have their own pill.

### What shows, and when it goes

- **Two changes on the line**, the most pressing first: a red CI, a conflict, a change request.
  With more, **▸ N more** opens the full list under the line, latest first, each with when.
  Without more, the times are in the line's tooltip. A CI or a conflict has no moment of its
  own in the data, so it is listed without one.
- **One block with the reasons.** What moved is the last entry of the card's reasons block,
  in its colour and with its bar, not a second line beside it.
  - **When a reason already says it word for word** (a change request, a re-check), the
    reason gets a **new** badge instead of being said twice.
  - **A pill only gives the state.** So a red CI, a conflict or a failed release is still
    said on the line, and its pill gets a dot in its own colour to point at it.

  Once you have seen it, the mark goes and the reason or the pill stays: it is why the card
  is here.
- **The line goes** when you open the PR from the card (a middle click included), or with
  **mark all as seen** in the band, which also says how many cards moved.
- **Hovering does nothing**: moving the mouse across the board would wipe what the line is
  there to keep.

### Where it lives

- **`public/since.js`** is pure: `snapshotOf(pr)` takes the photo, and
  `changesSince(photo, pr, me)` lists the changes with their kind, who and when. It is loaded
  by the page as a global and by `test/since.test.js` as a module.
- **`public/index.html`** holds the rest:
  - the `seen` store (`sync`, `mark`, `seed`);
  - the line and its list, in `sinceHtml`;
  - the clearing on opening a PR, and the band's button.
- **The demo** starts a few cards with older photos. They are written again whenever the demo
  server restarts: its dates start from the restart, so older photos would all read as
  changed.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PR_RADAR_CHECK_SECONDS` | `60` | Free checks between two full searches. `0` goes back to a full refresh every `PR_RADAR_REFRESH_SECONDS` and nothing else. |
| `PR_RADAR_REFRESH_SECONDS` | `300` | Full search interval. |

## Code map

- **`watch.js`**:
  - `createWatcher` holds the `ETag`s and the notifications' `Last-Modified`;
  - `inFlight` and `toFollow` pick the cards to follow;
  - `nextDiscoveryAt` enforces the gap between full searches;
  - `watched` says whether the checks still run: a page lease, or a webhook;
  - `searchEveryMs` spaces the full searches when only a webhook is looking.
- **`github.js`**:
  - `discover`, `loadNodes`, `shapeBoard`, `fetchBoard` (with the PRs it may reuse);
  - `STATUS_QUERY`, `statusFingerprint`, `fetchStatusFingerprints` for the cards in flight;
  - the event feed's conditional first page in `recentlyTouchedPullRequests`.
- **`server.js`**:
  - `patchPrs` reloads a few PRs into the cached board, and sends the webhook its changes;
  - `reusableNodes` picks what a scheduled search may reuse (`REUSE_MS`);
  - `liveStep` and `liveTick` run the loop;
  - the `/api/prs` route renews the page lease.
- **`claude-sessions.js`**: `scan()` returns the PR links new since the last scan (`touched`).
- **`public/since.js`**, **`public/index.html`**: since you looked (see above).
- **Tests**: `test/watch.test.js`, `test/fetch.test.js` (reuse, status fingerprint, event
  feed), `test/since.test.js`, and the reshaping cases in `test/classification.test.js`.
