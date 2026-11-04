/**
 * @module V2EX Tools
 * @description Read V2EX topic lists, full topics with appendices and all reply pages, and notifications; draft replies and new topics for the user to post
 * @icon 🅥
 * @author Browser for AI Agent
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000) {
  for (const start = Date.now(); Date.now() - start < timeout; await sleep(250)) {
    const value = fn();
    if (value) return value;
  }
  return null;
}

async function fetchDoc(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

// Number of pages from the pager's page box; pages without a pager have one.
function pageCount(doc) {
  return Number(doc.querySelector('.page_input')?.getAttribute('max')) || 1;
}

function pageUrl(url, page) {
  const next = new URL(url, location.origin);
  next.hash = '';
  next.searchParams.set('p', String(page));
  return next.href;
}

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

// The tooltip script moves the absolute time from title to data-original-title on the live page.
function timeOf(el) {
  return (el?.getAttribute('title') || el?.getAttribute('data-original-title') || '').replace(/ \+08:00$/, '');
}

function memberOf(a) {
  return a?.getAttribute('href')?.match(/^\/member\/([^/?#]+)/)?.[1] || '';
}

// Rendered Markdown to plain text: paragraphs and list items on their own lines, images as their URLs, and links
// as their href unless the text already says it (e.g. @mentions keep their text).
function richText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  for (const img of clone.querySelectorAll('img')) img.replaceWith(img.getAttribute('src') || '');
  for (const a of clone.querySelectorAll('a')) {
    const label = a.textContent.trim();
    const href = a.getAttribute('href') || '';
    if (href.startsWith('/member/') || !href || href === label || a.href === label) continue;
    a.replaceWith(label ? `${label} (${a.href})` : a.href);
  }
  for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of clone.querySelectorAll('p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, tr')) {
    block.prepend(block.tagName === 'LI' ? '\n- ' : '\n\n');
  }
  return clone.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function topicId(href) {
  return Number(href?.match(/\/t\/(\d+)/)?.[1]) || 0;
}

function parseListItem(cell) {
  const link = cell.querySelector('a.topic-link');
  const info = cell.querySelector('.topic_info');
  const members = [...(info?.querySelectorAll('strong > a[href^="/member/"]') || [])].map(memberOf);
  const node = info?.querySelector('a.node');
  return {
    id: topicId(link.getAttribute('href')),
    title: text(link),
    url: `${location.origin}/t/${topicId(link.getAttribute('href'))}`,
    // Node pages leave the node out of each row.
    ...(node && { node: node.getAttribute('href').replace('/go/', ''), node_title: text(node) }),
    author: members[0] || '',
    last_touched: timeOf(info?.querySelector('span[title], span[data-original-title]')),
    last_reply_by: members[1] || '',
    replies: Number(text(cell.querySelector('.count_livid, .count_orange'))) || 0,
    ...(cell.querySelector('.topic_info > .votes')?.textContent.trim() && {
      votes: Number(text(cell.querySelector('.topic_info > .votes'))) || 0,
    }),
  };
}

function listCells(doc) {
  return [...doc.querySelectorAll('#Main .cell')].filter((cell) => cell.querySelector(':scope .item_title a.topic-link'));
}

/**
 * List topics on the current list page: the home page and its tabs (技术, 最热, 全部…), /recent, a node (/go/<node>) or a tag (/tag/<tag>), loading following pages where the page has a pager. Each topic has its node, author, last-touched time, last replier and reply count; use get_topic to read it
 * @pattern https://www.v2ex.com/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=50] - Maximum number of topics to return; more pages are loaded automatically
 */
export async function list_topics({ limit = 50 } = {}) {
  const start = Number(new URL(location.href).searchParams.get('p')) || 1;
  let doc = document;
  const topics = [];
  for (let page = start; ; page++) {
    for (const cell of listCells(doc)) {
      if (topics.length >= limit) break;
      const topic = parseListItem(cell);
      // New replies bump topics up between page loads, so one can reappear on the next page.
      if (!topics.some((t) => t.id === topic.id)) topics.push(topic);
    }
    if (topics.length >= limit || page >= pageCount(doc)) break;
    doc = await fetchDoc(pageUrl(location.href, page + 1));
  }
  if (!topics.length) throw new Error('No topics on this page; open the V2EX home page, /recent or a node page such as /go/programmer');
  return { count: topics.length, topics };
}

