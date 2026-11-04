/**
 * @module X Tools
 * @description Read X (Twitter) timelines, posts with their reply threads, and profiles as structured data, and draft posts and replies for the user to publish
 * @icon 𝕏
 * @author Browser for AI Agent
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Re-checks on DOM changes rather than on a timer, which background tabs throttle to about once a minute.
function waitFor(fn, timeout = 8000) {
  return new Promise((resolve) => {
    const value = fn();
    if (value) return resolve(value);
    const observer = new MutationObserver(() => {
      const found = fn();
      if (found) done(found);
    });
    const timer = setTimeout(() => done(null), timeout);
    const done = (result) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(result);
    };
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

// X keeps every loaded post and user in its Redux store, and each timeline's entries in state.urt. Reading the
// store returns full text and exact counts, including entries the virtualized list has not rendered, which it
// never does in a background tab.
function appState() {
  // The timeline module is passed down to each rendered entry, so start from the entries themselves.
  const starts = document.querySelectorAll('[data-testid=cellInnerDiv] article, [data-testid=cellInnerDiv] [data-testid=UserCell], [data-testid=cellInnerDiv] > div > div');
  if (!starts.length) throw new Error('No timeline on this page; open a timeline, profile, search, list or post on x.com');
  let store;
  let timeline;
  for (const el of starts) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    for (let fiber = el[key], depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
      const props = fiber.memoizedProps || {};
      store ||= props.value?.store?.getState ? props.value.store : undefined;
      timeline ||= typeof props.module?.fetchBottom === 'function' ? props.module : undefined;
    }
    if (store && timeline) return { store, timeline };
  }
  throw new Error('Could not read the timeline; reload the page and retry');
}

function tweetIdsOf(entry) {
  const content = entry.content || {};
  if (entry.type === 'tweet' && content.id) return [content.id];
  // Conversation modules group a reply chain; other modules (who to follow, topics) hold no posts.
  return (content.items || [])
    .map((item) => item.item?.content || item.content || {})
    .filter((c) => c.id && (c.displayType === 'Tweet' || c.displayType === 'SelfThread' || /tweet/i.test(c.displayType || '')))
    .map((c) => c.id);
}

function expandText(tweet) {
  let text = tweet.note_tweet?.text || tweet.full_text || tweet.text || '';
  // Replies start with the @handles they answer, which reply_to already names; X hides them too.
  const [start] = tweet.display_text_range || [0];
  if (!tweet.note_tweet && start > 0) text = Array.from(text).slice(start).join('');
  const urls = [...(tweet.note_tweet?.entity_set?.urls || []), ...(tweet.entities?.urls || [])];
  for (const url of urls) text = text.split(url.url).join(url.expanded_url);
  // Media links point back to the post itself; the media list has them.
  for (const media of tweet.extended_entities?.media || tweet.entities?.media || []) text = text.split(media.url).join('');
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function mediaOf(tweet) {
  return (tweet.extended_entities?.media || []).map((media) => {
    if (media.type === 'photo') return { type: 'photo', url: media.media_url_https };
    const best = (media.video_info?.variants || [])
      .filter((v) => v.content_type === 'video/mp4')
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return { type: media.type, url: best?.url || media.expanded_url, poster: media.media_url_https };
  });
}

function formatTweet(state, id, depth = 0) {
  const tweets = state.entities.tweets.entities;
  const users = state.entities.users.entities;
  const tweet = tweets[id];
  if (!tweet) return null;
  const user = users[tweet.user] || {};
  if (tweet.retweeted_status && depth === 0) {
    const original = formatTweet(state, tweet.retweeted_status, 1);
    if (original) return { ...original, reposted_by: user.screen_name };
  }
  const quoted = tweet.quoted_status && depth < 1 ? formatTweet(state, tweet.quoted_status, depth + 1) : null;
  const media = mediaOf(tweet);
  // Counts update live after the post loads; the page shows these, and counts quotes as reposts.
  const live = state.liveTweetCounts?.[id] || {};
  const quotes = live.quoteCount ?? tweet.quote_count ?? 0;
  const views = live.viewCount ?? tweet.views?.count;
  return {
    id: tweet.id_str,
    url: `https://x.com/${user.screen_name}/status/${tweet.id_str}`,
    author: { name: user.name, handle: user.screen_name, ...(user.is_blue_verified && { verified: true }) },
    created_at: tweet.created_at,
    text: expandText(tweet),
    ...(tweet.in_reply_to_screen_name && { reply_to: tweet.in_reply_to_screen_name }),
    replies: live.replyCount ?? tweet.reply_count ?? 0,
    reposts: (live.retweetCount ?? tweet.retweet_count ?? 0) + quotes,
    quotes,
    likes: live.likeCount ?? tweet.favorite_count ?? 0,
    bookmarks: live.bookmarkCount ?? tweet.bookmark_count ?? 0,
    ...(views != null && { views: Number(views) }),
    ...(media.length && { media }),
    ...(tweet.card?.legacy?.binding_values && { card: cardOf(tweet.card.legacy) }),
    ...(quoted && { quote: quoted }),
  };
}

function cardOf(card) {
  const values = Object.fromEntries((card.binding_values || []).map((v) => [v.key, v.value?.string_value]));
  return { title: values.title || '', url: values.card_url || card.url || '', ...(values.description && { description: values.description }) };
}

function orderedTweetIds(state, timelineId, includePromoted) {
  const timeline = state.urt[timelineId] || {};
  const entries = [...(timeline.entries || [])];
  entries.sort((a, b) => (BigInt(b.sortIndex || 0) > BigInt(a.sortIndex || 0) ? 1 : -1));
  // Profiles keep the pinned post apart from the entries and show it first.
  if (timeline.pinnedEntry) entries.unshift(timeline.pinnedEntry);
  const ids = [];
  for (const entry of entries) {
    if (!includePromoted && /^promoted-/.test(entry.entryId)) continue;
    for (const id of tweetIdsOf(entry)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function loadTweets(limit, includePromoted, skip = []) {
  const { store, timeline } = appState();
  const ids = () => orderedTweetIds(store.getState(), timeline.timelineId, includePromoted).filter((id) => !skip.includes(id));
  // Each fetchBottom loads about 20 more entries through the app's own request.
  for (let round = 0, before = -1; ids().length < limit && ids().length !== before && round < 10; round++) {
    before = ids().length;
    await store.dispatch(timeline.fetchBottom());
  }
  const state = store.getState();
  return { state, timeline, ids: ids().slice(0, limit) };
}

/**
 * List posts on the current X timeline (Home, a profile, search results, a list, bookmarks), loading more as needed. Each post has its URL, author, time, full text with links expanded, reply/repost/quote/like/bookmark/view counts as the page shows them (reposts include quotes), media and any quoted post; reposts carry reposted_by. Ads are left out
 * @pattern https://x.com/*
 * @param {{ limit?: number, include_ads?: boolean }} options
 * @param {number} [options.limit=40] - Maximum number of posts to return; up to 200
 * @param {boolean} [options.include_ads=false] - Keep promoted posts
 */
