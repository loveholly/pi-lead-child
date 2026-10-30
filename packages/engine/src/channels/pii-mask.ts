// 发出去以前的个人信息脱敏（用户 2026-10-22：用 CDP 协助请求是合法的，只要把客户的邮箱脱敏）。
// 在代码里做，不靠模型自觉：代回的正文发出去以前一律过一遍。按邮箱的格式找，不理解文字的意思。
// 保留本地部分的第一个字和域名，例如 jane.doe@acme.com → j***@acme.com。已经脱敏的不会再变。

// 本地部分只认常见字符；* 不在里面，所以 j***@acme.com 不会再匹配。
const EMAIL = /([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,})/g;

/** 把文字里的邮箱脱敏。返回脱敏以后的文字和脱敏了几处。 */
export function maskEmails(text: string): { text: string; masked: number } {
  let masked = 0;
  const result = text.replace(EMAIL, (_, first: string, domain: string) => {
    masked++;
    return `${first}***@${domain}`;
  });
  return { text: result, masked };
}
