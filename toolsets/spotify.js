/**
 * @module Spotify Tools
 * @description Read what's playing on the Spotify Web Player and its lyrics, list tracks on playlist, album, artist, search and Liked Songs pages, and control playback
 * @icon 🎧
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

// Playlists use playlist-tracklist; albums, artists, search and Liked Songs use track-list.
const GRID = '[role=grid]:has([data-testid=tracklist-row])';
const WIDGET = ':is([data-testid=now-playing-widget], [data-testid=now-playing-widget-v2])';

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function spotifyUrl(href) {
  return href ? new URL(href, location.origin).origin + new URL(href, location.origin).pathname : '';
}

function seconds(time) {
  const parts = (time || '').split(':').map(Number);
  return parts.some(Number.isNaN) || !time ? null : parts.reduce((sum, part) => sum * 60 + part, 0);
}

// Button labels follow the account's display language, so play state comes from Media Session first.
function isPlaying() {
  const state = navigator.mediaSession?.playbackState;
  if (state === 'playing') return true;
  if (state === 'paused') return false;
  const label = document.querySelector('[data-testid=control-button-playpause]')?.getAttribute('aria-label') || '';
  return /pau|暂停|暫停|停止|일시/i.test(label);
}

function nowPlaying() {
  const widget = document.querySelector(WIDGET);
  if (!widget) throw new Error('Nothing is playing; start a track in the Spotify Web Player first');
  const meta = navigator.mediaSession?.metadata;
  const artwork = [...(meta?.artwork || [])].sort((a, b) => Number.parseInt(b.sizes) - Number.parseInt(a.sizes))[0];
  const position = text(document.querySelector('[data-testid=playback-position]'));
  const duration = text(document.querySelector('[data-testid=playback-duration]'));
  const repeat = document.querySelector('[data-testid=control-button-repeat]');
  // Shown when the music plays on another device, e.g. "Playing on MacBook".
  const device = text(document.querySelector('[data-testid=now-playing-bar] > div + div'));
  return {
    title: meta?.title || text(widget.querySelector(':scope > div:nth-child(2) > div:nth-child(1)')),
    artists: [...widget.querySelectorAll('a[href^="/artist/"]')].map((a) => ({ name: text(a), url: spotifyUrl(a.getAttribute('href')) })),
    album: meta?.album || '',
    album_url: spotifyUrl(widget.querySelector('a[href^="/album/"]')?.getAttribute('href')),
    cover: artwork?.src || widget.querySelector('img')?.src || '',
    is_playing: isPlaying(),
    position,
    duration,
    position_seconds: seconds(position),
    duration_seconds: seconds(duration),
    ...(repeat && { repeat: { true: 'context', mixed: 'track' }[repeat.getAttribute('aria-checked')] || 'off' }),
    ...(device && { device }),
  };
}

/**
 * Read the track playing in the Spotify Web Player: title, artists with links, album, cover URL, whether it is playing, position and duration, repeat mode, and the device when it plays elsewhere
 * @pattern https://open.spotify.com/*
 */
export function get_now_playing() {
  return nowPlaying();
}

// The Now Playing sidebar also shows a few lines as a preview; the lyrics view is the largest block of lines.
function lyricsLines() {
  const groups = new Map();
  for (const line of document.querySelectorAll('[data-testid=lyrics-line]')) {
    if (!groups.has(line.parentElement)) groups.set(line.parentElement, []);
    groups.get(line.parentElement).push(line);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
}

// Lines carry hashed classes for past, current and upcoming states; the current one is the only line in its state.
function currentLineIndex(lines) {
  const groups = new Map();
  lines.forEach((line, index) => {
    const state = line.classList[1] || '';
    if (!groups.has(state)) groups.set(state, []);
    groups.get(state).push(index);
  });
  const single = [...groups.values()].filter((group) => group.length === 1);
  return single.length === 1 && lines.length > 2 ? single[0][0] : -1;
}

/**
 * Read the lyrics of the track playing in the Spotify Web Player, opening the lyrics view if needed and closing it again. Returns the lines in order, the index of the line being sung (current_line, -1 when unknown) and the lyrics provider. Lines have no timestamps
 * @pattern https://open.spotify.com/*
 */
export async function get_lyrics() {
  const track = nowPlaying();
  const button = document.querySelector('[data-testid=lyrics-button]');
  if (!button) throw new Error('No lyrics button in the player bar; the window may be too narrow');
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
    return { title: track.title, artists: track.artists.map((a) => a.name), available: false, lines: [] };
  }
  const opened = button.getAttribute('aria-pressed') !== 'true';
  if (opened) button.click();
  const lines = await waitFor(() => {
    const found = lyricsLines();
    return found.length > 8 || (found.some((line) => text(line)) && !opened) ? found : null;
  });
  try {
    if (!lines) throw new Error('Spotify has no lyrics for this track, or the lyrics view did not load');
    const provider = [...document.querySelectorAll('p, span, div')].find(
      (el) => !el.children.length && /^Lyrics provided by /.test(el.textContent),
    );
    // Instrumental breaks show as "♪"; empty lines are spacers.
    const kept = lines.filter((line) => text(line));
    const current = currentLineIndex(lines);
    return {
      title: track.title,
      artists: track.artists.map((a) => a.name),
      available: true,
      provider: text(provider).replace(/^Lyrics provided by /, ''),
      current_line: current >= 0 ? kept.indexOf(lines[current]) : -1,
      lines: kept.map(text),
    };
  } finally {
    if (opened) document.querySelector('[data-testid=lyrics-button]')?.click();
  }
}

