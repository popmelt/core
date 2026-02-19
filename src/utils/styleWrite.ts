import type { StyleModification } from '../tools/types';
import { findElementBySelector } from './cssSelector';

// Apply an inline style to an element
export function applyInlineStyle(el: Element, property: string, value: string): void {
  if (el instanceof HTMLElement) {
    el.style.setProperty(property, value, 'important');
  }
}

// Revert an inline style to its original value
export function revertInlineStyle(el: Element, property: string, original: string): void {
  if (el instanceof HTMLElement) {
    // Remove the inline style
    el.style.removeProperty(property);
    // If there was an original inline value (not from stylesheet), restore it
    // The original value from getComputedStyle includes both inline and stylesheet styles
    // We only need to remove our override - the stylesheet/inline value will take over
  }
}

// Apply all style modifications to the DOM (used on restore)
export function applyStyleModifications(modifications: StyleModification[]): void {
  for (const mod of modifications) {
    let el = findElementBySelector(mod.selector);
    // After refresh, data-pm attributes are gone — fall back to durable selector
    if (!el && mod.durableSelector) {
      el = findElementBySelector(mod.durableSelector);
      if (el) {
        // Re-tag element so the data-pm selector works for the rest of the session
        const pmId = mod.selector.match(/\[data-pm="([^"]+)"\]/)?.[1];
        if (pmId) el.setAttribute('data-pm', pmId);
      }
    }
    if (el) {
      for (const change of mod.changes) {
        applyInlineStyle(el, change.property, change.modified);
      }
    }
  }
}

// Revert all style modifications on an element
export function revertElementStyles(selector: string, modifications: StyleModification[]): void {
  const el = findElementBySelector(selector);
  if (!el) return;

  const mod = modifications.find(m => m.selector === selector);
  if (!mod) return;

  for (const change of mod.changes) {
    revertInlineStyle(el, change.property, change.original);
  }
}

// Revert all style modifications
export function revertAllStyles(modifications: StyleModification[]): void {
  for (const mod of modifications) {
    const el = findElementBySelector(mod.selector);
    if (el) {
      for (const change of mod.changes) {
        revertInlineStyle(el, change.property, change.original);
      }
    }
  }
}
