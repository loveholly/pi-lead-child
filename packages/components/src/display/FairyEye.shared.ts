// FairyEye 的规格（主题 11.12、M-7 到 M-10）：形状、三种色调和动的节奏。和渲染分开，方便单独测。
//
// 出处：形状和节奏改编自 ymd-physics/pi-fairy 的 modules/animation（assets/fairy.svg、assets/idle-motion.json、
// scripts/frame-svg.mjs）。那几份文件是 Apache-2.0，本身改编自 Chengzhibense/Fairy-DSH（Copyright 2026 Chengzhibense，
// commit d639887a386b0de6fef2e61c97dc268631854591）。这里的改动：只留圆盘、方块、四层眼睛和高光，去掉光晕和渐变；
// 坐标换成 142 见方的盒子；待机转速改成 24 秒一圈、思考 8 秒一圈；加了状态切换和小尺寸加深幅度。
// Apache-2.0 不授予 Fairy 角色、名字和游戏的任何权利；这个仓库对外发布前要换成原创形象，或者带上 NOTICE 和许可证。

// 盒子是 142 见方（原图的 viewBox 是 -1..161，这里取 9..151，圆盘贴着盒子的边）。中心在 71。
export const FAIRY_BOX = 142;
export const FAIRY_CENTER = 71;

// 各层的直径（盒子的单位）。高光相对中心的偏移也是盒子的单位。
export const fairyGeometry = {
  disc: 136,
  cornersCircle: 103.5,
  cornersSquare: 86,
  // 方块本身斜 3 度（原图的 rotate(3 80 80)），转动叠加在它上面。
  cornersSquareTilt: 3,
  sclera: 96,
  irisOuter: 66,
  irisRing: 48.3,
  iris: 47,
  pupil: 32,
  highlight: 22,
  highlightHalo: 28,
  highlightOffset: { x: 18, y: 20.5 },
} as const;

export type FairyEyeTone = 'color' | 'muted' | 'quiet';
export type FairyEyeState = 'idle' | 'thinking';

export type FairyPalette = {
  disc: string;
  corners: string;
  sclera: string;
  irisOuter: string;
  iris: string;
  pupil: string;
  highlight: string;
};

// 三种色调（主题 F-1 到 F-3）。颜色是 Fairy 的样子，不是界面的强调色，所以不走外观旋钮。
//   color：原图的蓝（圆盘取渐变中间的那一档）。圆盘对白底约 7:1。
//   muted：同一个蓝紫色，降低饱和度，用在答完的消息上。圆盘对白底约 3.1:1（P13.4 图形至少 3:1）。
//   quiet：灰度，保留彩色版的明暗结构，只用于离线。圆盘对白底约 4.8:1。
export const fairyPalettes: Record<FairyEyeTone, FairyPalette> = {
  color: { disc: '#3045DC', corners: '#2B3388', sclera: '#EEF0F5', irisOuter: '#9DAEE0', iris: '#317BCF', pupil: '#3B3D8A', highlight: '#F5F8FD' },
  muted: { disc: '#7B8CE8', corners: '#6676DA', sclera: '#F5F7FF', irisOuter: '#C9D2F6', iris: '#6E9BE0', pupil: '#4A4F9E', highlight: '#FFFFFF' },
  quiet: { disc: '#667085', corners: '#475467', sclera: '#FFFFFF', irisOuter: '#B7BDC7', iris: '#667085', pupil: '#10131A', highlight: '#FFFFFF' },
};

// 动的节奏（主题 M-7 到 M-10）。
export const fairyMotion = {
  idleTurnMs: 24_000,
  busyTurnMs: 8_000,
  breathMs: 1_500,
  // 状态切换时转速和呼吸幅度过渡到新值用的时间（M-9）。
  switchMs: 260,
  // 24 以下的尺寸，呼吸的幅度加大（M-8）。
  smallSize: 24,
  smallDepth: 1.6,
  // 减弱动态效果时，思考中的瞳孔停在这个位置（0 是张开，1 是缩到最小）。
  reducedHold: 0.6,
  // 呼吸曲线（原图 idle-motion.json 的 bezier）。
  bezier: [0.72, 0, 0.28, 1] as const,
} as const;

// 四层眼睛：张开时的比例、缩到最小时的比例、相位领先多少圈。瞳孔先缩，外面依次跟上。
export type FairyLayer = 'sclera' | 'irisOuter' | 'iris' | 'pupil';
export const fairyLayers: Record<FairyLayer, { expanded: number; contracted: number; lead: number }> = {
  sclera: { expanded: 0.985, contracted: 0.91, lead: 0 },
  irisOuter: { expanded: 1, contracted: 0.9, lead: 0.03125 },
  iris: { expanded: 1, contracted: 0.87, lead: 0.0625 },
  pupil: { expanded: 1, contracted: 0.85, lead: 0.125 },
};

// 三次贝塞尔曲线：给横坐标求纵坐标（先二分求参数，再算纵坐标）。不是直接把时间代进去。
export function fairyEase(value: number): number {
  'worklet';
  const x = Math.max(0, Math.min(1, value));
  if (x === 0 || x === 1) return x;
  const [x1, y1, x2, y2] = fairyMotion.bezier;
  const cubic = (t: number, a: number, b: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (cubic(mid, x1, x2) < x) low = mid;
    else high = mid;
  }
  return cubic((low + high) / 2, y1, y2);
}

// 一层眼睛在某一时刻的比例。
//   timeMs：页面时钟。几个 Fairy 用同一个时钟，所以一起呼吸。
//   amplitude：0 不呼吸，1 完全呼吸（状态切换时在两者之间过渡）。
//   depth：幅度倍数（小尺寸 1.6）。
//   hold：给了就不跟时钟走，停在这个进度（减弱动态效果）。
export function fairyLayerScale(layer: FairyLayer, timeMs: number, amplitude: number, depth: number, hold?: number): number {
  'worklet';
  const spec = fairyLayers[layer];
  let progress: number;
  if (hold !== undefined) {
    progress = hold;
  } else {
    const phase = (((timeMs / fairyMotion.breathMs) + spec.lead) % 1 + 1) % 1;
    progress = fairyEase(phase <= 0.5 ? phase * 2 : 2 - phase * 2);
  }
  return spec.expanded - (spec.expanded - spec.contracted) * depth * amplitude * progress;
}

// 方块转一帧以后的角度。方块转 90 度和原来重合，所以角度只在 0 到 90 之间走。
export function fairyNextAngle(angle: number, degPerMs: number, dtMs: number): number {
  'worklet';
  return (angle + degPerMs * Math.min(dtMs, 64)) % 90;
}

// 转速（度每毫秒）。只有彩色、没开减弱动态效果时才转。
export function fairyTurnSpeed(state: FairyEyeState, moving: boolean): number {
  if (!moving) return 0;
  return 360 / (state === 'thinking' ? fairyMotion.busyTurnMs : fairyMotion.idleTurnMs);
}

export function fairyDepth(size: number): number {
  return size <= fairyMotion.smallSize ? fairyMotion.smallDepth : 1;
}
