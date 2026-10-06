/**
 * @module YouTube Tools
 * @description Read timestamped transcripts of YouTube videos
 * @icon ▶️
 * @author Browser for AI Agent
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// YouTube serves two transcript panels: the newer view-model one and the older Polymer one.
const SEGMENT_VARIANTS = [
  {
    selector: 'transcript-segment-view-model',
    time: '.ytwTranscriptSegmentViewModelTimestamp',
    text: '.ytAttributedStringHost',
  },
  { selector: 'ytd-transcript-segment-renderer', time: '.segment-timestamp', text: '.segment-text' },
];

/**
 * Read the current video's transcript as "[time] text" lines, for summarizing or searching a video; uses the default language of YouTube's transcript panel. The tab must be visible (active): YouTube does not render transcripts in background tabs
 * @pattern https://www.youtube.com/watch*
 */
export async function get_transcript() {
  if (document.hidden) {
    throw new Error('YouTube only renders transcripts in a visible tab; make this tab active, then retry');
  }
  const segmentSelector = SEGMENT_VARIANTS.map((variant) => variant.selector).join(', ');

  // After in-page navigation the URL changes first; the description and transcript panel only switch
  // to the new video once ytd-watch-flexy's video-id catches up.
  const videoId = new URL(location.href).searchParams.get('v');
  const flexy = () => document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  for (let i = 0; i < 50 && flexy() !== videoId; i++) await sleep(200);
  if (flexy() !== videoId) throw new Error('Timed out waiting for the video page to load; try again');
  const player = document.querySelector('#movie_player')?.getPlayerResponse?.();

  // The caption baseUrl now requires a proof-of-origin token, so read the page's own transcript panel instead.
  // An already open panel may still show the previous video, so always reopen it and wait for freshly
  // rendered segments. The older panel keeps its segments when reopened for the same video, so after a
  // short wait without fresh segments, the existing ones are current.
  const button = document.querySelector('ytd-video-description-transcript-section-renderer button');
  if (!button) throw new Error('This video has no transcript');
  const stale = new Set(document.querySelectorAll(segmentSelector));
  button.click();
  let segments = [];
  for (let i = 0; i < 50 && !segments.length; i++) {
    await sleep(200);
    const all = [...document.querySelectorAll(segmentSelector)];
    segments = all.filter((segment) => !stale.has(segment));
    if (!segments.length && i >= 10) segments = all;
  }

  const lines = segments.map((segment) => {
    const variant = SEGMENT_VARIANTS.find((v) => segment.matches(v.selector));
    const time = segment.querySelector(variant.time)?.textContent.trim();
    const text = segment.querySelector(variant.text)?.textContent.trim();
    return `[${time}] ${text}`;
  });
  if (!lines.length) throw new Error('Timed out loading the transcript; try again');

  return {
    title: player?.videoDetails?.title,
    channel: player?.videoDetails?.author,
    lengthSeconds: Number(player?.videoDetails?.lengthSeconds) || undefined,
    url: location.href,
    transcript: lines.join('\n'),
  };
}
