// Generate a CSS selector for an element
export function getElementSelector(el: Element): string {
  if (el.id) {
    return `#${el.id}`;
  }

  const tagName = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 3).join('.');

  if (classes) {
    return `${tagName}.${classes}`;
  }

  return tagName;
}

// Generate a unique, stable selector for an element
export function getUniqueSelector(el: Element): string {
  // First, try ID (most reliable)
  if (el.id && !el.id.startsWith('radix-') && !el.id.startsWith(':')) {
    return `#${CSS.escape(el.id)}`;
  }

  // Build path from element to document
  const path: string[] = [];
  let current: Element | null = el;

  while (current && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    // Add id if available
    if (current.id && !current.id.startsWith('radix-') && !current.id.startsWith(':')) {
      path.unshift(`#${CSS.escape(current.id)}`);
      break; // ID is unique, stop here
    }

    // Add class names (first 2 meaningful ones)
    const classes = Array.from(current.classList)
      .filter(c => !c.startsWith('_') && c.length < 30)
      .slice(0, 2);
    if (classes.length > 0) {
      selector += '.' + classes.map(c => CSS.escape(c)).join('.');
    }

    // Add nth-child if needed to disambiguate
    const parentEl: Element | null = current.parentElement;
    if (parentEl) {
      const siblings = Array.from(parentEl.children).filter(
        (child) => child.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = parentEl;
  }

  return path.join(' > ');
}

// Find an element by its selector
export function findElementBySelector(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    // Invalid selector
    return null;
  }
}
