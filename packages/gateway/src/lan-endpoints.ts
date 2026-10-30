// 手机扫码配对时连哪个地址。地址由网关决定，不由页面决定：只给网关真正在监听、手机在局域网上能连到的地址。
// - 网关在通配地址（0.0.0.0、::）上监听时，本机每个非内部的 IPv4 地址都能连。
// - 网关在具体地址上另开监听（PLC_GATEWAY_HOST 是局域网或 Tailscale 地址）时，只有那个地址能连。
// - 只在回环上监听时，手机连不上，列表是空的。
// 169.254.x.x 是没拿到 DHCP 时的自分配地址，手机通常连不到，不列出来。
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type NetworkInterfaceReader = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

// 网关的一个监听：主监听，或者 listenAlso 另开的监听。
export interface ListeningAddress {
  address: string;
  port: number;
}

function isWildcard(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

function isPrivateLan(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// 本机非内部的 IPv4 地址。家庭和办公室的局域网地址（10/8、172.16/12、192.168/16）排在前面，
// 其他的（例如 Tailscale 的 100.x）排在后面。同一组里保持网卡的顺序。
export function lanIPv4Addresses(readInterfaces: NetworkInterfaceReader = networkInterfaces): string[] {
  const found: string[] = [];
  for (const entries of Object.values(readInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return [...found.filter(isPrivateLan), ...found.filter((ip) => !isPrivateLan(ip))];
}

// 网关现在在局域网上能接受连接的 WebSocket 地址，例如 ws://192.168.1.20:47130。
export function lanPairingEndpoints(
  listening: ListeningAddress[],
  readInterfaces: NetworkInterfaceReader = networkInterfaces,
): string[] {
  const lan = lanIPv4Addresses(readInterfaces);
  const endpoints: string[] = [];
  const add = (ip: string, port: number) => {
    const endpoint = `ws://${ip}:${port}`;
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  };
  for (const { address, port } of listening) {
    if (isWildcard(address)) {
      for (const ip of lan) add(ip, port);
      continue;
    }
    const ip = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
    if (lan.includes(ip)) add(ip, port);
  }
  return endpoints;
}

// 一个对端地址是不是这台机器（工单 15）。child 和用户在同一台机器上：它连回环地址，或者连本机的局域网地址
// （这时对端地址就是本机网卡的地址）。比较前去掉 IPv4 映射的前缀（::ffff:）和 IPv6 的网卡后缀（%en0）。
// 读不到网卡时只比回环和这条连接自己的本地地址。
function normalizeAddress(address: string): string {
  const withoutZone = address.split("%")[0]!;
  return (withoutZone.startsWith("::ffff:") ? withoutZone.slice("::ffff:".length) : withoutZone).toLowerCase();
}

export function isThisMachineAddress(
  remoteAddress: string | undefined,
  localAddress: string | undefined,
  readInterfaces: NetworkInterfaceReader = networkInterfaces,
): boolean {
  if (!remoteAddress) return true;
  const remote = normalizeAddress(remoteAddress);
  if (remote === "::1" || remote.startsWith("127.")) return true;
  if (localAddress && normalizeAddress(localAddress) === remote) return true;
  try {
    for (const entries of Object.values(readInterfaces())) {
      for (const entry of entries ?? []) if (normalizeAddress(entry.address) === remote) return true;
    }
  } catch {
    return false;
  }
  return false;
}
