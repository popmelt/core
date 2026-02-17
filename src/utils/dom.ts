export {
  extractElementInfo,
  getDirectTextContent,
  getTopmostElementAtPoint,
  getReactComponentInfo,
  captureElementsAtBounds,
  captureElementsAtPoints,
  getUniqueSelector,
  findElementBySelector,
  resolveRegionToElement,
  getComponentBoundary,
  findComponentBoundaryByName,
  findAllComponentBoundariesByName,
  getComponentPositions,
  findSpacingUsages,
  findSpacingUsagesByBinding,
  type ComponentBoundary,
  type SpacingRect,
  type TokenBinding,
} from './domQuery';

export {
  getComputedStyleValue,
  getRawStyleValue,
  getAuthoredStyleValue,
  isFlexOrGrid,
  getComputedGap,
  type GapZone,
  computeGapZones,
  isAutoGap,
  getComputedPadding,
  type BorderRadiusCorner,
  getComputedBorderRadius,
  isTextElement,
  getTextBoundingRect,
  getComputedTextProperties,
} from './styleRead';

export {
  applyInlineStyle,
  revertInlineStyle,
  applyStyleModifications,
  revertElementStyles,
  revertAllStyles,
} from './styleWrite';

export {
  type ColorVariable,
  getColorVariables,
  resolveColorValue,
  findMatchingColorVariable,
} from './colorVariables';
