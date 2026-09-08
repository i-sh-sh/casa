/**
 * The icon set. Drawn here, not imported.
 *
 * Every glyph is built on the same 24×24 grid with a 1.75px stroke, **butt
 * caps and miter joins** — square ends and sharp corners. That is the whole
 * construction rule, and it is chosen against the alternative: Lucide's
 * 2px round-cap set is excellent and is now on so many screens that it reads
 * as a default rather than a decision.
 *
 * `vector-effect="non-scaling-stroke"` keeps the line exactly 1.75px at every
 * size, so a 16px icon beside a label has the same weight as a 24px one in
 * the nav. Without it the small ones go spindly and the set stops cohering.
 *
 * Icons are `aria-hidden` by default and never carry meaning alone: every one
 * of them sits beside its own word. Two people who meet a private symbol once
 * a week will never learn it.
 */

export type IconName =
  | 'home' | 'cart' | 'pantry' | 'ledger' | 'dials'
  | 'plus' | 'minus' | 'box' | 'box-ticked' | 'close'
  | 'back' | 'search' | 'alert' | 'lock';

const PATHS: Record<IconName, string> = {
  // A house reduced to a gable and a wall. No door, no chimney, no window —
  // at 18px they collapse into noise.
  home: 'M3.5 11.5 12 4l8.5 7.5M6 10.5V20h12v-9.5',

  // A basket: a trapezoid with a square handle. Not a trolley — a trolley
  // needs wheels, and wheels are two circles that mush at small sizes.
  cart: 'M4 9h16l-1.6 11H5.6L4 9ZM8.5 9V5.5h7V9',

  // A cupboard, not a jar. Two shelves say "what is in the house" more
  // plainly than any single container could.
  pantry: 'M4 4h16v16H4V4ZM4 10h16M4 15h16M12 4v16',

  // The ledger itself: a page with its money column ruled off down the left.
  // The one icon in the set that is literally the product.
  ledger: 'M5 3h14v18H5V3ZM15 3v18M8 8h4M8 12h4',

  // Not a gear. A gear is the single most reused icon on the web, and this
  // set can afford one place to differ: two ruled sliders with square handles.
  dials: 'M4 8h16M4 16h16M9 5.5v5M16 13.5v5',

  plus:  'M12 5v14M5 12h14',
  minus: 'M5 12h14',

  // The tick target on the shopping list. The empty box and the ticked box
  // are the same square so nothing moves when it changes state — a shifting
  // glyph under a walking thumb is how the wrong row gets tapped.
  'box':        'M4 4h16v16H4V4Z',
  'box-ticked': 'M4 4h16v16H4V4ZM7.5 12.2l3 3 6-6.4',

  close: 'M5.5 5.5l13 13M18.5 5.5l-13 13',

  // Points left because the page is RTL: forward travel is leftward.
  back: 'M14.5 5.5 8 12l6.5 6.5',

  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.3 15.3 20 20',

  // A square, not a triangle. The triangle-with-a-bang is the stock warning
  // glyph; a ruled box with a bar reads as a stamped mark in a ledger.
  alert: 'M4 4h16v16H4V4ZM12 8v5M12 16h.01',

  lock: 'M6 10.5h12V20H6v-9.5ZM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3',
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      vectorEffect="non-scaling-stroke"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <path d={PATHS[name]} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
