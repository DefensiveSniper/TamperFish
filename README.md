# Goofish Chat Aggregation Service (`TamperFish`)

[English](README.md) | [简体中文](README.zh-CN.md)

This repository is a local aggregation, manual takeover, and auto-reply toolkit built around the Goofish PC Web messaging flow and the Qianniu "pending shipment" order flow. The repository currently wires together 6 end-to-end pipelines:

1. A Tampermonkey script collects sessions, messages, and session-side metadata from `goofish.com/im`
2. `sync.js` periodically reads browser-local cache through Chrome CDP and backfills Goofish messages
3. A Qianniu Tampermonkey script collects pending-shipment orders from `myseller.taobao.com/home.htm/batch-consign`
4. A local API + SQLite aggregates sessions, messages, and orders, and serves the management console on port `3210`
5. Outgoing messages enter the `outgoing_messages` queue and are sent back through the browser script
6. Qianniu orders are automatically linked to Goofish sessions by `buyer_user_id + product_id` and shown both in the console and at the top of each chat

## Core Capabilities

- Session aggregation: dual-path collection via the foreground Tampermonkey script and background CDP sync, with all messages persisted into SQLite
- Qianniu order capture: parses `batch-consign` order cards and stores order ID, buyer, product, amount, quantity, and shipping info
- Order matching: links Qianniu orders to Goofish sessions precisely by `buyer_user_id + product_id`
- Local console: inspect sessions, messages, and the outgoing queue at `http://127.0.0.1:3210`
- Order console: an order drawer lets you inspect script runtime state, sync the current page immediately, or trigger a manual full scan
- Manual replies: the input box on the right side of the UI pushes messages into the `pending` queue and lets the browser send them
- AI toggle: the top bar can globally enable or disable AI auto-replies for manual takeover scenarios
- Patrol toggle: the top bar can remotely enable or disable background Tampermonkey patrol without affecting precise sending or on-demand backfill
- Startup initialization: after the project starts, it initializes session history sync with a limit of `30` sessions by default
- Unread monitoring: after initialization, continuous patrol is disabled by default and new messages are synced incrementally based on unread badges in the left-side session list
- Precise sending: the browser script actively claims outgoing jobs and prioritizes locating the target conversation by `session_id` before sending
- Auto-reply: the worker consumes `outbox.new_messages`, generates replies, and writes them into `outgoing_messages`
- Project Chrome: `npm start` automatically launches a project-dedicated Chrome instance with remote debugging on port `18800`
- Chrome proxy: supports configuring a dedicated proxy for the project Chrome instance through a local config file or environment variables
- Log persistence: startup flow, Chrome, `sync.js`, the API, and the built-in worker all write logs to files

## Directory Layout

```text
goofishAggregation/
├── qianniu_capture/
│   └── qianniu_batch_consign.js # Tampermonkey script: capture Qianniu pending-shipment orders
├── xianyu_capture/
│   └── xianyu_monitor.js        # Tampermonkey script (current panel version 4.0)
├── server/
│   ├── package.json             # Node dependencies and scripts
│   ├── start.js                 # Unified launcher: Chrome + API + sync.js
│   ├── index.js                 # Express API + local UI
│   ├── db.js                    # SQLite data layer
│   ├── sync.js                  # CDP sync daemon
│   ├── auto_reply_worker.js     # Auto-reply worker
│   ├── ai.js                    # LLM integration wrapper
│   ├── public/                  # Static assets for the 3210 console
│   ├── data.db                  # [generated] SQLite database
│   ├── server.log               # [generated] launcher / Chrome / sync combined log
│   └── server3210.log           # [generated] API and built-in worker log
├── integrations/
│   └── qianniu/                 # Reserved for future integrations
└── agent_logs/                  # Collaboration logs
```

## Requirements

- Node.js 20+ (the current machine uses Node 22)
- Desktop Google Chrome
- Tampermonkey extension
- A logged-in Goofish Web session at `https://www.goofish.com/im`

## Install Dependencies

Using the lockfile is recommended:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm ci
```

If you intentionally want to re-resolve dependencies, you can also run:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm install
```

