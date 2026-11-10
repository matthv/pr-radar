'use strict';

const { wizzRef, withPrUrls } = require('./hub');

const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
// Strings only: String(["x"]) passes a pattern a raw array then breaks further on.
const login = value => (typeof value === 'string' && GITHUB_LOGIN.test(value) ? value : null);
const text = value => (typeof value === 'string' ? value : '');
// A retry would fail the same way: the offer goes with these, and stays for the others.
const OFFER_REFUSED = new Set(['badOffer', 'network', 'parse']);

async function hubAction(body, { hub, tabCounter, boardUrls, readForOffer, installTheme, themeCatalog, log = () => {} }) {
  if (body.action === 'bye') tabCounter.bye(text(body.tabId));
  else tabCounter.beat(text(body.tabId), body.hidden === true);
  const to = login(body.to);
  const urls = boardUrls();
  const shared = {};
  switch (body.action) {
    case 'signIn':
      hub.signIn();
      break;
    case 'decline':
      await hub.decline();
      break;
    case 'availability':
      hub.setAvailability(body.value);
      break;
    case 'kudos':
      if (to) hub.sendKudos(to);
      break;
    case 'wizz': {
      const pr = body.pr == null ? null : text(body.pr);
      // A nudge only for a PR of this board, which the recipient's radar can find too.
      if (to && (pr === null || urls.includes(pr))) hub.sendWizz(to, pr === null ? null : wizzRef(pr));
      break;
    }
    case 'offerTheme':
      if (!to) break;
      try {
        const theme = await readForOffer(text(body.name));
        if (hub.offerTheme(to, theme)) shared.sent = theme.name;
        else shared.error = { reason: 'offline' };
      } catch (error) {
        shared.error = { reason: error.reason, params: error.params };
      }
      break;
    case 'acceptOffer': {
      const id = text(body.id);
      const offer = hub.peekOffer(id);
      if (!offer) {
        shared.error = { reason: 'gone' };
        break;
      }
      try {
        shared.installed = await installTheme(offer.theme, { from: offer.from });
        hub.takeOffer(id);
        log('info', `installed custom-themes/${shared.installed}, offered by ${offer.from}`);
      } catch (error) {
        if (OFFER_REFUSED.has(error.reason)) hub.takeOffer(id);
        shared.error = { reason: error.reason, params: error.params };
        log('fail', `offer from ${offer.from} not installed, ${error.message}`);
      }
      if (shared.installed) shared.catalog = await themeCatalog().catch(() => undefined);
      break;
    }
    case 'declineOffer':
      hub.takeOffer(text(body.id));
      break;
    default:
  }
  hub.setTabs(tabCounter.count());
  return { hub: withPrUrls(hub.state(), urls), ...shared };
}

module.exports = { hubAction, login };
