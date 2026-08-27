# dsh-image-preview

dsh（DeepSeek Harness）会话区图片预览插件：当模型执行 `read_image` 工具时，会话界面默认以小图缩略展示图片，点击后以与 dsh 自带 `ImageLightbox` 一致的样式全屏查看原图。

## 功能

- **默认小图**：`read_image` 结果以 240px 圆角缩略图展示，不撑爆会话流。
- **点击看大图**：点击缩略图弹出原图预览（`Esc` / 点击遮罩 / 关闭按钮均可关闭，关闭后焦点还原到触发元素）。
- **复用自带图片通路**：图片字节经宿主端 `session.attachment` RPC 授权加载，与 dsh 自带 `resolveImage` 同一条通路。
- **状态完整**：运行中（`row.running`）、失败（可点击重试 `image.loadFailed`）、加载中（`image.loading`）都有对应展示。
- **主题自适应**：颜色全部引用 dsh 主题 token（`--dsw-*`），随 `data-ds-dark-theme` 自动明暗。

## 工作原理

插件是纯浏览器端 client 插件，注册 `tool.call.toolview` 的 keyed slot（`key: "read_image"`），接管 `read_image` 工具行的渲染：

```
模型执行 read_image
  └─ 工具结果 content: [{ text 信封 }, { type: "image", attachment }]
       └─ tool-call 节点 → ToolCallTree → tool.call.toolview (key=read_image)
            └─ ReadImageRow：小图缩略图 + 点击 ImageLightbox 原图预览
```

`sessionId` 由会话级 slot 的 standard kit 注入；附件引用（`attachmentId` / `mediaType` / `width` / `height`）取自工具结果块。

## 安装

在 dsh web profile（如 `~/.dsh/profiles/web`）中：

1. `package.json` 添加依赖：

   ```json
   "@alger-ai/dsh-image-preview": "link:/path/to/dsh-image-preview"
   ```

2. `dsh.profile.bundles` 列表追加：

   ```json
   "@alger-ai/dsh-image-preview"
   ```

3. `pnpm install` 后重启 `dsh web` 并刷新页面。

## 本地自检

```bash
node verify.mjs
```

## 文件结构

```
dsh-image-preview/
├── package.json        # bundle 声明（dsh.bundle.patch / dsh.client platform=web）
├── cordis.patch.yml    # 注册 client 入口（id: ui-image-preview）
├── lib/
│   ├── index.js        # 宿主端空入口（浏览器端插件）
│   └── client.js       # 浏览器端：read_image toolview + 缩略图 + 原图预览
└── verify.mjs          # 自检脚本
```

## License

MIT
