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

  const CREW = '<svg class="st-crew" viewBox="0 0 24 52"><g stroke="var(--st-line)" stroke-width=".6">'
    + '<rect x="5" y="30" width="6.5" height="19" fill="var(--st-pants)"/><rect x="12.5" y="30" width="6.5" height="19" fill="var(--st-pants)"/>'
    + '<rect x="4.5" y="48" width="7" height="3" rx="1" fill="var(--st-pants)"/><rect x="12.5" y="48" width="7" height="3" rx="1" fill="var(--st-pants)"/>'
    + '<rect x="1" y="13.5" width="3.6" height="15" rx="1.8" fill="var(--st-shirt)"/><rect x="19.4" y="13.5" width="3.6" height="15" rx="1.8" fill="var(--st-shirt)"/>'
    + '<circle cx="2.8" cy="29.5" r="1.7" fill="var(--st-skin)"/><circle cx="21.2" cy="29.5" r="1.7" fill="var(--st-skin)"/>'
    + '<path d="M4.5,14Q12,10.5 19.5,14L19.5,31H4.5Z" fill="var(--st-shirt)"/>'
    + '<rect x="10.3" y="9" width="3.4" height="3" fill="var(--st-skin)"/>'
    + '<circle cx="12" cy="6" r="4.4" fill="var(--st-skin)"/></g>'
    + '<path d="M7.6,6.2C7.4,2.6 9.6,1.4 12,1.4S16.6,2.6 16.4,6.2C15.4,4.2 13.6,3.6 12,3.6S8.6,4.2 7.6,6.2Z" fill="var(--st-pants)"/>'
    + '<path d="M8.6,12.4Q12,14.6 15.4,12.4" stroke="var(--st-pants)" stroke-width="1.4" fill="none"/>'
    + '<path d="M8,16.2l1.2,3.4l-1.2,-.9l-1.2,.9z" fill="var(--st-gold)"/></svg>';
  const SPARKLES = Array.from({ length: 12 }, (_, index) =>
    `<i style="--x:${(8 + (index * 37) % 84)}%;--y:${(index * 23) % 78}%;--d:${(-(index * 0.37) % 1.1).toFixed(2)}s"></i>`).join('');
  const TRANSPORTER = `<div class="st-transporter"><div class="st-beam">${SPARKLES}</div>${CREW}</div>`;

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
    front: () => `<div class="st-nebula"></div><i class="st-nebula-core"></i>${TRANSPORTER}<div class="st-warp"></div>`,
    back: () => STARS.map(star).join(''),
    ambient: warp,
    every: [16_000, 32_000],
  });
})();
