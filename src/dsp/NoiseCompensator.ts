// 单分区噪声补偿器:纯 TypeScript,不依赖 Web Audio,
// 既被 AudioWorklet 调用,也能在 Node 里跑验证测试。
//
// 信号流:
//   监听麦克风 ─→ 分析滤波器组 ─→ 快包络 ─→ 滑动窗百分位持续噪声估计 ─→ 增益映射 ─┐
//                                          └→ 冲击事件检测(记录/冻结)          │
//   广播语音   ─→ 语音滤波器组 ─→ 逐频段增益(块内线性插值)─→ 求和 ─→ SPL 限幅 ─→ 输出
//
// 持续噪声估计与冲击识别的配合:
//   宽带电平突然跳变(>impulseRiseDb)时进入评估期,估计与增益先冻结;
//   - 评估期内电平从峰值跌落 impulseDecayDb 以上 → 短促冲击(行李车撞击),
//     记录事件并继续冻结 impulseFreezeSec,估计完全不吸收这个峰;
//   - 电平在峰值附近(−sustainedHoldDb 以内)持续 sustainedHoldSec → 持续噪声,
//     立即放行,估计以 noiseRiseTauSec 快速跟上(保证 20dB 阶跃 300ms 内响应);
//   冲击按"快速衰减的瞬态"识别——持续 0.1s 以上不衰减的矩形突发不属于撞击声。

import { Biquad } from './Biquad.js';
import type { DspTuning, ZoneConfig, ZoneStats } from './types.js';

/** 8 个倍频程分析频段(Hz) */
export const BAND_CENTERS = [125, 250, 500, 1000, 2000, 4000, 8000, 12000];

const EPS = 1e-9;

export function toDb(lin: number): number {
  return 20 * Math.log10(lin + EPS);
}
export function toLin(db: number): number {
  return Math.pow(10, db / 20);
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? v : v;
}

export class NoiseCompensator {
  private micFilters: Biquad[] = [];
  private spFilters: Biquad[] = [];
  /** 每频段快包络(线性幅度) */
  private envFast: Float64Array;
  /** 每频段持续噪声估计(评估/冻结期不上升) */
  private sustained: Float64Array;
  /** 每频段语音输入包络(SPL 上限用) */
  private spEnv: Float64Array;
  /** 增益快/慢分量(dB) */
  private gainFastDb: Float64Array;
  private gainSlowDb: Float64Array;
  /** 上一块实际施加的线性增益(块内插值防爆音) */
  private prevGainLin: Float64Array;
  /** 当前块增益(dB),预分配避免音频线程产生垃圾 */
  private gainDbWork: Float64Array;
  /** 当前块目标增益(dB),调试用 */
  private targetDbWork: Float64Array;

  private micScratch: Float32Array[] = [];
  private spScratch: Float32Array[] = [];

  // 冲击事件检测(评估期内冻结估计与增益,防止瞬态被吸收)
  private onsetEnv = 1e-6;
  private broadSmooth = 1e-6;
  private firstBlock = true;
  private evaluating = false;
  private evalStartSec = 0;
  private evalPeakDb = -200;
  private evalHighSec = 0;
  private freezeUntilSec = -1;
  private impulseCount = 0;

  private timeSec = 0;
  private lastStats: ZoneStats;

  constructor(
    public cfg: ZoneConfig,
    private tuning: DspTuning,
    private sampleRate: number,
    private blockSize: number,
  ) {
    const n = tuning.numBands;
    for (let b = 0; b < n; b++) {
      this.micFilters.push(Biquad.bandpass(sampleRate, BAND_CENTERS[b], 1.0));
      this.spFilters.push(Biquad.bandpass(sampleRate, BAND_CENTERS[b], 1.0));
      this.micScratch.push(new Float32Array(blockSize));
      this.spScratch.push(new Float32Array(blockSize));
    }
    const blockSec = blockSize / sampleRate;
    this.envFast = new Float64Array(n).fill(1e-6);
    this.sustained = new Float64Array(n).fill(1e-6);
    this.spEnv = new Float64Array(n).fill(1e-6);
    this.gainFastDb = new Float64Array(n).fill(cfg.minGainDb);
    this.gainSlowDb = new Float64Array(n).fill(cfg.minGainDb);
    this.prevGainLin = new Float64Array(n).fill(toLin(cfg.minGainDb));
    this.gainDbWork = new Float64Array(n).fill(cfg.minGainDb);
    this.targetDbWork = new Float64Array(n).fill(cfg.minGainDb);
    this.lastStats = {
      noiseDb: 0, gainDb: cfg.minGainDb, speechDb: 0, splOutDb: 0,
      frozen: false, impulseEvents: 0,
      bandNoiseDb: new Array<number>(n).fill(0),
      bandGainDb: new Array<number>(n).fill(cfg.minGainDb),
    };
  }

