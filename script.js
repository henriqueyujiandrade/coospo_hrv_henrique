/**
 * HRV Monitor — Coospo HW9 (PPG — tempo real via Web Bluetooth)
 *
 * Timers
 *   Metrics (HR / RMSSD / Stress) : every 3 s
 *   SQI                           : every 30 s
 *
 * Rolling window  : keeps only beats within the last N seconds
 * Anomaly filter  : rejects beats whose RR deviates > threshold % from
 *                   the last accepted beat
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const METRICS_MS   = 3_000;    // metrics refresh period
const SQI_MS       = 30_000;   // SQI refresh period
const CHART_POINTS = 1200;     // max RMSSD history kept (~1 h at 3 s/pt)

// ─── Config (mirrors DOM inputs — read from HTML value attributes at startup) ──
const _wInit = parseInt(document.getElementById('window-size')?.value,    10);
const _mInit = parseInt(document.getElementById('window-maxage')?.value,  10);
const _fInit = parseInt(document.getElementById('anomaly-filter')?.value, 10);
let windowBeats      = (!isNaN(_wInit) && _wInit >= 5   && _wInit <= 300) ? _wInit        : 30;
let windowMaxAgeMs   = (!isNaN(_mInit) && _mInit >= 10  && _mInit <= 600) ? _mInit * 1000 : 90_000;
let anomalyThreshold = (!isNaN(_fInit) && _fInit >= 5   && _fInit <= 80)  ? _fInit / 100  : 0.20;

// ─── Beat store ────────────────────────────────────────────────────────────────
/**
 * Each entry: { rr: number (ms), ts: number (epoch ms), valid: boolean }
 */
let beats        = [];
let lastValidRR  = null;   // reference RR for anomaly detection

// ─── SQI period counters (reset every 30 s) ───────────────────────────────────
let sqiValid     = 0;
let sqiTotal     = 0;
let lastSqiPct   = null;   // last published SQI value

// ─── Gap detection (device-filtered beat estimation) ──────────────────────────
let lastNotifTs  = null;   // epoch ms of last BLE notification

// ─── Chart data ───────────────────────────────────────────────────────────────
const RR_POINTS   = 9000;  // max individual beats kept (~2.5 h at 60 bpm)
const TL_POINTS   = 18_000; // max timeline beats kept (~5 h at 60 bpm)
let rmssdHistory = [];     // array of { ts, rmssd, hr, stress }
let rrHistory    = [];     // array of { rr, valid, deviceFiltered } per beat
let timelineBeats = [];    // full session history — never pruned (for timeline scroll)

// ─── RR series toggle state ───────────────────────────────────────────────────
const rrSeriesVisible = { valid: true, anomaly: true, device: true };
let rrLegendHitBoxes  = [];   // [{ x1, x2, y1, y2, key }] in canvas CSS px

// ─── BLE state ─────────────────────────────────────────────────────────────────
let bleDevice    = null;
let bleChar      = null;
let isConnected  = false;

// ─── SQI countdown (display only) ────────────────────────────────────────────
let sqiCountdown = SQI_MS / 1000;   // seconds remaining

// ─── Session timing ───────────────────────────────────────────────────────────
let firstBeatTs     = null;   // epoch ms of first beat in current session
let sessionStart    = null;   // epoch ms when BLE connected
let sessionInterval = null;   // stopwatch setInterval handle

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const elHR          = document.getElementById('metric-hr');
const elRMSSD       = document.getElementById('metric-rmssd');
const elStress      = document.getElementById('metric-stress');
const elSQI         = document.getElementById('metric-sqi');
const elStressFill  = document.getElementById('stress-fill');
const elSqiCard     = document.getElementById('card-sqi');
const elSqiGauge    = document.getElementById('sqi-gauge-fill');
const elSqiCountdown = document.getElementById('sqi-countdown');
const elStatusDot   = document.getElementById('status-dot');
const elWindowInput  = document.getElementById('window-size');
const elMaxAgeInput  = document.getElementById('window-maxage');
const elFilterInput  = document.getElementById('anomaly-filter');
const elBeatCount   = document.getElementById('window-beat-count');
const elChartMeta        = document.getElementById('chart-meta');
const elChartPlaceholder = document.getElementById('chart-placeholder');
const elRRChartMeta      = document.getElementById('rr-chart-meta');
const elRRChartPH        = document.getElementById('rr-chart-placeholder');
const elAlterarBtn       = document.getElementById('btn-alterar');
const elExportBtn        = document.getElementById('btn-export');
const elConnectBtn       = document.getElementById('btn-connect');
const elConnectLabel = document.getElementById('btn-connect-label');
const elBadgeMode   = document.getElementById('badge-mode');
const elSubtitle     = document.querySelector('.subtitle');
const elSessionTimer = document.getElementById('session-timer');
const canvas         = document.getElementById('rmssd-chart');
const ctx           = canvas.getContext('2d');
const rrCanvas      = document.getElementById('rr-chart');
const rrCtx         = rrCanvas.getContext('2d');
const wlCanvas        = document.getElementById('window-timeline');
const wlCtx           = wlCanvas.getContext('2d');
const elWLMeta        = document.getElementById('wl-meta');
const elWLPlaceholder = document.getElementById('wl-placeholder');

// ─── Protocol modal DOM refs ───────────────────────────────────────────────
const elBtnProtocol      = document.getElementById('btn-protocol');
const elModalProtocol    = document.getElementById('modal-protocol');
const elModalClose       = document.getElementById('modal-close');
const elBtnStartProtocol = document.getElementById('btn-start-protocol');
const elProtoBPM         = document.getElementById('proto-bpm');
const elProtoBaseline    = document.getElementById('proto-baseline');
const elProtoGuide1      = document.getElementById('proto-guide1');
const elProtoStressor    = document.getElementById('proto-stressor');
const elProtoGuide2      = document.getElementById('proto-guide2');
const elProtoMove        = document.getElementById('proto-move');
const elProtoRest        = document.getElementById('proto-rest');
const elProtocolBar      = document.getElementById('protocol-bar');

// ─── Protocol bar UI state ─────────────────────────────────────────────────────────────────
let protoCountdownTimer = null;
let protoPhaseStartTs   = null;
let protoPhaseDurMs     = 0;

// ═══════════════════════════════════════════════════════════════════════════════
//  BEAT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

function processBeat(rr, ts = Date.now(), deviceFiltered = false) {
  const valid = deviceFiltered ? false : isValidBeat(rr);

  // Append beat to rolling window store
  beats.push({ rr, ts, valid, deviceFiltered });

  // Full-history store for timeline scroll
  timelineBeats.push({ rr, ts, valid, deviceFiltered });
  if (timelineBeats.length > TL_POINTS) timelineBeats.shift();

  // Update anomaly reference only on accepted real beats
  if (valid) lastValidRR = rr;

  // SQI period accounting
  sqiTotal++;
  if (valid) sqiValid++;

  // Mark first real-beat timestamp for window-fill tracking
  if (!deviceFiltered && firstBeatTs === null) firstBeatTs = ts;

  // Keep rolling window tidy
  pruneWindow();

  // All beats feed the tachogram; only real beats flash the dot
  rrHistory.push({ rr, valid, deviceFiltered });
  if (rrHistory.length > RR_POINTS) rrHistory.shift();
  if (!deviceFiltered) flashDot();
  renderRRChart();

  // Redraw window timeline
  renderWindowTimeline();
}

/**
 * Returns false if the beat deviates from the last valid beat by more
 * than `anomalyThreshold` (fraction).  First beat is always accepted.
 */
function isValidBeat(rr) {
  if (lastValidRR === null) return true;
  const deviation = Math.abs(rr - lastValidRR) / lastValidRR;
  return deviation <= anomalyThreshold;
}

