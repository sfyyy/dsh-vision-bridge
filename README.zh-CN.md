# @dsh-extension/dsh-vision-bridge

> 让 DSH 的纯文本 DeepSeek 会话获得**按需多模态能力**。

[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E.svg?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![TypeScript](https://img.shields.io/badge/TypeScript-typings-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/@dsh-extension/dsh-vision-bridge.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/@dsh-extension/dsh-vision-bridge)
[![npm downloads](https://img.shields.io/npm/dm/@dsh-extension/dsh-vision-bridge.svg?color=cb3837)](https://www.npmjs.com/package/@dsh-extension/dsh-vision-bridge)
[![GitHub stars](https://img.shields.io/github/stars/sfyyy/dsh-vision-bridge.svg)](https://github.com/sfyyy/dsh-vision-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFE.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)

[English](./README.md) · [npm](https://www.npmjs.com/package/@dsh-extension/dsh-vision-bridge)

一个 DSH 插件：会话全程停留在文本模型上，只有当模型真正需要看图时——截图、上传的图片、流程图、图表——才通过 `vision_describe` 工具把「图片 + 问题」交给 OpenAI 兼容的视觉模型处理。

- **长上下文永远不会发给视觉模型** —— 30 万 token 的会话历史绝不发送，每次视觉调用只有「图 + 问题」，成本最低。
- **会话日志与界面保留原图** —— 只有模型*输入*被改写为文本标记。
- **自带视觉端点** —— 任何 OpenAI 兼容的 `/v1/chat/completions` 服务（OpenAI、DeepSeek、Gemini 代理、本地 vLLM/One-API…）都可用。

## ❤️ 赞助商

> [想出现在这里吗？](mailto:sfyyy@users.noreply.github.com) —— 以 API 捐赠的方式赞助本项目。

<table>

<tr>
<td width="180"><a href="https://api.xiaoyaoapi.cc/"><img src="https://api.xiaoyaoapi.cc/logo.png" alt="xiaoyaoapi" width="150"></a></td>
<td>🎉 感谢 <a href="https://api.xiaoyaoapi.cc/">xiaoyaoapi</a> 为本项目捐赠 API！xiaoyaoapi 是一个面向开发者的 OpenAI 兼容 AI API 聚合网关，基于 New API 构建，提供统一管理后台。它支持统一密钥管理、透明用量统计，并在单一端点下聚合多个主流大模型渠道——让开发者以更低成本、更便捷的方式接入领先的大模型服务，可直接作为本插件的视觉端点使用。</td>
</tr>

</table>

## 工作原理

```text
用户/工具产生图片 ──► 图片保留在会话与界面中
                        │
                        ▼ （模型输入层）
                  图片被改写为文本标记
                （标记里带附件 id，并提示调用 vision_describe）
                        │
                        ▼
   文本模型调用 vision_describe(attachmentIds / paths, question)
                        │
                        ▼
   视觉模型（只收到 图 + 问题）→ 返回文本答案 → 作为工具结果回到会话
```

- `agent/pre-step` 钩子记录会话中出现过的所有图片附件（用户上传 + 工具产生的截图，包括嵌套在 `tool-result` 里的），建立附件索引，供 `vision_describe` 按 id 解析字节。
- 包装 `session.deriveMessages()`：任何进入文本模型的请求都不含图片块（原生 DeepSeek 适配器会拒绝图片内容），图片被替换为文本标记；会话事件日志与界面展示保持原图不变。
- DSH 内置 `llm-pi-ai` 负责构造 OpenAI 多模态请求；插件只维护唯一的 `vision-bridge` provider 路由，不重复实现协议适配器。

### 图片准入

DSH Web 会在消息进入 agent 前根据当前 DeepSeek 模型执行图片能力检查。本插件保留 admission bypass，让图片先进入会话；随后标记改写保证文本模型请求中不含图片块。插件关闭或卸载后，原生准入检查恢复。

可通过 `GET /_dsh/vision-bridge/settings` 检查 `value.admissionBypass` 与依赖服务状态。

## 安装

从 npm registry 安装（非本地安装），一条命令即可：

```sh
# 如果你的终端里已经有 dsh 命令：
dsh plugin --profile web add @dsh-extension/dsh-vision-bridge

# 或者你一直使用 npx，可以写成：
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add @dsh-extension/dsh-vision-bridge
```

> `--profile` 指定你要启动的 profile（`web` 即浏览器 UI profile）；如果你的 profile 名字不同，请相应调整或省略。
>
> 新增客户端 bundle 后需要重启一次 `dsh web`，让界面加载。

## 配置

在 DSH **设置 → Vision Bridge** 中填写，或编辑 `~/.dsh/vision-bridge.json`：

```json
{
  "enabled": true,
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-xxxx",
  "apiKeyEnv": "",
  "model": "gpt-5.6-terra"
}
```

- `baseUrl` 可以是 API 根地址、`.../v1` 基址或完整的 `.../chat/completions` 地址（插件会自动规范化）。
- `apiKeyEnv` 与 `apiKey` 二选一；直接填写的 key 会同步到 DSH credential store，并以 `DSH_VISION_BRIDGE_API_KEY` 引用。
- 插件在 DSH 的 `llm-pi-ai.providers` 中维护唯一的 `vision-bridge` 路由，不改动其它 provider。
- `enabled: false` 时整条链路关闭：不注册工具、不改写图片、不启用准入 bypass（恢复原生行为）。

**优先级（高者生效）：** 设置页（含 schema 默认值）→ 环境变量 → 配置文件。

**环境变量覆盖：** `DSH_VISION_BRIDGE_BASE_URL`、`DSH_VISION_BRIDGE_API_KEY`、`DSH_VISION_BRIDGE_API_KEY_ENV`、`DSH_VISION_BRIDGE_MODEL`、`DSH_VISION_BRIDGE_ENABLED`。

## vision_describe 工具

- **参数**
  - `attachmentIds`：当前会话中的图片附件 id（形如 `sha256:...`），可多张；
  - `paths`：本地图片绝对路径（png/jpeg/webp/gif），可单独或与附件 id 混用，**共 1–4 张**；
  - `question`：必填，针对图片的具体问题。
- **行为**：解析图片 → 通过 `vision-bridge` 路由把「图片 + 问题」发给视觉模型 → 返回文本答案作为工具结果。
- 支持多图对比：把多张图放在同一条 user 消息里一起发送。
- 附件 id 只能来自当前会话（用户上传或工具产生）；`paths` 走 DSH 的沙箱感知文件服务。

## 验证

```sh
npm test
```

测试覆盖：图片标记改写（含嵌套 tool-result）、附件 id/路径两种解析、事件日志附件索引、禁用时全链路关闭、纯文本会话不受影响。

## 开发

从本地源码目录安装：

```sh
dsh plugin inject /path/to/dsh-vision-bridge
```

## 搜索关键词

`deepseek` · `deepseek-harness` · `dsh` · `plugin` · `vision` · `multimodal` · `vision-language-model` · `VLM` · `image understanding` · `screenshot` · `OCR` · `image analysis` · `OpenAI-compatible` · `text-only-llm` · `on-demand vision` · `LLM agent`

## 协议

[MIT](./LICENSE)
