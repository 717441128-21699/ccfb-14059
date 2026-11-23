// 界面:分区配置 / 实时监视 / 增益曲线 / 播出记录 四个面板 + 顶栏控制。

import { App } from './app.js';
import { SCENARIOS } from '../sim/synth.js';
import { BAND_CENTERS } from '../dsp/NoiseCompensator.js';
import type { ZoneConfig } from '../dsp/types.js';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = '', parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

// ---------- 顶栏 ----------
export function initHeader(app: App, root: HTMLElement): void {
  const scenarioSel = el('select', '', root);
  for (const s of SCENARIOS) {
    const o = el('option', '', scenarioSel);
    o.value = s.id;
    o.textContent = s.label;
    o.title = s.description;
  }
  scenarioSel.value = app.scenarioId;
  scenarioSel.onchange = () => app.setScenario(scenarioSel.value);

  const btnStart = el('button', 'primary', root);
  btnStart.textContent = '▶ 启动';
  btnStart.onclick = async () => {
    if (app.running) app.stop();
    else await app.start();
    btnStart.textContent = app.running ? '■ 停止' : '▶ 启动';
    btnBcast.disabled = !app.running;
    btnMic.disabled = !app.running;
    autoChk.disabled = !app.running;
  };

  const btnBcast = el('button', '', root);
  btnBcast.textContent = '📢 播放广播';
  btnBcast.disabled = true;
  btnBcast.onclick = () => app.broadcast();

  const autoLabel = el('label', 'chk', root);
  const autoChk = el('input', '', autoLabel);
  autoChk.type = 'checkbox';
  autoChk.disabled = true;
  autoChk.onchange = () => app.setAutoBroadcast(autoChk.checked);
  autoLabel.append(' 自动广播(15s)');

  const btnMic = el('button', '', root);
  btnMic.textContent = '🎙 真实麦克风';
  btnMic.disabled = true;
  btnMic.onclick = () => void app.useRealMic();

  const zoneSel = el('select', '', root);
  app.zones.forEach((z, i) => {
    const o = el('option', '', zoneSel);
    o.value = String(i);
    o.textContent = `监听:${z.name}`;
  });
  zoneSel.onchange = () => app.selectZone(Number(zoneSel.value));

  const volLabel = el('label', 'chk', root);
  volLabel.append('监听音量');
  const vol = el('input', '', volLabel);
  vol.type = 'range';
  vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.value = '0.8';
  vol.oninput = () => app.setMonitorVolume(Number(vol.value));

  const btnBench = el('button', '', root);
  btnBench.textContent = '⏱ 性能基准';
  const benchOut = el('span', 'bench', root);
  btnBench.onclick = () => {
    const r = app.benchmark();
    benchOut.textContent =
      `8 分区 × 128 采样:平均 ${r.avgMs.toFixed(4)} ms/块,峰值 ${r.maxMs.toFixed(3)} ms/块(上限 3 ms)`;
    benchOut.classList.toggle('ok', r.avgMs < 3);
    benchOut.classList.toggle('bad', r.avgMs >= 3);
  };
}

// ---------- 分区配置 ----------
const ZONE_FIELDS: { key: keyof ZoneConfig; label: string; step: number }[] = [
  { key: 'noiseRefDb', label: '参考噪声 dB', step: 1 },
  { key: 'slopeDbPerDb', label: '斜率 dB/dB', step: 0.1 },
  { key: 'minGainDb', label: '最小增益 dB', step: 1 },
  { key: 'maxGainDb', label: '最大增益 dB', step: 1 },
  { key: 'maxSplDb', label: '最大声压 dB SPL', step: 1 },
  { key: 'micSensitivityDb', label: '话筒灵敏度 dB', step: 1 },
];

export function initZonesPanel(app: App, root: HTMLElement): void {
  const table = el('table', 'zones', root);
  const head = el('tr', '', el('thead', '', table));
  el('th', '', head).textContent = '分区';
  el('th', '', head).textContent = '启用';
  for (const f of ZONE_FIELDS) el('th', '', head).textContent = f.label;
  const body = el('tbody', '', table);
  app.zones.forEach((z, zi) => {
    const tr = el('tr', '', body);
    el('td', 'name', tr).textContent = z.name;
    const tdEn = el('td', '', tr);
    const chk = el('input', '', tdEn);
    chk.type = 'checkbox';
    chk.checked = z.enabled;
    chk.onchange = () => app.updateZone(zi, { enabled: chk.checked });
    for (const f of ZONE_FIELDS) {
      const td = el('td', '', tr);
      const inp = el('input', '', td);
      inp.type = 'number';
      inp.step = String(f.step);
      inp.value = String(z[f.key]);
      inp.onchange = () => {
        app.updateZone(zi, { [f.key]: Number(inp.value) } as Partial<ZoneConfig>);
      };
    }
  });
}

