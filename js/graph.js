/**
 * Mini Traffic & Load Graph — Exact Reference Design
 * 
 * Layout:
 * - Compact horizontal mini graph (~150px)
 * - 2 lines: Latency (ms) [red/coral] & Peak Load (%) [orange/amber]
 * - Clean vertical current traffic scrubber line
 * - Compact boundary-aware tooltip:
 *   ┌─────────────────────┐
 *   │ 100k req/s          │
 *   │                     │
 *   │ Latency   200ms     │
 *   │ Peak load 130%      │
 *   └─────────────────────┘
 * - Zero empty padding, zero excessive glow
 */

export class TrafficGraph {
  constructor(canvasEl, model, onTrafficScrub = null) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.model = model;
    this.onTrafficScrub = onTrafficScrub;

    this.hoverPoint = null;
    this.isDragging = false;
    this.activeTraffic = 1000;

    this.setupListeners();
  }

  setupListeners() {
    const getCanvasPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        width: rect.width,
        height: rect.height
      };
    };

    const handlePointer = (e, isDragging) => {
      const pos = getCanvasPos(e);
      this.hoverPoint = { x: pos.x, y: pos.y };

      const pad = { top: 18, right: 35, bottom: 22, left: 35 };
      const cW = pos.width - pad.left - pad.right;

      if (pos.x >= pad.left - 5 && pos.x <= pos.width - pad.right + 5) {
        const clampedX = Math.max(pad.left, Math.min(pos.width - pad.right, pos.x));
        const trafficVal = Math.round(((clampedX - pad.left) / cW) * 100000);

        if (isDragging) {
          this.activeTraffic = trafficVal;
          if (this.onTrafficScrub) {
            this.onTrafficScrub(trafficVal);
          }
        }
      }
      this.render();
    };

    this.canvas.addEventListener('mousemove', (e) => {
      handlePointer(e, this.isDragging);
    });

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      handlePointer(e, true);
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (!this.isDragging) {
        this.hoverPoint = null;
        this.render();
      }
    });

    // Touch support
    this.canvas.addEventListener('touchstart', (e) => {
      this.isDragging = true;
      handlePointer(e, true);
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      handlePointer(e, true);
    }, { passive: true });

    window.addEventListener('touchend', () => {
      this.isDragging = false;
    });

    window.addEventListener('resize', () => this.render());
    window.addEventListener('themeChanged', () => this.render());
  }

  isLightMode() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  updateState(state) {
    this.currentState = state;
    if (state && typeof state.traffic === 'number') {
      this.activeTraffic = state.traffic;
    }
    this.render();
  }

  /* Bezier curve drawing helper */
  drawSmoothCurve(ctx, pts, getX, getY) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(getX(pts[0]), getY(pts[0]));
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cpX = (getX(prev) + getX(curr)) / 2;
      ctx.bezierCurveTo(cpX, getY(prev), cpX, getY(curr), getX(curr), getY(curr));
    }
  }

  render() {
    if (!this.canvas || !this.currentState) return;

    const isLight = this.isLightMode();
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 420;
    const height = rect.height || 155;

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    const pad = { top: 16, right: 32, bottom: 22, left: 32 };
    const cW = width - pad.left - pad.right;
    const cH = height - pad.top - pad.bottom;

    /* ── Background ── */
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = isLight ? '#f8fafc' : '#0a101e';
    ctx.fillRect(0, 0, width, height);

    /* ── Compute Sweep Data Points (0 to 100k RPS) ── */
    const MAX_T = 100000;
    const STEPS = 50;
    const points = [];
    let bottleneckT = null;

    for (let i = 0; i <= STEPS; i++) {
      const t = Math.max(100, (i / STEPS) * MAX_T);
      const sw = { ...this.currentState, traffic: t };
      const res = this.model.calculate(sw);

      if (!bottleneckT && res.systemMaxUtilization >= 0.95) {
        bottleneckT = t;
      }

      points.push({
        traffic: t,
        peakLoad: Math.min(2.0, res.systemMaxUtilization),
        latency: Math.min(500, res.avgLatency),
        res: res
      });
    }

    const getX = (t) => pad.left + (t / MAX_T) * cW;
    const getYL = (v) => pad.top + cH - Math.min(1.0, v / 1.5) * cH;
    const getYLat = (lat) => pad.top + cH - Math.min(1.0, lat / 300) * cH;

    /* ── Subtle Baseline Grid ── */
    ctx.strokeStyle = isLight ? 'rgba(203,213,225,0.4)' : 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;

    for (let p = 0; p <= 1; p += 0.5) {
      const y = pad.top + cH - p * cH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
    }

    /* ── Curve 1: Peak Load (Orange / Amber) ── */
    ctx.save();
    ctx.strokeStyle = isLight ? '#d97706' : '#fb923c';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.drawSmoothCurve(ctx, points, p => getX(p.traffic), p => getYL(p.peakLoad));
    ctx.stroke();
    ctx.restore();

    /* ── Curve 2: Latency (Coral / Red) ── */
    ctx.save();
    ctx.strokeStyle = isLight ? '#e11d48' : '#f43f5e';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.drawSmoothCurve(ctx, points, p => getX(p.traffic), p => getYLat(p.latency));
    ctx.stroke();
    ctx.restore();

    /* ── Saturation Marker ── */
    if (bottleneckT) {
      const bX = getX(bottleneckT);
      ctx.save();
      ctx.strokeStyle = isLight ? 'rgba(225,29,72,0.4)' : 'rgba(244,63,94,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(bX, pad.top);
      ctx.lineTo(bX, height - pad.bottom);
      ctx.stroke();
      ctx.restore();
    }

    /* ── Current Traffic Vertical Scrubber Line & Dot ── */
    const curTraffic = this.currentState.traffic || this.activeTraffic || 1000;
    const curX = Math.max(pad.left, Math.min(width - pad.right, getX(curTraffic)));
    const curMetrics = this.model.calculate({ ...this.currentState, traffic: curTraffic });

    ctx.save();
    ctx.strokeStyle = isLight ? '#3b82f6' : '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(curX, pad.top);
    ctx.lineTo(curX, height - pad.bottom);
    ctx.stroke();

    // Dot at load point
    const loadDotY = getYL(Math.min(2.0, curMetrics.systemMaxUtilization));
    ctx.fillStyle = '#fb923c';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(curX, loadDotY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Dot at latency point
    const latDotY = getYLat(Math.min(500, curMetrics.avgLatency));
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.arc(curX, latDotY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    /* ── Compact Boundary-Aware Tooltip ── */
    if (this.hoverPoint && this.hoverPoint.x >= pad.left - 5 && this.hoverPoint.x <= width - pad.right + 5) {
      const hT = ((this.hoverPoint.x - pad.left) / cW) * MAX_T;
      const clampedHT = Math.max(100, Math.min(MAX_T, hT));
      const hRes = this.model.calculate({ ...this.currentState, traffic: clampedHT });

      const ttW = 160;
      const ttH = 68;
      let ttX = this.hoverPoint.x + 12;
      if (ttX + ttW > width - 6) {
        ttX = this.hoverPoint.x - ttW - 12;
      }
      const ttY = Math.max(6, Math.min(height - ttH - 6, this.hoverPoint.y - ttH / 2));

      ctx.save();
      ctx.fillStyle = isLight ? '#ffffff' : '#0e1626';
      ctx.strokeStyle = isLight ? '#cbd5e1' : 'rgba(100,130,170,0.3)';
      ctx.lineWidth = 1;
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.roundRect(ttX, ttY, ttW, ttH, 6);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Header: Traffic string (e.g. 100k req/s or 1.0k req/s)
      const tStr = clampedHT >= 1000 ? `${(clampedHT / 1000).toFixed(1)}k req/s` : `${Math.round(clampedHT)} req/s`;
      ctx.fillStyle = isLight ? '#0f172a' : '#f8fafc';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(tStr, ttX + 8, ttY + 16);

      // Latency Row
      ctx.font = '9.5px Inter, sans-serif';
      ctx.fillStyle = isLight ? '#64748b' : '#94a3b8';
      ctx.fillText('Latency', ttX + 8, ttY + 36);
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#f43f5e';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(hRes.avgLatency)}ms`, ttX + ttW - 8, ttY + 36);

      // Peak Load Row
      ctx.textAlign = 'left';
      ctx.font = '9.5px Inter, sans-serif';
      ctx.fillStyle = isLight ? '#64748b' : '#94a3b8';
      ctx.fillText('Peak load', ttX + 8, ttY + 54);
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.fillStyle = '#fb923c';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(hRes.systemMaxUtilization * 100)}%`, ttX + ttW - 8, ttY + 54);

      ctx.restore();
    }

    ctx.restore();
  }
}
