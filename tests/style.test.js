// style.css guards: colors only via the --ot-* tokens, the two themes keep
// WCAG AA text contrast, and !important stays limited to the documented cases.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

const css = read('style.css');

// The declarations of a top-level block, e.g. ':host' -> { '--ot-bg': '#fff' }.
function tokens(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out = {};
  body.replace(/(--ot-[\w-]+):\s*([^;]+);/g, (_, k, v) => { out[k] = v.trim(); });
  return out;
}
const LIGHT = tokens(':host');
const DARK = { ...LIGHT, ...tokens(':host([data-theme="dark"])') };

function rgba(value) {
  let m = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16)).concat(1);
  }
  m = value.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(m, `not a color: ${value}`);
  const p = m[1].split(',').map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const luminance = (c) => {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token layers (bottom first), minimum ratio]
// 4.5 = AA for normal text, 3 = AA for UI components (focus ring, icons).
const PAIRS = [
  ['text', ['bg'], 4.5], ['text-strong', ['entry-bg'], 4.5], ['text-secondary', ['entry-bg'], 4.5],
  ['text-muted', ['bg'], 4.5], ['text-muted', ['bg-subtle'], 4.5], ['text-muted', ['bg-muted'], 4.5],
  ['text-subtle', ['bg'], 4.5], ['text-subtle', ['bg-sunken'], 4.5], ['text-subtle', ['bg-subtle'], 4.5],
  ['text-subtle', ['bg-sunken', 'cal-bg'], 4.5], ['text', ['input-bg'], 4.5], ['text-subtle', ['input-bg'], 4.5],
  ['accent-text', ['bg'], 4.5], ['accent-text', ['accent-subtle'], 4.5], ['accent-strong', ['accent-subtle'], 4.5],
  ['accent-text', ['bg-sunken', 'sel-bg'], 4.5], ['accent-text', ['bg-sunken', 'ghost-bg'], 4.5],
  ['on-accent', ['accent-solid'], 4.5], ['on-accent', ['accent-solid-hover'], 4.5], ['on-accent', ['danger-solid'], 4.5],
  ['badge-text', ['badge-bg'], 4.5],
  ['cal-text', ['bg-sunken', 'cal-bg'], 4.5], ['cal-text', ['bg-sunken', 'cal-bg-hover'], 4.5], ['cal-meta', ['bg-sunken', 'cal-bg'], 4.5],
  ['cal-pop-title', ['bg'], 4.5], ['cal-pop-hint', ['bg'], 4.5], ['text-secondary', ['cal-pop-desc-bg'], 4.5],
  ['danger', ['bg'], 4.5], ['danger-text', ['danger-bg'], 4.5], ['warn-text', ['warn-bg'], 4.5],
  ['success', ['bg'], 4.5], ['success', ['bg-subtle'], 4.5], ['busy', ['bg'], 4.5],
  ['toast-text', ['toast-bg'], 4.5], ['toast-action', ['toast-bg'], 4.5], ['toast-bg', ['toast-action'], 4.5], ['toast-error', ['toast-bg'], 3],
  ['text', ['accent-subtle'], 4.5], ['text-subtle', ['accent-subtle'], 4.5], ['text-muted', ['bg-sunken'], 4.5],
  ['focus', ['bg'], 3], ['focus', ['bg-sunken'], 3], ['accent', ['bg'], 3], ['cal-muted', ['bg-sunken', 'cal-bg'], 3],
  ['text-muted', ['bg-sunken', 'tl-work-bg'], 4.5], ['cal-text', ['bg-sunken', 'tl-work-bg', 'cal-bg'], 4.5],
  ['on-now', ['now'], 4.5], ['now', ['bg-sunken'], 3],
  ['cal-text', ['bg'], 4.5], ['text-secondary', ['bg-muted'], 4.5], ['accent-text', ['bg-sunken', 'tl-work-bg'], 4.5],
  ['absent-text', ['absent-bg'], 4.5], ['absent-text', ['bg'], 4.5], ['star', ['bg'], 3], ['star', ['bg-muted'], 3], ['star', ['accent-subtle'], 3],
  ['rec-text', ['rec-bg'], 4.5], ['rec', ['rec-bg'], 3],
  // Book meetings dialog: count badge, footer summary, errors, hover states.
  ['bg', ['cal-text'], 4.5], ['text-secondary', ['bg-subtle'], 4.5], ['danger-text', ['bg'], 4.5],
  ['text', ['bg-hover-tint'], 4.5], ['accent-text', ['accent-border'], 3], ['warn-text', ['bg'], 4.5],
  // Booked (read-only) entries: text on the muted hatched surface (hatch over bg).
  ['text-strong', ['booked-bg', 'booked-hatch'], 4.5], ['text-secondary', ['booked-bg', 'booked-hatch'], 4.5],
  ['text-muted', ['booked-bg', 'booked-hatch'], 4.5],
  // Day meters: the under-target total is text (AA); the bars are UI (3:1 on the track).
  ['meter-under', ['bg'], 4.5], ['meter-under', ['bg-subtle'], 4.5], ['meter-under', ['accent-subtle'], 4.5], ['meter-under', ['bg-sunken'], 4.5],
  ['meter-met', ['meter-track'], 3], ['meter-under', ['meter-track'], 3], ['meter-today', ['meter-track'], 3],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`project-${i}`, ['entry-bg'], 3]),
];

describe('style.css theme tokens', () => {
  for (const [name, theme, page] of [['light', LIGHT, [255, 255, 255, 1]], ['dark', DARK, [0, 0, 0, 1]]]) {
    it(`meets WCAG AA contrast in the ${name} theme`, () => {
      const failures = [];
      for (const [fg, layers, min] of PAIRS) {
        const bg = layers.reduce((acc, l) => over(rgba(theme[`--ot-${l}`]), acc), page);
        const ratio = contrast(over(rgba(theme[`--ot-${fg}`]), bg), bg);
        if (ratio < min) failures.push(`${fg} on ${layers.join('+')}: ${ratio.toFixed(2)} < ${min}`);
      }
      assert.deepEqual(failures, []);
    });
  }

  it('defines every dark token as a light token too', () => {
    const extra = Object.keys(tokens(':host([data-theme="dark"])')).filter((k) => !(k in LIGHT));
    assert.deepEqual(extra, []);
  });

  it('uses only defined tokens', () => {
    const used = [...new Set(css.match(/var\(--ot-[\w-]+\)/g).map((v) => v.slice(4, -1)))];
    assert.deepEqual(used.filter((t) => !(t in LIGHT)), []);
  });

  it('hard-codes no colors outside the token blocks', () => {
    const outside = css.replace(/\n:host(\([^)]*\))? \{[\s\S]*?\n\}/g, '');
    assert.deepEqual(outside.match(/#[0-9a-f]{3,6}\b|rgba?\(/gi) || [], []);
  });

  it('keeps !important to the documented host reset and [hidden]', () => {
    const decls = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[\w-]+:[^;{}]*!important/g);
    assert.deepEqual(decls, ['all: initial !important', 'display: none !important']);
  });
});
