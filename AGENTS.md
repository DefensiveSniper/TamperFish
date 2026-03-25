# Repository Guidelines

## Project Structure & Module Organization
`frontend/` contains the React 18 + TypeScript + Vite console. Put UI components under `frontend/src/components/`, shared state in `frontend/src/context/`, reusable hooks in `frontend/src/hooks/`, and API typings in `frontend/src/types/`. `server/` contains the local Express + SQLite service, Chrome/CDP sync, and auto-reply worker (`index.js`, `db.js`, `sync.js`, `auto_reply_worker.js`). Browser scripts live in `xianyu_capture/` and `qianniu_capture/`. Collaboration artifacts belong in `tasks/` and `agent_logs/`.

## Build, Test, and Development Commands
Install dependencies per package:

```bash
cd server && npm ci
cd frontend && npm ci
```

Key commands:

- `cd server && npm start`: launch Chrome, API server on `127.0.0.1:3210`, WSS bridge, sync daemon, and built-in worker.
- `cd server && npm run dev`: same stack with watch mode for backend iteration.
- `cd server && npm run worker:once`: run one worker pass for debugging queue behavior.
- `cd frontend && npm run dev`: start the Vite dev server with `/api` proxied to port `3210`.
- `cd frontend && npm run build`: type-check and build the SPA into `server/public/`.

## Coding Style & Naming Conventions
Follow the existing style in each area: TypeScript uses 2-space indentation and `PascalCase` component files such as `Header.tsx`; backend and userscripts use plain JavaScript with semicolons and descriptive camelCase helpers. Add function-level comments for non-trivial functions and keep changes minimal. Do not invent new tooling; this repo currently has no ESLint or Prettier config checked in.

## Testing Guidelines
There is no dedicated automated test suite yet. Before opening a PR, at minimum run `cd frontend && npm run build` and smoke-test the affected flow with `cd server && npm start`. For browser-script changes, verify the Tampermonkey panel, message sync, and order sync manually in Chrome.

## Commit & Pull Request Guidelines
Recent history uses concise conventional prefixes such as `feat:`, `fix:`, `docs:`, and `chore:`. Keep commits focused and describe the user-visible change, for example `fix: stabilize unread session sync`. PRs should include scope, risk, manual verification steps, and screenshots for UI or Tampermonkey panel changes.

## Agent Workflow Notes
Read `agent_logs/LATEST.md` before starting. Track work in `tasks/todo.md`, then write both `agent_logs/YYYY-MM-DD_HHMM_<agentName>.md` and `agent_logs/LATEST.md` after each deliverable. If you edit `xianyu_capture/xianyu_monitor.js`, update all version markers together: `@name`, `@version`, initialization log text, and panel title text.
