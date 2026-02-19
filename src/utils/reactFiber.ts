// Get React component info from a DOM element via React fiber
export function getReactComponentInfo(element: Element): { name: string; path: string[] } | null {
  // Find the fiber key (has random suffix per React instance)
  const fiberKey = Object.keys(element).find(
    key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
  );

  if (!fiberKey) return null;

  let fiber = (element as unknown as Record<string, unknown>)[fiberKey] as {
    type?: { displayName?: string; name?: string };
    return?: unknown;
  } | null;

  const path: string[] = [];

  // Walk up the fiber tree to build component hierarchy
  while (fiber) {
    const type = fiber.type;
    const name = type?.displayName || type?.name;

    // Keep PascalCase names (React components), skip lowercase (DOM elements)
    // Also skip anonymous functions and internal React types
    if (
      name &&
      typeof name === 'string' &&
      /^[A-Z]/.test(name) &&
      !name.startsWith('_') &&
      name !== 'Fragment'
    ) {
      path.unshift(name);
    }

    fiber = fiber.return as typeof fiber;
  }

  return path.length > 0
    ? { name: path[path.length - 1]!, path }
    : null;
}

export type FiberNode = {
  type?: { displayName?: string; name?: string } | string;
  return?: FiberNode | null;
  child?: FiberNode | null;
  sibling?: FiberNode | null;
  stateNode?: unknown;
  tag?: number;
};

/** Collect PascalCase component fibers from a DOM element up to the root. */
export function collectComponentFibers(element: Element): { name: string; fiber: FiberNode }[] {
  const fiberKey = Object.keys(element).find(
    key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
  );
  if (!fiberKey) return [];

  let fiber = (element as unknown as Record<string, unknown>)[fiberKey] as FiberNode | null;
  const results: { name: string; fiber: FiberNode }[] = [];

  while (fiber) {
    const type = fiber.type;
    const name = typeof type === 'function' || typeof type === 'object'
      ? (type as Record<string, unknown>)?.displayName || (type as Record<string, unknown>)?.name
      : null;
    if (
      name &&
      typeof name === 'string' &&
      /^[A-Z]/.test(name) &&
      !name.startsWith('_') &&
      name !== 'Fragment'
    ) {
      results.push({ name, fiber });
    }
    fiber = fiber.return as FiberNode | null;
  }

  // Reverse so root is first, leaf is last
  results.reverse();
  return results;
}

/** Find the outermost DOM element owned by a fiber (walk fiber.child until a host fiber with stateNode Element). */
export function findFiberRootElement(fiber: FiberNode): Element | null {
  // Host fibers have tag 5 (HostComponent) and a stateNode that is an Element
  let current: FiberNode | null = fiber;
  const visited = new Set<FiberNode>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.stateNode instanceof Element) {
      return current.stateNode;
    }
    // Walk into children
    if (current.child) {
      current = current.child;
    } else {
      current = null;
    }
  }
  return null;
}
