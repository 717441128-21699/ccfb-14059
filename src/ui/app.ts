// 应用主逻辑:音频图搭建、场景播放、广播触发、状态分发。

import { MultiZoneEngine } from '../dsp/MultiZoneEngine.js';
import { DEFAULT_TUNING, defaultZones } from '../dsp/types.js';
import type { DspTuning, ZoneConfig, ZoneStats } from '../dsp/types.js';
import { SCENARIOS, makeRng, speech } from '../sim/synth.js';

export interface LogEntry {
  time: string;
  kind: 'broadcast' | 'impulse' | 'system';
  text: string;
  detail: string;
}

export interface HistoryPoint { t: number; noiseDb: number; gainDb: number }

const ANNOUNCEMENTS = [
  '乘坐 CA1835 航班前往北京的旅客请注意,现在开始登机,请前往 32 号登机口',
  '前往上海的 MU5110 航班现在开始值机,请旅客到 A12 柜台办理手续',
  '请看管好您的行李物品,谨防遗失',
  '乘坐 CZ3902 航班前往广州的旅客,登机口变更为 18 号',
];

type Listener = () => void;

export class App {
  zones: ZoneConfig[] = defaultZones();
  tuning: DspTuning = { ...DEFAULT_TUNING };
  selectedZone = 0;
  scenarioId = 'morning';
  running = false;
  autoBroadcast = false;

  stats: ZoneStats[] = [];
  blockMsAvg = 0;
  blockMsMax = 0;
  history: HistoryPoint[] = [];
  logs: LogEntry[] = [];

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private noiseSrc: AudioBufferSourceNode | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private monitorGain: GainNode | null = null;
  private autoTimer: number | null = null;
  private announceIdx = 0;
  private bcast = { active: false, gainSum: 0, gainN: 0, maxSpl: 0, text: '', start: '' };
  private listeners: Record<string, Listener[]> = {};

  on(event: string, fn: Listener): void {
    (this.listeners[event] ??= []).push(fn);
  }
  private emit(event: string): void {
    for (const fn of this.listeners[event] ?? []) fn();
  }

