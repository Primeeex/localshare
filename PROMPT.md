# PROMPT.md — LocalShare: Build Instructions for an AI Coding Agent

> **Read this entire document before writing a single line of code.**
> This is a complete, exhaustive specification. Every section is binding.
> Ambiguity is intentional only where the agent is given explicit creative latitude.
> All other decisions are specified here. Do not deviate without a comment in code explaining why.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Philosophy & Design Principles](#2-philosophy--design-principles)
3. [Repository Structure](#3-repository-structure)
4. [Technology Stack](#4-technology-stack)
5. [Dependency Manifest](#5-dependency-manifest)
6. [Feature Specification — Complete](#6-feature-specification--complete)
   - 6.1 File Upload (Single & Multi)
   - 6.2 Drag-and-Drop Upload
   - 6.3 Clipboard / Text Sharing
   - 6.4 File Download (Single)
   - 6.5 Download All as ZIP
   - 6.6 QR Code (Open on Phone)
   - 6.7 Transfer Progress Bar
   - 6.8 Upload from Mobile Camera
   - 6.9 Password / PIN Protection
   - 6.10 Dark Mode UI
   - 6.11 File Expiry / Auto-Cleanup
   - 6.12 Live File List (Real-Time via SSE)
   - 6.13 File Preview (Images, Text, PDF, Video, Audio)
   - 6.14 Peer Clipboard Sync (NEW — novel feature)
   - 6.15 Transfer Speed Meter & ETA
   - 6.16 File Rename Before Download
   - 6.17 Session Rooms (Multiple Isolated Spaces)
   - 6.18 Device Name & Presence List
   - 6.19 Send-to-Device (Direct Push to Specific Peer)
   - 6.20 File Notes / Annotations
   - 6.21 Network Info Panel (IP, Port, QR)
   - 6.22 CLI Flags & Config File
   - 6.23 Graceful Shutdown & Cleanup
   - 6.24 Security Hardening
   - 6.25 Toast Notifications
   - 6.26 Keyboard Shortcuts
   - 6.27 Drag Reorder of File Queue
   - 6.28 File Type Icons & MIME Detection
   - 6.29 Copy Link Button
   - 6.30 Accessibility (WCAG 2.1 AA)
7. [Server Architecture](#7-server-architecture)
8. [API Reference — REST Endpoints](#8-api-reference--rest-endpoints)
9. [API Reference — SSE Events](#9-api-reference--sse-events)
10. [File Storage Model](#10-file-storage-model)
11. [Session & Room Model](#11-session--room-model)
12. [Authentication & PIN Protection Model](#12-authentication--pin-protection-model)
13. [UI Specification](#13-ui-specification)
    - 13.1 Layout & Structure
    - 13.2 Color System (Light & Dark)
    - 13.3 Typography
    - 13.4 Component Library (all components)
    - 13.5 Responsive Breakpoints
    - 13.6 Animations & Transitions
    - 13.7 Loading States
    - 13.8 Empty States
    - 13.9 Error States
14. [CLI Interface](#14-cli-interface)
15. [Configuration System](#15-configuration-system)
16. [Logging System](#16-logging-system)
17. [Error Handling Contract](#17-error-handling-contract)
18. [Security Model](#18-security-model)
19. [Performance Contracts](#19-performance-contracts)
20. [Open Source Repository Standards](#20-open-source-repository-standards)
    - 20.1 README.md (full specification)
    - 20.2 CONTRIBUTING.md
    - 20.3 CODE_OF_CONDUCT.md
    - 20.4 CHANGELOG.md
    - 20.5 LICENSE (MIT)
    - 20.6 .github/ directory
    - 20.7 package.json fields
21. [Testing Requirements](#21-testing-requirements)
22. [Build & Release Pipeline](#22-build--release-pipeline)
23. [Docker Support](#23-docker-support)
24. [Novel Feature Deep-Dives](#24-novel-feature-deep-dives)
25. [Edge Cases & Known Gotchas](#25-edge-cases--known-gotchas)
26. [Implementation Order (Recommended)](#26-implementation-order-recommended)
27. [Acceptance Criteria Checklist](#27-acceptance-criteria-checklist)

---

## 1. Project Overview

**Name:** LocalShare  
**Tagline:** "Share anything. Zero cloud. Zero friction."  
**One-liner:** A tiny, self-hosted web server that lets every device on the same Wi-Fi network share files, text snippets, and clipboard content through a browser — no apps, no accounts, no internet.

### What it is
LocalShare is a Node.js process you start on one machine. It serves a beautiful, fully-featured web UI on a local port. Every device on the same network (laptop, phone, tablet, smart TV browser) opens the URL (or scans the QR code) and immediately gains the ability to upload files, download files, share text, sync clipboard, and see who else is on the network — in real time.

### What it is NOT
- Not a cloud service. Nothing leaves the local network.
- Not a desktop app. It is a CLI tool that serves a web UI.
- Not a P2P (WebRTC) tool. All transfers go through the local server, keeping it simple and reliable.
- Not a permanent file store. Files are ephemeral by default (configurable expiry).
- Not a replacement for Syncthing or rsync. It is for ad-hoc, session-based sharing.

### Who it is for
- Developers who need to AirDrop between Linux and iPhone.
- People who want to get a photo off their phone without a USB cable.
- Teams in a room collaborating without cloud accounts.
- Anyone who has ever emailed a file to themselves.

### Open Source Commitment
This project is MIT-licensed, maintained openly on GitHub, and designed to be trivially forkable and contributable. All design decisions should favor simplicity, auditability, and zero magic.

---

## 2. Philosophy & Design Principles

These principles govern every decision in the codebase. When two choices seem equal, the principle breaks the tie.

### P1 — Zero Friction First
A user who has never heard of LocalShare should be able to run `npx localshare` and share a file in under 30 seconds. No configuration required. No environment setup. Sane defaults for everything.

### P2 — Single Process, No Daemon
LocalShare is a foreground process. It starts, prints the URL and QR code to the terminal, and stops when you Ctrl+C. No systemd units. No background processes. No port conflicts silently handled by mystery logic.

### P3 — Vanilla JS, No Bundler
The UI is served as plain HTML + CSS + JavaScript files. No React, Vue, Webpack, or Vite is required to build or run the UI. Dependencies may be vendored via a single `npm run vendor` script but the server in production serves static files — it does not run a bundler. This keeps the project auditable and the startup time under 100ms.

### P4 — Readable Code Over Clever Code
Every function should be understandable by a developer who has never seen the codebase. Prefer explicit over implicit. Prefer 10 readable lines over 3 clever ones. Comment every non-obvious decision with a `// WHY:` comment.

### P5 — Fail Loudly, Recover Gracefully
Errors are not swallowed. They are logged with context. The server never crashes silently. A failed upload tells the user exactly what went wrong. A missing file returns a 404 with a human-readable message, not a stack trace.

### P6 — Security Without Paranoia
LocalShare is for trusted local networks. Security measures exist to prevent accidents and casual snooping, not nation-state attacks. Default: no auth. Optional: PIN protection. Complexity budget: low.

### P7 — Mobile First, Desktop Second
The primary use case is a phone user sharing a file to a laptop. The UI must be fully usable on a 375px wide screen. Desktop is a bonus layout. Every tap target is at minimum 44×44px.

### P8 — Accessible by Default
The UI passes WCAG 2.1 AA at all times. This is not optional and not deferred. Color contrast ratios are enforced in the design tokens. Every interactive element has a visible focus ring. Every image has alt text.

### P9 — The README is the product
For an open source CLI tool, the README is what gets people to try it. It must include: a GIF/screenshot, one-command install, feature list, all CLI flags, configuration reference, and a contributing guide link. It must be beautiful in a GitHub renderer.

### P10 — Real-Time or Nothing
A file list that requires a page refresh is not good enough. The file list, device presence, and clipboard sync are all real-time via Server-Sent Events (SSE). The user never needs to refresh.

---

## 3. Repository Structure

The agent MUST produce exactly this directory structure. Do not add or remove top-level directories without strong justification documented in a code comment.

```
localshare/
├── bin/
│   └── localshare.js          # CLI entry point (#!/usr/bin/env node)
├── src/
│   ├── server.js              # Express app factory (not the entry point)
│   ├── config.js              # Configuration loader (CLI args + config file + defaults)
│   ├── logger.js              # Structured logger (pino or custom)
│   ├── storage.js             # File storage abstraction (in-memory index + disk)
│   ├── cleanup.js             # File expiry and cleanup scheduler
│   ├── auth.js                # PIN/session middleware
│   ├── qr.js                  # QR code generator (terminal + image)
│   ├── network.js             # Local IP detection utilities
│   ├── rooms.js               # Session room management
│   ├── sse.js                 # SSE channel management (clients, broadcast)
│   ├── routes/
│   │   ├── index.js           # Route aggregator
│   │   ├── files.js           # /api/files/* routes
│   │   ├── text.js            # /api/text/* routes
│   │   ├── clipboard.js       # /api/clipboard/* routes
│   │   ├── devices.js         # /api/devices/* routes
│   │   ├── rooms.js           # /api/rooms/* routes
│   │   ├── auth.js            # /api/auth/* routes
│   │   └── events.js          # /events SSE endpoint
│   └── middleware/
│       ├── errorHandler.js    # Global error handler
│       ├── rateLimit.js       # Simple rate limiter
│       ├── cors.js            # CORS headers (local network only)
│       └── requestId.js       # Attach req.id to every request
├── public/
│   ├── index.html             # Main SPA shell
│   ├── css/
│   │   ├── tokens.css         # CSS custom properties (design tokens)
│   │   ├── reset.css          # Minimal CSS reset
│   │   ├── layout.css         # Grid/flex layout primitives
│   │   ├── components.css     # Component styles
│   │   ├── animations.css     # Keyframes and transition classes
│   │   └── dark.css           # Dark mode overrides (prefers-color-scheme + data-theme)
│   ├── js/
│   │   ├── app.js             # App bootstrap and router
│   │   ├── api.js             # All fetch() wrappers (typed, never inline fetch)
│   │   ├── store.js           # Client-side state (plain object + event emitter)
│   │   ├── sse.js             # SSE client connection and event dispatch
│   │   ├── upload.js          # Upload logic (chunked, progress, queue)
│   │   ├── download.js        # Download helpers (single, ZIP)
│   │   ├── clipboard.js       # Clipboard sync logic
│   │   ├── qr.js              # QR code rendering (using qrcode.js vendored)
│   │   ├── devices.js         # Device presence rendering
│   │   ├── preview.js         # File preview modal logic
│   │   ├── rooms.js           # Room join/switch UI logic
│   │   ├── theme.js           # Dark/light theme toggle + persistence
│   │   ├── shortcuts.js       # Keyboard shortcut registration
│   │   ├── toast.js           # Toast notification system
│   │   ├── icons.js           # SVG icon registry (inline SVG, no sprite sheets)
│   │   └── utils.js           # formatBytes, formatDate, debounce, etc.
│   ├── vendor/
│   │   └── qrcode.min.js      # Vendored QR code library (no CDN dependency)
│   └── assets/
│       ├── favicon.svg        # SVG favicon
│       └── logo.svg           # LocalShare logo (SVG, monochrome + color versions)
├── uploads/                   # Default upload storage (gitignored, created at runtime)
├── test/
│   ├── unit/
│   │   ├── storage.test.js
│   │   ├── config.test.js
│   │   ├── network.test.js
│   │   ├── auth.test.js
│   │   └── rooms.test.js
│   ├── integration/
│   │   ├── upload.test.js
│   │   ├── download.test.js
│   │   ├── text.test.js
│   │   ├── sse.test.js
│   │   └── auth.test.js
│   └── helpers/
│       └── testServer.js      # Creates an isolated test server instance
├── .github/
│   ├── workflows/
│   │   ├── ci.yml             # Lint + test on push/PR
│   │   └── release.yml        # npm publish on version tag
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── pull_request_template.md
├── docs/
│   ├── architecture.md        # System architecture narrative
│   ├── api.md                 # Full REST + SSE API docs (auto-generated or hand-written)
│   ├── configuration.md       # All config options with types, defaults, examples
│   └── screenshots/           # PNG screenshots referenced by README
├── scripts/
│   ├── vendor.js              # Downloads and pins vendored JS dependencies
│   └── release.js             # Bumps version, updates CHANGELOG, tags
├── .gitignore
├── .npmignore
├── .eslintrc.json
├── .prettierrc
├── .editorconfig
├── localshare.config.example.json   # Example config file
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── CHANGELOG.md
└── LICENSE
```

---

## 4. Technology Stack

### Runtime
- **Node.js** ≥ 18.0.0 (LTS). Use native `fetch`, `crypto`, `fs/promises`, `stream/promises`. Do NOT use `request`, `node-fetch`, or `axios` for internal use.
- **npm** ≥ 9.0.0

### Server Framework
- **Express** 4.x — stable, widely known, no magic.
- Do NOT use Fastify, Koa, Hono, or any other framework. Express is specified because its middleware model is most legible to contributors.

### Key Server Dependencies (use these exact packages)
| Package | Purpose |
|---|---|
| `express` | HTTP server |
| `multer` | Multipart file upload handling |
| `archiver` | ZIP generation for "Download All" |
| `qrcode` | QR code generation (server-side, for terminal output) |
| `nanoid` | Short unique IDs for files, rooms, sessions |
| `chokidar` | Watch uploads dir for external changes (optional, feature-flagged) |
| `pino` | Fast structured logger |
| `pino-pretty` | Human-readable log output in dev |
| `mime-types` | MIME type detection from extension |
| `helmet` | HTTP security headers |
| `express-rate-limit` | Rate limiting middleware |
| `ws` | WebSocket (used only if SSE is insufficient for a specific feature — default to SSE) |
| `yargs` | CLI argument parsing |
| `cosmiconfig` | Config file loading (`localshare.config.json`, `package.json#localshare`, etc.) |
| `serve-static` | Serve the public/ directory |

### Dev Dependencies
| Package | Purpose |
|---|---|
| `vitest` | Unit and integration tests |
| `supertest` | HTTP integration testing |
| `eslint` | Linting |
| `prettier` | Formatting |
| `nodemon` | Dev server with restart |
| `@types/node` | TypeScript types for IDE support (JSDoc typed, no TS compile step) |

### Client-Side (No Build Step)
- Vanilla HTML5 + CSS3 + ES2022 JavaScript (modules via `<script type="module">`)
- No React, Vue, Svelte, Alpine, HTMX, or any framework
- No Tailwind, Bootstrap, or any CSS framework
- CSS Custom Properties (variables) for the entire design system
- Native `EventSource` API for SSE
- Native `Fetch API` for all HTTP
- Native `Web Share API` where available (mobile)
- `qrcode.js` vendored in `public/vendor/` — this is the ONLY vendored client dependency

### TypeScript Policy
The project is written in plain JavaScript with JSDoc type annotations. This means:
- All functions have `/** @param {Type} name */` JSDoc comments
- `package.json` includes `"type": "module"` — use ES module syntax throughout (`import`/`export`)
- `jsconfig.json` is included with `"checkJs": true` for IDE support
- No `tsc` compile step. Code runs directly with Node.

---

## 5. Dependency Manifest

The `package.json` must contain exactly this structure (version ranges are minimums — use latest compatible):

```json
{
  "name": "localshare",
  "version": "1.0.0",
  "description": "Share files between devices on the same Wi-Fi with a tiny web UI",
  "type": "module",
  "main": "src/server.js",
  "bin": {
    "localshare": "bin/localshare.js"
  },
  "engines": {
    "node": ">=18.0.0",
    "npm": ">=9.0.0"
  },
  "keywords": [
    "file-sharing", "local-network", "wifi", "lan", "self-hosted",
    "cli", "web-ui", "no-cloud", "airdrop-alternative"
  ],
  "license": "MIT",
  "files": [
    "bin/",
    "src/",
    "public/",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
  "scripts": {
    "start": "node bin/localshare.js",
    "dev": "nodemon bin/localshare.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ bin/ public/js/ test/",
    "format": "prettier --write .",
    "vendor": "node scripts/vendor.js",
    "release": "node scripts/release.js"
  },
  "dependencies": {
    "archiver": "^6.0.0",
    "chokidar": "^3.5.3",
    "cosmiconfig": "^9.0.0",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.3",
    "helmet": "^7.1.0",
    "mime-types": "^2.1.35",
    "multer": "^1.4.5-lts.1",
    "nanoid": "^5.0.4",
    "pino": "^8.17.1",
    "pino-pretty": "^10.3.0",
    "qrcode": "^1.5.3",
    "yargs": "^17.7.2"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^1.0.4",
    "eslint": "^8.56.0",
    "nodemon": "^3.0.2",
    "prettier": "^3.1.1",
    "supertest": "^6.3.3",
    "vitest": "^1.0.4"
  }
}
```

---

## 6. Feature Specification — Complete

Every feature below must be implemented. "Must" means it ships in v1.0. "Should" means it ships in v1.0 but can be simplified. "May" means it is a nice-to-have for a future version but the placeholder/stub must exist.

---

### 6.1 File Upload (Single & Multi)

**Behavior:**
- Users can upload one or more files simultaneously via the file input or drag-and-drop.
- Maximum file size per upload: configurable, default **2 GB**. This is enforced both client-side (before fetch) and server-side (multer `limits.fileSize`).
- Maximum total storage: configurable, default **10 GB**. When storage is full, uploads fail with a clear 507 response.
- Concurrent uploads: up to 4 simultaneous uploads from one client (client enforces this queue).
- Each file is stored in `uploads/<roomId>/<fileId>-<originalname>` on disk.
- The in-memory file index is rebuilt from disk on server start (so files survive server restart).
- Uploaded files are visible to all connected clients immediately via SSE.

**API:**
- `POST /api/rooms/:roomId/files` — multipart/form-data, field name `files[]`

**Storage metadata per file:**
```js
{
  id: 'nanoid(10)',
  roomId: 'string',
  originalName: 'string',          // original filename from upload
  storedName: 'string',            // as stored on disk
  mimeType: 'string',
  size: 'number',                  // bytes
  uploadedAt: 'ISO8601 string',
  uploadedBy: 'string',            // device name or "Anonymous"
  expiresAt: 'ISO8601 string | null',
  note: 'string | null',           // user-provided annotation
  downloadCount: 'number',
  pinned: 'boolean',               // pinned files ignore expiry
}
```

**Client behavior:**
- The upload button opens a native file picker (no custom picker).
- Clicking anywhere in the drop zone also opens the file picker.
- While uploading, a per-file progress bar is shown with: filename, size, speed (bytes/sec), ETA, and a cancel button.
- A file upload can be cancelled mid-stream (use `AbortController`).
- After completion: success toast, file appears in list, progress bar disappears after 2s.
- On error: error toast with the error message from the server.

---

### 6.2 Drag-and-Drop Upload

**Behavior:**
- The entire browser window is the drop zone (not just a small box).
- When a drag event enters the window, a full-screen overlay appears with a dashed border and the text "Drop to upload".
- The overlay disappears when the drag leaves the window or files are dropped.
- Dropped files are added to the upload queue and processed identically to file-input uploads.
- Dropping a folder: not supported in v1. If a folder is dropped, show a toast: "Folder upload is not supported. Please zip the folder first."
- The overlay must not interfere with other UI interactions (it is a top-layer element with `pointer-events: none` except when active).

**CSS class states:** `.drop-overlay--inactive`, `.drop-overlay--active`, `.drop-overlay--rejected`

---

### 6.3 Clipboard / Text Sharing

**Behavior:**
- A dedicated "Text" tab (or panel) allows users to share arbitrary text snippets.
- Text entries are NOT the same as files. They live in a separate data store.
- A user can type or paste text into a textarea and click "Share Text".
- Shared text appears in a list visible to all devices in the room in real-time.
- Each text entry has: id, content, sharedAt, sharedBy, label (optional short title).
- Text entries can be copied to clipboard with one click (copy icon button).
- Text entries can be deleted by anyone in the room (no ownership enforcement in v1).
- Max text entry length: 100,000 characters. Enforced client and server side.
- Max text entries per room: 50. When limit is reached, the oldest non-pinned entry is removed.
- Text entries persist for the same duration as files (configurable expiry).

**API:**
- `GET /api/rooms/:roomId/text` — list all text entries
- `POST /api/rooms/:roomId/text` — create a text entry `{ content, label? }`
- `DELETE /api/rooms/:roomId/text/:id` — delete a text entry

**Special paste behavior:**
- When the user presses Ctrl+V / Cmd+V while the main window is focused (but no input is focused), a modal appears with the pasted content pre-filled, asking "Share this text?" with a Share and Cancel button.
- This behavior is opt-in (a toggle in settings, default ON).

---

### 6.4 File Download (Single)

**Behavior:**
- Clicking a file name or "Download" button triggers a browser download.
- The server streams the file from disk using `res.download()` or `createReadStream` piped to response.
- `Content-Disposition: attachment; filename="<originalName>"` is set.
- `Content-Type` is set from `mime-types.lookup(originalName)`.
- `Content-Length` is set for known file sizes.
- The download count for the file is incremented on each successful download.
- Range requests (`Range` header) are supported for resumable downloads and media streaming.

**API:**
- `GET /api/rooms/:roomId/files/:fileId/download`
- `GET /api/rooms/:roomId/files/:fileId/preview` — inline preview (Content-Disposition: inline)

---

### 6.5 Download All as ZIP

**Behavior:**
- A "Download All" button in the file list downloads all files in the current room as a single ZIP.
- The ZIP is generated on-the-fly using `archiver` — it is streamed directly to the response, not stored on disk.
- ZIP filename: `localshare-<roomId>-<date>.zip`
- Files added to the ZIP retain their original names.
- If two files have the same name, the second is renamed `<name>-2.<ext>`.
- If no files exist, the button is disabled with a tooltip: "No files to download".
- The ZIP generation does not block other requests (it is a streaming response).
- Progress of ZIP download is tracked by the browser's native download UI.
- Maximum ZIP size: 4 GB. If the total would exceed this, the button shows a warning: "Too large to ZIP. Download files individually."

**API:**
- `GET /api/rooms/:roomId/files/zip`

---

### 6.6 QR Code (Open on Phone)

**Behavior — Terminal:**
- On server start, the terminal shows:
  - The local IP address(es) and port
  - The full URL (e.g., `http://192.168.1.42:3000`)
  - A QR code rendered in the terminal using Unicode block characters (NOT an image file)
  - The QR code is generated by the `qrcode` package with `type: 'terminal'`

**Behavior — Web UI:**
- A "QR Code" button in the header opens a modal.
- The modal contains a large QR code image (generated client-side from `qrcode.js` vendored library) encoding the current room's URL.
- Below the QR code: the URL as plain text with a "Copy URL" button.
- The modal is closeable by clicking outside it or pressing Escape.
- The QR code automatically updates if the room changes.

**Behavior — Multiple network interfaces:**
- If the machine has multiple local IPs (e.g., Wi-Fi + Ethernet), all are listed in the terminal and in a dropdown in the UI.
- The QR code defaults to the most likely Wi-Fi interface (heuristic: prefer 192.168.x.x over 10.x.x.x over 172.16.x.x).
- The user can switch which IP the QR code uses via a dropdown in the QR modal.

---

### 6.7 Transfer Progress Bar

**Server-side tracking:**
- For each active upload, the server tracks bytes received vs. total expected (from `Content-Length` header).
- This progress is emitted to the uploader's SSE connection every 250ms.

**Client-side rendering:**
- Each file in the upload queue shows a progress bar: `[████████░░░░] 67% — 12.3 MB/s — ETA 4s`
- The progress bar is a `<progress>` element styled with CSS (not a div with width trick, for accessibility).
- Speed calculation: rolling average over last 5 data points, recalculated every 250ms.
- ETA calculation: `(totalBytes - receivedBytes) / currentSpeedBytesPerSec`
- When upload completes: bar fills to 100%, turns green, then disappears after 1.5s.
- When upload fails: bar turns red, shows error message.
- When upload is cancelled: bar turns grey, shows "Cancelled".

**Download progress:**
- Browser-native download progress is used for downloads (no custom tracking needed).
- For large downloads (>50MB), a toast notification says: "Downloading <filename>..." until the browser's download manager takes over.

---

### 6.8 Upload from Mobile Camera

**Behavior:**
- On mobile devices, the "Upload" button presents two options: "Choose File" and "Take Photo / Video".
- "Take Photo / Video" uses `<input type="file" capture="environment" accept="image/*,video/*">`.
- The captured photo/video is uploaded identically to a regular file upload.
- This button is only shown when the user agent is detected as mobile (`navigator.userAgent` check + touch capability check).
- On desktop, this button is hidden.
- Detection is done purely client-side in `upload.js`.

---

### 6.9 Password / PIN Protection

**Model:**
- The server can be started with a PIN (4–8 digits) via `--pin <value>` CLI flag or config file.
- When a PIN is set, every API endpoint and the main HTML page require authentication.
- Authentication is session-based: a correct PIN sets a signed cookie (`httpOnly`, `sameSite: strict`).
- Cookie signing uses a random secret generated at server start (not configurable — this prevents secret reuse).
- Sessions expire when the browser closes (no `maxAge` on the cookie in v1).
- The PIN is never stored in plaintext. It is stored as a bcrypt hash (use Node's built-in `crypto.scrypt` — do NOT add bcrypt as a dependency).

**PIN UI:**
- When unauthenticated, the only page served is a PIN entry page.
- The PIN page: full-screen, centered, a 4-8 digit input, and a "Enter" button.
- The input is type="password" with inputmode="numeric".
- On wrong PIN: the input shakes (CSS animation), error message "Incorrect PIN", and the rate limiter kicks in (3 wrong attempts → 30s lockout with countdown displayed).
- On correct PIN: redirect to main app.

**API protection:**
- `POST /api/auth/verify` — takes `{ pin: string }`, returns `{ success: true }` and sets cookie, or `{ success: false, retriesLeft: number }`.
- `POST /api/auth/logout` — clears the session cookie.
- All other API routes check for the session cookie via middleware. Unauthenticated requests return `401`.

---

### 6.10 Dark Mode UI

**Behavior:**
- Default: follows `prefers-color-scheme` media query.
- User can override with a toggle in the UI (sun/moon icon button in header).
- User preference is persisted in `localStorage` as `theme: 'light' | 'dark' | 'system'`.
- On page load, the theme is applied before any render to prevent flash of wrong theme (inline `<script>` in `<head>` that reads localStorage and sets `data-theme` on `<html>`).
- All colors are CSS custom properties defined in `tokens.css`.
- Dark mode is implemented via `[data-theme="dark"]` selector overriding `[data-theme="light"]` tokens.
- There is also a `@media (prefers-color-scheme: dark)` fallback for users with system theme but no localStorage entry.
- The three-state toggle cycles: `system → light → dark → system`.

**Color token naming convention:**
```
--color-bg-base          /* page background */
--color-bg-surface       /* card/panel background */
--color-bg-elevated      /* modal/dropdown background */
--color-bg-overlay       /* dimming overlay */
--color-border           /* default border */
--color-border-strong    /* active/focused border */
--color-text-primary     /* body text */
--color-text-secondary   /* muted/helper text */
--color-text-disabled    /* disabled state text */
--color-accent           /* brand accent — interactive elements */
--color-accent-hover     /* accent hover state */
--color-accent-text      /* text on accent background */
--color-success          /* success states */
--color-warning          /* warning states */
--color-error            /* error states */
--color-info             /* informational states */
```

---

### 6.11 File Expiry / Auto-Cleanup

**Behavior:**
- Files have an `expiresAt` timestamp set at upload time.
- Default expiry: configurable, default **24 hours** after upload.
- Pinned files (`pinned: true`) never expire.
- A cleanup job runs every 60 seconds.
- Expired files are: removed from disk, removed from the in-memory index, and broadcast to all clients via SSE (`file:deleted` event).
- Users see a countdown on each file: "Expires in 2h 14m" (updated every minute client-side).
- Files expiring in less than 30 minutes show the countdown in orange.
- Files expiring in less than 5 minutes show the countdown in red with a pulsing animation.
- Users can extend a file's expiry by clicking "Extend" (+24h, requires no auth unless PIN mode).
- Users can pin a file (prevents expiry) with a pin icon button.

**API:**
- `PATCH /api/rooms/:roomId/files/:fileId` — `{ expiresAt?, pinned?, note? }`

---

### 6.12 Live File List (Real-Time via SSE)

**Behavior:**
- The client establishes a persistent SSE connection to `/events?roomId=<id>&deviceId=<id>`.
- The SSE connection sends a heartbeat comment (`: ping\n\n`) every 15 seconds to prevent proxy timeouts.
- On connection, the server sends a `connected` event with the current room state.
- Every state change (file added, file deleted, file updated, text added, device joined, device left, clipboard updated) triggers a broadcast to all clients in that room.
- The client updates the UI in response to SSE events, with no fetch required.
- SSE reconnection: the browser reconnects automatically. The client sends the last event ID (via `Last-Event-ID` header) and the server can replay missed events from an in-memory buffer (last 50 events per room).
- Maximum SSE connections per server: 500 (configurable). Above this limit, new connections receive a 503 with a `Retry-After` header.

**Event types (all JSON in the `data` field):**
```
connected         — initial state dump
file:added        — { file: FileObject }
file:deleted      — { fileId, roomId }
file:updated      — { file: FileObject }
text:added        — { entry: TextEntry }
text:deleted      — { entryId, roomId }
device:joined     — { device: DeviceObject }
device:left       — { deviceId, roomId }
clipboard:updated — { clipboard: ClipboardEntry }
room:updated      — { room: RoomObject }
server:shutdown   — { message, countdown }
```

---

### 6.13 File Preview (Images, Text, PDF, Video, Audio)

**Behavior:**
- Clicking a file name opens a preview modal (not a new tab).
- Previewed in-modal: `image/*`, `text/*`, `application/pdf`, `video/*`, `audio/*`.
- Non-previewable files show: a large file type icon, the file name, size, and a prominent "Download" button.
- Image preview: full-size image with zoom on click (toggle between fit-to-modal and 1:1). Pinch-to-zoom on mobile.
- Text preview: shows the content in a `<pre>` element with syntax awareness (code files get a monospace font, no syntax highlighting in v1).
- PDF preview: uses a native `<iframe src="/api/rooms/:roomId/files/:fileId/preview">` — the browser's built-in PDF viewer.
- Video preview: `<video controls>` with `src` pointing to the file endpoint. Supports range requests for seeking.
- Audio preview: `<audio controls>` with waveform-style placeholder.
- Modal has: close button (top-right X), close on Escape, close on click-outside.
- Modal has: filename, size, uploader, timestamp in the header.
- Modal has: "Download" and "Delete" buttons in the footer.
- Navigation arrows (prev/next) when multiple files are in the room.

---

### 6.14 Peer Clipboard Sync ✨ (Novel Feature)

**Concept:**
This is the "wow" feature. When enabled, all devices in a room share a live clipboard. Anything you copy on one device appears as a clipboard notification on all other devices, which they can accept with one tap to paste into their own clipboard.

**How it works:**
1. On device A: user copies text (or we detect a copy event from our own paste field).
2. Device A sends `POST /api/rooms/:roomId/clipboard` with `{ content, type: 'text' }`.
3. Server broadcasts `clipboard:updated` SSE event to all other devices in the room.
4. On device B: a non-intrusive toast appears at the bottom: "📋 New clipboard from [Device A] — Tap to copy"
5. Device B taps the toast → `navigator.clipboard.writeText(content)` → confirms with a ✓.

**Privacy:**
- Clipboard sync is **opt-in per device** (a toggle in settings, default OFF).
- Devices that have opted out still see clipboard items in the "Clipboard" tab but do not receive pop-up toasts.
- The clipboard history (last 10 items) is visible in a "Clipboard" tab.
- Clipboard entries auto-delete after 30 minutes.
- Long clipboard content (>500 chars) is truncated in the toast with "...show more".

**Limitations:**
- v1 supports text clipboard only. Image clipboard is a v2 feature (stub the API).
- Due to browser security, clipboard sync only works if the user grants clipboard-write permission OR manually clicks the toast.
- A warning is shown when clipboard permission is denied.

**API:**
- `POST /api/rooms/:roomId/clipboard` — `{ content: string, type: 'text', label?: string }`
- `GET /api/rooms/:roomId/clipboard` — list recent clipboard entries
- `DELETE /api/rooms/:roomId/clipboard/:id` — delete a clipboard entry

---

### 6.15 Transfer Speed Meter & ETA

(Already covered in 6.7 — adding additional detail here)

**Server-side speed tracking:**
- `multer` does not natively support per-chunk progress. Use a custom `Transform` stream that wraps `busboy` (multer's dependency) to count bytes as they arrive.
- Every 250ms, emit an SSE event `upload:progress` to the uploading client's SSE channel:
  ```json
  {
    "type": "upload:progress",
    "fileId": "abc123",
    "received": 1048576,
    "total": 10485760,
    "speed": 4194304
  }
  ```
- The client calculates ETA from this data.

**Global stats display:**
- A small status bar at the bottom of the app shows:
  - Active uploads: count
  - Total transferred this session: bytes formatted (e.g., "143 MB transferred")
  - Active devices in room: count

---

### 6.16 File Rename Before Download

**Behavior:**
- In the file action menu (three-dot menu on each file row), there is a "Download as..." option.
- This opens a small inline input with the current filename pre-filled.
- The user edits the name and presses Enter or "Download".
- The download is triggered via a programmatic `<a download="newname">` click.
- The file on the server is NOT renamed. This is purely a client-side filename override.

---

### 6.17 Session Rooms (Multiple Isolated Spaces)

**Concept:**
A room is an isolated sharing space. Files, text, and clipboard are scoped to a room. Multiple rooms can exist simultaneously on one server.

**Behavior:**
- On first visit, a user is assigned to the "default" room.
- The URL contains the room ID: `http://host:port/?room=default`.
- Users can create a new room (generates a nanoid) or join an existing room by ID.
- Rooms can have a human-readable display name (editable, max 32 chars).
- Rooms can be PIN-protected independently of the server PIN.
- All data (files, text, clipboard, devices) is scoped per room.
- A room with zero files, zero text entries, and zero connected devices is auto-deleted after 30 minutes.
- The default room is never auto-deleted.
- Maximum rooms per server: 20 (configurable).
- Users can switch rooms via a room selector dropdown in the header.
- The current room is stored in `localStorage` and `?room=` URL param (URL param takes priority).

**Room data model:**
```js
{
  id: 'string',                // nanoid(8)
  name: 'string',              // display name, default = room ID
  createdAt: 'ISO8601',
  pin: 'string | null',        // scrypt hash of room PIN
  files: 'Map<fileId, File>',  // in-memory index
  textEntries: 'Map<id, TextEntry>',
  clipboardEntries: 'Array<ClipboardEntry>',  // capped at 10
  connectedDevices: 'Map<deviceId, Device>',
  lastActivityAt: 'ISO8601',
}
```

**API:**
- `GET /api/rooms` — list all rooms (id, name, fileCount, deviceCount)
- `POST /api/rooms` — create a room `{ name?, pin? }`
- `GET /api/rooms/:roomId` — get room details
- `DELETE /api/rooms/:roomId` — delete a room (and all its files)
- `PATCH /api/rooms/:roomId` — update name or PIN

---

### 6.18 Device Name & Presence List

**Concept:**
When a device connects to a room, it announces itself with a device name. All devices in the room see each other in real time.

**Behavior:**
- On first visit, the client generates a `deviceId` (nanoid, stored in `localStorage`).
- The client also has a `deviceName` (stored in `localStorage`, default: generated friendly name).
- Friendly name generation: `[Adjective][Animal]` format, e.g., `QuickFox`, `BraveOtter`. 50+ adjectives × 50+ animals = 2500+ combinations. This list is hardcoded in `utils.js`.
- The deviceId and deviceName are sent in every SSE connection and API request via headers: `X-Device-Id` and `X-Device-Name`.
- The server maintains a list of connected devices per room (tied to active SSE connections).
- When an SSE connection closes, the device is removed from the presence list after a 5-second grace period (to handle brief reconnects).
- Each device has a colored avatar: a circle with the first two letters of the device name, color derived from a hash of the device ID (consistent across sessions).

**Device data model:**
```js
{
  id: 'string',
  name: 'string',
  joinedAt: 'ISO8601',
  lastSeenAt: 'ISO8601',
  userAgent: 'string',         // raw UA string
  deviceType: 'desktop|mobile|tablet',  // derived from UA
  deviceIcon: 'laptop|phone|tablet',    // for UI rendering
  color: 'string',             // hex, derived from id hash
}
```

**UI:**
- A "Devices" indicator in the header shows avatars of connected devices (stacked, up to 5, then "+N more").
- Clicking opens a dropdown list of all devices with names and join times.
- Your own device is marked with "(you)".
- New device joining: a subtle toast "QuickFox joined the room".
- Device leaving: a subtle toast "BraveOtter left the room" (shown only if device was present for >30s, to suppress bouncy connections).

---

### 6.19 Send-to-Device (Direct Push to Specific Peer) ✨ (Novel Feature)

**Concept:**
Rather than uploading a file to the shared pool, you can "push" a file directly to a specific device. That device gets a pop-up notification asking them to accept or decline the file.

**Flow:**
1. User right-clicks a file in their upload queue OR clicks a "Send to..." button.
2. A popover shows the list of currently connected devices.
3. User selects a target device.
4. Server stores the file in a temporary "pending transfers" area.
5. Target device receives an SSE event `transfer:incoming` with file metadata.
6. A modal appears on target device: "[QuickFox] wants to send you: photo.jpg (2.3 MB). Accept / Decline"
7. On Accept: file is downloaded directly. On Decline: sender is notified, file is deleted.
8. Transfer expires after 60 seconds if no response.

**API:**
- `POST /api/rooms/:roomId/transfers` — initiate transfer `{ fileId, targetDeviceId }`
- `PATCH /api/rooms/:roomId/transfers/:transferId` — `{ action: 'accept' | 'decline' }`
- `GET /api/rooms/:roomId/transfers/:transferId/download` — download the transferred file (only by the target device)

---

### 6.20 File Notes / Annotations

**Behavior:**
- Each file can have a short text note attached to it (max 500 characters).
- The note is displayed below the filename in the file list.
- Notes can be added, edited, and deleted by anyone in the room.
- Adding a note is done via the file action menu → "Add Note" → inline text input.
- Notes are stored in the file metadata object.
- Notes are shown in the file preview modal.

---

### 6.21 Network Info Panel (IP, Port, QR)

**Behavior:**
- A "Network Info" section in the sidebar or settings panel shows:
  - All detected local IP addresses
  - The port the server is running on
  - The full URL for each IP
  - A QR code for each URL (small, 128×128px)
- This is useful when multiple network interfaces are active.
- The server's detected IPs are available via: `GET /api/server/info`

**API:**
```js
// GET /api/server/info
{
  hostname: 'string',
  port: number,
  interfaces: [
    { name: 'string', address: 'string', url: 'string' }
  ],
  version: 'string',
  uptime: number,             // seconds
  roomCount: number,
  totalFiles: number,
  totalSize: number,          // bytes
}
```

---

### 6.22 CLI Flags & Config File

(Full specification in Section 14 and 15)

---

### 6.23 Graceful Shutdown & Cleanup

**Behavior:**
- On `SIGINT` (Ctrl+C) or `SIGTERM`, the server:
  1. Broadcasts `server:shutdown` SSE event with `{ countdown: 5 }` to all clients.
  2. The UI shows a full-screen banner: "Server is shutting down in 5 seconds..."
  3. Waits 2 seconds for clients to receive the message.
  4. Closes all SSE connections.
  5. Closes the HTTP server (stops accepting new connections, finishes in-flight requests with a 5s timeout).
  6. Runs cleanup tasks (flush any pending state to disk if persistence is enabled).
  7. Logs "LocalShare stopped. Goodbye." and exits with code 0.
- Unhandled promise rejections and uncaught exceptions are caught, logged with full stack trace, and the server shuts down gracefully (exit code 1).

---

### 6.24 Security Hardening

(Full specification in Section 18)

---

### 6.25 Toast Notifications

**System:**
- A global toast system in `toast.js` that can be called from anywhere: `Toast.show({ message, type, duration })`.
- `type` values: `'success' | 'error' | 'warning' | 'info'`
- Toasts stack vertically in the bottom-right corner (bottom-center on mobile).
- Each toast has: an icon (✓/✕/⚠/ℹ), the message, and a close button.
- Default duration: 4 seconds. Error toasts: 8 seconds (must be manually dismissed or duration runs out).
- Entry animation: slide up + fade in. Exit animation: fade out.
- Maximum 5 toasts visible at once; additional queue behind the oldest.
- ARIA live region: the toast container has `aria-live="polite"` for screen readers.

---

### 6.26 Keyboard Shortcuts

Implement all of the following. Display a shortcuts help overlay on `?` key.

| Shortcut | Action |
|---|---|
| `U` | Focus / open file upload dialog |
| `T` | Switch to Text tab |
| `F` | Switch to Files tab |
| `C` | Switch to Clipboard tab |
| `D` | Switch to Devices tab |
| `/` | Focus search bar |
| `Escape` | Close any open modal/dropdown |
| `Ctrl+V` / `Cmd+V` | Open paste-to-share modal (when no input focused) |
| `?` | Show keyboard shortcuts help modal |
| `J` / `K` | Navigate up/down in file list (vim-style) |
| `Enter` | Preview selected file |
| `Backspace` | Delete selected file (with confirmation) |
| `Ctrl+D` / `Cmd+D` | Download selected file |
| `Q` | Open QR code modal |
| `N` | Open new room dialog |

---

### 6.27 Drag Reorder of File Queue

**Behavior:**
- The upload queue (files waiting to be uploaded) can be reordered by dragging.
- Use native HTML5 drag and drop (no library needed).
- Implemented in `upload.js`.
- Reordering only affects the upload order, not already-uploaded files.

---

### 6.28 File Type Icons & MIME Detection

**Behavior:**
- Every file in the list shows a file type icon (SVG).
- Icons are determined by MIME type category:
  - `image/*` → image icon
  - `video/*` → video/film icon
  - `audio/*` → music note icon
  - `application/pdf` → PDF icon
  - `application/zip`, `application/x-tar`, `application/x-7z-compressed` → archive icon
  - `application/msword`, `application/vnd.openxmlformats-officedocument.*` → document icon
  - `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.*` → spreadsheet icon
  - `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.*` → presentation icon
  - `text/*`, `application/json`, `application/xml` → code/text icon
  - All others → generic file icon

- All icons are defined as inline SVG strings in `icons.js`. NO external icon libraries. NO icon fonts.
- Color of icons: use `--color-accent` for icon fill/stroke to match theme.

---

### 6.29 Copy Link Button

**Behavior:**
- Each file has a "Copy Link" option in its action menu.
- Copies `http://<serverIP>:<port>/api/rooms/<roomId>/files/<fileId>/download` to clipboard.
- If the server has multiple IPs, copies the primary IP URL.
- Toast: "Link copied to clipboard".
- This link works for any device on the network without requiring the UI.

---

### 6.30 Accessibility (WCAG 2.1 AA)

**Requirements (all mandatory):**
- All color contrast ratios: ≥ 4.5:1 for normal text, ≥ 3:1 for large text and UI components. Verify with the WebAIM Contrast Checker algorithm implemented in `tokens.css` comments.
- All interactive elements are keyboard focusable and have a visible focus ring (2px solid `--color-accent`, 2px offset).
- The focus ring is NOT suppressed with `outline: none` unless a custom focus style replaces it.
- All form inputs have associated `<label>` elements (not placeholder-as-label).
- All images have `alt` attributes. Decorative images have `alt=""`.
- All icon buttons have `aria-label` attributes.
- Modals trap focus when open (focus cycles within the modal).
- Modals restore focus to the triggering element when closed.
- The drag-and-drop zone has a keyboard-accessible equivalent (the file input).
- All SSE-driven UI updates use ARIA live regions where appropriate.
- The app is fully usable with keyboard only.
- The app is fully usable with a screen reader (VoiceOver/NVDA).
- `prefers-reduced-motion` is respected: all decorative animations are disabled.
- `prefers-contrast: more` is respected: borders and text are increased in contrast.

---

## 7. Server Architecture

### Process Architecture
```
bin/localshare.js
  └── loads config (yargs + cosmiconfig)
  └── starts logger
  └── detects network interfaces
  └── creates Express app (src/server.js)
  └── initializes storage (src/storage.js)
  └── initializes rooms (src/rooms.js)
  └── initializes SSE channels (src/sse.js)
  └── starts cleanup scheduler (src/cleanup.js)
  └── starts HTTP server on configured port
  └── prints URL + QR code to terminal
  └── registers SIGINT/SIGTERM handlers
```

### Request Flow
```
Request
  → requestId middleware (attach req.id)
  → helmet (security headers)
  → CORS middleware
  → rate limiter
  → auth middleware (check PIN cookie if PIN mode)
  → route handler
  → error handler (if route throws)
  → response
```

### Storage Architecture
```
In-memory:
  rooms: Map<roomId, Room>
    room.files: Map<fileId, FileMetadata>
    room.textEntries: Map<id, TextEntry>
    room.clipboardEntries: ClipboardEntry[]
    room.connectedDevices: Map<deviceId, Device>

On-disk:
  uploads/<roomId>/<fileId>-<originalname>

SSE channels:
  clients: Map<roomId, Set<SSEClient>>
  each SSEClient = { res, deviceId, lastEventId }
```

### Module Responsibilities

**`src/server.js`** — Pure Express app factory. Accepts a config object and returns `{ app, start, stop }`. Does NOT call `listen()` — that is done in `bin/localshare.js`. This allows the test suite to create isolated server instances.

**`src/config.js`** — Merges CLI args, config file, and defaults into a single frozen config object. Validates all values. Throws with a helpful error message if invalid.

**`src/storage.js`** — All disk I/O. Exposes: `saveFile(roomId, file, stream)`, `readFile(roomId, fileId)`, `deleteFile(roomId, fileId)`, `listFiles(roomId)`, `rebuildIndexFromDisk()`. All async.

**`src/rooms.js`** — In-memory room state. Exposes: `createRoom(options)`, `getRoom(id)`, `deleteRoom(id)`, `addFile(roomId, metadata)`, `removeFile(roomId, fileId)`, `addDevice(roomId, device)`, `removeDevice(roomId, deviceId)`, etc.

**`src/sse.js`** — SSE client management. Exposes: `addClient(roomId, res, deviceId)`, `removeClient(roomId, deviceId)`, `broadcast(roomId, event, data)`, `broadcastToDevice(roomId, deviceId, event, data)`, `getClientCount(roomId)`.

---

## 8. API Reference — REST Endpoints

All routes prefixed with `/api`. All responses are `application/json` unless specified otherwise.

### Server

| Method | Path | Description |
|---|---|---|
| GET | `/api/server/info` | Server metadata (see 6.21) |
| GET | `/api/server/health` | `{ status: 'ok', uptime: number }` |

### Auth

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/auth/verify` | `{ pin }` | Verify PIN, set session cookie |
| POST | `/api/auth/logout` | — | Clear session cookie |
| GET | `/api/auth/status` | — | `{ authenticated: bool, pinRequired: bool }` |

### Rooms

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/rooms` | — | List all rooms |
| POST | `/api/rooms` | `{ name?, pin? }` | Create room |
| GET | `/api/rooms/:roomId` | — | Get room details |
| PATCH | `/api/rooms/:roomId` | `{ name?, pin? }` | Update room |
| DELETE | `/api/rooms/:roomId` | — | Delete room and all contents |

### Files

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/rooms/:roomId/files` | — | List files (metadata only) |
| POST | `/api/rooms/:roomId/files` | multipart `files[]` | Upload files |
| GET | `/api/rooms/:roomId/files/:fileId` | — | Get file metadata |
| PATCH | `/api/rooms/:roomId/files/:fileId` | `{ expiresAt?, pinned?, note? }` | Update metadata |
| DELETE | `/api/rooms/:roomId/files/:fileId` | — | Delete file |
| GET | `/api/rooms/:roomId/files/:fileId/download` | — | Download file (attachment) |
| GET | `/api/rooms/:roomId/files/:fileId/preview` | — | Preview file (inline) |
| GET | `/api/rooms/:roomId/files/zip` | — | Download all as ZIP |

### Text

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/rooms/:roomId/text` | — | List text entries |
| POST | `/api/rooms/:roomId/text` | `{ content, label? }` | Create text entry |
| PATCH | `/api/rooms/:roomId/text/:id` | `{ content?, label? }` | Update text entry |
| DELETE | `/api/rooms/:roomId/text/:id` | — | Delete text entry |

### Clipboard

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/rooms/:roomId/clipboard` | — | List clipboard entries |
| POST | `/api/rooms/:roomId/clipboard` | `{ content, type, label? }` | Add clipboard entry |
| DELETE | `/api/rooms/:roomId/clipboard/:id` | — | Delete clipboard entry |

### Devices

| Method | Path | Description |
|---|---|---|
| GET | `/api/rooms/:roomId/devices` | List connected devices |
| PATCH | `/api/rooms/:roomId/devices/:deviceId` | Update device name |

### Transfers

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/rooms/:roomId/transfers` | `{ fileId, targetDeviceId }` | Initiate device transfer |
| PATCH | `/api/rooms/:roomId/transfers/:id` | `{ action }` | Accept/decline transfer |
| GET | `/api/rooms/:roomId/transfers/:id/download` | — | Download transferred file |

### Events (SSE)

| Method | Path | Description |
|---|---|---|
| GET | `/events` | SSE stream. Query: `?roomId=&deviceId=` |

---

### Error Response Format

All errors follow this schema:
```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "File exceeds the maximum allowed size of 2 GB",
    "requestId": "abc-123",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

**Error Codes:**
```
AUTH_REQUIRED          401 — No session cookie, PIN required
AUTH_INVALID           401 — Wrong PIN
AUTH_LOCKED            429 — Too many wrong attempts
FILE_TOO_LARGE         413 — Exceeds per-file limit
STORAGE_FULL           507 — Exceeds total storage limit
FILE_NOT_FOUND         404 — File ID not in index
ROOM_NOT_FOUND         404 — Room ID not in index
ROOM_LIMIT_REACHED     409 — Max rooms exceeded
INVALID_BODY           400 — Request body validation failed
TEXT_TOO_LONG          400 — Text content exceeds limit
DEVICE_NOT_FOUND       404 — Device not connected
TRANSFER_NOT_FOUND     404 — Transfer ID not found
TRANSFER_EXPIRED       410 — Transfer timed out
RATE_LIMITED           429 — Rate limit exceeded
INTERNAL_ERROR         500 — Unexpected server error
```

---

## 9. API Reference — SSE Events

The `/events` endpoint streams events in the standard SSE format:
```
id: <eventId>\n
event: <type>\n
data: <JSON>\n\n
```

All events include `{ type, roomId, timestamp }` at the top level.

### Event Payloads

```
connected
  { serverInfo, room, files, textEntries, clipboardEntries, devices }

file:added
  { file: FileMetadata }

file:deleted
  { fileId }

file:updated
  { file: FileMetadata }

text:added
  { entry: TextEntry }

text:deleted
  { entryId }

text:updated
  { entry: TextEntry }

device:joined
  { device: Device }

device:left
  { deviceId }

clipboard:updated
  { entry: ClipboardEntry }

clipboard:deleted
  { entryId }

upload:progress
  { fileId, received, total, speed }  — sent only to the uploading device

transfer:incoming
  { transfer: Transfer }  — sent only to the target device

transfer:accepted
  { transferId }  — sent only to the initiating device

transfer:declined
  { transferId }  — sent only to the initiating device

transfer:expired
  { transferId }

room:updated
  { room: { id, name } }

server:shutdown
  { message, countdown }
```

---

## 10. File Storage Model

### Directory Layout
```
uploads/
  default/                    # default room
    abc12345-photo.jpg
    def67890-document.pdf
  xK9mP2qR/                   # custom room
    ghi11111-video.mp4
```

### In-Memory Index
The server maintains a complete in-memory index of all files. On startup, `storage.rebuildIndexFromDisk()` scans the uploads directory and reconstructs the index. Metadata NOT recoverable from disk (uploadedBy, downloadCount, note, pinned, expiresAt) is reset to defaults on rebuild.

To preserve metadata across restarts, write metadata to a sidecar file: `<fileId>.meta.json` alongside each file. On rebuild, this file is read and merged.

```
uploads/
  default/
    abc12345-photo.jpg
    abc12345.meta.json         # { uploadedBy, downloadCount, note, pinned, expiresAt }
```

### File Size Tracking
Total storage used is tracked in memory as a running sum. It is recalculated from disk on startup.

---

## 11. Session & Room Model

### Default Room
- ID: `default`
- Name: "Default Room"
- Always exists, cannot be deleted.
- All clients go here if no `?room=` param is specified.

### Room Lifecycle
```
Created → Active (has SSE clients or files) → Idle → Auto-deleted
                                                     (after 30m idle, if not default)
```

### Room Persistence
Rooms are in-memory. On server restart, only the default room is recreated. Custom rooms are lost (this is intentional — LocalShare is ephemeral by design). Files on disk for a room whose room object no longer exists are cleaned up on next startup.

### Switching Rooms (Client)
When a user switches rooms in the UI:
1. The current SSE connection is closed.
2. A new SSE connection is opened with the new `roomId`.
3. The URL is updated: `history.pushState({}, '', '?room=<newId>')`.
4. The UI is reset and populated with the new room's data from the `connected` event.

---

## 12. Authentication & PIN Protection Model

### Server-Level PIN
When `--pin` is provided:
- ALL routes except `/` (HTML), `/css/*`, `/js/*`, `/vendor/*`, `/assets/*`, `/api/auth/*` require a valid session cookie.
- The HTML page is always served (it shows the PIN entry UI if not authenticated).

### Room-Level PIN
A room can have its own PIN. When set:
- Joining the room (SSE connect) requires the room PIN in the `X-Room-Pin` header.
- All API calls for that room require the room PIN or a valid room session.
- Room PINs are independent of server PINs.

### Session Cookie
```
Name: localshare_session
Value: signed JWT (using crypto.createHmac with server-generated secret)
Attributes: HttpOnly, SameSite=Strict, Path=/
Max-Age: session (no explicit expiry — expires when browser closes)
Secure: only set if server is running on HTTPS (not in v1 — LocalShare is HTTP only on LAN)
```

### Rate Limiting (Auth)
- 3 wrong PIN attempts per IP → 30-second lockout.
- After lockout: 5 more attempts → 5-minute lockout.
- After 3rd lockout period: permanent block until server restart. (Log a warning.)
- Rate limit state is in-memory per IP address.

---

## 13. UI Specification

### 13.1 Layout & Structure

The app is a single-page application (SPA) with no client-side router library. Navigation is done by showing/hiding tabs.

**Overall layout:**
```
┌─────────────────────────────────────────────────────────┐
│  HEADER: logo | room selector | devices | theme | QR    │
├─────────────────────────────────────────────────────────┤
│  TABS: [Files] [Text] [Clipboard] [Devices]             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  TAB CONTENT AREA                                       │
│                                                         │
│  (Files tab default):                                   │
│  ┌─ UPLOAD ZONE ──────────────────────────────────────┐ │
│  │  Drop files here or [Choose Files] [Take Photo]   │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ FILE LIST ────────────────────────────────────────┐ │
│  │  [icon] filename.jpg    2.3 MB  2m ago  [↓][⋯]    │ │
│  │  [icon] document.pdf    450 KB  5m ago  [↓][⋯]    │ │
│  │  [icon] video.mp4       145 MB  1h ago  [↓][⋯]    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  [Download All (3 files)]                               │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  STATUSBAR: 3 files | 148 MB | 2 devices | uptime      │
└─────────────────────────────────────────────────────────┘
```

**Mobile layout (≤ 480px):** Same structure but:
- Header collapses to: logo | room name | [☰ menu button]
- Menu button opens a bottom sheet with: theme toggle, QR code, room selector, settings
- Tabs are full-width swipeable tabs
- File list items are touch-optimized (larger rows, swipe-to-delete via CSS overflow trick)
- Status bar is hidden (too small)

### 13.2 Color System (Light & Dark)

Design character: **clean utility tool** — like a well-made hardware app. No gradients. No decorative elements. Monochromatic base with a single accent color. Think: Transmit (the FTP client), not a marketing site.

**Light Mode:**
```css
--color-bg-base:        #F7F7F8;   /* very light grey, not white */
--color-bg-surface:     #FFFFFF;
--color-bg-elevated:    #FFFFFF;
--color-bg-overlay:     rgba(0, 0, 0, 0.4);
--color-border:         #E2E2E7;
--color-border-strong:  #ABABBA;
--color-text-primary:   #18181B;
--color-text-secondary: #71717A;
--color-text-disabled:  #A1A1AA;
--color-accent:         #2563EB;   /* clean blue — NOT Anthropic terracotta */
--color-accent-hover:   #1D4ED8;
--color-accent-text:    #FFFFFF;
--color-success:        #16A34A;
--color-warning:        #D97706;
--color-error:          #DC2626;
--color-info:           #0891B2;
--color-accent-subtle:  #EFF6FF;   /* bg for accent-tinted areas */
```

**Dark Mode:** (redefine same tokens)
```css
--color-bg-base:        #09090B;
--color-bg-surface:     #18181B;
--color-bg-elevated:    #27272A;
--color-bg-overlay:     rgba(0, 0, 0, 0.7);
--color-border:         #27272A;
--color-border-strong:  #52525B;
--color-text-primary:   #FAFAFA;
--color-text-secondary: #A1A1AA;
--color-text-disabled:  #52525B;
--color-accent:         #3B82F6;   /* slightly lighter for dark bg */
--color-accent-hover:   #60A5FA;
--color-accent-text:    #FFFFFF;
--color-success:        #22C55E;
--color-warning:        #F59E0B;
--color-error:          #EF4444;
--color-info:           #22D3EE;
--color-accent-subtle:  #1E3A5F;
```

### 13.3 Typography

**Font Stack:**
- UI: `'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- Monospace (file names, sizes, IDs, code): `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, 'Courier New', monospace`
- Inter is loaded from Google Fonts with `display=swap` and a local() fallback.
- If Google Fonts is blocked (air-gapped network), the system-ui fallback is visually fine.

**Type Scale:**
```
--text-xs:   11px / 1.4
--text-sm:   13px / 1.5
--text-base: 15px / 1.6
--text-lg:   17px / 1.5
--text-xl:   20px / 1.4
--text-2xl:  24px / 1.3
--text-3xl:  30px / 1.2
```

**Font weights used:** 400 (regular), 500 (medium), 600 (semibold). Never bold (700) in UI. Never thin (300).

### 13.4 Component Library

Every component listed below must be implemented. No component may use JavaScript when CSS alone is sufficient.

**Button:**
- Variants: `primary`, `secondary`, `ghost`, `danger`
- Sizes: `sm`, `md`, `lg`
- States: `default`, `hover`, `active`, `disabled`, `loading` (spinner inside button, text hidden)
- Primary: filled with `--color-accent`, white text
- Secondary: border with `--color-border-strong`, transparent bg
- Ghost: no border, no bg, uses text color
- Danger: filled red (`--color-error`)
- All buttons: border-radius 6px, no text transform, font-weight 500

**Input / Textarea:**
- Border: 1px solid `--color-border`
- Focus: border-color `--color-accent`, no outline (border IS the focus indicator)
- Error state: border-color `--color-error`, error message below in `--color-error`
- Placeholder: `--color-text-disabled`
- Border-radius: 6px
- Padding: 8px 12px (md size)

**File Row:**
- Height: 56px (comfortable tap target)
- Structure: `[icon 32px] [filename + size + meta] [expiry badge] [download btn] [more btn]`
- Filename: `--text-sm`, `--color-text-primary`, truncated with ellipsis if too long
- Meta (uploader, time): `--text-xs`, `--color-text-secondary`
- Hover state: `--color-bg-surface` with slight border highlight
- Selected state (keyboard navigation): `--color-accent-subtle` background, `--color-accent` left border
- Action buttons (download, more): appear on hover (opacity 0 → 1 transition), always visible on mobile

**Modal:**
- Backdrop: `--color-bg-overlay` with blur(4px)
- Dialog: `--color-bg-elevated`, border-radius 12px, max-width 560px, padding 24px
- Header: title (semibold), close button (top-right)
- Footer: action buttons, right-aligned
- Entry animation: scale(0.96) → scale(1) + opacity 0 → 1, 150ms ease-out
- Exit animation: scale(1) → scale(0.96) + opacity 1 → 0, 100ms ease-in

**Dropdown / Action Menu:**
- Opens below the trigger button (or above if near bottom of viewport)
- `--color-bg-elevated` background, `--color-border` border, border-radius 8px, shadow
- Items: 36px height, hover bg `--color-bg-surface`
- Danger items: red text color

**Progress Bar:**
- `<progress>` element, styled with CSS (appearance override)
- Track: `--color-border`, height 4px, border-radius 2px
- Fill: `--color-accent` (uploading), `--color-success` (complete), `--color-error` (failed)

**Badge:**
- Inline pill: border-radius 99px, padding 2px 8px
- Variants: `default`, `success`, `warning`, `error`, `info`
- `--text-xs`, `font-weight: 500`

**Tab Bar:**
- Full-width flex row
- Active tab: `--color-text-primary`, `--color-accent` bottom border (2px)
- Inactive tab: `--color-text-secondary`, no border
- Tab bar bottom border: `--color-border`

**Toast:**
- Fixed to bottom-right (desktop), bottom-center (mobile)
- Width: 320px max
- Shadow: `0 4px 12px rgba(0,0,0,0.15)`
- Border-left: 3px solid (type color)
- Icon + message + dismiss button
- Stack gap: 8px

**Device Avatar:**
- Circle, 32px diameter
- Background: hash-derived color (always same hue for same device ID)
- Text: first 2 chars of device name, uppercase, white, font-weight 600, 12px
- Tooltip: full device name on hover

**QR Modal:**
- White background always (even in dark mode) — QR codes need high contrast
- QR code image: 240×240px, centered
- URL text below: monospace, selectable, with copy button
- IP selector dropdown if multiple IPs

**Drag Overlay:**
- Position: fixed, inset 0, z-index 9999
- Background: `--color-accent` at 10% opacity
- Border: 2px dashed `--color-accent`
- Content: centered icon + text, large (48px icon)
- Pointer events: none when inactive

### 13.5 Responsive Breakpoints
```css
/* Mobile first */
/* base: 0–479px (phone) */
@media (min-width: 480px)  { /* large phone */ }
@media (min-width: 640px)  { /* tablet portrait */ }
@media (min-width: 768px)  { /* tablet landscape */ }
@media (min-width: 1024px) { /* desktop */ }
@media (min-width: 1280px) { /* large desktop — no major changes */ }
```

### 13.6 Animations & Transitions
```
All transitions: 150ms ease (default)
Modal open:      150ms ease-out (scale + fade)
Modal close:     100ms ease-in  (scale + fade)
Toast enter:     200ms ease-out (slide up + fade)
Toast exit:      150ms ease-in  (fade)
Tab switch:      instant (no animation — prevents motion sickness)
File row appear: 200ms ease-out (fade in from slight bottom)
File row delete: 200ms ease-in  (fade out + collapse height)
Drop overlay:    100ms ease     (fade in/out)
Button press:    80ms ease      (scale 0.98)
Expiry pulse:    1s ease-in-out, infinite (opacity 0.6 ↔ 1.0)
```

### 13.7 Loading States
- Initial page load: skeleton UI (CSS-only grey pulse animation on file list rows)
- SSE reconnecting: subtle banner at top: "Reconnecting..." in yellow
- File upload: per-file progress (see 6.7)
- ZIP generation: "Preparing download..." button state with spinner
- Any API call: the triggering button shows a spinner

### 13.8 Empty States

**No files:**
```
[Upload icon, large, --color-text-disabled]
No files yet
Drag files here or click "Upload" to get started
```

**No text entries:**
```
[Text icon]
Nothing shared yet
Type something above and click "Share Text"
```

**No devices:**
```
[Device icon]
Only you here
Scan the QR code or open this URL on another device
[QR button]
```

**No clipboard entries:**
```
[Clipboard icon]
Clipboard is empty
Enable clipboard sync to share copied text across devices
[Settings link]
```

### 13.9 Error States

**Server disconnected (SSE lost):**
- Full-page overlay: "Connection lost — Reconnecting in Xs..." with a progress ring
- Buttons disabled while disconnected
- Auto-reconnects with exponential backoff (1s, 2s, 4s, 8s, max 30s)

**Upload failed:**
- Error inline in the upload queue row, with the specific error message
- "Retry" button on the failed item

**Room not found:**
- The room selector shows "Room not found" and redirects to default room

---

## 14. CLI Interface

### Usage
```
localshare [options]

Options:
  -p, --port          Port to listen on                [number] [default: 3000]
  -d, --dir           Upload storage directory        [string] [default: ./uploads]
  -P, --pin           PIN for server-level auth        [string]
  -H, --host          Host to bind to                  [string] [default: 0.0.0.0]
  --max-file-size     Max file size in bytes/MB/GB     [string] [default: 2GB]
  --max-storage       Max total storage                [string] [default: 10GB]
  --expiry            Default file expiry (e.g. 24h, 7d, never) [string] [default: 24h]
  --max-rooms         Maximum number of rooms          [number] [default: 20]
  --max-connections   Maximum SSE connections          [number] [default: 500]
  --no-cleanup        Disable automatic file cleanup   [boolean]
  --no-qr             Don't print QR code to terminal  [boolean]
  --no-color          Disable terminal colors          [boolean]
  --log-level         Log level (trace,debug,info,warn,error,silent) [default: info]
  --log-format        Log format (pretty, json)        [string] [default: pretty]
  --config            Path to config file              [string]
  --version           Show version                     [boolean]
  --help              Show help                        [boolean]

Examples:
  localshare                            Start on default port 3000
  localshare -p 8080                    Start on port 8080
  localshare --pin 1234                 Require PIN 1234 to access
  localshare --expiry never --no-cleanup  Keep files forever
  localshare --max-file-size 500MB      Limit uploads to 500 MB
  localshare --dir /tmp/share           Store uploads in /tmp/share
```

### Startup Output (Terminal)
```
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │   📂  LocalShare v1.0.0                             │
  │                                                     │
  │   Local:    http://localhost:3000                   │
  │   Network:  http://192.168.1.42:3000  ◄── primary  │
  │   Network:  http://10.0.0.55:3000                  │
  │                                                     │
  │   QR Code (scan to open on phone):                  │
  │                                                     │
  │   [QR CODE IN UNICODE BLOCKS HERE]                  │
  │                                                     │
  │   PIN protection: disabled                          │
  │   File expiry:    24 hours                          │
  │   Max file size:  2 GB                              │
  │   Storage dir:    ./uploads                         │
  │                                                     │
  │   Press Ctrl+C to stop                              │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

---

## 15. Configuration System

### Config File Loading (cosmiconfig)
LocalShare looks for configuration in these places (in order, first found wins):
1. `--config` CLI flag (explicit path)
2. `localshare.config.json` in current directory
3. `localshare.config.js` in current directory
4. `.localsharc` in current directory
5. `package.json` field `"localshare": { ... }`
6. `localshare.config.json` in `~/.config/localshare/`

### Config Schema
```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "dir": "./uploads",
  "pin": null,
  "maxFileSize": "2GB",
  "maxStorage": "10GB",
  "expiry": "24h",
  "maxRooms": 20,
  "maxConnections": 500,
  "cleanup": true,
  "qr": true,
  "logLevel": "info",
  "logFormat": "pretty"
}
```

### Size Parsing
`maxFileSize` and `maxStorage` accept: `"500MB"`, `"2GB"`, `"1024"` (bytes), `1073741824` (number in bytes). A dedicated `parseSize(str)` utility handles this.

### Duration Parsing
`expiry` accepts: `"24h"`, `"7d"`, `"30m"`, `"never"`, `0` (same as never). A dedicated `parseDuration(str)` utility returns milliseconds or `null` for never.

### Priority
CLI args > config file > defaults. Values are merged (not replaced) at the key level.

---

## 16. Logging System

### Logger: pino

All logging goes through `src/logger.js` which exports a configured pino instance.

**Log levels and when to use them:**
- `trace` — per-request details (headers, body sizes). Dev only.
- `debug` — internal state changes (room created, file indexed, SSE client added).
- `info` — meaningful lifecycle events (server started, file uploaded, device joined).
- `warn` — recoverable issues (cleanup failed for a file, SSE client disconnected unexpectedly).
- `error` — failures that affect a user request (upload failed, disk write error).
- `fatal` — unrecoverable errors (port in use, upload dir not writable).

**Log format (pretty, dev):**
```
[10:30:00.123] INFO (localshare): File uploaded
    fileId: "abc12345"
    room: "default"
    name: "photo.jpg"
    size: 2407168
    by: "QuickFox"
```

**Log format (json, production/structured):**
```json
{"level":30,"time":1705312200123,"msg":"File uploaded","fileId":"abc12345","room":"default","name":"photo.jpg","size":2407168,"by":"QuickFox","reqId":"req-xyz"}
```

**Request logging:**
Every request is logged at the end of the response cycle with:
`method`, `url`, `status`, `responseTime` (ms), `reqId`, `userAgent` (truncated).

---

## 17. Error Handling Contract

### Server-Side

**All route handlers are wrapped in a try/catch.** Use a `asyncRoute(fn)` wrapper:
```js
// src/middleware/asyncRoute.js
export const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
```

**Global error handler** (`src/middleware/errorHandler.js`):
- Catches all errors passed to `next(err)`.
- Determines HTTP status from `err.status` or defaults to 500.
- Sends the standardized error response format.
- Logs at `error` level with `err.stack`.
- Never exposes stack traces in production response bodies.
- `NODE_ENV=development` may include `stack` in the error response for easier debugging.

**Known errors** are instances of `AppError`:
```js
class AppError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
```

**Unknown errors** (e.g., disk full during write) are caught, wrapped as `INTERNAL_ERROR`, and logged with full stack.

### Client-Side

**All `fetch()` calls** go through `api.js` which:
- Wraps the response in a `Result` object: `{ ok, data, error }`.
- Never throws to the caller — returns an error result instead.
- Logs errors to the browser console with context.
- Shows a toast notification for API errors (configurable per-call).

---

## 18. Security Model

### Network Scope
LocalShare binds to `0.0.0.0` by default, making it accessible from the local network. This is intentional. It can be restricted to `127.0.0.1` with `--host 127.0.0.1`.

### HTTP Headers (helmet)
All responses include:
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0           (disabled — modern browsers don't need it, it can be harmful)
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';
```

Note: The CSP must allow `data:` in `img-src` for the QR code data URI.

### File Upload Security
- Filename sanitization: strip path components, disallow `..`, replace special chars.
  Use a `sanitizeFilename(name)` function. Max filename length: 255 chars.
- MIME type validation: NOT done by extension alone. The `mimeType` stored is `mime-types.lookup(filename) || 'application/octet-stream'`. We do NOT attempt to read file magic bytes in v1 (performance concern for large files) but stub this for future.
- No file execution: files are NEVER executed. They are served with `Content-Disposition: attachment`.
- Upload directory is outside the web root. It is NEVER served by `serve-static`. Files are only accessible via the dedicated download endpoint.
- Symlink attack: the upload directory is created with a `realpath` check.

### Path Traversal Prevention
- All room IDs and file IDs are validated against a regex: `/^[a-zA-Z0-9_-]{1,32}$/`
- File paths are constructed as `path.join(uploadsDir, roomId, storedFilename)` where `storedFilename` is sanitized.
- After construction, verify the resolved path starts with `uploadsDir` using `realpath`.

### CSRF Protection
- No forms with state-changing side effects. All mutating requests are `fetch()` with JSON bodies.
- The SSE connection uses query params, not cookies, for identification.
- PIN session cookie: `SameSite=Strict` prevents CSRF for the PIN flow.

### Rate Limiting
- All API routes: 100 requests per 15 minutes per IP (configurable).
- `/api/auth/verify`: 5 requests per minute per IP (separate, stricter limit).
- `/api/rooms/:roomId/files` (upload): 10 uploads per minute per IP.
- Rate limiter uses in-memory store (not Redis — LocalShare is single-process).

### DoS Protection
- Max body size for JSON endpoints: 100KB (express.json `limit` option).
- Max text entry size: 100KB.
- Max filename length: 255 bytes.
- Max number of files per room: 200 (configurable).
- Slow-read attack: use `req.socket.setTimeout(30000)` for file downloads.

---

## 19. Performance Contracts

These are the performance targets that must be met on a modern consumer laptop (e.g., MacBook Pro M1, 16GB RAM) serving a LAN network.

| Metric | Target |
|---|---|
| Server startup time | < 500ms from node spawn to HTTP listening |
| Time to first byte (HTML) | < 20ms from receipt of request |
| SSE `connected` event | < 50ms from SSE connection established |
| File list API | < 10ms for ≤ 200 files |
| File upload throughput | > 100 MB/s to localhost (disk I/O bound, not CPU) |
| ZIP generation start | < 1s for ≤ 10 files |
| Memory usage at idle | < 50 MB RSS |
| Memory usage under load (100 concurrent SSE connections) | < 150 MB RSS |
| CPU usage at idle | ~0% |
| SSE broadcast latency (server to client) | < 50ms |

### Optimization Rules
- DO NOT read entire files into memory. Always stream.
- DO NOT block the event loop with synchronous disk operations. All disk I/O is async.
- DO NOT send unnecessary SSE events. Debounce rapid-fire updates (e.g., upload progress) to max 4 per second.
- The in-memory file index is always the authoritative source. Disk is the persistence layer. Never `readdir` on a hot path.

---

## 20. Open Source Repository Standards

### 20.1 README.md (Full Specification)

The README must contain these sections in this order:

1. **Logo + name** — The `logo.svg` centered, then `# LocalShare` heading
2. **Tagline** — One-line description
3. **Badges** — npm version, license, CI status (GitHub Actions badge), Node version
4. **Demo** — A screenshot (reference `docs/screenshots/demo-light.png` and `docs/screenshots/demo-dark.png`). The agent must create placeholder images (1px white/black PNGs) with a note to replace them.
5. **Features** — A clean bulleted list with emojis for each major feature:
   ```
   ✨ Drag-and-drop file upload
   📱 QR code to open on any device
   🔐 Optional PIN protection
   📋 Clipboard sync across devices
   👥 Real-time device presence
   📦 Download all files as ZIP
   🌙 Dark mode
   ⌨️  Full keyboard shortcuts
   🚀 Zero config — one command to start
   ... (list all features)
   ```
6. **Quick Start** — Three commands: `npx localshare`, or `npm install -g localshare && localshare`, or Docker
7. **Installation** — All three methods with full code blocks
8. **Usage** — `localshare --help` output as a code block
9. **Configuration** — Table of all config options with type, default, and description
10. **Config File** — Example `localshare.config.json`
11. **API** — Brief mention that a full API reference is in `docs/api.md`
12. **Docker** — The Docker run command and docker-compose example
13. **Contributing** — One paragraph + link to `CONTRIBUTING.md`
14. **License** — MIT

### 20.2 CONTRIBUTING.md

Contents:
- How to clone and run in dev mode
- Code style (Prettier + ESLint — run `npm run lint` and `npm run format` before PRs)
- How to run tests (`npm test`, `npm run test:watch`, `npm run test:coverage`)
- Branch naming convention: `feat/`, `fix/`, `docs/`, `chore/`
- PR expectations: a test for each bug fix, a description of what changed and why
- Issue triage labels explained
- How to report a security vulnerability (email first, not a public issue)

### 20.3 CODE_OF_CONDUCT.md

Use the Contributor Covenant v2.1, verbatim.

### 20.4 CHANGELOG.md

Use [Keep a Changelog](https://keepachangelog.com) format:
```
# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.
LocalShare adheres to Semantic Versioning.

## [Unreleased]

## [1.0.0] - YYYY-MM-DD

### Added
- (list every feature from the spec)
```

### 20.5 LICENSE

MIT license with `Copyright (c) 2024 LocalShare Contributors`.

### 20.6 `.github/` Directory

**`workflows/ci.yml`:**
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x, 22.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node-version }}' }
      - run: npm ci
      - run: npm run lint
      - run: npm test
```

**`workflows/release.yml`:**
```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20.x', registry-url: 'https://registry.npmjs.org' }
      - run: npm ci
      - run: npm test
      - run: npm publish
        env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
```

**`ISSUE_TEMPLATE/bug_report.md`:** Standard bug report with: Environment (OS, Node version, LocalShare version), Steps to reproduce, Expected behavior, Actual behavior, Logs.

**`ISSUE_TEMPLATE/feature_request.md`:** Problem description, proposed solution, alternatives considered, additional context.

**`pull_request_template.md`:** Checklist: description of change, tests added/updated, docs updated, ran `npm test` and `npm run lint`.

### 20.7 package.json Fields

Beyond the dependency manifest, include:
```json
{
  "homepage": "https://github.com/localshare/localshare#readme",
  "repository": {
    "type": "git",
    "url": "https://github.com/localshare/localshare.git"
  },
  "bugs": {
    "url": "https://github.com/localshare/localshare/issues"
  },
  "funding": {
    "type": "github",
    "url": "https://github.com/sponsors/localshare"
  }
}
```

---

## 21. Testing Requirements

### Test Framework: Vitest

### Coverage Targets (enforced by CI)
- Statements: ≥ 80%
- Branches: ≥ 75%
- Functions: ≥ 80%
- Lines: ≥ 80%

### Unit Tests — Required Coverage

**`storage.test.js`:**
- `saveFile` writes to correct path
- `saveFile` rejects oversized files
- `readFile` returns stream for existing file
- `readFile` throws FILE_NOT_FOUND for missing file
- `deleteFile` removes file and meta sidecar
- `rebuildIndexFromDisk` correctly reconstructs metadata from sidecars
- `rebuildIndexFromDisk` handles missing meta sidecar gracefully
- `calculateTotalSize` returns correct sum

**`config.test.js`:**
- Defaults are applied when no config is provided
- CLI args override defaults
- Config file overrides defaults
- CLI args override config file
- Invalid port number throws with helpful message
- `parseSize('2GB')` returns correct bytes
- `parseSize('500MB')` returns correct bytes
- `parseDuration('24h')` returns correct ms
- `parseDuration('never')` returns null

**`network.test.js`:**
- `getLocalIPs()` returns at least one IP
- `getLocalIPs()` excludes loopback
- `getPrimaryIP()` prefers 192.168.x.x over 10.x.x.x

**`auth.test.js`:**
- `hashPin('1234')` produces different outputs each call (salt)
- `verifyPin('1234', hash)` returns true for correct PIN
- `verifyPin('9999', hash)` returns false for wrong PIN
- Rate limiter blocks after 3 failed attempts
- Rate limiter unblocks after lockout period

**`rooms.test.js`:**
- `createRoom()` creates room with default values
- `createRoom({ name })` uses provided name
- `getRoom('default')` always returns a room
- `getRoom('nonexistent')` throws ROOM_NOT_FOUND
- `deleteRoom('default')` throws (cannot delete default)
- Auto-delete fires for idle custom rooms after threshold

### Integration Tests — Required Coverage

**`upload.test.js`** (using supertest):
- POST /api/rooms/default/files with valid file returns 201 + metadata
- POST with oversized file returns 413 with FILE_TOO_LARGE code
- POST without file returns 400
- POST with PIN-protected server without auth returns 401
- Multiple file upload in one request returns array of metadata

**`download.test.js`:**
- GET /api/rooms/default/files/:id/download returns file stream
- GET with invalid fileId returns 404 with FILE_NOT_FOUND
- GET with Range header returns 206 partial content
- GET /zip returns ZIP stream with correct files
- GET /zip on empty room returns 200 with empty zip (or 400)

**`text.test.js`:**
- POST creates text entry, returns 201
- GET returns list including new entry
- POST with too-long content returns 400
- DELETE removes entry, returns 204

**`sse.test.js`:**
- Connecting to /events returns text/event-stream content-type
- Connection receives `connected` event within 1 second
- Uploading a file broadcasts `file:added` event to other clients
- Deleting a file broadcasts `file:deleted` event
- Heartbeat ping is sent within 20 seconds

**`auth.test.js`:**
- All API routes return 401 when PIN is set and no cookie
- POST /api/auth/verify with correct PIN sets cookie and returns 200
- POST /api/auth/verify with wrong PIN returns 401 with retriesLeft
- After 3 wrong attempts, returns 429 with lockout duration

---

## 22. Build & Release Pipeline

### Version Management
- Version is in `package.json` only (single source of truth).
- Follows Semantic Versioning: MAJOR.MINOR.PATCH.
- `scripts/release.js` does: version bump, CHANGELOG update, `git tag`, `git push`.

### npm Publish
- `npm run release patch|minor|major` — bumps version, commits, tags, triggers CI release workflow.
- Published package includes only: `bin/`, `src/`, `public/`, `README.md`, `LICENSE`, `CHANGELOG.md` (per `.npmignore`).
- Published package size target: < 2MB.

### npx Support
- `bin/localshare.js` has `#!/usr/bin/env node` shebang.
- `chmod +x` is set in the npm `prepare` script.
- `npx localshare` must work without any prior installation.

---

## 23. Docker Support

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY ../../Downloads .
EXPOSE 3000
VOLUME ["/app/uploads"]
ENTRYPOINT ["node", "bin/localshare.js"]
CMD ["--dir", "/app/uploads"]
```

**Build optimizations:**
- Use Alpine base image.
- Multi-stage build is NOT needed (no compile step).
- `npm ci --omit=dev` to skip devDependencies.
- `.dockerignore` includes: `node_modules/`, `uploads/`, `test/`, `.git/`, `docs/screenshots/`.

### docker-compose.yml
```yaml
version: '3.8'
services:
  localshare:
    image: localshare/localshare:latest
    ports:
      - "3000:3000"
    volumes:
      - ./uploads:/app/uploads
    environment:
      - LOCALSHARE_PORT=3000
    restart: unless-stopped
```

### Environment Variable Support
All CLI flags can also be set via environment variables prefixed with `LOCALSHARE_`:
- `LOCALSHARE_PORT=8080`
- `LOCALSHARE_PIN=1234`
- `LOCALSHARE_MAX_FILE_SIZE=500MB`
- `LOCALSHARE_EXPIRY=7d`
- `LOCALSHARE_LOG_LEVEL=debug`
- `LOCALSHARE_DIR=/data/uploads`

Environment variables have lower priority than CLI flags but higher than config file.

---

## 24. Novel Feature Deep-Dives

### 24.1 Peer Clipboard Sync — Implementation Notes

The core challenge is browser clipboard security. `navigator.clipboard.readText()` requires user gesture AND a permissions grant. We CANNOT silently read the user's clipboard.

**The design therefore works on PUSH, not PULL:**
- User explicitly pastes into our UI (the paste listener on the window), OR
- User explicitly clicks "Share from Clipboard" which calls `navigator.clipboard.readText()` with proper user activation.
- The server stores the clipboard content.
- Other devices receive it as an SSE event and display a toast.
- The receiving device taps the toast and calls `navigator.clipboard.writeText(content)`.

**Clipboard entry data model:**
```js
{
  id: 'nanoid(8)',
  roomId: 'string',
  content: 'string',
  type: 'text',                    // 'text' | 'image' (future)
  label: 'string | null',          // user-provided label
  sharedAt: 'ISO8601',
  sharedBy: 'string',              // deviceId
  sharedByName: 'string',          // device name snapshot
  expiresAt: 'ISO8601',            // 30 min from creation
  size: number,                    // content.length for text
}
```

**Permission handling:**
```
if navigator.clipboard.writeText is not available:
  → show text in a modal with "Click to copy" button that uses execCommand
if permission is denied:
  → show the content as selectable text with a manual copy instruction
if permission is granted:
  → write directly, confirm with ✓ icon
```

### 24.2 Send-to-Device — Implementation Notes

**Security:** The download endpoint for a pending transfer ONLY works for the target device (checked by `X-Device-Id` header). If any other device tries to download, it gets a 403.

**Clean-up:** Pending transfers are stored in memory. On expiry (60s), the file is deleted from disk and the transfer object is removed. The initiating device gets a `transfer:expired` SSE event.

**File storage:** The transferred file is stored in `uploads/_transfers/<transferId>/<filename>` — a separate directory from room files.

**Declined transfers:** The file is deleted immediately. A `transfer:declined` event is sent to the initiator.

**Re-inviting:** The same file can be re-sent if the first transfer is declined (it creates a new transfer with a new ID).

### 24.3 Session Rooms — Multi-Room Isolation

Each room has its own SSE subscriber set. A broadcast for room `A` NEVER reaches clients in room `B`. This is enforced by the `broadcast(roomId, event, data)` function in `sse.js` which iterates only over `clients.get(roomId)`.

The upload directory structure enforces this: `uploads/<roomId>/`. A multer `diskStorage` destination function is parameterized by room ID extracted from `req.params.roomId`.

### 24.4 Device Name Generation

The name generation is deterministic per device but random across devices:
- On first page load, `localStorage.getItem('localshare_deviceId')` is checked.
- If absent: `deviceId = nanoid(12)`, stored in localStorage.
- `deviceName` = `generateDeviceName(deviceId)` using a hash of the ID to seed the adjective/animal selection.
- This means the same device always gets the same generated name, even after a page refresh.
- Users can rename their device in the Devices tab.

---

## 25. Edge Cases & Known Gotchas

Every item here MUST be handled explicitly in code. Do not leave these as "future work".

### Upload Edge Cases
1. **User closes browser mid-upload** — multer will detect the closed connection. The partially-written file must be cleaned up. Use multer's `error` event to delete partial files.
2. **Disk full during upload** — catch `ENOSPC` errno from the write stream, return 507, delete partial file.
3. **Two users upload the same filename simultaneously** — each gets a unique `fileId`, so the stored filename includes the ID. No collision possible.
4. **Filename with only special characters** — `sanitizeFilename` must produce a non-empty result. Fallback: `'unnamed_file'`.
5. **Zero-byte file upload** — valid. Store it. It will show as "0 B" in the UI.
6. **Upload interrupted and resumed** — v1 does NOT support resumable uploads. If an upload fails, the user retries from the beginning. Stub the API for chunked upload in future.

### SSE Edge Cases
7. **Nginx/proxy timeout** — the 15-second heartbeat prevents this. Document in README that proxies should set `proxy_read_timeout 3600s` for SSE endpoints.
8. **Client reconnects with stale `Last-Event-ID`** — the in-memory event buffer holds the last 50 events per room. If the client missed more than 50 events, send the full room state as a new `connected` event instead of replaying individual events.
9. **1000 clients connect simultaneously** — the `max-connections` limit (default 500) prevents memory exhaustion. Clients over the limit get a 503 with `Retry-After: 30`.

### File Expiry Edge Cases
10. **Clock skew** — expiry is calculated in absolute UTC timestamps (ISO8601). No relative timers that drift.
11. **Server restart during expiry window** — on startup, the cleanup job immediately runs and deletes any files whose `expiresAt` is in the past.
12. **File pinned then un-pinned** — when un-pinned, if the file's original `expiresAt` has already passed, the file is immediately deleted.

### Network Edge Cases
13. **Multiple network interfaces** — handled (see 6.6). QR code defaults to most likely Wi-Fi interface.
14. **Port already in use** — catch `EADDRINUSE` on `server.listen()`. Print a clear error: "Port 3000 is already in use. Try `localshare --port 3001`." Exit with code 1.
15. **IPv6-only interface** — `getLocalIPs()` includes IPv6 addresses but formats them correctly in URLs: `http://[::1]:3000/`.

### Auth Edge Cases
16. **Cookie cleared by browser** — user must re-enter PIN. No recovery path.
17. **PIN set to '0000'** — valid PIN. Do not add any PIN blacklist.
18. **Server restarted with PIN** — the session secret changes on restart. All existing sessions are invalidated. Users must re-enter PIN after server restart. This is by design and should be documented.

### Storage Edge Cases
19. **`uploads/` directory deleted while server is running** — the cleanup job will fail to delete files. Log a `warn`. The next startup will recreate the directory.
20. **Files added to `uploads/` externally** — by default, these are ignored (no chokidar watching). With `--watch` flag (future feature), they would be indexed.
21. **Max files per room reached** — new upload returns 409 with `ROOM_FULL` error code and message: "This room has reached the maximum of N files. Delete some files before uploading more."

---

## 26. Implementation Order (Recommended)

Follow this order to build a working app as fast as possible, with features layering on:

**Phase 1 — Working skeleton (can upload and download):**
1. `src/config.js` — defaults only, no file loading yet
2. `src/logger.js`
3. `src/network.js`
4. `src/storage.js` — save and read files only
5. `src/rooms.js` — single default room only
6. `src/server.js` — bare Express app with multer
7. `src/routes/files.js` — POST upload, GET download
8. `public/index.html` — minimal: file input, upload button, file list
9. `bin/localshare.js` — starts server, prints URL to terminal
10. Verify: can upload and download a file from another device

**Phase 2 — Real-time + text:**
11. `src/sse.js`
12. `src/routes/events.js`
13. `public/js/sse.js` + `public/js/store.js`
14. SSE-driven file list updates
15. `src/routes/text.js`
16. Text tab in UI

**Phase 3 — UX polish:**
17. Drag-and-drop
18. Progress bars
19. Toast notifications
20. Dark mode
21. QR code (terminal + UI modal)
22. Keyboard shortcuts
23. Device presence

**Phase 4 — Power features:**
24. Session rooms
25. PIN protection
26. File expiry
27. ZIP download
28. File preview modal
29. Clipboard sync
30. Send-to-device

**Phase 5 — Production hardening:**
31. Security headers (helmet)
32. Rate limiting
33. Graceful shutdown
34. All edge cases from Section 25
35. Full test suite
36. Docker support
37. All open source files (README, CONTRIBUTING, etc.)

---

## 27. Acceptance Criteria Checklist

The agent's output is complete only when every item below is verifiable:

### Functional
- [ ] `npx localshare` (simulated) starts a server with no config
- [ ] Server prints URL and QR code to terminal on start
- [ ] File can be uploaded from a browser
- [ ] Uploaded file appears in the file list
- [ ] File appears in real-time on another connected browser (SSE)
- [ ] File can be downloaded
- [ ] All files can be downloaded as a single ZIP
- [ ] Text can be shared between devices in real-time
- [ ] QR code opens in a modal with the correct URL
- [ ] Clipboard sync works: shared text appears as a toast on other devices
- [ ] Dark mode toggle works and persists across page refresh
- [ ] PIN protection blocks API access and serves PIN entry UI
- [ ] Correct PIN grants access; wrong PIN is rejected with rate limiting
- [ ] File expiry countdown is shown and files are deleted when expired
- [ ] Device presence list updates in real-time
- [ ] Send-to-device: recipient gets a modal to accept or decline
- [ ] All keyboard shortcuts work as specified
- [ ] File preview modal works for images, text, PDF, video, audio
- [ ] Graceful shutdown broadcasts to clients before closing

### Code Quality
- [ ] No `console.log` in production code (use logger)
- [ ] No `TODO` comments without a linked issue or inline explanation
- [ ] All `async` functions have proper error handling
- [ ] No hardcoded port, path, or configuration values (all from config)
- [ ] `npm test` passes with ≥ 80% coverage
- [ ] `npm run lint` produces zero errors
- [ ] `npm run format -- --check` produces zero changes

### Repository
- [ ] `README.md` is complete per Section 20.1
- [ ] `CONTRIBUTING.md` is present and complete
- [ ] `CODE_OF_CONDUCT.md` is present (Contributor Covenant)
- [ ] `CHANGELOG.md` is present with v1.0.0 entry
- [ ] `LICENSE` is MIT
- [ ] `.github/workflows/ci.yml` is present and syntactically valid
- [ ] `Dockerfile` is present and builds successfully
- [ ] `docker-compose.yml` is present
- [ ] `.gitignore` includes `node_modules/`, `uploads/`, `.env`
- [ ] `.npmignore` is present and excludes test/, docs/, .github/
- [ ] `package.json` has all required fields including `bin`, `engines`, `files`

### Accessibility
- [ ] All interactive elements are keyboard-focusable
- [ ] All icon buttons have `aria-label`
- [ ] Modal closes on Escape and traps focus
- [ ] Toasts have `aria-live="polite"` container
- [ ] Color contrast ratios pass WCAG AA for all text

### Security
- [ ] Upload filenames are sanitized (no path traversal)
- [ ] Downloads use `Content-Disposition: attachment`
- [ ] Helmet security headers are set on all responses
- [ ] Rate limiting is active on auth and upload endpoints
- [ ] PIN is stored as scrypt hash, never plaintext

### Performance
- [ ] Files are streamed, not read into memory
- [ ] ZIP is generated as a stream, not buffered in memory
- [ ] SSE heartbeat is sent every 15 seconds

---

*End of PROMPT.md*

---

> **Agent note:** This document is the single source of truth.  
> When two sections appear to conflict, the more specific section wins.  
> When something is unspecified, choose the simpler, more auditable option.  
> Leave a `// WHY: ...` comment explaining any deviation from this spec.
