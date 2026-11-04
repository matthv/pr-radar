'use strict';

(() => {
  const DEATH_STAR = '<svg class="sw-deathstar" viewBox="0 0 100 100">'
    + '<circle cx="50" cy="50" r="48" fill="currentColor"/>'
    + '<path d="M2,47h96v5H2z" fill="var(--bg)" opacity=".55"/>'
    + '<circle cx="34" cy="31" r="11" fill="var(--bg)" opacity=".35"/><circle cx="34" cy="31" r="3" fill="var(--bg)" opacity=".6"/>'
    + '<path d="M50,2v45M50,52v46M14,18l30,29M86,82l-30-30" stroke="var(--bg)" stroke-width=".6" opacity=".35" fill="none"/></svg>';

  // Seeded, so the sky stays the same from one load to the next.
  const STARS = (() => {
    let seed = 2026_05_04;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    return Array.from({ length: 70 }, () => ({
      left: (random() * 100).toFixed(1),
      top: (random() * 100).toFixed(1),
      size: (1 + random() * 1.6).toFixed(1),
      twinkle: random() < 0.35,
      d: (2.5 + random() * 4).toFixed(1),
      delay: (-random() * 6).toFixed(1),
    }));
  })();
  const star = ({ left, top, size, twinkle, d, delay }) => `<i class="sw-star${twinkle ? ' twinkle' : ''}" style="left:${left}%;top:${top}%;--s:${size}px;--d:${d}s;--delay:${delay}s"></i>`;

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
    front: () => `${DEATH_STAR}<div class="sw-flyby"></div>`,
    back: () => STARS.map(star).join(''),
    ambient: flyby,
    every: [14_000, 30_000],
  });
})();
