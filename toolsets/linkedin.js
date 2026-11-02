/**
 * @module LinkedIn Tools
 * @description Read LinkedIn people search results and profiles, and prepare connection invitations with a note
 * @icon 💼
 * @author Browser for AI Agent
 */

const ACTION_LABELS = new Set(['Connect', 'Message', 'Pending', 'Follow', 'Following', 'More', 'Contact info', '·']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 5000) {
  for (const start = Date.now(); Date.now() - start < timeout; await sleep(200)) {
    const value = fn();
    if (value) return value;
  }
  return null;
}

function lines(el) {
  return (el?.innerText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Dialogs and dropdowns render inside shadow roots (e.g. #interop-outlet), out of reach of querySelectorAll.
function deepQueryAll(selector, root = document) {
  const found = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) found.push(...deepQueryAll(selector, el.shadowRoot));
  }
  return found;
}

// LinkedIn ignores a bare el.click() on some controls; dispatch the full pointer sequence.
function press(el) {
  const init = { bubbles: true, cancelable: true, composed: true, view: window };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, init));
  }
}

function label(el) {
  return (el.getAttribute('aria-label') || el.innerText || '').trim();
}

function visibleDialog() {
  return deepQueryAll('[role=dialog]').find(isVisible);
}

function topCard() {
  const name = document.querySelector('main h2');
  if (!name) throw new Error('This page is not a LinkedIn profile; open https://www.linkedin.com/in/<id>/ first');
  // The first section holding the name also wraps the rest of the page; the innermost one is the top card.
  let card = name.closest('section');
  for (let el = name.parentElement; el && el !== card; el = el.parentElement) {
    if (el.tagName === 'SECTION') card = el;
  }
  return { name: name.innerText.trim(), card };
}

function connectionStatus(card, name) {
  const controls = [...card.querySelectorAll('a, button')].map(label);
  if (controls.some((text) => /^Pending\b/.test(text))) return 'pending';
  if (controls.some((text) => /^Invite .* to connect$/.test(text))) return 'not_connected';
  if (lines(card).some((line) => /^·\s*1st$/.test(line))) return 'connected';
  return controls.some((text) => text === `Follow ${name}`) ? 'follow_only' : 'unknown';
}

function sectionText(title) {
  const heading = [...document.querySelectorAll('main h2')].find((h) => h.innerText.trim() === title);
  return heading ? lines(heading.closest('section')).slice(1).join('\n') : '';
}

/**
 * List the people on the current people search results page. Out-of-network results show as "LinkedIn Member" with no profile URL. next_page_url is set when more results exist; navigate to it to read the next page
 * @pattern https://www.linkedin.com/search/results/people/*
 */
export async function list_people_results() {
  const items = await waitFor(() => {
    const found = [...document.querySelectorAll('main [role=listitem]')].filter((li) => lines(li).length >= 2);
    return found.length ? found : null;
  });
  if (!items) throw new Error('No people results on this page; check the search keywords or wait for the page to load');

  const people = items.map((li) => {
    const link = li.querySelector('a[href*="/in/"]');
    const [name, ...rest] = lines(li);
    const degree = rest.find((line) => /^•\s*\d/.test(line))?.replace(/^•\s*/, '') || '';
    const summary = rest.find((line) => /^(Current|Past):/.test(line)) || '';
    const [headline = '', place = ''] = rest.filter(
      (line) => !/^•/.test(line) && !/^(Current|Past):/.test(line) && !ACTION_LABELS.has(line),
    );
    return {
      name,
      profile_url: link ? link.href.split('?')[0] : '',
      degree,
      headline,
      location: place,
      ...(summary && { summary }),
    };
  });

  const hasNext = [...document.querySelectorAll('main button')].some((b) => label(b) === 'Next' && !b.disabled);
  const url = new URL(location.href);
  url.searchParams.set('page', String((Number(url.searchParams.get('page')) || 1) + 1));
  return { count: people.length, people, next_page_url: hasNext ? url.href : '' };
}

