# ⚡ URL Shortener — Interactive System Design Simulator

An interactive, production-ready system design simulation platform built with Vite and vanilla JavaScript. Designed to make distributed architecture, caching dynamics, database read/write path separation, and bottleneck detection intuitive through direct cause-and-effect interaction.

![Framework](https://img.shields.io/badge/Framework-Vite%206%20%2B%20Vanilla%20JS-646CFF?logo=vite&logoColor=white)
![Deployment](https://img.shields.io/badge/Deploy-Vercel%20Ready-000000?logo=vercel&logoColor=white)
![Theme](https://img.shields.io/badge/Theme-Dark%20%7C%20Light%20Mode-06b6d4)
![License](https://img.shields.io/badge/License-MIT-10b981)

---

## 🎯 Educational Goals

This simulator empowers engineers to answer fundamental distributed system design questions through interactive experimentation:

* **What happens during URL creation (`POST /api/v1/urls`)?** Observe base62 sequential counter, SHA-256 hash collision handling, and Snowflake 64-bit ID generation with durable database writes.
* **What happens during URL redirection (`GET /:short_code`)?** Watch requests branch into Redis Cache **HIT** (~1.2ms) vs **MISS** (Database query $\rightarrow$ Cache writeback $\rightarrow$ 302/301 redirect).
* **Why separate Read and Write paths?** Read replicas scale read capacity (`SELECT`), but do NOT scale primary write capacity (`INSERT`).
* **Why does Redis caching matter?** Removing Redis forces database reads to surge dynamically by $1 / (1 - \text{hitRate})$ (e.g. $16.7\times$ surge at 94% hit rate).
* **How to identify the active bottleneck?** Diagnose whether the system is constrained by the API tier, Redis cluster, Primary DB writes, or Replica read pools.
* **Why adding servers doesn't always help?** Scaling the API layer when the database is saturated yields 0 throughput gain.

---

## ✨ Features

1. **🎨 Dual Theme System (Dark Obsidian & Crisp Light Mode)**:
   - Instant toggle with system preference detection and `localStorage` persistence.
   - Dynamic canvas telemetry chart adapting colors on the fly.

2. **📌 Mode 1: How It Works (The Request Lifecycle)**:
   - Interactive URL shortening widget with **Counter + Base62**, **SHA-256 Hash**, and **Snowflake ID** strategies.
   - **301 Moved Permanently** vs **302 Found** educational redirect policy switcher.
   - Animated packet flow with an interactive **Hop Inspector** displaying exact HTTP headers, SQL queries (`INSERT`/`SELECT`), and Redis commands (`GET`/`SETEX`).
   - Live database table preview with single-click "Visit (GET)" execution.

3. **📈 Mode 2: Scale System (Traffic & Bottleneck Simulation)**:
   - Dynamic traffic slider (100 to 100,000+ req/s), customizable read/write ratio, API node scaling, Redis toggling, and read replica controls.
   - Live **Architecture Telemetry Stack** with bottleneck indicators.
   - Causal **Metric Cards** and **Detailed Breakdown** with step-by-step arithmetic explanations.
   - Interactive **Traffic vs Load & Latency Canvas Chart** with threshold markers.
   - Activity & Incident timeline stream.

4. **🧪 Mode 3: Engineering Challenges**:
   - Real-world scenarios (*Viral Product Launch*, *Midnight Cache Collapse*, *Write-Heavy Flash Sale*).
   - Allows suboptimal engineering choices with explicit before/after causal feedback and celebratory confetti.

5. **💥 Mode 4: Chaos & Failure Lab (Resilience Testing)**:
   - Controlled failure injections: Kill Redis, Terminate API Node, Kill Read Replica, Primary DB Outage, Drop Database B-Tree Index, Inject Latency.
   - Real-time cascading impact analysis.

6. **⚙️ Simulation Assumptions**:
   - Inspectable and configurable unit capacities and base latencies.

---

## 🛠️ Local Setup Instructions

### Prerequisites
- [Node.js](https://nodejs.org/) (version 18.0.0 or higher)
- [npm](https://www.npmjs.com/) (version 9.0.0 or higher)

### Quick Start
```bash
# 1. Clone or navigate to the repository
cd url-shortener-simulator

# 2. Install dependencies
npm install

# 3. Start the local development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📦 Build Command

To compile the production-ready static assets:

```bash
npm run build
```

The optimized static bundle is output to the `dist/` directory:
- `dist/index.html` (minified HTML entry point)
- `dist/assets/index-[hash].css` (compiled CSS design tokens and layout)
- `dist/assets/index-[hash].js` (bundled JavaScript engine)

To test the production build locally:
```bash
npm run preview
```

---

## 🚀 Deployment Instructions for Vercel

This repository is pre-configured with `vercel.json` for 1-click zero-configuration deployment to [Vercel](https://vercel.com).

### Option A: Via GitHub (Recommended)
1. Push your repository to GitHub.
2. Log in to [Vercel Dashboard](https://vercel.com/dashboard) and click **"Add New..."** $\rightarrow$ **"Project"**.
3. Import your GitHub repository.
4. Vercel automatically detects the **Vite** framework:
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Install Command**: `npm install`
5. Click **"Deploy"**.
6. Your live URL will be generated within seconds (e.g., `https://url-shortener-simulator.vercel.app`).

### Option B: Via Vercel CLI
```bash
# 1. Install the Vercel CLI globally
npm install -g vercel

# 2. Login and deploy
vercel

# 3. Deploy to production
vercel --prod
```

---

## ⚙️ Vercel Configuration Summary

| Setting | Value |
| :--- | :--- |
| **Framework Preset** | `Vite` |
| **Root Directory** | `./` |
| **Build Command** | `npm run build` (or `vite build`) |
| **Output Directory** | `dist` |
| **Node.js Version** | `18.x` or `20.x` |
| **Environment Variables** | None required (100% in-browser simulation) |

---

## 📄 License
MIT © Antigravity
