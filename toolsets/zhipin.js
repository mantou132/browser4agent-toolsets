/**
 * @module BOSS Zhipin Tools
 * @description Search BOSS直聘 (zhipin.com) jobs with filters, read job details, list chats with bosses and read their messages, and draft chat replies for the user to send
 * @icon 💼
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

// The site's own JSON API, called with the logged-in session. BOSS rate-limits aggressively and answers bursts
// with a security check, so callers pause between pages.
async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load ${url.pathname}: ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`BOSS直聘 refused ${url.pathname}: ${data.message || data.code}; log in, or pass the security check on the page, then retry`);
  }
  return data.zpData || {};
}

let filterOptions;
async function filterCode(list, value) {
  if (value == null || value === '') return undefined;
  if (/^\d+$/.test(String(value))) return value;
  filterOptions ||= await api('/wapi/zpgeek/pc/all/filter/conditions.json');
  const options = filterOptions[list] || [];
  const option = options.find((o) => o.name === value) || options.find((o) => o.name.includes(value));
  if (!option) throw new Error(`Unknown option "${value}"; choose from ${options.map((o) => o.name).join(', ')}`);
  return option.code;
}

let cities;
async function cityCode(value) {
  if (value == null || value === '') return undefined;
  if (/^\d+$/.test(String(value))) return value;
  if (!cities) {
    const data = await api('/wapi/zpgeek/common/data/city/site.json');
    cities = (data.siteList || []).flatMap((province) => [province, ...(province.subLevelModelList || [])]);
  }
  const name = String(value).replace(/市$/, '');
  const city = cities.find((c) => c.name === name && c.subLevelModelList == null) || cities.find((c) => c.name === name);
  if (!city) throw new Error(`Unknown city "${value}"; use a city name such as 北京 or 长沙, or its code such as 101250100`);
  return city.code;
}

const jobUrl = (encryptJobId) => `https://www.zhipin.com/job_detail/${encryptJobId}.html`;

function compactJob(job) {
  return {
    id: job.encryptJobId,
    title: job.jobName,
    salary: job.salaryDesc,
    url: jobUrl(job.encryptJobId),
    location: [job.cityName, job.areaDistrict, job.businessDistrict].filter(Boolean).join(' '),
    experience: job.jobExperience,
    degree: job.jobDegree,
    skills: job.skills || [],
    company: job.brandName,
    industry: job.brandIndustry,
    company_size: job.brandScaleName,
    ...(job.brandStageName && { funding: job.brandStageName }),
    ...(job.welfareList?.length && { benefits: job.welfareList }),
    boss: [job.bossName, job.bossTitle].filter(Boolean).join(' · '),
    boss_online: Boolean(job.bossOnline),
    ...(job.contact && { contacted: true }),
  };
}

// The search page's component holds the jobs it loaded, with salaries in plain text (the cards draw them in an
// obfuscated font). Searching and paging go through the component, so the site sends its own signed requests.
// Resolves once fn() holds, re-checking whenever the component's list state changes. Polling timers would be
// throttled to about once a minute in a background tab.
function watchUntil(vm, fn, timeout) {
  return new Promise((resolve) => {
    if (fn()) return resolve(true);
    const done = (value) => {
      unwatch();
      clearTimeout(timer);
      resolve(value);
    };
    const unwatch = vm.$watch(() => [vm.loading, vm.moreLoading, vm.hasMore, vm.jobList], () => fn() && done(true));
    const timer = setTimeout(() => done(false), timeout);
  });
}

function jobsPage() {
  const vm = document.querySelector('.page-jobs-main')?.__vue__;
  if (!vm || !Array.isArray(vm.jobList)) throw new Error('No job search on this page; open https://www.zhipin.com/web/geek/jobs');
  return vm;
}

/**
 * Search jobs on the BOSS直聘 job search page (/web/geek/jobs) and read the results, loading more pages as needed. Without arguments it reads the current search. Filters take the names shown on the site (e.g. experience "3-5年", salary "20-50K", degree "本科", company_size "100-499人") or their codes. Each job has its salary, location, experience, degree, skills, company, boss and whether the boss is online; use get_job with its url for the description
 * @pattern https://www.zhipin.com/web/geek/job*
 * @param {{ query?: string, city?: string, experience?: string, salary?: string, degree?: string, company_size?: string, funding?: string, limit?: number }} options
 * @param {string} [options.query] - Keywords, such as 前端 or AI应用开发
 * @param {string} [options.city] - City name such as 长沙, or city code such as 101250100
 * @param {string} [options.experience] - Experience filter, e.g. 1-3年, 3-5年, 应届生
 * @param {string} [options.salary] - Monthly salary filter, e.g. 10-20K, 20-50K
 * @param {string} [options.degree] - Degree filter, e.g. 本科, 硕士
 * @param {string} [options.company_size] - Company size filter, e.g. 100-499人
 * @param {string} [options.funding] - Funding stage filter, e.g. B轮, 已上市
 * @param {number} [options.limit=30] - Maximum number of jobs to return; up to 150
 */
