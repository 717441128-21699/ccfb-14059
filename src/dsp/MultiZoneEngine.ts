// 多分区引擎:一份麦克风输入 + 一份广播语音,驱动 N 个分区的补偿器。

import { NoiseCompensator } from './NoiseCompensator.js';
import type { DspTuning, ZoneConfig, ZoneStats } from './types.js';

export class MultiZoneEngine {
  readonly compensators: NoiseCompensator[] = [];
  private outputs: Float32Array[] = [];

  constructor(
    zones: ZoneConfig[],
    private tuning: DspTuning,
    private sampleRate: number,
    private blockSize: number,
  ) {
    for (const z of zones) {
      this.compensators.push(new NoiseCompensator({ ...z }, tuning, sampleRate, blockSize));
      this.outputs.push(new Float32Array(blockSize));
    }
  }

  /** 处理一个块,返回每个分区的输出(内部缓冲,下次调用前有效) */
  process(mic: Float32Array, speech: Float32Array | null): Float32Array[] {
    for (let z = 0; z < this.compensators.length; z++) {
      const c = this.compensators[z];
      if (c.cfg.enabled) {
        c.process(mic, speech, this.outputs[z]);
      } else {
        this.outputs[z].fill(0);
      }
    }
    return this.outputs;
  }

  stats(): ZoneStats[] {
    return this.compensators.map((c) => c.stats);
  }

  updateZone(index: number, cfg: ZoneConfig): void {
    this.compensators[index]?.updateConfig(cfg);
  }

  updateTuning(tuning: DspTuning, zones: ZoneConfig[]): void {
    // 频段数等结构参数变化时整体重建
    this.tuning = tuning;
    this.compensators.length = 0;
    this.outputs.length = 0;
    for (const z of zones) {
      this.compensators.push(new NoiseCompensator({ ...z }, tuning, this.sampleRate, this.blockSize));
      this.outputs.push(new Float32Array(this.blockSize));
    }
  }
}
