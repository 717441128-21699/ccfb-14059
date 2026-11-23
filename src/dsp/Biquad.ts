// 二阶 IIR(RBJ cookbook),用于分析滤波器组与语音滤波器组。

export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;

  /** 带通(峰值增益 0dB,Q 控制带宽) */
  static bandpass(sampleRate: number, f0: number, q: number): Biquad {
    const b = new Biquad();
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    b.b0 = alpha / a0;
    b.b1 = 0;
    b.b2 = -alpha / a0;
    b.a1 = (-2 * cosw0) / a0;
    b.a2 = (1 - alpha) / a0;
    return b;
  }

  /** 高通(用于合成 fricative 等) */
  static highpass(sampleRate: number, f0: number, q: number): Biquad {
    const b = new Biquad();
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    b.b0 = (1 + cosw0) / 2 / a0;
    b.b1 = -(1 + cosw0) / a0;
    b.b2 = (1 + cosw0) / 2 / a0;
    b.a1 = (-2 * cosw0) / a0;
    b.a2 = (1 - alpha) / a0;
    return b;
  }

  processBlock(input: Float32Array, out: Float32Array): void {
    let { b0, b1, b2, a1, a2, z1, z2 } = this;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      out[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }

  processSample(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void { this.z1 = 0; this.z2 = 0; }
}