export async function list_tweets({ limit = 40, include_ads = false } = {}) {
  const { state, timeline, ids } = await loadTweets(Math.min(limit, 200), include_ads);
  const pinned = state.urt[timeline.timelineId]?.pinnedEntry?.content?.id;
  const tweets = ids.map((id) => formatTweet(state, id) && { ...formatTweet(state, id), ...(id === pinned && { pinned: true }) }).filter(Boolean);
  if (!tweets.length) throw new Error('No posts on this timeline yet; wait for it to load and retry');
  return { timeline: timeline.timelineId, url: location.href, count: tweets.length, tweets };
}

/**
 * Read the post open on the current page (x.com/<user>/status/<id>) and its replies, loading more replies as needed. Returns the post, then replies in the order X shows them, each with author, time, text and counts
 * @pattern https://x.com/:user/status/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=50] - Maximum number of replies to return; up to 200
 */
export async function get_thread({ limit = 50 } = {}) {
  const id = location.pathname.match(/\/status\/(\d+)/)?.[1];
  if (!id) throw new Error('Not a post page; open https://x.com/<user>/status/<id>');
  const { state, ids } = await loadTweets(Math.min(limit, 200) + 1, false);
  const post = formatTweet(state, id);
  if (!post) throw new Error('The post has not loaded; wait for it and retry');
  // Posts above the focused one are the chain it replies to.
  const index = ids.indexOf(id);
  const ancestors = index > 0 ? ids.slice(0, index) : [];
  const replies = ids.filter((tid) => tid !== id && !ancestors.includes(tid)).slice(0, limit).map((tid) => formatTweet(state, tid));
  return {
    ...(ancestors.length && { in_reply_to: ancestors.map((tid) => formatTweet(state, tid)) }),
    post,
    // X shows a ranked subset; the post's reply count also includes nested and hidden replies.
    count: replies.length,
    replies,
  };
}

