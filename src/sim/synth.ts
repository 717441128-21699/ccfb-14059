// 场景合成器:大厅噪声(人声嘈杂、行李车撞击、夜间 HVAC)与伪广播语音。
// 纯 TypeScript,浏览器和 Node 测试共用。

import { Biquad } from '../dsp/Biquad.js';

/** 可播种的伪随机数(测试要可复现) */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function rmsDb(x: Float32Array): number {
  let ms = 0;
  for (let i = 0; i < x.length; i++) ms += x[i] * x[i];
  return 20 * Math.log10(Math.sqrt(ms / x.length) + 1e-9);
}

/** 把信号整体缩放到目标 RMS(dBFS) */
export function normalizeTo(x: Float32Array, targetDbFs: number): Float32Array {
  const g = Math.pow(10, (targetDbFs - rmsDb(x)) / 20);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Paul Kellet 粉红噪声 */
export function pinkNoise(sr: number, seconds: number, rng: () => number): Float32Array {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/**
 * 大厅人声嘈杂:若干条"假嗓子"(带通噪声 + 音节级起伏)叠加在粉红噪声底上。
 * @param levelDbFs 目标 RMS 电平
 */
export function babble(sr: number, seconds: number, levelDbFs: number, rng: () => number): Float32Array {
  const n = Math.floor(sr * seconds);
  const out = pinkNoise(sr, seconds, rng);
  for (let i = 0; i < n; i++) out[i] *= 0.5;

  const voices = 16;
  const white = new Float32Array(n);
  const band = new Float32Array(n);
  for (let v = 0; v < voices; v++) {
    for (let i = 0; i < n; i++) white[i] = rng() * 2 - 1;
    const bp = Biquad.bandpass(sr, 250 + rng() * 2500, 2.5);
    bp.processBlock(white, band);
    // 音节包络:4~7Hz 的随机台阶再平滑
    const stepHz = 4 + rng() * 3;
    const stepLen = Math.max(1, Math.floor(sr / stepHz));
    let env = 0, target = rng();
    const voiceGain = 0.25 + rng() * 0.5;
    for (let i = 0; i < n; i++) {
      if (i % stepLen === 0) target = rng() < 0.25 ? 0 : 0.4 + rng() * 0.6;
      env += (target - env) * 0.002;
      out[i] += band[i] * env * voiceGain;
    }
  }
  return normalizeTo(out, levelDbFs);
}

/**
 * 行李车撞击:金属泛音簇快速衰减 + 短噪声爆发 + 低频砰声。
 * @param peakDbFs 峰值电平
 */
export function clang(sr: number, peakDbFs: number, rng: () => number): Float32Array {
  const dur = 0.7;
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const base = 550 + rng() * 300;
  const ratios = [1, 2.09, 3.37, 4.98, 6.85];
  const amps = [1, 0.6, 0.45, 0.3, 0.2];
  const taus = [0.06, 0.09, 0.12, 0.08, 0.05];
  for (let p = 0; p < ratios.length; p++) {
    const f = base * ratios[p] * (1 + (rng() - 0.5) * 0.06);
    const w = 2 * Math.PI * f;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      out[i] += amps[p] * Math.sin(w * t) * Math.exp(-t / taus[p]);
    }
  }
  // 撞击瞬间的宽带噪声(25ms)
  const burstN = Math.floor(sr * 0.025);
  for (let i = 0; i < burstN; i++) {
    out[i] += (rng() * 2 - 1) * Math.exp(-i / (sr * 0.006)) * 0.8;
  }
  // 低频砰声
  const thumpW = 2 * Math.PI * 90;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] += 0.7 * Math.sin(thumpW * t) * Math.exp(-t / 0.15);
  }
  // 按峰值归一
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = Math.pow(10, peakDbFs / 20) / peak;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** 夜间空厅:HVAC 低频嗡声 + 很低的粉红噪声底 */
export function hvac(sr: number, seconds: number, levelDbFs: number, rng: () => number): Float32Array {
  const n = Math.floor(sr * seconds);
  const out = pinkNoise(sr, seconds, rng);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = out[i] * 0.4 +
      0.5 * Math.sin(2 * Math.PI * 50 * t) +
      0.25 * Math.sin(2 * Math.PI * 100 * t) +
      0.12 * Math.sin(2 * Math.PI * 150 * t);
  }
  return normalizeTo(out, levelDbFs);
}