## How to Start

### 1. Start the full stack with one command

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm start
```

By default this does all of the following:

- Uses the project Chrome directory `.chrome-xianyu-profile` inside the repository
- Cleans transient cache and stale lock files from the project Chrome directory before startup, while keeping `Sessions` so the previous browser session and cookies can be restored
- Starts Chrome in session-restore mode if previous session data exists in the profile, without reinjecting the initial URLs
- Automatically opens `https://www.goofish.com/im` and `https://myseller.taobao.com/home.htm/batch-consign` if this is the first launch or the current profile has no recoverable session
- Adds `--allow-insecure-localhost` to the project Chrome instance so scripts can connect to the locally self-signed `wss://localhost`
- Opens the Chrome remote debugging port `18800`
- Starts the API service at `127.0.0.1:3210`
- Starts the browser-script WSS endpoint at `wss://localhost:3211/ws/browser`
- Starts `sync.js`
- Starts the built-in auto-reply worker
- Monitors port `18800` and automatically relaunches the project Chrome instance if it is closed

If you want to troubleshoot whether the proxy is causing Chrome startup failures, you can temporarily start it like this:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
CHROME_PROXY_DISABLED=1 npm start
```

If you explicitly want to preserve the current cache state and skip the pre-start cleanup, you can temporarily disable it:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
CHROME_CLEAR_TRANSIENT_DATA_ON_START=0 npm start
```

### 2. Development mode

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm run dev
```

This starts the API entry with `node --watch`, which is useful when editing backend code.

### 3. Run the worker separately

Use this only for debugging:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm run worker
npm run worker:dry
npm run worker:once
npm run worker:dry:once
```

Notes:

- `npm start` already launches the built-in worker
- Do not run `npm run worker` in parallel with `npm start`, or multiple workers may consume the same `outbox` events concurrently

## Browser-Side Setup

### 1. Install and enable Tampermonkey

Install the Tampermonkey extension in Chrome.

### 2. Import the Tampermonkey scripts

Import and enable:

- [xianyu_capture/xianyu_monitor.js](xianyu_capture/xianyu_monitor.js)
- [qianniu_capture/qianniu_batch_consign.js](qianniu_capture/qianniu_batch_consign.js)

The current Goofish script panel version is `4.0`, and the Qianniu order script version is `1.4`. After each script update, make sure the version text inside Tampermonkey is updated as well.
After importing the Qianniu order script for the first time, allow it to access `trade.taobao.com` so it can fetch the product ID from the `tradeSnap` page.

The control channel between the scripts and the local service no longer relies on high-frequency HTTP polling and now uses a single long-lived connection:

- `wss://localhost:3211/ws/browser`

At startup, the project automatically generates a local development certificate for localhost and configures the project Chrome instance to trust the self-signed localhost certificate.

### 3. Log in to Goofish / Qianniu Web

After completing one login in the project Chrome instance, subsequent launches will try to restore the previous session:

