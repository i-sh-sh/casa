import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * The design rules, enforced.
 *
 * docs/DESIGN.md names a set of values that are banned outright, because each
 * one is a recognisable signature of template-made design. A document that
 * bans them is a wish; a test that fails on them is a system. This is the
 * cheap half of design review — it cannot tell you whether a screen is good,
 * only that it has not quietly slid back to the defaults.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  };
  walk(join(root, dir));
  return out;
}

const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * The file with its prose stripped out.
 *
 * These assertions are about declarations, and both files are heavily
 * commented — largely with the very names being banned, since that is how a
 * rule explains itself. Matching raw text made the stylesheet fail on
 * "Not #FFFFFF, not #F8FAFC" in a comment saying exactly why it isn't used.
 * The assertion was right; the input was wrong.
 */
const declarations = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

const css = () => declarations(read('src/styles.css'));

// ── The emoji ban ────────────────────────────────────────────────────────

test('no emoji anywhere in the interface or the messages it sends', () => {
  // The single clearest tell. An emoji used as an icon is font-dependent,
  // renders differently on every platform, cannot be given a colour token or
  // a stroke weight, and announces that nobody drew anything.
  const pictograph = /\p{Extended_Pictographic}/u;
  const offenders: string[] = [];

  const files = [
    ...sourceFiles('src', ['.tsx', '.ts', '.css']),
    ...sourceFiles('api', ['.ts']),
    join(root, 'public/guide.html'),
  ];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const found = [...line].filter((c) => pictograph.test(c));
      if (found.length) offenders.push(`${relative(root, file)}:${i + 1}  ${found.join(' ')}`);
    });
  }

  assert.deepEqual(offenders, [], `emoji found — use src/ui/Icon.tsx instead:\n${offenders.join('\n')}`);
});

// ── The palette ban ──────────────────────────────────────────────────────

test('none of the default palettes appear in the stylesheet', () => {
  // Tailwind's indigo and violet, the semantic green/amber/red triad, the
  // slate page ground and the slate dark mode. Every one of them is a value
  // nobody chose, which is exactly why the eye reads them as machine-made.
  const BANNED: Record<string, string> = {
    '#6366f1': 'indigo-500',
    '#8b5cf6': 'violet-500',
    '#0ea5e9': 'sky-500',
    '#10b981': 'emerald-500',
    '#f59e0b': 'amber-500',
    '#ef4444': 'red-500',
    '#f8fafc': 'slate-50 page ground',
    '#0f172a': 'slate-900 dark mode',
    '#e5e7eb': 'gray-200 border',
    '#6b7280': 'gray-500 secondary text',
  };
  const source = css().toLowerCase();
  for (const [hex, name] of Object.entries(BANNED)) {
    assert.ok(!source.includes(hex), `${hex} (${name}) is banned — see docs/DESIGN.md §9`);
  }
});

test('the guide is painted in the app\'s own palette, not a copy that drifted', () => {
  // public/guide.html mirrors the tokens instead of importing them, because
  // Vite hashes the real stylesheet into /assets/index-<hash>.css and a static
  // page cannot name that file. Mirroring is a real cost — two places to
  // change a colour — and this is what stops the second place going stale.
  const guide = declarations(read('public/guide.html'));
  const app = css();
  for (const token of ['--paper', '--ink', '--red', '--blue', '--rule']) {
    const inApp = new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(app);
    const inGuide = new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(guide);
    assert.ok(inApp && inGuide, `${token} must be defined in both`);
    assert.equal(
      inGuide[1]!.toLowerCase(), inApp[1]!.toLowerCase(),
      `${token} has drifted between src/styles.css and public/guide.html`,
    );
  }
});

test('there is no green in the app at all', () => {
  // The most unusual rule here, and it comes from accounting rather than
  // taste: black is in-credit, red is overdrawn. A healthy envelope is set in
  // plain ink and gets no reward colour, which is what leaves the red pencil
  // meaning something when it does appear.
  const hexes = css().match(/#[0-9a-f]{6}\b/gi) ?? [];
  for (const hex of hexes) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const dominantGreen = g > r + 24 && g > b + 24;
    assert.ok(!dominantGreen, `${hex} reads as green — the palette is paper, ink and one red pencil`);
  }
});

// ── The shape ban ────────────────────────────────────────────────────────