function parseReply(cell) {
  const author = cell.querySelector('strong > a[href^="/member/"]');
  return {
    floor: Number(text(cell.querySelector('.no'))) || 0,
    id: Number(cell.id.replace('r_', '')),
    author: memberOf(author),
    ...(cell.querySelector('.badge.op') && { op: true }),
    time: timeOf(cell.querySelector('.ago')),
    thanks: Number(text(cell.querySelector('.ago ~ .small'))) || 0,
    text: richText(cell.querySelector('.reply_content')),
  };
}

function parseTopic(doc, id) {
  const header = doc.querySelector('#Main .box .header');
  if (!header?.querySelector('h1')) throw new Error(`Topic ${id} not found, or it needs you to log in to V2EX`);
  const meta = header.querySelector('small.gray');
  const node = [...header.querySelectorAll('a[href^="/go/"]')].pop();
  const clicks = meta?.textContent.match(/(\d+)\s*次点击/)?.[1];
  const summary = [...doc.querySelectorAll('#Main .box .cell')].find((cell) => /条回复/.test(text(cell.querySelector('.gray'))));
  return {
    id,
    title: text(header.querySelector('h1')),
    url: `${location.origin}/t/${id}`,
    node: node?.getAttribute('href').replace('/go/', '') || '',
    node_title: text(node),
    author: memberOf(meta?.querySelector('a[href^="/member/"]')),
    created: timeOf(meta?.querySelector('span[title], span[data-original-title]')),
    clicks: Number(clicks) || 0,
    tags: [...(summary?.querySelectorAll('a.tag') || [])].map(text),
    content: richText(header.parentElement.querySelector(':scope > .cell .topic_content')),
    appendices: [...doc.querySelectorAll('#Main .box .subtle')].map((subtle) => ({
      time: timeOf(subtle.querySelector('.fade span[title], .fade span[data-original-title]')),
      text: richText(subtle.querySelector('.topic_content')),
    })),
    total_replies: Number(text(summary?.querySelector('.gray')).match(/(\d+)\s*条回复/)?.[1]) || 0,
  };
}

/**
 * Read a topic: title, node, author, click count, tags, content, appendices (附言) and replies with floor numbers, authors (op marks the topic author), times and thanks counts, loading every reply page. Defaults to the topic on the current page; pass url to read another topic without navigating
 * @pattern https://www.v2ex.com/*
 * @param {{ url?: string, limit?: number, author?: string }} options
 * @param {string} [options.url] - Topic URL, path or ID, such as https://www.v2ex.com/t/1254131
 * @param {number} [options.limit=300] - Maximum number of replies to return, from the first floor; truncated is true when more exist
 * @param {string} [options.author] - Keep only replies by this member, e.g. the topic author's name to follow their follow-ups
 */
export async function get_topic({ url, limit = 300, author } = {}) {
  const target = /^\d+$/.test(String(url ?? '')) ? `/t/${url}` : url || location.href;
  const id = topicId(new URL(target, location.origin).pathname);
  if (!id) throw new Error('Not a topic URL; expected https://www.v2ex.com/t/<id>');

  const first = await fetchDoc(pageUrl(`/t/${id}`, 1));
  const topic = parseTopic(first, id);
  const replies = [];
  let truncated = false;
  for (let page = 1, doc = first; ; doc = await fetchDoc(pageUrl(`/t/${id}`, ++page))) {
    for (const reply of [...doc.querySelectorAll('#Main .cell[id^="r_"]')].map(parseReply)) {
      if (author && reply.author.toLowerCase() !== author.toLowerCase()) continue;
      if (replies.length >= limit) truncated = true;
      else replies.push(reply);
    }
    if (truncated || page >= pageCount(doc)) break;
  }
  return { topic, count: replies.length, truncated, replies };
}

/**
 * List the logged-in member's notifications (replies to their topics, @mentions, thanks, favorites), newest first, each with who, what happened, the topic and the reply text
 * @pattern https://www.v2ex.com/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=30] - Maximum number of notifications to return; more pages are loaded automatically
 */
