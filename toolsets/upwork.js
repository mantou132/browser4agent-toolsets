/**
 * @module Upwork Tools
 * @description Read Upwork job postings and fill in proposal forms on the apply page. Draft cover letters and questionnaire answers without submitting — the form stays open for the user to review and send
 * @icon 🟢
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

function textOf(el) {
  return (el?.innerText || '').replace(/\s+/g, ' ').trim();
}

// Cloudflare shows a "Just a moment..." interstitial before the real page loads.
// Detecting it early prevents returning empty data that looks like a valid result.
function assertNotChallenge() {
  if (/just a moment/i.test(document.title) || /just a moment/i.test(document.body?.innerText || '')) {
    throw new Error(
      'The page is showing a Cloudflare "Just a moment..." challenge. Make this browser tab visible (active) so the challenge can complete, then retry. Background tabs often get stuck on it.',
    );
  }
}

// Upwork uses React controlled inputs; setting .value directly is ignored.
// Use the native setter to bypass React's synthetic event override.
function setValue(field, value) {
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.dispatchEvent(new Event('blur', { bubbles: true }));
}

// On the proposal apply page, each question is a <label> whose text is the question,
// followed by a textarea.air3-textarea. The cover letter is identified by its own label.
function findTextareaByLabel(keyword) {
  const textareas = document.querySelectorAll('textarea.air3-textarea');
  for (const ta of textareas) {
    // Walk up to the nearest container that also holds the label text.
    let container = ta.parentElement;
    for (let i = 0; i < 6 && container; i++) {
      const text = textOf(container);
      if (text.toLowerCase().includes(keyword.toLowerCase())) return ta;
      container = container.parentElement;
    }
  }
  return null;
}

// Map each textarea to its label text by scanning ancestors.
function textareaLabels() {
  const textareas = document.querySelectorAll('textarea.air3-textarea');
  return [...textareas].map((ta) => {
    let container = ta.parentElement;
    for (let i = 0; i < 8 && container; i++) {
      const labelEl = container.querySelector('label');
      if (labelEl && !labelEl.contains(ta)) {
        return { textarea: ta, label: textOf(labelEl) };
      }
      const prev = container.previousElementSibling;
      if (prev && prev.querySelector('label')) {
        return { textarea: ta, label: textOf(prev.querySelector('label')) };
      }
      container = container.parentElement;
    }
    return { textarea: ta, label: '' };
  });
}

/**
 * Read a job posting's details from the current Upwork job page or proposal apply page: title, description, skills, budget, experience level, project length, and Connects required. On the apply page also returns the proposal form fields with their labels, required flags, and current values
 * @pattern https://www.upwork.com/jobs/*
 * @pattern https://www.upwork.com/nx/proposals/job/*
 */
export function get_job() {
  assertNotChallenge();
  const url = location.href;
  const isProposal = url.includes('/proposals/job/');

  // The apply page has the job title in an <h3>; the job posting page has it in
  // <title> as "Job Title - Category" and as the first non-nav heading.
  let title = '';
  if (isProposal) {
    const h3s = [...document.querySelectorAll('h3')];
    title = h3s.find((h) => {
      const t = h.textContent.trim();
      return t && !t.startsWith('Average') && !t.startsWith('Top profile');
    })?.textContent.trim() || '';
  } else {
    // Job posting page: title is in document.title before " - "
    title = document.title.split(' - ')[0].trim();
  }

  // On the apply page, the description is in [id^="air3-truncation-"]; on the job
  // posting page it's in [data-test="Description"]. The air3-truncation elements on
  // the job posting page are client reviews, not the description.
  let description = '';
  if (isProposal) {
    description = document.querySelector('[id^="air3-truncation-"]')?.textContent.trim() || '';
  } else {
    description = document.querySelector('[data-test="Description"]')?.textContent.trim() || '';
  }

  // Skills: on the apply page they're in a <section> with an <h4> heading; on the
  // job posting page they're in a <section> with an <h5> heading, as air3-line-clamp divs.
  const sections = [...document.querySelectorAll('section')];
  const skillsSection = sections.find(
    (s) => s.querySelector('h4, h5')?.textContent?.includes('Skill'),
  );
  const skills = skillsSection
    ? [...skillsSection.querySelectorAll('li, div.is-clamped, div.air3-line-clamp, [data-test="skill"]')]
        .map((el) => textOf(el))
        .filter(Boolean)
    : [];

  // Budget, experience level, and project length.
  // On the apply page they're in <li><strong>…</strong><small>…</small> lists.
  // On the job posting page they appear as plain text; extract via innerText.
  const meta = {};
  if (isProposal) {
    const metaItems = [...document.querySelectorAll('li')].filter(
      (li) => li.querySelector('strong') && li.querySelector('small'),
    );
    for (const li of metaItems) {
      const value = textOf(li.querySelector('strong'));
      const label = textOf(li.querySelector('small'));
      if (label.includes('Experience')) meta.experience_level = value;
      else if (label.includes('Fixed') || label.includes('Hourly')) meta.budget = value;
      else if (label.includes('length') || label.includes('Duration')) meta.project_length = value;
    }
  } else {
    // Job posting page: budget and experience are in the page text.
    const text = document.body.innerText;
    // Hourly: "$12.00-$125.00" with "Hourly" label nearby.
    const hourlyMatch = text.match(/\$(\d+(?:\.\d+)?)\s*[-–]\s*\$(\d+(?:\.\d+)?)/);
    const fixedMatch = text.match(/\$([\d,]+(?:\.\d+)?)\s*(?:Fixed-price|Fixed)/i);
    const isHourly = /\bHourly\b/.test(text);
    if (hourlyMatch && isHourly) meta.budget = `$${hourlyMatch[1]}-$${hourlyMatch[2]}/hr Hourly`;
    else if (fixedMatch) meta.budget = `$${fixedMatch[1]} Fixed-price`;
    const expMatch = text.match(/\b(Entry|Intermediate|Expert)\b/);
    if (expMatch) meta.experience_level = expMatch[1];
    const lengthMatch = text.match(/(\d+\s*(?:to\s*\d+)?\s*(?:months?|weeks?|days?|hours?))/i);
    if (lengthMatch) meta.project_length = lengthMatch[1];
  }

  // Connects required is shown in the proposal settings section (apply page only).
  const connectsText = document.body.innerText.match(/requires\s+(\d+)\s+Connects/);
  const connects_required = connectsText ? Number(connectsText[1]) : null;

  // Posted date.
  const postedMatch = document.body.innerText.match(/Posted\s+(.{1,30})/);
  const posted = postedMatch ? postedMatch[1].trim().split('\n')[0] : '';

  // View job posting link (apply page has a link back to the job).
  const viewJobLink = document.querySelector('a[href*="/jobs/~"]');
  const job_url = viewJobLink?.href || url;

  const result = {
    title,
    description,
    skills,
    posted,
    job_url,
    ...meta,
    ...(connects_required && { connects_required }),
  };

  if (isProposal) {
    // Describe the proposal form: bid, milestone mode, and questionnaire fields.
    const bidInput = document.querySelector('#charged-amount-id');
    const earnedInput = document.querySelector('#earned-amount-id');
    const milestoneRadios = [...document.querySelectorAll('input[name="milestoneMode"]')];

    result.proposal = {
      bid: bidInput?.value || '',
      estimated_earnings: earnedInput?.value || '',
      payment_mode: milestoneRadios.find((r) => r.checked)?.value || '',
      payment_options: milestoneRadios.map((r) => r.value),
      questions: textareaLabels().map(({ label }) => ({ label, filled: false })),
    };
  }

  return result;
}

