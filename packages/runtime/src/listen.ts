// 本机 socket 和网关的 listen。
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:net";

// listen 一次。listen 失败时 reject，并且不留下 error 监听；成功之后，server 后来的错误交给 onLateError。
// 以前的写法用 once("error") 等 listen 的结果，成功之后这个监听一直留着：后来的错误被它吞掉。
export function listenOnce(
  server: Server,
  address: { port: number; host?: string } | { path: string },
  onLateError: (error: Error) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListenError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onListenError);
      server.on("error", onLateError);
      resolve();
    };
    server.once("error", onListenError);
    server.once("listening", onListening);
    if ("path" in address) server.listen(address.path);
    else server.listen(address.port, address.host);
  });
}

// 只给本机同一个用户的 Unix socket。socket 所在的目录（数据目录）先收紧成 0700，没有就以 0700 创建：
// 别的用户进不了这个目录，listen 和 chmod 之间也连不上。之后 socket 本身再 chmod 成 0600。
// 不用 umask：它是进程级的，会影响同一时刻创建的其他文件。
// 注意：这只防别的系统用户。同一个用户的进程（包括 child agent）照样连得上，信任边界是系统用户。
export async function listenOwnerOnly(server: Server, path: string, onLateError: (error: Error) => void = () => {}): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  await listenOnce(server, { path }, onLateError);
  chmodSync(path, 0o600);
}