/** Remove beats older than the max-age cap. */
function pruneWindow() {
  const cutoff = Date.now() - windowMaxAgeMs;
  // Walk from front (oldest) and splice once we hit a recent beat
  let i = 0;
  while (i < beats.length && beats[i].ts < cutoff) i++;
  if (i > 0) beats.splice(0, i);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MATH / METRICS
// ═══════════════════════════════════════════════════════════════════════════════

/** Valid RR intervals for RMSSD: last `windowBeats` valid beats, age-capped. */
function validRRs() {
  pruneWindow();
  // Hybrid window: fixed beat count + max-age cap
  const valid = beats.filter(b => b.valid);
  return valid.slice(-windowBeats).map(b => b.rr);
}

/** HR in bpm from mean RR.  Returns null when insufficient data. */
function calcHR(rrs) {
  if (rrs.length === 0) return null;
  const mean = rrs.reduce((a, b) => a + b, 0) / rrs.length;
  return Math.round(60_000 / mean);
}

/**
 * Root Mean Square of Successive Differences (ms).
 * Requires at least 2 intervals.
 */
function calcRMSSD(rrs) {
  if (rrs.length < 2) return null;
  let sumSq = 0;
  for (let i = 1; i < rrs.length; i++) {
    const d = rrs[i] - rrs[i - 1];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (rrs.length - 1));
}

/**
 * Stress 1–10 — inversely proportional to RMSSD.
 *   RMSSD ≤ 15 ms  →  10  (very high stress / low HRV)
 *   RMSSD ≥ 100 ms →   1  (very relaxed / high HRV)
 */
function calcStress(rmssd) {
  if (rmssd === null) return null;
  const raw = 10 - ((rmssd - 15) / 85) * 9;
  return Math.min(10, Math.max(1, Math.round(raw)));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DOM UPDATES
// ═══════════════════════════════════════════════════════════════════════════════

/** Update HR / RMSSD / Stress.  Called every 3 s. */
function updateMetrics() {
  if (!isConnected) return;
  const rrs    = validRRs();
  const hr     = calcHR(rrs);
  const rmssd  = calcRMSSD(rrs);
  const stress = calcStress(rmssd);

  setValue(elHR,     hr     !== null ? hr     : '--');
  setValue(elRMSSD,  rmssd  !== null ? Math.round(rmssd) : '--');
  setValue(elStress, stress !== null ? stress : '--');

  // Stress bar
  if (stress !== null) {
    const pct = (stress / 10) * 100;
    elStressFill.style.width = pct + '%';
    if      (stress <= 3) elStressFill.style.background = 'var(--green)';
    else if (stress <= 6) elStressFill.style.background = 'var(--yellow)';
    else                  elStressFill.style.background = 'var(--red)';
  }

  // Beat count badge
  elBeatCount.textContent = rrs.length + ' batimento' + (rrs.length !== 1 ? 's' : '') + ' na janela';

  // Push to chart history
  if (rmssd !== null) {
    rmssdHistory.push({ ts: Date.now(), rmssd: Math.round(rmssd), hr, stress });
    if (rmssdHistory.length > CHART_POINTS) rmssdHistory.shift();
    renderChart();
  }

  // Refresh window timeline on every metrics tick
  renderWindowTimeline();
}

/** Update SQI.  Called every 30 s. */
function updateSQI() {
  if (!isConnected) return;
  let sqi;
  if (sqiTotal === 0) {
    sqi = lastSqiPct ?? 100;
  } else {
    sqi = Math.round((sqiValid / sqiTotal) * 100);
    lastSqiPct = sqi;
  }

  // Reset period counters
  sqiValid = 0;
  sqiTotal = 0;

  setValue(elSQI, sqi);

  // Gauge bar
  elSqiGauge.style.width = sqi + '%';

  // Card state classes
  elSqiCard.classList.remove('sqi-warn', 'sqi-danger');
  if      (sqi < 70) elSqiCard.classList.add('sqi-danger');
  else if (sqi < 85) elSqiCard.classList.add('sqi-warn');

  // Reset countdown
  sqiCountdown = SQI_MS / 1000;
}

/**
 * Set a card value with a flash animation if the value changed.
 * @param {HTMLElement} el
 * @param {number|string} val
 */
function setValue(el, val) {
  const str = String(val);
  if (el.textContent === str) return;
  el.textContent = str;
  el.classList.remove('flash');
  // Force reflow so the animation restarts
  void el.offsetWidth;
  el.classList.add('flash');
}

// ─── Status dot heartbeat flash ───────────────────────────────────────────────
let dotTimer = null;
function flashDot() {
  if (!isConnected) return;
  elStatusDot.classList.add('beat');
  clearTimeout(dotTimer);
  dotTimer = setTimeout(() => elStatusDot.classList.remove('beat'), 160);
}

// ─── SQI countdown ────────────────────────────────────────────────────────────
function tickCountdown() {
  if (!isConnected) return;
  sqiCountdown = Math.max(0, sqiCountdown - 1);
  elSqiCountdown.textContent = `próxima leitura em ${sqiCountdown} s`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHART  (Canvas 2D — no external lib)
// ═══════════════════════════════════════════════════════════════════════════════

function renderChart() {
  const container = canvas.parentElement;
  const dpr       = window.devicePixelRatio || 1;
  const contW     = container.clientWidth;
  const cssH      = container.clientHeight;

  if (contW === 0 || cssH === 0) return;

  // Dynamic width: 20 pts visible = 60 s; canvas grows as history accumulates
  const n_   = rmssdHistory.length;
  const PT_W = Math.max(6, contW / 20);
  const cssW = n_ <= 1 ? contW : Math.max(contW, Math.round((n_ - 1) * PT_W) + 68);

  // Capture scroll state before resizing canvas
  const wasAtEnd = container.scrollLeft >= container.scrollWidth - contW - 2;

  // Resize buffer (resets context state — must re-apply scale)
  canvas.width        = cssW * dpr;
  canvas.height       = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.scale(dpr, dpr);

  const W   = cssW;
  const H   = cssH;
  const PAD = { top: 14, right: 18, bottom: 34, left: 50 };
  const PW  = W - PAD.left - PAD.right;
  const PH  = H - PAD.top  - PAD.bottom;

  // Background
  ctx.fillStyle = '#111113';
  ctx.fillRect(0, 0, W, H);

  // Toggle placeholder visibility
  if (rmssdHistory.length < 2) {
    elChartPlaceholder.classList.remove('hidden');
    elChartMeta.textContent = 'aguardando dados…';
    return;
  }
  elChartPlaceholder.classList.add('hidden');

  // Window-fill state — based on valid beat count, not time
  const validCount  = beats.filter(b => b.valid).length;
  const windowFull  = validCount >= windowBeats;
  const fillPct     = Math.min(100, Math.round((validCount / windowBeats) * 100));

  elChartMeta.textContent = windowFull
    ? rmssdHistory.length + ' pontos \u00b7 atualiza a cada 3 s'
    : `\u25a2 preenchendo janela \u2014 ${fillPct}% \u00b7 dados parciais`;

  // Color scheme based on window fill state
  const lineColor = windowFull ? '#22d3ee' : '#71717a';
  const dotColor  = windowFull ? '#22d3ee' : '#71717a';
  const dotGlow   = windowFull ? 'rgba(34, 211, 238, 0.15)' : 'rgba(113, 113, 122, 0.15)';
  const gradTop   = windowFull ? 'rgba(34, 211, 238, 0.18)' : 'rgba(113, 113, 122, 0.14)';
  const gradMid   = windowFull ? 'rgba(34, 211, 238, 0.04)' : 'rgba(113, 113, 122, 0.03)';

  const data   = rmssdHistory.map(m => m.rmssd);
  const minVal = Math.max(0, Math.min(...data) - 6);
  const maxVal = Math.max(...data) + 6;
  const range  = maxVal - minVal || 1;
  const n      = data.length;

  const toX = i => PAD.left + (i / (n - 1)) * PW;
  const toY = v => PAD.top  + PH - ((v - minVal) / range) * PH;

  // ── Horizontal grid lines ──────────────────────────────────
  const gridCount = 4;
  ctx.save();
  ctx.strokeStyle = '#1f1f23';
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 5]);
  for (let i = 0; i <= gridCount; i++) {
    const y   = PAD.top + (PH * i / gridCount);
    const val = maxVal - (range * i / gridCount);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    // Y-axis labels
    ctx.fillStyle   = '#3f3f46';
    ctx.font        = `10px "SF Mono", "Cascadia Code", monospace`;
    ctx.textAlign   = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(val.toFixed(0), PAD.left - 7, y);
  }
  ctx.restore();

  // ── Gradient fill ──────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + PH);
  grad.addColorStop(0,   gradTop);
  grad.addColorStop(0.6, gradMid);
  grad.addColorStop(1,   'rgba(0, 0, 0, 0)');

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.lineTo(toX(n - 1), PAD.top + PH);
  ctx.lineTo(toX(0),     PAD.top + PH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ── Data line ─────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 1.8;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.setLineDash([]);
  ctx.stroke();

  // ── Latest-value dot (glowing) ────────────────────────────
  const lx = toX(n - 1);
  const ly = toY(data[n - 1]);

  ctx.beginPath();
  ctx.arc(lx, ly, 7, 0, Math.PI * 2);
  ctx.fillStyle = dotGlow;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();

  // ── "Preenchendo janela" banner ───────────────────────────
  if (!windowFull) {
    const remaining  = Math.max(0, windowBeats - beats.filter(b => b.valid).length);
    ctx.fillStyle    = '#52525b';
    ctx.font         = `10px "SF Mono", "Cascadia Code", monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.setLineDash([]);
    ctx.fillText(
      `\u27f3  preenchendo janela \u2014 faltam ${remaining} bat.`,
      PAD.left + PW / 2,
      PAD.top + 5
    );
  }

  // ── Axes ──────────────────────────────────────────────────
  ctx.strokeStyle = '#2d2d33';
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + PH + 1);
  ctx.lineTo(PAD.left + PW, PAD.top + PH + 1);
  ctx.stroke();

  // ── Y-axis title ──────────────────────────────────────────
  ctx.save();
  ctx.translate(11, PAD.top + PH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle    = '#3f3f46';
  ctx.font         = `10px "SF Mono", monospace`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ms', 0, 0);
  ctx.restore();

  // ── X-axis time ticks ─────────────────────────────────────
  ctx.fillStyle    = '#3f3f46';
  ctx.font         = `9px "SF Mono", monospace`;
  ctx.textBaseline = 'alphabetic';
  ctx.setLineDash([]);
  const tickStep = 20; // every 20 pts ≈ 60 s
  for (let ti = 0; ti < n; ti += tickStep) {
    const secsAgo = Math.round((rmssdHistory[n - 1].ts - rmssdHistory[ti].ts) / 1000);
    const lbl = secsAgo === 0 ? 'agora'
      : secsAgo < 60 ? `\u2212${secsAgo}s`
      : `\u2212${Math.floor(secsAgo / 60)}m`;
    ctx.textAlign = (ti === 0 && n > tickStep) ? 'left' : 'center';
    ctx.fillText(lbl, toX(ti), H - 5);
    ctx.beginPath();
    ctx.moveTo(toX(ti), PAD.top + PH + 1);
    ctx.lineTo(toX(ti), PAD.top + PH + 5);
    ctx.strokeStyle = '#2d2d33';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }
  if ((n - 1) % tickStep !== 0) {
    ctx.textAlign = 'right';
    ctx.fillText('agora', toX(n - 1), H - 5);
  }

  // Auto-scroll to latest data when user is at the right edge
  if (wasAtEnd) container.scrollLeft = container.scrollWidth;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG ALTERAR / SALVAR
// ═══════════════════════════════════════════════════════════════════════════════

let configEditing = false;

function enterEditMode() {
  configEditing = true;
  elWindowInput.readOnly = false;
  elMaxAgeInput.readOnly = false;
  elFilterInput.readOnly = false;
  elAlterarBtn.textContent = 'Salvar';
  elAlterarBtn.classList.add('editing');
  elWindowInput.focus();
  elWindowInput.select();
}

function saveConfig() {
  const w = parseInt(elWindowInput.value, 10);
  const m = parseInt(elMaxAgeInput.value,  10);
  const f = parseInt(elFilterInput.value,  10);

  // Validate beat window
  if (!isNaN(w) && w >= 5 && w <= 300) {
    windowBeats = w;
  } else {
    elWindowInput.value = windowBeats;
  }

  // Validate max age
  if (!isNaN(m) && m >= 10 && m <= 600) {
    windowMaxAgeMs = m * 1000;
  } else {
    elMaxAgeInput.value = windowMaxAgeMs / 1000;
  }

  pruneWindow();

  // Validate filter
  if (!isNaN(f) && f >= 5 && f <= 80) {
    anomalyThreshold = f / 100;
  } else {
    elFilterInput.value = Math.round(anomalyThreshold * 100);
  }

  configEditing = false;
  elWindowInput.readOnly = true;
  elMaxAgeInput.readOnly = true;
  elFilterInput.readOnly = true;
  elAlterarBtn.textContent = 'Alterar';
  elAlterarBtn.classList.remove('editing');
}

elAlterarBtn.addEventListener('click', () => {
  if (!configEditing) enterEditMode();
  else saveConfig();
});

// ESC: cancel config edit or close protocol modal
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (configEditing) {
    elWindowInput.value = windowBeats;
    elMaxAgeInput.value = windowMaxAgeMs / 1000;
    elFilterInput.value = Math.round(anomalyThreshold * 100);
    configEditing = false;
    elWindowInput.readOnly = true;
    elMaxAgeInput.readOnly = true;
    elFilterInput.readOnly = true;
    elAlterarBtn.textContent = 'Alterar';
    elAlterarBtn.classList.remove('editing');
  }
  if (!elModalProtocol.classList.contains('hidden')) {
    elModalProtocol.classList.add('hidden');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WEB BLUETOOTH
// ═══════════════════════════════════════════════════════════════════════════════

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    alert(
      'Web Bluetooth não está disponível neste navegador.\n' +
      'Use Google Chrome ou Microsoft Edge no Desktop ou Android.'
    );
    return;
  }

  // Toggle: if already connected, disconnect
  if (isConnected) {
    disconnectBluetooth();
    return;
  }

  setConnectingState();

  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }]
    });

    bleDevice.addEventListener('gattserverdisconnected', onGATTDisconnected);

    const server  = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    bleChar       = await service.getCharacteristic('heart_rate_measurement');

    bleChar.addEventListener('characteristicvaluechanged', onHRMeasurement);
    await bleChar.startNotifications();

    // Live mode: clear any stale data
    beats       = [];
    lastValidRR = null;
    lastNotifTs = null;
    setConnectedState(bleDevice.name);

  } catch (err) {
    // NotFoundError = user cancelled the picker — no alert needed
    if (err.name !== 'NotFoundError') {
      console.error('[BLE]', err.name, err.message);
      alert('Não foi possível conectar:\n' + err.message);
    }
    bleDevice = null;
    bleChar   = null;
    setDisconnectedState();
  }
}

function disconnectBluetooth() {
  if (bleChar) {
    bleChar.removeEventListener('characteristicvaluechanged', onHRMeasurement);
    bleChar.stopNotifications().catch(() => {});
    bleChar = null;
  }
  if (bleDevice) {
    if (bleDevice.gatt.connected) bleDevice.gatt.disconnect();
    bleDevice = null;
  }
  setDisconnectedState();
}

function onGATTDisconnected() {
  bleChar   = null;
  bleDevice = null;
  setDisconnectedState();
}

/**
 * Parse Heart Rate Measurement characteristic (0x2A37).
 * Extracts RR intervals (1/1024 s units → ms) and feeds processBeat().
 */
function onHRMeasurement(event) {
  const notifTs      = Date.now();
  const data         = event.target.value;  // DataView
  const flags        = data.getUint8(0);
  const hrIs16bit    = (flags & 0x01) !== 0;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent    = (flags & 0x10) !== 0;

  let offset = 1;
  offset += hrIs16bit ? 2 : 1;            // skip HR value
  if (energyPresent) offset += 2;         // skip Energy Expended

  if (rrPresent) {
    // ── Collect valid RR batch ──────────────────────────────
    const rrBatch = [];
    while (offset + 1 < data.byteLength) {
      const rrRaw = data.getUint16(offset, true);  // little-endian
      offset += 2;
      const rrMs = Math.round(rrRaw * 1000 / 1024);
      // Sanity bounds: 30–230 bpm
      if (rrMs >= 260 && rrMs <= 2000) rrBatch.push(rrMs);
    }

    if (rrBatch.length > 0) {
      // ── Gap detection: estimate device-filtered beats ─────
      // The sum of RRs in a packet should ≈ wall-clock time since last packet.
      // A gap significantly larger than reported RRs suggests the device
      // suppressed beats (motion artifact / poor optical contact).
      if (lastNotifTs !== null) {
        const elapsed  = notifTs - lastNotifTs;
        const reported = rrBatch.reduce((a, b) => a + b, 0);
        const gap      = elapsed - reported;
        const estRR    = lastValidRR || 800;

        // More than ~45% of a typical beat unaccounted → insert synthetic beat(s)
        if (gap > Math.max(350, estRR * 0.45)) {
          const nMissing = Math.max(1, Math.round(gap / estRR));
          for (let i = 0; i < nMissing; i++) {
            const syntheticTs = lastNotifTs + Math.round(estRR * (i + 1));
            processBeat(estRR, syntheticTs, /* deviceFiltered */ true);
          }
        }
      }

      // ── Process real beats ──────────────────────────────
      rrBatch.forEach(rr => processBeat(rr));
      lastNotifTs = notifTs;
    }
  }
}

// ── UI state helpers ──────────────────────────────────────────────────────────

function setConnectingState() {
  elConnectBtn.disabled = true;
  elConnectBtn.className = 'btn-connect connecting';
  elConnectLabel.textContent = 'Conectando…';
  elBadgeMode.textContent = 'CONECTANDO';
  elBadgeMode.className = 'badge-mode connecting';
}

function formatDuration(ms) {
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm  = String(m).padStart(2, '0');
  const ss  = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function setConnectedState(deviceName) {
  isConnected = true;
  elConnectBtn.disabled = false;
  elConnectBtn.className = 'btn-connect connected';
  elConnectLabel.textContent = 'Desconectar';
  elBadgeMode.textContent = 'AO VIVO';
  elBadgeMode.className = 'badge-mode live';
  elSubtitle.textContent = (deviceName || 'Coospo HW9') + ' \u00b7 PPG Óptico';
  elStatusDot.classList.add('live');
  elStatusDot.title = 'Dispositivo conectado';
  console.info('[BLE] Conectado:', deviceName);
}

function setDisconnectedState() {
  isConnected = false;
  elConnectBtn.disabled = false;
  elConnectBtn.className = 'btn-connect';
  elConnectLabel.textContent = 'Conectar';
  elBadgeMode.textContent = 'DESCONECTADO';
  elBadgeMode.className = 'badge-mode';
  elSubtitle.textContent = 'Coospo HW9 \u00b7 PPG Óptico';
  elStatusDot.classList.remove('live', 'beat');
  elStatusDot.title = 'Aguardando conexão';
  // Stop audio protocol and session timer
  AudioProtocol.stop();
  protocolUIReset();
  clearInterval(sessionInterval);
  sessionInterval = null;
  sessionStart    = null;
  firstBeatTs     = null;
  elSessionTimer.classList.remove('visible');
  elSessionTimer.textContent = '00:00';
  // Clear stale data and reset display
  beats        = [];
  lastValidRR  = null;
  rmssdHistory = [];
  sqiValid = 0;
  sqiTotal = 0;
  sqiCountdown = SQI_MS / 1000;
  setValue(elHR,    '--');
  setValue(elRMSSD, '--');
  setValue(elStress, '--');
  setValue(elSQI,   '--');
  elStressFill.style.width = '0%';
  elSqiGauge.style.width   = '0%';
  elSqiCard.classList.remove('sqi-warn', 'sqi-danger');
  elBeatCount.textContent  = '0 batimentos na janela';
  rrHistory     = [];
  timelineBeats = [];
  lastNotifTs   = null;
  renderChart();
  renderRRChart();
  renderWindowTimeline();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RR CHART  (Tachogram — Canvas 2D)
// ═══════════════════════════════════════════════════════════════════════════════

function renderRRChart() {
  const container = rrCanvas.parentElement;
  const dpr    = window.devicePixelRatio || 1;
  const contW  = container.clientWidth;
  const cssH   = container.clientHeight;

  if (contW === 0 || cssH === 0) return;

  // Dynamic width: 75 visible beats ≈ 60 s at 75 bpm; grows as history accumulates
  const n_     = rrHistory.length;
  const BEAT_W = Math.max(4, contW / 75);
  const cssW   = n_ <= 1 ? contW : Math.max(contW, Math.round((n_ - 1) * BEAT_W) + 68);

  // Capture scroll state before resizing canvas
  const wasAtEnd = container.scrollLeft >= container.scrollWidth - contW - 2;

  rrCanvas.width        = cssW * dpr;
  rrCanvas.height       = cssH * dpr;
  rrCanvas.style.width  = cssW + 'px';
  rrCanvas.style.height = cssH + 'px';
  rrCtx.scale(dpr, dpr);

  const W   = cssW;
  const H   = cssH;
  const PAD = { top: 14, right: 18, bottom: 34, left: 50 };
  const PW  = W - PAD.left - PAD.right;
  const PH  = H - PAD.top  - PAD.bottom;

  rrCtx.fillStyle = '#111113';
  rrCtx.fillRect(0, 0, W, H);

  if (rrHistory.length < 2) {
    elRRChartPH.classList.remove('hidden');
    elRRChartMeta.textContent = 'aguardando dados…';
    return;
  }
  elRRChartPH.classList.add('hidden');
  elRRChartMeta.textContent =
    rrHistory.length + ' batimentos · tempo real';

  const allRR  = rrHistory.map(b => b.rr);
  const minVal = Math.max(0, Math.min(...allRR) - 20);
  const maxVal = Math.max(...allRR) + 20;
  const range  = maxVal - minVal || 1;
  const n      = rrHistory.length;

  const toX = i => PAD.left + (i / (n - 1)) * PW;
  const toY = v => PAD.top  + PH - ((v - minVal) / range) * PH;

  // ── Grid ──────────────────────────────────────────────────
  const gridCount = 4;
  rrCtx.save();
  rrCtx.strokeStyle = '#1f1f23';
  rrCtx.lineWidth   = 1;
  rrCtx.setLineDash([3, 5]);
  for (let i = 0; i <= gridCount; i++) {
    const y   = PAD.top + (PH * i / gridCount);
    const val = maxVal - (range * i / gridCount);
    rrCtx.beginPath();
    rrCtx.moveTo(PAD.left, y);
    rrCtx.lineTo(W - PAD.right, y);
    rrCtx.stroke();
    rrCtx.fillStyle    = '#3f3f46';
    rrCtx.font         = `10px "SF Mono", "Cascadia Code", monospace`;
    rrCtx.textAlign    = 'right';
    rrCtx.textBaseline = 'middle';
    rrCtx.fillText(val.toFixed(0), PAD.left - 7, y);
  }
  rrCtx.restore();

  // ── Gradient fill under valid-only segments ───────────────
  if (rrSeriesVisible.valid) {
    const grad = rrCtx.createLinearGradient(0, PAD.top, 0, PAD.top + PH);
    grad.addColorStop(0,   'rgba(52, 211, 153, 0.13)');
    grad.addColorStop(0.7, 'rgba(52, 211, 153, 0.03)');
    grad.addColorStop(1,   'rgba(52, 211, 153, 0)');
    let segStart = -1;
    for (let i = 0; i <= n; i++) {
      const isValid = i < n && rrHistory[i].valid;
      if (isValid && segStart === -1) {
        segStart = i;
      } else if (!isValid && segStart !== -1) {
        const segEnd = i - 1;
        if (segEnd > segStart) {
          rrCtx.beginPath();
          rrCtx.moveTo(toX(segStart), toY(rrHistory[segStart].rr));
          for (let j = segStart + 1; j <= segEnd; j++)
            rrCtx.lineTo(toX(j), toY(rrHistory[j].rr));
          rrCtx.lineTo(toX(segEnd), PAD.top + PH);
          rrCtx.lineTo(toX(segStart), PAD.top + PH);
          rrCtx.closePath();
          rrCtx.fillStyle = grad;
          rrCtx.fill();
        }
        segStart = -1;
      }
    }
  }

  // ── Series 1 — VÁLIDOS: linha sólida verde ───────────────
  if (rrSeriesVisible.valid) {
    rrCtx.lineWidth   = 1.8;
    rrCtx.lineJoin    = 'round';
    rrCtx.lineCap     = 'round';
    rrCtx.setLineDash([]);
    rrCtx.strokeStyle = '#34d399';
    let drawing = false;
    for (let i = 0; i < n; i++) {
      if (rrHistory[i].valid) {
        if (!drawing) { rrCtx.beginPath(); rrCtx.moveTo(toX(i), toY(rrHistory[i].rr)); drawing = true; }
        else            rrCtx.lineTo(toX(i), toY(rrHistory[i].rr));
      } else {
        if (drawing) { rrCtx.stroke(); drawing = false; }
      }
    }
    if (drawing) rrCtx.stroke();
    for (let i = 0; i < n; i++) {
      if (rrHistory[i].valid) {
        rrCtx.beginPath();
        rrCtx.arc(toX(i), toY(rrHistory[i].rr), 2, 0, Math.PI * 2);
        rrCtx.fillStyle = '#34d399';
        rrCtx.fill();
      }
    }
  }

  // ── Series 2 — ANOMALIAS: linha tracejada vermelha + losango ─
  if (rrSeriesVisible.anomaly) {
    rrCtx.strokeStyle = 'rgba(248, 113, 113, 0.35)';
    rrCtx.lineWidth   = 1;
    rrCtx.setLineDash([3, 4]);
    let anomDrawing = false;
    for (let i = 0; i < n; i++) {
      const isAnom = !rrHistory[i].valid && !rrHistory[i].deviceFiltered;
      if (isAnom) {
        if (!anomDrawing) { rrCtx.beginPath(); rrCtx.moveTo(toX(i), toY(rrHistory[i].rr)); anomDrawing = true; }
        else                rrCtx.lineTo(toX(i), toY(rrHistory[i].rr));
      } else {
        if (anomDrawing) { rrCtx.stroke(); anomDrawing = false; }
      }
    }
    if (anomDrawing) rrCtx.stroke();
    rrCtx.setLineDash([]);
    for (let i = 0; i < n; i++) {
      if (!rrHistory[i].valid && !rrHistory[i].deviceFiltered) {
        const cx = toX(i), cy = toY(rrHistory[i].rr), s = 5;
        rrCtx.beginPath();
        rrCtx.moveTo(cx, cy - s); rrCtx.lineTo(cx + s, cy);
        rrCtx.lineTo(cx, cy + s); rrCtx.lineTo(cx - s, cy);
        rrCtx.closePath();
        rrCtx.fillStyle   = 'rgba(248, 113, 113, 0.90)';
        rrCtx.strokeStyle = 'rgba(248, 113, 113, 0.3)';
        rrCtx.lineWidth   = 1;
        rrCtx.fill(); rrCtx.stroke();
      }
    }
  }

  // ── Series 3 — OMITIDOS PELO DISPOSITIVO: marcador âmbar ─
  if (rrSeriesVisible.device) {
    rrCtx.setLineDash([]);
    for (let i = 0; i < n; i++) {
      if (rrHistory[i].deviceFiltered) {
        const cx = toX(i), cy = toY(rrHistory[i].rr), s = 4;
        rrCtx.beginPath();
        rrCtx.rect(cx - s / 2, cy - s / 2, s, s);
        rrCtx.fillStyle   = 'rgba(251, 191, 36, 0.85)';
        rrCtx.strokeStyle = 'rgba(251, 191, 36, 0.3)';
        rrCtx.lineWidth   = 1;
        rrCtx.fill(); rrCtx.stroke();
      }
    }
  }

  // ── Latest beat marker ────────────────────────────────────
  {
    const last  = rrHistory[n - 1];
    const lx    = toX(n - 1);
    const ly    = toY(last.rr);
    const color = last.valid ? '#34d399' : last.deviceFiltered ? '#fbbf24' : '#f87171';
    const glow  = last.valid ? 'rgba(52,211,153,0.18)'
                : last.deviceFiltered ? 'rgba(251,191,36,0.18)'
                : 'rgba(248,113,113,0.18)';
    rrCtx.beginPath();
    rrCtx.arc(lx, ly, 7, 0, Math.PI * 2);
    rrCtx.fillStyle = glow;
    rrCtx.fill();
    rrCtx.beginPath();
    rrCtx.arc(lx, ly, 3, 0, Math.PI * 2);
    rrCtx.fillStyle = color;
    rrCtx.fill();
  }

  // ── Axes ──────────────────────────────────────────────────
  rrCtx.strokeStyle = '#2d2d33';
  rrCtx.lineWidth   = 1;
  rrCtx.setLineDash([]);
  rrCtx.beginPath();
  rrCtx.moveTo(PAD.left, PAD.top);
  rrCtx.lineTo(PAD.left, PAD.top + PH + 1);
  rrCtx.lineTo(PAD.left + PW, PAD.top + PH + 1);
  rrCtx.stroke();

  // ── Y-axis label ──────────────────────────────────────────
  rrCtx.save();
  rrCtx.translate(11, PAD.top + PH / 2);
  rrCtx.rotate(-Math.PI / 2);
  rrCtx.fillStyle    = '#3f3f46';
  rrCtx.font         = `10px "SF Mono", monospace`;
  rrCtx.textAlign    = 'center';
  rrCtx.textBaseline = 'middle';
  rrCtx.fillText('ms', 0, 0);
  rrCtx.restore();

  // ── Legend (bottom-right, interactive — clique para ocultar/exibir) ──
  rrLegendHitBoxes = [];
  {
    const rrLegItems = [
      { color: '#34d399', label: 'válido',                   key: 'valid'   },
      { color: '#f87171', label: 'filtro de anomalias',      key: 'anomaly' },
      { color: '#fbbf24', label: 'omitido pelo dispositivo', key: 'device'  },
    ];
    const SW = 12, SG = 5, IG = 16;
    rrCtx.font         = `9px -apple-system, "Segoe UI", sans-serif`;
    rrCtx.textBaseline = 'middle';
    const legWidths = rrLegItems.map(it => SW + SG + rrCtx.measureText(it.label).width);
    const totalLegW = legWidths.reduce((a, b) => a + b, 0) + IG * (rrLegItems.length - 1);
    let lx = PAD.left + PW - totalLegW;
    const legY = H - 5;
    for (let i = 0; i < rrLegItems.length; i++) {
      const it      = rrLegItems[i];
      const visible = rrSeriesVisible[it.key];
      // Store hit-box (CSS px) for click/hover detection
      rrLegendHitBoxes.push({ x1: lx - 2, x2: lx + legWidths[i] + 2, y1: legY - 8, y2: legY + 8, key: it.key });
      rrCtx.globalAlpha = visible ? 1 : 0.35;
      rrCtx.beginPath();
      rrCtx.moveTo(lx, legY);
      rrCtx.lineTo(lx + SW, legY);
      rrCtx.strokeStyle = it.color;
      rrCtx.lineWidth   = 2.5;
      rrCtx.setLineDash([]);
      rrCtx.stroke();
      rrCtx.fillStyle = '#52525b';
      rrCtx.textAlign = 'left';
      rrCtx.fillText(it.label, lx + SW + SG, legY);
      if (!visible) {
        // strikethrough over label
        const tw = rrCtx.measureText(it.label).width;
        rrCtx.beginPath();
        rrCtx.moveTo(lx + SW + SG, legY);
        rrCtx.lineTo(lx + SW + SG + tw, legY);
        rrCtx.strokeStyle = '#52525b';
        rrCtx.lineWidth   = 1;
        rrCtx.stroke();
      }
      rrCtx.globalAlpha = 1;
      lx += legWidths[i] + IG;
    }
  }

  // ── X-axis beat-count ticks ───────────────────────────────
  rrCtx.fillStyle    = '#3f3f46';
  rrCtx.font         = `9px "SF Mono", monospace`;
  rrCtx.textBaseline = 'alphabetic';
  rrCtx.setLineDash([]);
  const bTickStep = 75; // every 75 beats ≈ 60 s at 75 bpm
  for (let ti = 0; ti < n; ti += bTickStep) {
    const beatsAgo = n - 1 - ti;
    const lbl = beatsAgo === 0 ? 'agora' : `\u2212${beatsAgo}`;
    rrCtx.textAlign = (ti === 0 && n > bTickStep) ? 'left' : 'center';
    rrCtx.fillText(lbl, toX(ti), H - 5);
    rrCtx.beginPath();
    rrCtx.moveTo(toX(ti), PAD.top + PH + 1);
    rrCtx.lineTo(toX(ti), PAD.top + PH + 5);
    rrCtx.strokeStyle = '#2d2d33';
    rrCtx.lineWidth   = 1;
    rrCtx.stroke();
  }
  if ((n - 1) % bTickStep !== 0) {
    rrCtx.textAlign = 'right';
    rrCtx.fillText('agora', toX(n - 1), H - 5);
  }

  // Auto-scroll to latest data when user is at the right edge
  if (wasAtEnd) container.scrollLeft = container.scrollWidth;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WINDOW TIMELINE  (Canvas 2D — janela de cálculo)
//
//  Shows every beat in the rolling window as a vertical tick:
//    Green  #34d399 — valid, used in RMSSD calculation
//    Red    #f87171 — rejected by the anomaly filter (site)
//    Amber  #fbbf24 — estimated as suppressed by the device (motion artifact)
// ═══════════════════════════════════════════════════════════════════════════════

function renderWindowTimeline() {
  if (!wlCanvas) return;
  const container = wlCanvas.parentElement;
  const dpr    = window.devicePixelRatio || 1;
  const contW  = container.clientWidth;
  const cssH   = container.clientHeight;

  if (contW === 0 || cssH === 0) return;

  // Dynamic canvas width: one visible width = windowMaxAgeMs of data.
  // Clamped to MAX_CANVAS_PX / dpr so the backing store never exceeds the
  // browser's hard limit (~65 535 px), which causes a silent white-out.
  const MAX_CANVAS_PX  = 32_767;
  const scale          = contW / windowMaxAgeMs; // px per ms
  const firstTs        = timelineBeats.length > 0 ? timelineBeats[0].ts : null;
  const now0           = Date.now();
  const sessionDurMs   = firstTs ? Math.max(windowMaxAgeMs, now0 - firstTs + 1000) : windowMaxAgeMs;
  const idealCssW      = Math.max(contW, Math.ceil(sessionDurMs * scale));
  const maxCssW        = Math.floor(MAX_CANVAS_PX / dpr);
  const cssW           = Math.min(idealCssW, maxCssW);
  const clamped        = cssW < idealCssW;

  const wasAtEnd = container.scrollLeft >= container.scrollWidth - contW - 2;

  wlCanvas.width        = cssW * dpr;
  wlCanvas.height       = cssH * dpr;
  wlCanvas.style.width  = cssW + 'px';
  wlCanvas.style.height = cssH + 'px';
  wlCtx.scale(dpr, dpr);

  const W   = cssW;
  const H   = cssH;
  const PAD = { top: 8, right: 16, bottom: 40, left: 16 };
  const PW  = W - PAD.left - PAD.right;
  const PH  = H - PAD.top  - PAD.bottom;

  wlCtx.fillStyle = '#111113';
  wlCtx.fillRect(0, 0, W, H);

  pruneWindow();

  // ── Placeholder ────────────────────────────────────────────
  if (timelineBeats.length === 0) {
    elWLPlaceholder.classList.remove('hidden');
    elWLMeta.textContent = 'aguardando dados…';
    return;
  }
  elWLPlaceholder.classList.add('hidden');

  const now      = now0;
  const winStart = now - windowMaxAgeMs;

  // toX maps an epoch-ms timestamp → canvas x coordinate.
  // When clamped, the canvas acts as a sliding window anchored at the live
  // edge — the left edge represents (now - visibleDurMs) rather than firstTs.
  const visibleDurMs = PW / scale;
  const originTs     = clamped ? (now + 1000 - visibleDurMs) : (firstTs ?? now - windowMaxAgeMs);
  const toX = ts => PAD.left + ((ts - originTs) / visibleDurMs) * PW;

  // ── Category counts (current window only) ─────────────────
  let nValid = 0, nAnomaly = 0, nDevice = 0;
  for (const b of beats) {
    if (b.valid)               nValid++;
    else if (b.deviceFiltered) nDevice++;
    else                       nAnomaly++;
  }

  const wlValidCount = beats.filter(b => b.valid).length;
  const windowFull   = wlValidCount >= windowBeats;
  elWLMeta.textContent = windowFull
    ? `${nValid} válidos \u00b7 ${nAnomaly} anomalias \u00b7 ${nDevice} omitidos`
    : `preenchendo janela\u2026 \u00b7 ${Math.min(100, Math.round((wlValidCount / windowBeats) * 100))}%`;

  // ── Track background ───────────────────────────────────────
  wlCtx.fillStyle = '#18181b';
  wlCtx.fillRect(PAD.left, PAD.top, PW, PH);

  // ── Current window highlight (last windowSizeMs) ───────────
  const xWinStart = Math.max(PAD.left, toX(winStart));
  const xWinEnd   = PAD.left + PW;
  wlCtx.fillStyle = 'rgba(34, 211, 238, 0.05)';
  wlCtx.fillRect(xWinStart, PAD.top, xWinEnd - xWinStart, PH);

  // ── Window start boundary line ─────────────────────────────
  const xBound = toX(winStart);
  if (xBound > PAD.left + 2) {
    wlCtx.beginPath();
    wlCtx.moveTo(xBound + 0.5, PAD.top);
    wlCtx.lineTo(xBound + 0.5, PAD.top + PH);
    wlCtx.strokeStyle = 'rgba(34, 211, 238, 0.28)';
    wlCtx.lineWidth   = 1;
    wlCtx.setLineDash([3, 4]);
    wlCtx.stroke();
    wlCtx.setLineDash([]);
  }

  // ── Beat tick marks ────────────────────────────────────────
  const TICK_H  = Math.round(PH * 0.66);
  const TICK_Y1 = PAD.top + Math.round((PH - TICK_H) / 2);
  const TICK_Y2 = TICK_Y1 + TICK_H;

  wlCtx.lineWidth = 1.5;
  wlCtx.setLineDash([]);

  for (const b of timelineBeats) {
    const x = toX(b.ts);
    if (x < PAD.left - 1 || x > PAD.left + PW + 1) continue;
    wlCtx.beginPath();
    wlCtx.moveTo(Math.round(x) + 0.5, TICK_Y1);
    wlCtx.lineTo(Math.round(x) + 0.5, TICK_Y2);
    wlCtx.strokeStyle = b.valid ? '#34d399' : b.deviceFiltered ? '#fbbf24' : '#f87171';
    wlCtx.stroke();
  }

  // ── Track border ──────────────────────────────────────────
  wlCtx.strokeStyle = '#2d2d33';
  wlCtx.lineWidth   = 1;
  wlCtx.setLineDash([]);
  wlCtx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, PW, PH);

  // ── Time ticks (every windowSizeMs) ───────────────────────
  const timeY = PAD.top + PH + 12;
  wlCtx.fillStyle    = '#3f3f46';
  wlCtx.font         = `9px "SF Mono", monospace`;
  wlCtx.textBaseline = 'middle';
  wlCtx.setLineDash([]);

  const tickInterval = windowMaxAgeMs;
  const firstTickTs  = Math.ceil(originTs / tickInterval) * tickInterval;
  for (let t = firstTickTs; t <= now; t += tickInterval) {
    const x = toX(t);
    if (x < PAD.left || x > PAD.left + PW) continue;
    const secsAgo = Math.round((now - t) / 1000);
    const lbl = secsAgo === 0 ? 'agora'
      : secsAgo < 60 ? `\u2212${secsAgo}s`
      : `\u2212${Math.floor(secsAgo / 60)}m`;
    wlCtx.textAlign = 'center';
    wlCtx.fillText(lbl, x, timeY);
    wlCtx.beginPath();
    wlCtx.moveTo(x, PAD.top + PH + 1);
    wlCtx.lineTo(x, PAD.top + PH + 5);
    wlCtx.strokeStyle = '#2d2d33';
    wlCtx.lineWidth   = 1;
    wlCtx.stroke();
  }
  // "agora" label always at right edge
  wlCtx.textAlign = 'right';
  wlCtx.fillText('agora', PAD.left + PW, timeY);

  // ── Legend (right-aligned, always visible at live edge) ────
  const legendItems = [
    { color: '#34d399', label: 'usado no cálculo' },
    { color: '#f87171', label: 'filtro de anomalias' },
    { color: '#fbbf24', label: 'omitido pelo dispositivo' },
  ];

  wlCtx.font         = `9px -apple-system, "Segoe UI", sans-serif`;
  wlCtx.textBaseline = 'middle';

  const SW = 12, SG = 5, IG = 16;
  const legWidths = legendItems.map(it => SW + SG + wlCtx.measureText(it.label).width);
  const totalLegW = legWidths.reduce((a, b) => a + b, 0) + IG * (legendItems.length - 1);
  let lx          = PAD.left + PW - totalLegW;
  const legY      = H - 8;

  for (let i = 0; i < legendItems.length; i++) {
    const it = legendItems[i];
    wlCtx.beginPath();
    wlCtx.moveTo(lx, legY);
    wlCtx.lineTo(lx + SW, legY);
    wlCtx.strokeStyle = it.color;
    wlCtx.lineWidth   = 2.5;
    wlCtx.stroke();
    wlCtx.fillStyle = '#52525b';
    wlCtx.textAlign = 'left';
    wlCtx.fillText(it.label, lx + SW + SG, legY);
    lx += legWidths[i] + IG;
  }

  // Auto-scroll to live edge when user was already there
  if (wasAtEnd) container.scrollLeft = container.scrollWidth;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

function buildExportJSON() {
  const now = new Date();

  return {
    config: {
      exportado_em:        now.toISOString(),
      janela_batimentos:    windowBeats,
      janela_maxage_s:      windowMaxAgeMs / 1000,
      filtro_anomalias_pct: Math.round(anomalyThreshold * 100),
    },
    beats: {
      headers: ['timestamp_ms', 'rr_ms', 'valid'],
      rows: beats.map(b => [b.ts, b.rr, b.valid]),
    },
    metricas: {
      headers: ['timestamp_ms', 'hr_bpm', 'rmssd_ms', 'stress'],
      rows: rmssdHistory.map(m => [m.ts, m.hr ?? null, m.rmssd, m.stress ?? null]),
    },
  };
}

async function saveSessionToDatabase(data) {
  try {
    const res = await fetch('/api/save-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    console.info('[Export] Sessão salva no banco. session_id:', json.session_id);
  } catch (err) {
    console.error('[Export] Falha ao salvar no banco:', err.message);
  }
}

async function exportData() {
  if (beats.length === 0 && rmssdHistory.length === 0) {
    alert('Nenhum dado para exportar. Conecte o dispositivo e aguarde alguns batimentos.');
    return;
  }

  const now   = new Date();
  const stamp = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  const fileName = `hrv_${stamp}.json`;
  const data     = buildExportJSON();
  const content  = JSON.stringify(data, null, 2);
  const blob     = new Blob([content], { type: 'application/json;charset=utf-8;' });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[Export]', err);
        alert('Erro ao salvar ' + fileName + ':\n' + err.message);
      }
    }
  } else {
    // Fallback: trigger download via anchor element
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  saveSessionToDatabase(data);
}

// ─── Responsive chart redraw ──────────────────────────────────────────────────
new ResizeObserver(() => {
  if (rmssdHistory.length >= 2) renderChart();
}).observe(canvas.parentElement);

new ResizeObserver(() => {
  if (rrHistory.length >= 2) renderRRChart();
}).observe(rrCanvas.parentElement);

new ResizeObserver(() => renderWindowTimeline()).observe(wlCanvas.parentElement);

// ═══════════════════════════════════════════════════════════════════════════════
//  SNAP-TO-LIVE
// Sets up the ▶ agora button for each scrollable chart container.
// The button appears only when the user has scrolled away from the live edge.
// ═══════════════════════════════════════════════════════════════════════════════

function setupSnapLive(container, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  container.addEventListener('scroll', () => {
    const atEnd = container.scrollLeft >= container.scrollWidth - container.clientWidth - 4;
    btn.classList.toggle('hidden', atEnd);
  }, { passive: true });

  btn.addEventListener('click', () => {
    container.scrollLeft = container.scrollWidth;
    btn.classList.add('hidden');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
//  RECORDING SESSION  (Preview → official recording)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discard any preview data, start the official session timer, and fire
 * the audio protocol scheduler.  Called after the user clicks "Iniciar Protocolo".
 * @param {{ bpm: number, phaseDurations: number[] }} config
 */
// ═══════════════════════════════════════════════════════════════════════════════
//  PROTOCOL PROGRESS BAR
// ═══════════════════════════════════════════════════════════════════════════════

function protocolUIReset() {
  clearInterval(protoCountdownTimer);
  protoCountdownTimer = null;
  elProtocolBar.classList.add('hidden');
  for (let i = 0; i < 8; i++) {
    document.getElementById(`proto-phase-${i}`).classList.remove('proto-active', 'proto-done');
    const fill = document.getElementById(`proto-fill-${i}`);
    fill.style.transition = 'none';
    fill.style.width = '0%';
  }
}

function protocolUIInit(phaseDurations) {
  clearInterval(protoCountdownTimer);
  protoCountdownTimer = null;
  for (let i = 0; i < 8; i++) {
    document.getElementById(`proto-phase-${i}`).classList.remove('proto-active', 'proto-done');
    const fill = document.getElementById(`proto-fill-${i}`);
    fill.style.transition = 'none';
    fill.style.width = '0%';
    const time = document.getElementById(`proto-time-${i}`);
    if (time) time.textContent = (phaseDurations[i] ?? 0) + 's';
  }
  elProtocolBar.classList.remove('hidden');
}

function onProtocolPhaseChange(phaseIdx, durationMs) {
  clearInterval(protoCountdownTimer);
  protoCountdownTimer = null;

  if (phaseIdx === -1) {
    // Protocol finished — mark all done, then fade out
    for (let i = 0; i < 8; i++) {
      const item = document.getElementById(`proto-phase-${i}`);
      item.classList.remove('proto-active');
      item.classList.add('proto-done');
    }
    setTimeout(() => elProtocolBar.classList.add('hidden'), 1500);
    return;
  }

  // Sync all segment states
  for (let i = 0; i < 8; i++) {
    const item = document.getElementById(`proto-phase-${i}`);
    item.classList.toggle('proto-active', i === phaseIdx);
    item.classList.toggle('proto-done',   i < phaseIdx);
    const fill = document.getElementById(`proto-fill-${i}`);
    fill.style.transition = 'none';
    fill.style.width = i < phaseIdx ? '100%' : '0%';
  }

  if (durationMs <= 0) return;

  // Animate fill for the active phase
  const activeFill = document.getElementById(`proto-fill-${phaseIdx}`);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      activeFill.style.transition = `width ${durationMs}ms linear`;
      activeFill.style.width = '100%';
    });
  });

  // Live countdown
  protoPhaseStartTs = Date.now();
  protoPhaseDurMs   = durationMs;
  const timeEl = document.getElementById(`proto-time-${phaseIdx}`);
  const tick = () => {
    const rem = Math.max(0, Math.ceil((protoPhaseDurMs - (Date.now() - protoPhaseStartTs)) / 1000));
    if (timeEl) timeEl.textContent = rem + 's';
  };
  tick();
  protoCountdownTimer = setInterval(tick, 500);
}

function startRecordingSession(config) {
  // Discard preview data so only session data appears in exports
  beats         = [];
  lastValidRR   = null;
  rmssdHistory  = [];
  rrHistory     = [];
  timelineBeats = [];
  sqiValid      = 0;
  sqiTotal      = 0;
  lastSqiPct    = null;
  firstBeatTs   = null;
  lastNotifTs   = null;

  // Reset metric displays
  setValue(elHR,     '--');
  setValue(elRMSSD,  '--');
  setValue(elStress, '--');
  setValue(elSQI,    '--');
  elStressFill.style.width = '0%';
  elSqiGauge.style.width   = '0%';
  elSqiCard.classList.remove('sqi-warn', 'sqi-danger');
  elBeatCount.textContent  = '0 batimentos na janela';
  sqiCountdown = SQI_MS / 1000;
  elSqiCountdown.textContent = `próxima leitura em ${sqiCountdown} s`;
  renderChart();
  renderRRChart();
  renderWindowTimeline();

  // Start official session stopwatch
  sessionStart = Date.now();
  elSessionTimer.textContent = '00:00';
  elSessionTimer.classList.add('visible');
  clearInterval(sessionInterval);
  sessionInterval = setInterval(() => {
    elSessionTimer.textContent = formatDuration(Date.now() - sessionStart);
  }, 1000);

  // Initialise progress bar and launch audio protocol
  protocolUIInit(config.phaseDurations);
  AudioProtocol.start({ ...config, onPhaseChange: onProtocolPhaseChange });
}

function init() {
  // Metrics timer — every 3 s
  setInterval(updateMetrics, METRICS_MS);

  // SQI timer — every 30 s
  setInterval(updateSQI, SQI_MS);

  // SQI countdown ticker — every 1 s
  setInterval(tickCountdown, 1_000);

  // Buttons
  elConnectBtn.addEventListener('click', connectBluetooth);
  elExportBtn.addEventListener('click', exportData);

  // Protocol modal
  elBtnProtocol.addEventListener('click', () => elModalProtocol.classList.remove('hidden'));
  elModalClose.addEventListener('click',  () => elModalProtocol.classList.add('hidden'));
  elModalProtocol.addEventListener('click', e => {
    if (e.target === elModalProtocol) elModalProtocol.classList.add('hidden');
  });
  elBtnStartProtocol.addEventListener('click', () => {
    if (!isConnected) {
      const proceed = confirm(
        'O dispositivo Bluetooth não está conectado. Deseja iniciar o protocolo sonoro assim mesmo?'
      );
      if (!proceed) return;
    }
    const config = {
      bpm: Math.max(1, parseInt(elProtoBPM.value, 10) || 6),
      phaseDurations: [
        Math.max(0, parseInt(elProtoBaseline.value,  10) || 90),  // 0 Linha de Base
        Math.max(0, parseInt(elProtoGuide1.value,    10) || 60),  // 1 Guia Resp. 1
        2,                                                         // 2 Silêncio pré-estressor (fixo)
        Math.max(0, parseInt(elProtoStressor.value,  10) || 5),   // 3 Estressor
        2,                                                         // 4 Silêncio pós-estressor (fixo)
        Math.max(0, parseInt(elProtoGuide2.value,    10) || 60),  // 5 Guia Resp. 2
        Math.max(0, parseInt(elProtoMove.value,      10) || 10),  // 6 Movimentação
        Math.max(0, parseInt(elProtoRest.value,      10) || 10),  // 7 Repouso
      ],
    };
    elModalProtocol.classList.add('hidden');
    startRecordingSession(config);
  });

  // Snap-to-live for all three scrollable chart containers
  setupSnapLive(canvas.parentElement,    'snap-rmssd');
  setupSnapLive(wlCanvas.parentElement,  'snap-wl');
  setupSnapLive(rrCanvas.parentElement,  'snap-rr');

  // RR chart legend — click to toggle series, hover for pointer cursor
  rrCanvas.addEventListener('click', (e) => {
    if (rrLegendHitBoxes.length === 0) return;
    const rect = rrCanvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    for (const box of rrLegendHitBoxes) {
      if (cssX >= box.x1 && cssX <= box.x2 && cssY >= box.y1 && cssY <= box.y2) {
        rrSeriesVisible[box.key] = !rrSeriesVisible[box.key];
        renderRRChart();
        break;
      }
    }
  });
  rrCanvas.addEventListener('mousemove', (e) => {
    if (rrLegendHitBoxes.length === 0) { rrCanvas.style.cursor = 'default'; return; }
    const rect = rrCanvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    rrCanvas.style.cursor = rrLegendHitBoxes.some(
      b => cssX >= b.x1 && cssX <= b.x2 && cssY >= b.y1 && cssY <= b.y2
    ) ? 'pointer' : 'default';
  });

  // Initial placeholder render
  renderChart();
  renderWindowTimeline();

  console.info('[HRV Monitor] Pronto — aguardando conexão Bluetooth (Coospo HW9)');
}

init();
