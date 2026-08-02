import { Fragment, type ReactNode } from 'react';
import type { Block, Inline } from '../../shared/markdown';

/**
 * Render the markdown tree as React elements.
 *
 * Never innerHTML. The document being rendered is very often something an
 * agent wrote a moment ago, and this renderer runs in the window that holds
 * the preload bridge — so the file's content is data all the way down, and
 * `href`s were already filtered to non-executing schemes by the parser.
 */
export interface MarkdownProps {
  blocks: Block[];
  /** Resolves an image reference in the document to something <img> can load. */
  resolveImage?(src: string): string | undefined;
  /** Called for in-document links to project files, instead of navigating. */
  onOpenPath?(path: string): void;
}

function renderInline(nodes: Inline[], props: MarkdownProps, keyBase = ''): ReactNode {
  return nodes.map((node, i) => {
    const key = `${keyBase}-${i}`;
    switch (node.type) {
      case 'text':
        return <Fragment key={key}>{node.value}</Fragment>;
      case 'code':
        return <code key={key}>{node.value}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(node.children, props, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(node.children, props, key)}</em>;
      case 'del':
        return <del key={key}>{renderInline(node.children, props, key)}</del>;
      case 'break':
        return <br key={key} />;
      case 'image': {
        const src = props.resolveImage?.(node.src);
        if (!src) {
          return (
            <span key={key} className="md-img-missing" title={node.src}>
              {node.alt || node.src}
            </span>
          );
        }
        return <img key={key} src={src} alt={node.alt} width={node.width} />;
      }
      case 'link': {
        const external = /^(https?|mailto|tel):/i.test(node.href);
        return (
          <a
            key={key}
            href={external ? node.href : undefined}
            title={node.title ?? node.href}
            onClick={(e) => {
              e.preventDefault();
              if (external) void window.open?.(node.href);
              else if (!node.href.startsWith('#')) props.onOpenPath?.(node.href);
            }}
          >
            {renderInline(node.children, props, key)}
          </a>
        );
      }
    }
  });
}

function renderBlocks(blocks: Block[], props: MarkdownProps, keyBase = ''): ReactNode {
  return blocks.map((block, i) => {
    const key = `${keyBase}b${i}`;
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(block.depth, 6)}` as 'h1';
        return <Tag key={key}>{renderInline(block.children, props, key)}</Tag>;
      }
      case 'paragraph':
        return <p key={key}>{renderInline(block.children, props, key)}</p>;
      case 'code':
        return (
          <pre key={key} data-lang={block.lang ?? undefined}>
            <code>{block.value}</code>
          </pre>
        );
      case 'hr':
        return <hr key={key} />;
      case 'quote':
        return <blockquote key={key}>{renderBlocks(block.children, props, key)}</blockquote>;
      case 'list': {
        const items = block.items.map((item, j) => (
          <li key={`${key}i${j}`} className={item.checked === null ? undefined : 'md-task'}>
            {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly />}
            {renderBlocks(item.children, props, `${key}i${j}`)}
          </li>
        ));
        return block.ordered ? (
          <ol key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={key} className="md-table-wrap">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, c) => (
                    <th key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                      {renderInline(cell, props, `${key}h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                        {renderInline(cell, props, `${key}r${r}c${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'html':
        // raw HTML is shown as text, not executed
        return (
          <pre key={key} className="md-raw">
            <code>{block.value}</code>
          </pre>
        );
    }
  });
}

export function Markdown(props: MarkdownProps) {
  return <div className="md">{renderBlocks(props.blocks, props)}</div>;
}