- [goofish.com/im](https://www.goofish.com/im)
- [myseller.taobao.com/home.htm/batch-consign](https://myseller.taobao.com/home.htm/batch-consign)

Notes:

- The Goofish message script runs on `goofish.com/im`
- The Qianniu order script runs on `batch-consign`
- The Qianniu script caches decrypted buyer info by `orderId`; once an order has been decrypted successfully, it will not click "decrypt" again for that order later
- On first launch or when using a brand-new profile, the launcher automatically opens both the Goofish and Qianniu entry pages
- If the current profile already contains the previous session, the launcher restores the original tabs and cookies, so you usually do not need to manually reopen the Qianniu page

By default, the scripts first perform a startup initialization pass: they iterate through the first `30` sessions and try to pull back recent history, then automatically stop continuous patrol.

After initialization:

- The currently open session continues lightweight syncing
- Sessions with unread badges in the left-side list are opened on demand and synced incrementally
- Full traversal is reserved for manually enabled patrol mode and precise-send fallback only

## 3210 Console Overview

Open:

- [http://127.0.0.1:3210](http://127.0.0.1:3210)

The current UI supports:

- Incremental refresh for the left-side session list to reduce polling flicker
- Active refresh for the message panel on the right, so new messages in the current session appear without re-clicking the session on the left
- Order drawer in the top bar: inspect Qianniu pending-shipment orders, matching status, and script runtime state, and trigger current-page sync or a manual full scan
- AI toggle in the top bar: globally enable or disable auto-replies
- Patrol toggle in the top bar: remotely control background Tampermonkey patrol and show script sync status
- Manual reply input on the right: messages enter the `pending` queue first and are then sent by the browser
- Outgoing queue panel: distinguishes `AI` and `manual` message sources
- Order summary at the top of the chat: precisely matched orders are shown above the corresponding conversation

## Environment Variables and Local Configuration

### AI / API

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `AUTO_REPLY_ENABLED`
- `AUTO_REPLY_INTERVAL_MS`

Current behavior:

- `AUTO_REPLY_ENABLED=0` initializes the runtime AI toggle as disabled
- The built-in worker still starts, but skips auto-reply generation

### Chrome / Launcher

- `PORT`: local API port, default `3210`
- `BROWSER_WSS_PORT`: browser-script WSS port, default `3211`
- `BROWSER_WSS_PATH`: browser-script WSS path, default `/ws/browser`
- `BROWSER_WSS_CERT_PATH`: optional custom localhost WSS certificate path
- `BROWSER_WSS_KEY_PATH`: optional custom localhost WSS private key path
- `CDP_PORT`: Chrome DevTools remote debugging port, default `18800`
- `SYNC_INTERVAL`: `sync.js` polling interval, default `5000`
- `CHROME_PROFILE_NAME`: profile name shown in logs, default `xianyu`
- `CHROME_PROFILE_DIRECTORY`: profile directory name inside the project Chrome directory, default `Default`
- `CHROME_USER_DATA_DIR`: project Chrome user-data directory, default `.chrome-xianyu-profile` under the repository root
- `GOOFISH_URL`: default Goofish page opened on first launch, default `https://www.goofish.com/im`
- `QIANNIU_URL`: default Qianniu page opened on first launch, default `https://myseller.taobao.com/home.htm/batch-consign`
- `CHROME_MONITOR_INTERVAL_MS`: Chrome watchdog interval, default `3000`
- `CHROME_CLEAR_TRANSIENT_DATA_ON_START`: whether to clear transient cache from the project Chrome directory before startup; enabled by default while preserving `Sessions` for session restore, set to `0` to disable
- `CHROME_START_TIMEOUT_MS`: timeout for waiting for Chrome to expose the CDP port, default `15000`

### Chrome Proxy

- `CHROME_PROXY_SERVER`
- `CHROME_PROXY_USERNAME`
- `CHROME_PROXY_PASSWORD`
- `CHROME_PROXY_BYPASS_LIST`
- `CHROME_PROXY_CONFIG_PATH`

By default the launcher first tries to read the local file:

- [server/.chrome-proxy.local.json](server/.chrome-proxy.local.json)

Example:

```json
{
  "proxyServer": "http://127.0.0.1:7890",
  "proxyUsername": "",
  "proxyPassword": "",
  "proxyBypassList": "localhost;127.0.0.1;::1"
}
```

Notes:

- The proxy only affects the project Chrome instance launched by this repository and does not affect your normal Chrome instances
- If the proxy requires a username and password, the launcher automatically generates a local authentication extension in `server/.chrome-proxy-extension/`
- Both the local file and that generated directory are ignored by `.gitignore`

### Notes on custom Chrome directories

If you customize `CHROME_USER_DATA_DIR`:

- For a brand-new empty directory, it is best to also set `CHROME_PROFILE_DIRECTORY` explicitly
- If you pass only `CHROME_USER_DATA_DIR` without `CHROME_PROFILE_DIRECTORY`, the current launcher tries to parse the profile from `Local State`; startup fails when that file does not exist in an empty directory

## Log Files

Default log locations:

- [server/server.log](server/server.log)
  - Launcher logs
  - Chrome output
  - `sync.js` output
- [server/server3210.log](server/server3210.log)
  - API service logs
  - Built-in worker logs

## Database and Queues

Core tables:

- `sessions`: primary session table
- `messages`: chat messages
- `outbox`: internal event bus (`new_session` / `new_messages`)
- `outgoing_messages`: outgoing message queue (`pending / sending / sent / failed`)
- `app_settings`: runtime settings such as the AI toggle

The current sending pipeline is:

1. New messages enter `outbox`
2. The worker generates a reply and writes it to `outgoing_messages.pending`
3. The browser sender loop atomically claims one outgoing job
4. It first tries to locate the target session precisely by `session_id`; if that fails, it performs a limited fallback traversal and backfill
5. The browser automatically fills the input and sends the message
6. Right after sending, the current session is resynced so the new message is written back to the local cache promptly
7. The API writes the final status back as `sent` or `failed`

## FAQ

### 1. `3210` shows data, but the message panel on the right does not update

Refresh the browser page once to ensure you have the latest frontend script. The current version already supports active refresh for the current session.

### 2. The database contains "empty sessions" with only a buyer name and no messages

The backend now blocks empty snapshots at the `ingest()` layer, so this kind of empty shell is no longer written into `sessions`. If old records still exist, clean up those historical dirty rows manually from the database.

### 3. What if the project Chrome instance gets closed

If it was started by `npm start`, the watchdog monitors port `18800` and automatically relaunches the project Chrome instance after it is closed.

### 4. How do I switch the proxy

Edit:

- [server/.chrome-proxy.local.json](server/.chrome-proxy.local.json)

Then restart:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
npm start
```

If you want to temporarily bypass the proxy for troubleshooting, use:

```bash
cd /Users/snoopy/Desktop/goofishAggregation/server
CHROME_PROXY_DISABLED=1 npm start
```

## Current Known Limitations

- The launcher currently supports only one project Chrome instance, so it cannot safely aggregate multiple seller accounts into the same `3210` console yet
- `server/ai.js` still keeps a default API key fallback, which is not recommended for production use
- `outbox` events are currently processed and marked afterward, so running multiple workers at the same time may cause duplicate consumption
- Precise sending still depends on `sessionInfo.sessionId` being readable inside the Goofish page; if the page structure changes, it falls back to limited traversal and backfill

## Next Development Plan

The items below are not implemented yet and are kept as future work.

### 0. Solution document (continuously evolving)

The ongoing evolution plan for multi-account / multi-store aggregation, multi-worker scheduling, and precise sending is maintained in:

- [docs/multi-shop-aggregation-evolution.md](docs/multi-shop-aggregation-evolution.md)

Notes:

- The README keeps only the entry point, scope, and status instead of repeating the full design
- If new decisions, assumptions, or TODO changes are added later, update that document first and sync the README summary only when needed

### 1. Multiple Chrome instances and multiple proxies

Goals:

- Support launching multiple project Chrome instances at the same time
- Allow each instance to configure its own `userDataDir`, `profileDirectory`, `cdpPort`, and proxy independently
- Let the same `3210` console display aggregated data from multiple instances

Planned refactor scope:

- `server/start.js`
  - Refactor from the current single-instance mode to an instance-list-driven model
  - Maintain a separate watchdog, Chrome process, and proxy config for each instance
- `server/sync.js`
  - Refactor to "one sync process per instance"
  - Include `instanceId` when reporting data
- `xianyu_capture/xianyu_monitor.js`
  - Include instance identifiers in session snapshots, outgoing-message matching, and send-status writeback
- `server/db.js`
  - Add `instance_id` / `account_id` dimensions to `sessions`, `messages`, `outbox`, and `outgoing_messages`
  - Avoid `chat_key` collisions across different Chrome instances or seller accounts
- `server/index.js` and `server/public/`
  - Show the source instance for each session in the UI
  - Add filtering or switching by instance

Current status:

- The codebase only has a startup-layer foundation that could be extended to multi-instance support in the future
- If you force multiple Chrome instances to write into the same database today, you risk session mix-ups, outgoing-message cross-send issues, and UI confusion
