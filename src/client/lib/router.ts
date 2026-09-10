import { useCallback, useEffect, useState } from 'react';

export interface Location {
  path: string;
  query: URLSearchParams;
}

function read(): Location {
  return {
    path: window.location.pathname.replace(/\/+$/, '') || '/',
    query: new URLSearchParams(window.location.search),
  };
}

/**
 * The app has five screens and no nested routes, so a full router would be
 * more machinery than the problem deserves.
 */
export function useLocation(): [Location, (to: string, replace?: boolean) => void] {
  const [loc, setLoc] = useState<Location>(read);

  useEffect(() => {
    const onPop = () => setLoc(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, replace = false) => {
    if (replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    setLoc(read());
  }, []);

  return [loc, navigate];
}
