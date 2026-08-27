/** dsh-image-preview self-check: verify the __ModuleLoader__.load registration
 *  contract (browser-bundle loader) plus metadata and feature wiring. */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// 1) Simulate window.__ModuleLoader__ so the bundle self-registers.
let spec;
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
globalThis.document = undefined; // styles injection guard
await import(pathToFileURL(path.join(root, "lib/client.js")).href);

assert.ok(spec, "lib/client.js 必须调用 window.__ModuleLoader__.load({ id, factory })");
assert.equal(spec.id, "@alger-ai/dsh-image-preview", "id 必须等于 bundle 名");
assert.equal(typeof spec.factory, "function", "factory 必须是函数");

const plugin = spec.factory((id) => {
  if (id === "react" || id === "react-dom" || id === "react/jsx-runtime") return {};
  throw new Error(`unexpected require: ${id}`);
});
assert.equal(typeof plugin.apply, "function", "factory 必须返回 { apply }");
assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes("slots"), "inject 必须声明 slots");
console.log(`✅ __ModuleLoader__.load 自注册契约通过 (id=${spec.id}, apply=${typeof plugin.apply}, inject=${JSON.stringify(plugin.inject)})`);

// 2) Host entry must export apply().
const hostMod = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
assert.equal(typeof hostMod.apply, "function");
console.log("✅ lib/index.js exports apply() (host-side empty)");

// 3) Package contract.
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.equal(pkg.dsh?.client?.platform, "web");
assert.equal(typeof pkg.exports?.["./client"], "string");
console.log("✅ package.json: dsh.bundle.patch + dsh.client(platform=web) + exports['./client']");

// 4) Feature wiring present in the client bundle.
const src = readFileSync(path.join(root, "lib/client.js"), "utf8");
assert.ok(src.includes('key: "read_image"'), "必须注册 read_image 的 toolview");
assert.ok(src.includes('tool.call.toolview'), "必须注入 tool.call.toolview 槽位");
assert.ok(src.includes("session.attachment"), "必须经 session.attachment RPC 加载图片");
assert.ok(src.includes("dip-frame"), "应有缩略图框样式 dip-frame");
assert.ok(src.includes("dip-backdrop") && src.includes("dip-image") && src.includes("dip-close"), "应有原图预览（lightbox）样式");
assert.ok(src.includes("Escape"), "lightbox 应支持 Esc 关闭");
console.log("✅ read_image toolview: 缩略图 + 原图预览（Esc/遮罩/关闭）已接线");

// 5) cordis.patch.yml registers the bundle.
const patch = readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
assert.ok(patch.includes("@alger-ai/dsh-image-preview"));
console.log("✅ cordis.patch.yml registers @alger-ai/dsh-image-preview");

console.log("\n✅ dsh-image-preview self-check passed");
