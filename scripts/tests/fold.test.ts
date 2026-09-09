import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

const kit = code(read('src/ui/kit.tsx'));
const css = read('src/styles.css');

const SCREENS = [
  'src/features/pantry/PantryScreen.tsx',
  'src/features/shopping/ShoppingScreen.tsx',
  'src/features/money/BudgetScreen.tsx',
  'src/features/money/TransactionsScreen.tsx',
] as const;

/**
 * A fold is the one addition to the interaction layer, and docs/DESIGN.md is
 * blunt about that layer: it is paid for on every single use. Twenty openings a
 * day means a fold that hides something needed is not a tidier screen, it is a
 * tax. These are the rules that keep it earning its tap.
 */

test('a shut section still says what is inside it', () => {
  // The whole justification. A fold that hides the signal along with the detail
  // has made the screen worse and merely shorter: the pantry exists to say what
  // ran out, and the budget to say what is left.
  for (const screen of SCREENS) {
    const source = code(read(screen));
    // To the closing tag, not to the first `>`: the props hold JSX of their
    // own, so `count={<span …>}` ends a lazy match in the middle of the tag.
    const folds = [...source.matchAll(/<Fold\b[\s\S]*?<\/Fold>/g)];
    assert.ok(folds.length > 0, `${screen} has no folded sections`);
    for (const fold of folds) {
      assert.match(fold[0], /\bnote=/, `a <Fold> in ${screen} hides its section without summarising it`);
      assert.match(fold[0], /\bcount=/, `a <Fold> in ${screen} does not say how much it is hiding`);
    }
  }
});

/**
 * Every `<Fold>` on a screen, with the block of code that renders it.
 *
 * The block runs from the `.map(` that produces the sections to the closing
 * tag, so everything declared inside it — the counts, the totals, the flags —
 * is exactly what the default is forbidden to see.
 */
function foldBlocks(source: string): { block: string; locals: string[]; fallback: string }[] {
  return [...source.matchAll(/\.map\(\(([\s\S]*?)<\/Fold>/g)].map((match) => {
    const block = match[1]!;
    const locals = [...block.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]!);
    // The section's own bindings: `([aisle, aisleProducts])`, `(item)`.
    const params = [...(/^\s*[([]([^)\]]*)[\])]/.exec(block)?.[1] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((m) => m[0]);
    const call = /folds\.isOpen\([^,]+,\s*([^)]*)\)/.exec(block);
    assert.ok(call, 'a <Fold> renders without folds.isOpen');
    let fallback = call![1]!.trim();
    // One level of indirection: `open={folds.isOpen(id, fallback)}` with
    // `const fallback = …` above it is the shape every screen uses.
    const bound = new RegExp(`\\bconst\\s+${fallback}\\s*=\\s*([^;]*);`).exec(block);
    if (bound) fallback = bound[1]!.trim();
    return { block, locals: [...locals, ...params].filter((n) => n !== call![1]!.trim()), fallback };
  });
}

test('nothing folds under a moving thumb', () => {
  // The real bug this replaces: defaults derived from the section's contents.
  // Tick the last item in an aisle and the aisle judged itself finished and
  // shut — mid-shop, under the thumb that ticked it. Allocate money that clears
  // an overspend and the budget group folded away from the person fixing it.
  //
  // The first fix carried the judgement in a ref. The better one is that there
  // is nothing to carry: a default that cannot see the rows cannot react to
  // them. So the rule is positional rather than syntactic — the fallback may
  // not name anything declared inside the block that renders the sections.
  // A screen-level flag (a search, a filter) is fine: only a deliberate act
  // changes it, and it can only ever open.
  //
  // The first version of this test checked the *name* passed to isOpen rather
  // than what that name was bound to, and passed happily against both bugs.
  for (const screen of SCREENS) {
    const blocks = foldBlocks(code(read(screen)));
    assert.ok(blocks.length > 0, `${screen} has no folds`);
    for (const { locals, fallback } of blocks) {
      for (const local of locals) {
        assert.ok(
          !new RegExp(`\\b${local}\\b`).test(fallback),
          `${screen} judges a fold by \`${local}\`, which is computed from the section's own rows — `
          + `the section can collapse under a tap (default: \`${fallback}\`)`,
        );
      }
    }
  }
});

