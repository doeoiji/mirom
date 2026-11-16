# MiROM Hub

Official Xiaomi, Redmi & POCO ROM downloader (HyperOS & MIUI).

A zero-dependency **Node.js backend** runs on your PC (or server), polls Xiaomi's official updater servers in real time (`update.miui.com` & `update.intl.miui.com`), backfills full device history, verifies download links across all 5 official mirrors, and pushes live updates to connected browsers via Server-Sent Events.

---

## Project files
- `server/server.js` — HTTP server, live Xiaomi API & feed pollers, mirror link verifier, SSE stream (`/api/roms`, `/api/events`, `/api/stats`, `/api/refresh`)
- `server/xiaomi.js` — Xiaomi official updater API client & tracker parser
- `server/db.js` — JSON database (`data/db.json`, auto-created on startup)
- `index.html`, `app.js`, `styles.css` — Frontend web UI
- `.github/workflows/pages.yml` — GitHub Actions workflow to publish the frontend to GitHub Pages
- `Dockerfile` — Optional container image for VPS/cloud hosting

---

## 1. Run Locally on Your PC

Requires **Node.js 18+** (no `npm install` needed).

```powershell
cd c:\xiaomi-rom-download
npm start
```
Or:
```powershell
node server/server.js
```

Open **http://localhost:8080/** in your browser.
- The top-right pill shows **`Server Live · <count> ROMs`**.
- Everything is stored in `data/db.json` (auto-saved).
- Optional environment variables: `PORT` (default `8080`), `API_POLL_MIN` (default `5`), `FEED_POLL_MIN` (default `10`), `DATA_DIR` (default `./data`).

---

## 2. Publish with Cloudflare Tunnel (Node Server Running on Your PC)

This exposes the Node.js server running on your PC to the public internet with free HTTPS — **no port forwarding and no separate hosting needed**. Both the website and the `/api/*` endpoints run through your tunnel.

### Quick test URL (temporary, changes on restart)
1. Install `cloudflared` (one time):
   ```powershell
   winget install Cloudflare.cloudflared
   ```
2. Start your Node server in terminal 1:
   ```powershell
   npm start
   ```
3. Start the Cloudflare Tunnel in terminal 2:
   ```powershell
   cloudflared tunnel --url http://localhost:8080
   ```
4. Cloudflare prints a public `https://....trycloudflare.com` URL — share it with anyone!

### Permanent public URL (with your own domain on Cloudflare)
1. Log in and create a named tunnel:
   ```powershell
   cloudflared tunnel login
   cloudflared tunnel create mirom
   cloudflared tunnel route dns mirom roms.yourdomain.com
   ```
2. Run the tunnel pointing to your PC's server:
   ```powershell
   cloudflared tunnel run --url http://localhost:8080 mirom
   ```
3. Your site is now live at `https://roms.yourdomain.com` as long as `npm start` and `cloudflared` are running on your PC.

---

## 3. Publish Frontend on GitHub Pages + Node Server on Your PC

Use this if you want the website hosted at `https://<your-username>.github.io/<repo>/` while your PC's Node server powers the live ROM API through Cloudflare Tunnel:

1. **Expose your PC's Node server** using a permanent Cloudflare Tunnel (Section 2 above), e.g. `https://api-roms.yourdomain.com` (or a quick `trycloudflare.com` URL for testing).
2. **Point the frontend to your PC's tunnel URL** (choose either option):
   - **Permanent (recommended):** Edit line 13 in `index.html`:
     ```html
     <meta name="mirom-api" content="https://api-roms.yourdomain.com">
     ```
   - **Quick test without editing files:** Open your GitHub Pages URL with `?api=https://your-tunnel.trycloudflare.com` once (it saves in the browser's `localStorage`).
3. **Push to GitHub & enable Pages:**
   ```powershell
   git init
   git add .
   git commit -m "Initial MiROM Hub"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
4. On GitHub, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
   The workflow `.github/workflows/pages.yml` automatically deploys `index.html`, `app.js`, and `styles.css`.
5. Keep `npm start` and `cloudflared tunnel ...` running on your PC so visitors on GitHub Pages always get live ROMs and verified links.
