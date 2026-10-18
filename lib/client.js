/**
 * dsh-image-preview 客户端插件（浏览器端）。
 *
 * 必须以 window.__ModuleLoader__.load({ id, factory }) 自注册，id 必须等于
 * bundle 名 "@alger-ai/dsh-image-preview"。factory 返回 { apply, inject }。
 *
 * 功能：dsh 执行 read_image 工具时，会话区默认以小图缩略展示图片；用户自己
 * 发送的图片、助手最终输出里的 image block、Markdown 图片和 present 交付卡片
 * 里的图片也走同一套
 * 缩略图 / Lightbox。点击后用与 dsh 自带 ImageLightbox 一致的样式全屏查看大图
 * （Esc / 点遮罩 / 关闭按钮均可关闭）；工具条的“更多”菜单可把带本地路径的
 * 图片交给默认应用 / 关联应用、右侧栏或系统文件管理器打开。
 *
 * ── 与 dsh 0.2.1-rc.2 的契约（重要）────────────────────────────────────
 *
 * dsh 现已自带 read_image 的 toolview（dsh-client-ui-tool 的 readImageToolview）。
 * 0.2.x 的官方行默认折叠，并通过 children 声明 tool.call.images 子 slot 渲染
 * 官方图片卡片；本插件接管整行，让缩略图默认可见，并保留官方的会话鉴权加载器。
 *
 * tool.call.toolview 是 keyed slot，其 registry 规定：
 *
 *   同 key 且同 priority → 直接抛错
 *   "keyed slot ... already has an entry for key ... — register at a different
 *    priority to shadow it (lowest renders)"
 *
 * 因此接管官方 read_image 必须显式使用**更低 priority**（这里用 -1），
 * 否则 apply() 阶段即抛异常，插件一行都渲染不出来。priority 越低越优先渲染。
 *
 * 本插件不声明 children：tool.call.images 已由官方 read_image 条目声明，
 * 重复声明会抛 "slot ... is already declared"；插件自己渲染缩略图，不需要该子 slot。
 *
 * 图片位置：
 *   - 用户发送的图片 → conversation.chat.user.images single slot，
 *     官方 MessageImages 的 priority 是 100，本插件用 -1 遮蔽
 *   - assistant image block → conversation.chat.message.images single slot，
 *     官方 MessageImages 的 priority 是 100，本插件用 -1 遮蔽
 *   - Markdown ![alt](path) → MarkdownText 私有按钮 + 官方 Lightbox，不是 slot；
 *     在 document 捕获阶段拦截点击，用独立 React root 挂载插件 Lightbox
 *   - present 交付卡片 → [data-presented-file] > button[title]（Host 绝对路径）；
 *     同样在 document 捕获阶段拦截，只接管图片扩展名，其余文件保留官方侧栏
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
 * 图片格式：read_image 只提交 PNG / JPEG / WebP / GIF（含动画 GIF）；插件按
 * 官方 attachment 通路加载，不再声称支持 SVG / BMP / ICO。
 *
 * 颜色全部引用 dsh 主题 token（--dsw-*），随 data-ds-dark-theme 自动明暗。
 */
