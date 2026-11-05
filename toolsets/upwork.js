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
  const url = location.href;
  const isProposal = url.includes('/proposals/job/');

  // Job title is an h3 inside the job details section.
  const h3s = [...document.querySelectorAll('h3')];
  const title = h3s.find((h) => {
    const t = h.textContent.trim();
    return t && !t.startsWith('Average') && !t.startsWith('Top profile');
  })?.textContent.trim() || '';

  // Job description is inside an element with id starting "air3-truncation-".
  const descEl = document.querySelector('[id^="air3-truncation-"]');
  const description = descEl?.textContent.trim() || '';

  // Skills are in a section after the job details.
  const sections = [...document.querySelectorAll('section')];
  const skillsSection = sections.find((s) => s.querySelector('h4')?.textContent?.includes('Skills'));
  const skills = skillsSection
    ? [...skillsSection.querySelectorAll('li')].map((li) => textOf(li)).filter(Boolean)
    : [];

  // Budget, experience level, and project length are in <li><strong>…</strong><small>…</small> lists.
  const metaItems = [...document.querySelectorAll('li')].filter((li) => li.querySelector('strong') && li.querySelector('small'));
  const meta = {};
  for (const li of metaItems) {
    const value = textOf(li.querySelector('strong'));
    const label = textOf(li.querySelector('small'));
    if (label.includes('Experience')) meta.experience_level = value;
    else if (label.includes('Fixed') || label.includes('Hourly')) meta.budget = value;
    else if (label.includes('length') || label.includes('Duration')) meta.project_length = value;
  }

  // Connects required is shown in the proposal settings section.
  const connectsText = document.body.innerText.match(/requires\s+(\d+)\s+Connects/);
  const connects_required = connectsText ? Number(connectsText[1]) : null;

  // Posted date.
  const postedMatch = document.body.innerText.match(/Posted\s+([\w\s,]+)/);
  const posted = postedMatch ? postedMatch[1].trim() : '';

  // View job posting link.
  const viewJobLink = document.querySelector('a[href*="/jobs/~"]');
  const job_url = viewJobLink?.href || '';

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
