import type { ReactNode } from 'react';

/**
 * The masthead every screen shares.
 *
 * Set in Frank Ruhl Libre 900 — the one place per screen the display face is
 * allowed to speak. It does not stick to the top and it carries no hairline
 * of its own: the first rule on the page belongs to the first section, and a
 * second rule directly above it would read as a header bar, which is a card
 * lying on its side.
 */
export function TopBar({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="masthead">
      <div className="masthead-row">
        <div className="grow">
          <h1>{title}</h1>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        {action}
      </div>
    </header>
  );
}
