'use strict';

(() => {
  const RELAY = '<svg class="me-relay" viewBox="0 0 200 200">'
    + '<g fill="currentColor">'
    + '<path d="M28,178C60,140 92,104 150,30L160,36C112,104 78,146 40,186Z"/>'
    + '<path d="M58,190C96,150 130,112 186,48L194,56C142,118 108,158 70,196Z"/>'
    + '<path d="M24,184l22-10l18,20l-22,8z"/></g>'
    + '<ellipse class="ring a" cx="110" cy="112" rx="34" ry="12" transform="rotate(-48 110 112)"/>'
    + '<ellipse class="ring b" cx="110" cy="112" rx="22" ry="8" transform="rotate(-48 110 112)"/>'
    + '<circle class="core" cx="110" cy="112" r="9"/></svg>';

  const NORMANDY = '<svg class="me-normandy" viewBox="-28 -10 56 20">'
    + '<path d="M-26,0L-16,-4L8,-5.5L20,-2L27,0L20,2L8,5.5L-16,4Z" fill="currentColor"/>'
    + '<path d="M-12,-4L-4,-9.5L4,-4.8ZM-12,4L-4,9.5L4,4.8Z" fill="currentColor"/>'
    + '<path d="M-14,0H18" stroke="var(--me-red)" stroke-width=".9"/>'
    + '<path d="M14,-2.4L19,-1.2" stroke="var(--bg)" stroke-width=".9" opacity=".6"/>'
    + '<circle class="engine" cx="-25" cy="-1.6" r="1.4"/><circle class="engine" cx="-25" cy="1.6" r="1.4"/></svg>';

  // The Normandy crosses the top of the window, one way or the other, its drive trailing.
  function flyby({ front }) {
    const lane = front.querySelector('.me-flyby');
    if (!lane) return;
    lane.classList.toggle('rtl', Math.random() < 0.5);
    lane.style.setProperty('--y', `${(8 + Math.random() * 30).toFixed(0)}vh`);
    lane.style.setProperty('--drop', `${((Math.random() - 0.5) * 12).toFixed(0)}vh`);
    lane.innerHTML = `<div class="me-craft"><i class="me-trail"></i>${NORMANDY}</div>`;
    lane.classList.remove('fly');
    void lane.getBoundingClientRect();
    lane.classList.add('fly');
  }

  PRRadarTheme.register({
    front: () => `${RELAY}<div class="me-flyby"></div>`,
    back: () => PRRadarTheme.stars({ seed: 20071120, count: 88, className: 'me-star' }),
    ambient: flyby,
    every: [15_000, 30_000],
  });
})();
