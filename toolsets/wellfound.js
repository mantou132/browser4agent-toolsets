/**
 * @module Wellfound Tools
 * @description Search Wellfound (AngelList Talent) job listings, read job details including remote and time-zone requirements, track applications, and fill in application forms
 * @icon 🚀
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

// Pages are server-rendered by Next.js; the Apollo cache in __NEXT_DATA__ has the structured records. Fetching
// keeps it fresh, since the copy in the current document goes stale after client-side navigation.
async function fetchApolloState(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const data = doc.getElementById('__NEXT_DATA__');
  if (!data) throw new Error(`No page data in ${url}; are you logged in to Wellfound?`);
  return JSON.parse(data.textContent).props.pageProps.apolloState?.data || {};
}

function deref(state, value) {
  return value?.__ref ? state[value.__ref] : value;
}

function postedDate(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '';
}

function remoteInfo(state, job) {
  return {
    remote: Boolean(job.remote),
    // An empty list on a remote job is shown on the site as "Hires remotely: Everywhere".
    hires_remotely_in: job.remote ? (job.acceptedRemoteLocationNames?.length ? job.acceptedRemoteLocationNames : ['Everywhere']) : [],
  };
}

// Only job pages carry the time-zone details; listing results leave them out.
function scheduleInfo(state, job) {
  const config = deref(state, job.remoteConfig) || {};
  const zones = (config.hiringTimeZones || []).map((zone) => deref(state, zone)?.name).filter(Boolean);
  const hoursZone = deref(state, config.collaborationTimeZone)?.name;
  return {
    preferred_time_zones: zones,
    collaboration_hours: config.collaborationStartAt
      ? `${config.collaborationStartAt}-${config.collaborationEndAt} ${hoursZone || ''}`.trim()
      : '',
  };
}

// Job pages 404 without the slug.
function jobUrl(id, slug) {
  return `https://wellfound.com/jobs/${id}-${slug}`;
}

function textOf(el) {
  return (el?.innerText || '').replace(/\s+/g, ' ').trim();
}

/**
 * List jobs on the current role or location listing page (e.g. /role/r/frontend-engineer for remote roles), loading following pages as needed. Each job includes company, compensation, where it hires remotely, and the start of its description; use get_job for time zones and collaboration hours
 * @pattern https://wellfound.com/role/*
 * @param {{ limit?: number, description_chars?: number }} options
 * @param {number} [options.limit=40] - Maximum number of jobs to return; more pages are loaded automatically
 * @param {number} [options.description_chars=300] - Characters of each description to include; 0 omits it
 */
export async function list_jobs({ limit = 40, description_chars = 300 } = {}) {
  const url = new URL(location.href);
  const jobs = [];
  let total = 0;
  for (let page = Number(url.searchParams.get('page')) || 1; jobs.length < limit; page++) {
    url.searchParams.set('page', String(page));
    const state = await fetchApolloState(url.href);
    const talent = deref(state, state.ROOT_QUERY?.talent) || {};
    const results = Object.entries(talent).find(([key]) => key.startsWith('seoLandingPageJobSearchResults'))?.[1];
    if (!results) throw new Error('No job results on this page; open a Wellfound role listing such as /role/r/frontend-engineer');
    total = results.totalJobCount;

    for (const startup of results.startups.map((ref) => deref(state, ref))) {
      for (const job of (startup.highlightedJobListings || []).map((ref) => deref(state, ref))) {
        if (jobs.length >= limit) break;
        jobs.push({
          id: job.id,
          title: job.title,
          company: startup.name,
          url: jobUrl(job.id, job.slug),
          compensation: job.compensation || '',
          job_type: job.jobType || '',
          years_experience_min: job.yearsExperienceMin ?? null,
          posted: postedDate(job.liveStartAt),
          locations: job.locationNames || [],
          ...remoteInfo(state, job),
          ...(description_chars > 0 && { description: (job.description || '').slice(0, description_chars) }),
        });
      }
    }
    if (page >= results.pageCount) break;
  }
  return { total_jobs: total, count: jobs.length, jobs };
}

/**
 * Read a job's full details: description, compensation, experience, visa and relocation, remote policy with preferred time zones and collaboration hours, skills and the hiring contact. Defaults to the job on the current page; pass url to read another job without navigating
 * @pattern https://wellfound.com/*
 * @param {{ url?: string }} options
 * @param {string} [options.url] - Job URL or path including its slug, such as /jobs/4589345-frontend-engineer
 */
export async function get_job({ url } = {}) {
  const target = new URL(url || location.href, location.origin);
  const id = target.pathname.match(/^\/jobs\/(\d+)/)?.[1];
  if (!id) throw new Error('Not a job URL; expected https://wellfound.com/jobs/<id>-<slug>');

  const state = await fetchApolloState(target.pathname);
  const job = state[`JobListing:${id}`];
  if (!job) throw new Error(`Job ${id} was not found; it may have been closed`);
  const startup = deref(state, job.startup) || {};
  const contactRole = deref(state, job.recruitingContact);
  const contact = deref(state, contactRole?.user);

  return {
    id,
    title: job.title,
    company: startup.name || '',
    company_url: startup.slug ? `https://wellfound.com/company/${startup.slug}` : '',
    url: jobUrl(id, job.slug),
    live: job.live !== false,
    posted: postedDate(job.liveStartAt),
    compensation: job.compensation || '',
    job_type: job.jobType || '',
    years_experience_min: job.yearsExperienceMin ?? null,
    visa_sponsorship: Boolean(job.visaSponsorship),
    relocation_allowed: Boolean(job.allowRelocation),
    locations: job.locationNames || [],
    ...remoteInfo(state, job),
    ...scheduleInfo(state, job),
    skills: (job.skills || []).map((tag) => deref(state, tag)?.displayName).filter(Boolean),
    hiring_contact: contact
      ? { name: contact.name, title: contactRole.title || '', profile_url: `https://wellfound.com${contact.pathName}` }
      : null,
    description: job.description || '',
  };
}

