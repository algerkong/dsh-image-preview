/**
 * dsh-image-preview self-check.
 *
 * 校验三层契约：
 *   1) bundle 自注册契约（__ModuleLoader__.load 形状、id、exports）
 *   2) 与真实 dsh slot registry 的注册契约 —— 用最小 keyed-slot 复刻件证明：
 *        官方 read_image 已在默认 priority 注册时，插件必须以更低 priority 才能接管，
 *        否则 apply() 抛 “already has an entry for key ... at priority 0”。
 *      这正是本插件此前在 dsh 0.1.5-rc.2 上彻底不渲染的根因。
 *      dsh 0.2.x 的官方条目还会声明 tool.call.images 子 slot；插件接管整行但
 *      不声明 children，避免与官方声明冲突。
 *   3) 运行时渲染契约 —— 用真实 react + 自带的极简 reconciler 递归展开函数组件，断言：
 *        - 不再自己 fetch /api/session.attachment（改用注入的 loadImage）
 *        - 经 loadImage 取图并渲染缩略图
 *        - 点击缩略图打开 Lightbox，Esc 可关闭
 *        - 多图走网格 + 左右导航 + 计数器，且 registry 按 sessionId 隔离
 *        - 最终输出 image block、Markdown 图片、present 交付图片都能接管
 *        - 交付图片的三处文件操作走 Session Remote / sidebarRight
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(root, "lib/client.js"), "utf8");

// ── 1) bundle 自注册契约 ────────────────────────────────────────────────
let spec;
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
globalThis.document = undefined; // style-injection guard
await import(pathToFileURL(path.join(root, "lib/client.js")).href);

assert.ok(spec, "lib/client.js 必须调用 window.__ModuleLoader__.load({ id, factory })");
assert.equal(spec.id, "@alger-ai/dsh-image-preview", "id 必须等于 bundle 名");
assert.equal(typeof spec.factory, "function", "factory 必须是函数");

const duckPlugin = spec.factory((id) => {
  if (id === "react" || id === "react-dom" || id === "react/jsx-runtime") return {};
  throw new Error(`unexpected require: ${id}`);
});
assert.equal(typeof duckPlugin.apply, "function", "factory 必须返回 { apply }");
assert.ok(Array.isArray(duckPlugin.inject) && duckPlugin.inject.includes("slots"), "inject 必须声明 slots");
console.log(`✅ 1/3 自注册契约通过 (id=${spec.id}, inject=${JSON.stringify(duckPlugin.inject)})`);

// ── 2) slot 注册契约：必须用更低 priority 接管官方 read_image ────────────
// 最小复刻件，对齐 dsh 0.2.1-rc.2 slot registry 的 keyed 分支与 children 声明语义。
class KeyedSlotRegistry {
  constructor() {
    this.entries = [];
    // "root" 由 SlotCore 内建；tool.call.toolview 由 ToolCallTree 的 children 声明；
    // conversation.chat.message.images 由 chat 的 assistant-step 声明。
    this.declared = new Map([
      ["root", "(built-in)"],
      ["tool.call.toolview", "root"],
      ["conversation.chat.message.images", "assistant-step"],
      ["conversation.chat.user.images", "user-content"],
    ]);
  }
  declare(name, by) {
    if (this.declared.has(name)) {
      throw new Error(`slot "${name}" is already declared (by ${this.declared.get(name)})`);
    }
    this.declared.set(name, by);
  }
  register(options) {
    if (!this.declared.has(options.name)) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
    }
    const priority = options.priority ?? 0;
    const clash = this.entries.find((e) =>
      e.options.name === options.name &&
      e.options.key === options.key &&
      (e.options.priority ?? 0) === priority
    );
    if (clash !== undefined) {
      throw new Error(
        `keyed slot "${options.name}" already has an entry for key "${options.key}" ` +
        `at priority ${priority} — register at a different priority to shadow it (lowest renders)`,
      );
    }
    // 子 slot 声明发生在条目注册时，且跨条目全局唯一（0.2.x 语义）。
    for (const child of Object.keys(options.children ?? {})) {
      this.declare(child, `an entry in "${options.name}"`);
    }
    const entry = { options };
    this.entries = [...this.entries, entry].sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
    return () => { this.entries = this.entries.filter((e) => e !== entry); };
  }
  /** 最低 priority 者渲染（与 registry 的 "lowest renders" 一致）。 */
  renderKey(key) { return this.entries.find((e) => e.options.key === key); }
}

const registry = new KeyedSlotRegistry();
// 官方 dsh 自带的 read_image toolview 已以默认 priority 注册；0.2.x 起它还声明
// tool.call.images 子 slot，由 ui-attachment 的 MessageImages 填充。
registry.register({
  name: "tool.call.toolview",
  key: "read_image",
  locale: "conversation",
  children: { "tool.call.images": { kind: "single", scope: "session" } },
});

const captured = [];
duckPlugin.apply({
  slots: {
    inject(_name, cb) { cb(); },
    register(options, component) {
      captured.push({ options, component });
      return registry.register(options);
    },
  },
});
assert.equal(captured.length, 3, "apply() 必须注册 toolview、最终输出图片、用户图片三个 slot 接管项");

