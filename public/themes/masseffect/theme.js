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

  const OMNI_TOOL = '<svg class="me-omni" viewBox="0 0 66 54">'
    + '<g stroke="var(--me-armor-edge)" stroke-width=".7">'
    + '<path d="M-6,38L34,35Q40,34.6 44,36L52,38Q55,39 54,42L52,46Q50,48 46,47.5L34,47L-6,50Z" fill="var(--me-armor)"/>'
    + '<path d="M52,38Q58,36 60,39Q61,41 57,42L53,42.5" fill="var(--me-armor)"/></g>'
    + '<path d="M2,42.6L24,41" stroke="var(--me-red)" stroke-width="1.6"/>'
    + '<g class="holo" fill="none" stroke="var(--me-omni)">'
    + '<ellipse cx="38" cy="41.5" rx="3.2" ry="7.5" stroke-width="1.4" fill="var(--me-omni)" fill-opacity=".18"/>'
    + '<path d="M28,30L50,30L54,10L32,10Z" stroke-width="1" fill="var(--me-omni)" fill-opacity=".14"/>'
    + '<path d="M35,15H49M34.2,19H45M33.4,23H48" stroke-width=".9" opacity=".8"/>'
    + '<path class="scan" d="M31,28H51" stroke-width=".7" opacity=".9"/>'
    + '<path d="M38,34L37,30M38,34L45,30" stroke-width=".6" opacity=".6"/></g></svg>';

  const NORMANDY = '<svg class="me-normandy" viewBox="-28 -10 56 20">'
    + '<path d="M-26,0L-16,-4L8,-5.5L20,-2L27,0L20,2L8,5.5L-16,4Z" fill="currentColor"/>'
    + '<path d="M-12,-4L-4,-9.5L4,-4.8ZM-12,4L-4,9.5L4,4.8Z" fill="currentColor"/>'
    + '<path d="M-14,0H18" stroke="var(--me-red)" stroke-width=".9"/>'
    + '<path d="M14,-2.4L19,-1.2" stroke="var(--bg)" stroke-width=".9" opacity=".6"/>'
    + '<circle class="engine" cx="-25" cy="-1.6" r="1.4"/><circle class="engine" cx="-25" cy="1.6" r="1.4"/></svg>';

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
    front: () => `${OMNI_TOOL}<div class="me-flyby"></div>`,
    back: () => RELAY + PRRadarTheme.stars({ seed: 20071120, count: 88, className: 'me-star' }),
    ambient: flyby,
    every: [15_000, 30_000],
  });
})();