/**
 * List your job applications with their status (Pending, Status Updates Offsite, etc.) from the Applied page
 * @pattern https://wellfound.com/jobs/applications*
 */
export async function list_applications() {
  const links = await waitFor(() => {
    const found = [...document.querySelectorAll('a[href^="/jobs/applications/"]')].filter((a) =>
      /^\/jobs\/applications\/\d+-\d+/.test(a.getAttribute('href')),
    );
    return found.length ? found : null;
  });
  if (!links) return { count: 0, applications: [] };

  const applications = links.map((a) => {
    const [company = '', title = '', status = '', when = ''] = a.innerText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const ids = a.getAttribute('href').match(/(\d+)-(\d+)/);
    return { company, title, status, when, job_id: ids[2], application_id: ids[1], application_url: a.href };
  });
  return { count: applications.length, applications };
}

// Each question is a <label> whose first child holds the question text and whose remaining children hold the
// input, textarea or radio group. Radio options carry their own <label for>. The built-in note ("What interests
// you…" or "Cover Letter") has no <label>; its heading is the previous sibling of its wrapper.
function fieldLabel(field) {
  const question = field.closest('label');
  if (!question) return textOf(field.parentElement?.previousElementSibling);
  const head = question.firstElementChild;
  return head && !head.contains(field) ? textOf(head) : textOf(question);
}

function questionText(field) {
  return fieldLabel(field).replace(/\s*\*$/, '');
}

function optionText(radio) {
  return textOf(document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)) || radio.value;
}

function setValue(field, value) {
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function formFields(form) {
  return [...form.querySelectorAll('input, textarea, select')].filter((f) => f.type !== 'hidden' && f.type !== 'file');
}

function describeForm(form) {
  const groups = new Map();
  for (const field of formFields(form)) {
    const key = field.type === 'radio' ? `radio:${field.name}` : field;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(field);
  }
  return [...groups.values()].map((fields) => {
    const [field] = fields;
    const label = fieldLabel(field);
    const radio = field.type === 'radio';
    const checked = fields.find((f) => f.checked);
    return {
      label: questionText(field),
      type: radio ? 'radio' : field.tagName === 'TEXTAREA' ? 'textarea' : field.type,
      required: /\*$/.test(label) || field.required,
      value: radio ? (checked ? optionText(checked) : '') : field.value,
      ...(radio && { options: fields.map(optionText) }),
    };
  });
}

/**
 * Open the application form for the job on the current page and fill it in: the note goes into the first free-text question ("What interests you…" or "Cover Letter"), and answers fill other questions by label. Stops before sending; the form stays open for the user to review and click "Send application". Returns every field with its label, required flag and current value. The tab must be visible (active)
 * @pattern https://wellfound.com/jobs/*
 * @param {{ note?: string, answers?: object }} options
 * @param {string} [options.note] - Text for the first free-text question
 * @param {object} [options.answers] - Map of question text (case-insensitive substring) to value; for yes/no and other choice questions the value is the option text, e.g. { "LinkedIn": "https://...", "contact me about future": "Yes" }
 */
export async function draft_application({ note, answers = {} } = {}) {
  const findForm = () =>
    [...document.querySelectorAll('button')].find((b) => /Send application/.test(b.innerText))?.closest('form');
  let form = findForm();
  if (!form) {
    if (document.hidden) {
      throw new Error('Wellfound loads the application form slowly in background tabs; make this tab active, then retry');
    }
    const apply = [...document.querySelectorAll('button, a')].find(
      (el) => /^Apply( now)?$/.test(el.innerText.trim()) && el.offsetParent,
    );
    if (!apply) throw new Error('No Apply button on this page; the job may be closed, external, or already applied to');
    apply.click();
    // The modal mounts first and loads its questions a moment later.
    form = await waitFor(() => {
      const found = findForm();
      return found && formFields(found).length ? found : null;
    }, 15000);
    await sleep(500);
  }
  if (!form) throw new Error('The application form did not open');

  const filled = [];
  const skipped = [];
  if (note != null) {
    const first = form.querySelector('textarea');
    if (first) {
      setValue(first, note);
      filled.push(questionText(first));
    } else {
      skipped.push('note: this form has no free-text question');
    }
  }
  for (const [key, value] of Object.entries(answers)) {
    const needle = key.toLowerCase();
    const matches = formFields(form).filter((f) => fieldLabel(f).toLowerCase().includes(needle));
    if (!matches.length) throw new Error(`No question matches "${key}"`);
    if (matches[0].type === 'radio') {
      const option = matches.find((r) => optionText(r).toLowerCase() === String(value).toLowerCase());
      if (!option) throw new Error(`"${key}" has no option "${value}"; options: ${matches.map(optionText).join(', ')}`);
      option.click();
    } else {
      setValue(matches[0], String(value));
    }
    filled.push(questionText(matches[0]));
  }

  const fields = describeForm(form);
  return {
    status: 'ready_to_send',
    filled,
    ...(skipped.length && { skipped }),
    missing_required: fields.filter((f) => f.required && !f.value).map((f) => f.label),
    fields,
  };
}
