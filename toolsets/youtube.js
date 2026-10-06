/**
 * @module YouTube Tools
 * @description Read timestamped transcripts of YouTube videos
 * @icon ▶️
 * @author Browser for AI Agent
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read the current video's transcript as "[time] text" lines, for summarizing or searching a video; uses the default language of YouTube's transcript panel
 * @pattern https://www.youtube.com/watch*
 */
export async function get_transcript() {
  const segmentSelector = 'transcript-segment-view-model';

  // After in-page navigation the URL changes first; the description and transcript panel only switch
  // to the new video once ytd-watch-flexy's video-id catches up.
  const videoId = new URL(location.href).searchParams.get('v');
  const flexy = () => document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  for (let i = 0; i < 50 && flexy() !== videoId; i++) await sleep(200);
  if (flexy() !== videoId) throw new Error('Timed out waiting for the video page to load; try again');
  const player = document.querySelector('#movie_player')?.getPlayerResponse?.();

  // The caption baseUrl now requires a proof-of-origin token, so read the page's own transcript panel instead.
  // An already open panel may still show the previous video, so always reopen it and wait for freshly
  // rendered segments.
  const button = document.querySelector('ytd-video-description-transcript-section-renderer button');
  if (!button) throw new Error('This video has no transcript');
  const stale = new Set(document.querySelectorAll(segmentSelector));
  button.click();
  let segments = [];
  for (let i = 0; i < 50 && !segments.length; i++) {
    await sleep(200);
    segments = [...document.querySelectorAll(segmentSelector)].filter((segment) => !stale.has(segment));
  }

  const lines = segments.map((segment) => {
    const time = segment.querySelector('.ytwTranscriptSegmentViewModelTimestamp')?.textContent.trim();
    const text = segment.querySelector('.ytAttributedStringHost')?.textContent.trim();
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