  /**
   * 处理一个音频块。
   * @param mic    监听麦克风信号(环境噪声)
   * @param speech 广播语音信号,无广播时传 null
   * @param out    输出缓冲(长度 = blockSize),会被覆盖写入
   */
  process(mic: Float32Array, speech: Float32Array | null, out: Float32Array): void {
    const t = this.tuning;
    const n = t.numBands;
    const blockSec = this.blockSize / this.sampleRate;
    const now = this.timeSec;

    // ---- 1. 噪声分析:逐频段滤波 + 快包络 ----
    for (let b = 0; b < n; b++) {
      const buf = this.micScratch[b];
      this.micFilters[b].processBlock(mic, buf);
      let ms = 0;
      for (let i = 0; i < buf.length; i++) ms += buf[i] * buf[i];
      const rms = Math.sqrt(ms / buf.length) + EPS;
      const tau = rms > this.envFast[b] ? t.envAttackSec : t.envReleaseSec;
      this.envFast[b] += (rms - this.envFast[b]) * (1 - Math.exp(-blockSec / tau));
    }

    // ---- 2. 冲击事件检测:突发上升后快速跌落的,记录为冲击并短暂冻结增益 ----
    let rawMs = 0;
    for (let i = 0; i < mic.length; i++) rawMs += mic[i] * mic[i];
    const rawRms = Math.sqrt(rawMs / mic.length) + EPS;
    const onsetTau = rawRms > this.onsetEnv ? 0.005 : 0.05;
    this.onsetEnv += (rawRms - this.onsetEnv) * (1 - Math.exp(-blockSec / onsetTau));
    if (this.firstBlock) {
      this.broadSmooth = this.onsetEnv;
      this.firstBlock = false;
    } else if (!this.evaluating) {
      this.broadSmooth += (this.onsetEnv - this.broadSmooth) *
        (1 - Math.exp(-blockSec / t.broadSmoothSec));
    }
    const onsetDb = toDb(this.onsetEnv);
    const broadSmoothDb = toDb(this.broadSmooth);

    if (!this.evaluating && onsetDb - broadSmoothDb > t.impulseRiseDb) {
      this.evaluating = true;
      this.evalStartSec = now;
      this.evalPeakDb = onsetDb;
      this.evalHighSec = 0;
    }
    if (this.evaluating) {
      if (onsetDb > this.evalPeakDb) this.evalPeakDb = onsetDb;
      if (onsetDb < this.evalPeakDb - t.impulseDecayDb) {
        // 快起快落 → 短促冲击(行李车撞击):记录事件并继续冻结
        this.freezeUntilSec = now + t.impulseFreezeSec;
        this.evaluating = false;
        this.impulseCount++;
      } else {
        // 电平保持在峰值附近 → 累计高位持续时间
        if (onsetDb > this.evalPeakDb - t.sustainedHoldDb) {
          this.evalHighSec += blockSec;
        } else {
          this.evalHighSec = 0;
        }
        if (this.evalHighSec >= t.sustainedHoldSec ||
            now - this.evalStartSec > t.impulseEvalSec) {
          // 持续噪声:立即放行,参照底对齐防止重复触发
          this.evaluating = false;
          this.broadSmooth = this.onsetEnv;
        }
      }
    }
    const frozen = this.evaluating || now < this.freezeUntilSec;

    // ---- 3. 持续噪声估计(冻结期间不上升) ----
    if (!frozen) {
      for (let b = 0; b < n; b++) {
        const rising = this.envFast[b] > this.sustained[b];
        const tau = rising ? t.noiseRiseTauSec : t.noiseFallTauSec;
        this.sustained[b] += (this.envFast[b] - this.sustained[b]) *
          (1 - Math.exp(-blockSec / tau));
      }
    }

    // ---- 4. 语音输入包络(SPL 上限用) ----
    if (speech) {
      for (let b = 0; b < n; b++) {
        const buf = this.spScratch[b];
        this.spFilters[b].processBlock(speech, buf);
        let ms = 0;
        for (let i = 0; i < buf.length; i++) ms += buf[i] * buf[i];
        const rms = Math.sqrt(ms / buf.length) + EPS;
        const tau = rms > this.spEnv[b] ? t.envAttackSec : t.envReleaseSec;
        this.spEnv[b] += (rms - this.spEnv[b]) * (1 - Math.exp(-blockSec / tau));
      }
    } else {
      const kd = Math.exp(-blockSec / t.envReleaseSec);
      for (let b = 0; b < n; b++) this.spEnv[b] *= kd;
    }

    // ---- 5. 逐频段增益映射 + 宽带 SPL 上限 + 快慢双分量平滑 ----
    let spTotalMs = 0;
    for (let b = 0; b < n; b++) spTotalMs += this.spEnv[b] * this.spEnv[b];
    const spTotalDb = toDb(Math.sqrt(spTotalMs)) + t.splCalibDb;
    const totalCap = this.cfg.maxSplDb - spTotalDb;

    const gainDb = this.gainDbWork;
    for (let b = 0; b < n; b++) {
      const noiseDb = toDb(this.sustained[b]) + t.splCalibDb + this.cfg.micSensitivityDb;
      let target = clamp(
        (noiseDb - this.cfg.noiseRefDb) * this.cfg.slopeDbPerDb,
        this.cfg.minGainDb,
        this.cfg.maxGainDb,
      );
      // 最大声压级上限:整体语音电平 + 增益不得超过 maxSplDb
      target = Math.min(target, totalCap);
      this.targetDbWork[b] = target;

      if (!frozen) {
        const kFast = 1 - Math.exp(-blockSec /
          (target > this.gainFastDb[b] ? t.gainAttackTauSec : t.gainReleaseTauSec));
        const kSlow = 1 - Math.exp(-blockSec /
          (target > this.gainSlowDb[b] ? t.gainSlowTauSec : t.gainReleaseTauSec));
        this.gainFastDb[b] += (target - this.gainFastDb[b]) * kFast;
        this.gainSlowDb[b] += (target - this.gainSlowDb[b]) * kSlow;
      }
      gainDb[b] = t.fastPortion * this.gainFastDb[b] +
        (1 - t.fastPortion) * this.gainSlowDb[b];
    }

    // ---- 6. 语音通路:逐频段施加增益(块内线性插值)→ 求和 → 限幅 ----
    out.fill(0);
    if (speech) {
      for (let b = 0; b < n; b++) {
        const buf = this.spScratch[b];
        const g0 = this.prevGainLin[b];
        const g1 = toLin(gainDb[b]);
        this.prevGainLin[b] = g1;
        const step = (g1 - g0) / buf.length;
        let g = g0;
        for (let i = 0; i < buf.length; i++) {
          g += step;
          out[i] += buf[i] * g;
        }
      }
      // 输出 RMS 硬限幅:保证整块输出声压不超过 maxSplDb
      const limitRms = toLin(this.cfg.maxSplDb - t.splCalibDb);
      let outMs0 = 0;
      for (let i = 0; i < out.length; i++) outMs0 += out[i] * out[i];
      const outRms = Math.sqrt(outMs0 / out.length);
      if (outRms > limitRms) {
        const s = limitRms / (outRms + EPS);
        for (let i = 0; i < out.length; i++) out[i] *= s;
      }
      // 峰值安全软限幅(兜底,正常不会触发)
      const limitLin = limitRms * 1.5;
      for (let i = 0; i < out.length; i++) {
        const y = out[i];
        if (y > limitLin) out[i] = limitLin * Math.tanh(y / limitLin);
        else if (y < -limitLin) out[i] = limitLin * Math.tanh(y / limitLin);
      }
    }

    // ---- 7. 统计 ----
    let outMs = 0;
    for (let i = 0; i < out.length; i++) outMs += out[i] * out[i];
    const splOut = speech ? Math.max(0, toDb(Math.sqrt(outMs / out.length)) + t.splCalibDb) : 0;

    let spMs = 0;
    for (let b = 0; b < n; b++) spMs += this.spEnv[b] * this.spEnv[b];
    const noiseDbOut = toDb(Math.sqrt(
      this.sustained.reduce((s, v) => s + v * v, 0) / n,
    )) + t.splCalibDb + this.cfg.micSensitivityDb;

    this.updateStats(noiseDbOut, splOut, frozen,
      toDb(Math.sqrt(spMs / n)) + t.splCalibDb);
    this.timeSec += blockSec;
  }

