/**
 * @module Google Docs Tools
 * @description Read Google Docs documents as Markdown (headings, lists, tables, bold/italic, links)
 * @icon 📝
 * @author Browser for AI Agent
 */

// `inherited` holds the emphasis already applied by an ancestor, so nested styled spans are wrapped only once.
function inlineMarkdown(node, inherited = {}) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'IMG') return `![${node.alt || ''}](${node.src})`;

  const style = node.getAttribute('style') || '';
  const own = {
    strike: !inherited.strike && /text-decoration:[^;]*line-through/.test(style),
    italic: !inherited.italic && /font-style:italic/.test(style),
    bold: !inherited.bold && /font-weight:700/.test(style),
  };
  const context = {
    strike: inherited.strike || own.strike,
    italic: inherited.italic || own.italic,
    bold: inherited.bold || own.bold,
  };
  let text = [...node.childNodes].map((child) => inlineMarkdown(child, context)).join('');
  if (!text.trim()) return text;
  if (node.tagName === 'A' && node.getAttribute('href')) {
    // Docs wraps external links as https://www.google.com/url?q=<target>
    const href = new URL(node.href);
    const target =
      href.hostname === 'www.google.com' && href.pathname === '/url' ? href.searchParams.get('q') : href.href;
    return `[${text}](${target})`;
  }
  if (own.strike) text = `~~${text}~~`;
  if (own.italic) text = `*${text}*`;
  if (own.bold) text = `**${text}**`;
  return text;
}

function tableMarkdown(table) {
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('td, th')].map((cell) =>
      [...cell.children]
        .map((child) => inlineMarkdown(child).trim())
        .filter(Boolean)
        .join('<br>')
        .replaceAll('|', '\\|')
        .replaceAll('\n', '<br>'),
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

function blockMarkdown(el) {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inlineMarkdown(el, { bold: true }).trim()}`;
  if (tag === 'P' && el.classList.contains('title')) return `# ${inlineMarkdown(el, { bold: true }).trim()}`;
  if (tag === 'UL' || tag === 'OL') {
    // Nesting is encoded in the list class suffix, e.g. lst-kix_abc-1 is the second level.
    const level =
      Number(
        [...el.classList]
          .find((c) => c.startsWith('lst-kix_'))
          ?.split('-')
          .pop(),
      ) || 0;
    const marker = tag === 'OL' ? '1.' : '-';
    return [...el.children].map((li) => `${'  '.repeat(level)}${marker} ${inlineMarkdown(li).trim()}`).join('\n');
  }
  if (tag === 'TABLE') return tableMarkdown(el);
  if (tag === 'HR') return '---';
  return inlineMarkdown(el).trim();
}

/**
 * Read the full content of the current Google Doc as Markdown
 * @pattern https://docs.google.com/document/d/*
 */
export async function get_doc_markdown() {
  const id = location.pathname.split('/')[3];
  // The /export endpoint redirects to googleusercontent.com (blocked by CORS); mobilebasic is same-origin HTML.
  const res = await fetch(`/document/d/${id}/mobilebasic`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load the document: ${res.status}`);
  // Docs enforces Trusted Types; the extension's page policy makes the HTML parseable.
  const html = window.__browser4agentPolicy.createHTML(await res.text());
  const content = new DOMParser().parseFromString(html, 'text/html').querySelector('.doc-content');
  if (!content) throw new Error('Could not parse the document content');

  const blocks = [...content.children].map(blockMarkdown).filter(Boolean);
  return {
    title: document.title.replace(/ - Google (Docs|文档)$/, ''),
    url: location.href,
    markdown: blocks.join('\n\n'),
  };
}
