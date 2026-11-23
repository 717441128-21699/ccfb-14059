// 调试:阶跃场景增益链路
import { MultiZoneEngine } from '../src/dsp/MultiZoneEngine.js';
import { DEFAULT_TUNING, defaultZones } from '../src/dsp/types.js';
import { babble, speech, makeRng } from '../src/sim/synth.js';

const SR = 48000, BS = 128;

const mic = babble(SR, 7, -39, makeRng(4));
const loud = babble(SR, 7, -19, makeRng(5));
for (let i = Math.floor(2 * SR); i < mic.length; i++) mic[i] = loud[i];

const eng = new MultiZoneEngine(defaultZones().slice(0, 1), DEFAULT_TUNING, SR, BS);
const sp = speech(SR, 7, -20, makeRng(8));
const c = (eng as unknown as { compensators: {
  detector: { evaluating: boolean };
  gainDebug: { target: number[]; fast: number[]; slow: number[]; sustainedDb: number[] };
}[] }).compensators;

for (let b = 0; b < Math.floor(mic.length / BS); b++) {
  eng.process(mic.subarray(b * BS, (b + 1) * BS), sp.subarray(b * BS, (b + 1) * BS));
  const t = b * BS / SR;
  if (t > 2.0 && t < 3.2 && b % 15 === 0) {
    const g = c[0].gainDebug;
    const s = eng.stats()[0];
    // 打印 2kHz 频段(索引 4)和平均值
    const avgT = g.target.reduce((a, v) => a + v, 0) / g.target.length;
    const avgF = g.fast.reduce((a, v) => a + v, 0) / g.fast.length;
    const avgS = g.slow.reduce((a, v) => a + v, 0) / g.slow.length;
    console.log(`t=${t.toFixed(3)} eval=${c[0].detector.evaluating ? 1 : 0} ` +
      `tgt=${avgT.toFixed(2)} fast=${avgF.toFixed(2)} slow=${avgS.toFixed(2)} ` +
      `gain=${s.gainDb.toFixed(2)} sus[4]=${g.sustainedDb[4].toFixed(1)} tgt[4]=${g.target[4].toFixed(2)}`);
  }
}