// ---------- 实时监视 ----------
export function initMonitorPanel(app: App, root: HTMLElement): void {
  const cards = el('div', 'zone-cards', root);
  const cardEls: { noise: HTMLElement; gain: HTMLElement; spl: HTMLElement; card: HTMLElement }[] = [];
  app.zones.forEach((z, i) => {
    const card = el('div', 'zone-card', cards);
    card.onclick = () => app.selectZone(i);
    el('div', 'zc-name', card).textContent = z.name;
    const noise = el('div', 'zc-val', card);
    const gain = el('div', 'zc-val', card);
    const spl = el('div', 'zc-val', card);
    cardEls.push({ noise, gain, spl, card });
  });

  const mid = el('div', 'monitor-mid', root);
  const canvas = el('canvas', 'bands', mid);
  canvas.width = 560; canvas.height = 220;
  const readouts = el('div', 'readouts', mid);
  const ro = (label: string): HTMLElement => {
    const d = el('div', 'ro', readouts);
    el('span', 'ro-label', d).textContent = label;
    return el('span', 'ro-val', d);
  };
  const roNoise = ro('持续噪声');
  const roSpeech = ro('广播输入');
  const roGain = ro('当前增益');
  const roSpl = ro('输出声压');
  const roFrozen = ro('冲击冻结');
  const roImpulse = ro('冲击次数');
  const roBlock = ro('块处理耗时');

  const ctx = canvas.getContext('2d')!;
  const dbMin = 20, dbMax = 100;

  function draw(): void {
    const s = app.stats[app.selectedZone];
    app.zones.forEach((z, i) => {
      const st = app.stats[i];
      const c = cardEls[i];
      c.card.classList.toggle('selected', i === app.selectedZone);
      c.card.classList.toggle('frozen', !!st?.frozen);
      c.noise.textContent = st ? `噪声 ${st.noiseDb.toFixed(1)} dB` : '噪声 --';
      c.gain.textContent = st ? `增益 ${st.gainDb.toFixed(1)} dB` : '增益 --';
      c.spl.textContent = st && st.splOutDb > 0 ? `输出 ${st.splOutDb.toFixed(1)} dB` : '输出 --';
    });
    if (!s) return;
    roNoise.textContent = `${s.noiseDb.toFixed(1)} dB SPL`;
    roSpeech.textContent = s.speechDb > 0 ? `${s.speechDb.toFixed(1)} dB` : '--';
    roGain.textContent = `${s.gainDb.toFixed(1)} dB`;
    roSpl.textContent = s.splOutDb > 0 ? `${s.splOutDb.toFixed(1)} dB SPL` : '--';
    roFrozen.textContent = s.frozen ? '冻结中' : '正常';
    roFrozen.className = `ro-val ${s.frozen ? 'warn' : 'ok'}`;
    roImpulse.textContent = String(s.impulseEvents);
    roBlock.textContent = `平均 ${app.blockMsAvg.toFixed(4)} ms / 峰值 ${app.blockMsMax.toFixed(3)} ms`;
    roBlock.className = `ro-val ${app.blockMsAvg < 3 ? 'ok' : 'bad'}`;

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const n = s.bandNoiseDb.length;
    const bw = w / n;
    // 网格
    ctx.strokeStyle = 'rgba(128,140,160,.18)';
    ctx.fillStyle = 'rgba(128,140,160,.7)';
    ctx.font = '10px sans-serif';
    for (let db = 30; db <= 90; db += 15) {
      const y = h - ((db - dbMin) / (dbMax - dbMin)) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(`${db}`, 2, y - 2);
    }
    for (let b = 0; b < n; b++) {
      const x = b * bw;
      // 噪声柱
      const nh = Math.max(0, (s.bandNoiseDb[b] - dbMin) / (dbMax - dbMin)) * h;
      ctx.fillStyle = 'rgba(80,160,255,.75)';
      ctx.fillRect(x + 4, h - nh, bw / 2 - 6, nh);
      // 增益柱(以 0dB 为基准上下画,缩放到画面)
      const g = s.bandGainDb[b];
      const gh = Math.abs(g) / (dbMax - dbMin) * h * 2;
      const y0 = h - ((40 - dbMin) / (dbMax - dbMin)) * h; // 增益 0 线画在 40dB 处
      ctx.fillStyle = g >= 0 ? 'rgba(255,170,60,.85)' : 'rgba(120,220,140,.85)';
      ctx.fillRect(x + bw / 2 + 2, g >= 0 ? y0 - gh : y0, bw / 2 - 6, gh);
      ctx.fillStyle = 'rgba(200,210,225,.8)';
      ctx.textAlign = 'center';
      ctx.fillText(`${BAND_CENTERS[b] >= 1000 ? BAND_CENTERS[b] / 1000 + 'k' : BAND_CENTERS[b]}`,
        x + bw / 2, h - 3);
      ctx.textAlign = 'left';
    }
  }
  app.on('stats', draw);
  app.on('state', draw);
}

