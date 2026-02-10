import { useEffect } from 'react';
import type { Annotation, AnnotationAction } from '../tools/types';

export function useWheelZoom(
  activeText: { linkedSelector?: string; fontSize: number } | null,
  setActiveText: React.Dispatch<React.SetStateAction<any>>,
  hoveredTextId: string | null,
  annotations: Annotation[],
  dispatch: React.Dispatch<AnnotationAction>,
) {
  useEffect(() => {
    const wheelHandler = (e: WheelEvent) => {
      // Handle edit mode scaling (activeText is set, but not linked annotations)
      if (activeText) {
        if (activeText.linkedSelector) return; // Linked annotations have fixed size
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? -2 : 2;
        setActiveText((prev: typeof activeText) => prev ? {
          ...prev,
          fontSize: Math.max(12, Math.min(72, prev.fontSize + delta)),
        } : null);
        return;
      }

      // Handle hover scaling (hoveredTextId is set)
      if (!hoveredTextId) return;

      e.preventDefault();
      const annotation = annotations.find((a) => a.id === hoveredTextId);
      if (annotation && annotation.type === 'text' && !annotation.linkedSelector) {
        const currentSize = annotation.fontSize || 12;
        const delta = e.deltaY > 0 ? -2 : 2;
        dispatch({
          type: 'UPDATE_TEXT_SIZE',
          payload: { id: hoveredTextId, fontSize: currentSize + delta },
        });
      }
    };

    window.addEventListener('wheel', wheelHandler, { passive: false });
    return () => {
      window.removeEventListener('wheel', wheelHandler);
    };
  }, [hoveredTextId, activeText, annotations, dispatch, setActiveText]);
}
