// A small, dependency-free Markdown renderer covering the everyday subset:
// headings, paragraphs, emphasis, strikethrough, code (inline + fenced),
// links, images, blockquotes, nested/ordered/task lists, tables, and rules.
// Raw HTML in the source is escaped, never rendered.
(function () {
  const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
  const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeUrl(url) {
    const u = url.trim();
    if (/^(javascript|vbscript|data):/i.test(u) && !/^data:image\//i.test(u)) return '#';
    return escapeHtml(u);
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/&\w+;/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  function renderInline(text) {
    const slots = [];
    const stash = (html) => `\u0000${slots.push(html) - 1}\u0000`;

    // Backslash escapes and code spans first, so nothing inside them is formatted.
    let s = text.replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, (_, c) => stash(escapeHtml(c)));
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) =>
      stash(`<code>${escapeHtml(code.trim())}</code>`)
    );

    s = s.replace(/!\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"([^"]*)")?\s*\)/g, (_, alt, src, title) =>
      stash(
        `<img src="${safeUrl(src)}" alt="${escapeHtml(alt)}"${
          title ? ` title="${escapeHtml(title)}"` : ''
        }>`
      )
    );
    s = s.replace(/\[([^\]]+)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"([^"]*)")?\s*\)/g, (_, label, href, title) =>
      stash(
        `<a href="${safeUrl(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${renderInline(
          label
        )}</a>`
      )
    );
    s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) =>
      stash(`<a href="${safeUrl(url)}">${escapeHtml(url)}</a>`)
    );

    s = escapeHtml(s);
    s = s
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_(?=\S)([\s\S]*?\S)_(?![\w_])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(?: {2,}|\\)\n/g, '<br>\n');

    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
  }

  function splitRow(line) {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map((c) => c.trim());
  }

  function isBlockStart(line, next) {
    return (
      HEADING_RE.test(line) ||
      FENCE_RE.test(line) ||
      HR_RE.test(line) ||
      /^\s{0,3}>/.test(line) ||
      LIST_RE.test(line) ||
      (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next) && next.includes('-'))
    );
  }

  function indentOf(line) {
    return line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  }

  function parseList(lines, start) {
    const first = lines[start].match(LIST_RE);
    const ordered = /\d/.test(first[2]);
    const baseIndent = indentOf(first[1]);
    const items = [];
    let loose = false;
    let i = start;

    while (i < lines.length) {
      const m = lines[i].match(LIST_RE);
      if (!m || indentOf(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = baseIndent + m[2].length + Math.min(m[3].length, 4);
      const body = [m[4]];
      i++;

      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && indentOf(lines[j]) > baseIndent) {
            body.push('');
            loose = true;
            i++;
            continue;
          }
          // A blank line followed by a sibling item makes the list loose.
          const sib = j < lines.length && lines[j].match(LIST_RE);
          if (sib && indentOf(sib[1]) === baseIndent && /\d/.test(sib[2]) === ordered) {
            loose = true;
            i = j;
          }
          break;
        }
        const ind = indentOf(line);
        if (ind > baseIndent) {
          body.push(line.replace(/\t/g, '    ').slice(Math.min(ind, contentIndent)));
          i++;
          continue;
        }
        if (!isBlockStart(line, lines[i + 1]) && body[body.length - 1] !== '') {
          body.push(line.trim()); // lazy paragraph continuation
          i++;
          continue;
        }
        break;
      }
      items.push(body);
    }

    const tag = ordered ? 'ol' : 'ul';
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    let hasTask = false;
    const lis = items.map((body) => {
      const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        hasTask = true;
        body[0] = task[2];
        const checked = task[1] !== ' ' ? ' checked' : '';
        return `<li class="task"><input type="checkbox" disabled${checked}> ${parseBlocks(body, !loose)}</li>`;
      }
      return `<li>${parseBlocks(body, !loose)}</li>`;
    });
    const cls = hasTask ? ' class="task-list"' : '';
    return { html: `<${tag}${startAttr}${cls}>\n${lis.join('\n')}\n</${tag}>`, next: i };
  }

  // `tight` renders paragraphs without <p> wrappers (used inside tight list items).
  function parseBlocks(lines, tight) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') {
        i++;
        continue;
      }

      const fence = line.match(FENCE_RE);
      if (fence) {
        const marker = fence[2];
        const code = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(marker) && lines[i].trim().replace(/[`~]/g, '') === '')) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or run off the end if unclosed)
        const lang = fence[3] ? ` class="language-${escapeHtml(fence[3])}"` : '';
        out.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(HEADING_RE);
      if (heading) {
        const level = heading[1].length;
        const inner = renderInline(heading[2]);
        out.push(`<h${level} id="${slugify(inner)}">${inner}</h${level}>`);
        i++;
        continue;
      }

      if (HR_RE.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        const quote = [];
        while (i < lines.length && lines[i].trim() !== '' && (/^\s{0,3}>/.test(lines[i]) || quote.length)) {
          if (!/^\s{0,3}>/.test(lines[i]) && isBlockStart(lines[i], lines[i + 1])) break;
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>\n${parseBlocks(quote, false)}\n</blockquote>`);
        continue;
      }

      if (LIST_RE.test(line)) {
        const list = parseList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''
        );
        const cell = (tag, text, idx) =>
          `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${renderInline(text || '')}</${tag}>`;
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          const cells = splitRow(lines[i]);
          rows.push(`<tr>${header.map((_, idx) => cell('td', cells[idx], idx)).join('')}</tr>`);
          i++;
        }
        out.push(
          `<div class="table-wrap"><table>\n<thead><tr>${header.map((h, idx) => cell('th', h, idx)).join('')}</tr></thead>\n` +
            `<tbody>\n${rows.join('\n')}\n</tbody>\n</table></div>`
        );
        continue;
      }

      const para = [line.replace(/^\s+/, '')];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], lines[i + 1])) {
        para.push(lines[i].replace(/^\s+/, ''));
        i++;
      }
      const inner = renderInline(para.join('\n'));
      out.push(tight ? inner : `<p>${inner}</p>`);
    }

    return out.join('\n');
  }

  window.renderMarkdown = function (src) {
    return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), false);
  };
})();
