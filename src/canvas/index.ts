import { createRoot } from 'react-dom/client';
import { createElement } from 'react';

import { CanvasApp } from './CanvasApp';

export function mountCanvas(
  root: HTMLElement,
  config: { devOrigin: string; bridgeOrigin: string },
) {
  const reactRoot = createRoot(root);
  reactRoot.render(createElement(CanvasApp, config));
}
