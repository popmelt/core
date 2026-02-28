'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ShadowHostProps = {
  children: ReactNode;
};

// ---------------------------------------------------------------------------
// Host stylesheet mirroring
//
// Component previews (LibraryPanel) re-render real React components inside
// the shadow root. Those components rely on the host page's CSS (Tailwind,
// CSS-in-JS, global stylesheets) to display correctly. Since the shadow
// boundary blocks inheritance of document stylesheets, we mirror them in.
//
// Popmelt's own chrome is unaffected — it uses inline styles exclusively,
// which always win over class/element selectors from the mirrored sheets.
// ---------------------------------------------------------------------------

function isStylesheet(el: Element): boolean {
  if (el.tagName === 'STYLE') return true;
  if (el.tagName === 'LINK' && (el as HTMLLinkElement).rel === 'stylesheet') return true;
  return false;
}

/**
 * Clone all document stylesheets into `shadow`, observe for additions/removals,
 * and return a cleanup function.
 */
function mirrorHostStyles(shadow: ShadowRoot): () => void {
  const cloneMap = new Map<Element, Element>();

  // Sentinel: mirrored styles are inserted before this node so they appear
  // before the React content root (and before ShadowChrome's reset).
  const sentinel = shadow.firstChild;

  function insertClone(original: Element) {
    if (cloneMap.has(original)) return;
    // Don't re-mirror our own clones (shouldn't happen, but guard)
    if (original.hasAttribute('data-pm-mirror')) return;

    const clone = original.cloneNode(true) as Element;
    clone.setAttribute('data-pm-mirror', '');
    shadow.insertBefore(clone, sentinel);
    cloneMap.set(original, clone);
  }

  function removeClone(original: Element) {
    const clone = cloneMap.get(original);
    if (clone) {
      clone.remove();
      cloneMap.delete(original);
    }
  }

  // --- Initial sync ---
  for (const el of document.querySelectorAll('link[rel="stylesheet"], style')) {
    // Skip styles inside our own shadow host
    if (el.getRootNode() !== document) continue;
    insertClone(el);
  }

  // --- Adopted stylesheets (constructable sheets used by some frameworks) ---
  try {
    if (document.adoptedStyleSheets.length > 0) {
      shadow.adoptedStyleSheets = [
        ...document.adoptedStyleSheets,
        ...shadow.adoptedStyleSheets,
      ];
    }
  } catch { /* adoptedStyleSheets not supported or immutable */ }

  // --- Observe dynamic additions/removals ---
  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      if (mut.type === 'childList') {
        for (const node of mut.addedNodes) {
          if (node instanceof Element && isStylesheet(node)) {
            insertClone(node);
          }
        }
        for (const node of mut.removedNodes) {
          if (node instanceof Element) {
            removeClone(node);
          }
        }
      }
    }
  });

  // Watch head (primary) and body (some frameworks inject there)
  observer.observe(document.head, { childList: true });
  if (document.body) {
    observer.observe(document.body, { childList: true });
  }

  return () => {
    observer.disconnect();
    for (const clone of cloneMap.values()) clone.remove();
    cloneMap.clear();
  };
}

/**
 * Renders children inside a shadow DOM via createPortal.
 *
 * Unlike createRoot, createPortal keeps children in the same React tree —
 * context, refs, state, and event bubbling all work normally. The shadow
 * boundary provides CSS isolation without breaking React's internals.
 *
 * Host-page stylesheets are automatically mirrored into the shadow root
 * so that component previews render with the page's CSS classes intact.
 */
export function ShadowHost({ children }: ShadowHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || host.shadowRoot) return;

    const shadow = host.attachShadow({ mode: 'open' });
    const root = document.createElement('div');
    root.setAttribute('data-popmelt-root', '');
    shadow.appendChild(root);
    setShadowRoot(shadow);
    setContainer(root);
  }, []);

  // Mirror host stylesheets after the shadow root is ready
  useEffect(() => {
    if (!shadowRoot) return;
    return mirrorHostStyles(shadowRoot);
  }, [shadowRoot]);

  return (
    <>
      <div
        ref={hostRef}
        data-popmelt-shadow-host
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'visible' }}
      />
      {container && createPortal(children, container)}
    </>
  );
}
