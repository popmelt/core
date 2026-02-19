import { collectComponentFibers, findFiberRootElement, type FiberNode } from './reactFiber';

export type ComponentBoundary = {
  name: string;
  path: string[];       // Full PascalCase ancestor chain, root-first
  depthIndex: number;   // Currently selected index in path
  rootElement: Element;  // Component's outermost DOM node
};

/**
 * Get the component boundary at a DOM element.
 * Default selection = innermost component. depthOffset moves toward root (positive = shallower).
 */
export function getComponentBoundary(element: Element, depthOffset = 0): ComponentBoundary | null {
  const fibers = collectComponentFibers(element);
  if (fibers.length === 0) return null;

  const path = fibers.map(f => f.name);
  // Default = innermost (last). Offset moves toward root.
  const defaultIndex = fibers.length - 1;
  const targetIndex = Math.max(0, Math.min(fibers.length - 1, defaultIndex - depthOffset));

  const selected = fibers[targetIndex]!;
  const rootElement = findFiberRootElement(selected.fiber) ?? element;

  return {
    name: selected.name,
    path,
    depthIndex: targetIndex,
    rootElement,
  };
}

/** Walk the page DOM to find a component by name and return its boundary. */
export function findComponentBoundaryByName(name: string): ComponentBoundary | null {
  const results = findAllComponentBoundariesByName(name);
  return results[0] ?? null;
}

/** Find a named component in a DOM element's fiber chain (any depth, not just innermost).
 *  Tries exact match first, then fuzzy (one name contains the other, min 4 chars). */
function findNamedBoundary(element: Element, name: string): ComponentBoundary | null {
  const fibers = collectComponentFibers(element);
  const nameLower = name.toLowerCase();
  let fuzzyIdx = -1;
  for (let i = fibers.length - 1; i >= 0; i--) {
    const fiberName = fibers[i]!.name;
    if (fiberName === name) {
      const rootElement = findFiberRootElement(fibers[i]!.fiber) ?? element;
      return { name, path: fibers.map(f => f.name), depthIndex: i, rootElement };
    }
    // Fuzzy: one name contains the other (min 4 chars for the shorter string)
    if (fuzzyIdx === -1) {
      const fiberLower = fiberName.toLowerCase();
      if (
        (fiberLower.length >= 4 && nameLower.includes(fiberLower)) ||
        (nameLower.length >= 4 && fiberLower.includes(nameLower))
      ) {
        fuzzyIdx = i;
      }
    }
  }
  if (fuzzyIdx >= 0) {
    const rootElement = findFiberRootElement(fibers[fuzzyIdx]!.fiber) ?? element;
    return { name, path: fibers.map(f => f.name), depthIndex: fuzzyIdx, rootElement };
  }
  return null;
}

/** Walk the page DOM to find all instances of a component by name (checks full fiber chain). */
export function findAllComponentBoundariesByName(name: string): ComponentBoundary[] {
  const walker = createPopmeltTreeWalker();
  const results: ComponentBoundary[] = [];
  const seen = new Set<Element>();
  let node: Node | null = walker.currentNode;
  while ((node = walker.nextNode())) {
    const boundary = findNamedBoundary(node as Element, name);
    if (boundary && !seen.has(boundary.rootElement)) {
      seen.add(boundary.rootElement);
      results.push(boundary);
    }
  }
  return results;
}

/**
 * Single DOM walk to find the vertical position (top of first instance) for each
 * component name in the given set. Returns a Map<name, y>.
 * Checks the full fiber chain at each element, not just the innermost.
 * Components not found on the page get `Infinity` so they sort last.
 */
export function getComponentPositions(names: Set<string>): Map<string, number> {
  const positions = new Map<string, number>();
  if (names.size === 0) return positions;
  const remaining = new Set(names);
  const walker = createPopmeltTreeWalker();
  const seen = new Set<Element>();
  let node: Node | null = walker.currentNode;
  while ((node = walker.nextNode()) && remaining.size > 0) {
    for (const modelName of remaining) {
      const boundary = findNamedBoundary(node as Element, modelName);
      if (!boundary || seen.has(boundary.rootElement)) continue;
      seen.add(boundary.rootElement);
      const rect = boundary.rootElement.getBoundingClientRect();
      positions.set(modelName, rect.top + window.scrollY);
      remaining.delete(modelName);
      break;
    }
  }
  // Components not found on the page sort last
  for (const name of remaining) {
    positions.set(name, Infinity);
  }
  return positions;
}

export function createPopmeltTreeWalker(): TreeWalker {
  return document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (el.closest('#devtools-toolbar, #devtools-canvas, #devtools-scrim, [data-popmelt-panel]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}
