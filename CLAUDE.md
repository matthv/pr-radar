# CLAUDE.md

PR Radar is a local dashboard of the GitHub PRs you author or review. The README is the full
manual: read the section of what you touch before changing it, and update it in the same PR.

## Stack and layout

- **Node 22.4+, no dependencies.** Plain CommonJS on Node's standard library; don't add an npm
  package. Run with `node`, not `yarn` (see README, Running it).
- One module per concern at the root (`github.js` fetches and classifies, `server.js` serves and
  routes, `slack.js`, `hub.js`, `update.js`…). The page is `public/index.html`, one file with its
  own CSS, script and `I18N`; small shared helpers in `public/*.js` load both in the page and in
  the tests.
- `npm run demo` (port 4322) serves a fake board from `demo.js`, nothing fetched. Show and check
  UI changes there, in the **board** view, and add a demo case for any new card state
  (`test/demo.test.js` checks they all appear).

## Before every commit

- `node --test`: one test file per module, testing the pure functions it exports, never the
  network. A real case gets a fixture named after its PR number.
- `gitleaks detect`.
- Commits and PR titles in Conventional Commits (`feat:`, `fix:`, `chore:`…): semantic-release
  turns each `feat` or `fix` merged on `main` into a version. Never edit the version in
  `package.json`.

## UI rules

- **Every icon is an inline SVG, never an emoji**, for a consistent look. The one exception is a
  theme's `icon` in its `theme.json`.
- **Colour encodes priority and is reserved** (README, Reading the colours): indigo is your move,
  amber waiting on someone, emerald approved or green CI, brick actually broken, cyan only a
  navigation accent. Never use them for decoration, and a theme never changes them.
- **Every text in both languages**: a key added to `I18N.fr` is added to `I18N.en`, and the
  reverse.
- Animations only under `@media (prefers-reduced-motion: no-preference)`.

## Code

- No comment by default. One only for a non-obvious why: a workaround, an external constraint,
  a trap. Never paraphrase the code.
- Code, comments and commit messages in English.
- A route that acts (POST) is localhost-only and takes a JSON body, like the existing ones; check
  what `gh` answers, since `runGh` passes an error body through as a success.
- Anything a plugin, a theme or the hub sends ends up in the page: validate and escape it, accept
  only `https://` links.
- A new setting goes in `.env.example` with a comment and in the README's Configuration table;
  the board works without it. The **Update** banner names the variables new to `.env.example`.

## Privacy

- Never read, print or commit `.env`, tokens or the `gh` token.
- The presence hub (`hub.js`) gets no Forest data: no PR, repo or title. Its token never reaches
  the browser or a log.
- `custom-themes/` is personal and git-ignored; never commit what's in it.

## Themes

How to write one is in `public/themes/README.md`. A theme dresses the header, the empty states and
the background; it never covers the cards, and nothing in it takes a click.
