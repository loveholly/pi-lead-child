// 测试的 DOM 环境（happy-dom）和浏览器不一样、会让界面测试得出错误结论的几处，在这里补齐。
// apps/companion/test/domShims.ts 的内容和这个文件一样；改一处，另一处也要改。
// node 环境的测试没有 window，这里什么都不做。
// 下面几条是 2026-11-10 升级到 vitest 5、DOM 环境换成 happy-dom 时碰到的。

if (typeof window !== 'undefined') {
  // 媒体查询一律不匹配。Reanimated 用 matchMedia 读"减弱动态效果"，Tamagui 用它算媒体查询。
  // happy-dom 的 matchMedia 按窗口宽度（缺省 1024）真的去匹配，Tamagui 就会按宽屏的媒体查询出样式。测试一直是在
  // 「什么都不匹配」下写的（窗口宽度由各测试自己给 react-native-web），所以这里换掉它，不只是在没有时补上。
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });

  // happy-dom 有 ResizeObserver，但它什么都不做：observe 以后永远不回调。组件看到有 ResizeObserver，就以为量得出
  // 尺寸（例如 ChatList 改用只画看得见的块的虚拟列表），结果什么都量不到，一块也不画。这里去掉它，和量不出尺寸的
  // 环境一致。要测量尺寸的测试自己用 vi.stubGlobal 给一个会回调的 ResizeObserver。
  delete (window as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  // requestAnimationFrame 传给回调的时间要和 Reanimated 的动画起点（performance.now()）是同一个时钟。以前的 DOM 实现
  // 从窗口创建时算起，两个时钟差几秒，动画按负的时间算，永远播不完。这里让回调拿到 performance.now()，和浏览器里一样。
  if (typeof window.requestAnimationFrame === 'function') {
    const requestFrame = window.requestAnimationFrame.bind(window);
    const sameClock = (callback: FrameRequestCallback) => requestFrame(() => callback(performance.now()));
    window.requestAnimationFrame = sameClock;
    globalThis.requestAnimationFrame = sameClock;
  }

  // happy-dom 的 focus() 对任何元素都生效。浏览器只把焦点给能聚焦的元素：有 tabindex 的、带 href 的链接、
  // 没禁用的表单控件、可编辑的元素。react-native-web 的 Modal 挨个对子元素调 focus()，看焦点到没到，
  // 用这个找第一个能聚焦的元素；不补这一条，焦点会落在 Modal 最外面那个普通的 div 上。
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focusIfFocusable(this: HTMLElement, options?: FocusOptions) {
    if (isFocusable(this)) focus.call(this, options);
  };

  // happy-dom 解析不了 flex 的两值写法「flex: <grow> <basis>」，例如 Tamagui 给 flex={1.4} 写的 flex:1.4 0px：
  // 它把第二个值当成 flex-shrink，不合法，整条声明丢掉。这里在插入规则前补上缺省的 flex-shrink（1），
  // 写成三值写法。意思不变，happy-dom 认得。
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function insertRuleWithFullFlex(this: CSSStyleSheet, rule: string, index?: number) {
    return insertRule.call(this, rule.replace(FLEX_GROW_AND_BASIS, 'flex:$1 1 $2'), index);
  };
}

// flex: 后面是一个数（grow），再跟一个带单位的长度或百分比（basis），然后是 ; 或 }。两个数（grow shrink）不匹配。
const FLEX_GROW_AND_BASIS = /\bflex:\s*(\d*\.?\d+)\s+(-?\d*\.?\d+(?:px|%|r?em|vw|vh))(?=\s*[;}])/g;

function isFocusable(element: HTMLElement): boolean {
  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex !== null && !Number.isNaN(Number.parseInt(tabIndex, 10))) return true;
  const editable = element.getAttribute('contenteditable');
  if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true;
  switch (element.localName) {
    case 'a':
    case 'area':
      return element.hasAttribute('href');
    case 'button':
    case 'select':
    case 'textarea':
      return !element.hasAttribute('disabled');
    case 'input':
      return !element.hasAttribute('disabled') && element.getAttribute('type') !== 'hidden';
    case 'iframe':
    case 'summary':
      return true;
    default:
      return false;
  }
}