export async function search_jobs({ query, city, experience, salary, degree, company_size, funding, limit = 30 } = {}) {
  const vm = jobsPage();
  const filters = {
    ...(query != null && { query }),
    ...(city != null && { city: String(await cityCode(city)) }),
    ...(experience != null && { experience: [String(await filterCode('experienceList', experience))] }),
    ...(salary != null && { salary: String(await filterCode('salaryList', salary)) }),
    ...(degree != null && { degree: [String(await filterCode('degreeList', degree))] }),
    ...(company_size != null && { scale: [String(await filterCode('scaleList', company_size))] }),
    ...(funding != null && { stage: [String(await filterCode('stageList', funding))] }),
  };
  if (Object.keys(filters).length) {
    const first = vm.jobList[0];
    vm.isSearch = true;
    // Filters left out are cleared, so each call is a fresh search; the city carries over.
    const cleared = { salary: '', experience: [], degree: [], scale: [], stage: [], industry: [], position: [], jobType: '' };
    vm.onFilterChange({ ...vm.formData, ...cleared, ...filters });
    const changed = await watchUntil(vm, () => !vm.loading && vm.jobList[0] !== first, 10000);
    if (!changed && !vm.jobList.length) return { query: vm.formData.query, count: 0, jobs: [] };
  }

  const max = Math.min(limit, 150);
  for (let stalls = 0; vm.jobList.length < max && vm.hasMore && stalls < 3; ) {
    const before = vm.jobList.length;
    // The component loads the next page only when the window is scrolled to the bottom.
    window.scrollTo(0, document.documentElement.scrollHeight);
    await vm.loadMoreHandle();
    await watchUntil(vm, () => !vm.moreLoading && vm.jobList.length > before, 5000);
    stalls = vm.jobList.length > before ? 0 : stalls + 1;
  }
  window.scrollTo(0, 0);

  const jobs = vm.jobList.slice(0, max).map(compactJob);
  return { query: vm.formData.query, city: vm.formData.city, url: location.href, count: jobs.length, has_more: vm.jobList.length > max || Boolean(vm.hasMore), jobs };
}

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Read a job's details from its page: title, salary, city, experience, degree, benefits, full description, address, the boss and their company, and the company's funding, size and industry. Defaults to the job on the current page; pass url to read another job without navigating
 * @pattern https://www.zhipin.com/*
 * @param {{ url?: string }} options
 * @param {string} [options.url] - Job URL, such as https://www.zhipin.com/job_detail/<id>.html from search_jobs
 */
