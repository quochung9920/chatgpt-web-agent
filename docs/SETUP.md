# Setup guide

## 1. Control server

Requirements: Node.js 20+.

```bash
cd server
cp .env.example .env
npm install
npm start
```

Set strong random values for `API_KEY` and `AGENT_TOKEN`.

For production, place the server behind HTTPS and a reverse proxy. The Chrome extension should then use a `wss://` URL.

## 2. WordPress plugin

Copy the `wordpress-plugin` directory into:

```text
wp-content/plugins/chatgpt-web-agent
```

Activate **ChatGPT Web Agent** in WordPress. Go to:

```text
Settings -> ChatGPT Web Agent
```

Copy the generated token into the control server `.env` as `WORDPRESS_TOKEN`. Set `WORDPRESS_BASE_URL` to the site origin, for example:

```text
https://example.com
```

Restart the control server after changing environment values.

## 3. Chrome extension

Open:

```text
chrome://extensions
```

Enable **Developer mode**, click **Load unpacked**, and select the `chrome-extension` folder.

Open the extension options and configure:

- Server URL: `ws://localhost:8787` for local development, or the production `wss://` URL.
- Agent ID: must match `AGENT_ID` in the server environment.
- Agent token: must match `AGENT_TOKEN`.

The extension reconnects automatically.

## 4. Verify locally

Health check:

```bash
curl http://localhost:8787/health
```

Authenticated browser status:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:8787/v1/browser/status
```

WordPress site information:

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

## 5. ChatGPT integration

`openapi.yaml` is the API contract for the server. Before importing/using it with a ChatGPT plugin or integration surface:

1. Replace `https://agent.example.com` with the public HTTPS URL of your deployed server.
2. Configure Bearer authentication using the server `API_KEY`.
3. Do not expose `AGENT_TOKEN` or `WORDPRESS_TOKEN` to the ChatGPT-facing layer.

The intended trust flow is:

```text
ChatGPT -> API_KEY -> control server
control server -> AGENT_TOKEN -> Chrome extension
control server -> WORDPRESS_TOKEN -> WordPress plugin
```

## Production notes

- Use HTTPS/WSS only.
- Restrict CORS to the integration origins you actually need.
- Put the server behind rate limiting.
- Rotate credentials periodically.
- Keep page creation defaulting to draft when practical.
- Add human approval for destructive actions before implementing delete/plugin/theme operations.
- Avoid arbitrary JavaScript execution from remote commands.

## Current action examples

### Read the active page

```json
{
  "action": "page.read",
  "args": { "maxLength": 50000 }
}
```

### Click an element

```json
{
  "action": "page.click",
  "args": { "selector": "button[type=submit]" }
}
```

### Type into an element

```json
{
  "action": "page.type",
  "args": {
    "selector": "input[name=s]",
    "text": "hello",
    "clear": true
  }
}
```

### Navigate

```json
{
  "action": "tab.navigate",
  "args": { "url": "https://example.com" }
}
```

## Recommended next milestone

The MVP deliberately keeps the tool surface small. The next milestone should add:

- per-domain browser allowlists and confirmation rules;
- WordPress media upload/search;
- Gutenberg block-aware helpers instead of only raw `post_content`;
- WordPress menu/global-style operations;
- DOM snapshots optimized for LLM use;
- console error and network request inspection;
- screenshot/visual-diff workflow;
- append-only audit log for every remote action.