function parseRow(row) {
  const cells = row.querySelectorAll('[role=gridcell]');
  const titleCell = row.querySelector('[data-testid=internal-track-link]')?.closest('[role=gridcell]') || cells[1];
  const link = row.querySelector('[data-testid=internal-track-link]');
  const album = row.querySelector('a[href^="/album/"]');
  const last = cells[cells.length - 1];
  const duration = [...(last?.querySelectorAll('div, span') || [])].map(text).find((t) => /^\d+:\d{2}(:\d{2})?$/.test(t)) || '';
  // Playlist pages put "Date added" between the album and the duration; artist pages put the play count there.
  const extra = [...cells].slice(2, -1).filter((cell) => !cell.querySelector('a')).map(text).find(Boolean);
  const plays = /^[\d,.\s]+$/.test(extra || '') ? Number(extra.replace(/\D/g, '')) : undefined;
  const added = plays == null ? extra : undefined;
  return {
    index: Number(row.closest('[role=row]').getAttribute('aria-rowindex')) - 1,
    title: text(link) || text(titleCell?.querySelector('[dir=auto]')),
    url: spotifyUrl(link?.getAttribute('href')),
    artists: [...(titleCell?.querySelectorAll('a[href^="/artist/"]') || [])].map(text),
    ...(album && { album: text(album) }),
    duration_seconds: seconds(duration),
    ...(added && { added }),
    ...(plays != null && { plays }),
    ...(titleCell?.querySelector('[data-encore-id=tagIcon]') && { explicit: true }),
  };
}

