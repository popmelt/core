'use client';

import type { CSSProperties } from 'react';
import React, { useCallback, useEffect, useState } from 'react';

import { useSpinner } from '../hooks/useSpinner';
import type { AnnotationAction, StyleModification } from '../tools/types';
import { findElementBySelector } from '../utils/dom';

type ModifiedElementBadgesProps = {
  styleModifications: StyleModification[];
  isInspecting: boolean; // Hide all badges when an element is being inspected
  accentColor: string;
  annotationGroupCount: number; // Number of annotation groups for numbering
  dispatch: React.Dispatch<AnnotationAction>;
  inFlightSelectors?: Set<string>;
};

type BadgeData = {
  selector: string;
  modIndex: number;
  top: number;
  left: number;
  label: string;
  changeCount: number;
  annotationNumber: number;
};

// Build element label from modification info
function buildElementLabel(mod: StyleModification): string {
  const { element } = mod;
  const tagName = element.tagName;
  const id = element.id ? `#${element.id}` : '';
  const classes = element.className
    ? '.' + element.className.split(' ').slice(0, 2).join('.')
    : '';
  const reactComponent = element.reactComponent;

  return reactComponent
    ? `<${reactComponent}> ${tagName}${id}${classes}`
    : `${tagName}${id}${classes}`;
}

const TOOLTIP_HEIGHT = 22;
const BADGE_HIT_PAD = 12;

/** Fixed-position badge wrapper that stays within the viewport via CSS clamping. */
function BadgeHitArea({ left, top, style, children, ...props }: {
  left: number;
  top: number;
  style?: CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style'>) {
  return (
    <div data-devtools="badge-hit-area" {...props} style={{
      position: 'fixed',
      left: `max(0px, ${left}px)`,
      top: `max(0px, ${top}px)`,
      padding: BADGE_HIT_PAD,
      transform: `translate(min(0px, calc(100vw - max(0px, ${left}px) - 100%)), min(0px, calc(100vh - max(0px, ${top}px) - 100%)))`,
      ...style,
    }}>
      {children}
    </div>
  );
}

export function ModifiedElementBadges({
  styleModifications,
  isInspecting,
  accentColor,
  annotationGroupCount,
  dispatch,
  inFlightSelectors,
}: ModifiedElementBadgesProps) {
  const [badges, setBadges] = useState<BadgeData[]>([]);

  // Spinner animation for in-flight badges
  const hasInFlight = inFlightSelectors && inFlightSelectors.size > 0;
  const { charIndex, word: thinkingWord } = useSpinner(!!hasInFlight);

  useEffect(() => {
    // Hide all badges when inspecting an element
    if (isInspecting) {
      setBadges([]);
      return;
    }

    let animationFrameId: number | null = null;

    const updateBadges = () => {
      const newBadges: BadgeData[] = [];

      styleModifications.forEach((mod, index) => {
        const el = findElementBySelector(mod.selector);
        if (!el) return;

        const rect = el.getBoundingClientRect();
        newBadges.push({
          selector: mod.selector,
          modIndex: index,
          top: rect.top >= TOOLTIP_HEIGHT ? rect.top - TOOLTIP_HEIGHT : rect.bottom,
          left: rect.left,
          label: buildElementLabel(mod),
          changeCount: mod.changes.length,
          annotationNumber: annotationGroupCount + index + 1,
        });
      });

      setBadges(newBadges);
    };

    const scheduleUpdate = () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = requestAnimationFrame(updateBadges);
    };

    updateBadges();

    // Update on scroll/resize
    window.addEventListener('scroll', scheduleUpdate, true);
    window.addEventListener('resize', scheduleUpdate, true);

    // Watch for DOM mutations that could affect element positions (e.g. Claude changing styles)
    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['style', 'class'],
    });

    // Reposition after fonts/images finish loading (layout shifts not caught by MutationObserver)
    window.addEventListener('load', scheduleUpdate);
    document.fonts.ready.then(scheduleUpdate);

    return () => {
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', scheduleUpdate, true);
      window.removeEventListener('load', scheduleUpdate);
      observer.disconnect();
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [styleModifications, isInspecting, annotationGroupCount]);

  const handleBadgeClick = useCallback((modIndex: number) => {
    const mod = styleModifications[modIndex];
    if (!mod) return;

    const el = findElementBySelector(mod.selector);
    if (!el) return;

    // Clear annotation selection
    dispatch({ type: 'SELECT_ANNOTATION', payload: { id: null } });

    // Switch to inspector tool and select the element
    dispatch({ type: 'SET_TOOL', payload: 'inspector' });
    dispatch({
      type: 'SELECT_ELEMENT',
      payload: { el, info: mod.element },
    });
  }, [styleModifications, dispatch]);

  if (badges.length === 0) return null;

  const tooltipStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    backgroundColor: accentColor,
    color: '#fff',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    padding: '4px 8px',
    borderRadius: 0,
    whiteSpace: 'nowrap',
    maxWidth: 400,
  };

  const labelStyle: CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
    minWidth: 0,
  };

  return (
    <>
      {badges.map((badge) => {
        const isInFlight = inFlightSelectors?.has(badge.selector);
        return (
          <BadgeHitArea
            key={badge.selector}
            left={badge.left - BADGE_HIT_PAD}
            top={badge.top - BADGE_HIT_PAD}
            onClick={() => handleBadgeClick(badge.modIndex)}
            style={{
              zIndex: 10000,
              cursor: 'pointer',
              pointerEvents: 'auto',
            }}
          >
            <div
              data-devtools="badge"
              style={{
                ...tooltipStyle,
                backgroundColor: isInFlight ? '#999999' : accentColor,
              }}
            >
              <span>{badge.annotationNumber}.</span>
              <span style={labelStyle}>{badge.label}</span>
              <span style={{ opacity: 0.8 }}>
                ({badge.changeCount} {badge.changeCount === 1 ? 'change' : 'changes'})
              </span>
              {isInFlight && (
                <span style={{ opacity: 0.8, marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
                    {charIndex === 1 ? (
                      <>
                        <circle cx="7" cy="7" r="2" />
                        <circle cx="17" cy="7" r="2" />
                        <circle cx="7" cy="17" r="2" />
                        <circle cx="17" cy="17" r="2" />
                      </>
                    ) : (
                      <>
                        <circle cx="12" cy="6" r="2" />
                        <circle cx="6" cy="12" r="2" />
                        <circle cx="18" cy="12" r="2" />
                        <circle cx="12" cy="18" r="2" />
                      </>
                    )}
                  </svg>
                  {thinkingWord}
                </span>
              )}
            </div>
          </BadgeHitArea>
        );
      })}
    </>
  );
}
