import type { ReactNode } from 'react';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Parse inline markdown (bold, italic, code, links) into React nodes */
export function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters — longer/greedier patterns first
  const re = /(`[^`]+`)|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(_([^_]+?)_)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) {
      // inline code
      nodes.push(
        <code key={match.index} style={{
          fontFamily: MONO, fontSize: '0.9em',
          backgroundColor: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 2,
        }}>
          {match[1].slice(1, -1)}
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
      // link [text](url)
      nodes.push(
        <a key={match.index} href={match[12]} target="_blank" rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}>
          {match[11]}
        </a>,
      );
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
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        const m = lines[i]!.match(/^\s*[-*]\s+(.+)/);
        if (m) items.push(<li key={items.length}>{parseInline(m[1]!)}</li>);
        i++;
      }
      elements.push(
        <ul key={elements.length} style={{ margin: '2px 0', paddingLeft: 20 }}>{items}</ul>,
      );
      continue;
    }

    // Ordered list (1. 2. etc)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const m = lines[i]!.match(/^\s*\d+\.\s+(.+)/);
        if (m) items.push(<li key={items.length}>{parseInline(m[1]!)}</li>);
        i++;
      }
      elements.push(
        <ol key={elements.length} style={{ margin: '2px 0', paddingLeft: 20 }}>{items}</ol>,
      );
      continue;
    }

    // Blank line → spacer
    if (line.trim() === '') {
      elements.push(<div key={elements.length} style={{ height: 4 }} />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <div key={elements.length} style={{ margin: '2px 0' }}>
        {parseInline(line)}
      </div>,
    );
    i++;
  }

  return <>{elements}</>;
}
