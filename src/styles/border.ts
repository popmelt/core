import type { CSSProperties } from 'react';

/** Shared diagonal-line border used across all Popmelt chrome. */
export const POPMELT_BORDER: Pick<CSSProperties, 'borderWidth' | 'borderStyle' | 'borderImage'> = {
  borderWidth: 4,
  borderStyle: 'solid',
  borderImage:
    'repeating-linear-gradient(-45deg, rgba(0,0,0,1) 0, rgba(0,0,0,1) 1px, rgba(0,0,0,0.1) 1px, rgba(0,0,0,0.1) 4px) 4',
};
