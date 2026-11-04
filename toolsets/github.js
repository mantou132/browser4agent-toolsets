/**
 * @module GitHub Tools
 * @description Read GitHub issues, pull requests with their changed files, issue lists, Actions runs with failed step logs, commits and files, and draft comments for the user to post
 * @icon 🐙
 * @author Browser for AI Agent
 */

// Pages embed the data their React views render; reading it avoids the rendered markup.
async function embeddedPayload(path) {
  const doc = path === location.pathname + location.search ? document : await fetchDoc(path);
  const script = doc.querySelector('script[data-target="react-app.embeddedData"]');
  if (!script) throw new Error(`No page data in ${path}; it may not exist, or you may need to log in to GitHub`);
  return JSON.parse(script.textContent).payload || {};
}

async function fetchDoc(path) {
  const res = await fetch(path, { credentials: 'include' });
  if (res.status === 404) throw new Error(`${path} was not found, or it is private and you are not logged in`);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

// owner/repo plus the rest of the path, from a URL or the current page.
function route(url) {
  const target = new URL(url || location.href, location.origin);
  if (target.origin !== 'https://github.com') throw new Error('Not a github.com URL');
  const [owner, repo, kind, ...rest] = target.pathname.split('/').filter(Boolean);
  return { owner, repo, kind, rest, base: `/${owner}/${repo}`, search: target.search };
}

const login = (actor) => actor?.login || '';
const day = (time) => (time ? new Date(time).toISOString().replace('.000Z', 'Z') : '');

// Rendered comment HTML to plain text, keeping links, code blocks and list structure readable.
function htmlText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  for (const node of clone.querySelectorAll('.js-clipboard-copy, clipboard-copy, .anchor, svg')) node.remove();
  for (const img of clone.querySelectorAll('img')) img.replaceWith(img.getAttribute('alt') ? `[${img.getAttribute('alt')}]` : '');
  for (const a of clone.querySelectorAll('a[href]')) {
    const label = a.textContent.trim();
    if (label && label !== a.href && !label.startsWith('@') && !label.startsWith('#')) a.append(` (${a.href})`);
  }
  for (const pre of clone.querySelectorAll('pre')) pre.replaceWith(`\n\`\`\`\n${pre.textContent.trim()}\n\`\`\`\n`);
  for (const code of clone.querySelectorAll('code')) code.replaceWith(`\`${code.textContent}\``);
  for (const h of clone.querySelectorAll('h1, h2, h3, h4, h5, h6')) h.prepend(`${'#'.repeat(h.tagName[1])} `);
  for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
  for (const row of clone.querySelectorAll('tr')) {
    row.replaceWith(`\n${[...row.cells].map((cell) => cell.textContent.replace(/\s+/g, ' ').trim()).join(' | ')}`);
  }
  for (const block of clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, table, li')) {
    if (block.tagName === 'P' && block.parentElement.tagName === 'LI' && !block.previousElementSibling) continue;
    block.prepend(block.tagName === 'LI' ? '\n- ' : '\n\n');
  }
  return clone.textContent
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n\s*\n- /g, '\n- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reactions(groups) {
  const names = { THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'laugh', HOORAY: 'hooray', CONFUSED: 'confused', HEART: 'heart', ROCKET: 'rocket', EYES: 'eyes' };
  const counts = Object.fromEntries(
    (groups || [])
      .map((g) => [names[g.content] || g.content, g.reactors?.totalCount ?? g.users?.totalCount ?? 0])
      .filter(([, count]) => count > 0),
  );
  return Object.keys(counts).length ? { reactions: counts } : {};
}

/**
 * Read an issue: title, state, author, labels, assignees, the body in Markdown and its comments in order with authors, times and reactions. Defaults to the issue on the current page; pass url to read another without navigating. Long threads load only their first and last comments; omitted_comments says how many are in between
 * @pattern https://github.com/*
 * @param {{ url?: string, limit?: number }} options
 * @param {string} [options.url] - Issue URL, such as https://github.com/owner/repo/issues/123
 * @param {number} [options.limit=100] - Maximum number of comments to return
 */