/**
 * Read the profile on the current page: name, headline, location, organizations from the top card, the About text, and the connection status with the viewer (connected, pending, not_connected, follow_only)
 * @pattern https://www.linkedin.com/in/*
 */
export function get_profile() {
  const { name, card } = topCard();
  const degree = lines(card).find((line) => /^·\s*\d/.test(line))?.replace(/^·\s*/, '') || '';
  const details = lines(card).filter((line) => line !== name && !/^·/.test(line) && !ACTION_LABELS.has(line));
  const [headline = '', place = '', ...organizations] = details;
  return {
    name,
    profile_url: location.href.match(/^https:\/\/www\.linkedin\.com\/in\/[^/]+\//)?.[0] || location.href,
    degree,
    headline,
    location: place,
    organizations,
    about: sectionText('About'),
    connection_status: connectionStatus(card, name),
  };
}

/**
 * Open the connection invitation for the profile on the current page and, when a note is given, type it in. Stops before sending: the dialog stays open for the user to review and click Send. Returns the note limit and LinkedIn's remaining personalized-invitation count when shown
 * @pattern https://www.linkedin.com/in/*
 * @param {{ note?: string }} options
 * @param {string} [options.note] - Invitation note; free accounts allow 200 characters and a few notes per month
 */
export async function draft_invitation({ note = '' } = {}) {
  const { name, card } = topCard();
  const status = connectionStatus(card, name);
  if (status === 'pending') throw new Error(`An invitation to ${name} is already pending`);
  if (status === 'connected') throw new Error(`${name} is already a connection; send a message instead`);
  if (visibleDialog()) throw new Error('A dialog is already open; close it first');

  const isInvite = (el) => /^Invite .* to connect$/.test(label(el)) && isVisible(el);
  let invite = [...card.querySelectorAll('a, button')].find(isInvite);
  if (!invite) {
    // Profiles with Follow as the primary action keep Connect under "More".
    const more = [...card.querySelectorAll('button')].find((b) => label(b) === 'More' && isVisible(b));
    if (more) {
      press(more);
      invite = await waitFor(() => deepQueryAll('[role=menuitem], [role=button], button, a').find(isInvite), 3000);
    }
  }
  if (!invite) throw new Error(`No Connect action is available for ${name}`);
  press(invite);

  const findButton = (dialog, text) => [...dialog.querySelectorAll('button')].find((b) => b.innerText.trim() === text);
  let dialog = await waitFor(visibleDialog);
  if (!dialog) throw new Error('The invitation dialog did not open');
  if (!note) return { name, status: 'dialog_open', dialog: lines(dialog).join(' ') };

  const addNote = findButton(dialog, 'Add a note');
  if (addNote) press(addNote);
  const textarea = await waitFor(() => {
    dialog = visibleDialog();
    return dialog?.querySelector('textarea');
  });
  if (!textarea) {
    return { name, status: 'note_unavailable', dialog: dialog ? lines(dialog).join(' ') : '' };
  }

  const text = lines(dialog).join(' ');
  const limit = Number(text.match(/\d+\/(\d+)/)?.[1]) || Number(textarea.maxLength) || 0;
  if (limit && note.length > limit) {
    throw new Error(`The note is ${note.length} characters; LinkedIn allows ${limit}. The dialog is still open`);
  }
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, note);
  textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

  const send = findButton(dialog, 'Send');
  const remaining = text.match(/(\d+) personalized invitations? remaining[^.]*/);
  return {
    name,
    status: 'ready_to_send',
    note_length: note.length,
    note_limit: limit,
    remaining: remaining?.[0] || '',
    send_enabled: Boolean(send && !send.disabled),
    // The note box stays editable even with no quota left, so flag it before the user clicks Send.
    ...(remaining?.[1] === '0' && {
      warning: 'No personalized invitations left this month; cancel and send without a note, or wait',
    }),
  };
}
