# ChatGPT Web Agent

A secure bridge for turning a normal ChatGPT conversation into a **design → build → browser QA → repair** workflow for user-owned websites.

The project is intentionally split into independent layers:

- **Figma / HTML / image reference** — ChatGPT reads the design using the appropriate connected capability. Figma is not hard-coded into this repository.
- **Control server** — exposes a small authenticated API, stores implementation targets, brokers Chrome commands, and performs visual comparisons.
- **Chrome extension** — controls and inspects a user-approved Chrome session with whitelisted actions and Chrome DevTools Protocol.
- **WordPress plugin** — exposes page, Gutenberg block, media, and reversible agent-CSS operations.

## Goal

The intended user experience is:

```text
User in ChatGPT
  |
  | "Build this WordPress section from this Figma node and verify it."
  v
ChatGPT reads Figma / HTML reference
  |
  v
Create implementation TARGET
  |
  v
Inspect existing WordPress page + block system
  |
  v
Build/update Gutenberg + import assets + agent CSS
  |
  v
Open real Chrome -> emulate viewport -> screenshot
  |
  v
Inspect DOM + computed styles + console/network errors
  |
  v
Compare reference vs implementation
  |
  +---- mismatch ----> repair WordPress -> verify again
  |
  +---- pass --------> complete
```

## Repository structure

```text
chatgpt-web-agent/
├── openapi.yaml
├── server/
│   ├── .env.example
│   ├── package.json
│   └── src/
│       ├── index.js
│       └── target-store.js
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js
│   ├── options.html
│   └── options.js
├── wordpress-plugin/
│   └── chatgpt-web-agent.php
└── docs/
    └── SETUP.md
```

## Version 0.2 capabilities

### Persistent implementation targets

A target records what ChatGPT is trying to reproduce and where it should be implemented:

```json
{
  "name": "Homepage hero",
  "source": {
    "type": "figma",
    "url": "https://www.figma.com/design/...",
    "nodeId": "4:1049",
    "referenceImageUrl": "https://..."
  },
  "destination": {
    "type": "wordpress",
    "pageId": 42,
    "url": "https://example.com/"
  },
  "viewports": [
    { "label": "desktop", "width": 1440, "height": 900 },
    { "label": "mobile", "width": 390, "height": 844, "mobile": true }
  ]
}
```

Target states support the repair loop:

```text
draft -> building -> verifying -> repairing -> verifying -> complete
```

### Chrome browser + visual QA

Whitelisted browser actions include:

```text
tabs.list
tab.active
tab.navigate
tab.reload
page.wait
page.read
page.inspect
page.elements
page.click
page.type
page.scroll
page.viewport.get
page.viewport.set
page.viewport.clear
page.screenshot
page.elementScreenshot
debug.start
debug.logs
debug.clear
debug.stop
```

`page.inspect` returns element geometry and computed CSS. The extension can emulate desktop/tablet/mobile viewports and can capture console/network diagnostics through Chrome DevTools Protocol.

The server also exposes higher-level operations:

- `POST /v1/verification/capture` — navigate, set viewport, inspect selectors, collect errors, and screenshot in one call.
- `POST /v1/verification/compare` — compare the Chrome screenshot with a reference image and produce similarity metrics. A target automatically becomes `repairing` or `complete` based on the threshold.

### WordPress implementation tools

- Read site/theme/registered block context
- List/read/create/update pages
- Parse raw page content into a Gutenberg block tree
- Search existing image attachments
- Import a public HTTPS image into Media Library
- Read/replace an **agent-owned CSS layer** injected separately from the active theme

The dedicated CSS layer is deliberate: generated fixes can be replaced or cleared without editing theme files.

## Figma workflow

Figma itself is kept outside the web-agent transport. In a ChatGPT conversation with the Figma connector available, ChatGPT should:

1. Read the exact node from the node-specific Figma URL.
2. Use Figma design context as the reference, including its screenshot/assets/tokens.
3. Create a Web Agent target whose `source.type` is `figma` and whose `source.nodeId` identifies that node.
4. Reuse existing WordPress blocks/components where possible.
5. Build the section.
6. Capture Chrome at the matching viewport.
7. Compare and inspect differences.
8. Patch Gutenberg/CSS/assets and repeat until acceptable.

The web agent therefore remains useful when the source is HTML, an image, an existing website, or another design system instead of Figma.

## Quick start

### 1. Control server

```bash
cd server
cp .env.example .env
npm install
npm start
```

### 2. WordPress

Copy `wordpress-plugin/` to:

```text
wp-content/plugins/chatgpt-web-agent/
```

Activate it and open **Settings → ChatGPT Web Agent**. Put its generated token into the server as `WORDPRESS_TOKEN`.

### 3. Chrome

Open `chrome://extensions`, enable Developer Mode, choose **Load unpacked**, and select `chrome-extension/`.

Configure its Options page with the control-server WebSocket URL, `AGENT_ID`, and `AGENT_TOKEN`.

> Version 0.2 requests Chrome's `debugger` permission because viewport emulation, CDP screenshots, console capture, and network capture require it.

### 4. Connect ChatGPT

`openapi.yaml` describes the ChatGPT-facing API. Replace `https://agent.example.com` with the public HTTPS endpoint for your server and configure Bearer authentication using `API_KEY`.

The ChatGPT-facing layer receives only `API_KEY`. Keep `AGENT_TOKEN` and `WORDPRESS_TOKEN` on the server/extension side.

See [`docs/SETUP.md`](docs/SETUP.md) for full setup and example repair-loop calls.

## Security model

```text
ChatGPT integration -- API_KEY --> Control server
Control server -- AGENT_TOKEN --> Chrome extension
Control server -- WORDPRESS_TOKEN --> WordPress plugin
```

Important safeguards in the current implementation:

- Remote browser actions are explicitly allowlisted.
- Arbitrary JavaScript execution is not exposed.
- WordPress media import requires a public HTTPS URL.
- WordPress-generated CSS is isolated from theme files.
- Reference-image host allowlisting can be enabled with `REFERENCE_ALLOWED_HOSTS`.
- Delete/plugin/theme-install actions are intentionally not included yet.

Use HTTPS/WSS in production, rotate exposed credentials, and add human approval before introducing destructive actions.

## Current status

Version `0.2.0` is the first end-to-end foundation for autonomous visual repair. It provides the transport and verification primitives; ChatGPT remains the reasoning/orchestration layer that decides how to translate a Figma/HTML reference into the site's actual block system and how to repair mismatches.
