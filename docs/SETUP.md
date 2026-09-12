# Setup guide

This guide configures ChatGPT Web Agent `0.2.0` for the intended workflow:

```text
Figma / HTML reference
      ↓
ChatGPT reasoning
      ↓
WordPress build/update
      ↓
Chrome visual QA
      ↓
compare + repair loop
```

## 1. Control server

Requirements: Node.js 20+.

```bash
cd server
cp .env.example .env
npm install
npm start
```

Configure `.env`:

```text
PORT=8787
API_KEY=long-random-chatgpt-facing-key
AGENT_ID=desktop-chrome
AGENT_TOKEN=long-random-browser-agent-key
WORDPRESS_BASE_URL=https://example.com
WORDPRESS_TOKEN=token-from-wordpress-plugin
REQUEST_TIMEOUT_MS=20000
DATA_DIR=./data
REFERENCE_ALLOWED_HOSTS=
```

`DATA_DIR` stores persistent implementation targets. It is ignored by Git.

`REFERENCE_ALLOWED_HOSTS` is optional. When set, it is a comma-separated allowlist used by visual comparison when downloading reference images. Wildcards are supported only as a leading `*.` rule, for example:

```text
REFERENCE_ALLOWED_HOSTS=figma.com,*.figma.com,cdn.example.com
```

For production, place the server behind HTTPS and use WSS for the Chrome extension.

## 2. WordPress plugin

Copy the `wordpress-plugin` directory into:

```text
wp-content/plugins/chatgpt-web-agent
```

Activate **ChatGPT Web Agent** and open:

```text
Settings -> ChatGPT Web Agent
```

Copy the generated token into the server `.env` as `WORDPRESS_TOKEN`.

Version 0.2 provides:

- page list/read/create/update;
- parsed Gutenberg block tree;
- image search/import;
- registered block information;
- a reversible agent-owned CSS layer.

The agent CSS is stored separately from the active theme and injected as:

```html
<style id="chatgpt-web-agent-css">...</style>
```

This is the preferred place for iterative visual fixes until a design has stabilized.

## 3. Chrome extension

Open:

```text
chrome://extensions
```

Enable **Developer mode**, choose **Load unpacked**, and select `chrome-extension/`.

Open the extension Options page and configure:

- Server URL: `ws://localhost:8787` locally, or the production `wss://` endpoint.
- Agent ID: must equal server `AGENT_ID`.
- Agent token: must equal server `AGENT_TOKEN`.

Version 0.2 uses Chrome's `debugger` permission. This is required for:

- viewport/device emulation;
- full-page and element screenshots;
- console error capture;
- network request/response capture.

The extension still exposes only whitelisted operations. It does not expose arbitrary remote JavaScript execution.

## 4. Verify the three layers

Health:

```bash
curl http://localhost:8787/health
```

Browser connection:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:8787/v1/browser/status
```

WordPress connection:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:8787/v1/wordpress/site
```

Active Chrome tab:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"tab.active","args":{}}' \
  http://localhost:8787/v1/browser/action
```

## 5. Connect ChatGPT

`openapi.yaml` is the ChatGPT-facing contract.

Before using it with a ChatGPT plugin/custom integration:

1. Deploy the control server to a public HTTPS endpoint.
2. Replace `https://agent.example.com` in `openapi.yaml` with that endpoint.
3. Configure Bearer authentication with `API_KEY`.
4. Keep `AGENT_TOKEN` and `WORDPRESS_TOKEN` private to the control infrastructure.

Trust flow:

```text
ChatGPT -> API_KEY -> control server
control server -> AGENT_TOKEN -> Chrome extension
control server -> WORDPRESS_TOKEN -> WordPress plugin
```

A normal ChatGPT conversation can use the workflow once that plugin/integration is connected. ChatGPT by itself does not automatically gain access to this API merely because the server is running.

## 6. Create an implementation target

Example Figma target:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"Homepage hero",
    "source":{
      "type":"figma",
      "url":"https://www.figma.com/design/FILE/Project?node-id=4-1049",
      "nodeId":"4:1049"
    },
    "destination":{
      "type":"wordpress",
      "pageId":42,
      "url":"https://example.com/"
    },
    "viewports":[
      {"label":"desktop","width":1440,"height":900},
      {"label":"mobile","width":390,"height":844,"mobile":true}
    ]
  }' \
  http://localhost:8787/v1/targets
