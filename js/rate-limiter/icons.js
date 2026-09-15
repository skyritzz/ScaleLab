/**
 * Rate Limiter Shared Icon Set
 *
 * Minimal, stroke-based line icons (24x24, stroke-width 2, currentColor) in the
 * same style already used for the app's own nav/theme icons. Replaces emoji
 * across the pipeline, race-condition, and distributed-topology visualizations
 * so every glyph reads as one consistent system instead of mixed platform emoji.
 *
 * Usage: RL_ICONS.database → raw <svg> string. Size/color are controlled by
 * the wrapping element (see .rl-icon-badge in css/rate-limiter.css).
 */

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const RL_ICONS = {
  client: svg(`<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>`),
  gateway: svg(`<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3 3 0 0 0 3-3v-1a3 3 0 0 0-3-3H9a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h1.5"/>`),
  shield: svg(`<path d="M12 3 19 6.5v5c0 5-3 8.5-7 9.5-4-1-7-4.5-7-9.5v-5Z"/><path d="m9 12 2 2 4-4"/>`),
  database: svg(`<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>`),
  zap: svg(`<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>`),
  lock: svg(`<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`),
  unlock: svg(`<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>`),
  alertTriangle: svg(`<path d="M12 3 22 20H2Z"/><path d="M12 9.5v4.5"/><path d="M12 17.2v.1"/>`),
  checkCircle: svg(`<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>`),
  xCircle: svg(`<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>`),
  server: svg(`<rect x="3" y="4" width="18" height="7" rx="1.75"/><rect x="3" y="13" width="18" height="7" rx="1.75"/><path d="M7 7.5h.01M7 16.5h.01"/>`),
  network: svg(`<circle cx="12" cy="5" r="2.25"/><circle cx="5" cy="19" r="2.25"/><circle cx="19" cy="19" r="2.25"/><path d="M12 7.25v3.5M12 10.75 6.6 16.6M12 10.75l5.4 5.85"/>`),
  pulse: svg(`<path d="M3 12h4l2-8 4 16 2-8h6"/>`),
  layers: svg(`<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>`),
};

/** Returns an inline-sized SVG icon inside a tinted rounded badge. Pass a hex/var color for the tint. */
export function rlIconBadge(name, { size = 36, iconSize = 18, color = 'currentColor', className = '' } = {}) {
  const icon = RL_ICONS[name] || RL_ICONS.server;
  return `<span class="rl-icon-badge ${className}" style="--ib-size:${size}px; --ib-icon-size:${iconSize}px; --ib-color:${color};">${icon}</span>`;
}

/** Returns a bare icon svg sized via CSS (no badge background). */
export function rlIcon(name, { size = 16, className = '' } = {}) {
  const icon = RL_ICONS[name] || RL_ICONS.server;
  return `<span class="rl-icon-bare ${className}" style="--ic-size:${size}px;">${icon}</span>`;
}
