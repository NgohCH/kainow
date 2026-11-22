import { checkInputSize, checkOutputSize, type Block, type Inline } from './blocks';
import { headerLines, type DocumentHeader } from './header';

function inlineMd(list: Inline[]): string {
  return list
    .map((i) => {
      let t = i.code ? `\`${i.text}\`` : i.text.replace(/\n/g, '  \n');
      if (!i.code) {
        if (i.bold) t = `**${t}**`;
        if (i.italic) t = `*${t}*`;
      }
      return i.href ? `[${t}](${i.href})` : t;
    })
    .join('');
}

function cellMd(list: Inline[]): string {
  return inlineMd(list).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function blocksMd(blocks: Block[], indent = ''): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        out.push(`${'#'.repeat(b.level)} ${inlineMd(b.inlines)}`);
        break;
      case 'paragraph':
        out.push(b.inlines.length === 1 && b.inlines[0].code && b.inlines[0].text.includes('\n') ? `\`\`\`\n${b.inlines[0].text}\n\`\`\`` : inlineMd(b.inlines));
        break;
      case 'list':
        out.push(
          b.items
            .map((item, n) => {
              const marker = b.ordered ? `${n + 1}. ` : '- ';
              const body = blocksMd(item).join('\n\n').split('\n');
              return body.map((line, k) => (k === 0 ? marker : ' '.repeat(marker.length)) + line).join('\n');
            })
            .join('\n'),
        );
        break;
      case 'table':
        out.push([`| ${b.header.map(cellMd).join(' | ')} |`, `| ${b.header.map(() => '---').join(' | ')} |`, ...b.rows.map((r) => `| ${r.map(cellMd).join(' | ')} |`)].join('\n'));
        break;
      case 'quote':
        out.push(
          blocksMd(b.blocks)
            .join('\n\n')
            .split('\n')
            .map((l) => `> ${l}`.trimEnd())
            .join('\n'),
        );
        break;
      case 'rule':
        out.push('---');
        break;
      case 'footnotes':
        out.push(b.items.map((f) => `[^${f.label}]: ${inlineMd(f.inlines)}`).join('\n'));
        break;
    }
  }
  return out.map((s) => indent + s);
}

/** The stored Markdown body (or blocks written back as Markdown) under a header block from the letterhead. */
export function renderMarkdown(h: DocumentHeader, body: string | Block[]): Buffer {
  checkInputSize(body);
  const [title, ...rest] = headerLines(h);
  const text = typeof body === 'string' ? body : `${blocksMd(body).join('\n\n')}\n`;
  const head = [`**${h.organisationName}**`, '', `# ${title.replace(/\n/g, ' ')}`, '', rest.map((l) => `${l}  `).join('\n').replace(/ {2}$/, ''), '', '---', ''].join('\n');
  return checkOutputSize(Buffer.from(`${head}\n${text}`, 'utf8'));
}