```

For a Figma workflow, ChatGPT should first read the exact Figma node through the Figma connector and use the returned screenshot/assets/tokens as reference context. The web agent does not scrape Figma itself.

## 7. Build in WordPress

Useful endpoints:

```text
GET   /v1/wordpress/site
GET   /v1/wordpress/pages
GET   /v1/wordpress/pages/{id}
GET   /v1/wordpress/pages/{id}/blocks
POST  /v1/wordpress/pages
PATCH /v1/wordpress/pages/{id}
GET   /v1/wordpress/media
POST  /v1/wordpress/media/import
GET   /v1/wordpress/styles/agent-css
PUT   /v1/wordpress/styles/agent-css
```

When importing a Figma/exported asset:

```json
{
  "url": "https://public-https-asset.example/image.png",
  "filename": "hero-dog.png",
  "title": "Homepage hero dog",
  "alt": "Dog receiving veterinary care"
}
```

## 8. Capture one QA observation

A higher-level capture call sets the viewport, navigates, waits for the page, reads DOM context, inspects requested selectors, captures browser errors, and takes a screenshot:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId":"TARGET_UUID",
    "url":"https://example.com/",
    "viewport":{"width":1440,"height":900},
    "selectors":[".hero",".hero h1",".hero img"],
    "errorsOnly":true,
    "fullPage":false
  }' \
  http://localhost:8787/v1/verification/capture
```

The observation includes:

- viewport and document dimensions;
- page text/HTML snapshot;
- element bounding boxes;
- computed CSS for inspected selectors;
- console errors/warnings;
- HTTP responses with error status when requested;
- screenshot data URL.

## 9. Compare against a reference

You can pass either a reference image URL or image data URL.

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId":"TARGET_UUID",
    "referenceUrl":"https://cdn.example.com/reference.png",
    "passThreshold":0.92,
    "capture":{
      "url":"https://example.com/",
      "viewport":{"width":1440,"height":900},
      "selectors":[".hero",".hero h1"]
    }
  }' \
  http://localhost:8787/v1/verification/compare
```

The server returns:

```text
similarity
pixelSimilarity
dimensionSimilarity
differentPixelRatio
reference dimensions
candidate dimensions
```

If a target was supplied, the target becomes:

```text
complete   when similarity >= passThreshold
repairing  when similarity < passThreshold
```

Visual similarity is a QA signal, not a substitute for semantic inspection. Text wrapping, responsive behavior, DOM structure, accessibility, console errors, and reused design-system components should also be considered by ChatGPT.

## 10. Recommended ChatGPT loop

For each section or page:

```text
1. Read exact Figma node / HTML reference
2. Create or update TARGET
3. Read existing WordPress page + blocks + registered blocks
4. Reuse existing block/component patterns
5. Import required assets
6. Write Gutenberg markup
7. Write/update agent CSS
8. Capture desktop QA
9. Inspect mismatched selectors + errors
10. Repair
11. Capture again
12. Repeat for tablet/mobile
13. Mark target complete only after all required viewports pass
```

## Direct browser actions

Examples:

Inspect an element:

```json
{
  "action": "page.inspect",
  "args": { "selector": ".hero h1" }
}
```

Set mobile viewport:

```json
{
  "action": "page.viewport.set",
  "args": {
    "width": 390,
    "height": 844,
    "deviceScaleFactor": 1,
    "mobile": true
  }
}
```

Capture only browser errors:

```json
{
  "action": "debug.logs",
  "args": { "errorsOnly": true }
}
```

Element screenshot:

```json
{
  "action": "page.elementScreenshot",
  "args": { "selector": ".hero" }
}
```

## Production notes

- Use HTTPS/WSS only.
- Put the server behind rate limiting.
- Restrict network exposure and CORS for your deployment.
- Set `REFERENCE_ALLOWED_HOSTS` when visual references come from known CDNs.
- Rotate all three credentials if any one is exposed.
- Keep destructive operations out of the tool surface unless they have explicit approval policies.
- Prefer draft pages for large generated changes until the workflow is trusted.
- Do not add arbitrary JavaScript execution as a generic remote action.
- Consider an append-only audit log before using this on production sites.