test('nothing is rounded and nothing floats', () => {
  // The one weird decision, held everywhere regardless of cost. A generator
  // cannot keep a constraint that hurts; keeping it is most of what makes the
  // app look authored.
  const radii = css().match(/border-radius:\s*([^;]+);/g) ?? [];
  for (const rule of radii) {
    assert.ok(/:\s*0(\s|!|;|$)/.test(rule), `${rule.trim()} — every radius must be 0 (docs/DESIGN.md §4)`);
  }
  const shadows = css().match(/box-shadow:\s*([^;]+);/g) ?? [];
  for (const rule of shadows) {
    assert.ok(/none/.test(rule), `${rule.trim()} — this app has no elevation; separate with a rule`);
  }
});

// ── The typography ban ───────────────────────────────────────────────────

test('the banned typefaces are not loaded or referenced', () => {
  // Heebo, Assistant and Rubik are the Google Fonts Hebrew default trio and
  // the house style of every Israeli side project; Inter is the same fact in
  // Latin. Using them is not a neutral choice, it is the absence of one.
  const sources = [declarations(read('index.html')), css()].join('\n');
  for (const family of ['Heebo', 'Assistant', 'Rubik', 'Inter', 'Plus Jakarta', 'Manrope', 'DM Sans', 'Space Grotesk']) {
    assert.ok(
      !new RegExp(`\\b${family}\\b`, 'i').test(sources),
      `${family} is banned — the app is set in Frank Ruhl Libre, Alef and IBM Plex Mono`,
    );
  }
});

test('the three faces it does use are all loaded', () => {
  const html = read('index.html');
  for (const family of ['Frank+Ruhl+Libre', 'Alef', 'IBM+Plex+Mono']) {
    assert.ok(html.includes(family), `${family} is used in the stylesheet but never loaded`);
  }
});

// ── The one-handed floor ─────────────────────────────────────────────────

test('touch targets keep their one-handed minimums', () => {
  // Read while walking, one hand, basket in the other. These are not style
  // values and they are not negotiable downward.
  const source = css();
  const rowHeight = /--row-h:\s*(\d+)px/.exec(source);
  assert.ok(rowHeight && Number(rowHeight[1]) >= 64, 'a list row must stay at least 64px tall');

  // Every button variant, not just the base one. The small variants are
  // smaller in ink, never in target — a rendered measurement caught `btn-sm`
  // and `btn-quiet` at 40px, and `btn-sm` is what the pantry's plus and minus
  // use, which are the most-pressed controls in the app.
  const variants = [...source.matchAll(/\.(btn[\w-]*|tab)\s*\{([^}]*)\}/g)];
  assert.ok(variants.length >= 4, 'expected to find the button variants');
  for (const [, name, body] of variants) {
    const declared = /min-height:\s*(\d+)px/.exec(body ?? '');
    if (!declared) continue; // inherits the base rule
    assert.ok(Number(declared[1]) >= 44, `.${name} declares a ${declared[1]}px target — the floor is 44px`);
  }
});

test('the money column is a fixed width, not a floor', () => {
  // The design's central claim is that every amount hangs on one invisible
  // vertical. `min-width` cannot deliver that: it sets a floor, so a row
  // holding ₪43,200 grows its box past a row holding ₪1,200 and their right
  // edges part company.
  //
  // This survived a rendered measurement because every amount on screen at the
  // time was the same order of magnitude. It only appeared once a projection
  // put ₪1,200 directly above ₪43,200 — so the rule is asserted here rather
  // than left to the next screenshot that happens to mix magnitudes.
  for (const [file, selector] of [['src/styles.css', '.amount'], ['public/guide.html', '.amt']] as const) {
    const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(declarations(read(file)));
    assert.ok(block, `${selector} must be defined in ${file}`);
    const body = block[1] ?? '';
    assert.ok(/width:\s*[\d.]+em/.test(body), `${selector} in ${file} needs a fixed width`);
    assert.ok(!/min-width:/.test(body), `${selector} in ${file} uses min-width — a floor does not align a column`);
  }
});

test('motion stays under the ceiling the app set itself', () => {
  // Opened twenty times a day for eight seconds. Anything expressive here is
  // paid for again on every single use.
  const durations = [...css().matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  for (const ms of durations) {
    assert.ok(ms <= 200, `${ms}ms exceeds the motion ceiling — nothing may stand between a tap and its mark`);
  }
});