function scrollerOf(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

// The track list component keeps a paged cache of every track's metadata; it fills in background tabs too,
// where the virtualized rows stop rendering.
function itemsCacheOf(grid) {
  const key = Object.keys(grid).find((k) => k.startsWith('__reactFiber'));
  for (let fiber = grid[key], depth = 0; fiber && depth < 30; fiber = fiber.return, depth++) {
    const cache = fiber.memoizedProps?.itemsCache;
    if (typeof cache?.getItems === 'function') return cache;
  }
  return null;
}

const trackUrl = (uri) => (uri ? `${location.origin}/${uri.split(':').slice(1).join('/')}` : '');

function fromItem(item, index) {
  return {
    index,
    title: item.name || '',
    url: trackUrl(item.uri),
    artists: (item.artists || []).map((a) => a.name),
    ...(item.album?.name && { album: item.album.name }),
    duration_seconds: Math.round((item.duration?.milliseconds || 0) / 1000),
    ...(item.addedAt && { added: item.addedAt.slice(0, 10) }),
    ...(item.isExplicit && { explicit: true }),
    ...(item.isPlayable === false && { playable: false }),
  };
}

async function tracksFromCache(cache, count) {
  let items = [];
  for (let start = Date.now(); Date.now() - start < 15000; await sleep(300)) {
    items = cache.getItems(0, count - 1) || [];
    if (items.filter(Boolean).length >= count) break;
    // Some lists (artist pages) cache only URIs; their rows have the details.
    if (items.some((item) => item && !item.name)) return [];
  }
  return items.map((item, i) => item?.name && item.uri?.startsWith('spotify:') && fromItem(item, i + 1)).filter(Boolean);
}

async function tracksFromRows(grid, limit, target) {
  const tracks = new Map();
  const collect = () => {
    for (const row of grid.querySelectorAll('[data-testid=tracklist-row]')) {
      const track = parseRow(row);
      if (track.index > 0 && track.index <= limit && !tracks.has(track.index)) tracks.set(track.index, track);
    }
  };
  // The list renders only the rows near the viewport, and only while the tab is visible.
  const scroller = scrollerOf(grid);
  const start = scroller?.scrollTop;
  collect();
  try {
    for (let stalls = 0; scroller && !document.hidden && tracks.size < target && stalls < 8; ) {
      const before = tracks.size;
      const rows = grid.querySelectorAll('[data-testid=tracklist-row]');
      rows[rows.length - 1]?.scrollIntoView({ block: 'start' });
      await sleep(300);
      collect();
      stalls = tracks.size > before ? 0 : stalls + 1;
    }
  } finally {
    if (scroller) scroller.scrollTop = start;
  }
  return [...tracks.values()].sort((a, b) => a.index - b.index);
}

/**
 * List tracks on the current playlist, album, artist, search results or Liked Songs page, loading more as needed. Each track has its position (index, from 1), title, URL, artists, album, duration and, on playlists and Liked Songs, the date it was added
 * @pattern https://open.spotify.com/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=100] - Maximum number of tracks to return
 */
export async function list_tracks({ limit = 100 } = {}) {
  const grid = document.querySelector(GRID);
  if (!grid) throw new Error('No track list on this page; open a playlist, album, artist, search or Liked Songs page');
  // aria-rowcount includes the header row, which artist pages leave out.
  const total = Math.max(0, Number(grid.getAttribute('aria-rowcount')) - (grid.querySelector('[role=columnheader]') ? 1 : 0));
  const target = Math.min(limit, total || limit);

  const cache = itemsCacheOf(grid);
  let tracks = cache ? await tracksFromCache(cache, target) : [];
  if (tracks.length < target) {
    const rows = await tracksFromRows(grid, limit, target);
    if (rows.length > tracks.length) tracks = rows;
  }
  return {
    title: grid.getAttribute('aria-label') || text(document.querySelector('main h1')),
    url: location.origin + location.pathname,
    total_tracks: total,
    count: tracks.length,
    truncated: tracks.length < total,
    ...(tracks.length < target && document.hidden && { note: 'Only the rendered rows were read; make the tab visible to load more' }),
    tracks,
  };
}

/**
 * Control playback in the Spotify Web Player: play, pause, toggle, next or previous, or play track number index from the track list on the current page. Returns the resulting now-playing state
 * @pattern https://open.spotify.com/*
 * @param {{ action: string, index?: number }} options
 * @param {string} options.action - One of play, pause, toggle, next, previous, play_track
 * @param {number} [options.index] - For play_track: the track's index from list_tracks on the current page
 */
export async function control_playback({ action, index } = {}) {
  const click = (testid) => {
    const button = document.querySelector(`[data-testid=${testid}]`);
    if (!button || button.disabled) throw new Error(`The ${action} control is not available right now`);
    button.click();
  };
  const before = document.querySelector(WIDGET) ? nowPlaying() : null;
  switch (action) {
    case 'play':
    case 'pause':
      if (isPlaying() !== (action === 'play')) click('control-button-playpause');
      break;
    case 'toggle':
      click('control-button-playpause');
      break;
    case 'next':
      click('control-button-skip-forward');
      break;
    case 'previous':
      click('control-button-skip-back');
      break;
    case 'play_track': {
      const grid = document.querySelector(GRID);
      const row = grid?.querySelector(`[role=row][aria-rowindex="${Number(index) + 1}"] [data-testid=tracklist-row]`);
      if (!row) throw new Error(`Track ${index} is not loaded on this page; call list_tracks first or scroll to it`);
      row.querySelector('[role=gridcell] button')?.click();
      break;
    }
    default:
      throw new Error('action must be one of play, pause, toggle, next, previous, play_track');
  }
  // Wait for the player bar to reflect the change.
  await waitFor(() => {
    if (!document.querySelector(WIDGET)) return false;
    const after = nowPlaying();
    return !before || after.title !== before.title || after.is_playing !== before.is_playing;
  }, 4000);
  return nowPlaying();
}
