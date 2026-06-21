# AGENTS.md — iphone-opencode

## Project

iPhone companion app for OpenCode on Windows. A PWA (React+TypeScript frontend) talking to a Node.js/Express/WebSocket server with SQLite.

## Architecture

```
iphone-opencode/
├── server/          # Express + ws + SQLite backend
├── client/          # React + TypeScript PWA frontend
└── shared/          # Common types and utilities
```

- **Server** (`server/`): Entrypoint `server/src/index.ts`. Express REST API + WebSocket server (`ws`). SQLite via `better-sqlite3`.
- **Client** (`client/`): Vite + React + TypeScript PWA. Register service worker for offline support.
- **Shared** (`shared/`): TypeScript types shared between server and client.

## Setup

```bash
npm install          # installs server + client deps
npm run dev          # starts both server and client in dev mode
npm run build        # production build
npm run test         # runs all tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## Key commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server + client with HMR |
| `npm run build` | Production build (server + client) |
| `npm run test -- --run` | Single run, no watch |
| `npm run lint` | ESLint check |
| `npm run typecheck` | TypeScript check |
| `npm run db:migrate` | Run SQLite migrations |
| `npm run db:seed` | Seed dev data |

Order: `lint -> typecheck -> test` before commit.

## Conventions

- **Sub-agents required** for all multi-step tasks (`@debugger`, `@code-reviewer`, etc.)
- **Mobile-first CSS**: all components start at 375px viewport, expand up
- **Dark/light themes**: use CSS custom properties in `:root` / `[data-theme="dark"]`
- **WebSocket messaging**: typed envelope pattern (`{ type: string, payload: T }`)
- **API routes**: `/api/v1/*` with token auth via `Authorization: Bearer <token>`
- **SQLite migrations**: numbered files in `server/src/db/migrations/`
- **Testing**: Vitest for unit tests, Playwright for E2E tests
- **No Docker** -- native Windows service only

## Phases

1. Core server + PWA shell (auth, WebSocket, project listing, chat UI)
2. File management (browse, view, edit, upload/download)
3. Terminal access + git integration
4. Notifications, voice, search, session history
5. Advanced: multi-agent, approval workflow, plugin arch, remote tunnel

## Gotchas

- `better-sqlite3` requires native build tools on Windows (Visual Studio Build Tools)
- WebSocket server must handle reconnection gracefully (mobile networks drop often)
- PWA requires HTTPS for service worker registration in production
- Server runs as Windows native process, not Docker
