/**
 * dsh-image-preview 客户端插件（浏览器端）。
 *
 * 必须以 window.__ModuleLoader__.load({ id, factory }) 自注册，id 必须等于
 * bundle 名 "@alger-ai/dsh-image-preview"。factory 返回 { apply, inject }。
 *
 * 功能：dsh 执行 read_image 工具时，会话区默认以小图缩略展示图片，点击后
 * 用与 dsh 自带 ImageLightbox 一致的样式全屏查看大图（Esc / 点遮罩 / 关闭按钮
 * 均可关闭）。
 *
 * ── 与 dsh 0.1.5-rc.2 的契约（重要）────────────────────────────────────
 *
 * dsh 现已自带 read_image 的 toolview（dsh-client-ui-tool 的 readImageToolview）。
 * tool.call.toolview 是 keyed slot，其 registry 规定：
 *
 *   同 key 且同 priority → 直接抛错
 *   "keyed slot ... already has an entry for key ... — register at a different
 *    priority to shadow it (lowest renders)"
 *
 * 因此接管官方 read_image 必须显式使用**更低 priority**（这里用 -1），
 * 否则 apply() 阶段即抛异常，插件一行都渲染不出来。priority 越低越优先渲染。
 *
 * 图片 URL 不再自己 fetch /api/session.attachment：slot 已通过 owner props 注入
 * 会话鉴权过的官方加载器 loadImage(attachment) => Promise<string>
 * （即 uiConversation.imageUrl(sessionId, attachment)，按会话缓存）。插件直接复用，
 * 避免绕过官方鉴权通路。
 *
 * 多图 + 跨行导航：
 *   - 单次 read_image 返回多张图片 → 缩略网格 + 行内前后导航
 *   - 多次 read_image → 所有已加载图片注册到按会话隔离的全局 registry，
 *     Lightbox 里左右箭头 / 键盘可跨工具行切换（按对话时间顺序）
 *
 * 图片格式：PNG / JPG / GIF（动画） / SVG / WebP / BMP / ICO 等所有
 * 浏览器 <img> 原生支持的格式。
 *
 * 颜色全部引用 dsh 主题 token（--dsw-*），随 data-ds-dark-theme 自动明暗。
 */