const reg = captured.find((entry) => entry.options.name === "tool.call.toolview")?.options;
const messageReg = captured.find((entry) => entry.options.name === "conversation.chat.message.images")?.options;
const userReg = captured.find((entry) => entry.options.name === "conversation.chat.user.images")?.options;
assert.ok(reg !== undefined, "必须注册 tool.call.toolview");
assert.ok(messageReg !== undefined, "必须注册 conversation.chat.message.images");
assert.ok(userReg !== undefined, "必须注册 conversation.chat.user.images");
assert.equal(reg.key, "read_image", "必须接管 read_image key");
assert.equal(reg.locale, "conversation", "必须声明 conversation locale");
assert.ok(
  typeof reg.priority === "number" && reg.priority < 0,
  `接管官方 read_image 必须使用更低的 priority（< 0），当前=${String(reg.priority)}；` +
  "否则 keyed slot 同 key 同 priority 会抛错",
);
assert.equal(reg.children, undefined, "插件接管整行即可，不应重复声明官方已有的 tool.call.images 子 slot");
assert.ok(registry.declared.has("tool.call.images"), "官方声明过的 tool.call.images 不应因插件接管而消失");
assert.equal(registry.renderKey("read_image").options.priority, reg.priority, "插件的低 priority 条目应被选中渲染");

assert.equal(messageReg.locale, "conversation", "最终输出图片 slot 也必须声明 conversation locale");
assert.ok(
  typeof messageReg.priority === "number" && messageReg.priority < 100,
  `接管官方 MessageImages（priority 100）必须使用更低的 priority，当前=${String(messageReg.priority)}`,
);
assert.equal(userReg.locale, "conversation", "用户图片 slot 也必须声明 conversation locale");
assert.ok(
  typeof userReg.priority === "number" && userReg.priority < 100,
  `接管官方用户 MessageImages（priority 100）必须使用更低的 priority，当前=${String(userReg.priority)}`,
);
assert.equal(registry.entries.find((entry) => entry.options.name === "conversation.chat.message.images")?.options.priority, messageReg.priority, "最终输出图片接管条目应被注册");
console.log(`✅ 2/3 slot 接管契约通过 (read_image priority=${reg.priority} < 0；message.images priority=${messageReg.priority} < 100；user.images priority=${userReg.priority} < 100)`);

// ── 3) 运行时渲染契约 ──────────────────────────────────────────────────
// 只看代码不看注释：剥掉块注释与行注释后再断言，避免文档提及旧实现导致误判。
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

