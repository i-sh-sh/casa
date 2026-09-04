import { useEffect, useState, type ReactNode } from 'react';

/**
 * The header every screen shares.
 *
 * The only behaviour it has is the hairline that appears once the page has
 * scrolled — without it a sticky header floats over the content with nothing
 * separating them, and the first row of a list looks like it belongs to the
 * title.
 */
export function TopBar({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="topbar" data-scrolled={scrolled}>
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
      </div>
      <div className="spacer" />
      {action}
    </header>
  );
}
