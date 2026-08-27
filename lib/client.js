/**
 * dsh-image-preview 客户端插件（浏览器端）。
 *
 * 必须以 window.__ModuleLoader__.load({ id, factory }) 自注册，id 必须等于
 * bundle 名 "@alger-ai/dsh-image-preview"。factory 返回 { apply, inject }。
 *
 * 功能：dsh 执行 read_image 工具时，会话区默认以小图缩略展示图片，点击后
 * 用与 dsh 自带 ImageLightbox 一致的样式全屏查看大图（Esc / 点遮罩 / 关闭按钮
 * 均可关闭）。实现方式：注册 `tool.call.toolview` 的 keyed slot（key=read_image），
 * 接管 read_image 工具行渲染；图片字节经宿主端 `session.attachment` RPC 授权加载。
 * 颜色全部引用 dsh 主题 token（--dsw-*），随 data-ds-dark-theme 自动明暗。
 */
window.__ModuleLoader__.load({
  id: "@alger-ai/dsh-image-preview",
  factory: (require) => {
    const react = require("react");
    const react_dom = require("react-dom");

    const NS = "conversation";
    const CSS_TAG = "@alger-ai/dsh-image-preview";

    // ── 样式：缩略图框 + 原图预览（与 dsh 自带 MessageImage / ImageLightbox 同款 token）──
    const CSS = `
[data-dsh-image-preview] .dip-row{display:flex;flex-direction:column;gap:6px;padding:2px 0}
[data-dsh-image-preview] .dip-header{display:flex;align-items:center;gap:8px;min-width:0}
[data-dsh-image-preview] .dip-leading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#93a0b4);flex:none;display:inline-flex;align-items:center;justify-content:center;position:relative}
[data-dsh-image-preview] .dip-title{color:var(--dsw-alias-label-primary,#e7ecf5);font-size:14px;line-height:24px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-image-preview] .dip-summary{flex:auto;min-width:0;color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:14px;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-image-preview] .dip-inspect{flex:none;border:1px solid var(--dsw-alias-border-l2,#2a3242);background:transparent;color:var(--dsw-alias-label-secondary,#b9c3d4);font-size:12px;line-height:18px;border-radius:8px;padding:2px 10px;cursor:pointer}
[data-dsh-image-preview] .dip-inspect:hover{color:var(--dsw-alias-label-primary,#e7ecf5);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
[data-dsh-image-preview] .dip-body{display:flex}
[data-dsh-image-preview] .dip-frame{border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));cursor:zoom-in;border-radius:16px;flex:none;place-items:center;padding:0;display:grid;overflow:hidden}
[data-dsh-image-preview] .dip-frame img{object-fit:cover;width:100%;height:100%;display:block;max-width:240px;max-height:240px}
[data-dsh-image-preview] .dip-dim{color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:12px;line-height:18px}
[data-dsh-image-preview] .dip-error{border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,141,141,.12));color:var(--dsw-alias-state-error-primary,#e58d8d);cursor:pointer;border-radius:10px;max-width:240px;padding:10px 12px;font-size:12px;line-height:18px}
.dip-backdrop{z-index:1000;place-items:center;padding:40px;display:grid;position:fixed;inset:0}
.dip-mask{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.6));backdrop-filter:var(--dsw-mask-blur,blur(8px));position:absolute;inset:0}
.dip-image{object-fit:contain;background:var(--dsw-specific-input-major,#171d29);max-width:min(100%,1600px);max-height:calc(100vh - 80px);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35));border-radius:12px;position:relative}
.dip-close{z-index:1;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-specific-input-major,#171d29);width:36px;height:36px;color:var(--dsw-alias-label-primary,#e7ecf5);cursor:pointer;border-radius:999px;place-items:center;display:grid;position:fixed;top:20px;right:20px}
.dip-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
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

    // ── 工具块解析 ──────────────────────────────────────────────────────────
    /** 从已结算的 tool-result 块内容中取出图片附件引用；无则 undefined。 */
    function imageAttachmentOf(block) {
      if (typeof block !== "object" || block === null) return void 0;
      if (!("kind" in block) || block.isError === true) return void 0;
      const content = Array.isArray(block.content) ? block.content : [];
      for (const part of content) {
        if (part !== null && typeof part === "object" && part.type === "image" && part.attachment) return part.attachment;
      }
      return void 0;
    }
    function parseArgs(argsRaw) {
      if (typeof argsRaw !== "string") return void 0;
      try { return JSON.parse(argsRaw); } catch { return void 0; }
    }
    /** read_image 的调用路径（running 取 argsRaw.file_path，结算取 meta/call）。 */
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
    /** 错误摘要：error.message 首行（与内置 tool row 的 errorSummary 一致）。 */
    function errorSummaryOf(block) {
      const error = block?.error;
      if (error === void 0 || error === null || typeof error.message !== "string") return void 0;
      const nl = error.message.indexOf("\n");
      return nl === -1 ? error.message : error.message.slice(0, nl);
    }

    // ── 图片加载：宿主 session.attachment RPC（与 dsh 自带 resolveImage 同一条通路）──
    function loadImageUrl(sessionId, attachment) {
      return fetch("/api/session.attachment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: `dsh-image-preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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

    // ── 原图预览（与 dsh 自带 ImageLightbox 行为一致：body portal / Esc / 点遮罩 / 关闭）──
    function ImageLightbox({ src, alt, labels, onClose }) {
      const closeRef = react.useRef(null);
      const restoreRef = react.useRef(null);
      react.useEffect(() => {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKeyDown);
        return () => {
          window.removeEventListener("keydown", onKeyDown);
          if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
        };
      }, [onClose]);
      return react_dom.createPortal(
        react.createElement("div", { className: "dip-backdrop", role: "dialog", "aria-modal": "true", "aria-label": labels.dialog },
          react.createElement("div", { className: "dip-mask", "aria-hidden": "true", onMouseDown: onClose }),
          react.createElement("img", { className: "dip-image", src, alt }),
          react.createElement("button", { ref: closeRef, type: "button", className: "dip-close", "aria-label": labels.close, onClick: onClose },
            react.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
              react.createElement("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }))))
      , document.body);
    }

    // ── 图片工具行（默认小图，点击原图预览）──
    function ReadImageRow({ toolName, block, cwd, home, openFile, inspect, t, sessionId }) {
      const [src, setSrc] = react.useState(null);
      const [loadError, setLoadError] = react.useState(false);
      const [open, setOpen] = react.useState(false);
      const [attempt, setAttempt] = react.useState(0);
      const running = !("kind" in block);
      const isError = "kind" in block && block.isError === true;
      const attachment = running || isError ? void 0 : imageAttachmentOf(block);
      const path = pathOf(block);
      const title = "Read image" + (path !== void 0 ? ` · ${path}` : "");
      const request = react.useCallback(() => setAttempt((a) => a + 1), []);
      const close = react.useCallback(() => setOpen(false), []);

      react.useEffect(() => {
        if (attachment === void 0 || sessionId === void 0) return;
        let live = true;
        setLoadError(false);
        setSrc(null);
        loadImageUrl(sessionId, attachment).then((url) => {
          if (live) setSrc(url);
        }).catch(() => {
          if (live) setLoadError(true);
        });
        return () => { live = false; };
      }, [attachment, sessionId, attempt]);

      const alt = attachment?.name ?? t("image.label");
      const labels = { dialog: t("image.preview"), close: t("image.closePreview") };

      return react.createElement("div", { "data-dsh-image-preview": "", className: "dip-row", "data-state": running ? "running" : isError ? "error" : "ok" },
        react.createElement("div", { className: "dip-header" },
          react.createElement("span", { className: "dip-leading", "aria-hidden": "true" },
            react.createElement("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none" },
              react.createElement("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2", stroke: "currentColor", strokeWidth: "1.4" }),
              react.createElement("circle", { cx: "5.5", cy: "6.2", r: "1.4", fill: "currentColor" }),
              react.createElement("path", { d: "M2 11.5l3.2-3.2 2.4 2.4 2.6-2.6 3.8 3.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }))),
          react.createElement("span", { className: "dip-title" }, title),
          react.createElement("span", { className: "dip-summary" }, running ? t("row.running") : isError ? t("row.failed") : ""),
          inspect !== void 0 && react.createElement("button", { type: "button", className: "dip-inspect", onClick: inspect }, "Inspect")),
        react.createElement("div", { className: "dip-body" },
          running ? react.createElement("span", { className: "dip-dim" }, t("row.running"))
            : isError ? react.createElement("span", { className: "dip-error", "data-error": "" }, errorSummaryOf(block) ?? t("row.failed"))
            : loadError ? react.createElement("button", { type: "button", className: "dip-error", onClick: request }, t("image.loadFailed"))
            : src === null ? react.createElement("span", { className: "dip-dim" }, t("image.loading"))
            : react.createElement("button", { type: "button", className: "dip-frame", title: t("image.openOriginal"), "aria-label": t("image.openOriginal"), onClick: () => setOpen(true) },
                react.createElement("img", { src, alt }))),
        open && src !== null && react.createElement(ImageLightbox, { src, alt, labels, onClose: close }));
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