assert.ok(!/fetch\s*\(/.test(code), "不应再自己 fetch（应复用官方注入的 loadImage）");
assert.ok(
  !/client-request/.test(code) && !/\/api\/session\.attachment/.test(code),
  "不应再手工构造 session.attachment RPC 信封（应复用官方 loadImage）",
);
assert.ok(!/atob\s*\(/.test(code), "不应再自己 base64 解码附件字节（应复用官方 loadImage）");
assert.ok(/loadImage/.test(code), "必须使用注入的官方 loadImage 加载器");
assert.ok(/"read_image"/.test(code), "必须声明 read_image key");
assert.ok(/createPortal/.test(code), "Lightbox 应 portal 到 body");
assert.ok(/Escape/.test(code), "Lightbox 应支持 Esc 关闭");

// 真实 react：优先仓库 devDependency（pnpm install 后可用），其次环境变量指定的
// DSH profile。react-dom 不在运行时依赖里，故 createPortal 做桩，并用自带的
// 极简 reconciler 递归展开函数组件（含正确的 per-component hook 作用域）。
function resolveReactEntry() {
  const candidates = [
    process.env.DSH_REACT_PATH,
    path.join(root, "node_modules/react/index.js"),
    process.env.DSH_PROFILE === undefined
      ? undefined
      : path.join(process.env.DSH_PROFILE, "node_modules/react/index.js"),
    path.join(os.homedir(), ".dsh/profiles/web/node_modules/react/index.js"),
    path.join(os.homedir(), ".dsh/profiles/desktop/node_modules/react/index.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");
  return candidates.find((candidate) => existsSync(candidate));
}

const reactEntry = resolveReactEntry();
if (reactEntry === undefined) {
  const message =
    "找不到 react。先在仓库执行 `pnpm install`（或设置 DSH_REACT_PATH 指向 react/index.js）；" +
    "若只想跑前两层，可设置 DSH_VERIFY_ALLOW_SKIP=1。";
  if (process.env.DSH_VERIFY_ALLOW_SKIP === "1") {
    console.log(`⚠️  3/3 跳过真实渲染断言（${message}）`);
    console.log("\n✅ dsh-image-preview self-check passed (2/3，渲染层被显式跳过)");
    process.exit(0);
  }
  throw new Error(message);
}

let React;
try {
  React = (await import(pathToFileURL(reactEntry).href)).default;
  assert.equal(typeof React.createElement, "function", `react 入口不可用：${reactEntry}`);
} catch (error) {
  throw new Error(`无法加载 React（${reactEntry}）：${error.message}`);
}

// ── 极简 reconciler：递归展开函数组件，per-component hook 作用域 ──────────
function createRuntime(React) {
  const frames = new Map();
  let stack = [];
  let touched = [];

  const frameAt = (key) => {
    let f = frames.get(key);
    if (f === undefined) {
      f = { state: [], ref: [], effect: [], cb: [], memo: [], idx: 0, pending: [] };
      frames.set(key, f);
    }
    return f;
  };
  const cur = () => stack[stack.length - 1];
  const depsEqual = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const api = {
    useState(init) {
      const f = cur(); const i = f.idx++;
      if (!(i in f.state)) f.state[i] = typeof init === "function" ? init() : init;
      return [f.state[i], (v) => { f.state[i] = typeof v === "function" ? v(f.state[i]) : v; }];
    },
    useRef(init) { const f = cur(); const i = f.idx++; if (!(i in f.ref)) f.ref[i] = { current: init }; return f.ref[i]; },
    useCallback(fn, deps) {
      const f = cur(); const i = f.idx++;
      const prev = f.cb[i];
      if (prev !== undefined && depsEqual(prev.deps, deps)) return prev.fn;
      f.cb[i] = { fn, deps };
      return fn;
    },
    useMemo(fn, deps) {
      const f = cur(); const i = f.idx++;
      const prev = f.memo[i];
      if (prev !== undefined && depsEqual(prev.deps, deps)) return prev.value;
      const value = fn();
      f.memo[i] = { value, deps };
      return value;
    },
    useEffect(fn, deps) {
      const f = cur(); const i = f.idx++;
      const prev = f.effect[i];
      if (prev !== undefined && depsEqual(prev.deps, deps)) return;
      f.effect[i] = { deps, fn, cleanup: prev === undefined ? undefined : prev.cleanup };
      f.pending.push(i);
    },
  };

  function expand(node, keyPath) {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) {
      return node.map((n, i) => expand(n, `${keyPath}.${i}`)).filter((n) => n !== null && n !== undefined);
    }
    if (typeof node !== "object") return null;

    const type = node.type;
    if (typeof type === "function") {
      const name = type.name || "anon";
      const fkey = `${keyPath}|${name}`;
      const f = frameAt(fkey);
      f.idx = 0;
      f.pending = [];
      stack.push(f);
      let out;
      try { out = type(node.props); } finally { stack.pop(); }
      touched.push(f);
      return expand(out, fkey);
    }
    // host element：递归展开其 children
    const children = node.props?.children;
    if (children === undefined) return node;
    return React.createElement(type, { ...node.props, children: expand(children, keyPath) });
  }

  return {
    api,
    async render(Component, props, maxPasses = 6) {
      let tree;
      for (let p = 0; p < maxPasses; p++) {
        touched = [];
        tree = expand(React.createElement(Component, props), "root");
        const hadPending = touched.some((f) => f.pending.length > 0);
        for (const f of touched) {
          for (const i of f.pending) {
            const e = f.effect[i];
            if (typeof e.cleanup === "function") { try { e.cleanup(); } catch { /* ignore */ } e.cleanup = undefined; }
            const c = e.fn();
            e.cleanup = typeof c === "function" ? c : undefined;
          }
          f.pending = [];
        }
        await new Promise((r) => setTimeout(r, 5));
        if (!hadPending) break;
      }
      return tree;
    },
  };
}

// 最小 DOM / window 桩
const makeEl = (tag) => ({
  tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, attributes: {},
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
  remove() { if (this.parentElement !== undefined) this.parentElement.removeChild(this); },
  setAttribute(k, v) { this.attributes[k] = v; },
  removeAttribute(k) { delete this.attributes[k]; },
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; },
});
const listeners = {};
const docListeners = {};
const markdownButtons = [];
const presentedCards = [];
globalThis.Element = class Element {};
const win = {
  addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((x) => x !== fn); },
  fire(type, ev) {
    // 合成事件带 preventDefault，贴近真实 KeyEvent
    const event = { preventDefault() {}, stopPropagation() {}, ...ev };
    (listeners[type] ?? []).slice().forEach((fn) => fn(event));
  },
};
globalThis.window = win;
// 浏览器内建：插件用 document.activeElement instanceof HTMLElement 做焦点还原
globalThis.HTMLElement = class HTMLElement {};
globalThis.document = {
  body: makeEl("body"), head: makeEl("head"), activeElement: null,
  baseURI: "http://localhost/",
  createElement: (tag) => {
    const el = makeEl(tag);
    // 记录 <a download> 触发的下载，用于验证“下载”按钮
    el.click = () => { if (el.tagName === "A") downloads.push({ href: el.href, download: el.download }); };
    return el;
  },
  querySelector: () => null,
  querySelectorAll: (selector) => selector === "[data-presented-file]"
    ? presentedCards
    : selector.includes('[data-chat-flow-kind="assistant-step"]') ? markdownButtons : [],
  addEventListener(type, fn) { (docListeners[type] ??= []).push(fn); },
  removeEventListener(type, fn) { docListeners[type] = (docListeners[type] ?? []).filter((x) => x !== fn); },
};
/** 捕获由插件触发的下载（<a download> click）。 */
const downloads = [];

