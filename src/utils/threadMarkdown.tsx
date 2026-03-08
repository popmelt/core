import type { ReactNode } from 'react';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

let _vsId = 0;
function VscodeIcon({ size = 11 }: { size?: number }) {
  const id = ++_vsId;
  const m = `pm-vs-m${id}`, f0 = `pm-vs-f0-${id}`, f1 = `pm-vs-f1-${id}`, g = `pm-vs-g${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'inline', verticalAlign: 'middle', marginLeft: 3, flexShrink: 0 }}>
      <mask id={m} maskType="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <path fillRule="evenodd" clipRule="evenodd" d="M70.9119 99.3171C72.4869 99.9307 74.2828 99.8914 75.8725 99.1264L96.4608 89.2197C98.6242 88.1787 100 85.9892 100 83.5872V16.4133C100 14.0113 98.6243 11.8218 96.4609 10.7808L75.8725 0.873756C73.7862 -0.130129 71.3446 0.11576 69.5135 1.44695C69.252 1.63711 69.0028 1.84943 68.769 2.08341L29.3551 38.0415L12.1872 25.0096C10.589 23.7965 8.35363 23.8959 6.86933 25.2461L1.36303 30.2549C-0.452552 31.9064 -0.454633 34.7627 1.35853 36.417L16.2471 50.0001L1.35853 63.5832C-0.454633 65.2374 -0.452552 68.0938 1.36303 69.7453L6.86933 74.7541C8.35363 76.1043 10.589 76.2037 12.1872 74.9905L29.3551 61.9587L68.769 97.9167C69.3925 98.5406 70.1246 99.0104 70.9119 99.3171ZM75.0152 27.2989L45.1091 50.0001L75.0152 72.7012V27.2989Z" fill="white"/>
      </mask>
      <g mask={`url(#${m})`}>
        <path d="M96.4614 10.7962L75.8569 0.875542C73.4719 -0.272773 70.6217 0.211611 68.75 2.08333L1.29858 63.5832C-0.515693 65.2373 -0.513607 68.0937 1.30308 69.7452L6.81272 74.754C8.29793 76.1042 10.5347 76.2036 12.1338 74.9905L93.3609 13.3699C96.086 11.3026 100 13.2462 100 16.6667V16.4275C100 14.0265 98.6246 11.8378 96.4614 10.7962Z" fill="#0065A9"/>
        <g filter={`url(#${f0})`}>
          <path d="M96.4614 89.2038L75.8569 99.1245C73.4719 100.273 70.6217 99.7884 68.75 97.9167L1.29858 36.4169C-0.515693 34.7627 -0.513607 31.9063 1.30308 30.2548L6.81272 25.246C8.29793 23.8958 10.5347 23.7964 12.1338 25.0095L93.3609 86.6301C96.086 88.6974 100 86.7538 100 83.3334V83.5726C100 85.9735 98.6246 88.1622 96.4614 89.2038Z" fill="#007ACC"/>
        </g>
        <g filter={`url(#${f1})`}>
          <path d="M75.8578 99.1263C73.4721 100.274 70.6219 99.7885 68.75 97.9166C71.0564 100.223 75 98.5895 75 95.3278V4.67213C75 1.41039 71.0564 -0.223106 68.75 2.08329C70.6219 0.211402 73.4721 -0.273666 75.8578 0.873633L96.4587 10.7807C98.6234 11.8217 100 14.0112 100 16.4132V83.5871C100 85.9891 98.6234 88.1786 96.4586 89.2196L75.8578 99.1263Z" fill="#1F9CF0"/>
        </g>
        <g style={{ mixBlendMode: 'overlay' }} opacity="0.25">
          <path fillRule="evenodd" clipRule="evenodd" d="M70.8511 99.3171C72.4261 99.9306 74.2221 99.8913 75.8117 99.1264L96.4 89.2197C98.5634 88.1787 99.9392 85.9892 99.9392 83.5871V16.4133C99.9392 14.0112 98.5635 11.8217 96.4001 10.7807L75.8117 0.873695C73.7255 -0.13019 71.2838 0.115699 69.4527 1.44688C69.1912 1.63705 68.942 1.84937 68.7082 2.08335L29.2943 38.0414L12.1264 25.0096C10.5283 23.7964 8.29285 23.8959 6.80855 25.246L1.30225 30.2548C-0.513334 31.9064 -0.515415 34.7627 1.29775 36.4169L16.1863 50L1.29775 63.5832C-0.515415 65.2374 -0.513334 68.0937 1.30225 69.7452L6.80855 74.754C8.29285 76.1042 10.5283 76.2036 12.1264 74.9905L29.2943 61.9586L68.7082 97.9167C69.3317 98.5405 70.0638 99.0104 70.8511 99.3171ZM74.9544 27.2989L45.0483 50L74.9544 72.7012V27.2989Z" fill={`url(#${g})`}/>
        </g>
      </g>
      <defs>
        <filter id={f0} x="-8.39411" y="15.8291" width="116.727" height="92.2456" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/><feOffset/><feGaussianBlur stdDeviation="4.16667"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend mode="overlay" in2="BackgroundImageFix" result="effect1_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
        </filter>
        <filter id={f1} x="60.4167" y="-8.07558" width="47.9167" height="116.151" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/><feOffset/><feGaussianBlur stdDeviation="4.16667"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend mode="overlay" in2="BackgroundImageFix" result="effect1_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
        </filter>
        <linearGradient id={g} x1="49.9392" y1="0.257812" x2="49.9392" y2="99.7423" gradientUnits="userSpaceOnUse">
          <stop stopColor="white"/><stop offset="1" stopColor="white" stopOpacity="0"/>
        </linearGradient>
      </defs>
    </svg>
  );
}

