# Deploying Horizons

Horizons has two halves that deploy to **two different hosts**:

| Part | What it is | Host | Why |
| --- | --- | --- | --- |
| **Client** | Vite + React + tldraw static build (`dist/`) | **Netlify** | Static files, served over a CDN. |
| **Game server** | `ws` WebSocket server (`src/index.js`) holding live in-memory rooms | **Render** | Needs a persistent connection + shared memory; Netlify Functions can't do this. |

The client talks to the server over `wss://`, configured by the `VITE_SERVER_URL` env var **at build time**.

---

## 1. Deploy the game server to Render

1. Push this repo to GitHub (Render deploys from a repo).
2. Go to <https://dashboard.render.com> → **New** → **Blueprint**, and point it at this repo.
   Render reads [`render.yaml`](render.yaml) and creates the `horizons-server` web service.
   - Build: `npm install`
   - Start: `node src/index.js`
   - Health check: `GET /healthz` (the server answers `200 ok`)
   - Render injects `$PORT`; the server already reads `process.env.PORT`.
3. Deploy. Note the public URL, e.g. `https://horizons-server.onrender.com`.
   The WebSocket URL is the same host with `wss://`: `wss://horizons-server.onrender.com`.

> **Free-tier note:** Render's free web services spin down after ~15 min idle and cold-start
> on the next request (a few seconds). Fine for casual play; upgrade the plan to keep it warm.

---

## 2. Deploy the client to Netlify

1. Go to <https://app.netlify.com> → **Add new site** → **Import an existing project**, and
   pick this repo. Netlify reads [`netlify.toml`](netlify.toml):
   - Build command: `npm run build`
   - Publish dir: `dist`
2. **Before the first build**, set the server URL:
   **Site configuration → Environment variables → Add a variable**
   - Key: `VITE_SERVER_URL`
   - Value: `wss://horizons-server.onrender.com`  ← your Render URL from step 1, **`wss://`**
3. Trigger a deploy. Netlify builds the client with that server URL baked in.

> `VITE_SERVER_URL` is read at **build time**, not runtime. If you change the server URL later,
> you must trigger a new Netlify deploy for it to take effect.

---

## 3. Play

Open the Netlify site URL in two tabs (or send the share link to a friend), create a game in
one, and join from the other. The browsers connect to the Render server over `wss://`.

## Local development (unchanged)

```bash
node src/index.js   # server → ws://localhost:8080
npm run dev         # client → http://localhost:5173
```

The committed [`.env`](.env) defaults `VITE_SERVER_URL` to `ws://localhost:8080` for local play.
