export {
  getReactComponentInfo,
} from './reactFiber';

export {
  getUniqueSelector,
  findElementBySelector,
} from './cssSelector';

export {
  getComponentBoundary,
  findComponentBoundaryByName,
  findAllComponentBoundariesByName,
  getComponentPositions,
  type ComponentBoundary,
} from './componentBoundary';

export {
  extractElementInfo,
  getDirectTextContent,
  getTopmostElementAtPoint,
  captureElementsAtBounds,
  captureElementsAtPoints,
  resolveRegionToElement,
} from './elementExtraction';

export {
  findSpacingUsages,
  findSpacingUsagesByBinding,
  type SpacingRect,
  type TokenBinding,
} from './spacingAnalysis';

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