window.__ModuleLoader__.load({
  id: "@alger-ai/dsh-image-preview",
  factory: (require) => {
    const react = require("react");
    const react_dom = require("react-dom");

    const NS = "conversation";
    const CSS_TAG = "@alger-ai/dsh-image-preview";
    /** 接管官方 read_image 所需的注册优先级（同 key 同 priority 会抛错）。 */
    const SHADOW_PRIORITY = -1;

    // ── 样式 ──────────────────────────────────────────────────────────────
    const CSS = `
/* ── 工具行 ── */
[data-dsh-image-preview] .dip-row{display:flex;flex-direction:column;gap:6px;padding:2px 0}
[data-dsh-image-preview] .dip-header{display:flex;align-items:center;gap:8px;min-width:0}
[data-dsh-image-preview] .dip-leading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#93a0b4);flex:none;display:inline-flex;align-items:center;justify-content:center;position:relative}
[data-dsh-image-preview] .dip-title{color:var(--dsw-alias-label-primary,#e7ecf5);font-size:14px;line-height:24px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-image-preview] .dip-summary{flex:auto;min-width:0;color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:14px;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-image-preview] .dip-inspect{flex:none;border:1px solid var(--dsw-alias-border-l2,#2a3242);background:transparent;color:var(--dsw-alias-label-secondary,#b9c3d4);font-size:12px;line-height:18px;border-radius:8px;padding:2px 10px;cursor:pointer}
[data-dsh-image-preview] .dip-inspect:hover{color:var(--dsw-alias-label-primary,#e7ecf5);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}

/* ── 缩略图（单图） ── */
[data-dsh-image-preview] .dip-body{display:flex}
[data-dsh-image-preview] .dip-frame{border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));cursor:zoom-in;border-radius:16px;flex:none;place-items:center;padding:0;display:grid;overflow:hidden;position:relative}
[data-dsh-image-preview] .dip-frame img{object-fit:cover;width:100%;height:100%;display:block;max-width:240px;max-height:240px}
[data-dsh-image-preview] .dip-dim{color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:12px;line-height:18px}

/* ── 多图缩略网格 ── */
[data-dsh-image-preview] .dip-gallery{display:flex;flex-wrap:wrap;gap:8px}
[data-dsh-image-preview] .dip-gallery .dip-frame{width:160px;height:160px;border-radius:12px}
[data-dsh-image-preview] .dip-gallery .dip-frame img{max-width:160px;max-height:160px}
[data-dsh-image-preview] .dip-gallery .dip-frame .dip-idx{position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;pointer-events:none}

/* ── 错误态 ── */
[data-dsh-image-preview] .dip-error{border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,141,141,.12));color:var(--dsw-alias-state-error-primary,#e58d8d);cursor:pointer;border-radius:10px;max-width:240px;padding:10px 12px;font-size:12px;line-height:18px}

/* ── Lightbox（全屏大图） ── */
.dip-backdrop{z-index:1000;place-items:center;padding:40px;display:grid;position:fixed;inset:0}
.dip-mask{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.6));backdrop-filter:var(--dsw-mask-blur,blur(8px));position:absolute;inset:0}
.dip-stage{width:100%;height:100%;display:grid;place-items:center;position:relative}
.dip-stage--zoomable{cursor:grab}
.dip-stage--dragging{cursor:grabbing}
.dip-image{object-fit:contain;background:var(--dsw-specific-input-major,#171d29);max-width:min(100%,1600px);max-height:calc(100vh - 80px);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35));border-radius:12px;position:relative;transform-origin:center center;will-change:transform;transition:transform .12s ease-out;user-select:none;-webkit-user-drag:none}
.dip-stage--dragging .dip-image{transition:none}
.dip-close{z-index:3;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-specific-input-major,#171d29);width:36px;height:36px;color:var(--dsw-alias-label-primary,#e7ecf5);cursor:pointer;border-radius:999px;place-items:center;display:grid;position:fixed;top:20px;right:20px}
.dip-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}

/* ── Lightbox 工具条（缩放 / 旋转 / 下载） ── */
.dip-toolbar{z-index:3;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-specific-input-major,#171d29);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35));border-radius:999px;align-items:center;gap:2px;padding:4px 6px;display:flex;position:fixed;top:20px;left:50%;transform:translateX(-50%)}
.dip-tool{border:none;background:transparent;color:var(--dsw-alias-label-primary,#e7ecf5);cursor:pointer;width:32px;height:32px;border-radius:999px;place-items:center;display:grid;flex:none}
.dip-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.dip-tool:disabled{opacity:.35;cursor:default}
.dip-zoom{color:var(--dsw-alias-label-secondary,#b9c3d4);font-size:12px;line-height:18px;min-width:46px;text-align:center;user-select:none;font-variant-numeric:tabular-nums}
.dip-toolbar-sep{background:var(--dsw-alias-border-l2-darkmode-thin,#2a3242);width:1px;height:18px;margin:0 4px;flex:none}

/* ── Lightbox 前后导航 ── */
.dip-nav{z-index:3;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-specific-input-major,#171d29);width:44px;height:44px;color:var(--dsw-alias-label-primary,#e7ecf5);cursor:pointer;border-radius:999px;place-items:center;display:grid;position:fixed;top:50%;transform:translateY(-50%);opacity:.75}
.dip-nav:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.dip-nav--prev{left:20px}
.dip-nav--next{right:20px}

/* ── Lightbox 计数器 ── */
.dip-counter{z-index:3;background:rgba(0,0,0,.55);color:#fff;font-size:13px;line-height:18px;padding:3px 12px;border-radius:8px;position:fixed;bottom:20px;left:50%;transform:translateX(-50%);pointer-events:none}
`;
    (function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = CSS_TAG;
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    })();

    // ── 全局图片注册表（跨工具行导航，按 session 隔离）────────────────────
    // 所有 ReadImageRow 加载成功后注册图片，组件卸载时反注册。
    // ImageLightbox 查询注册表实现跨行左右切换。
    // 以 sessionId 分桶：同一浏览器同时打开多个会话时不会互相串图。
    const _reg = (() => {
      if (typeof window === "undefined") return { reg() { return () => {}; }, all() { return []; } };
      const k = "__dipImgReg";
      if (!(window[k] instanceof Map)) window[k] = new Map();
      const store = window[k];
      let ord = 0;
      const bucket = (sessionId) => {
        const key = sessionId ?? "-";
        let b = store.get(key);
        if (b === void 0) { b = []; store.set(key, b); }
        return b;
      };
      return {
        /** 注册一张图片（attachmentId 去重），返回 unregister 函数。 */
        reg(sessionId, attachmentId, src, alt, name) {
          if (!attachmentId) return () => {};
          const arr = bucket(sessionId);
          const existing = arr.find((e) => e.id === attachmentId);
          if (existing !== void 0) { existing.src = src; existing.alt = alt; existing.name = name; }
          else arr.push({ id: attachmentId, src, alt, name, ord: ord++ });
          return () => {
            const i = arr.findIndex((e) => e.id === attachmentId);
            if (i !== -1) arr.splice(i, 1);
          };
        },
        /** 按对话顺序返回该会话所有已注册图片的有序副本。 */
        all(sessionId) { return [...bucket(sessionId)].sort((a, b) => a.ord - b.ord); },
      };
    })();

    // ── 工具块解析 ──────────────────────────────────────────────────────────
    function imageAttachmentsOf(block) {
      if (typeof block !== "object" || block === null) return [];
      if (!("kind" in block) || block.isError === true) return [];
      const content = Array.isArray(block.content) ? block.content : [];
      const result = [];
      for (const part of content) {
        if (part !== null && typeof part === "object" && part.type === "image" && part.attachment) {
          result.push(part.attachment);
        }
      }
      return result;
    }
    function parseArgs(argsRaw) {
      if (typeof argsRaw !== "string") return void 0;
      try { return JSON.parse(argsRaw); } catch { return void 0; }
    }
    function pathOf(block) {
      if (typeof block !== "object" || block === null) return void 0;
      if (!("kind" in block)) {
        const args = parseArgs(block.argsRaw);
        return args !== void 0 && typeof args.file_path === "string" ? args.file_path : void 0;
      }
      if (block.meta !== void 0 && block.meta !== null && typeof block.meta.path === "string") return block.meta.path;
      const args = parseArgs(block.call?.argsRaw);
      return args !== void 0 && typeof args.file_path === "string" ? args.file_path : void 0;
    }
    function errorSummaryOf(block) {
      const error = block?.error;
      if (error === void 0 || error === null || typeof error.message !== "string") return void 0;
      const nl = error.message.indexOf("\n");
      return nl === -1 ? error.message : error.message.slice(0, nl);
    }

    // ── Lightbox（全局 registry 驱动：左右切换对话中所有已加载图片）──
    /** 缩放档位：1 = 适应窗口，向上放大，向下缩小。 */
    const ZOOM_MIN = 0.25;
    const ZOOM_MAX = 8;
    const ZOOM_STEP = 1.25;

    /** 由附件原始 name 推断下载文件名；无 name 时回退到带扩展名的通用名。 */
    function downloadNameOf(entry) {
      const raw = typeof entry?.name === "string" ? entry.name.trim() : "";
      const safe = raw.replace(/[\\/:*?"<>|]+/g, "_");
      if (safe === "") return "image";
      return /\.[a-z0-9]{2,5}$/i.test(safe) ? safe : `${safe}.png`;
    }

    /** 触发浏览器下载：blob:/data: 直接走 <a download>，不产生跨源问题。 */
    function triggerDownload(url, filename) {
      if (typeof document === "undefined" || typeof url !== "string" || url === "") return;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function ImageLightbox({ startId, sessionId, labels, onClose }) {
      const closeRef = react.useRef(null);
      const restoreRef = react.useRef(null);
      const stageRef = react.useRef(null);
      const [, forceUpdate] = react.useState(0); // 用于 registry 变化时触发重渲染
      const bump = react.useCallback(() => forceUpdate((n) => n + 1), []);

      // 当前图片 ID（随导航变化）
      const [activeId, setActiveId] = react.useState(startId);

      // 视图变换：缩放 / 旋转 / 平移
      const [zoom, setZoom] = react.useState(1);
      const [rotation, setRotation] = react.useState(0);
      const [offset, setOffset] = react.useState({ x: 0, y: 0 });
      const [dragging, setDragging] = react.useState(false);
      const dragRef = react.useRef(null);

      const all = _reg.all(sessionId);
      const total = all.length;
      const currentIdx = Math.max(0, all.findIndex((e) => e.id === activeId));
      const current = all[currentIdx] ?? all[0];
      const multi = total > 1;

      /**
       * 把角度归一到 (-180, 180]，即与它视觉朝向相同、数值离 0 最近的角。
       *
       * CSS `transition` 是对 `rotate(Ndeg)` 里的**数值**做插值，而不是对取模后的
       * 视觉朝向插值。所以把 270° 直接写成 0° 会从 270 倒着扫回 0，看起来就是反转
       * 一整圈；写成 -90（视觉与 270 完全相同、数值只差 90）才是最短路径。
       */
      const nearestEquivalent = (deg) => {
        const wrapped = ((deg % 360) + 360) % 360; // [0, 360)
        return wrapped > 180 ? wrapped - 360 : wrapped; // (-180, 180]
      };

      /**
       * 旋转增量：**不做取模**，让角度持续累加。
       *
       * `rotate(360deg)` 与 `rotate(0deg)` 视觉相同，但数值连续，于是第四次 +90°
       * 会从 270 平滑转到 360（回到正位），而不是被取模成 0 再倒扫 270°。
       */
      const rotateBy = react.useCallback((deg) => {
        setRotation((r) => r + deg);
      }, []);

      /** 切图 / 关闭时把视图变换复位，避免把上一张的缩放带到下一张。 */
      const resetView = react.useCallback(() => {
        setZoom(1);
        // 回到“最近的 0°”：r - nearestEquivalent(r) 必为 360 的整数倍，
        // 视觉上就是正位，且数值差值不超过 180°，过渡不会绕远。
        setRotation((r) => r - nearestEquivalent(r));
        setOffset({ x: 0, y: 0 });
        setDragging(false);
        dragRef.current = null;
      }, []);

      const goTo = react.useCallback((next) => {
        if (total === 0) return;
        const nxt = ((next % total) + total) % total;
        setActiveId(all[nxt].id);
        resetView();
      }, [total, all, resetView]);

      // 纯函数式更新：把 clamp 放进 updater，不在 updater 内调用其它 setState
      // （StrictMode 下 updater 可能被执行两次，副作用会重复）。
      const zoomBy = react.useCallback((factor) => {
        setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor)));
      }, []);

      // 缩回适应窗口（≤100%）时把平移归零，避免图片停在画布外
      react.useEffect(() => {
        if (zoom <= 1) setOffset((o) => (o.x === 0 && o.y === 0 ? o : { x: 0, y: 0 }));
      }, [zoom]);

      const download = react.useCallback(() => {
        if (current === undefined) return;
        triggerDownload(current.src, downloadNameOf(current));
      }, [current]);

      react.useEffect(() => {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const onKeyDown = (e) => {
          if (e.key === "Escape") onClose();
          if (multi && e.key === "ArrowLeft") goTo(currentIdx - 1);
          if (multi && e.key === "ArrowRight") goTo(currentIdx + 1);
          // 缩放 / 旋转 / 复位快捷键（+/- 与 0，逗号句点旋转）
          if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(ZOOM_STEP); }
          if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / ZOOM_STEP); }
          if (e.key === "0") { e.preventDefault(); resetView(); }
          if (e.key === ",") { e.preventDefault(); rotateBy(-90); }
          if (e.key === ".") { e.preventDefault(); rotateBy(90); }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
          window.removeEventListener("keydown", onKeyDown);
          if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
        };
      }, [onClose, goTo, multi, currentIdx, zoomBy, rotateBy, resetView]);

      // registry 可能在首次渲染后才补上当前图（异步加载），订阅一次以确保刷新
      react.useEffect(() => { bump(); }, [bump]);

      // 滚轮缩放：非被动监听，以便 preventDefault 阻止页面滚动
      react.useEffect(() => {
        const stage = stageRef.current;
        if (stage === null || stage === undefined) return;
        const onWheel = (e) => {
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
      }, [zoomBy]);

      if (!current) return null;

      // 拖拽平移（仅在放大后有意义）
      const onPointerDown = (e) => {
        if (zoom <= 1) return;
        dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
        setDragging(true);
      };
      const onPointerMove = (e) => {
        const d = dragRef.current;
        if (d === null) return;
        setOffset({ x: e.clientX - d.x, y: e.clientY - d.y });
      };
      const endDrag = () => { dragRef.current = null; setDragging(false); };

      const transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)`;

      const icon = (path, size = 16) =>
        react.createElement("svg", { width: String(size), height: String(size), viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" }, path);

      const toolButton = (key, label, onClick, path, disabled) =>
        react.createElement("button", {
          key, type: "button", className: "dip-tool", title: label, "aria-label": label,
          onClick, disabled: disabled === true,
        }, path);

      const children = [
        react.createElement("div", { className: "dip-mask", "aria-hidden": "true", onMouseDown: onClose, key: "mask" }),
        react.createElement("div", {
          className: `dip-stage${dragging ? " dip-stage--dragging" : ""}${zoom > 1 ? " dip-stage--zoomable" : ""}`,
          ref: stageRef, key: "stage",
          onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerLeave: endDrag,
          // 点空白处关闭；点图片本身不关闭
          onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
        },
          react.createElement("img", {
            className: "dip-image", key: current.id, src: current.src, alt: current.alt,
            style: { transform },
            draggable: false,
            onMouseDown: (e) => e.stopPropagation(),
          })),
        // 工具条：缩放 / 旋转 / 下载
        react.createElement("div", { className: "dip-toolbar", key: "toolbar", role: "toolbar", "aria-label": labels.toolbar },
          toolButton("zoom-out", labels.zoomOut, () => zoomBy(1 / ZOOM_STEP),
            icon(react.createElement("path", { d: "M4 8h8", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" })),
            zoom <= ZOOM_MIN),
          react.createElement("span", { className: "dip-zoom", key: "zoomval", title: labels.zoomReset, onClick: () => { setZoom(1); setOffset({ x: 0, y: 0 }); } },
            `${Math.round(zoom * 100)}%`),
          toolButton("zoom-in", labels.zoomIn, () => zoomBy(ZOOM_STEP),
            icon(react.createElement("path", { d: "M8 4v8M4 8h8", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" })),
            zoom >= ZOOM_MAX),
          react.createElement("span", { className: "dip-toolbar-sep", key: "sep1", "aria-hidden": "true" }),
          toolButton("rotate-ccw", labels.rotateLeft, () => rotateBy(-90),
            icon(react.createElement("path", { d: "M3.2 6.5h3.6V2.9M3.5 6.2a5 5 0 1 1-.6 4.2", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }))),
          toolButton("rotate-cw", labels.rotateRight, () => rotateBy(90),
            icon(react.createElement("path", { d: "M12.8 6.5H9.2V2.9M12.5 6.2a5 5 0 1 0 .6 4.2", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }))),
          react.createElement("span", { className: "dip-toolbar-sep", key: "sep2", "aria-hidden": "true" }),
          toolButton("download", labels.download, download,
            icon([
              react.createElement("path", { key: "a", d: "M8 2.5v7.2", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
              react.createElement("path", { key: "b", d: "M5 7l3 3 3-3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }),
              react.createElement("path", { key: "c", d: "M3 12.6h10", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
            ]))),
        react.createElement("button", { ref: closeRef, type: "button", className: "dip-close", "aria-label": labels.close, onClick: onClose, key: "close" },
          react.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
            react.createElement("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" })))
      ];
      if (multi) {
        children.push(
          react.createElement("button", { type: "button", className: "dip-nav dip-nav--prev", "aria-label": labels.previous, key: "prev", onClick: () => goTo(currentIdx - 1) },
            react.createElement("svg", { width: "18", height: "18", viewBox: "0 0 16 16", fill: "none" },
              react.createElement("path", { d: "M10 3L5 8l5 5", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }))),
          react.createElement("button", { type: "button", className: "dip-nav dip-nav--next", "aria-label": labels.next, key: "next", onClick: () => goTo(currentIdx + 1) },
            react.createElement("svg", { width: "18", height: "18", viewBox: "0 0 16 16", fill: "none" },
              react.createElement("path", { d: "M6 3l5 5-5 5", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }))),
          react.createElement("span", { className: "dip-counter", key: "counter" }, `${currentIdx + 1} / ${total}`)
        );
      }
      return react_dom.createPortal(
        react.createElement("div", { className: "dip-backdrop", role: "dialog", "aria-modal": "true", "aria-label": labels.dialog }, ...children)
      , document.body);
    }

    // ── 图片工具行 ──────────────────────────────────────────────────────────
    // owner props（dsh 0.1.5-rc.2 契约，见 ToolCallOwnerProps）：
    //   callId, toolName, block, cwd, home, openFile, loadImage, inspect
    // sessionId / t 由 session 作用域 slot 的 standard kit 注入。
    function ReadImageRow({ toolName, block, cwd, home, openFile, inspect, t, sessionId, loadImage }) {
      const [urls, setUrls] = react.useState([]);
      const [loadErrors, setLoadErrors] = react.useState([]);
      const [openAttachmentId, setOpenAttachmentId] = react.useState(null);
      const [attempt, setAttempt] = react.useState(0);
      const running = !("kind" in block);
      const isError = "kind" in block && block.isError === true;
      const attachments = running || isError ? [] : imageAttachmentsOf(block);
      const multi = attachments.length > 1;
      const path = pathOf(block);
      const title = t("tool.title.readImage") + (path !== void 0 ? ` · ${path}` : "");
      const request = react.useCallback(() => setAttempt((a) => a + 1), []);
      const closeLightbox = react.useCallback(() => setOpenAttachmentId(null), []);

      // 用 ref 持有官方加载器，避免其引用变化导致重复加载
      const loadImageRef = react.useRef(loadImage);
      loadImageRef.current = loadImage;

      // 经官方会话鉴权加载器加载图片，并注册到全局 registry
      react.useEffect(() => {
        const atts = running || isError ? [] : imageAttachmentsOf(block);
        const load = loadImageRef.current;
        if (!atts.length || typeof load !== "function") return;
        let live = true;
        const unregFns = [];
        setUrls(new Array(atts.length).fill(null));
        setLoadErrors(new Array(atts.length).fill(false));
        atts.forEach((att, i) => {
          const register = (url) => {
            unregFns.push(_reg.reg(sessionId, att.attachmentId, url, att.name ?? t("image.label"), att.name));
          };
          const settle = (url) => {
            if (!live) return;
            setUrls((prev) => { const n = [...prev]; n[i] = url; return n; });
            register(url);
          };
          // 官方加载器可能同步暴露已缓存 URL（peek），命中则免一次 RPC
          const cached = typeof load.peek === "function" ? load.peek(att) : void 0;
          if (typeof cached === "string") { settle(cached); return; }
          Promise.resolve(load(att)).then((url) => {
            if (typeof url === "string" && url !== "") settle(url);
            else throw new Error("attachment-load-empty");
          }).catch(() => {
            if (live) setLoadErrors((prev) => { const n = [...prev]; n[i] = true; return n; });
          });
        });
        return () => {
          live = false;
          unregFns.forEach((fn) => fn());
        };
      }, [block, sessionId, attempt, running, isError, t]);

      const alts = attachments.map((a) => a.name ?? t("image.label"));
      // dialog/close 用会话 locale；工具条与左右导航的文案在 dsh 的
      // conversation 命名空间里没有对应 key（翻译器缺 key 时会原样返回 key），
      // 故这些保持英文常量。
      const labels = {
        dialog: t("image.preview"),
        close: t("image.closePreview"),
        previous: "Previous image",
        next: "Next image",
        toolbar: "Image tools",
        zoomIn: "Zoom in (+)",
        zoomOut: "Zoom out (-)",
        zoomReset: "Reset zoom (0)",
        rotateLeft: "Rotate left (,)",
        rotateRight: "Rotate right (.)",
        download: "Download image",
      };

      const anyError = loadErrors.some(Boolean);
      const allLoaded = urls.length === attachments.length && urls.every((u) => u !== null);
      const loading = !allLoaded && !anyError && attachments.length > 0;

      // 缩略图内容
      let body;
      if (running) {
        body = react.createElement("span", { className: "dip-dim" }, t("row.running"));
      } else if (isError) {
        body = react.createElement("span", { className: "dip-error", "data-error": "" }, errorSummaryOf(block) ?? t("row.failed"));
      } else if (anyError && !allLoaded) {
        body = react.createElement("button", { type: "button", className: "dip-error", onClick: request }, t("image.loadFailed"));
      } else if (loading) {
        body = react.createElement("span", { className: "dip-dim" }, t("image.loading"));
      } else if (multi) {
        body = react.createElement("div", { className: "dip-gallery" },
          attachments.map((att, i) => {
            const url = urls[i];
            const err = loadErrors[i];
            if (err) return react.createElement("button", { key: i, type: "button", className: "dip-error", onClick: request }, t("image.loadFailed"));
            if (url === null) return react.createElement("span", { key: i, className: "dip-dim", style: { width: 160, height: 160, display: "inline-block" } });
            return react.createElement("button", {
              key: i, type: "button", className: "dip-frame", title: t("image.openOriginal"),
              "aria-label": `${t("image.openOriginal")} (${i + 1}/${attachments.length})`,
              onClick: () => setOpenAttachmentId(att.attachmentId)
            },
              react.createElement("img", { src: url, alt: att.name ?? t("image.label") }),
              react.createElement("span", { className: "dip-idx" }, String(i + 1))
            );
          })
        );
      } else if (urls.length === 1 && urls[0] !== null) {
        body = react.createElement("button", { type: "button", className: "dip-frame", title: t("image.openOriginal"), "aria-label": t("image.openOriginal"),
          onClick: () => setOpenAttachmentId(attachments[0]?.attachmentId ?? null) },
          react.createElement("img", { src: urls[0], alt: alts[0] ?? "" })
        );
      } else {
        body = react.createElement("span", { className: "dip-dim" }, t("image.loading"));
      }

      return react.createElement("div", { "data-dsh-image-preview": "", className: "dip-row", "data-state": running ? "running" : isError ? "error" : "ok" },
        react.createElement("div", { className: "dip-header" },
          react.createElement("span", { className: "dip-leading", "aria-hidden": "true" },
            react.createElement("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none" },
              react.createElement("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2", stroke: "currentColor", strokeWidth: "1.4" }),
              react.createElement("circle", { cx: "5.5", cy: "6.2", r: "1.4", fill: "currentColor" }),
              react.createElement("path", { d: "M2 11.5l3.2-3.2 2.4 2.4 2.6-2.6 3.8 3.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }))),
          react.createElement("span", { className: "dip-title" }, title),
          react.createElement("span", { className: "dip-summary" },
            running ? t("row.running") : isError ? t("row.failed") : multi ? `${attachments.length} images` : ""),
          inspect !== void 0 && react.createElement("button", { type: "button", className: "dip-inspect", onClick: inspect }, t("row.inspect"))),
        react.createElement("div", { className: "dip-body" }, body),
        openAttachmentId && react.createElement(ImageLightbox, {
          startId: openAttachmentId, sessionId, labels, onClose: closeLightbox
        }));
    }

    // ── slot 注册 ───────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "read_image",
        locale: NS,
        // 官方已自带 read_image 的 toolview；keyed slot 同 key 同 priority 会抛错，
        // 必须用更低 priority 才能接管（priority 越低越优先渲染）。
        priority: SHADOW_PRIORITY
      }, ReadImageRow));
    }

    return { apply, inject: ["slots"] };
  },
});
