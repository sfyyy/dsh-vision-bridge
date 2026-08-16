# @dsh-extension/dsh-vision-bridge

> On-demand vision for text-only DeepSeek Harness (DSH) sessions.

[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E.svg?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![TypeScript](https://img.shields.io/badge/TypeScript-typings-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/@dsh-extension/dsh-vision-bridge.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/@dsh-extension/dsh-vision-bridge)
[![npm downloads](https://img.shields.io/npm/dm/@dsh-extension/dsh-vision-bridge.svg?color=cb3837)](https://www.npmjs.com/package/@dsh-extension/dsh-vision-bridge)
[![GitHub stars](https://img.shields.io/github/stars/sfyyy/dsh-vision-bridge.svg)](https://github.com/sfyyy/dsh-vision-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFE.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)

[中文文档](./README.zh-CN.md) · [npm](https://www.npmjs.com/package/@dsh-extension/dsh-vision-bridge)

A DSH plugin that gives a **text-only DeepSeek session on-demand multimodal capability**: the session stays on its text model for every turn, and only when the model actually needs to look at pixels — a screenshot, an uploaded image, a diagram, a chart — does it call the `vision_describe` tool, which sends **only the image(s) + a focused question** to an OpenAI-compatible vision model.

- **No long context ever reaches the vision model** — a 300k-token conversation history is never sent; each vision call is just image + question, keeping cost minimal.
- **Session log and UI keep the original images** — only the model *input* is rewritten to text markers.
- **Bring your own vision endpoint** — any OpenAI-compatible `/v1/chat/completions` service (OpenAI, DeepSeek, Gemini proxy, local vLLM/One-API, …).

## ❤️ Sponsors

> [Want to appear here?](mailto:sfyyy@users.noreply.github.com) — sponsor this project with an API donation.

<table>

<tr>
<td width="180"><a href="https://api.xiaoyaoapi.cc/"><img src="https://api.xiaoyaoapi.cc/logo.png" alt="xiaoyaoapi" width="150"></a></td>
<td>🎉 Thanks to <a href="https://api.xiaoyaoapi.cc/">xiaoyaoapi</a> for donating their API to this project! xiaoyaoapi is an OpenAI-compatible AI API aggregation gateway for developers, built on New API with a unified admin dashboard. It offers unified key management, transparent usage tracking, and multi-channel access to mainstream large models under a single endpoint — letting developers integrate leading LLM services at lower cost and with greater convenience, ready to use as the vision endpoint of this plugin.</td>
</tr>

</table>

## How it works

```text
User / tool produces an image ──► image stays in the session and UI
                                   │
                                   ▼  (model input layer)
                              image is rewritten to a text marker
                          (marker carries the attachment id and hints
                           the model to call vision_describe)
                                   │
                                   ▼
   text model calls vision_describe(attachmentIds / paths, question)
                                   │
                                   ▼
   vision model (receives only image + question) → text answer
                                → returned as a normal tool result
```

- The `agent/pre-step` hook records every image attachment that appears in the session (user uploads **and** tool-produced screenshots, including ones nested inside `tool-result`), building an attachment index that `vision_describe` uses to resolve bytes by id.
- `session.deriveMessages()` is wrapped so that **no text-model request ever contains image blocks** (the native DeepSeek adapter rejects them); images are replaced by text markers. The session event log and UI keep showing the original images.
- DSH's built-in `llm-pi-ai` builds the OpenAI multimodal request; the plugin only maintains a single `vision-bridge` provider route and does not re-implement a protocol adapter.

### Image admission

DSH Web runs an image-capability check before a message enters the agent, based on the current DeepSeek model. This plugin keeps an admission bypass so images can enter the session first; the marker rewrite then guarantees no text-model request carries image blocks. When the plugin is disabled or uninstalled, the native admission check is restored.

Check `GET /_dsh/vision-bridge/settings` for the live `value.admissionBypass` and dependency-service status.

## Installation

Install from the npm registry (not a local checkout) — one command:

```sh
# if you already have the `dsh` CLI on PATH:
dsh plugin --profile web add @dsh-extension/dsh-vision-bridge

# or, if you have been using npx all along:
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add @dsh-extension/dsh-vision-bridge
```

> The `--profile` flag targets the profile you boot (`web` is the browser UI profile). Omit it or adapt it if your profile has a different name.
>
> After a new client bundle is added, restart `dsh web` once so the UI picks it up.

## Configuration

Configure it in **Settings → Vision Bridge** (DSH Web), or edit `~/.dsh/vision-bridge.json`:

```json
{
  "enabled": true,
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-xxxx",
  "apiKeyEnv": "",
  "model": "gpt-5.6-terra"
}
```

- `baseUrl` accepts an API root, a `.../v1` base, or a full `.../chat/completions` URL (the plugin normalizes it).
- `apiKey` and `apiKeyEnv` are mutually exclusive. A directly entered key is synced to the DSH credential store and referenced as `DSH_VISION_BRIDGE_API_KEY`.
- The plugin maintains exactly one `vision-bridge` route inside DSH's `llm-pi-ai.providers` and never touches other providers.
- `enabled: false` disables the whole chain: no tool registration, no image rewriting, no admission bypass (native behavior restored).

**Precedence (highest wins):** Settings page (with schema defaults) → environment variables → config file.

**Environment overrides:** `DSH_VISION_BRIDGE_BASE_URL`, `DSH_VISION_BRIDGE_API_KEY`, `DSH_VISION_BRIDGE_API_KEY_ENV`, `DSH_VISION_BRIDGE_MODEL`, `DSH_VISION_BRIDGE_ENABLED`.

## `vision_describe` tool

- **Arguments**
  - `attachmentIds`: image attachment ids from the current conversation (shaped like `sha256:...`), one or several;
  - `paths`: absolute local image file paths (`png`/`jpeg`/`webp`/`gif`) — use either or both, **1–4 images in total**;
  - `question`: required — a focused, specific question about the image(s).
- **Behavior**: resolves the images → sends image(s) + question to the vision model via the `vision-bridge` route → returns the text answer as a tool result.
- **Multi-image comparison** is supported: put several images in the same user message.
- Attachment ids must come from the current conversation (user uploads or tool output); `paths` go through DSH's sandbox-aware file service.

## Verify

```sh
npm test
```

The suite covers: image-marker rewriting (including nested `tool-result`), both id- and path-based resolution, event-log attachment indexing, full-chain shutdown when disabled, and text-only sessions staying untouched.

## Development

From a local checkout:

```sh
dsh plugin inject /path/to/dsh-vision-bridge
```

## Search keywords

`deepseek` · `deepseek-harness` · `dsh` · `plugin` · `vision` · `multimodal` · `vision-language-model` · `VLM` · `image understanding` · `screenshot` · `OCR` · `image analysis` · `OpenAI-compatible` · `text-only-llm` · `on-demand vision` · `LLM agent`

## License

[MIT](./LICENSE)
