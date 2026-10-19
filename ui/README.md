# Admin web UI

A React + TypeScript + Vite single-page app, embedded in the headscale binary and
served at `/admin/`. It talks to the same `/api/v1` the CLI uses and signs in with
an API key (`headscale apikeys create`).

## Build

```sh
cd ui
npm install
npm run build        # writes ui/dist
cd .. && go build ./cmd/headscale   # embeds ui/dist
```

A fresh checkout only contains `dist/.gitkeep`, so `go build` works without
building the UI; `/admin/` is then empty.

## Develop

```sh
npm run dev          # http://localhost:5173/admin/, proxies /api to 127.0.0.1:8080
npm run gen:api      # regenerate src/api/schema.d.ts from a running server
```

`src/api/schema.d.ts` is generated from the server's OpenAPI document; run
`gen:api` after changing the API.

## What is in it

Machines (with detail pages and actions), Network (allowed access and real
traffic), Activity (event log), Policy (visual and code editor with a simulator),
Users, Keys and Settings. Real traffic needs `hs-flow-agent` on the machines.

## Tests

`npm run e2e` drives the UI in Chromium against a real headscale, with real
Tailscale clients in userspace-networking mode (no root). **Run it against a
disposable server**: it creates users, nodes and keys, and overwrites the stored
policy (restored on exit).

```sh
HEADSCALE_URL=http://127.0.0.1:8080 HEADSCALE_KEY=hskey-api-… npm run e2e
```

Needs `tailscale` and `tailscaled` on `PATH`, Chromium (`CHROMIUM=/path`, default
`/usr/bin/chromium`), and `policy.mode: database`. Set `E2E_SCREENSHOTS=dir` to
keep screenshots.
