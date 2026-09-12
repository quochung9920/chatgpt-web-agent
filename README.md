# ChatGPT Web Agent

A secure bridge that lets a ChatGPT integration control a WordPress site and a user-approved Chrome session through explicit, whitelisted actions.

## What this repository contains

- `server/` — HTTPS/WebSocket control server. It authenticates ChatGPT-facing API calls and relays browser commands to the Chrome extension.
- `chrome-extension/` — Manifest V3 extension that connects Chrome to the control server and executes a small allowlist of browser actions.
- `wordpress-plugin/` — WordPress plugin exposing authenticated REST endpoints for site info and Gutenberg page create/read/update operations.
- `openapi.yaml` — OpenAPI schema for the control server, ready to be used as the API contract for a ChatGPT plugin/custom integration.
- `docs/SETUP.md` — local/deployment setup instructions.

## Architecture

```text
ChatGPT chat / integration
          |
          | HTTPS + Bearer API key
          v
+---------------------------+
| Control server            |
| - REST API                |
| - WebSocket broker        |
| - action allowlist        |
+-------------+-------------+
              |
        +-----+------+
        |            |
        v            v
Chrome extension   WordPress plugin
        |            |
        v            v
Current Chrome     Gutenberg / Pages
session            WordPress REST
```

## MVP capabilities

### Browser

- Get tabs and active tab
- Navigate/reload
- Read DOM/text from the active page
- Click a CSS selector
- Type into a CSS selector
- Scroll
- Capture the visible tab as a screenshot

The extension intentionally does **not** expose arbitrary JavaScript execution in this first version.

### WordPress

- Read basic site information
- List pages
- Read a page including raw Gutenberg content
- Create a page
- Update an existing page

## Quick start

1. Install the WordPress plugin from `wordpress-plugin/` and copy the generated access token from **Settings → ChatGPT Web Agent**.
2. Deploy/run the server in `server/` and configure its `.env` values.
3. Load `chrome-extension/` as an unpacked extension and configure the server URL, agent ID, and agent token in its Options page.
4. Confirm `GET /health`, `GET /v1/browser/status`, and `GET /v1/wordpress/site` work.
5. Connect the API described by `openapi.yaml` to the ChatGPT integration/plugin surface you intend to use.

See [`docs/SETUP.md`](docs/SETUP.md) for the complete setup.

## Security model

There are separate credentials for separate trust boundaries:

- `API_KEY`: authorizes ChatGPT/integration calls to the control server.
- `AGENT_TOKEN`: authorizes the local Chrome extension to the WebSocket broker.
- `WORDPRESS_TOKEN`: authorizes the control server to the WordPress REST plugin.

Do not commit real credentials. Use HTTPS/WSS in production and rotate any token that is exposed.

## Status

This is the initial MVP foundation. The next logical additions are request approval policies, per-site/action scopes, media upload, Gutenberg block helpers, visual comparison, console/network inspection, and audit history.