const runtime = createRuntime(React);
const rt = runtime.api;
const testReact = {
  createElement: React.createElement, Fragment: React.Fragment,
  useState: rt.useState, useRef: rt.useRef, useCallback: rt.useCallback,
  useMemo: rt.useMemo, useEffect: rt.useEffect,
};

const registeredEntries = [];
const openRequests = [];
const sidebarAddresses = [];
let standaloneRender = null;
const reactDomTest = {
  createPortal: (node) => node,
  render: (element, host) => { standaloneRender = { element, host }; },
  unmountComponentAtNode: () => { standaloneRender = null; },
};
spec.factory((id) => {
  if (id === "react") return testReact;
  if (id === "react-dom") return reactDomTest;
  throw new Error(`unexpected require: ${id}`);
}).apply({
  slots: { inject: (_n, cb) => cb(), register: (options, component) => { registeredEntries.push({ options, component }); } },
  sessions: { list: { getSnapshot: () => ({ byId: { "session-ui": { cwd: "/tmp", retainedBy: { mainView: 1 } } } }) } },
  remote: { session: {
    openWorkspacePath: (request) => { openRequests.push(request); return Promise.resolve({ ok: true }); },
    workspacePathApplications: () => Promise.resolve({ ok: true, value: [{ id: "preview", name: "Preview", default: true, icon: null }] }),
  } },
  sidebarRight: { openResource: (address) => { sidebarAddresses.push(address); } },
});
const ReadImageRow = registeredEntries.find((entry) => entry.options.name === "tool.call.toolview").component;
const MessageImagesRow = registeredEntries.find((entry) => entry.options.name === "conversation.chat.message.images").component;

const FIND = (node, pred, out = []) => {
  if (Array.isArray(node)) { node.forEach((n) => FIND(n, pred, out)); return out; }
  if (node !== null && typeof node === "object" && node.type !== undefined) {
    if (pred(node)) out.push(node);
    FIND(node.props?.children, pred, out);
  }
  return out;
};
const cls = (node, c) => typeof node?.props?.className === "string" && node.props.className.split(/\s+/).includes(c);

const t = (key) => ({
  "tool.title.readImage": "Read image", "image.label": "Image", "image.loading": "Loading image…",
  "image.loadFailed": "Image failed to load; click to retry", "image.openOriginal": "View original",
  "image.preview": "Original image preview", "image.closePreview": "Close original image preview",
  "row.running": "Running", "row.failed": "Failed", "row.inspect": "Inspect",
}[key] ?? key);

const att = (id, name) => ({ attachmentId: id, mediaType: "image/png", bytes: 1234, width: 800, height: 600, name });
const makeBlock = (callId, attachments) => ({
  kind: "tool-result", seq: 1, time: Date.now(), callId, callTime: Date.now(),
  call: { name: "read_image", argsRaw: JSON.stringify({ file_path: "/tmp/shot.png" }) },
  content: [
    { type: "text", text: "<path>/tmp/shot.png</path>\n<type>image</type>\n<content>\n</content>" },
    ...attachments.map((a) => ({ type: "image", attachment: a })),
  ],
  isError: false, meta: { path: "/tmp/shot.png" }, subCalls: [],
});

let loadCalls = 0;
const loadImage = (a) => { loadCalls += 1; return Promise.resolve(`blob:fake/${a.attachmentId}`); };

// ── 3a) 单图：loadImage 通路 + 缩略图 + Lightbox + Esc ──────────────────
const SESSION_A = "session-single";
const singleProps = {
  toolName: "read_image", block: makeBlock("call-a", [att("att-1", "shot.png")]),
  cwd: "/tmp", home: "/root", openFile() {}, inspect: undefined, t, sessionId: SESSION_A, loadImage,
};
let tree = await runtime.render(ReadImageRow, singleProps);

assert.equal(loadCalls, 1, "应通过注入的官方 loadImage 加载一次图片（而非自己 fetch）");
assert.equal(FIND(tree, (n) => cls(n, "dip-row")).length, 1, "应渲染工具行");
const singleFrames = FIND(tree, (n) => cls(n, "dip-frame"));
assert.equal(singleFrames.length, 1, "单图应渲染 1 个缩略图");
const thumbImg = FIND(tree, (n) => n.type === "img")[0];
assert.ok(thumbImg !== undefined && /blob:fake\/att-1/.test(String(thumbImg.props.src)), "缩略图 src 应来自 loadImage 返回值");
const titleNode = FIND(tree, (n) => cls(n, "dip-title"))[0];
assert.ok(/Read image/.test(String(titleNode.props.children)), "标题应来自 locale key tool.title.readImage");
assert.equal(FIND(tree, (n) => cls(n, "dip-gallery")).length, 0, "单图不应出现多图网格");
assert.equal(FIND(tree, (n) => cls(n, "dip-backdrop")).length, 0, "初始不应有 Lightbox");