export async function get_issue({ url, limit = 100 } = {}) {
  const { base, kind, rest } = route(url);
  if (kind !== 'issues' || !/^\d+$/.test(rest[0] || '')) throw new Error('Not an issue URL; expected https://github.com/<owner>/<repo>/issues/<number>');
  const payload = await embeddedPayload(`${base}/issues/${rest[0]}`);
  const issue = payload.issueViewerRoute?.data?.repository?.issue;
  if (!issue) throw new Error('No issue data on this page; it may be a pull request (use get_pull_request)');

  const front = issue.timelineItems || { edges: [] };
  const back = issue.backTimelineItems || { edges: [] };
  const nodes = [...front.edges, ...back.edges].map((e) => e.node).filter(Boolean);
  const seen = new Set();
  const comments = nodes
    .filter((n) => n.__typename === 'IssueComment' && !seen.has(n.id) && seen.add(n.id))
    .map((c) => ({
      author: login(c.author),
      ...(c.authorAssociation && c.authorAssociation !== 'NONE' && { association: c.authorAssociation.toLowerCase() }),
      created_at: c.createdAt,
      body: c.isMinimized ? `[hidden: ${c.minimizedReason || 'minimized'}]` : (c.body || '').trim(),
      ...reactions(c.reactionGroups),
    }));
  const total = issue.totalCommentsCount ?? comments.length;
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state?.toLowerCase(),
    ...(issue.stateReason && { state_reason: issue.stateReason.toLowerCase() }),
    author: login(issue.author),
    created_at: issue.createdAt,
    labels: (issue.labels?.edges || []).map((e) => e.node?.name).filter(Boolean),
    assignees: (issue.assignedActors?.nodes || issue.assignedActors?.edges?.map((e) => e.node) || []).map(login).filter(Boolean),
    ...(issue.milestone?.title && { milestone: issue.milestone.title }),
    body: (issue.body || '').trim(),
    ...reactions(issue.reactionGroups),
    total_comments: total,
    ...(total > comments.length && { omitted_comments: total - comments.length }),
    comments: comments.slice(0, limit),
  };
}

/**
 * Read a pull request: title, state (open, closed, merged), author, base and head branches, commit count, merge details, the conversation (description, comments and review summaries with authors and times) and the changed files with lines added and deleted. Defaults to the pull request on the current page; pass url to read another
 * @pattern https://github.com/*
 * @param {{ url?: string, limit?: number, files?: boolean }} options
 * @param {string} [options.url] - Pull request URL, such as https://github.com/owner/repo/pull/123
 * @param {number} [options.limit=100] - Maximum number of conversation entries to return
 * @param {boolean} [options.files=true] - Include the list of changed files
 */
export async function get_pull_request({ url, limit = 100, files = true } = {}) {
  const { base, kind, rest } = route(url);
  if (kind !== 'pull' || !/^\d+$/.test(rest[0] || '')) throw new Error('Not a pull request URL; expected https://github.com/<owner>/<repo>/pull/<number>');
  const path = `${base}/pull/${rest[0]}`;
  // The conversation tab is server-rendered; its embedded data holds the pull request's metadata.
  const doc = location.pathname === path ? document : await fetchDoc(path);
  const script = doc.querySelector('script[data-target="react-app.embeddedData"]');
  const pr = script ? JSON.parse(script.textContent).payload?.pullRequestsLayoutRoute?.pullRequest : null;
  if (!pr) throw new Error('No pull request data on this page');

  // The description and comments carry a comment body; reviews say who approved or requested changes.
  const author = (el) => el.querySelector('.author, strong a[href^="/"]')?.textContent.trim() || '';
  const time = (el) => el.querySelector('relative-time')?.getAttribute('datetime') || '';
  const comment = (el) => ({ author: author(el), created_at: time(el), body: htmlText(el.querySelector('.comment-body')) });
  // The description sits above the timeline; timeline items hold comments and reviews.
  const opening = [...doc.querySelectorAll('.timeline-comment-group')].find((c) => !c.closest('.js-timeline-item'));
  const conversation = opening ? [comment(opening)] : [];
  for (const item of doc.querySelectorAll('.js-timeline-item')) {
    const review = item.textContent.replace(/\s+/g, ' ').match(/ (approved these changes|requested changes|reviewed)\b/)?.[1];
    if (review) {
      const body = htmlText(item.querySelector('.comment-body'));
      conversation.push({ author: author(item), created_at: time(item), review: review.replace(' these changes', ''), ...(body && { body }) });
    } else {
      for (const c of item.querySelectorAll('.timeline-comment-group')) if (c.querySelector('.comment-body')) conversation.push(comment(c));
    }
  }

  let changed;
  if (files) {
    const changes = (await embeddedPayload(`${path}/files`)).pullRequestsChangesRoute || {};
    changed = (changes.diffSummaries || []).map((f) => ({
      path: f.path,
      change: f.changeType?.toLowerCase(),
      additions: f.linesAdded,
      deletions: f.linesDeleted,
    }));
  }
  return {
    number: pr.number,
    title: pr.title,
    url: `https://github.com${path}`,
    state: pr.mergedTime ? 'merged' : pr.state?.toLowerCase(),
    author: login(pr.author),
    base: pr.baseBranch,
    head: pr.headRepositoryOwnerLogin && pr.headRepositoryOwnerLogin !== route(url).owner ? `${pr.headRepositoryOwnerLogin}:${pr.headBranch}` : pr.headBranch,
    commits: pr.commitsCount,
    created_at: day(pr.createdTime),
    ...(pr.mergedTime && { merged_at: day(pr.mergedTime), merged_by: pr.mergedBy?.login || pr.mergedBy || '' }),
    ...(pr.closedTime && !pr.mergedTime && { closed_at: day(pr.closedTime) }),
    conversation: conversation.slice(0, limit),
    ...(changed && { files: changed }),
  };
}

