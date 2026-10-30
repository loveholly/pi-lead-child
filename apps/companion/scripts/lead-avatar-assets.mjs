// 生成 Lead 形象的系统素材（主题 default.md 11.12 的 F-8）：Fairy 标记的四种状态。
//   默认 default.png、思考中 thinking.webp（动图）、淡彩 muted.png、离线 offline.png，96×96，透明底。
// 输出到 assets/images/lead-avatar/，再把四张图写成 data URI 放进 src/components/leadAvatarDefaults.ts
// （网页、原生和测试都不用另外配置图片的加载）。
//
// 用法：node scripts/lead-avatar-assets.mjs
// 需要：本机的 Google Chrome、puppeteer-core（PUPPETEER_CORE 给出它的入口文件，不是项目依赖）、img2webp（libwebp）。
// 图形是自己画的几何图形（圆角方块和四角星），不用 Fairy 角色的素材：那个角色没有授权给别人用。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../assets/images/lead-avatar');
const MODULE = join(here, '../src/components/leadAvatarDefaults.ts');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 规格（F-8）。
const SIZE = 96;
const INSET = 2;
const SIDE = SIZE - INSET * 2;
const RADIUS = SIDE / 3;
const STAR = SIDE * 0.56;
const INK = '#10131A';
const GREY = '#667085';
const STROKE = 4;
// 思考中：3 秒一圈循环（星转 90°，四角星转 90° 和原来一样），呼吸两次，每次 1.5 秒，最小缩到 0.72。
const LOOP_MS = 3000;
const BREATH_MS = 1500;
const MIN_SCALE = 0.72;
const FPS = 24;
// 呼吸曲线和 FairyEye 一样（M-7）。
const BEZIER = [0.72, 0, 0.28, 1];

// 四角星：四个尖朝上下左右，边向中心凹。半径 r，中心在 (0, 0)。
function starPath(r) {
  const c = r * 0.115;
  const p = (x, y) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  return `M${p(0, -r)} Q${p(c, -c)} ${p(r, 0)} Q${p(c, c)} ${p(0, r)} Q${p(-c, c)} ${p(-r, 0)} Q${p(-c, -c)} ${p(0, -r)} Z`;
}

function svg({ fill, stroke, star, scale = 1, angle = 0 }) {
  const square = stroke
    ? `<rect x="${INSET + STROKE / 2}" y="${INSET + STROKE / 2}" width="${SIDE - STROKE}" height="${SIDE - STROKE}" rx="${RADIUS - STROKE / 2}" fill="#FFFFFF" stroke="${stroke}" stroke-width="${STROKE}"/>`
    : `<rect x="${INSET}" y="${INSET}" width="${SIDE}" height="${SIDE}" rx="${RADIUS}" fill="${fill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${square}`
    + `<path d="${starPath(STAR / 2)}" fill="${star}" transform="translate(${SIZE / 2} ${SIZE / 2}) rotate(${angle.toFixed(3)}) scale(${scale.toFixed(4)})"/></svg>`;
}

// cubic-bezier(x1, y1, x2, y2) 在 x 处的 y（牛顿法求 t）。
function bezier(x) {
  const [x1, y1, x2, y2] = BEZIER;
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  const slope = (a, b, t) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t ** 2;
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const d = slope(x1, x2, t);
    if (Math.abs(d) < 1e-6) break;
    t -= (at(x1, x2, t) - x) / d;
    t = Math.min(1, Math.max(0, t));
  }
  return at(y1, y2, t);
}

function thinkingFrame(ms) {
  const phase = (ms % BREATH_MS) / BREATH_MS;
  const depth = bezier(phase < 0.5 ? phase * 2 : (1 - phase) * 2);
  return svg({ fill: INK, star: '#FFFFFF', scale: 1 - (1 - MIN_SCALE) * depth, angle: (90 * ms) / LOOP_MS });
}

const puppeteerPath = process.env.PUPPETEER_CORE;
if (!puppeteerPath) throw new Error('PUPPETEER_CORE 没有给出：puppeteer-core 的入口文件（lib/esm/puppeteer/puppeteer-core.js）');
const puppeteer = (await import(puppeteerPath)).default;

mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'lead-avatar-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
  const shoot = async (markup, path) => {
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${markup}</body></html>`);
    await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  };
  await shoot(svg({ fill: INK, star: '#FFFFFF' }), join(OUT, 'default.png'));
  await shoot(svg({ fill: GREY, star: '#FFFFFF' }), join(OUT, 'muted.png'));
  await shoot(svg({ stroke: GREY, star: GREY }), join(OUT, 'offline.png'));
  const frames = Math.round((LOOP_MS / 1000) * FPS);
  const files = [];
  for (let i = 0; i < frames; i += 1) {
    const file = join(work, `frame-${String(i).padStart(3, '0')}.png`);
    await shoot(thinkingFrame((i * LOOP_MS) / frames), file);
    files.push(file);
  }
  execFileSync('img2webp', ['-loop', '0', '-lossless', '-d', String(Math.round(LOOP_MS / frames)), ...files, '-o', join(OUT, 'thinking.webp')]);
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(OUT, 'lead-avatar.svg'), svg({ fill: INK, star: '#FFFFFF' }));

const uri = (file, type) => `data:${type};base64,${readFileSync(join(OUT, file)).toString('base64')}`;
writeFileSync(MODULE, [
  '// 生成的文件，不要手改：node scripts/lead-avatar-assets.mjs（主题 default.md 11.12 的 F-8）。',
  '// Lead 形象的系统素材，四种状态各一张，写成 data URI：网页、原生和测试都能直接用。',
  'export const leadAvatarDefaults = {',
  `  default: '${uri('default.png', 'image/png')}',`,
  `  thinking: '${uri('thinking.webp', 'image/webp')}',`,
  `  muted: '${uri('muted.png', 'image/png')}',`,
  `  offline: '${uri('offline.png', 'image/png')}',`,
  '} as const;',
  '',
].join('\n'));
console.log('ok', OUT);