export async function list_notifications({ limit = 30 } = {}) {
  const notifications = [];
  for (let page = 1; notifications.length < limit; page++) {
    const doc = await fetchDoc(pageUrl('/notifications', page));
    const cells = doc.querySelectorAll('#notifications .cell[id^="n_"]');
    if (page === 1 && !cells.length && !doc.getElementById('notifications')) {
      throw new Error('No notifications page; are you logged in to V2EX?');
    }
    for (const cell of cells) {
      if (notifications.length >= limit) break;
      const line = cell.querySelector('span.gray');
      const topic = line?.querySelector('a.topic-link');
      const summary = line?.cloneNode(true);
      summary?.querySelector('a.topic-link')?.replaceWith('《' + text(topic) + '》');
      notifications.push({
        id: Number(cell.id.replace('n_', '')),
        from: memberOf(line?.querySelector('a[href^="/member/"]')),
        summary: text(summary),
        topic_id: topicId(topic?.getAttribute('href')),
        topic_url: topic ? new URL(topic.getAttribute('href'), location.origin).href : '',
        time: text(cell.querySelector('span.snow')),
        ...(cell.querySelector('.payload') && { text: richText(cell.querySelector('.payload')) }),
      });
    }
    if (page >= pageCount(doc)) break;
  }
  return { count: notifications.length, notifications };
}

function setValue(field, value) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Fill in the reply box on the current topic page. Pass reply_to with a floor number to start the reply with "@<author> #<floor> ", the way V2EX quotes a reply. Stops before posting; the user reviews the text and clicks "回复". Returns the drafted text
 * @pattern https://www.v2ex.com/t/*
 * @param {{ content: string, reply_to?: number }} options
 * @param {string} options.content - Reply text; V2EX renders replies as plain text with links and @mentions
 * @param {number} [options.reply_to] - Floor number of the reply being answered, on the current reply page
 */
export function draft_reply({ content, reply_to } = {}) {
  const box = document.getElementById('reply_content');
  if (!box) throw new Error('No reply box on this page; log in to V2EX, and note that some topics are closed to replies');
  let prefix = '';
  if (reply_to != null) {
    const floor = [...document.querySelectorAll('#Main .cell[id^="r_"]')].map(parseReply).find((r) => r.floor === reply_to);
    if (!floor) throw new Error(`Floor #${reply_to} is not on this page; open the reply page that has it`);
    prefix = `@${floor.author} #${reply_to} `;
  }
  const value = prefix + (content || '');
  setValue(box, value);
  box.focus();
  box.scrollIntoView({ block: 'center' });
  return { status: 'ready_to_post', topic_id: topicId(location.pathname), content: value };
}

/**
 * Fill in the new-topic form on /write (open https://www.v2ex.com/write, or /write?node=<node> to preselect a node): title, Markdown content and node. Stops before publishing; the user reviews the draft and clicks "发布主题". Returns the drafted title, node and content length
 * @pattern https://www.v2ex.com/write*
 * @param {{ title: string, content?: string, node?: string }} options
 * @param {string} options.title - Topic title, up to 120 characters
 * @param {string} [options.content] - Topic body in Markdown, up to 20000 characters
 * @param {string} [options.node] - Node name from its URL, such as qna, programmer or jobs; required unless the page preselected one
 */
export async function draft_topic({ title, content = '', node } = {}) {
  const titleBox = document.getElementById('topic_title');
  if (!titleBox) throw new Error('No new-topic form on this page; log in to V2EX and open https://www.v2ex.com/write');
  if (!title) throw new Error('title is required');
  if (title.length > 120) throw new Error(`The title is ${title.length} characters; V2EX allows 120`);
  setValue(titleBox, title);

  const editor = await waitFor(() => document.querySelector('.CodeMirror')?.CodeMirror);
  if (editor) editor.setValue(content);
  else setValue(document.getElementById('editor'), content);

  const select = document.getElementById('nodes');
  if (node) {
    if (![...select.options].some((o) => o.value === node)) {
      throw new Error(`No node "${node}"; use the name from the node URL, such as qna for /go/qna`);
    }
    select.value = node;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    // The node picker is a select2 widget; jQuery listens for its own change event.
    window.jQuery?.(select).trigger('change');
  }
  const chosen = select?.value || new URL(location.href).searchParams.get('node') || '';
  return {
    status: 'ready_to_publish',
    title,
    node: chosen,
    content_chars: content.length,
    ...(!chosen && { missing: ['node'] }),
  };
}