/**
 * Read the profile open on the current page (x.com/<user>): name, handle, bio with links expanded, location, website, join date, follower/following/post counts, verification, and whether you follow each other
 * @pattern https://x.com/*
 */
export function get_profile() {
  const handle = location.pathname.split('/')[1];
  if (!handle || ['home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings', 'compose'].includes(handle)) {
    throw new Error('Not a profile page; open https://x.com/<user>');
  }
  const cell = document.querySelector('[data-testid=primaryColumn]');
  if (!cell) throw new Error('The profile has not loaded yet');
  // The store is reachable from any rendered element under the app root.
  const key = Object.keys(cell).find((k) => k.startsWith('__reactFiber'));
  let store;
  for (let fiber = cell[key], depth = 0; fiber && depth < 80 && !store; fiber = fiber.return, depth++) {
    store = fiber.memoizedProps?.value?.store?.getState ? fiber.memoizedProps.value.store : undefined;
  }
  if (!store) throw new Error('Could not read the page state; reload and retry');
  const user = Object.values(store.getState().entities.users.entities).find(
    (u) => u.screen_name?.toLowerCase() === handle.toLowerCase(),
  );
  if (!user) throw new Error(`Profile @${handle} has not loaded yet; wait for it and retry`);
  let bio = user.description || '';
  for (const url of user.entities?.description?.urls || []) bio = bio.split(url.url).join(url.expanded_url);
  const website = user.entities?.url?.urls?.[0]?.expanded_url || user.url || '';
  return {
    name: user.name,
    handle: user.screen_name,
    url: `https://x.com/${user.screen_name}`,
    bio,
    ...(user.location && { location: user.location }),
    ...(website && { website }),
    joined: user.created_at,
    followers: user.followers_count,
    following: user.friends_count,
    posts: user.statuses_count,
    ...(user.is_blue_verified && { verified: true }),
    ...(user.protected && { protected: true }),
    you_follow: Boolean(user.following),
    follows_you: Boolean(user.followed_by),
    ...(user.pinned_tweet_ids_str?.length && { pinned_post_id: user.pinned_tweet_ids_str[0] }),
  };
}

/**
 * Type a post into X's composer and stop before publishing; the user reviews it and clicks Post. With reply true on a post page it fills the reply box under the open post; otherwise it opens the new-post composer. Returns the drafted text
 * @pattern https://x.com/*
 * @param {{ text: string, reply?: boolean }} options
 * @param {string} options.text - Post text; X counts up to 280 characters for most accounts
 * @param {boolean} [options.reply=false] - Reply to the post open on the page instead of writing a new post
 */
export async function draft_post({ text, reply = false } = {}) {
  if (!text) throw new Error('text is required');
  let box;
  if (reply) {
    if (!/\/status\/\d+/.test(location.pathname)) throw new Error('reply needs a post page; open https://x.com/<user>/status/<id>');
    box = await waitFor(() => document.querySelector('[data-testid=primaryColumn] [data-testid=tweetTextarea_0]'));
    if (!box) throw new Error('No reply box under this post; replies may be limited by the author');
  } else {
    const open = document.querySelector('[data-testid=SideNav_NewTweet_Button]');
    if (!open) throw new Error('No Post button in the sidebar; widen the window or open https://x.com/compose/post');
    open.click();
    box = await waitFor(() => document.querySelector('[role=dialog] [data-testid=tweetTextarea_0]'));
    if (!box) throw new Error('The composer did not open');
  }
  box.focus();
  // The composer is a Draft.js editor: insertText lands twice (Draft.js and the browser both apply it), while a
  // paste goes through Draft.js alone and replaces the selection.
  document.execCommand('selectAll');
  const data = new DataTransfer();
  data.setData('text/plain', text);
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  await sleep(300);
  const button = document.querySelector(reply ? '[data-testid=tweetButtonInline]' : '[role=dialog] [data-testid=tweetButton]');
  return {
    status: 'ready_to_post',
    mode: reply ? 'reply' : 'new_post',
    text: box.innerText.trim(),
    ...(button?.getAttribute('aria-disabled') === 'true' && { warning: 'X has not enabled the Post button; the text may be too long' }),
  };
}