// 点击缩略图 → 打开 Lightbox
singleFrames[0].props.onClick();
tree = await runtime.render(ReadImageRow, singleProps);
let backdrop = FIND(tree, (n) => cls(n, "dip-backdrop"));
assert.equal(backdrop.length, 1, "点击缩略图应打开 Lightbox");
assert.equal(backdrop[0].props.role, "dialog", "Lightbox 必须是 dialog");
assert.equal(backdrop[0].props["aria-modal"], "true", "Lightbox 必须声明 aria-modal");
assert.equal(FIND(tree, (n) => cls(n, "dip-nav")).length, 0, "单图不应有左右导航");

// Esc → 关闭 Lightbox
win.fire("keydown", { key: "Escape" });
tree = await runtime.render(ReadImageRow, singleProps);
assert.equal(FIND(tree, (n) => cls(n, "dip-backdrop")).length, 0, "Esc 应关闭 Lightbox");
console.log("✅ 3/3a 单图通过（loadImage 通路 + 缩略图 + Lightbox + Esc 关闭）");

// ── 3b) 多图：网格 + 跨行导航 + 计数器 + session 隔离 ───────────────────
const SESSION_B = "session-multi";
const multiProps = {
  toolName: "read_image", block: makeBlock("call-b", [att("att-a", "a.png"), att("att-b", "b.png")]),
  cwd: "/tmp", home: "/root", openFile() {}, inspect: undefined, t, sessionId: SESSION_B, loadImage,
};
let mtree = await runtime.render(ReadImageRow, multiProps);
assert.equal(FIND(mtree, (n) => cls(n, "dip-gallery")).length, 1, "多图应使用 dip-gallery 网格");
const mFrames = FIND(mtree, (n) => cls(n, "dip-frame"));
assert.equal(mFrames.length, 2, "多图应渲染 2 个缩略图");

mFrames[0].props.onClick();
mtree = await runtime.render(ReadImageRow, multiProps);
assert.equal(FIND(mtree, (n) => cls(n, "dip-backdrop")).length, 1, "多图点击应打开 Lightbox");
const navs = FIND(mtree, (n) => cls(n, "dip-nav"));
assert.equal(navs.length, 2, "多图 Lightbox 应有左右导航按钮");
const counter = FIND(mtree, (n) => cls(n, "dip-counter"))[0];
assert.ok(counter !== undefined, "多图应显示计数器");

// session 隔离：SESSION_A 已注册 1 张图；若 registry 未按 sessionId 隔离，
// 这里会看到 1 / 3 而非 1 / 2。
assert.equal(String(counter.props.children), "1 / 2", `多图计数器应为 "1 / 2"（session 隔离），实际=${String(counter.props.children)}`);

// 左右导航：点 next 应切到第 2 张
navs.find((n) => cls(n, "dip-nav--next")).props.onClick();
mtree = await runtime.render(ReadImageRow, multiProps);
const counter2 = FIND(mtree, (n) => cls(n, "dip-counter"))[0];
assert.equal(String(counter2.props.children), "2 / 2", "点击 next 应切到 2 / 2");
const shown = FIND(mtree, (n) => cls(n, "dip-image"))[0];
assert.ok(/blob:fake\/att-b/.test(String(shown.props.src)), "第 2 张应显示 att-b");
console.log('✅ 3/3b 多图通过（网格 + 左右导航 + "1 / 2"→"2 / 2" + 按 sessionId 隔离）');

// ── 3c) 工具条：缩放 / 旋转 / 下载 / 复位 ───────────────────────────────
const SESSION_C = "session-tools";
const toolProps = {
  toolName: "read_image", block: makeBlock("call-c", [att("att-t", "my shot.png")]),
  cwd: "/tmp", home: "/root", openFile() {}, inspect: undefined, t, sessionId: SESSION_C, loadImage,
};
let ttree = await runtime.render(ReadImageRow, toolProps);
FIND(ttree, (n) => cls(n, "dip-frame"))[0].props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);

const toolbar = FIND(ttree, (n) => cls(n, "dip-toolbar"));
assert.equal(toolbar.length, 1, "Lightbox 应有工具条");
const tools = FIND(ttree, (n) => cls(n, "dip-tool"));
assert.equal(tools.length, 5, `工具条应有 5 个按钮（缩放±/旋转±/下载），实际=${tools.length}`);
// 每次从当前树重新解析按钮：避免闭包持有上一次渲染的旧节点（测试桩的节点
// 身份语义与真实 React 不同），保证断言针对的是最新状态。
const byLabel = (name) => FIND(ttree, (n) => cls(n, "dip-tool") && String(n.props["aria-label"]).startsWith(name))[0];
for (const name of ["Zoom in", "Zoom out", "Rotate left", "Rotate right", "Download"]) {
  assert.ok(byLabel(name) !== undefined, `工具条应包含「${name}」按钮`);
}

