import type { CSSProperties } from 'react';

/**
 * 4×4 diagonal-stripe tile (from diag.svg), wrapped in a 12×12 SVG so
 * border-image-slice: 4 produces tileable 4×4 edge regions.
 */
const DIAG_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMicgaGVpZ2h0PScxMic+PGRlZnM+PHBhdHRlcm4gaWQ9J2QnIHdpZHRoPSc0JyBoZWlnaHQ9JzQnIHBhdHRlcm5Vbml0cz0ndXNlclNwYWNlT25Vc2UnPjxwYXRoIGQ9J00tMSwxIGwyLC0yIE0wLDQgbDQsLTQgTTMsNSBsMiwtMicgc3Ryb2tlPSdibGFjaycgc3Ryb2tlLXdpZHRoPScuNScvPjwvcGF0dGVybj48L2RlZnM+PHJlY3Qgd2lkdGg9JzEyJyBoZWlnaHQ9JzEyJyBmaWxsPSd1cmwoI2QpJy8+PC9zdmc+';

/** Shared diagonal-line border used across all Popmelt chrome. */
export const POPMELT_BORDER: Pick<CSSProperties, 'borderWidth' | 'borderStyle' | 'borderImage'> = {
  borderWidth: 3,
  borderStyle: 'solid',
  borderImage: `url("${DIAG_SVG}") 4 / 1.9 / 0 round`,
};