// ---------- 增益曲线 ----------
export function initGainPanel(app: App, root: HTMLElement): void {
  const wrap = el('div', 'gain-wrap', root);
  const curve = el('canvas', 'curve', wrap);
  curve.width = 560; curve.height = 240;
  const hist = el('canvas', 'hist', wrap);
  hist.width = 560; hist.height = 120;
  const cctx = curve.getContext('2d')!;
  const hctx = hist.getContext('2d')!;
  const xMin = 30, xMax = 90, yMin = -15, yMax = 25;

  function drawCurve(): void {
    const z = app.zones[app.selectedZone];
    const s = app.stats[app.selectedZone];
    const w = curve.width, h = curve.height;
    cctx.clearRect(0, 0, w, h);
    const X = (db: number) => ((db - xMin) / (xMax - xMin)) * w;
    const Y = (g: number) => h - ((g - yMin) / (yMax - yMin)) * h;
    cctx.strokeStyle = 'rgba(128,140,160,.18)';
    cctx.fillStyle = 'rgba(128,140,160,.7)';
    cctx.font = '10px sans-serif';
    for (let db = 30; db <= 90; db += 10) {
      cctx.beginPath(); cctx.moveTo(X(db), 0); cctx.lineTo(X(db), h); cctx.stroke();
      cctx.fillText(`${db}dB`, X(db) + 2, h - 3);
    }
    for (let g = yMin; g <= yMax; g += 5) {
      cctx.beginPath(); cctx.moveTo(0, Y(g)); cctx.lineTo(w, Y(g)); cctx.stroke();
      cctx.fillText(`${g}`, 2, Y(g) - 2);
    }
    // 映射曲线
    cctx.strokeStyle = 'rgba(255,170,60,.9)';
    cctx.lineWidth = 2;
    cctx.beginPath();
    for (let db = xMin; db <= xMax; db += 0.5) {
      let g = (db - z.noiseRefDb) * z.slopeDbPerDb;
      g = Math.max(z.minGainDb, Math.min(z.maxGainDb, g));
      const x = X(db), y = Y(g);
      if (db === xMin) cctx.moveTo(x, y); else cctx.lineTo(x, y);
    }
    cctx.stroke();
    cctx.lineWidth = 1;
    // 参考噪声竖线
    cctx.strokeStyle = 'rgba(120,220,140,.5)';
    cctx.beginPath(); cctx.moveTo(X(z.noiseRefDb), 0); cctx.lineTo(X(z.noiseRefDb), h); cctx.stroke();
    // 实时工作点
    if (s) {
      cctx.fillStyle = '#ff5f5f';
      cctx.beginPath();
      cctx.arc(X(s.noiseDb), Y(s.gainDb), 5, 0, Math.PI * 2);
      cctx.fill();
      cctx.fillStyle = 'rgba(255,95,95,.9)';
      cctx.fillText(`${s.noiseDb.toFixed(1)}dB / ${s.gainDb.toFixed(1)}dB`,
        Math.min(X(s.noiseDb) + 8, w - 110), Y(s.gainDb) - 8);
    }
  }

  function drawHist(): void {
    const w = hist.width, h = hist.height;
    hctx.clearRect(0, 0, w, h);
    const pts = app.history;
    if (pts.length < 2) return;
    const t1 = pts[pts.length - 1].t;
    const t0 = t1 - 45; // 45 秒窗口
    const X = (t: number) => ((t - t0) / (t1 - t0)) * w;
    const Yn = (db: number) => h - ((db - 30) / 70) * h;
    const Yg = (g: number) => h - ((g + 15) / 40) * h;
    hctx.strokeStyle = 'rgba(80,160,255,.9)';
    hctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t), y = Yn(p.noiseDb);
      if (i === 0) hctx.moveTo(x, y); else hctx.lineTo(x, y);
    });
    hctx.stroke();
    hctx.strokeStyle = 'rgba(255,170,60,.9)';
    hctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t), y = Yg(p.gainDb);
      if (i === 0) hctx.moveTo(x, y); else hctx.lineTo(x, y);
    });
    hctx.stroke();
    hctx.fillStyle = 'rgba(128,140,160,.8)';
    hctx.font = '10px sans-serif';
    hctx.fillText('蓝:噪声 dB SPL(30-100)  橙:增益 dB(-15~+25)  窗口 45s', 6, 12);
  }

  app.on('stats', () => { drawCurve(); drawHist(); });
  app.on('config', drawCurve);
  app.on('state', drawCurve);
}

// ---------- 播出记录 ----------
export function initLogPanel(app: App, root: HTMLElement): void {
  const table = el('table', 'log', root);
  const head = el('tr', '', el('thead', '', table));
  for (const t of ['时间', '类型', '内容', '详情']) el('th', '', head).textContent = t;
  const body = el('tbody', '', table);
  const KIND_LABEL = { broadcast: '广播', impulse: '冲击', system: '系统' } as const;

  function render(): void {
    body.innerHTML = '';
    for (const entry of app.logs.slice(0, 60)) {
      const tr = el('tr', `log-${entry.kind}`, body);
      el('td', '', tr).textContent = entry.time;
      el('td', '', tr).textContent = KIND_LABEL[entry.kind];
      el('td', '', tr).textContent = entry.text;
      el('td', '', tr).textContent = entry.detail;
    }
  }
  app.on('log', render);
}
