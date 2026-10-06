# browser4agent toolsets

Community page tools for [Browser for AI Agent](https://github.com/mantou132/browser4agent) — think userscripts, but for AI agents.

A toolset gives agents (Claude Code, Codex, Cursor, …) site-specific tools that run inside your real, logged-in browser tab. Instead of screenshotting and clicking through a page, the agent calls `get_transcript` on YouTube or `get_thread` on Hacker News and gets clean, structured data back.

Every toolset here is reviewed in a public pull request before it reaches the market.

## Toolsets

| Toolset | Tools | Sites |
| --- | --- | --- |
| [Hacker News Tools](toolsets/hackernews.js) | `list_stories`, `get_thread` | news.ycombinator.com |
| [YouTube Tools](toolsets/youtube.js) | `get_transcript` | youtube.com |
| [Google Docs Tools](toolsets/google-docs.js) | `get_doc_markdown` | docs.google.com/document |
| [Google Sheets Tools](toolsets/google-sheets.js) | `read_sheet` | docs.google.com/spreadsheets |

## Use

Install the extension, open its **Toolset Market** page and subscribe. Tools show up for your agent automatically on matching pages.

Merged changes are published to the market automatically; subscribers get them with **Update** on the Toolset Market page.

## Contribute

Add or edit a file in [`toolsets/`](toolsets) and open a pull request. CI validates it with the same parser the market uses.

A toolset is one JavaScript (or TypeScript) file. Each exported function is a tool; JSDoc describes it:

```js
/**
 * @module Example Tools
 * @description What these tools are for
 * @icon 🧪
 * @author Your Name <you@example.com>
 */

/**
 * Read the page headline. Agents see this description, so say what the tool returns.
 * @pattern https://example.com/*
 * @param {{ uppercase?: boolean }} options
 * @param {boolean} [options.uppercase=false] - Return the headline in upper case
 */
export function get_headline({ uppercase = false } = {}) {
  const text = document.querySelector('h1').textContent;
  return { headline: uppercase ? text.toUpperCase() : text };
}
```

- `@pattern` is a [URLPattern](https://developer.mozilla.org/docs/Web/API/URL_Pattern_API); the tool is offered only on matching pages.
- Tools run in the page's main world. Top-level helper functions you reference are bundled into each tool.
- The `@module` name is the toolset's identity in the market. Don't rename an existing toolset.

### Guidelines

Reviews check for these:

- **Write descriptions in English** and say what the tool returns; agents choose tools by their descriptions.
- **Stop before irreversible actions.** A tool may fill in a form or a draft, but sending, submitting, purchasing and deleting are left to the user.
- **Talk only to the site itself.** No requests to third-party servers, no tracking, no obfuscated or minified code.
- **Return compact, structured data** with sensible limits; agents pay for every token.
- **Fail with a clear error** when the page isn't in the expected state.

### Test locally

In the extension's options page, choose **Subscribe Toolset** and paste the raw URL of your file (for example `https://raw.githubusercontent.com/<you>/browser4agent-toolsets/<branch>/toolsets/<file>.js`). Then ask your agent to use the tool on a matching page.

To run the same validation as CI:

```bash
node scripts/publish.mjs
```

## License

MIT
