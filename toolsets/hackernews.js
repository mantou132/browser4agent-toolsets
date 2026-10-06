/**
 * @module Hacker News Tools
 * @description Read Hacker News story lists (auto-paginated) and full comment threads
 * @icon 🟧
 * @author Browser for AI Agent
 */

function nextPageUrl(doc) {
  const href = doc.querySelector('a.morelink')?.getAttribute('href');
  return href ? new URL(href, location.href).href : '';
}

async function fetchDoc(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

// HN truncates long link text with "...", so links are rendered as their href.
function richText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  for (const a of clone.querySelectorAll('a')) a.replaceWith(a.href);
  for (const p of clone.querySelectorAll('p')) p.prepend('\n\n');
  return clone.textContent.trim();
}

function parseStory(row) {
  const sub = row.nextElementSibling?.querySelector('.subtext');
  const link = row.querySelector('.titleline > a');
  const comments = [...(sub?.querySelectorAll('a') || [])].find((a) => /comment|discuss/.test(a.textContent));
  return {
    id: Number(row.id),
    rank: Number.parseInt(row.querySelector('.rank')?.textContent, 10) || undefined,
    title: link?.textContent || '',
    url: link?.href || '',
    site: row.querySelector('.sitestr')?.textContent || '',
    points: Number.parseInt(sub?.querySelector('.score')?.textContent, 10) || 0,
    by: sub?.querySelector('.hnuser')?.textContent || '',
    time: sub?.querySelector('.age')?.title?.split(' ')[0] || '',
    comments: Number.parseInt(comments?.textContent, 10) || 0,
  };
}

function parseComment(row) {
  return {
    id: Number(row.id),
    depth: Number(row.querySelector('td.ind')?.getAttribute('indent')) || 0,
    by: row.querySelector('.hnuser')?.textContent || '',
    time: row.querySelector('.age')?.title?.split(' ')[0] || '',
    text: richText(row.querySelector('.commtext')) || '[deleted]',
  };
}

/**
 * List stories on the current list page (front page, New, Ask, Show, Best, etc.), loading following pages as needed
 * @pattern https://news.ycombinator.com/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=30] - Maximum number of stories to return; more pages are loaded automatically
 */
export async function list_stories({ limit = 30 } = {}) {
  let doc = document;
  const stories = [];
  while (doc) {
    for (const row of doc.querySelectorAll('tr.athing.submission')) {
      if (stories.length >= limit) return { count: stories.length, stories };
      // Rankings shift between page loads, so a story can reappear on the next page.
      if (!stories.some((story) => story.id === Number(row.id))) stories.push(parseStory(row));
    }
    const next = nextPageUrl(doc);
    doc = next && stories.length < limit ? await fetchDoc(next) : null;
  }
  if (!stories.length) throw new Error('No stories on this page; open an HN list page first');
  return { count: stories.length, stories };
}

/**
 * Read the story and comments on the current item page as a flat list in page order; depth is the reply nesting level
 * @pattern https://news.ycombinator.com/item*
 * @param {{ limit?: number, max_depth?: number }} options
 * @param {number} [options.limit=200] - Maximum number of comments to return; truncated is true when more exist
 * @param {number} [options.max_depth] - Keep only comments with depth <= this value; 0 means top-level comments only
 */
export function get_thread({ limit = 200, max_depth } = {}) {
  const row = document.querySelector('.fatitem tr.athing');
  if (!row) throw new Error('This page is not an HN item page');

  const item = row.classList.contains('submission')
    ? { ...parseStory(row), text: richText(document.querySelector('.fatitem .toptext')) }
    : parseComment(row);

  const all = [...document.querySelectorAll('tr.athing.comtr')]
    .map(parseComment)
    .filter((comment) => max_depth == null || comment.depth <= max_depth);
  const comments = all.slice(0, limit);
  return { item, total: all.length, count: comments.length, truncated: all.length > limit, comments };
}