/**
 * List a repository's issues matching a search, the way the Issues tab filters them (e.g. "is:open label:bug", "is:closed author:octocat"). Each issue has its number, title, state, author, labels, comment count and times. Defaults to the repository and filter of the current page
 * @pattern https://github.com/*
 * @param {{ repo?: string, query?: string, limit?: number }} options
 * @param {string} [options.repo] - owner/repo; defaults to the current page's repository
 * @param {string} [options.query] - Issue search filter; defaults to the current page's filter, or "is:issue state:open"
 * @param {number} [options.limit=25] - Maximum number of issues to return; more pages are loaded automatically, up to 100
 */
export async function list_issues({ repo, query, limit = 25 } = {}) {
  const here = route();
  const base = repo ? `/${repo.replace(/^\/|\/$/g, '')}` : here.base;
  if (!base || base.split('/').length !== 3 || base.includes('undefined')) throw new Error('Pass repo as owner/repo, or open a repository page');
  const q = query ?? (here.kind === 'issues' && !here.rest.length ? new URLSearchParams(here.search).get('q') : null) ?? 'is:issue state:open';

  const issues = [];
  let total = 0;
  for (let page = 1; issues.length < Math.min(limit, 100); page++) {
    const data = (await embeddedPayload(`${base}/issues?q=${encodeURIComponent(q)}&page=${page}`)).issuesIndexContentRoute || {};
    total = data.pageInfo?.totalCount ?? data.results?.length ?? 0;
    for (const result of data.results || []) {
      const issue = result.issue || result;
      if (issues.length >= limit) break;
      issues.push({
        number: issue.number,
        title: issue.title,
        url: issue.permalink,
        state: issue.state?.replace('REPO_ISSUE_STATE_', '').toLowerCase(),
        author: login(issue.author),
        labels: (issue.labels || []).map((l) => l.name).filter(Boolean),
        comments: issue.commentCount ?? 0,
        created_at: day(issue.createdAt),
        updated_at: day(issue.updatedAt),
      });
    }
    if (!data.results?.length || !(page < data.pageInfo?.totalPages)) break;
  }
  return { repo: base.slice(1), query: q, total_count: total, count: issues.length, issues };
}

function stripLog(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\u001b\[[\d;]*m/g, ''))
    .filter((line) => !/^##\[(group|endgroup)\]/.test(line) || /\S/.test(line.replace(/^##\[\w+\]/, '')));
}

/**
 * Read a GitHub Actions workflow run: its title, each job's status and conclusion, each step's conclusion, and for failed steps the last lines of their logs. Defaults to the run (or job) on the current page
 * @pattern https://github.com/*
 * @param {{ url?: string, log_lines?: number }} options
 * @param {string} [options.url] - Run URL, such as https://github.com/owner/repo/actions/runs/123, or one of its job URLs
 * @param {number} [options.log_lines=80] - Lines to keep from the end of each failed step's log; 0 skips logs
 */