window.__ModuleLoader__.load({
  id: "@alger-ai/dsh-image-preview",
  factory: (require) => {
    const react = require("react");
    const react_dom = require("react-dom");
    // dsh 的 React 18 把 createRoot 放在 react-dom/client；宿主不一定暴露，
    // 因此拿不到时回退到 react-dom 的 legacy render。
    let react_dom_client;
    try { react_dom_client = require("react-dom/client"); } catch { react_dom_client = undefined; }

    const NS = "conversation";
    const CSS_TAG = "@alger-ai/dsh-image-preview";
    /** 接管官方 read_image 所需的注册优先级（同 key 同 priority 会抛错）。 */
    const SHADOW_PRIORITY = -1;
    /** 最终输出 Markdown 图片使用独立的 registry 桶，避免和工具行互相污染。 */
    const MARKDOWN_SESSION = "__dsh_image_preview_markdown__";
    const ASSISTANT_STEP_SELECTOR = '[data-chat-flow-kind="assistant-step"]';
    const MARKDOWN_LABELS = {
      dialog: "Image preview",
      close: "Close image preview",
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
    const MORE_ZH = {
      more: "更多操作",
      open: "用默认应用打开",
      apps: "用其他应用打开",
      loading: "正在获取应用…",
      appsError: "无法获取应用列表",
      noApps: "没有可用应用",
      sidebar: "在侧栏打开",
      reveal: "在文件夹中显示",
      opened: "已打开",
      failed: "操作失败",
      working: "处理中…",
      default: "默认",
    };
    const MORE_EN = {
      more: "More actions",
      open: "Open with default app",
      apps: "Open with another app",
      loading: "Loading applications…",
      appsError: "Could not load applications",
      noApps: "No applications available",
      sidebar: "Open in sidebar",
      reveal: "Show in folder",
      opened: "Opened",
      failed: "Action failed",
      working: "Working…",
      default: "Default",
    };
    const MORE_KEYS = Object.keys(MORE_ZH);
    const MORE_NS = "dsh-image-preview";
    let moreLabels = () => MORE_ZH;
    /** 助手最终输出 / 交付卡片里可直接预览的图片扩展名。 */
    const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
    /** 交付卡片：present 工具生成的显式交付。 */
    const PRESENTED_FILE_SELECTOR = "[data-presented-file]";

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

/* ── 助手最终输出里的图片 ── */
[data-dsh-image-preview] .dip-message-images{display:flex;flex-wrap:wrap;gap:8px;max-width:100%;margin:6px 0}
[data-dsh-image-preview] .dip-message-images[data-align="center"]{justify-content:center}
[data-dsh-image-preview] .dip-message-images[data-align="end"]{justify-content:flex-end}
[data-dsh-image-preview] .dip-message-images .dip-gallery{display:flex;flex-wrap:wrap;gap:8px;max-width:100%}
[data-dsh-image-preview] .dip-message-images .dip-gallery .dip-frame{width:160px;height:160px;border-radius:12px}
[data-dsh-image-preview] .dip-message-images .dip-gallery .dip-frame img{max-width:160px;max-height:160px}
[data-dsh-image-preview] .dip-message-images .dip-gallery--single .dip-frame{width:auto;height:auto;max-width:min(520px,100%);max-height:360px;border-radius:12px}
[data-dsh-image-preview] .dip-message-images .dip-gallery--single .dip-frame img{width:auto;height:auto;max-width:min(520px,100%);max-height:360px;object-fit:contain}

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
.dip-menu{z-index:4;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2a3242);background:var(--dsw-specific-input-major,#171d29);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.35));border-radius:14px;min-width:230px;max-width:min(320px,calc(100vw - 24px));max-height:min(60vh,520px);padding:6px;display:flex;flex-direction:column;gap:2px;position:fixed;top:64px;left:50%;transform:translateX(-50%);overflow:auto}
.dip-menu-title{color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:11px;line-height:16px;padding:5px 10px 3px;user-select:none}
.dip-menu-item{border:none;background:transparent;color:var(--dsw-alias-label-primary,#e7ecf5);cursor:pointer;text-align:left;border-radius:9px;align-items:center;gap:8px;padding:7px 10px;font:inherit;font-size:13px;line-height:20px;display:flex;width:100%}
.dip-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.dip-menu-item:disabled{opacity:.45;cursor:default}
.dip-menu-item .dip-menu-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:11px;line-height:16px}
.dip-menu-sep{background:var(--dsw-alias-border-l2-darkmode-thin,#2a3242);height:1px;margin:4px 6px;flex:none}
.dip-menu-status{color:var(--dsw-alias-label-tertiary,#93a0b4);font-size:11px;line-height:16px;padding:4px 10px 5px}
.dip-menu-status[data-error=true]{color:var(--dsw-alias-state-error-primary,#e58d8d)}

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

    /**
     * 归一化 `conversation.chat.message.images` 的输入。
     *
     * 最终输出里的图片通常带 durable `attachment`；草稿/预览输入则用
     * `preview.url`。两种都支持，统一成带稳定 id 的条目，供 registry 与
     * lightbox 使用。
     */
    function messageImagesOf(images) {
      if (!Array.isArray(images)) return [];
      const result = [];
      for (let i = 0; i < images.length; i += 1) {
        const item = images[i];
        if (item === null || typeof item !== "object") continue;
        const attachment = item.attachment;
        if (attachment !== null && typeof attachment === "object") {
          const id = typeof attachment.attachmentId === "string" && attachment.attachmentId !== ""
            ? attachment.attachmentId
            : `attachment:${i}`;
          result.push({ id, attachment, name: attachment.name, width: attachment.width, height: attachment.height });
          continue;
        }
        const preview = item.preview;
        if (preview !== null && typeof preview === "object" && typeof preview.url === "string" && preview.url !== "") {
          result.push({ id: `preview:${preview.url}`, preview, name: preview.name, width: preview.width, height: preview.height });
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

    /**
     * Lightbox 文案。dialog/close 用会话 locale；工具条与左右导航在 dsh 的
     * conversation 命名空间里没有对应 key（翻译器缺 key 时会原样返回 key），
     * 故这些保持英文常量。
     */
    function lightboxLabels(t) {
      return {
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

    // ── 文件卡片 / 本地图片路径工具 ─────────────────────────────────────────
    /** 最后一个路径段。 */
    function basenameOf(path) {
      const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
      const at = normalized.lastIndexOf("/");
      return at === -1 ? normalized : normalized.slice(at + 1);
    }

    /** 只接管真正能作为 <img> 显示的文件，避免抢掉 STL / Markdown 等卡片的侧栏预览。 */
    function isImagePath(path) {
      if (typeof path !== "string" || path === "") return false;
      const clean = path.split(/[?#]/)[0];
      const at = clean.lastIndexOf(".");
      if (at === -1) return false;
      return IMAGE_EXTENSIONS.has(clean.slice(at + 1).toLowerCase());
    }

    /** 把本地绝对路径变成 dsh 鉴权文件路由；返回 undefined 表示不是本地文件。 */
    function localPathFromSrc(src) {
      if (typeof src !== "string" || src === "") return undefined;
      try {
        const url = new URL(src, document.baseURI);
        if (url.pathname.endsWith("/api/file") || url.pathname.endsWith("api/file")) {
          const path = url.searchParams.get("path");
          return path === null || path === "" ? undefined : path;
        }
        if (url.protocol === "file:") return decodeURIComponent(url.pathname);
      } catch {
        return undefined;
      }
      return undefined;
    }

    /** 给本地绝对路径拼一个带会话鉴权的图片 URL。 */
    function fileMediaUrlFor(path) {
      return new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI).href;
    }

    function isAbsoluteLocalPath(path) {
      return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path);
    }

    /** 把卡片里的相对路径按当前会话 cwd 解析成绝对路径。 */
    function resolveAbsolutePath(cwd, path) {
      if (typeof path !== "string" || path === "") return undefined;
      if (isAbsoluteLocalPath(path)) return path;
      if (typeof cwd !== "string" || cwd === "") return undefined;
      return `${cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\/+/, "")}`;
    }

    function encodeAddressSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ":");
    }

    /** dsh-resource://file/session/<sessionId>/<path>，与官方文件预览地址一致。 */
    function sessionFileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      return `dsh-resource://file/session/${encodeAddressSegment(sessionId)}/${normalized.split("/").map(encodeAddressSegment).join("/")}`;
    }

    function fileAddressFor(sessionId, cwd, path) {
      const normalized = path.replace(/\\/g, "/");
      if (!isAbsoluteLocalPath(normalized)) return sessionFileAddress(sessionId, normalized);
      const root = typeof cwd === "string" ? cwd.replace(/\\/g, "/").replace(/\/+$/, "") : "";
      if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
      if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
      return sessionFileAddress(sessionId, normalized);
    }

    /** 当前查看的 Session；与官方 open-in-app 的判断口径一致。 */
    function activeSessionInfo(ctx) {
      const byId = ctx.sessions?.list?.getSnapshot?.().byId;
      if (byId === undefined || byId === null) return undefined;
      for (const [id, row] of Object.entries(byId)) {
        if ((row?.retainedBy?.mainView ?? 0) > 0) return { id, cwd: row.cwd };
      }
      const first = Object.entries(byId)[0];
      return first === undefined ? undefined : { id: first[0], cwd: first[1]?.cwd };
    }

    /**
     * 生成插件 Lightbox 的“更多操作”适配器。
     *
     * - 打开 / 显示位置走 Session Remote，Host 会在启动前重新校验路径；
     * - 侧栏预览走 dsh-resource 地址，与官方卡片点击行为一致；
     * - 应用列表来自 Host 桌面探测，桌面不可用时返回失败。
     */
    function makeMoreActions(ctx, entries) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const open = async (path, application) => {
        if (path === undefined || ctx.remote?.session?.openWorkspacePath === undefined) return { ok: false };
        try {
          const request = application === undefined ? { path } : { path, application };
          const result = await ctx.remote.session.openWorkspacePath(request);
          return { ok: result?.ok === true };
        } catch {
          return { ok: false };
        }
      };
      return {
        labels: moreLabels(),
        pathFor: (id) => byId.get(id)?.path,
        open: (path, application) => open(path, application),
        reveal: async (path) => {
          if (path === undefined || ctx.remote?.session?.openWorkspacePath === undefined) return { ok: false };
          try {
            const result = await ctx.remote.session.openWorkspacePath({ path, action: "reveal" });
            return { ok: result?.ok === true };
          } catch {
            return { ok: false };
          }
        },
        sidebar: async (path) => {
          if (path === undefined || ctx.sidebarRight?.openResource === undefined) return { ok: false };
          const session = activeSessionInfo(ctx);
          if (session === undefined) return { ok: false };
          try {
            ctx.sidebarRight.openResource(fileAddressFor(session.id, session.cwd, path));
            return { ok: true };
          } catch {
            return { ok: false };
          }
        },
        apps: async (path) => {
          if (path === undefined || ctx.remote?.session?.workspacePathApplications === undefined) return null;
          try {
            const result = await ctx.remote.session.workspacePathApplications({ path });
            const value = result?.value;
            if (!result?.ok) return null;
            if (Array.isArray(value)) return value;
            return Array.isArray(value?.applications) ? value.applications : [];
          } catch {
            return null;
          }
        },
      };
    }

    function ImageLightbox({ startId, sessionId, labels, onClose, more }) {
      const closeRef = react.useRef(null);
      const restoreRef = react.useRef(null);
      const stageRef = react.useRef(null);
      const [, forceUpdate] = react.useState(0); // 用于 registry 变化时触发重渲染
      const bump = react.useCallback(() => forceUpdate((n) => n + 1), []);

      // 当前图片 ID（随导航变化）
      const [activeId, setActiveId] = react.useState(startId);
      const [moreOpen, setMoreOpen] = react.useState(false);
      const [appsState, setAppsState] = react.useState(undefined); // undefined=加载中，null=失败，数组=结果
      const [actionState, setActionState] = react.useState(null);

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
      const currentPath = more?.pathFor?.(current?.id);

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

      const runMore = react.useCallback(async (kind, application) => {
        if (currentPath === undefined || more === undefined || actionState?.phase === "busy") return;
        setActionState({ phase: "busy", kind });
        let result;
        try {
          if (kind === "open" || kind === "app") result = await more.open(currentPath, application);
          else if (kind === "reveal") result = await more.reveal(currentPath);
          else result = await more.sidebar(currentPath);
        } catch {
          result = { ok: false };
        }
        if (result?.ok !== true) {
          setActionState({ phase: "error", kind });
          return;
        }
        setActionState({ phase: "ok", kind });
        // 让“已打开”状态短暂可见，再关闭 Lightbox，把空间让给应用 / 侧栏。
        setTimeout(() => {
          setMoreOpen(false);
          onClose();
        }, 500);
      }, [currentPath, more, actionState, onClose]);

      react.useEffect(() => {
        if (!moreOpen || currentPath === undefined || more === undefined) return;
        let cancelled = false;
        setAppsState(undefined);
        setActionState(null);
        Promise.resolve(more.apps(currentPath)).then(
          (value) => { if (!cancelled) setAppsState(value ?? null); },
          () => { if (!cancelled) setAppsState(null); },
        );
        return () => { cancelled = true; };
      }, [moreOpen, currentPath, more]);

      react.useEffect(() => {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeRef.current?.focus();
        const onKeyDown = (e) => {
          if (e.key === "Escape" && moreOpen) {
            e.preventDefault();
            setMoreOpen(false);
            return;
          }
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
      }, [onClose, goTo, multi, currentIdx, zoomBy, rotateBy, resetView, moreOpen]);

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

      const menuItem = (key, label, onClick, disabled, hint) =>
        react.createElement("button", {
          key, type: "button", role: "menuitem", className: "dip-menu-item",
          onClick, disabled: disabled === true,
        }, label, hint === undefined ? null : react.createElement("span", { className: "dip-menu-hint" }, hint));
      const menuNote = (key, text, error) =>
        react.createElement("div", { key, className: "dip-menu-status", "data-error": error === true ? true : undefined, role: "status" }, text);

      const moreActions = more !== undefined && currentPath !== undefined;
      const menuChildren = [];
      if (moreActions) {
        const apps = Array.isArray(appsState) ? appsState : [];
        const defaultApp = apps.find((app) => app.default === true);
        const busy = actionState?.phase === "busy";
        menuChildren.push(react.createElement("div", { key: "title", className: "dip-menu-title" }, more.labels.more));
        menuChildren.push(menuItem("open", more.labels.open, () => { runMore("open"); }, busy, defaultApp?.name));
        if (appsState === undefined) menuChildren.push(menuNote("apps-loading", more.labels.loading));
        else if (appsState === null) menuChildren.push(menuNote("apps-error", more.labels.appsError, true));
        else if (apps.length === 0) menuChildren.push(menuNote("apps-empty", more.labels.noApps));
        else {
          menuChildren.push(react.createElement("div", { key: "apps-title", className: "dip-menu-title" }, more.labels.apps));
          for (const app of apps) {
            menuChildren.push(menuItem(`app:${app.id}`, app.name, () => { runMore("app", app.id); }, busy, app.default === true ? more.labels.default : undefined));
          }
        }
        menuChildren.push(react.createElement("div", { key: "sep", className: "dip-menu-sep", "aria-hidden": "true" }));
        menuChildren.push(menuItem("sidebar", more.labels.sidebar, () => { runMore("sidebar"); }, busy));
        menuChildren.push(menuItem("reveal", more.labels.reveal, () => { runMore("reveal"); }, busy));
        if (actionState?.phase === "error") menuChildren.push(menuNote("status", more.labels.failed, true));
        else if (actionState?.phase === "ok") menuChildren.push(menuNote("status", more.labels.opened));
        else if (busy) menuChildren.push(menuNote("status", more.labels.working));
      }

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
            ])),
          moreActions ? react.createElement("button", {
            key: "more", type: "button", className: "dip-tool", title: more.labels.more,
            "aria-label": more.labels.more, "aria-haspopup": "menu", "aria-expanded": moreOpen,
            onClick: () => setMoreOpen((open) => !open),
          }, icon([
            react.createElement("circle", { key: "a", cx: "3.2", cy: "8", r: "1.15", fill: "currentColor" }),
            react.createElement("circle", { key: "b", cx: "8", cy: "8", r: "1.15", fill: "currentColor" }),
            react.createElement("circle", { key: "c", cx: "12.8", cy: "8", r: "1.15", fill: "currentColor" }),
          ])) : null,
        ),
        moreOpen && moreActions ? react.createElement("div", {
          className: "dip-menu", role: "menu", key: "more-menu", "aria-label": more.labels.more,
          onMouseDown: (event) => event.stopPropagation(),
        }, ...menuChildren) : null,
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

    // ── 最终输出里的 Markdown 图片 ─────────────────────────────────────────
    // MarkdownText 内部用一个私有的 <button><img></button> + 官方 ImageLightbox，
    // 不是 slot，无法用注册 slot 的方式接管。这里在 document 捕获阶段拦下
    // assistant-step 里的这类按钮，改用插件自己的 Lightbox；如果宿主没有
    // react-dom render/createRoot，则返回 false，让官方行为原样保留。
    // ── 独立 Lightbox（Markdown 图片 / present 图片卡片共用）──────────────
    // 这两类图片都不是 slot：Markdown 是 <button><img>，present 是
    // [data-presented-file] 里的整卡预览按钮。这里在 document 捕获阶段拦下
    // 点击，用独立 React root 渲染插件的 Lightbox；若宿主没有 ReactDOM
    // 的挂载能力，就放行官方行为。
    let standaloneLightbox = null;
    let standaloneUnregs = [];
    let standaloneIds = new Set();
    /** apply() 时注入的根 ctx，供“更多操作”调用 Session Remote / Sidebar。 */
    let pluginCtx = null;

    function markdownImageSource(img) {
      const src = typeof img.currentSrc === "string" && img.currentSrc !== "" ? img.currentSrc : img.src;
      return typeof src === "string" && src !== "" ? src : undefined;
    }

    function markdownImageId(src) {
      return `markdown:${src}`;
    }

    function collectMarkdownEntries() {
      if (typeof document === "undefined") return [];
      const entries = [];
      const seen = new Set();
      const buttons = document.querySelectorAll(`${ASSISTANT_STEP_SELECTOR} button`);
      for (const button of buttons) {
        if (button.closest("[data-dsh-image-preview]") !== null) continue;
        const img = button.querySelector(":scope > img");
        if (img === null || img.parentElement !== button) continue;
        const src = markdownImageSource(img);
        if (src === undefined) continue;
        const id = markdownImageId(src);
        if (seen.has(id)) continue;
        seen.add(id);
        const alt = typeof img.alt === "string" && img.alt !== "" ? img.alt : "Image";
        entries.push({ id, src, alt, path: localPathFromSrc(src) });
      }
      return entries;
    }

    function collectPresentedEntries() {
      if (typeof document === "undefined") return [];
      const entries = [];
      const seen = new Set();
      for (const card of document.querySelectorAll(PRESENTED_FILE_SELECTOR)) {
        const button = card.querySelector(":scope > button[title]");
        if (button === null) continue;
        const path = button.getAttribute("title");
        if (!isImagePath(path)) continue;
        const id = `file:${path}`;
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({ id, src: fileMediaUrlFor(path), alt: basenameOf(path), path });
      }
      return entries;
    }

    function clearStandaloneRegistry() {
      for (const unreg of standaloneUnregs) unreg();
      standaloneUnregs = [];
      standaloneIds = new Set();
    }

    function registerStandaloneEntries(entries) {
      for (const entry of entries) {
        if (standaloneIds.has(entry.id)) continue;
        standaloneIds.add(entry.id);
        standaloneUnregs.push(_reg.reg(MARKDOWN_SESSION, entry.id, entry.src, entry.alt, entry.alt));
      }
    }

    function closeStandaloneLightbox() {
      if (standaloneLightbox === null) return;
      const current = standaloneLightbox;
      standaloneLightbox = null;
      current.close();
    }

    /**
     * 用独立 React root 渲染插件 Lightbox。成功返回 true；拿不到 ReactDOM
     * 的 render / createRoot 能力时返回 false，调用方应放行官方行为。
     */
    function openStandaloneLightbox(entries, activeId, labels) {
      if (typeof document === "undefined" || typeof react_dom === "undefined") return false;
      const canCreateRoot = react_dom_client !== undefined && typeof react_dom_client.createRoot === "function";
      const canLegacyRender = typeof react_dom.render === "function" && typeof react_dom.unmountComponentAtNode === "function";
      if (!canCreateRoot && !canLegacyRender) return false;

      closeStandaloneLightbox();
      clearStandaloneRegistry();
      registerStandaloneEntries(entries);

      const host = document.createElement("div");
      host.setAttribute("data-dsh-image-preview-standalone", "");
      document.body.appendChild(host);

      let closed = false;
      let root;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          if (root !== undefined) root.unmount();
          else react_dom.unmountComponentAtNode(host);
        } finally {
          host.remove();
          clearStandaloneRegistry();
          if (standaloneLightbox !== null && standaloneLightbox.host === host) standaloneLightbox = null;
        }
      };
      const more = pluginCtx === null ? undefined : makeMoreActions(pluginCtx, entries);
      const element = react.createElement(ImageLightbox, {
        startId: activeId,
        sessionId: MARKDOWN_SESSION,
        labels,
        more,
        onClose: close,
      });
      if (canCreateRoot) {
        root = react_dom_client.createRoot(host);
        root.render(element);
      } else {
        react_dom.render(element, host);
      }
      standaloneLightbox = { host, close };
      return true;
    }

    function openMarkdownLightbox(src, alt) {
      const entries = collectMarkdownEntries();
      const id = markdownImageId(src);
      // 被点击的图片可能因 selector 时序没被扫到，补一条。
      if (!entries.some((entry) => entry.id === id)) {
        entries.push({ id, src, alt, path: localPathFromSrc(src) });
      }
      return openStandaloneLightbox(entries, id, MARKDOWN_LABELS);
    }

    function openPresentedImage(path) {
      const entries = collectPresentedEntries();
      const id = `file:${path}`;
      if (!entries.some((entry) => entry.id === id)) {
        entries.push({ id, src: fileMediaUrlFor(path), alt: basenameOf(path), path });
      }
      return openStandaloneLightbox(entries, id, MARKDOWN_LABELS);
    }

    function stopHandledClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    }

    function onMarkdownImageClick(event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (typeof Element === "undefined" || !(target instanceof Element)) return;
      const button = target.closest("button");
      if (button === null || button.closest("[data-dsh-image-preview]") !== null) return;
      if (button.closest(ASSISTANT_STEP_SELECTOR) === null) return;
      const img = button.querySelector(":scope > img");
      if (img === null || img.parentElement !== button) return;
      const src = markdownImageSource(img);
      if (src === undefined) return;
      const alt = typeof img.alt === "string" && img.alt !== "" ? img.alt : "Image";
      let opened = false;
      try { opened = openMarkdownLightbox(src, alt); } catch { opened = false; }
      if (!opened) return;
      stopHandledClick(event);
    }

    /**
     * present / 交付卡片：整卡预览按钮的 title 就是 Host 绝对路径。
     * 只接管图片文件；STL / Markdown 等仍交给官方 Sidebar 预览。
     */
    function onPresentedImageClick(event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (typeof Element === "undefined" || !(target instanceof Element)) return;
      const card = target.closest(PRESENTED_FILE_SELECTOR);
      if (card === null) return;
      const button = card.querySelector(":scope > button[title]");
      if (button === null) return;
      if (target !== button && !button.contains(target)) return;
      const path = button.getAttribute("title");
      if (!isImagePath(path)) return;
      let opened = false;
      try { opened = openPresentedImage(path); } catch { opened = false; }
      if (!opened) return;
      stopHandledClick(event);
    }

    // ── 图片工具行 ──────────────────────────────────────────────────────────
    // owner props（dsh 0.2.1-rc.2 契约，见 ToolCallOwnerProps）：
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
      const labels = lightboxLabels(t);

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

    // ── 助手最终输出图片 ──────────────────────────────────────────────────
    // `conversation.chat.message.images` 是 assistant-step 声明给附件插件接管的
    // single slot；官方 MessageImages 的 priority 是 100，这里用更低的 priority
    // 接管，让最终输出里的图片和 read_image 工具行共用同一套 registry / Lightbox。
    function MessageImagesRow({ images, loadImage, align, sessionId, t }) {
      const entries = react.useMemo(() => messageImagesOf(images), [images]);
      const entryKey = entries.map((entry) => entry.id).join("\u0000");
      const [urls, setUrls] = react.useState([]);
      const [loadErrors, setLoadErrors] = react.useState([]);
      const [openId, setOpenId] = react.useState(null);
      const [attempt, setAttempt] = react.useState(0);
      const loadImageRef = react.useRef(loadImage);
      loadImageRef.current = loadImage;
      const tRef = react.useRef(t);
      tRef.current = t;
      const closeLightbox = react.useCallback(() => setOpenId(null), []);

      // 用 entryKey 而不是 entries 数组做依赖：父组件每次渲染都会新建数组，
      // 但同一批 attachment 的 id 不变，不应重复加载。
      react.useEffect(() => {
        if (entries.length === 0) {
          setUrls([]);
          setLoadErrors([]);
          return;
        }
        const load = loadImageRef.current;
        let live = true;
        const unregFns = [];
        setUrls(new Array(entries.length).fill(null));
        setLoadErrors(new Array(entries.length).fill(false));
        entries.forEach((entry, i) => {
          const settle = (url) => {
            if (!live || typeof url !== "string" || url === "") return;
            setUrls((prev) => { const next = [...prev]; next[i] = url; return next; });
            unregFns.push(_reg.reg(sessionId, entry.id, url, entry.name ?? tRef.current("image.label"), entry.name));
          };
          const fail = () => {
            if (live) setLoadErrors((prev) => { const next = [...prev]; next[i] = true; return next; });
          };
          // 草稿预览本身就是可用的 blob URL，无需走会话鉴权加载器。
          if (entry.preview !== undefined) {
            settle(entry.preview.url);
            return;
          }
          const cached = typeof load?.peek === "function" ? load.peek(entry.attachment) : void 0;
          if (typeof cached === "string" && cached !== "") {
            settle(cached);
            return;
          }
          if (typeof load !== "function") {
            fail();
            return;
          }
          Promise.resolve(load(entry.attachment)).then((url) => {
            if (typeof url !== "string" || url === "") throw new Error("attachment-load-empty");
            settle(url);
          }).catch(fail);
        });
        return () => {
          live = false;
          unregFns.forEach((fn) => fn());
        };
      }, [entryKey, sessionId, attempt]);

      const multi = entries.length > 1;
      const anyError = loadErrors.some(Boolean);
      const allLoaded = entries.length > 0 && urls.length === entries.length && urls.every((url) => url !== null);
      if (entries.length === 0) return null;

      if (!allLoaded) {
        return react.createElement("div", {
          "data-dsh-image-preview": "",
          className: "dip-message-images",
          "data-align": align ?? "start",
        }, anyError
          ? react.createElement("button", {
            type: "button",
            className: "dip-error",
            onClick: () => setAttempt((value) => value + 1),
          }, t("image.failed"))
          : react.createElement("span", { className: "dip-dim" }, t("image.loading")));
      }

      const frames = entries.map((entry, i) => {
        const url = urls[i];
        return react.createElement("button", {
          type: "button",
          className: "dip-frame",
          key: entry.id,
          title: entry.name ?? t("image.preview"),
          "aria-label": entry.name ?? t("image.preview"),
          onClick: () => setOpenId(entry.id),
        }, react.createElement("img", {
          src: url,
          alt: entry.name ?? t("image.label"),
          loading: "lazy",
          draggable: false,
        }), multi && react.createElement("span", { className: "dip-idx" }, `${i + 1}/${entries.length}`));
      });

      return react.createElement("div", {
        "data-dsh-image-preview": "",
        className: "dip-message-images",
        "data-align": align ?? "start",
      },
        react.createElement("div", { className: `dip-gallery${multi ? "" : " dip-gallery--single"}` }, frames),
        openId !== null && react.createElement(ImageLightbox, {
          startId: openId,
          sessionId,
          labels: lightboxLabels(t),
          onClose: closeLightbox,
        }));
    }

    // ── slot 注册 ───────────────────────────────────────────────────────────
    function apply(ctx) {
      pluginCtx = ctx;
      if (ctx.locale !== undefined) {
        ctx.effect(() => ctx.locale.register(MORE_NS, { zh: MORE_ZH, en: MORE_EN }), "dsh-image-preview: more actions dictionary");
        const t = ctx.locale.bind(MORE_NS);
        moreLabels = () => Object.fromEntries(MORE_KEYS.map((key) => [key, t(key)]));
      }
      // Markdown 图片和 present 图片卡片都不是 slot；用捕获阶段拦截点击，
      // 交给插件 Lightbox。拿不到 ReactDOM 时对应 open 函数返回 false，
      // 官方 Sidebar / Lightbox 行为原样保留。
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("click", onPresentedImageClick, true);
        document.addEventListener("click", onMarkdownImageClick, true);
        if (typeof ctx.effect === "function") {
          ctx.effect(() => () => {
            document.removeEventListener("click", onMarkdownImageClick, true);
            document.removeEventListener("click", onPresentedImageClick, true);
          });
        }
      }

      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "read_image",
        locale: NS,
        // 官方已自带 read_image 的 toolview；keyed slot 同 key 同 priority 会抛错，
        // 必须用更低 priority 才能接管（priority 越低越优先渲染）。
        priority: SHADOW_PRIORITY
      }, ReadImageRow));

      // 最终输出正文里的图片走 attachment 插件的 MessageImages，而不是
      // read_image 的 toolview。这里接管同一个 single slot，复用上面的
      // registry / Lightbox；官方注册的 priority 是 100，-1 会胜出。
      ctx.slots.inject("conversation.chat.message.images", () => ctx.slots.register({
        name: "conversation.chat.message.images",
        locale: NS,
        priority: SHADOW_PRIORITY
      }, MessageImagesRow));

      // 用户自己发送的图片是另一个 slot：conversation.chat.user.images，
      // 由 UserContent 在 data-message-attachments 里渲染；官方同样用
      // MessageImages（priority 100），这里一并遮蔽。
      ctx.slots.inject("conversation.chat.user.images", () => ctx.slots.register({
        name: "conversation.chat.user.images",
        locale: NS,
        priority: SHADOW_PRIORITY
      }, MessageImagesRow));
    }

    return { apply, inject: ["slots", "sessions", "remote", "remote.session", "sidebarRight", "locale"] };
  },
});
