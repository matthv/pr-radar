'use strict';

(() => {
  const DEATH_STAR = '<svg class="sw-deathstar" viewBox="0 0 100 100">'
    + '<circle cx="50" cy="50" r="48" fill="currentColor"/>'
    + '<path d="M2,47h96v5H2z" fill="var(--bg)" opacity=".55"/>'
    + '<circle cx="34" cy="31" r="11" fill="var(--bg)" opacity=".35"/><circle cx="34" cy="31" r="3" fill="var(--bg)" opacity=".6"/>'
    + '<path d="M50,2v45M50,52v46M14,18l30,29M86,82l-30-30" stroke="var(--bg)" stroke-width=".6" opacity=".35" fill="none"/></svg>';

  const R2D2 = '<svg class="sw-r2" viewBox="0 0 40 48"><g class="rock" stroke="var(--sw-r2-line)" stroke-width=".8">'
    + '<rect x="1" y="18" width="6" height="25" rx="2" fill="var(--sw-r2-body)"/><path d="M0,47l2-5h4l2,5z" fill="var(--sw-r2-dome)"/>'
    + '<rect x="33" y="18" width="6" height="25" rx="2" fill="var(--sw-r2-body)"/><path d="M32,47l2-5h4l2,5z" fill="var(--sw-r2-dome)"/>'
    + '<rect x="16" y="41" width="8" height="5" fill="var(--sw-r2-dome)"/>'
    + '<rect x="7" y="17" width="26" height="25" rx="2" fill="var(--sw-r2-body)"/>'
    + '<g fill="var(--sw-r2-blue)" stroke="none"><rect x="11" y="21" width="6" height="3"/><rect x="21" y="21" width="8" height="3"/>'
    + '<rect x="11" y="27" width="3" height="11"/><rect x="26" y="27" width="3" height="11"/></g>'
    + '<rect x="17" y="27" width="6" height="9" fill="var(--sw-r2-dome)"/>'
    + '<path d="M7,17A13,13 0 0 1 33,17Z" fill="var(--sw-r2-dome)"/>'
    + '<g stroke="none"><rect x="10" y="12" width="4" height="3" fill="var(--sw-r2-blue)"/><rect x="26" y="12" width="4" height="3" fill="var(--sw-r2-blue)"/>'
    + '<g class="eye"><circle cx="20" cy="10" r="2.8" fill="var(--sw-r2-line)"/><circle cx="20.8" cy="9.3" r=".8" fill="#fff"/></g>'
    + '<circle class="lamp" cx="25" cy="7.5" r="1" fill="var(--sw-sith)"/></g></g></svg>';

  const TIE_FIGHTER = '<svg class="sw-tie" viewBox="-16 -12 32 24">'
    + '<path d="M-15,-11h3l1,3v16l-1,3h-3l1-3v-16zM15,-11h-3l-1,3v16l1,3h3l-1-3v-16z" fill="currentColor"/>'
    + '<path d="M-11,0h22" stroke="currentColor" stroke-width="2.4"/>'
    + '<circle r="5" fill="currentColor"/><circle r="2.6" fill="var(--bg)" opacity=".5"/></svg>';

  // A TIE fighter crosses the top of the window, one way or the other, firing ahead of it.
  function flyby({ front }) {
    const lane = front.querySelector('.sw-flyby');
    if (!lane) return;
    lane.classList.toggle('rtl', Math.random() < 0.5);
    lane.style.setProperty('--y', `${(8 + Math.random() * 30).toFixed(0)}vh`);
    lane.style.setProperty('--drop', `${((Math.random() - 0.5) * 16).toFixed(0)}vh`);
    lane.innerHTML = `<div class="sw-craft">${TIE_FIGHTER}<i class="sw-bolt"></i><i class="sw-bolt b"></i></div>`;
    lane.classList.remove('fly');
    void lane.getBoundingClientRect();
    lane.classList.add('fly');
  }

  PRRadarTheme.register({
    front: () => `${DEATH_STAR}${R2D2}<div class="sw-flyby"></div>`,
    back: () => PRRadarTheme.stars({ seed: 20260504, count: 88, className: 'sw-star' }),
    ambient: flyby,
    every: [14_000, 30_000],
  });
})();