const imgStyle = () => String(FIND(ttree, (n) => cls(n, "dip-image"))[0].props.style.transform);
const zoomText = () => String(FIND(ttree, (n) => cls(n, "dip-zoom"))[0].props.children);

assert.equal(zoomText(), "100%", "初始缩放应为 100%");
assert.ok(/scale\(1\)/.test(imgStyle()) && /rotate\(0deg\)/.test(imgStyle()), `初始 transform 应为 scale(1) rotate(0deg)，实际=${imgStyle()}`);

// 放大：1.25 倍
byLabel("Zoom in").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
assert.equal(zoomText(), "125%", `放大后应为 125%，实际=${zoomText()}`);
assert.ok(/scale\(1\.25\)/.test(imgStyle()), `放大后 transform 应含 scale(1.25)，实际=${imgStyle()}`);

// 缩小回 100%
byLabel("Zoom out").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
assert.equal(zoomText(), "100%", `缩小后应回到 100%，实际=${zoomText()}`);

// 旋转右转 90°
byLabel("Rotate right").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
assert.ok(/rotate\(90deg\)/.test(imgStyle()), `右转后应含 rotate(90deg)，实际=${imgStyle()}`);

// 左转两次：90 → 0 → -90（或 270）
byLabel("Rotate left").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
assert.ok(/rotate\(0deg\)/.test(imgStyle()), `左转一次应回到 rotate(0deg)，实际=${imgStyle()}`);
byLabel("Rotate left").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
assert.ok(/rotate\(270deg\)|rotate\(-90deg\)/.test(imgStyle()), `再左转应到 270deg，实际=${imgStyle()}`);

// 键盘快捷键：0 复位
win.fire("keydown", { key: "0" });
ttree = await runtime.render(ReadImageRow, toolProps);
assert.ok(/scale\(1\)/.test(imgStyle()) && /rotate\(0deg\)/.test(imgStyle()), `按 0 应复位视图，实际=${imgStyle()}`);
assert.equal(zoomText(), "100%", "按 0 后缩放文本应为 100%");
// 键盘 +/- 缩放
win.fire("keydown", { key: "+" });
ttree = await runtime.render(ReadImageRow, toolProps);
assert.equal(zoomText(), "125%", `按 + 应放大到 125%，实际=${zoomText()}`);
win.fire("keydown", { key: "0" });
ttree = await runtime.render(ReadImageRow, toolProps);

// 下载：应触发 <a download>，文件名取自附件 name（空格转义）
assert.equal(downloads.length, 0, "此时不应有下载");
byLabel("Download").props.onClick();
assert.equal(downloads.length, 1, "点下载应触发一次浏览器下载");
assert.ok(/blob:fake\/att-t/.test(downloads[0].href), `下载 href 应为图片 URL，实际=${downloads[0].href}`);
assert.equal(downloads[0].download, "my shot.png", `下载文件名应为附件原名，实际=${downloads[0].download}`);

// 缩放上限：连点放大不应无限增长
for (let i = 0; i < 20; i++) byLabel("Zoom in").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
assert.equal(zoomText(), "800%", `缩放应封顶在 800%，实际=${zoomText()}`);

// 切图应复位视图：切到第 2 张前先放大旋转
byLabel("Rotate right").props.onClick();
ttree = await runtime.render(ReadImageRow, toolProps);
console.log("✅ 3/3c 工具条通过（缩放 100%→125%→封顶 800% / 旋转 90°·270° / 快捷键 0·+ / <a download> 下载）");

