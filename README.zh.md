# dsh-image-preview

> [English](./README.md)

**dsh（DeepSeek Harness）会话区图片预览插件。** 当模型执行 `read_image` 工具时，结果默认以小图缩略展示，不再显示为原始 JSON；点击缩略图以与 dsh 自带 `ImageLightbox` 一致的样式全屏查看原图。

## 功能

| | |
| --- | --- |
| 🖼️ **默认小图** | `read_image` 结果以约 240px 圆角缩略图展示，不撑爆会话流 |
| 🔍 **点击看大图** | 点击缩略图弹出原图预览 — `Esc` / 点击遮罩 / 关闭按钮均可关闭，关闭后焦点还原到触发元素 |
| ↔️ **跨行导航** | 左右按钮 / ← → 键可切换**本会话已加载的全部图片**（计数器显示 `3 / 4`）—— dsh 自带 lightbox 只能看单张 |
| 🔎 **缩放 / 旋转 / 拖动** | 工具条含缩小 / 放大 / 左转 / 右转 / 下载。滚轮可缩放，放大后可拖动平移，快捷键 `+` `-` `0` `,` `.`。缩放限制在 25%–800%，切图自动复位 |
| ⬇️ **下载原图** | 按附件原始文件名，经同源 `<a download>` 保存原图（对宿主加载器返回的 `blob:` URL 同样有效） |
| 🔐 **复用官方图片通路** | 图片经 dsh 注入到 slot owner 的会话鉴权加载器 `loadImage` 解析，不再自己手写附件 RPC |
| ⏱️ **状态完整** | 运行中（`row.running`）、失败（可点击重试 `image.loadFailed`）、加载中（`image.loading`）都有对应展示 |
| 🌗 **主题自适应** | 颜色全部引用 dsh 主题 token（`--dsw-*`），随 light/dark 主题自动切换 |

### Lightbox 操作

| 操作 | 控件 | 快捷键 |
| --- | --- | --- |
| 放大 / 缩小 | 工具条 `+` / `−`，或滚轮 | `+` / `-` |
| 复位视图 | 点击缩放百分比 | `0` |
| 旋转 | 工具条 ↺ / ↻ | `,` / `.` |
| 拖动平移 | 拖拽（仅放大后） | — |
| 下载 | 工具条 ⤓ | — |
| 上一张 / 下一张 | 两侧箭头 | `←` / `→` |
| 关闭 | ✕ / 遮罩 / `Esc` | `Esc` |

## 兼容性

针对 **dsh `0.1.5-rc.2`** 构建并验证。

> **为什么必须用低 priority 接管。** dsh 现已**自带** `read_image` 的 toolview。`tool.call.toolview` 是 **keyed** slot，其 registry 会拒绝「同 key 同 priority」的第二次注册：
>
> ```
> keyed slot "tool.call.toolview" already has an entry for key "read_image"
> at priority 0 — register at a different priority to shadow it (lowest renders)
> ```
>
> 因此本插件以 **`priority: -1`** 注册来接管家自带的这一行。少了它，`apply()` 会在浏览器启动阶段抛异常，**一行都渲染不出来** —— 这正是修复前的实际状况。

## 效果预览

**会话中的缩略图** — 每个 `read_image` 工具行默认显示小缩略图：

![会话中的缩略图预览](docs/screenshot-preview.png)

**大图 Lightbox** — 点击任意缩略图打开原图，支持 ← → 按钮或键盘左右箭头在对话中所有图片间跨行切换（底部计数器显示 `3 / 4`）：

![Lightbox 跨行导航](docs/screenshot-lightbox.png)

## 工作原理

本插件是**纯浏览器端 client 插件**，以 `priority: -1` 注册 `tool.call.toolview` 的 keyed slot（`key: "read_image"`），接管 `read_image` 工具行的渲染：

```
模型执行 read_image
  └─ 工具结果 content: [{ text 信封 }, { type: "image", attachment }]
       └─ tool-call 节点 → tool.call.toolview (key = read_image, priority -1 遮蔽官方行)
            └─ ReadImageRow：小图缩略图 + 点击打开跨行 Lightbox
```

- `sessionId` 与 `t` 由会话级 slot 的 standard kit 注入（`dsh-client-ui-session` / locale seat）。
- `loadImage` 是 dsh 通过 slot owner props 注入的会话鉴权加载器（`MessageImageLoader`，即 `uiConversation.imageUrl(sessionId, attachment)`，按会话缓存）。插件**不再**直接访问 `/api/session.attachment`。
- 附件元数据（`attachmentId` / `mediaType` / `width` / `height`）直接从工具结果块获取。
- Lightbox 视觉与 dsh 自带 `ImageLightbox` 一致（portal 到 `body`、遮罩背景、ESC/遮罩/关闭按钮关闭、焦点还原），但额外提供跨图导航与缩放 / 旋转 / 平移 / 下载。
- 缩放与旋转只是 `<img>` 上的一个 CSS `transform`（不重新编码）；下载把加载器给出的 `blob:` URL 直接交给 `<a download>`，不复制也不重新拉取字节。
- 图片注册表按 `sessionId` 分桶：同时打开多个会话时不会互相串图导航。

## 安装

### 从 GitHub 安装（推荐）

需要 pnpm ≥ 9。使用官方插件命令安装到你的 web profile：

```sh
dsh plugin --profile web add 'github:algerkong/dsh-image-preview'
```

或手动在 `~/.dsh/profiles/web/package.json` 中添加：

```json
{
  "dependencies": {
    "@alger-ai/dsh-image-preview": "github:algerkong/dsh-image-preview"
  },
  "dsh": {
    "profile": {
      "bundles": [ "@alger-ai/dsh-image-preview" ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，**重启 `dsh web`**，最后刷新页面。

### 本地开发

直接 link 本地目录：

```sh
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-image-preview
```

在 `dsh.profile.bundles` 中添加 `"@alger-ai/dsh-image-preview"`，重启 `dsh web` 并刷新。

## 使用

1. 开始一个会话，让模型对图片文件执行 `read_image`。
2. 工具行显示小缩略图而非原始 JSON。
3. 点击缩略图即可在 lightbox 中全屏查看原图。

## 开发

```sh
node verify.mjs   # 自检：bundle 结构、slot 接管契约、运行时渲染
```

`verify.mjs` 校验三层：`__ModuleLoader__.load` 自注册形状、**keyed slot 接管契约**（复刻 dsh registry 规则；若插件忘了 `priority: -1` 会直接失败）、以及一次真实渲染（loadImage 通路、缩略图、lightbox、Esc、多图网格与导航，外加缩放 / 旋转 / 下载工具条）。

## 文件结构

```
dsh-image-preview/
├── package.json        # bundle 声明（dsh.bundle.patch / dsh.client platform=web）
├── cordis.patch.yml    # 注册 client 入口（id: ui-image-preview）
├── lib/
│   ├── index.js        # 宿主端空入口（纯浏览器端插件）
│   └── client.js       # 浏览器端：read_image toolview + 缩略图 + 原图预览
└── verify.mjs          # 自检脚本
```

## License

MIT