import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Six screens do not need a routing library.
 *
 * react-router is 20kB and a set of concepts, in exchange for nested routes,
 * loaders and data revalidation — none of which this app has. What it does
 * need is a back button that works and a URL that can be bookmarked, and that
 * is `history.pushState` plus a `popstate` listener.
 */

interface RouterValue {
  path: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue>({ path: '/', navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (to === window.location.pathname) return;
    if (opts?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setPath(to);
    // A new screen starts at its top. Without this, navigating from halfway
    // down a long transaction list lands mid-way down the next screen.
    window.scrollTo(0, 0);
  }, []);

  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode } & Record<string, unknown>) {
  const { path, navigate } = useRouter();
  const active = path === to || (to !== '/' && path.startsWith(to));
  return (
    <a
      href={to}
      className={className}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        // Ctrl/Cmd-click and middle-click must keep opening a new tab. A
        // router that swallows them is a router people fight with.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
