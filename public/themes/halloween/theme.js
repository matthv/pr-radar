'use strict';

(() => {
  function spiderWeb() {
    const size = 150;
    const angle = step => Math.PI + (step / 5) * (Math.PI / 2);
    const at = (radius, step) => `${(size + radius * Math.cos(angle(step))).toFixed(1)},${(size + radius * Math.sin(angle(step))).toFixed(1)}`;
    const spokes = [0, 1, 2, 3, 4, 5].map(step => `M${size},${size}L${at(160, step)}`);
    const rings = [30, 58, 86, 114, 140].flatMap(radius => [0, 1, 2, 3, 4]
      .map(step => `M${at(radius, step)}Q${at(radius * 0.86, step + 0.5)} ${at(radius, step + 1)}`));
    return `<svg class="hw-web" viewBox="0 0 ${size} ${size}"><path d="${[...spokes, ...rings].join('')}" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
  }

  // Legs drawn on the left, mirrored on the right; each turns on its hip, the two alternate
  // sets of four stepping in turn as a real spider walks.
  const SPIDER_LEGS = [
    [[-2, -1.6], [-6, -7.5], [-9, -11.5]],
    [[-2.3, -0.5], [-8, -4.5], [-11.5, -2]],
    [[-2.3, 0.8], [-8, 1.5], [-11.5, 6]],
    [[-1.7, 2], [-6, 6.5], [-8, 11.5]],
  ];
  const SPIDER = (() => {
    const leg = (points, set) => {
      const xs = points.map(p => p[0]);
      const ys = points.map(p => p[1]);
      const [hipX, hipY] = points[0];
      const origin = `${((hipX - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs)) * 100).toFixed(0)}% ${((hipY - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys)) * 100).toFixed(0)}%`;
      return `<path class="leg ${set}" style="transform-origin:${origin}" d="M${points.map(p => p.join(',')).join('L')}"/>`;
    };
    const legs = SPIDER_LEGS.flatMap((points, index) => [
      leg(points, index % 2 ? 'b' : 'a'),
      leg(points.map(([x, y]) => [-x, y]), index % 2 ? 'a' : 'b'),
    ]);
    return '<svg class="hw-spider" viewBox="-12 -12 24 24">'
      + `<g fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${legs.join('')}</g>`
      + '<ellipse cx="0" cy="4" rx="3.8" ry="5" fill="currentColor"/><circle cx="0" cy="-1.6" r="2.6" fill="currentColor"/>'
      + '<circle class="eye" cx="-0.9" cy="-2.6" r=".6" fill="var(--hw-orange)"/><circle class="eye" cx="0.9" cy="-2.6" r=".6" fill="var(--hw-orange)"/></svg>';
  })();

  const GHOST_PATH = 'M20 2C10 2 3 10 3 21v25l5-5 5 5 5-5 5 5 5-5 5 5 4-5V21C37 10 30 2 20 2Z';
  const ghost = ({ left, top, w, d, delay, dx }) => `<svg class="hw-ghost" viewBox="0 0 40 48" style="left:${left};top:${top};--w:${w}px;--d:${d}s;--delay:${delay}s;--dx:${dx}px">`
    + `<path d="${GHOST_PATH}" fill="currentColor"/><ellipse cx="14" cy="20" rx="2.6" ry="3.6" fill="var(--bg)"/><ellipse cx="26" cy="20" rx="2.6" ry="3.6" fill="var(--bg)"/></svg>`;
  // Along the edges, in the gap between the columns, and inside them where a column runs
  // short: they peek out wherever no card covers them.
  const GHOSTS = [
    { left: '-12px', top: '24%', w: 46, d: 13, delay: 0, dx: 10 },
    { left: '34%', top: '50%', w: 34, d: 10, delay: -4, dx: 8 },
    { left: '-8px', top: '86%', w: 52, d: 15, delay: -8, dx: 12 },
    { left: 'calc(100% - 34px)', top: '34%', w: 44, d: 12, delay: -2, dx: -10 },
    { left: '48.8%', top: '84%', w: 30, d: 9, delay: -6, dx: -8 },
    { left: '49.2%', top: '44%', w: 30, d: 11, delay: -3, dx: 6 },
    { left: '24%', top: '27%', w: 26, d: 10, delay: -7, dx: 14 },
    { left: '70%', top: '26%', w: 32, d: 14, delay: -11, dx: -12 },
    { left: '64%', top: '56%', w: 48, d: 16, delay: -13, dx: 18 },
    { left: '21%', top: '72%', w: 40, d: 13, delay: -1, dx: -14 },
  ];

  // Each bolt is drawn anew: a jagged channel from the top of the window, split again and
  // again by midpoint displacement, with a few thinner forks off it.
  function lightning(width, height) {
    const jag = (from, to, spread, depth) => {
      if (!depth) return [from, to];
      const mid = [(from[0] + to[0]) / 2 + (Math.random() - 0.5) * spread, (from[1] + to[1]) / 2 + (Math.random() - 0.5) * spread * 0.3];
      return [...jag(from, mid, spread / 2, depth - 1), ...jag(mid, to, spread / 2, depth - 1).slice(1)];
    };
    const x = width * (0.15 + Math.random() * 0.7);
    const trunk = jag([x, 0], [x + (Math.random() - 0.5) * width * 0.3, height * (0.6 + Math.random() * 0.35)], height * 0.35, 7);
    const forks = Array.from({ length: 4 }, () => {
      const from = trunk[Math.floor(trunk.length * (0.15 + Math.random() * 0.6))];
      const length = height * (0.12 + Math.random() * 0.22);
      const lean = (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.6);
      return jag(from, [from[0] + lean * length, from[1] + length * 0.9], length * 0.5, 5);
    });
    const path = points => 'M' + points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L');
    return { x, trunk: path(trunk), forks: forks.map(path) };
  }

  function strike({ front, back }) {
    const storm = back.querySelector('.hw-storm');
    const flash = front.querySelector('.hw-flash');
    if (!storm || !flash) return;
    const { innerWidth: width, innerHeight: height } = window;
    const bolt = lightning(width, height);
    const strokes = (kind, size) => `<path class="${kind}" d="${bolt.trunk}" stroke-width="${size}"/>`
      + bolt.forks.map(fork => `<path class="${kind}" d="${fork}" stroke-width="${size / 2}"/>`).join('');
    storm.setAttribute('viewBox', `0 0 ${width} ${height}`);
    storm.innerHTML = strokes('glow', 16) + strokes('core', 2.6);
    flash.style.setProperty('--x', `${(bolt.x / width * 100).toFixed(0)}%`);
    for (const node of [storm, flash]) {
      node.classList.remove('strike');
      void node.getBoundingClientRect();
      node.classList.add('strike');
    }
  }

  PRRadarTheme.register({
    front: () => `${spiderWeb()}${SPIDER}<div class="hw-flash"></div>`,
    back: () => `${GHOSTS.map(ghost).join('')}<svg class="hw-storm"></svg>`,
    ambient: strike,
    every: [9_000, 21_000],
  });
})();