  /** 就地更新统计对象(数组引用不变,避免音频线程分配) */
  private updateStats(noiseDb: number, splOut: number, frozen: boolean, speechDb: number): void {
    const n = this.tuning.numBands;
    const s = this.lastStats;
    let gainSum = 0;
    for (let b = 0; b < n; b++) {
      const g = this.gainDbWork[b];
      s.bandGainDb[b] = g;
      gainSum += g;
      s.bandNoiseDb[b] = toDb(this.sustained[b]) + this.tuning.splCalibDb +
        this.cfg.micSensitivityDb;
    }
    s.noiseDb = noiseDb;
    s.gainDb = gainSum / n;
    s.speechDb = speechDb;
    s.splOutDb = splOut;
    s.frozen = frozen;
    s.impulseEvents = this.impulseCount;
  }

  get stats(): ZoneStats {
    return this.lastStats;
  }

  /** 冲击检测器内部状态(调试/测试用) */
  get detector(): { onsetDb: number; smoothDb: number; evaluating: boolean; frozen: boolean } {
    return {
      onsetDb: toDb(this.onsetEnv),
      smoothDb: toDb(this.broadSmooth),
      evaluating: this.evaluating,
      frozen: this.evaluating || this.timeSec < this.freezeUntilSec,
    };
  }

  /** 增益链路内部状态(调试/测试用) */
  get gainDebug(): { target: number[]; fast: number[]; slow: number[]; sustainedDb: number[] } {
    const n = this.tuning.numBands;
    return {
      target: Array.from(this.targetDbWork.slice(0, n)),
      fast: Array.from(this.gainFastDb),
      slow: Array.from(this.gainSlowDb),
      sustainedDb: Array.from(this.sustained).map((v) => toDb(v) + this.tuning.splCalibDb),
    };
  }

  updateConfig(cfg: ZoneConfig): void {
    this.cfg = cfg;
  }
}
