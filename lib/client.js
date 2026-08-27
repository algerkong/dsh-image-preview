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
 * 多图 + 跨行导航：
 *   - 单次 read_image 返回多张图片 → 缩略网格 + 行内前后导航
 *   - 多次 read_image → 所有已加载图片注册到全局 registry，
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
.dip-image{object-fit:contain;background:var(--dsw-specific-input-major,#171d29);max-width:min(100%,1600px);max-height:calc(100vh - 80px);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35));border-radius:12px;position:relative}
.dip-close{z-index:3;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-specific-input-major,#171d29);width:36px;height:36px;color:var(--dsw-alias-label-primary,#e7ecf5);cursor:pointer;border-radius:999px;place-items:center;display:grid;position:fixed;top:20px;right:20px}
.dip-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}

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

    // ── 全局图片注册表（跨工具行导航）─────────────────────────────────────
    // 所有 ReadImageRow 加载成功后注册图片，组件卸载时反注册。
    // ImageLightbox 查询注册表实现跨行左右切换。
    const _reg = (() => {
      if (typeof window === "undefined") return { reg() { return () => {}; }, unreg() {}, all() { return []; } };
      const k = "__dipImgReg";
      if (!window[k]) window[k] = [];
      const arr = window[k];
      let ord = 0;
      return {
        /** 注册一张图片（attachmentId 去重），返回 unregister 函数。 */
        reg(attachmentId, src, alt) {
          if (!attachmentId) return () => {};
          const existing = arr.find((e) => e.id === attachmentId);
          if (existing) { existing.src = src; existing.alt = alt; }
          else arr.push({ id: attachmentId, src, alt, ord: ord++ });
          return () => { const i = arr.findIndex((e) => e.id === attachmentId); if (i !== -1) arr.splice(i, 1); };
        },
        /** 反注册（组件卸载时调用）。 */
        unreg(attachmentId) { const i = arr.findIndex((e) => e.id === attachmentId); if (i !== -1) arr.splice(i, 1); },
        /** 按对话顺序返回所有已注册图片的有序副本。 */
        all() { return [...arr].sort((a, b) => a.ord - b.ord); },
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

    // ── 图片加载 RPC ───────────────────────────────────────────────────────
    function loadImageUrl(sessionId, attachment) {
      return fetch("/api/session.attachment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: `dip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          method: "session.attachment",
          payload: { sessionId, attachmentId: attachment.attachmentId }
        })
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }).then((json) => {
        const result = json !== null && typeof json === "object" ? json.result : void 0;
        if (result === void 0 || result.ok !== true) throw new Error(result?.error?.code ?? "attachment-load-failed");
        const value = result.value;
        const binary = atob(value.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const mediaType = value.attachment?.mediaType ?? attachment.mediaType ?? "image/png";
        return URL.createObjectURL(new Blob([bytes.buffer], { type: mediaType }));
      });
    }

    // ── Lightbox（全局 registry 驱动：左右切换对话中所有已加载图片）──
    function ImageLightbox({ startId, labels, onClose }) {
      const closeRef = react.useRef(null);
      const restoreRef = react.useRef(null);
      const [, forceUpdate] = react.useState(0); // 用于 registry 变化时触发重渲染
      const bump = react.useCallback(() => forceUpdate((n) => n + 1), []);

      // 当前图片 ID（随导航变化）
      const [activeId, setActiveId] = react.useState(startId);

      const all = _reg.all();
      const total = all.length;
      const currentIdx = Math.max(0, all.findIndex((e) => e.id === activeId));
      const current = all[currentIdx] ?? all[0];
      const multi = total > 1;

      const goTo = react.useCallback((next) => {
        if (total === 0) return;
        const nxt = ((next % total) + total) % total;
        setActiveId(all[nxt].id);
      }, [total, all]);

      react.useEffect(() => {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const onKeyDown = (e) => {
          if (e.key === "Escape") onClose();
          if (multi && e.key === "ArrowLeft") goTo(currentIdx - 1);
          if (multi && e.key === "ArrowRight") goTo(currentIdx + 1);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
          window.removeEventListener("keydown", onKeyDown);
          if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
        };
      }, [onClose, goTo, multi, currentIdx]);

      if (!current) return null;

      const children = [
        react.createElement("div", { className: "dip-mask", "aria-hidden": "true", onMouseDown: onClose }),
        react.createElement("img", { className: "dip-image", key: current.id, src: current.src, alt: current.alt }),
        react.createElement("button", { ref: closeRef, type: "button", className: "dip-close", "aria-label": labels.close, onClick: onClose, key: "close" },
          react.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
            react.createElement("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" })))
      ];
      if (multi) {
        children.push(
          react.createElement("button", { type: "button", className: "dip-nav dip-nav--prev", "aria-label": "Previous", key: "prev", onClick: () => goTo(currentIdx - 1) },
            react.createElement("svg", { width: "18", height: "18", viewBox: "0 0 16 16", fill: "none" },
              react.createElement("path", { d: "M10 3L5 8l5 5", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }))),
          react.createElement("button", { type: "button", className: "dip-nav dip-nav--next", "aria-label": "Next", key: "next", onClick: () => goTo(currentIdx + 1) },
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
    function ReadImageRow({ toolName, block, cwd, home, openFile, inspect, t, sessionId }) {
      const [urls, setUrls] = react.useState([]);
      const [loadErrors, setLoadErrors] = react.useState([]);
      const [openAttachmentId, setOpenAttachmentId] = react.useState(null);
      const [attempt, setAttempt] = react.useState(0);
      const running = !("kind" in block);
      const isError = "kind" in block && block.isError === true;
      const attachments = running || isError ? [] : imageAttachmentsOf(block);
      const multi = attachments.length > 1;
      const path = pathOf(block);
      const title = "Read image" + (path !== void 0 ? ` · ${path}` : "");
      const request = react.useCallback(() => setAttempt((a) => a + 1), []);
      const closeLightbox = react.useCallback(() => setOpenAttachmentId(null), []);

      // 加载图片并注册到全局 registry
      react.useEffect(() => {
        const atts = running || isError ? [] : imageAttachmentsOf(block);
        if (!atts.length || sessionId === void 0) return;
        let live = true;
        const unregFns = [];
        setUrls(new Array(atts.length).fill(null));
        setLoadErrors(new Array(atts.length).fill(false));
        atts.forEach((att, i) => {
          loadImageUrl(sessionId, att).then((url) => {
            if (!live) return;
            setUrls((prev) => { const n = [...prev]; n[i] = url; return n; });
            unregFns.push(_reg.reg(att.attachmentId, url, att.name ?? ""));
          }).catch(() => {
            if (live) setLoadErrors((prev) => { const n = [...prev]; n[i] = true; return n; });
          });
        });
        return () => {
          live = false;
          unregFns.forEach((fn) => fn());
        };
      }, [block, sessionId, attempt]);

      const alts = attachments.map((a) => a.name ?? t("image.label"));
      const labels = { dialog: t("image.preview"), close: t("image.closePreview") };

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
          inspect !== void 0 && react.createElement("button", { type: "button", className: "dip-inspect", onClick: inspect }, "Inspect")),
        react.createElement("div", { className: "dip-body" }, body),
        openAttachmentId && react.createElement(ImageLightbox, {
          startId: openAttachmentId, labels, onClose: closeLightbox
        }));
    }

    // ── slot 注册 ───────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "read_image",
        locale: NS
      }, ReadImageRow));
    }

    return { apply, inject: ["slots"] };
  },
});