export async function get_workflow_run({ url, log_lines = 80 } = {}) {
  const { base, kind, rest } = route(url);
  const runId = kind === 'actions' && rest[0] === 'runs' ? rest[1] : null;
  if (!runId) throw new Error('Not a workflow run URL; expected https://github.com/<owner>/<repo>/actions/runs/<id>');
  const runPath = `${base}/actions/runs/${runId}`;
  const doc = await fetchDoc(runPath);
  const partial = [...doc.querySelectorAll('react-partial')].find((p) => p.getAttribute('partial-name') === 'actions-run-jobs-list');
  const props = partial ? JSON.parse(partial.querySelector('script').textContent).props || {} : {};
  const groupsUrl = props.jobGroupsFetchUrl || `${runPath}/job_groups_batch?attempt=1`;
  const groups = await (await fetch(groupsUrl, { credentials: 'include', headers: { Accept: 'application/json' } })).json();
  const jobs = (groups.jobGroups || []).flatMap((g) => [...(g.nonNested?.jobs || []), ...(g.nested?.jobs || []), ...(g.jobs || [])]);

  const result = [];
  for (const job of jobs) {
    const entry = { name: job.displayName, status: job.status, conclusion: job.conclusion, url: `https://github.com${job.href}` };
    if (job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped') {
      // The job page links its steps endpoint, which reports each step and where its log is.
      const jobDoc = await fetch(job.href, { credentials: 'include' }).then((r) => r.text());
      const stepsPath = jobDoc.match(/\/actions\/runs\/\d+\/jobs\/\d+\/steps(?=["'])/)?.[0];
      const steps = stepsPath
        ? await (await fetch(`${base}${stepsPath}`, { credentials: 'include', headers: { Accept: 'application/json' } })).json()
        : [];
      entry.steps = [];
      for (const step of Array.isArray(steps) ? steps : steps.steps || []) {
        const item = { number: step.number, name: step.name, conclusion: step.conclusion };
        if (log_lines > 0 && step.conclusion === 'failure' && step.log_url) {
          // The log URL redirects to GitHub's own log storage.
          const lines = stripLog(await (await fetch(step.log_url)).text());
          item.log = lines.slice(-log_lines).join('\n');
          if (lines.length > log_lines) item.log_truncated = lines.length - log_lines;
        }
        entry.steps.push(item);
      }
    }
    result.push(entry);
  }
  const conclusions = jobs.map((j) => j.conclusion);
  return {
    title: doc.querySelector('h1, .PageHeader-title')?.textContent.replace(/\s+/g, ' ').trim() || doc.title,
    url: `https://github.com${runPath}`,
    status: jobs.every((j) => j.status === 'completed') ? 'completed' : 'in_progress',
    conclusion: conclusions.includes('failure') ? 'failure' : conclusions.includes('cancelled') ? 'cancelled' : conclusions.every((c) => c === 'success' || c === 'skipped') && jobs.length ? 'success' : null,
    jobs: result,
  };
}

/**
 * Read a commit: message, authors, dates, parents, the files it changed with lines added and deleted, and each file's patch up to patch_chars. Defaults to the commit on the current page
 * @pattern https://github.com/*
 * @param {{ url?: string, patch_chars?: number }} options
 * @param {string} [options.url] - Commit URL, such as https://github.com/owner/repo/commit/<sha>
 * @param {number} [options.patch_chars=3000] - Characters of patch to include per file; 0 omits patches
 */
export async function get_commit({ url, patch_chars = 3000 } = {}) {
  const { base, kind, rest } = route(url);
  if (kind !== 'commit' || !rest[0]) throw new Error('Not a commit URL; expected https://github.com/<owner>/<repo>/commit/<sha>');
  const data = (await embeddedPayload(`${base}/commit/${rest[0]}`)).commitRoute || {};
  const commit = data.commit;
  if (!commit) throw new Error('No commit data on this page');
  const body = commit.bodyMessageHtml ? htmlText(new DOMParser().parseFromString(`<div>${commit.bodyMessageHtml}</div>`, 'text/html').body) : '';
  return {
    sha: commit.oid,
    url: `https://github.com${base}/commit/${commit.oid}`,
    message: [commit.shortMessage, body].filter(Boolean).join('\n\n'),
    authors: (commit.authors || []).map((a) => a.login || a.displayName).filter(Boolean),
    authored_at: commit.authoredDate,
    committed_at: commit.committedDate,
    parents: commit.parents || [],
    stats: { files: data.headerInfo?.filesChanged, additions: data.headerInfo?.additions, deletions: data.headerInfo?.deletions },
    files: (data.diffEntryData || []).map((file) => {
      const patch = (file.diffLines || [])
        .map((line) => ({ ADDITION: '+', DELETION: '-', HUNK: '' }[line.type] ?? ' ') + line.text)
        .join('\n');
      return {
        path: file.path,
        status: file.status?.toLowerCase(),
        additions: file.linesAdded,
        deletions: file.linesDeleted,
        ...(file.oldTreeEntry?.path && file.oldTreeEntry.path !== file.path && { previous_path: file.oldTreeEntry.path }),
        ...(patch_chars > 0 && patch && { patch: patch.slice(0, patch_chars), ...(patch.length > patch_chars && { patch_truncated: true }) }),
        ...(file.isTooBig && { too_big: true }),
      };
    }),
  };
}

/**
 * Read a file from a repository at a branch, tag or commit, optionally a line range. Pass a file URL (https://github.com/owner/repo/blob/<ref>/<path>, with #L10-L40 for a range), or repo, path and ref
 * @pattern https://github.com/*
 * @param {{ url?: string, repo?: string, path?: string, ref?: string, max_chars?: number }} options
 * @param {string} [options.url] - File URL; defaults to the file on the current page
 * @param {string} [options.repo] - owner/repo, with path
 * @param {string} [options.path] - File path within the repository, with repo
 * @param {string} [options.ref] - Branch, tag or commit SHA; defaults to the default branch
 * @param {number} [options.max_chars=20000] - Maximum characters to return
 */
export async function read_file({ url, repo, path, ref = 'HEAD', max_chars = 20000 } = {}) {
  let rawPath;
  let range;
  if (repo && path) {
    rawPath = `/${repo}/raw/${ref}/${path.replace(/^\//, '')}`;
  } else {
    const target = new URL(url || location.href, location.origin);
    const { base, kind, rest } = route(target.href);
    if (kind !== 'blob' || rest.length < 2) throw new Error('Not a file URL; expected https://github.com/<owner>/<repo>/blob/<ref>/<path>');
    rawPath = `${base}/raw/${rest.join('/')}`;
    range = target.hash.match(/^#L(\d+)(?:-L(\d+))?/);
  }
  // The raw URL redirects to raw.githubusercontent.com, GitHub's own file host; the default
  // credentials mode sends cookies to github.com and lets the cross-origin redirect through.
  const res = await fetch(rawPath);
  if (!res.ok) throw new Error(`Failed to read ${rawPath}: ${res.status}`);
  let text = await res.text();
  const lines = text.split('\n');
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    text = lines.slice(start - 1, end).join('\n');
  }
  return {
    path: decodeURIComponent(rawPath.split('/raw/')[1]),
    lines: range ? `${range[1]}-${range[2] || range[1]}` : lines.length,
    content: text.slice(0, max_chars),
    ...(text.length > max_chars && { truncated: true }),
  };
}

function setNativeValue(field, value) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Type a comment into the comment box at the bottom of the issue or pull request on the current page. Stops before posting; the user reviews it and clicks Comment. Returns the drafted text
 * @pattern https://github.com/*
 * @param {{ text: string }} options
 * @param {string} options.text - Comment in GitHub-flavored Markdown
 */
export function draft_comment({ text } = {}) {
  if (!text) throw new Error('text is required');
  const { kind } = route();
  if (kind !== 'issues' && kind !== 'pull') throw new Error('Open an issue or pull request page first');
  const boxes = [...document.querySelectorAll('textarea#new_comment_field, textarea[name="comment[body]"], textarea[placeholder*="Markdown"], textarea[aria-label*="comment" i]')]
    .filter((box) => !box.closest('[hidden], .is-hidden, details:not([open])'));
  const box = boxes[boxes.length - 1];
  if (!box) throw new Error('No comment box on this page; log in, or the conversation may be locked');
  box.focus();
  setNativeValue(box, text);
  box.scrollIntoView({ block: 'center' });
  return { status: 'ready_to_post', text: box.value };
}