/**
 * Fill in the proposal form on the current Upwork apply page: cover letter, bid amount, payment mode, and questionnaire answers matched by label keyword. Stops before sending; the form stays open for the user to review and click "Send". Returns every field with its label and current value
 * @pattern https://www.upwork.com/nx/proposals/job/*
 * @param {{ cover_letter?: string, bid?: string, payment_mode?: string, answers?: object }} options
 * @param {string} [options.cover_letter] - Cover letter text for the Cover Letter field
 * @param {string} [options.bid] - Bid amount, e.g. "$1,000.00"
 * @param {string} [options.payment_mode] - "milestone" or "default" (by project)
 * @param {object} [options.answers] - Map of question text (case-insensitive substring) to answer text, e.g. { "chrome extension": "https://...", "SP-API": "I have..." }
 */
export async function draft_proposal({ cover_letter, bid, payment_mode, answers = {} } = {}) {
  assertNotChallenge();
  // Wait for the form to render.
  const textareas = await waitFor(() => {
    const found = document.querySelectorAll('textarea.air3-textarea');
    return found.length ? found : null;
  }, 10000);
  if (!textareas) throw new Error('No proposal form found on this page; make sure you are on the apply page');

  const filled = [];
  const skipped = [];

  // Cover letter — the first textarea, identified by the "Cover Letter" label nearby.
  if (cover_letter != null) {
    const labels = textareaLabels();
    const coverTa = labels.find(({ label }) => label.toLowerCase().includes('cover letter'))?.textarea || textareas[0];
    if (coverTa) {
      setValue(coverTa, cover_letter);
      filled.push('cover_letter');
    } else {
      skipped.push('cover_letter: no textarea found');
    }
  }

  // Bid amount.
  if (bid != null) {
    const bidInput = document.querySelector('#charged-amount-id');
    if (bidInput) {
      setValue(bidInput, bid);
      filled.push('bid');
    } else {
      skipped.push('bid: no bid input found');
    }
  }

  // Payment mode (milestone vs project).
  if (payment_mode != null) {
    const radio = document.querySelector(`input[name="milestoneMode"][value="${payment_mode}"]`);
    if (radio) {
      radio.click();
      filled.push('payment_mode');
    } else {
      skipped.push(`payment_mode: no radio with value "${payment_mode}"; use "milestone" or "default"`);
    }
  }

  // Questionnaire answers — match by label keyword.
  for (const [key, value] of Object.entries(answers)) {
    const ta = findTextareaByLabel(key);
    if (ta) {
      setValue(ta, String(value));
      filled.push(key);
    } else {
      skipped.push(`${key}: no matching question found`);
    }
  }

  // Re-read all fields to report current state.
  const labels = textareaLabels();
  const fields = labels.map(({ textarea, label }) => ({
    label,
    value: textarea.value,
    length: textarea.value.length,
    valid: textarea.checkValidity(),
  }));

  const bidInput = document.querySelector('#charged-amount-id');
  const earnedInput = document.querySelector('#earned-amount-id');
  const milestoneRadios = [...document.querySelectorAll('input[name="milestoneMode"]')];

  return {
    status: 'ready_to_send',
    filled,
    ...(skipped.length && { skipped }),
    bid: bidInput?.value || '',
    estimated_earnings: earnedInput?.value || '',
    payment_mode: milestoneRadios.find((r) => r.checked)?.value || '',
    missing_required: fields.filter((f) => !f.valid).map((f) => f.label),
    fields,
  };
}