test('every screen opens folded', () => {
  // The app opens as an index and expands on request. The only thing that may
  // override that is a deliberate narrowing, which opens sections and never
  // shuts one.
  for (const screen of SCREENS) {
    for (const { fallback } of foldBlocks(code(read(screen)))) {
      assert.notEqual(fallback, 'true', `${screen} opens a section by default`);
    }
  }
});

test('what is stored is a decision, never a state', () => {
  // A section nobody has touched must stay absent from storage, so the screen
  // is free to choose a better default next month. Writing the state instead
  // would freeze today's guess into every returning device forever.
  const useFolds = kit.slice(kit.indexOf('export function useFolds'));
  const body = useFolds.slice(0, useFolds.indexOf('\nexport '));
  const writes = [...body.matchAll(/setItem\(/g)];
  assert.equal(writes.length, 1, 'the fold map is written from more than one place');
  // The single write lives inside toggle — the only thing a person does on purpose.
  const toggle = body.slice(body.indexOf('const toggle'), body.indexOf('const isOpen'));
  assert.match(toggle, /setItem\(/, 'the stored map is written somewhere other than an explicit toggle');
});

test('storage never fails a tap', () => {
  // A private window, cleared site data, storage switched off: every one throws
  // on access, and none of them is a reason for a section to refuse to open.
  const useFolds = kit.slice(kit.indexOf('export function useFolds'));
  const body = useFolds.slice(0, useFolds.indexOf('\nexport '));
  assert.equal([...body.matchAll(/catch/g)].length, 2, 'a localStorage access is unguarded');
});

test('the disclosure mark is vertical, so no direction has to be chosen', () => {
  // Every sideways disclosure has to decide which way "forward" points, and
  // this page is right-to-left. Down and up mean the same thing in every
  // language; a rotation is the whole state change.
  assert.match(css, /\.fold-mark-open\s*\{[^}]*rotate\(180deg\)/);
  assert.ok(
    !/\.fold-mark[^{]*\{[^}]*rotate\((?!180deg)/.test(css),
    'the fold mark rotates by something other than a half turn',
  );
});

test('the fold header is a real target and a real heading', () => {
  // ≥48px is the one-handed minimum for anything pressed (docs/DESIGN.md §8),
  // and the heading keeps the section's own type: a screen where some headings
  // are chrome and others are controls reads as two screens.
  const head = css.slice(css.indexOf('.fold-head {'), css.indexOf('.fold-title'));
  assert.match(head, /min-height:\s*48px/);
  assert.match(head, /width:\s*100%/);
  assert.match(head, /font:\s*inherit/);
});

test('the header announces itself to a screen reader', () => {
  assert.match(kit, /aria-expanded=\{open\}/);
  assert.match(kit, /aria-controls=/);
});

test('a shut section is unmounted, not merely hidden', () => {
  // Sixty rows kept in the tree for a section nobody has open is sixty rows of
  // layout on every render, on the phone in the aisle.
  assert.match(kit, /\{open && </);
  assert.ok(!/fold[^\n]*display:\s*none/.test(css), 'a shut fold is hidden with CSS instead of unmounted');
});

test('the fold adds no motion beyond the mark', () => {
  // The ceiling is 120ms and the app pays it on every use. A height animation
  // on a section of sixty rows is the one place that ceiling would be missed.
  const folds = css.slice(css.indexOf('.fold-head {'), css.indexOf('.fold-head:active'));
  const transitions = [...folds.matchAll(/transition:[^;]+/g)].map((m) => m[0]);
  assert.deepEqual(
    transitions, ['transition: transform 120ms ease'],
    'the fold animates something other than its mark',
  );
});