const VOWELS = [
  [730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240],
  [530, 1840, 2480], [390, 1990, 2550],
];

/**
 * 伪广播语音:声门脉冲源(锯齿)+ 共振峰滤波 + 音节包络。
 * 电平归一到 levelDbFs,用于演示增益跟随;正式部署时换成 TTS/寻呼话筒音源。
 */
export function speech(sr: number, seconds: number, levelDbFs: number, rng: () => number): Float32Array {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  let formants = VOWELS[0];
  let f0 = 110;
  let phase = 0;
  let i = 0;
  while (i < n) {
    // 一个音节
    const sylLen = Math.floor(sr * (0.12 + rng() * 0.14));
    formants = VOWELS[Math.floor(rng() * VOWELS.length)];
    f0 = 95 + rng() * 40;
    const bp = formants.map((f) => Biquad.bandpass(sr, f, 9));
    const weights = [1, 0.55, 0.3];
    const attack = Math.floor(sr * 0.02);
    for (let k = 0; k < sylLen && i < n; k++, i++) {
      phase += f0 / sr;
      if (phase >= 1) phase -= 1;
      const src = 2 * phase - 1; // 锯齿声源
      let y = 0;
      for (let f = 0; f < 3; f++) y += bp[f].processSample(src) * weights[f];
      // 音节包络(20ms 起落)
      const rel = sylLen - k;
      const env = Math.min(1, k / attack, rel / attack);
      out[i] = y * env;
    }
    // 音节间停顿,偶尔长停顿(换气)
    const pause = Math.floor(sr * (rng() < 0.15 ? 0.35 : 0.05 + rng() * 0.1));
    i += pause;
  }
  return normalizeTo(out, levelDbFs);
}

/** 把 src 叠加到 dst 的 atSec 位置 */
export function mixAt(dst: Float32Array, src: Float32Array, atSec: number, sr: number): void {
  const start = Math.floor(atSec * sr);
  for (let i = 0; i < src.length && start + i < dst.length; i++) {
    dst[start + i] += src[i];
  }
}

export interface ScenarioDef {
  id: string;
  label: string;
  description: string;
  build: (sr: number, seconds: number) => Float32Array;
}

/** 演示场景(界面用;测试直接调上面的合成函数) */
export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'morning',
    label: '早高峰大厅',
    description: '约 70dB 人声嘈杂 + 偶发行李车撞击',
    build: (sr, sec) => {
      const rng = makeRng(101);
      const out = babble(sr, sec, -24, rng); // ≈70 dB SPL
      mixAt(out, clang(sr, -22, rng), sec * 0.3, sr);
      mixAt(out, clang(sr, -26, rng), sec * 0.7, sr);
      return out;
    },
  },
  {
    id: 'night',
    label: '半夜空厅',
    description: '约 38dB 空调嗡声,几乎无人',
    build: (sr, sec) => hvac(sr, sec, -56, makeRng(202)),
  },
  {
    id: 'clang',
    label: '行李车冲击',
    description: '55dB 背景 + 2s、5.5s 两次短促撞击(增益不应被顶起)',
    build: (sr, sec) => {
      const rng = makeRng(303);
      const out = babble(sr, sec, -39, rng);
      mixAt(out, clang(sr, -19, rng), 2.0, sr);
      mixAt(out, clang(sr, -19, rng), 5.5, sr);
      return out;
    },
  },
  {
    id: 'step',
    label: '突发噪声 +20dB',
    description: '2s 处人群噪声阶跃升高 20dB 并保持(增益 300ms 内跟上)',
    build: (sr, sec) => {
      const rng = makeRng(404);
      const quiet = babble(sr, sec, -39, rng);
      const loud = babble(sr, sec, -19, rng);
      const at = Math.floor(2 * sr);
      for (let i = at; i < quiet.length; i++) quiet[i] = loud[i];
      return quiet;
    },
  },
  {
    id: 'ramp',
    label: '客流渐强',
    description: '噪声在 8 秒内从 45dB 缓升到 70dB',
    build: (sr, sec) => {
      const rng = makeRng(505);
      const out = babble(sr, sec, -24, rng); // 终点 ≈70 dB SPL
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const g = Math.pow(10, Math.min(1, t / 8) * -20 / 20); // 额外 -20→0dB 渐强
        out[i] *= g;
      }
      return out;
    },
  },
];
