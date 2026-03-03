<p align="center">
  <img src="src/assets/bar - popmelt.png" alt="Popmelt" width="360" style="border-radius: 12px;" />
</p>

# Popmelt

## What is it?

Popmelt is a design collaboration layer for AI coding agents. Drop it into any React codebase and get a full design-feedback loop: draw on your running UI, pin feedback to elements, adjust style and layout directly, and hand off annotated screenshots with full technical context in a keystroke.

It works with AI CLI tools like [Claude Code](https://code.claude.com/docs/en/cli-reference) and [Codex](https://developers.openai.com/codex/cli/) — your agent sees exactly what you marked up, understands the code behind it, and edits your files.

<p align="center">
  <img src="src/assets/bar - annotations.png" alt="Popmelt annotations on a running app" width="720" style="border-radius: 6px;" />
</p>

**Popmelt is free to use and completely local**. It runs inside your codebase, with your existing AI CLI tools handling code changes behind the scenes. You don't need an account to use it and we never see your data.

## Quick start

### Install

```bash
npm install @popmelt.com/core
```

Peer dependencies: `react >=18`, `react-dom >=18`, `lucide-react >=0.400`.

### Frontend

Wrap your app in `PopmeltProvider`. In development, double-tap Cmd/Ctrl to open the toolbar.

```tsx
import { PopmeltProvider } from '@popmelt.com/core';
import { useRouter } from 'next/navigation';

export default function App() {
  const router = useRouter();

  return (
    <PopmeltProvider navigate={router.push}>
      {/* your app */}
    </PopmeltProvider>
  );
}
```

The `navigate` prop enables multi-page annotation support. Pass your framework's router push function (e.g. `router.push` in Next.js, `navigate` in React Router).

### Backend

Start the bridge server so Popmelt can talk to Claude/Codex. Use the plugin for your framework:

**Next.js** — wrap your config:

```ts
// next.config.ts
import { withPopmelt } from '@popmelt.com/core/next';
export default withPopmelt(nextConfig);
```

**Vite**:

```ts
// vite.config.ts
import { popmelt } from '@popmelt.com/core/vite';
export default defineConfig({ plugins: [popmelt()] });
```

**Astro**:

```ts
// astro.config.mjs
import { popmelt } from '@popmelt.com/core/astro';
export default defineConfig({ integrations: [popmelt()] });
```

**Other frameworks** — call `startPopmelt()` in your dev server startup:

```ts
import { startPopmelt } from '@popmelt.com/core/server';
await startPopmelt();
```

### CLI

Run the bridge standalone if you prefer not to integrate it into your dev server:

```bash
# standalone bridge server
npx @popmelt.com/core bridge

# bridge + dev server together
npx @popmelt.com/core wrap -- next dev
npx @popmelt.com/core wrap -- vite
```

### That's it

Open your app in the browser and double-tap Cmd (or Ctrl) to toggle the toolbar. Draw, type, point at things, hit Cmd+Enter. Your AI sees your annotated screenshot and code context and gets to work.

## Annotation tools

| Tool | Shortcut | What it does |
|------|----------|-------------|
| **Comment** | `C` | Click any element to pin a comment. Captures tag, classes, React component name, and ancestor context. |
| **Handle** | `H` | Drag padding, gap, border-radius, font-size, and line-height handles directly on elements. Shift to snap to a scale. |
| **Model** | `M` | Hover elements to see component boundaries. Click to promote a component or token into your design model. |
| **Rectangle** | `R` | Draw a rectangle to highlight a region. Auto-prompts for a text label. |
| **Oval** | `O` | Draw an ellipse. |
| **Line** | `L` | Draw a straight line. |
| **Pen** | `P` | Freehand drawing. |
| **Text** | `T` | Click to place a text label anywhere. |

<p align="center">
  <img src="src/assets/bar - comment.png" alt="Comment tool guidance" width="360" style="border-radius: 12px;" />
  <img src="src/assets/bar - rectangle.png" alt="Rectangle tool guidance" width="360" style="border-radius: 12px;" />
  <img src="src/assets/bar - text.png" alt="Text tool guidance" width="360" style="border-radius: 12px;" />
</p>

## Handle tool

Switch to the Handle tool (`H`) and hover any element to see draggable handles for its spatial properties:

- **Padding** — drag the inner edges of any element to adjust padding per-side. Hold Shift to snap to a scale (0, 2, 4, 8, 12, 16, 20, 24, 32).
- **Gap** — drag between flex or grid children to adjust row/column gap.
- **Border radius** — drag element corners to round them.
- **Font size** — drag the right edge of a text element to resize.
- **Line height** — drag below a text element to adjust leading.

All changes apply as inline styles instantly. Hold Cmd/Alt and swipe on a flex container to cycle `justify-content` or `flex-direction`; hold Shift and swipe to cycle `align-items`. Cmd+Z / Cmd+Shift+Z to undo/redo any change.

Right-click any element in Handle mode to open the **style panel** for full control over layout, typography, backgrounds, borders, and effects. Every modification is tracked and included in the feedback sent to your AI.

<p align="center">
  <img src="src/assets/bar - handle.png" alt="Handle tool guidance" width="360" style="border-radius: 12px;" />
</p>

## AI collaboration

Press Cmd+Enter to capture an annotated screenshot, bundle it with structured feedback (element selectors, style diffs, annotation text), and send it to your AI. Cmd+C copies the screenshot to your clipboard instead. Toggle between Claude (Opus/Sonnet) and Codex at any time.

### Threaded conversations

Follow-up annotations on the same element continue the existing thread — your AI sees prior context without re-explaining. If your AI needs clarification, a question badge appears on the annotation; reply inline and the conversation continues.

### Multi-page annotations

Annotate across multiple pages in a single session. Popmelt captures per-page screenshots and stitches them into a single submission so your AI understands the full scope of your feedback. Pass a `navigate` prop to `PopmeltProvider` to enable this.

### Resolution lifecycle

When your AI resolves an annotation, it's marked with a status badge. Resolved annotations show a checkmark; annotations that need your review get a flag. Dismissed annotations gray out. The lifecycle keeps your canvas clean as you iterate.

## Design model

Popmelt maintains a design model in `.popmelt/model.json` — a structured record of your design tokens and promoted components.

Switch to the Model tool (`M`) and hover any element to see component boundaries. Click to promote a component or token into your model. Popmelt classifies the scope of each promotion (instance vs pattern, element vs component vs token) so your AI understands what's a one-off tweak and what's a system-level change.

Your AI references the design model when making changes, keeping its output consistent with your established patterns.

<p align="center">
  <img src="src/assets/bar - model.png" alt="Model tool guidance" width="360" style="border-radius: 12px;" />
</p>

## Decision history

Every annotation and resolution is persisted to `.popmelt/decisions/` — a searchable record of what changed, why, and who asked for it. As your project evolves, this history becomes an invaluable reference for understanding past design choices and their context.

## Annotation counter

The toolbar shows a count of active annotations. Click the counter to cycle through them; scroll to change the annotation color; hover to see a route-grouped navigation list of all annotations across pages.

## API

### `PopmeltProvider`

```tsx
<PopmeltProvider
  enabled={true}                    // default: process.env.NODE_ENV === 'development'
  bridgeUrl="http://localhost:1111" // default
  navigate={router.push}           // optional: enables multi-page annotations
>
```

### `startPopmelt(options?)`

```ts
await startPopmelt({
  port: 1111,            // bridge server port (default: 1111, auto-selects 1111–1119 if occupied)
  projectRoot: '.',      // working directory for your AI
  claudePath: 'claude',  // path to Claude CLI binary
  provider: 'claude',    // 'claude' | 'codex'
  maxTurns: 40,          // max turns per job
  maxBudgetUsd: 1.0,     // spending cap per job
  timeoutMs: undefined,  // optional job timeout
});
```

Returns `{ port: number, projectId: string, close: () => Promise<void> }`.

### `usePopmelt()`

```ts
const { isEnabled } = usePopmelt();
```

## Requirements

- React 18+
- Node.js 18+ (server)
- Claude CLI or Codex CLI installed for AI integration

## License

[PolyForm Shield 1.0.0](./LICENSE)

**tl;dr** you can use and extend this software freely for yourself and your team. You may not sell it, offer it as a managed service, or take our code and create a competing AI design collaboration product/service with it. The software is offered as-is, and you're responsible for its use in your projects.

**If you need a custom license** for your use case, contact [reb@popmelt.com](mailto:reb@popmelt.com) with a brief outline of your desired terms.

<p align="center">
<img src="src/assets/popmelt-logo.svg" alt="Popmelt" width="64" />
</p>
