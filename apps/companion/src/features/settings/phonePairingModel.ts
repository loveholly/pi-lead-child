// 设置 → 设备 → 添加手机 的纯函数：设备名的校验、倒计时和地址的写法、错误的说明。
import { reasonText } from './deviceModel';

export const DEFAULT_PHONE_NAME = '手机';
export const PHONE_NAME_MAX = 80;

// 网关按去掉首尾空白后的长度校验（1 到 80）。这里先校验一遍，给出中文的说明。
export function phoneNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '请填写设备名';
  if (trimmed.length > PHONE_NAME_MAX) return `设备名最多 ${PHONE_NAME_MAX} 个字符`;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '设备名不能包含换行等控制字符';
  return null;
}

// 剩下的时间，写成「分:秒」。不足一秒的部分向上取整，到 0 才算过期。
export function countdownLabel(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ws://192.168.1.20:47130 → 192.168.1.20:47130。
export function endpointLabel(endpoint: string): string {
  return endpoint.replace(/^wss?:\/\//, '');
}

// 一个模块几个像素：码的边长（含静区）尽量接近 300，最少 3。一份邀请大约是 61×61 的码，每个模块 4 像素。
export function qrModuleSize(size: number): number {
  return Math.max(3, Math.floor(300 / (size + 8)));
}

function statusOf(reason: unknown): number | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined;
  const status = (reason as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function isNotFound(reason: unknown): boolean {
  return statusOf(reason) === 404;
}

// 生成邀请失败时的说明。网关的几种拒绝各有原因，按状态码说清楚怎么办。
export function invitationErrorText(reason: unknown): string {
  switch (statusOf(reason)) {
    case 409:
      return '网关只在本机监听，手机连不上。请在 Mac 上设置 PLC_GATEWAY_HOST 和 PLC_GATEWAY_PORT，然后重启 daemon。';
    case 404:
      return '这个 daemon 没有开启本机网页配对。请在 Mac 的终端运行 plc pair new。';
    case 403:
      return '只有在运行 daemon 的 Mac 上打开的网页才能添加手机。';
    default:
      return reasonText(reason);
  }
}
