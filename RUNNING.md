# Running LocalShare

This file exists because two separate things were confusing everyone:

1. **A stale Docker container** was serving port 3000 from a snapshot baked into
   the image at build time. Editing files in this repo changed nothing, because
   the container was not reading them.
2. **Browser caching** made it look like nothing was changing even when the
   server _was_ serving the new code.

Read the section for your setup. Section 1 is enough for local development.

---

## 1. Run it directly from this folder (recommended for development)

No Docker, no build step, no container. Node 18 or newer.

```bash
cd /home/Preonic/localshare
npm install          # first time only
npm start
```

Then open:

- **http://localhost:3000** — on the PC itself
- **http://<your-pc-ip>:3000** — from your phone, e.g. `http://192.168.1.110:3000`

To use a different port (useful if 3000 is taken):

```bash
node bin/localshare.js --port 3001
# or, via the environment:
LOCALSHARE_PORT=3001 npm start
```

The environment variable is `LOCALSHARE_PORT`. A bare `PORT` is ignored, which
means `PORT=3001 npm start` silently starts on 3000 and appears to do nothing.

`npm start` runs `node bin/localshare.js`, which reads the `uploads/` folder next
to the repo by default. Nothing needs to be compiled or generated — the server
serves `public/` straight off disk, so every save is live on the next reload.

### Automatic reload while you edit

```bash
npm run dev
```

This runs the same server under `nodemon`, restarting on changes to `src/`,
`bin/`, or `test/`.

---

## 2. Get your changes past the browser cache

CSS and JS are served with `Cache-Control: no-cache`, which means the browser
revalidates them on every load instead of reusing them blindly. It still needs a
validating request to succeed, so **if you changed nothing on disk, a normal
refresh will correctly keep showing you the old version.**

Hard refresh, once:

- **Windows / Linux:** `Ctrl` + `Shift` + `R`
- **macOS:** `Cmd` + `Shift` + `R`

If a change still refuses to appear, the browser is serving a memory-cached or
disk-cached copy. Force it one more time:

- **Chrome / Edge:** open DevTools (`F12`), then `Ctrl` + `Shift` + `R`.
- **Firefox / Safari:** clear the cache for `localhost:3000` in the site settings.

### Confirming you are looking at fresh code

Ask the server what it is actually sending:

```bash
curl -sI http://localhost:3000/css/components.css | grep -i cache-control
```

`no-cache` is correct and expected. If you see `max-age=3600` instead, you are
hitting an old server process and should restart it.

---

## 3. Free port 3000 from an old container

If something is already bound to port 3000, `npm start` fails with `EADDRINUSE`.
Find out what it is:

```bash
sudo ss -tlnp | grep ':3000'
```

If the result is a Docker container (the `docker-proxy` process), stop it:

```bash
sudo docker compose down
```

If it is a container started some other way:

```bash
sudo docker ps                 # find the container
sudo docker stop <container>
```

The simplest way to avoid the whole problem is to run on a different port with
`node bin/localshare.js --port 3001` and use `http://localhost:3001`.

---

## 4. Run it with Docker

```bash
sudo docker compose up -d --build
```

`--build` matters. Without it Docker reuses the existing image, and you get the
old code back with no warning.

`docker-compose.yml` mounts `./public` into the container, so **front-end changes
(`public/**`) appear on a plain browser refresh with no rebuild at all.** That
mount was missing before, which is why CSS and JS edits appeared to do nothing.

Changes to `src/` or `bin/` run on the server, so they cannot be hot-swapped —
rebuild for those:

```bash
sudo docker compose up -d --build
```

---

## 5. Deploying to a VPS with a domain

Yes, it is designed to run that way. It is a single Node process with a mounted
`uploads/` directory and no database.

**Requirements:** Node 18+, and a public or LAN-reachable port.

### With a reverse proxy (recommended)

Point nginx or Caddy at the app, terminate TLS there, and the app keeps running
on an internal port.

```nginx
server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    # SSE needs buffering off, or events arrive in batches instead of live.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto  $scheme;

        proxy_buffering off;          # required for Server-Sent Events
        proxy_read_timeout 3600s;     # stop long-lived SSE streams being cut
    }
}
```

`proxy_buffering off` is the one setting people miss. With buffering on, nginx
holds SSE events back and the UI sits there showing "Reconnecting..." even
though the stream is perfectly healthy.

The app trusts proxy headers for the URLs it prints on the QR code and in the
"share this link" text, so it will show `https://files.example.com/...` rather
than an internal address.

### As a systemd service

```ini
[Unit]
Description=LocalShare
After=network.target

[Service]
Type=simple
User=localshare
WorkingDirectory=/opt/localshare
ExecStart=/usr/bin/node bin/localshare.js --dir /var/lib/localshare/uploads
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now localshare
sudo journalctl -u localshare -f
```

