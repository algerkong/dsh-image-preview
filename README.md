# dsh-image-preview

> [中文版](./README.zh.md)

**Image preview for the dsh session interface.** When the agent runs the `read_image` tool, the result is rendered as a **small thumbnail** by default instead of raw JSON — click the thumbnail to view the **full-size original** in a lightbox styled exactly like dsh's built-in `ImageLightbox`.

## Features

| | |
| --- | --- |
| 🖼️ **Thumbnail by default** | `read_image` results render as a rounded ~240px thumbnail that never blows up the conversation flow |
| 🔍 **Click for full size** | Click the thumbnail to open the original image in a lightbox — dismiss with `Esc`, clicking the backdrop, or the close button; focus is restored to the trigger on close |
| 🔐 **Reuses the built-in image pipeline** | Image bytes are fetched through the host's `session.attachment` RPC with authorization — the exact same path dsh's own `resolveImage` uses |
| ⏱️ **Complete states** | Running (`row.running`), failed with retry (`image.loadFailed`), and loading (`image.loading`) states are all covered |
| 🌗 **Theme aware** | All colors reference dsh theme tokens (`--dsw-*`), so the preview follows the light/dark theme automatically |

## How it works

`dsh-image-preview` is a **pure client-side plugin**. It registers a keyed slot on `tool.call.toolview` with key `read_image` and takes over rendering of the `read_image` tool row:

```
agent runs read_image
  └─ tool result content: [{ text envelope }, { type: "image", attachment }]
       └─ tool-call node → tool.call.toolview (key = read_image)
            └─ ReadImageRow: thumbnail + click to open ImageLightbox
```

- `sessionId` is injected by the session-scoped slot's standard kit.
- Attachment metadata (`attachmentId`, `mediaType`, `width`, `height`) comes straight from the tool result block.
- The lightbox (`ImageLightbox`) is a clone of dsh's built-in behavior: portal to `body`, backdrop mask, ESC/backdrop/close dismissal, focus restore.

## Installation

### From GitHub (recommended)

Requires pnpm ≥ 9. Install into your web profile with the official plugin command:

```sh
dsh plugin --profile web add 'github:algerkong/dsh-image-preview'
```

or manually in `~/.dsh/profiles/web/package.json`:

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

Then run `pnpm install` in the profile and **restart `dsh web`**. Refresh the page afterwards.

### Local development

Link the package directly:

```sh
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-image-preview
```

Add `"@alger-ai/dsh-image-preview"` to `dsh.profile.bundles`, restart `dsh web`, and refresh.

## Usage

1. Start a session and let the agent call `read_image` on an image file.
2. The tool row shows a small thumbnail instead of raw JSON.
3. Click the thumbnail to inspect the full-size original in the lightbox.

## Development

```sh
node verify.mjs   # self-check: bundle shape, slot registration, block parsing
```

## Files

```
dsh-image-preview/
├── package.json        # bundle metadata (dsh.bundle.patch / dsh.client platform=web)
├── cordis.patch.yml    # registers the client entry (id: ui-image-preview)
├── lib/
│   ├── index.js        # host-side entry (empty — browser-only plugin)
│   └── client.js       # browser: read_image toolview + thumbnail + lightbox
└── verify.mjs          # self-check script
```

## License

MIT
