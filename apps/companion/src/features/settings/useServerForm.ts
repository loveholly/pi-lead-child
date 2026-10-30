import { useState } from 'react';

type Fields = Record<string, string>;

// 初始值来自服务端的表单。服务端的值变了（保存成功，或者别的设备改了设置）时，表单不重新挂载：
// 用户没改过的字段跟着服务端走，改过还没保存的字段留着用户的输入。保存的结果提示也就不会被冲掉。
export function useServerForm<T extends Fields>(server: T) {
  const [state, setState] = useState({ form: server, baseline: server });
  let { form } = state;
  if (!sameFields(state.baseline, server)) {
    // 渲染时按上一次的服务端值更新状态（React 文档里「保存上一次渲染的信息」的写法），不用 effect，不多渲染一轮旧值。
    form = rebase(state.form, state.baseline, server);
    setState({ form, baseline: server });
  }
  const setForm = (update: (current: T) => T) => setState((current) => ({ ...current, form: update(current.form) }));
  const field = (name: keyof T) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  return { form, setForm, field };
}

function sameFields<T extends Fields>(a: T, b: T): boolean {
  return Object.keys(b).every((name) => a[name] === b[name]);
}

export function rebase<T extends Fields>(form: T, baseline: T, server: T): T {
  const next: Fields = { ...form };
  for (const name of Object.keys(server)) {
    if (form[name] === baseline[name]) next[name] = server[name]!;
  }
  return next as T;
}
