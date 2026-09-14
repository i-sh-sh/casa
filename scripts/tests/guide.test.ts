import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const guide = read('public/guide.html');

/**
 * The guide, checked against the app it describes.
 *
 * A guide is the one document a couple reads *before* they can tell whether it
 * is true, which makes a stale sentence in it worse than a stale sentence
 * anywhere else: it is believed. The scene about joining a home had survived
 * two rewrites of the joining code still promising a waiting room that the app
 * no longer has — the very first thing a new couple does, described wrongly.
 *
 * So the facts the guide asserts about the app are read out of the app here.
 * Prose cannot be tested; the claims inside it can.
 */

/** The spoken half of every scene, keyed by its index label. */
function scenes(): { idx: string; n: number; say: string }[] {
  return [...guide.matchAll(/<section class="scene"[\s\S]*?<\/section>/g)].map((m) => {
    const idx = /<div class="idx">([^<]+)<\/div>/.exec(m[0])?.[1]?.trim() ?? '';
    const say = /<div class="say">([\s\S]*?)<\/div>\s*<\/section>/.exec(m[0])?.[1] ?? m[0];
    return { idx, n: Number(idx.slice(0, 2)), say };
  });
}

test('the film is numbered the way it is ordered', () => {
  // The counter reads «7 / 18» off these labels, so a duplicate or a gap left
  // by an inserted scene is visible on screen and nowhere else.
  const all = scenes();
  assert.ok(all.length >= 15, 'the guide lost scenes');
  all.forEach((scene, i) => {
    assert.equal(scene.n, i + 1, `scene ${i + 1} is labelled «${scene.idx}»`);
  });
  assert.equal(new Set(all.map((s) => s.idx)).size, all.length, 'two scenes share a label');
});

test('joining a home is described the way the code does it', () => {
  // acceptInvite spends the token and inserts the membership with the role the
  // link carries. There is no approval between opening a link and being in the
  // home, so the guide may not describe one: a couple told to wait for an
  // approval that never arrives concludes the app is broken.
  const accept = read('api/auth/[action].ts');
  const body = accept.slice(accept.indexOf('async function acceptInvite'));
  assert.match(body, /INSERT INTO household_members[\s\S]*?invite\.role/,
    'the invite no longer decides the role — the guide needs rewriting, not this test');
  assert.ok(!/'pending'/.test(body.slice(0, body.indexOf('setHouseholdCookie'))),
    'accepting an invite now parks the person as pending; the guide says it does not');

  const joining = scenes().find((s) => s.idx.includes('הבית שלכם'));
  assert.ok(joining, 'the guide no longer explains how a second person joins');
  for (const wrong of ['ממתין לאישור', 'ממתינה לאישור', 'מסך המתנה', 'ממתין לאישור בעל הבית']) {
    assert.ok(!joining!.say.includes(wrong),
      `the joining scene still promises a waiting room («${wrong}»)`);
  }
});

test('the guide calls each role what the app calls it', () => {
  // Two vocabularies for the same four roles is how «צופה» in the guide and
  // «viewer» on screen become two different features in somebody's head.
  const labels = read('src/features/settings/SettingsScreen.tsx');
  const map = /ROLE_LABELS[^=]*=\s*\{([\s\S]*?)\}/.exec(labels)?.[1] ?? '';
  const known = [...map.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(known.length >= 4, 'the role labels moved');

  // Only the words the guide sets in «angle quotes» are claims about the app's
  // own vocabulary; ordinary prose is free.
  const quoted = [...guide.matchAll(/«([^»]{2,20})»/g)].map((m) => m[1]!);
  const roleish = quoted.filter((q) => /^(בעל הבית|שותף|שותפה|צופה|ממתין|חבר)/.test(q));
  for (const word of roleish) {
    assert.ok(known.includes(word), `the guide calls a role «${word}», the app does not`);
  }
});

test('the guide promises that the money is not left on the device', () => {
  // The offline scene makes a privacy claim, and the service worker is the only
  // thing that can keep it. If an API path that carries money is ever added to
  // that allowlist, this fails before a phone does.
  const sw = read('public/sw.js');
  const list = /const CACHEABLE_API = \[([\s\S]*?)\]/.exec(sw)?.[1] ?? '';
  const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(paths.length > 0, 'the cache allowlist moved');
  for (const path of paths) {
    assert.ok(!/money|budget|transaction|account/.test(path),
      `${path} is cached on the device, and the guide promises the money is not`);
  }

  const offline = scenes().find((s) => s.idx.includes('בלי קליטה'));
  assert.ok(offline, 'the guide no longer explains working without a signal');
  assert.match(offline!.say, /הכסף לא/, 'the offline scene stopped making the promise');
});

test('the film waits for the reader', () => {
  // Measured in a browser at 390×844: every one of the eighteen scenes is
  // taller than the screen. So on a phone — the only device this guide is
  // actually read on — reading a scene *means* scrolling, and a clock that
  // keeps running takes the paragraph away mid-sentence and then drops the
  // reader into the middle of a scene whose opening they never saw.
  //
  // Verified in a browser from both directions before this was written: the
  // progress bar freezes at the same width across 2.5s while scrolled down,
  // and advances again within 900ms of returning to the top.
  const script = guide.slice(guide.indexOf('<script>'));
  const scroll = /addEventListener\('scroll'[\s\S]*?\}, \{ passive: true \}\)/.exec(script)?.[0];
  assert.ok(scroll, 'nothing stops the clock while somebody is reading');
  assert.match(scroll!, /playing = false/, 'scrolling away no longer pauses the film');
  assert.match(scroll!, /playing = true/, 'coming back to the top no longer restarts it');

  // And a scene must begin at its own beginning, or the fix above merely moves
  // the problem: the clock waits, but for a scene shown from the middle.
  const go = script.slice(script.indexOf('function go('), script.indexOf('var waiting'));
  assert.match(go, /scrollTo\(0, 0\)/, 'a new scene keeps the previous scene\'s scroll position');
});

test('the counter is right before the script runs', () => {
  // Server-rendered text that the projector overwrites on load — which means a
  // stale number here is visible exactly once per visit, in the first frame,
  // and never in any state a test of the running page would reach.
  const printed = /<span class="count n" id="clock">([^<]+)<\/span>/.exec(guide)?.[1]?.trim();
  assert.equal(printed, `1 / ${scenes().length}`);
});

test('no scene outstays a phone screen', () => {
  // The guide plays itself. A scene that cannot be read inside its own
  // duration is not a scene, it is a pause button somebody has to find.
  for (const section of guide.match(/<section class="scene"[^>]*>/g) ?? []) {
    const dur = Number(/data-dur="(\d+)"/.exec(section)?.[1] ?? 0);
    assert.ok(dur >= 8 && dur <= 14, `a scene runs for ${dur}s`);
  }
  for (const scene of scenes()) {
    const words = scene.say.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length;
    assert.ok(words <= 95, `«${scene.idx}» says ${words} words — more than one breath`);
  }
});
