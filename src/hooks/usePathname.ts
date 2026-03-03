import { useSyncExternalStore } from 'react';

// Patch History.prototype once to dispatch events on pushState/replaceState
// This allows SPA navigation (which doesn't fire popstate) to be observable.
if (typeof window !== 'undefined' && !(window as any).__popmeltPathPatch) {
  (window as any).__popmeltPathPatch = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const orig = History.prototype[method];
    History.prototype[method] = function (this: History, ...args: [any, string, (string | URL | null)?]) {
      const prevPath = window.location.pathname;
      orig.apply(this, args);
      window.dispatchEvent(new CustomEvent('popmelt:locationchange', { detail: { prevPath } }));
    };
  }
}

function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback);
  window.addEventListener('popmelt:locationchange', callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener('popmelt:locationchange', callback);
  };
}

function getSnapshot() {
  return window.location.pathname;
}

export function usePathname() {
  return useSyncExternalStore(subscribe, getSnapshot, () => '/');
}