  log(kind: LogEntry['kind'], text: string, detail = ''): void {
    this.logs.unshift({
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      kind, text, detail,
    });
    if (this.logs.length > 200) this.logs.pop();
    this.emit('log');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('./dist/src/worklet/pa-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'pa-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { zones: this.zones, tuning: this.tuning },
    });
    this.node.port.onmessage = (e: MessageEvent) => this.onWorkletMessage(e.data);
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0.8;
    this.node.connect(this.monitorGain).connect(this.ctx.destination);
    this.startScenarioNoise();
    this.running = true;
    if (this.autoBroadcast) this.setAutoBroadcast(true);
    this.log('system', '处理器已启动', `采样率 ${this.ctx.sampleRate} Hz,${this.zones.length} 个分区`);
    this.emit('state');
  }

  stop(): void {
    this.noiseSrc?.stop();
    this.micSrc?.mediaStream.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.noiseSrc = null;
    this.micSrc = null;
    this.running = false;
    this.bcast.active = false;
    if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
    this.log('system', '处理器已停止');
    this.emit('state');
  }

  /** 按当前场景生成噪声并循环播放(作为监听麦克风输入) */
  startScenarioNoise(): void {
    if (!this.ctx || !this.node) return;
    this.noiseSrc?.stop();
    this.micSrc?.disconnect();
    this.micSrc = null;
    const sc = SCENARIOS.find((s) => s.id === this.scenarioId) ?? SCENARIOS[0];
    const data = sc.build(this.ctx.sampleRate, 12);
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.node, 0, 0);
    src.start();
    this.noiseSrc = src;
    this.log('system', `场景切换:${sc.label}`, sc.description);
  }

  setScenario(id: string): void {
    this.scenarioId = id;
    if (this.running) this.startScenarioNoise();
  }

  /** 接入真实麦克风替代合成噪声 */
  async useRealMic(): Promise<void> {
    if (!this.ctx || !this.node) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.noiseSrc?.stop();
      this.noiseSrc = null;
      this.micSrc = this.ctx.createMediaStreamSource(stream);
      this.micSrc.connect(this.node, 0, 0);
      this.log('system', '已切换到真实麦克风');
    } catch {
      this.log('system', '麦克风不可用', '已继续使用合成场景噪声');
    }
    this.emit('state');
  }

  /** 触发一次广播 */
  broadcast(): void {
    if (!this.ctx || !this.node || this.bcast.active) return;
    const text = ANNOUNCEMENTS[this.announceIdx++ % ANNOUNCEMENTS.length];
    const data = speech(this.ctx.sampleRate, 5, -20, makeRng(Date.now() & 0xffff));
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.node, 0, 1);
    this.bcast = {
      active: true, gainSum: 0, gainN: 0, maxSpl: 0, text,
      start: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    src.onended = () => {
      src.disconnect();
      const avgGain = this.bcast.gainN ? this.bcast.gainSum / this.bcast.gainN : 0;
      this.log('broadcast', `广播:${text}`,
        `平均增益 ${avgGain.toFixed(1)} dB,峰值声压 ${this.bcast.maxSpl.toFixed(1)} dB SPL`);
      this.bcast.active = false;
      this.emit('state');
    };
    src.start();
    this.emit('state');
  }

  setAutoBroadcast(on: boolean): void {
    this.autoBroadcast = on;
    if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
    if (on && this.running) {
      this.autoTimer = window.setInterval(() => this.broadcast(), 15000);
    }
  }

  setMonitorVolume(v: number): void {
    if (this.monitorGain) this.monitorGain.gain.value = v;
  }

  selectZone(i: number): void {
    this.selectedZone = i;
    this.node?.port.postMessage({ type: 'selectZone', index: i });
    this.emit('state');
  }

  updateZone(index: number, patch: Partial<ZoneConfig>): void {
    Object.assign(this.zones[index], patch);
    this.node?.port.postMessage({ type: 'zoneConfig', index, cfg: this.zones[index] });
    this.emit('config');
  }

  private onWorkletMessage(m: { type: string;[k: string]: unknown }): void {
    if (m.type === 'stats') {
      this.stats = m.zones as ZoneStats[];
      this.blockMsAvg = m.blockMsAvg as number;
      this.blockMsMax = m.blockMsMax as number;
      const s = this.stats[this.selectedZone];
      if (s) {
        this.history.push({ t: performance.now() / 1000, noiseDb: s.noiseDb, gainDb: s.gainDb });
        if (this.history.length > 1500) this.history.shift();
      }
      if (this.bcast.active && s) {
        this.bcast.gainSum += s.gainDb;
        this.bcast.gainN++;
        if (s.splOutDb > this.bcast.maxSpl) this.bcast.maxSpl = s.splOutDb;
      }
      this.emit('stats');
    } else if (m.type === 'impulse') {
      const z = this.zones[m.zone as number];
      this.log('impulse', `冲击噪声冻结:${z?.name ?? m.zone}`,
        '检测到短促冲击,增益保持 1s 不抬升');
    }
  }

  /** 主线程基准:8 分区同时处理每块耗时(验证 < 3ms) */
  benchmark(blocks = 10000): { avgMs: number; maxMs: number } {
    const sr = 48000, bs = 128;
    const engine = new MultiZoneEngine(this.zones, this.tuning, sr, bs);
    const mic = new Float32Array(bs).map(() => Math.random() * 0.1 - 0.05);
    const sp = new Float32Array(bs).map(() => Math.random() * 0.1 - 0.05);
    // 预热
    for (let i = 0; i < 200; i++) engine.process(mic, sp);
    let max = 0;
    const t0 = performance.now();
    for (let i = 0; i < blocks; i++) engine.process(mic, sp);
    const total = performance.now() - t0;
    // 单块最大值粗测(分段取)
    for (let i = 0; i < 200; i++) {
      const a = performance.now();
      engine.process(mic, sp);
      max = Math.max(max, performance.now() - a);
    }
    return { avgMs: total / blocks, maxMs: max };
  }
}
