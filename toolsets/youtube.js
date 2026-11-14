/**
 * @module YouTube Tools
 * @description Read timestamped transcripts of YouTube videos, and fill in the details of a video upload in YouTube Studio for the user to publish
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

// ---------- YouTube Studio upload dialog ----------

function uploadDialog() {
  const dialog = document.querySelector('ytcp-uploads-dialog');
  if (!dialog?.querySelector('ytcp-video-metadata-editor, #textbox')) {
    throw new Error(
      'No upload dialog with video details open. In YouTube Studio click Create > Upload videos and choose a file; ' +
        'the file input is input[type=file][name=Filedata], which an agent can fill through CDP DOM.setFileInputFiles',
    );
  }
  return dialog;
}

function textbox(dialog, labelStart) {
  return [...dialog.querySelectorAll('#textbox[contenteditable="true"]')].find((box) =>
    box.getAttribute('aria-label')?.startsWith(labelStart),
  );
}

// The title and description are contenteditable boxes; replace their text the way typing would.
function setEditable(box, value) {
  box.focus();
  document.execCommand('selectAll');
  if (value) document.execCommand('insertText', false, value);
  else document.execCommand('delete');
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

function checkedRadio(dialog, prefix) {
  return dialog.querySelector(`tp-yt-paper-radio-button[name^="${prefix}"][checked]`)?.getAttribute('name')?.slice(prefix.length) || '';
}

function selectRadio(dialog, name) {
  const radio = dialog.querySelector(`tp-yt-paper-radio-button[name="${name}"]`);
  if (!radio) throw new Error(`No option ${name} in the upload dialog`);
  radio.click();
}

function readUploadDetails(dialog) {
  const progress = dialog.querySelector('ytcp-video-upload-progress');
  return {
    step: (dialog.querySelector('ytcp-stepper [active], ytcp-stepper .step[active]')?.textContent || '').trim().split(/\s+/)[0] || '',
    progress: (progress?.textContent || '').replace(/\s+/g, ' ').trim(),
    video_url: dialog.querySelector('a[href*="youtu.be/"], a[href*="/shorts/"], a[href*="watch?v="]')?.href || '',
    title: textbox(dialog, 'Add a title')?.innerText.trim() || '',
    description: textbox(dialog, 'Tell viewers')?.innerText.trim() || '',
    tags: [...dialog.querySelectorAll('ytcp-chip-bar ytcp-chip')].map((chip) => chip.textContent.trim()),
    made_for_kids: { MFK: true, NOT_MFK: false }[checkedRadio(dialog, 'VIDEO_MADE_FOR_KIDS_')] ?? null,
    altered_content: { YES: true, NO: false }[checkedRadio(dialog, 'VIDEO_HAS_ALTERED_CONTENT_')] ?? null,
    visibility: dialog.querySelector('tp-yt-paper-radio-button[name="PUBLIC"][checked], tp-yt-paper-radio-button[name="UNLISTED"][checked], tp-yt-paper-radio-button[name="PRIVATE"][checked]')?.getAttribute('name') || '',
  };
}

/**
 * Fill in the details of the video in YouTube Studio's upload dialog: title, description, tags, the made-for-kids and altered or synthetic (AI) content answers, and visibility. It never clicks Publish, Save or Schedule; the user does. Returns the details as read back. The thumbnail and video file are chosen with file inputs, which page scripts cannot fill
 * @pattern https://studio.youtube.com/*
 * @param {{ title?: string, description?: string, tags?: string[], made_for_kids?: boolean, altered_content?: boolean, visibility?: string }} options
 * @param {string} [options.title] - Video title, up to 100 characters
 * @param {string} [options.description] - Description, up to 5000 characters; newlines are kept
 * @param {string[]} [options.tags] - Tags replacing the current ones, up to 500 characters in total
 * @param {boolean} [options.made_for_kids] - Whether the video is made for kids
 * @param {boolean} [options.altered_content] - Whether AI was used to make realistic content that could be mistaken for real (YouTube's altered or synthetic content disclosure)
 * @param {string} [options.visibility] - PUBLIC, UNLISTED or PRIVATE, selected on the last step; the dialog is advanced to that step without publishing
 */
export async function draft_upload_details({ title, description, tags, made_for_kids, altered_content, visibility } = {}) {
  const dialog = uploadDialog();
  if (title !== undefined) {
    if (!title) throw new Error('title cannot be empty');
    if (title.length > 100) throw new Error(`The title is ${title.length} characters; YouTube allows 100`);
    setEditable(textbox(dialog, 'Add a title'), title);
  }
  if (description !== undefined) {
    if (description.length > 5000) throw new Error(`The description is ${description.length} characters; YouTube allows 5000`);
    setEditable(textbox(dialog, 'Tell viewers'), description);
  }
  if (made_for_kids !== undefined) selectRadio(dialog, made_for_kids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK');

  if (tags !== undefined || altered_content !== undefined) {
    const toggle = dialog.querySelector('#toggle-button');
    if (toggle && /show more/i.test(toggle.textContent)) {
      toggle.click();
      await sleep(600);
    }
  }
  if (altered_content !== undefined) {
    selectRadio(dialog, altered_content ? 'VIDEO_HAS_ALTERED_CONTENT_YES' : 'VIDEO_HAS_ALTERED_CONTENT_NO');
  }
  if (tags !== undefined) {
    if (tags.join(',').length > 500) throw new Error('Tags exceed YouTube\'s 500-character limit');
    const bar = dialog.querySelector('ytcp-chip-bar');
    for (let remove; (remove = bar.querySelector('ytcp-chip #delete-icon')); ) {
      remove.click();
      await sleep(50);
    }
    const input = bar.querySelector('#text-input');
    input.focus();
    for (const tag of tags) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, tag);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
      await sleep(80);
    }
  }

  // Read the details before leaving their step: other steps unmount the details form.
  const result = readUploadDetails(dialog);
  if (visibility !== undefined) {
    if (!['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(visibility)) throw new Error('visibility must be PUBLIC, UNLISTED or PRIVATE');
    // Advance with Next (it saves the draft, nothing is published) until the visibility step shows.
    for (let i = 0; i < 4 && !dialog.querySelector(`tp-yt-paper-radio-button[name="${visibility}"]`)?.offsetParent; i++) {
      const next = dialog.querySelector('#next-button');
      if (!next || next.hasAttribute('disabled')) throw new Error('Cannot advance to the visibility step; check the details for errors');
      next.click();
      await sleep(800);
    }
    selectRadio(dialog, visibility);
    await sleep(200);
    result.step = 'Visibility';
  }
  result.visibility = readUploadDetails(dialog).visibility || result.visibility;
  const missing = [!result.title && 'title', result.made_for_kids === null && 'made_for_kids', !result.visibility && 'visibility'].filter(Boolean);
  return { status: missing.length ? 'incomplete' : 'ready_to_publish', ...result, ...(missing.length && { missing }) };
}
