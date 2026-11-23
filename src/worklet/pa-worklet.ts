// AudioWorklet 处理器:在音频渲染线程里跑 8 分区 DSP。
// 输入 0 = 监听麦克风(环境噪声),输入 1 = 广播语音,输出 = 当前选中分区的监听。

import { MultiZoneEngine } from '../dsp/MultiZoneEngine.js';
import { DEFAULT_TUNING, defaultZones } from '../dsp/types.js';
import type { DspTuning, ZoneConfig, ZoneStats } from '../dsp/types.js';

// AudioWorklet 全局作用域类型(标准 lib.dom 未包含)
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
declare const sampleRate: number;
declare const currentTime: number;

interface StatsMessage {
  type: 'stats';
  zones: ZoneStats[];
  selected: number;
  blockMsAvg: number;
  blockMsMax: number;
}

class PaProcessor extends AudioWorkletProcessor {
  private engine: MultiZoneEngine | null = null;
  private zones: ZoneConfig[];
  private tuning: DspTuning;
  private selected = 0;
  private blockCount = 0;
  private msAccum = 0;
  private msMax = 0;
  private lastImpulseCounts: number[] = [];

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = (options.processorOptions ?? {}) as {
      zones?: ZoneConfig[]; tuning?: DspTuning;
    };
    this.zones = opts.zones ?? defaultZones();
    this.tuning = opts.tuning ?? DEFAULT_TUNING;
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  private onMessage(m: { type: string;[k: string]: unknown }): void {
    if (m.type === 'selectZone') {
      this.selected = m.index as number;
    } else if (m.type === 'zoneConfig') {
      const i = m.index as number;
      this.zones[i] = m.cfg as ZoneConfig;
      this.engine?.updateZone(i, m.cfg as ZoneConfig);
    } else if (m.type === 'tuning') {
      this.tuning = m.tuning as DspTuning;
      this.engine?.updateTuning(this.tuning, this.zones);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const micIn = inputs[0]?.[0];
    if (!micIn || micIn.length === 0) return true;
    const speechIn = inputs[1]?.[0] ?? null;

    // 首个块按实际块长建引擎(渲染量子当前为 128 采样)
    if (!this.engine) {
      this.engine = new MultiZoneEngine(this.zones, this.tuning, sampleRate, micIn.length);
      this.lastImpulseCounts = this.zones.map(() => 0);
    }

    const perf = (globalThis as { performance?: { now(): number } }).performance;
    const t0 = perf ? perf.now() : 0;
    const outs = this.engine.process(micIn, speechIn);
    const dt = perf ? perf.now() - t0 : 0;
    this.msAccum += dt;
    if (dt > this.msMax) this.msMax = dt;

    // 输出选中分区(双声道同信号)
    const sel = Math.min(this.selected, outs.length - 1);
    const mono = outs[sel];
    for (const ch of outputs[0] ?? []) ch.set(mono);

    // 冲击事件即时上报
    const st = this.engine.stats();
    for (let z = 0; z < st.length; z++) {
      if (st[z].impulseEvents !== this.lastImpulseCounts[z]) {
        this.lastImpulseCounts[z] = st[z].impulseEvents;
        this.port.postMessage({ type: 'impulse', zone: z, time: currentTime });
      }
    }

    // 每 12 块(≈32ms)上报一次统计
    this.blockCount++;
    if (this.blockCount % 12 === 0) {
      const msg: StatsMessage = {
        type: 'stats',
        zones: st,
        selected: sel,
        blockMsAvg: this.msAccum / this.blockCount,
        blockMsMax: this.msMax,
      };
      this.port.postMessage(msg);
      this.blockCount = 0;
      this.msAccum = 0;
      this.msMax = 0;
    }
    return true;
  }
}

registerProcessor('pa-processor', PaProcessor);