// Color swatch helpers
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const FN_COLOR_RE = /^(?:rgba?|hsla?|oklch)\([^)]+\)$/;
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple',
  'pink', 'gray', 'grey', 'cyan', 'magenta', 'brown', 'navy', 'teal',
  'maroon', 'olive', 'silver', 'aqua', 'fuchsia', 'lime',
]);

function isColor(s: string): boolean {
  const t = s.trim();
  return HEX_RE.test(t) || FN_COLOR_RE.test(t) || NAMED_COLORS.has(t.toLowerCase());
}

function swatch(color: string, key: number | string): ReactNode {
  return (
    <span key={key} style={{
      display: 'inline-block',
      width: 10,
      height: 10,
      backgroundColor: color,
      border: '1px solid rgba(0,0,0,0.15)',
      borderRadius: 2,
      verticalAlign: 'middle',
      marginRight: 3,
    }} />
  );
}

/** Parse inline markdown (bold, italic, code, links) into React nodes */
export function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters — longer/greedier patterns first
  const re = /(`[^`]+`)|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(_([^_]+?)_)|(\[([^\]]+)\]\(([^)]+)\))|(#[0-9a-fA-F]{3,8})(?![0-9a-fA-F])|((?:rgba?|hsla?|oklch)\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) {
      // inline code — with color swatch if content is a color value
      const codeText = match[1].slice(1, -1);
      if (isColor(codeText)) nodes.push(swatch(codeText, `sw-${match.index}`));
      nodes.push(
        <code key={match.index} style={{
          fontFamily: MONO, fontSize: '0.9em',
          backgroundColor: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 2,
        }}>
          {codeText}
        </code>,
      );
    } else if (match[3] !== undefined) {
      // bold+italic ***…***
      nodes.push(<strong key={match.index}><em>{match[3]}</em></strong>);
    } else if (match[5] !== undefined) {
      // bold **…**
      nodes.push(<strong key={match.index}>{match[5]}</strong>);
    } else if (match[7] !== undefined) {
      // italic *…*
      nodes.push(<em key={match.index}>{match[7]}</em>);
    } else if (match[9] !== undefined) {
      // italic _…_
      nodes.push(<em key={match.index}>{match[9]}</em>);
    } else if (match[11] !== undefined && match[12] !== undefined) {
      // link [text](url) — local paths open in VS Code, external URLs open normally
      const raw = match[12];
      const isLocal = !/^https?:\/\/|^mailto:/i.test(raw);
      const href = isLocal ? `vscode://file/${raw}` : raw;
      if (isLocal) {
        nodes.push(
          <a key={match.index} href={href} target="_blank" rel="noopener noreferrer"
            style={{
              color: 'inherit', textDecoration: 'underline', whiteSpace: 'nowrap',
              backgroundColor: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 2,
              fontFamily: MONO, fontSize: '0.9em',
            }}>
            {match[11]}<VscodeIcon />
          </a>,
        );
      } else {
        nodes.push(
          <a key={match.index} href={href} target="_blank" rel="noopener noreferrer"
            style={{ color: 'inherit', textDecoration: 'underline' }}>
            {match[11]}
          </a>,
        );
      }
    } else if (match[13] !== undefined) {
      // hex color
      nodes.push(swatch(match[13], `sw-${match.index}`));
      nodes.push(match[13]);
    } else if (match[14] !== undefined) {
      // functional color (rgb, hsl, oklch)
      nodes.push(swatch(match[14], `sw-${match.index}`));
      nodes.push(match[14]);
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render a full markdown string to React elements */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.split('\n');
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block ```
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} style={{
          fontFamily: MONO, fontSize: '0.9em', lineHeight: 1.4,
          backgroundColor: 'rgba(0,0,0,0.04)', padding: '6px 8px',
          margin: '4px 0', overflowX: 'auto', whiteSpace: 'pre',
        }}>
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      elements.push(<hr key={elements.length} style={{ border: 'none', borderTop: '1px solid rgba(0,0,0,0.1)', margin: '6px 0' }} />);
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const sizes: Record<number, number> = { 1: 16, 2: 14, 3: 13, 4: 12 };
      elements.push(
        <div key={elements.length} style={{
          fontWeight: 700, fontSize: sizes[level] ?? 12,
          margin: '8px 0 2px',
        }}>
          {parseInline(headingMatch[2]!)}
        </div>,
      );
      i++;
      continue;
    }

    // Table (| col | col |)
    if (line.trimStart().startsWith('|') && line.trimEnd().endsWith('|')) {
      const tableRows: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|') && lines[i]!.trimEnd().endsWith('|')) {
        tableRows.push(lines[i]!);
        i++;
      }
      // Filter out separator rows (|---|---|)
      const isSeparator = (r: string) => /^\|[\s\-:|]+\|$/.test(r);
      const dataRows = tableRows.filter(r => !isSeparator(r));
      const parseCells = (r: string) => r.split('|').slice(1, -1).map(c => c.trim());
      const isBold = (c: string) => /^\*\*.+\*\*$/.test(c) || /^__.+__$/.test(c);

      // Detect sticky column: all non-header cells in first column are bold
      const allCells = dataRows.map(parseCells);
      const stickyCol = allCells.length > 1 &&
        allCells.slice(1).every(cells => cells[0] && isBold(cells[0]));
      // Detect sticky row: all cells in first row are bold (beyond default th styling)
      const stickyRow = allCells.length > 0 &&
        allCells[0]!.every(c => isBold(c));

      elements.push(
        <div key={elements.length} style={{ overflowX: 'auto', margin: '4px 0', paddingBottom: 4 }}>
          <table style={{
            borderCollapse: 'separate', borderSpacing: 0,
            fontSize: '0.95em', width: 'max-content', minWidth: '100%',
          }}>
            <tbody>
              {dataRows.map((row, ri) => (
                <tr key={ri}>
                  {parseCells(row).map((cell, ci) => {
                    const Tag = ri === 0 ? 'th' : 'td';
                    const isSticky = (ci === 0 && stickyCol) || (ri === 0 && stickyRow);
                    return (
                      <Tag key={ci} style={{
                        border: '1px solid rgba(0,0,0,0.1)',
                        padding: '3px 6px',
                        textAlign: 'left',
                        fontWeight: ri === 0 ? 600 : 400,
                        minWidth: 60,
                        whiteSpace: 'nowrap',
                        ...(isSticky ? {
                          position: 'sticky' as const,
                          ...(ci === 0 && stickyCol ? { left: 0 } : {}),
                          ...(ri === 0 && stickyRow ? { top: 0 } : {}),
                          background: '#fff',
                          zIndex: (ci === 0 && stickyCol && ri === 0 && stickyRow) ? 2 : 1,
                        } : {}),
                      }}>
                        {parseInline(cell)}
                      </Tag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Unordered list (- or *)
    const ulMatch = line.match(/^(\s*)([-*])\s+(.+)/);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*[-*]\s+(.+)/);
        if (m) {
          items.push(m[1]!);
          i++;
        } else if (items.length > 0 && lines[i]!.match(/^\s+\S/) && !lines[i]!.match(/^\s*\d+\.\s/) && !lines[i]!.match(/^\s*[-*]\s+/)) {
          // Continuation line: indented, not a new list item
          items[items.length - 1] += ' ' + lines[i]!.trim();
          i++;
        } else {
          break;
        }
      }
      elements.push(
        <ul key={elements.length} style={{ margin: 0, paddingLeft: 20, listStyleType: 'disc', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((text, j) => <li key={j}>{parseInline(text)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list (1. 2. etc)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*\d+\.\s+(.+)/);
        if (m) {
          items.push(m[1]!);
          i++;
        } else if (items.length > 0 && lines[i]!.match(/^\s+\S/) && !lines[i]!.match(/^\s*\d+\.\s/) && !lines[i]!.match(/^\s*[-*]\s+/)) {
          items[items.length - 1] += ' ' + lines[i]!.trim();
          i++;
        } else {
          break;
        }
      }
      elements.push(
        <ol key={elements.length} style={{ margin: 0, paddingLeft: 20, listStyleType: 'decimal', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((text, j) => <li key={j}>{parseInline(text)}</li>)}
        </ol>,
      );
      continue;
    }

    // Blank line — skip (parent flex gap handles spacing)
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <div key={elements.length}>
        {parseInline(line)}
      </div>,
    );
    i++;
  }

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{elements}</div>;
}
