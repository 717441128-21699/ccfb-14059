// 共享类型与默认参数:DSP 核心、AudioWorklet、UI、测试都从这里取配置。

/** 单个扬声器分区的配置 */
export interface ZoneConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** 监听麦克风灵敏度修正(dB),加到噪声测量值上 */
  micSensitivityDb: number;
  /** 增益映射:噪声等于该值时增益为 0 */
  noiseRefDb: number;
  /** 噪声每高出参考 1dB,语音增益抬升多少 dB */
  slopeDbPerDb: number;
  /** 安静环境(如半夜)下的最低增益,可为负(衰减) */
  minGainDb: number;
  /** 噪声再大也不超过的增益上限 */
  maxGainDb: number;
  /** 该分区允许的最大输出声压级(dB SPL) */
  maxSplDb: number;
}

/** DSP 全局动态参数(冲击识别、跟随速度等) */
export interface DspTuning {
  numBands: number;
  /** 包络快攻/快放(噪声测量用) */
  envAttackSec: number;
  envReleaseSec: number;
  /** 宽带电平平滑(冲击检测的参照底) */
  broadSmoothSec: number;
  /** 一块内电平跳变超过该值 → 进入冲击评估 */
  impulseRiseDb: number;
  /** 评估窗口内从峰值跌落超过该值 → 判定为冲击噪声 */
  impulseDecayDb: number;
  /** 冲击评估窗口(秒)。窗口内跌回峰值 -impulseDecayDb 以下 → 判定冲击 */
  impulseEvalSec: number;
  /** 判定冲击后增益冻结时长(秒) */
  impulseFreezeSec: number;
  /** 持续高位判定:评估期内电平保持在峰值 -sustainedHoldDb 以内
      累计 sustainedHoldSec 秒 → 判定为持续噪声,立即放行 */
  sustainedHoldDb: number;
  sustainedHoldSec: number;
  /** 持续噪声估计的上升/下降时间常数 */
  noiseRiseTauSec: number;
  noiseFallTauSec: number;
  /** 增益快分量/慢分量时间常数(快分量保证 20dB 阶跃 300ms 内跟上,
      慢分量让完全跟上需要持续约 2 秒以上的噪声) */
  gainAttackTauSec: number;
  gainSlowTauSec: number;
  gainReleaseTauSec: number;
  /** 快分量占比(其余为慢分量) */
  fastPortion: number;
  /** 声压级标定:0 dBFS 相当于多少 dB SPL */
  splCalibDb: number;
}

export const DEFAULT_TUNING: DspTuning = {
  numBands: 8,
  envAttackSec: 0.010,
  envReleaseSec: 0.20,
  broadSmoothSec: 1.0,
  impulseRiseDb: 8,
  impulseDecayDb: 8,
  impulseEvalSec: 0.35,
  impulseFreezeSec: 1.0,
  sustainedHoldDb: 4,
  sustainedHoldSec: 0.12,
  noiseRiseTauSec: 0.025,
  noiseFallTauSec: 1.0,
  gainAttackTauSec: 0.025,
  gainSlowTauSec: 1.5,
  gainReleaseTauSec: 2.0,
  fastPortion: 0.91,
  splCalibDb: 94,
};

/** 8 个默认分区 */
export function defaultZones(): ZoneConfig[] {
  const names = [
    'A1 值机大厅', 'A2 安检区', 'B1 候机厅东', 'B2 候机厅西',
    'C1 到达厅', 'C2 行李提取', 'D1 商业区', 'D2 登机长廊',
  ];
  return names.map((name, i) => ({
    id: `zone-${i + 1}`,
    name,
    enabled: true,
    micSensitivityDb: 0,
    noiseRefDb: 55,
    slopeDbPerDb: 0.9,
    minGainDb: -10,
    maxGainDb: 18,
    maxSplDb: i === 5 ? 90 : 95, // 行李提取区限得更严一点
  }));
}

/** 每个分区一块的实时统计(供监视界面/测试读取) */
export interface ZoneStats {
  /** 宽带持续噪声电平(dB SPL) */
  noiseDb: number;
  /** 当前平均语音增益(dB) */
  gainDb: number;
  /** 广播输入电平(dB SPL 等效) */
  speechDb: number;
  /** 输出声压级(dB SPL) */
  splOutDb: number;
  /** 是否处于冲击冻结 */
  frozen: boolean;
  /** 已识别到的冲击次数 */
  impulseEvents: number;
  /** 各频段持续噪声(dB SPL) */
  bandNoiseDb: number[];
  /** 各频段当前增益(dB) */
  bandGainDb: number[];
}
