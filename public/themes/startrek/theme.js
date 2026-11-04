'use strict';

(() => {
  // Seeded, so the sky stays the same from one load to the next.
  const STARS = (() => {
    let seed = 1966_09_08;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    return Array.from({ length: 88 }, () => ({
      left: (random() * 100).toFixed(1),
      top: (random() * 100).toFixed(1),
      size: (1 + random() * 1.6).toFixed(1),
      twinkle: random() < 0.35,
      d: (2.5 + random() * 4).toFixed(1),
      delay: (-random() * 6).toFixed(1),
    }));
  })();
  const star = ({ left, top, size, twinkle, d, delay }) => `<i class="st-star${twinkle ? ' twinkle' : ''}" style="left:${left}%;top:${top}%;--s:${size}px;--d:${d}s;--delay:${delay}s"></i>`;

  const ENTERPRISE = '<svg class="st-ship" viewBox="-28 -12 52 24">'
    + '<g fill="currentColor"><rect x="-26" y="-10" width="17" height="3" rx="1.5"/><rect x="-26" y="7" width="17" height="3" rx="1.5"/>'
    + '<path d="M-7,0L-13,-8M-7,0L-13,8" stroke="currentColor" stroke-width="1.4"/>'
    + '<ellipse cx="-6" cy="0" rx="8" ry="2.6"/><rect x="0" y="-1.2" width="6" height="2.4"/><circle cx="13" cy="0" r="10"/></g>'
    + '<circle cx="13" cy="0" r="3.2" fill="var(--bg)" opacity=".35"/>'
    + '<circle cx="-9.5" cy="-8.5" r="1.4" fill="var(--st-bussard)"/><circle cx="-9.5" cy="8.5" r="1.4" fill="var(--st-bussard)"/>'
    + '<path d="M-24,-8.5h12M-24,8.5h12" stroke="var(--st-warp)" stroke-width="1"/></svg>';

  // The Enterprise drifts in at impulse, then stretches and jumps to warp.
  function warp({ front }) {
    const lane = front.querySelector('.st-warp');
    if (!lane) return;
    lane.classList.toggle('rtl', Math.random() < 0.5);
    lane.style.setProperty('--y', `${(8 + Math.random() * 30).toFixed(0)}vh`);
    lane.innerHTML = `<div class="st-craft">${ENTERPRISE}</div>`;
    lane.classList.remove('engage');
    void lane.getBoundingClientRect();
    lane.classList.add('engage');
  }

  PRRadarTheme.register({
    front: () => '<div class="st-warp"></div>',
    back: () => STARS.map(star).join(''),
    ambient: warp,
    every: [16_000, 32_000],
  });
})();
