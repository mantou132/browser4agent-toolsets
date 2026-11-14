/**
 * @module Bilibili Tools
 * @description Read the state of a Bilibili video upload and fill in its title, description, tags and creation declaration for the user to publish
 * @icon 📺
 * @author Browser for AI Agent
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 5000) {
  for (const start = Date.now(); Date.now() - start < timeout; await sleep(150)) {
    const value = fn();
    if (value) return value;
  }
  return null;
}

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

// The upload page is a micro-app rendered in the light DOM; its form only exists after a video is chosen.
function uploadForm() {
  const app = document.querySelector('#video-up-app');
  const title = app?.querySelector('input[placeholder="请输入稿件标题"]');
  if (!title) {
    throw new Error(
      'No upload form on this page. Open https://member.bilibili.com/platform/upload/video/frame and choose a video file first; ' +
        'the file input is input[type=file][accept*=mp4], which an agent can fill through CDP DOM.setFileInputFiles',
    );
  }
  return { app, title };
}

function section(app, heading) {
  const h3 = [...app.querySelectorAll('h3')].find((h) => text(h) === heading);
  return h3?.closest('.section-title-container')?.parentElement || null;
}

// Vue binds inputs on `input` events; set through the native setter so the binding sees the new value.
function setValue(input, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function readTags() {
  return [...document.querySelectorAll('#tag-container .label-item-v2-content')].map(text);
}

// One entry per part (分P): its file name and status text such as 上传完成 or a percentage.
function readUploads(app) {
  return [...app.querySelectorAll('.task')].map((task) => ({
    file: text(task.querySelector('.task-title-text')),
    status: text(task.querySelector('.task-status')),
    done: Boolean(task.querySelector('.task-status-success')),
  }));
}

// The chosen cover is shown as a background image served from archive.biliimg.com; system suggestions are <img> thumbnails.
function hasCover(app) {
  const main = app.querySelector('.cover .cover-main');
  return [...(main?.querySelectorAll('*') || [])].some((el) => getComputedStyle(el).backgroundImage.includes('/bfs/archive/'));
}

function readForm() {
  const { app, title } = uploadForm();
  const editor = app.querySelector('.archive-info-editor .ql-container');
  const declaration = app.querySelector('input[placeholder^="请选择符合"]');
  return {
    uploads: readUploads(app),
    title: title.value,
    zone: text(section(app, '分区')?.querySelector('.select-item-cont')),
    tags: readTags(),
    declaration: declaration?.value || '',
    description: editor?.__quill?.getText().trim() || '',
    cover_set: hasCover(app),
  };
}

/**
 * Read the video upload form: upload status of each part, title, zone (分区), tags, creation declaration (创作声明), description and whether a cover is set
 * @pattern https://member.bilibili.com/platform/upload/video/*
 */
export function get_upload_form() {
  return readForm();
}

/**
 * Fill in the upload form for the user to review and publish; it never clicks 立即投稿 or 存草稿. Tags replace the current ones (Bilibili pre-fills guesses, often unrelated). Returns the form as read back, with any required fields still missing. The video file and a custom cover are chosen with file inputs, which page scripts cannot fill
 * @pattern https://member.bilibili.com/platform/upload/video/*
 * @param {{ title?: string, description?: string, tags?: string[], declaration?: string }} options
 * @param {string} [options.title] - Video title, up to 80 characters
 * @param {string} [options.description] - Plain-text description (简介), up to 2000 characters; newlines are kept
 * @param {string[]} [options.tags] - Up to 10 tags of at most 20 characters each, replacing the current tags
 * @param {string} [options.declaration] - Creation declaration (创作声明) option text, such as 内容无需标注, 含AI生成内容, 含虚构演绎内容, 内容含营销信息, 个人观点，仅供参考 or 内容为转载
 */
export async function draft_upload({ title, description, tags, declaration } = {}) {
  const { app, title: titleInput } = uploadForm();

  if (title !== undefined) {
    if (title.length > 80) throw new Error(`The title is ${title.length} characters; Bilibili allows 80`);
    setValue(titleInput, title);
  }

  if (description !== undefined) {
    if (description.length > 2000) throw new Error(`The description is ${description.length} characters; Bilibili allows 2000`);
    const quill = app.querySelector('.archive-info-editor .ql-container')?.__quill;
    if (!quill) throw new Error('The description editor is not ready; wait for the form to finish loading and retry');
    quill.setText(description, 'user');
  }

  const rejected = [];
  if (tags !== undefined) {
    if (tags.length > 10) throw new Error(`Bilibili allows 10 tags, got ${tags.length}`);
    const tooLong = tags.find((tag) => tag.length > 20);
    if (tooLong) throw new Error(`Tag "${tooLong}" is longer than 20 characters`);
    const box = document.querySelector('#tag-container');
    for (let close; (close = box.querySelector('.label-item-v2-container .close')); ) {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(80);
    }
    const input = box.querySelector('input[placeholder^="按回车键"]');
    for (const tag of tags) {
      setValue(input, tag);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      if (!(await waitFor(() => readTags().includes(tag), 3000))) {
        // Bilibili explains rejections (e.g. topic-only tags) in a toast.
        rejected.push({ tag, reason: text([...document.querySelectorAll('[class*="toast"]')].pop()) });
        setValue(input, '');
      }
    }
  }

  if (declaration !== undefined) {
    const input = app.querySelector('input[placeholder^="请选择符合"]');
    input.click();
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll('.bcc-option')];
      return found.length ? found : null;
    });
    const option = options?.find((o) => text(o) === declaration);
    if (!option) {
      document.body.click();
      throw new Error(`No declaration "${declaration}"; options: ${(options || []).map(text).join(', ')}`);
    }
    option.click();
    await waitFor(() => input.value === declaration, 2000);
  }

  await sleep(300);
  const form = readForm();
  const missing = [
    !form.title && 'title',
    !form.tags.length && 'tags',
    !form.declaration && 'declaration',
    !form.cover_set && 'cover',
    (!form.uploads.length || form.uploads.some((u) => !u.done)) && 'upload_in_progress',
  ].filter(Boolean);
  return {
    status: missing.length ? 'incomplete' : 'ready_to_publish',
    ...form,
    ...(missing.length && { missing }),
    ...(rejected.length && { rejected_tags: rejected }),
  };
}