export async function get_job({ url } = {}) {
  const target = new URL(url || location.href, location.origin);
  const id = target.pathname.match(/^\/job_detail\/([\w~-]+)\.html/)?.[1];
  if (!id) throw new Error('Not a job URL; expected https://www.zhipin.com/job_detail/<id>.html');
  let doc = document;
  if (target.pathname !== location.pathname) {
    const res = await fetch(target.pathname, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to load the job page: ${res.status}`);
    // After a burst of page loads BOSS直聘 answers with a JavaScript security check that only a real page load passes.
    if (new URL(res.url).pathname.includes('/security')) {
      throw new Error(`BOSS直聘 wants a security check; open ${jobUrl(id)} in this tab, then call get_job without url`);
    }
    doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  }
  const title = doc.querySelector('.job-banner h1');
  if (!title) throw new Error('No job on this page; it may be closed, or BOSS直聘 wants a security check (open the page and pass it)');

  const company = doc.querySelector('.sider-company');
  const companyFact = (icon) => text(company?.querySelector(`.icon-${icon}`)?.parentElement) || undefined;
  const bossAttr = text(doc.querySelector('.boss-info-attr')).split('·').map((part) => part.trim());
  return {
    id,
    title: text(title),
    salary: text(doc.querySelector('.job-banner .salary')),
    url: jobUrl(id),
    ...(text(doc.querySelector('.job-status')) && { status: text(doc.querySelector('.job-status')) }),
    city: text(doc.querySelector('.text-city')),
    experience: text(doc.querySelector('.text-experiece')),
    degree: text(doc.querySelector('.text-degree')),
    // The page repeats the benefit tags in several places.
    benefits: [...new Set([...doc.querySelectorAll('.job-tags span')].map(text).filter(Boolean))],
    skills: [...doc.querySelectorAll('.job-keyword-list li')].map(text).filter(Boolean),
    description: (doc.querySelector('.job-sec-text')?.innerText || doc.querySelector('.job-sec-text')?.textContent || '').trim(),
    address: text(doc.querySelector('.location-address')),
    boss: {
      name: text(doc.querySelector('.job-boss-info .name')?.firstChild),
      title: bossAttr[1] || '',
      ...(doc.querySelector('.boss-online-tag') && { online: true }),
      ...(text(doc.querySelector('.boss-active-time')) && { active: text(doc.querySelector('.boss-active-time')) }),
    },
    company: {
      name: bossAttr[0] || text(company?.querySelector('.company-info a[title]')),
      funding: companyFact('stage'),
      size: companyFact('scale'),
      industry: companyFact('industry'),
    },
  };
}

async function friends(limit) {
  const all = [];
  for (let page = 1; all.length < limit; page++) {
    if (page > 1) await sleep(500);
    const result = (await api('/wapi/zprelation/friend/getGeekFriendList.json', { page })).result || [];
    all.push(...result);
    if (!result.length) break;
  }
  return all.slice(0, limit);
}

// Local time, as the site shows it.
function localTime(ms) {
  return new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
}

function compactFriend(friend) {
  return {
    uid: friend.uid,
    name: friend.name,
    title: friend.title,
    company: friend.brandName,
    last_message: friend.lastMsg || friend.lastMessageInfo?.showText || '',
    last_time: friend.lastTS ? localTime(friend.lastTS) : friend.lastTime,
    unread: friend.unreadMsgCount || 0,
    ...(friend.isTop && { pinned: true }),
  };
}

/**
 * List the user's chats with bosses on BOSS直聘, most recent first: each boss's name, title, company, last message and time, and unread count. Use get_chat with the uid to read a conversation
 * @pattern https://www.zhipin.com/*
 * @param {{ limit?: number, unread_only?: boolean }} options
 * @param {number} [options.limit=50] - Maximum number of chats to return
 * @param {boolean} [options.unread_only=false] - Only chats with unread messages
 */
export async function list_chats({ limit = 50, unread_only = false } = {}) {
  const list = (await friends(unread_only ? Math.max(limit, 200) : limit)).map(compactFriend);
  const chats = (unread_only ? list.filter((c) => c.unread > 0) : list).slice(0, limit);
  return { count: chats.length, chats };
}

async function findFriend(who) {
  const list = await friends(300);
  const friend = list.find((f) => String(f.uid) === String(who) || f.encryptUid === who) ||
    list.find((f) => f.name === who || `${f.name} ${f.brandName}` === who) ||
    list.find((f) => f.brandName && String(who).includes(f.brandName) && String(who).includes(f.name));
  if (!friend) throw new Error(`No chat with "${who}"; pass a uid or name from list_chats`);
  const sameName = list.filter((f) => f.name === friend.name);
  if (String(friend.uid) !== String(who) && sameName.length > 1) {
    throw new Error(`Several chats are with "${who}"; pass the uid instead: ${sameName.map((f) => `${f.uid} (${f.brandName})`).join(', ')}`);
  }
  return friend;
}

function messageText(message) {
  const body = message.body || {};
  if (body.text) return body.text;
  if (body.dialog?.text) return body.dialog.text;
  if (body.jobDesc) {
    const job = body.jobDesc;
    return `[职位] ${job.title} ${job.salary} · ${job.company} · ${job.city}`;
  }
  if (body.hyperLink) return `[链接] ${body.hyperLink.text || body.hyperLink.title || ''}`.trim();
  if (body.image) return '[图片]';
  if (body.articles?.length) return `[卡片] ${body.articles[0].title || ''}`.trim();
  return (message.pushText || '').replace(/^[^:：]+[:：]/, '');
}

/**
 * Read the conversation with one boss on BOSS直聘: the job it is about and the messages in order, each marked from "me", "boss" or "system". Pass the uid or name from list_chats
 * @pattern https://www.zhipin.com/*
 * @param {{ who: string, limit?: number }} options
 * @param {string} options.who - The boss's uid, or their name (with the company if the name is shared, e.g. "李女士 某某科技")
 * @param {number} [options.limit=50] - Maximum number of most recent messages to return
 */
export async function get_chat({ who, limit = 50 } = {}) {
  const friend = await findFriend(who);
  const messages = [];
  for (let page = 1; messages.length < limit; page++) {
    if (page > 1) await sleep(500);
    const data = await api('/wapi/zpchat/geek/historyMsg', { gid: friend.uid, securityId: friend.securityId, page, c: 20, src: 0 });
    messages.unshift(...(data.messages || []));
    if (!data.hasMore || !data.messages?.length) break;
  }
  const job = messages.find((m) => m.body?.jobDesc)?.body.jobDesc;
  const readable = messages
    .map((m) => ({
      time: localTime(m.time),
      // Type 4 are notices such as "对方已查看了您的附件简历".
      from: m.type === 4 ? 'system' : m.from?.uid === friend.uid ? 'boss' : m.to?.uid === friend.uid ? 'me' : 'system',
      text: messageText(m),
    }))
    .filter((m) => m.text)
    .slice(-limit);
  return {
    boss: compactFriend(friend),
    ...(job && { job: { title: job.title, salary: job.salary, company: job.company, city: job.city, experience: job.experience, degree: job.education } }),
    count: readable.length,
    messages: readable,
  };
}

/**
 * Open the conversation with a boss on the chat page (/web/geek/chat) and type a message into the input box. Stops before sending; the user reviews it and clicks "发送". Opening a chat marks its messages as read
 * @pattern https://www.zhipin.com/web/geek/chat*
 * @param {{ who: string, text: string }} options
 * @param {string} options.who - The boss's uid or name from list_chats
 * @param {string} options.text - Message text, up to 300 characters
 */
export async function draft_message({ who, text } = {}) {
  if (!text) throw new Error('text is required');
  const friend = await findFriend(who);
  const items = () => [...document.querySelectorAll('.friend-content')];
  const match = (item) =>
    item.querySelector('.name-text')?.textContent.trim() === friend.name && item.textContent.includes(friend.brandName || '');
  let item = items().find(match);
  if (!item) {
    // The list renders recent chats only; the search box finds the rest.
    const search = document.querySelector('.boss-search-input');
    if (!search) throw new Error('No chat list on this page; open https://www.zhipin.com/web/geek/chat');
    search.value = friend.name;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    item = await waitFor(() => items().find(match));
  }
  if (!item) throw new Error(`"${friend.name}" is not in the chat list; scroll the list or search for them, then retry`);
  const header = () => document.querySelector('.chat-position-content')?.textContent.trim() || '';
  const previous = header();
  item.click();

  // Loading a conversation clears the input, so wait until its job bar replaces the previous one's.
  await waitFor(() => header() && header() !== previous, 3000);
  const value = text.slice(0, 300);
  let input;
  for (let attempt = 0; attempt < 3; attempt++) {
    input = await waitFor(() => document.querySelector('#chat-input'));
    if (!input) throw new Error('The conversation did not open');
    input.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => !document.querySelector('.btn-send')?.classList.contains('disabled'), 2000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (document.querySelector('#chat-input')?.innerText.trim() === value.trim()) break;
  }
  input = document.querySelector('#chat-input');
  if (input?.innerText.trim() !== value.trim()) throw new Error('The chat cleared the message while loading; retry');
  return {
    status: 'ready_to_send',
    boss: compactFriend(friend),
    job: document.querySelector('.chat-position-content .position-name')?.textContent.trim() || '',
    text: input.innerText,
    ...(text.length > 300 && { truncated: true }),
  };
}