### Persistent storage

Everything lives in the uploads directory. Back up that one folder to back up
user data:

```bash
sudo rsync -a /var/lib/localshare/uploads/ /backup/localshare/
```

---

## 6. Quick reference

| Task                       | Command                                         |
| -------------------------- | ----------------------------------------------- |
| Start                      | `npm start`                                     |
| Start with auto-reload     | `npm run dev`                                   |
| Start on another port      | `node bin/localshare.js --port 3001`            |
| Use a custom data folder   | `node bin/localshare.js --dir /path/to/uploads` |
| Run tests                  | `npm test`                                      |
| Lint                       | `npm run lint`                                  |
| Force browser to reload    | `Ctrl+Shift+R`                                  |
| Check what is on port 3000 | `sudo ss -tlnp \| grep ':3000'`                 |
| Docker, with rebuild       | `sudo docker compose up -d --build`             |

---

## 7. If the page loads but looks unfinished

Three front-end bugs shipped once that made the whole UI look dead - no canvas,
no file list, buttons that did nothing - while the server was perfectly healthy.
They are fixed now, and `test/unit/clientBoot.test.js` boots the real client in
a real DOM to make sure they cannot come back. If you ever see this shape of
symptom again, check these first, because they fail **silently**:

| Symptom                                          | Cause                                                                                                                                                                                                                                                         | How to spot it                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| No canvas, empty list, buttons dead              | `bindSwipeToDelete()` spread `document.adoptedStyleSheets`, which is `undefined` in Safari and iOS Safari before 16.4. The `TypeError` aborted `startApp()` before the presence canvas, drop field, room load and SSE were wired.                             | DevTools console shows a `TypeError` mentioning `adoptedStyleSheets`. |
| The PIN dialog opens but **Unlock does nothing** | `openOverlay()` calls `closeAll({silent: true})` to clear other overlays, and `closeAll` dispatches `localshare:overlays-closed` unconditionally. The dialog bound its listeners _before_ opening, so opening cancelled the dialog and stripped its handlers. | Dialog renders, submit does nothing, no network request.              |
| The device popover is a screen down the page     | The popover was a sibling of `<header>` inside a `position: static` `#app`, so `top: 100%` resolved against the viewport and it stretched the scroll area.                                                                                                    | Popover anchored to the viewport, page scrolls to reach it.           |

Two rules learned the hard way, both now enforced:

1. **A single throw in `startApp()` kills every feature bound after it.** The
   bind helpers run in sequence with no `try`/`catch` between them, so a null
   element or a missing browser API takes out the rest of the app.
2. **Check `npm run check:client` after touching the front end.** It boots the
   real client against a running server and asserts the popover opens, the PIN
   gate works, and the icons render as elements rather than as visible markup.

```bash
npm start &                     # or your usual setup
npm run check:client            # boots the real UI in a DOM and asserts behaviour
npm run check:imports           # every named import resolves to a real export
npm run check:dom               # every $("#id") used by the client exists in the HTML
```

A missing export or a missing element id is a _fatal_ module/DOM error: the
browser refuses to evaluate the module, so nothing on the page works, and only a
one-line red entry in the console says why.

---

## 8. The page updates but the API does not

`docker-compose.yml` mounts `./public` into the container. Static files are read
off disk on each request, so a plain browser refresh picks up every CSS and JS
edit immediately. The **server process** (`src/`) is a different story: it was
started once, with the code that existed at that moment, and it keeps running
that old code until it is restarted.

The result is a half-updated site that is genuinely confusing to debug:

| What you see                                                   | Why                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| A CSS or JS change appears after refresh                       | `public/` is a bind mount                                 |
| A change in `src/routes/*` or `src/middleware/*` has no effect | the node process is running the code from when it started |
| A fix is "in the source" but the API still misbehaves          | you are testing the old process                           |

To tell the two apart, compare a behaviour the server owns. Weak room PINs are
rejected with `400` by the current code and silently accepted with `201` by
stale code:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/rooms \
  -H 'Content-Type: application/json' -d '{"name":"t","pin":"1"}'
# 400 = current server   |   201 = stale server, restart it
```

Restart the container after any server-side change:

```bash
docker compose up -d --build     # server-side changes (src/**)
# a browser refresh is enough for public/**
```

To run the working tree without Docker at all (useful when you cannot reach the
Docker socket), start it on a spare port and remember the variable is
`LOCALSHARE_PORT`, not `PORT`:

```bash
setsid nohup node bin/localshare.js --port 3001 --dir /tmp/ls-verify \
  > /tmp/ls3001.log 2>&1 < /dev/null & disown
```
