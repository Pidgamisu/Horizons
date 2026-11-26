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

## Auto-deploy (test-gated)

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push to `main`:
it runs `npm test` + `npm run build`, and **only if both pass** triggers the Render and Netlify
deploys via their deploy hooks. This is stricter than the hosts' built-in auto-deploy, which
would ship even when tests are red.

**One-time setup:**

1. **Render** → service → **Settings → Deploy Hook** → copy the URL.
2. **Netlify** → **Site config → Build & deploy → Build hooks** → **Add build hook** → copy the URL.
3. **GitHub** → repo **Settings → Secrets and variables → Actions** → add:
   - `RENDER_DEPLOY_HOOK_URL`
   - `NETLIFY_BUILD_HOOK_URL`
4. Turn off Render's own push-based auto-deploy so you don't get double builds —
   `render.yaml` already sets `autoDeploy: false`.

   **Do not do the same on Netlify by stopping auto publishing.** Netlify calls that
   *locked deploys*, and its own docs are explicit about what it means: "New deploys won't be
   published to the main site, although Netlify will still build them and they will be ready
   for whenever you want to publish them." It does not prevent a build, so it buys you nothing
   against double builds — it just stops anything ever reaching the live site. See the
   2026-11-24 entry below for what that looks like in practice.

   For this workflow to be able to ship at all, Netlify needs **both**:
   - **auto publishing on** (deploys unlocked — the toggle is in the Deploys list,
     "Unlock to start auto publishing"), and
   - **builds active** (Project configuration → Developer settings → Continuous deployment →
     Build settings → Build status). Stopping builds also kills the hook: "If requests are
     sent to build hook URLs, Netlify will not build your site."

   There is no documented way to have Netlify build on a hook but not on a git push, so if the
   site is Git-linked, expect it to build twice. That is the cost of the test gate; leave it.

   Note that Netlify honours skip tags in commit messages the same way GitHub Actions does, so
   a commit marked to skip CI ships nowhere at all — which is what this repo's routine commits
   are for.

If a secret is missing, that host's deploy step is skipped (the build/tests still run), so you
can wire up one host at a time.

## Verifying a deploy actually shipped

**A green check proves nothing.** Two separate ways this repo has shipped nothing while
reporting success:

- Runs #1–#34 were green and skipped both deploy steps, because the hook secrets were unset
  and the steps are guarded by `if: env.X != ''` — a missing secret skips rather than fails.
  So check the *steps*, not the run:

  ```bash
  gh api repos/<owner>/<repo>/actions/runs/<id>/jobs \
    --jq '.jobs[].steps[] | "\(.conclusion)\t\(.name)"'
  ```

  The two "Trigger … deploy" lines must say `success`, not `skipped`.

- On 2026-11-24 both steps said `success`, Render shipped, and Netlify did not: the site was
  still serving the previous bundle two days later. The hook POST returning 200 only means
  Netlify accepted it.

So verify the hosts themselves, not the hook:

```bash
# Client: an asset that only exists in the new build must come back as a real image.
# Netlify's SPA fallback answers 200 with ~1KB of HTML for anything missing, so the
# status code is meaningless on its own — check the content type and size.
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
  https://horizonscardgame.com/cards/89.png

# Or compare the hashed bundle name against a local build of the same commit:
curl -s https://horizonscardgame.com/ | grep -oE 'src="/assets/[^"]+"'
grep -oE 'src="/assets/[^"]+"' dist/index.html

# Server: /healthz answers 200 on any version, so it cannot tell you which one is live.
# Connect two sockets to one room and read the dealt hand — v4 ids are two digits.
```

## Local development (unchanged)

```bash
node src/index.js   # server → ws://localhost:8080
npm run dev         # client → http://localhost:5173
```

The committed [`.env`](.env) defaults `VITE_SERVER_URL` to `ws://localhost:8080` for local play.