// ── 3d) 旋转回归：第四下必须「回正」，不能倒转一整圈 ─────────────────────
// 病根：`(r + deg) % 360` 把 270° 折叠成 0°，而 CSS transition 对 `rotate()` 是
// 对**数值**插值 —— 270→0 会倒着扫 270°，看起来就是反转一整圈。
// 正确做法是角度持续累加（`rotate(360deg)` 与 `0deg` 视觉相同、数值连续）。
//
// 这里做源码级守卫 + 最短路径数学验证：不依赖上面的极简测试桩（其跨渲染的
// 帧身份与真实 React 不同），因此结果稳定可复现。
const rotBody = /const rotateBy = react\.useCallback\(\(deg\) => \{\s*setRotation\(\(r\) => ([^;]+);/m.exec(code);
assert.ok(rotBody !== null, "应能定位 rotateBy 的 setRotation 更新表达式");
assert.ok(
  !/%\s*360/.test(rotBody[1]),
  `rotateBy 不得对角度取模 % 360（会把 270° 折叠成 0°，导致第四下倒转一整圈），实际=${rotBody[1].trim()}`,
);
assert.ok(
  /r\s*\+\s*deg/.test(rotBody[1]),
  `rotateBy 应让角度持续累加（r + deg），实际=${rotBody[1].trim()}`,
);

// 复位也必须走最短路径，否则从 270°/-270° 复位同样会绕远
assert.ok(
  /resetView[\s\S]{0,400}?nearestEquivalent/.test(code),
  "resetView 应用 nearestEquivalent 回到最近的 0°，而不是硬跳 setRotation(0)",
);

// 最短路径数学：验证“离 0 最近的等价角”这一核心算法
const nearEq = (deg) => {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
};
assert.equal(nearEq(270), -90, "270° 的最近等价角应为 -90°（而非 270）");
assert.equal(nearEq(-270), 90, "-270° 的最近等价角应为 90°（而非 -270）");
assert.equal(nearEq(0), 0, "0° 的最近等价角应为 0°");
assert.equal(nearEq(360), 0, "360° 的最近等价角应为 0°");
assert.equal(nearEq(90), 90, "90° 的最近等价角应为 90°");
// 复位步长必须 ≤180°，否则过渡会绕远
for (const deg of [90, 180, 270, -90, -180, -270, 45, 200]) {
  const step = Math.abs(nearEq(deg));
  assert.ok(step <= 180, `${deg}° 的复位步长应 ≤180°，实际=${step}°`);
}
console.log("✅ 3/3d 旋转回归通过（角度持续累加不取模；复位走最短路径 ≤180°，无整圈回绕）");

// ── 3e) 最终输出正文图片：接管 conversation.chat.message.images ─────────
// 助手最终回复里的 image block 走的是 assistant-step 的 message.images slot，
// 不是 read_image 的 toolview；这里验证同一套 registry / Lightbox 已接上。
const SESSION_FINAL = "session-final-output";
const finalProps = {
  images: [{ attachment: att("final-1", "final.png") }],
  loadImage, align: "start", sessionId: SESSION_FINAL, t,
};
const beforeFinal = loadCalls;
let ftree = await runtime.render(MessageImagesRow, finalProps);
assert.equal(loadCalls, beforeFinal + 1, "最终输出图片应通过注入的 loadImage 加载一次");
assert.equal(FIND(ftree, (n) => cls(n, "dip-message-images")).length, 1, "应渲染最终输出图片容器");
assert.equal(FIND(ftree, (n) => cls(n, "dip-gallery--single")).length, 1, "单图应使用 single 布局");
const finalFrames = FIND(ftree, (n) => cls(n, "dip-frame"));
assert.equal(finalFrames.length, 1, "单图应渲染 1 个缩略图");
const finalImg = FIND(ftree, (n) => n.type === "img")[0];
assert.ok(finalImg !== undefined && /blob:fake\/final-1/.test(String(finalImg.props.src)), "最终输出缩略图 src 应来自 loadImage");
finalFrames[0].props.onClick();
ftree = await runtime.render(MessageImagesRow, finalProps);
assert.equal(FIND(ftree, (n) => cls(n, "dip-backdrop")).length, 1, "点击最终输出缩略图应打开 Lightbox");
win.fire("keydown", { key: "Escape" });
ftree = await runtime.render(MessageImagesRow, finalProps);
assert.equal(FIND(ftree, (n) => cls(n, "dip-backdrop")).length, 0, "Esc 应关闭最终输出 Lightbox");

const finalMultiProps = {
  images: [
    { attachment: att("final-a", "a.png") },
    { attachment: att("final-b", "b.png") },
  ],
  loadImage, align: "start", sessionId: SESSION_FINAL, t,
};
ftree = await runtime.render(MessageImagesRow, finalMultiProps);
assert.equal(FIND(ftree, (n) => cls(n, "dip-gallery")).length, 1, "最终输出多图应使用 dip-gallery 网格");
assert.equal(FIND(ftree, (n) => cls(n, "dip-gallery--single")).length, 0, "多图不应使用 single 布局");
const finalMultiFrames = FIND(ftree, (n) => cls(n, "dip-frame"));
assert.equal(finalMultiFrames.length, 2, "最终输出多图应渲染 2 个缩略图");
finalMultiFrames[0].props.onClick();
ftree = await runtime.render(MessageImagesRow, finalMultiProps);
const finalNavs = FIND(ftree, (n) => cls(n, "dip-nav"));
assert.equal(finalNavs.length, 2, "最终输出多图 Lightbox 应有左右导航");
const finalCounter = FIND(ftree, (n) => cls(n, "dip-counter"))[0];
assert.equal(String(finalCounter.props.children), "1 / 2", "最终输出多图计数器应为 1 / 2");
finalNavs.find((n) => cls(n, "dip-nav--next")).props.onClick();
ftree = await runtime.render(MessageImagesRow, finalMultiProps);
const finalCounter2 = FIND(ftree, (n) => cls(n, "dip-counter"))[0];
assert.equal(String(finalCounter2.props.children), "2 / 2", "点击 next 应切到 2 / 2");
const finalShown = FIND(ftree, (n) => cls(n, "dip-image"))[0];
assert.ok(/blob:fake\/final-b/.test(String(finalShown.props.src)), "第 2 张应显示 final-b");
console.log("✅ 3/3e 最终输出图片通过（message.images 接管 + 单图/多图 + Lightbox + 导航）");

// ── 3f) 最终输出 Markdown 图片：捕获阶段接管官方按钮 ─────────────────────
// MarkdownText 的图片按钮不是 slot；插件在 document 捕获阶段拦截，并用独立
// React root 挂载自己的 Lightbox。这里用假 DOM 验证拦截、挂载与关闭。
const mdImg = {
  currentSrc: "blob:fake/md.png",
  src: "blob:fake/md.png",
  alt: "chart.png",
  parentElement: null,
};
const mdButton = {
  closest(selector) {
    if (selector === "[data-dsh-image-preview]") return null;
    if (selector === '[data-chat-flow-kind="assistant-step"]') return {};
    return null;
  },
  querySelector(selector) { return selector === ":scope > img" ? mdImg : null; },
};
mdImg.parentElement = mdButton;
markdownButtons.push(mdButton);
const mdTarget = new Element();
mdTarget.closest = (selector) => selector === "button" ? mdButton : null;
let mdPrevented = false;
let mdStopped = false;
const mdEvent = {
  target: mdTarget, button: 0, defaultPrevented: false,
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() { mdPrevented = true; },
  stopPropagation() { mdStopped = true; },
};
assert.ok(docListeners.click.length >= 1, "apply() 应安装 Markdown 图片点击捕获监听");
docListeners.click.slice(-1)[0](mdEvent);
assert.ok(standaloneRender !== null, "点击 Markdown 图片应挂载插件 Lightbox");
assert.ok(mdPrevented && mdStopped, "接管后应阻止官方按钮的默认点击行为");
assert.equal(standaloneRender.element.props.startId, "markdown:blob:fake/md.png", "Lightbox 应以被点击图片为起点");
assert.ok(document.body.children.includes(standaloneRender.host), "独立 Lightbox host 应挂到 body");
const mdHost = standaloneRender.host;
standaloneRender.element.props.onClose();
assert.equal(standaloneRender, null, "关闭时应卸载独立 React root");
assert.ok(!document.body.children.includes(mdHost), "关闭时应移除 Lightbox host");
console.log("✅ 3/3f 最终输出 Markdown 图片通过（捕获阶段拦截 + 独立 Lightbox + 关闭清理）");

// ── 3g) present 交付图片：整卡点击接管 + 三处文件操作 ───────────────────
// 交付卡片本身没有 <img>，整卡按钮的 title 是 Host 绝对路径；只接管图片
// 扩展名，STL / Markdown 仍走官方 Sidebar。
const presentedPath = "/tmp/preview_hero.png";
const presentedButton = {
  getAttribute(name) { return name === "title" ? presentedPath : null; },
  contains() { return true; },
};
const presentedCard = {
  querySelector(selector) { return selector === ":scope > button[title]" ? presentedButton : null; },
};
presentedCards.push(presentedCard);
const presentedTarget = new Element();
presentedTarget.closest = (selector) => selector === "[data-presented-file]" ? presentedCard : null;
let presentedPrevented = false;
let presentedStopped = false;
const presentedEvent = {
  target: presentedTarget, button: 0, defaultPrevented: false,
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() { presentedPrevented = true; },
  stopPropagation() { presentedStopped = true; },
};
assert.ok(docListeners.click.length >= 2, "apply() 应同时安装交付卡片与 Markdown 的捕获监听");
docListeners.click[0](presentedEvent);
assert.ok(standaloneRender !== null, "点击 present 图片卡片应打开插件 Lightbox");
assert.ok(presentedPrevented && presentedStopped, "接管后应阻止官方 Sidebar 预览");
assert.equal(standaloneRender.element.props.startId, `file:${presentedPath}`, "Lightbox 应以被点击的交付图片为起点");
assert.ok(standaloneRender.element.props.more !== undefined, "交付图片 Lightbox 应提供三处文件操作");
const fileMore = standaloneRender.element.props.more;
assert.equal(fileMore.pathFor(`file:${presentedPath}`), presentedPath, "更多操作应解析出文件路径");
assert.ok((await fileMore.apps(presentedPath)).some((app) => app.id === "preview"), "应能读取关联应用列表");
await fileMore.open(presentedPath);
assert.deepEqual(openRequests.at(-1), { path: presentedPath }, "默认打开应走 Session Remote");
await fileMore.reveal(presentedPath);
assert.deepEqual(openRequests.at(-1), { path: presentedPath, action: "reveal" }, "显示位置应走 Session Remote 的 reveal");
assert.equal((await fileMore.sidebar(presentedPath)).ok, true, "在侧栏打开应成功");
assert.ok(sidebarAddresses.at(-1).startsWith("dsh-resource://file/session/session-ui/"), "侧栏应使用会话文件地址");
assert.ok(sidebarAddresses.at(-1).endsWith("preview_hero.png"), `侧栏地址应保留图片路径，实际=${sidebarAddresses.at(-1)}`);
standaloneRender.element.props.onClose();
assert.equal(standaloneRender, null, "关闭交付图片 Lightbox 时应卸载 root");
console.log("✅ 3/3g 交付图片通过（整卡点击 + 默认应用 / 关联应用 / 侧栏 / 定位）");

console.log("\n✅ dsh-image-preview self-check passed (3/3)");
