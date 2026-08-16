/**
 * @dsh-extension/dsh-vision-bridge
 *
 * On-demand vision for text-only DeepSeek sessions.
 *
 * The session stays on its text model on EVERY turn. Uploaded images and
 * tool-produced images (e.g. browser screenshots) remain in the session log
 * and Web UI unchanged, but the model input carries text markers instead of
 * image blocks. When the model actually needs to look at pixels it calls the
 * single `vision_describe` tool, which sends only the image(s) + a focused
 * question to the configured OpenAI-compatible vision model and returns the
 * answer as a normal tool result. This keeps vision spend minimal (image +
 * question only — no long history is ever sent to the vision model).
 *
 * DSH's host api-proxy otherwise refuses the prompt first (the current model
 * reports text-only input, so the RPC answers "当前模型不支持图片"). This
 * plugin wraps the shared `llm.resolveModelInfo` so the admission gate lets
 * the message enter the session; the marker rewrite then keeps image blocks
 * out of every text-model request.
 *
 * Configuration (all optional; defaults apply, env vars override):
 *   baseUrl   — vision endpoint base, e.g. https://api.openai.com/v1
 *               (a full ".../chat/completions" URL is also accepted)
 *   apiKey    — static API key
 *   apiKeyEnv — env var name holding the key (recommended over apiKey)
 *   model     — vision model id (default gpt-4o-mini)
 *   enabled   — master switch (default true)
 *
 * Env-var overrides use the prefix DSH_VISION_BRIDGE_ + UPPERCASE_FIELD:
 *   DSH_VISION_BRIDGE_BASE_URL, DSH_VISION_BRIDGE_API_KEY,
 *   DSH_VISION_BRIDGE_API_KEY_ENV, DSH_VISION_BRIDGE_MODEL, ...
 *
 * No build step needed: this is plain ESM loaded straight from lib/index.js.
 * @module @dsh-extension/dsh-vision-bridge
 */
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = '@dsh-extension/dsh-vision-bridge'
export const inject = ['settings', 'credentials', 'attachments', 'llm', 'tools', 'systemPrompt']

/** Shared resolveModelInfo wrapper state (hot-reload idempotency). */
const ADMISSION_FLAG = Symbol.for('dsh-vision-bridge.resolveModelInfo.patched')

/** Whether the llm.resolveModelInfo admission bypass is currently installed. */
let admissionActive = false

/** Same-origin route the browser Settings form reads/writes. */
export const SETTINGS_ROUTE = '/_dsh/vision-bridge/settings'

const ENV_PREFIX = 'DSH_VISION_BRIDGE_'
const VISION_PROVIDER = 'vision-bridge'
const VISION_CREDENTIAL = 'DSH_VISION_BRIDGE_API_KEY'
const MAX_IMAGES_PER_CALL = 4
const MAX_PATH_BYTES = 20 * 1024 * 1024

/** Settings namespace surfaced in the built-in DSH Settings page. */
export const SETTINGS_NAMESPACE = 'vision-bridge'

/** schemastery schema driving the Settings form (defaults apply). */
const Config = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  model: z.string().default('gpt-4o-mini'),
})

/** Runtime defaults mirroring the schema (used when settings are unavailable). */
const DEFAULTS = {
  enabled: true,
  baseUrl: '',
  apiKey: '',
  apiKeyEnv: '',
  model: 'gpt-4o-mini',
}

/** camelCase → SCREAMING_SNAKE_CASE for env lookups (baseUrl → BASE_URL). */
function envName(key) {
  return ENV_PREFIX + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/** Config file path: $DSH_VISION_BRIDGE_CONFIG, else ~/.dsh/vision-bridge.json. */
function configFilePath() {
  return process.env.DSH_VISION_BRIDGE_CONFIG || join(homedir(), '.dsh', 'vision-bridge.json')
}

/**
 * Re-read an optional JSON config file on every call so edits take effect live
 * without a restart. Path: $DSH_VISION_BRIDGE_CONFIG, else ~/.dsh/vision-bridge.json.
 * File keys override env and stored config (highest precedence).
 */
function readConfigFile() {
  try {
    const raw = readFileSync(configFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* missing or invalid file — fall through to env/defaults */
  }
  return {}
}

/** Persist config to the config file (Settings form writes here). */
function writeConfigFile(value) {
  const path = configFilePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return value
}

/**
 * Resolve the effective config. Precedence (highest wins):
 * Settings page (ctx.settings, includes schema defaults) → env vars → config file.
 * Settings are re-read live so edits take effect without a reload.
 */
function resolveConfig(ctx, input) {
  let cfg = ctx?.settings?.get?.(SETTINGS_NAMESPACE) ?? { ...DEFAULTS, ...(input ?? {}) }
  for (const key of Object.keys(DEFAULTS)) {
    const envNameKey = envName(key)
    if (process.env[envNameKey] !== undefined) {
      const v = process.env[envNameKey]
      cfg = { ...cfg, [key]: key === 'enabled' ? v !== 'false' && v !== '0' : v }
    }
  }
  return { ...cfg, ...readConfigFile() }
}

/** Normalize baseUrl for DSH's OpenAI-compatible adapter. */
function resolveBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  const base = b.replace(/\/chat\/completions$/i, '')
  return /\/v\d+$/i.test(base) ? base : `${base}/v1`
}

/** True when a content array carries an image block, descending into tool-result. */
export function contentHasImage(content) {
  return content?.some?.(
    (block) => block?.type === 'image' || (block?.type === 'tool-result' && contentHasImage(block.content)),
  ) === true
}

/** Durable attachment ids look like "sha256:<hex>"; anything else is a path. */
export function isAttachmentIdInput(input) {
  return (
    typeof input === 'string' && /^[a-z0-9]+:[0-9a-f]{32,}$/i.test(input.trim())
  )
}

/** Detect the image format from magic bytes (attachments are extension-less). */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  const head = (offset, count) => {
    const parts = []
    for (let i = offset; i < offset + count; i++) parts.push(bytes[i].toString(16).padStart(2, '0'))
    return parts.join('')
  }
  if (head(0, 8) === '89504e470d0a1a0a') return 'image/png'
  if (head(0, 3) === 'ffd8ff') return 'image/jpeg'
  const riff = head(0, 4)
  const webp = head(8, 4)
  if (riff === '52494646' && webp === '57454250') return 'image/webp'
  if (riff === '47494638') return 'image/gif' // GIF87a / GIF89a
  return undefined
}

const IMAGE_EXTENSIONS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** Extension → media type fallback for path input. */
export function mediaTypeOf(path) {
  const match = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? IMAGE_EXTENSIONS[match[1]] : undefined
}

/** Recursively freeze a plain structured-clone tree. */
export function deepFreezeLocal(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeLocal(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Recursively rewrite image blocks in a content tree, descending into nested
 * `tool-result` content exactly like the harness's own image walk. Returns the
 * rewritten array plus a changed flag; an untouched input array is returned
 * as-is so callers can keep object identity for unchanged messages.
 */
export function rewriteImagesDeep(content, replace) {
  if (!Array.isArray(content)) return { content, changed: false }
  let changed = false
  const next = []
  for (const block of content) {
    if (block && block.type === 'image') {
      changed = true
      const out = replace(block)
      if (out !== undefined && out !== null) {
        if (Array.isArray(out)) next.push(...out)
        else next.push(out)
      }
      continue
    }
    if (block && Array.isArray(block.content)) {
      const inner = rewriteImagesDeep(block.content, replace)
      if (inner.changed) {
        changed = true
        next.push({ ...block, content: inner.content })
        continue
      }
    }
    next.push(block)
  }
  return { content: changed ? next : content, changed }
}

/** Text marker replacing an image block in the model input. */
export function imageMarker(block) {
  const attachment = block && block.attachment ? block.attachment : {}
  const id = attachment.attachmentId || attachment.id || 'unknown'
  const name = attachment.name || '图片'
  return {
    type: 'text',
    text:
      `[图片「${name}」已上传，附件 id「${id}」。当前模型无法直接查看图片；` +
      `需要看图时调用 vision_describe 工具并传入 attachmentIds: ["${id}"] 和具体问题。]`,
  }
}

/**
 * Replace every image block in one message (top-level or nested in tool-result)
 * with a marker. Returns the original message unchanged when it has no image;
 * changed messages are rebuilt as deep-frozen structured clones to match the
 * frozen-message contract of `Session.deriveMessages`.
 */
export function rewriteImageBlocksToMarkers(message) {
  if (!message || !Array.isArray(message.content)) return message
  const result = rewriteImagesDeep(message.content, imageMarker)
  if (!result.changed) return message
  const clone = structuredClone(message)
  clone.content = result.content
  return deepFreezeLocal(clone)
}

/** Distinct image attachment refs inside one message (recursive), first-seen order. */
export function collectMessageAttachmentRefs(message) {
  const refs = []
  const seen = new Set()
  if (!message || !Array.isArray(message.content)) return refs
  rewriteImagesDeep(message.content, (block) => {
    const attachment = block && block.attachment
    if (attachment && attachment.attachmentId && !seen.has(String(attachment.attachmentId))) {
      seen.add(String(attachment.attachmentId))
      refs.push(attachment)
    }
    return block
  })
  return refs
}

/**
 * Distinct image attachment refs from a session event log (first-seen order).
 * `user/message` carries the message directly; `assistant/message` and
 * `tool/result` nest it under `data.message`. Descends into nested tool-result
 * content, so host-produced images (e.g. built-in read_image re-uploads) that
 * never cross the inbox-claim stream are indexed too.
 */
export function collectEventAttachmentRefs(events) {
  const refs = []
  const seen = new Set()
  for (const event of events ?? []) {
    if (!event || !event.data) continue
    let message
    if (event.type === 'user/message') {
      message = event.data
    } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
      message = event.data.message
    } else {
      continue
    }
    if (!message || !Array.isArray(message.content)) continue
    rewriteImagesDeep(message.content, (block) => {
      const attachment = block && block.attachment
      if (attachment && attachment.attachmentId && !seen.has(String(attachment.attachmentId))) {
        seen.add(String(attachment.attachmentId))
        refs.push(attachment)
      }
      return block
    })
  }
  return refs
}

function createVisionRouteSync(ctx) {
  let syncedRoute = ''
  return async (cfg) => {
    const baseURL = resolveBaseUrl(cfg.baseUrl)
    const model = String(cfg.model || '').trim()
    if (!baseURL) throw new Error('vision-bridge: no baseUrl configured')
    if (!model) throw new Error('vision-bridge: no vision model configured')

    let apiKeyEnv = String(cfg.apiKeyEnv || '').trim()
    if (cfg.apiKey) {
      apiKeyEnv = VISION_CREDENTIAL
      const current = await ctx.credentials.resolve(VISION_CREDENTIAL)
      if (current?.value !== cfg.apiKey) await ctx.credentials.set(VISION_CREDENTIAL, cfg.apiKey)
    }
    if (!apiKeyEnv) throw new Error('vision-bridge: no apiKey or apiKeyEnv configured')

    const profile = {
      displayName: 'Vision Bridge',
      apiKeyEnv,
      api: 'openai-completions',
      baseURL,
      models: [{ id: model, name: model, input: ['text', 'image'] }],
    }
    const fingerprint = JSON.stringify(profile)
    if (fingerprint === syncedRoute) return
    await ctx.settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', VISION_PROVIDER], value: profile },
    ])
    await Promise.resolve()
    await ctx.llm.resolveModelInfo(VISION_PROVIDER, model)
    syncedRoute = fingerprint
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status)
  res.end(bytes)
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError('request body too large')
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('empty request body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sameOriginPost(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * Same-origin Settings route for the browser form: GET returns the effective
 * config, POST { value } persists it to the config file (applied live).
 */
function installSettingsRoute(ctx, resolveCfg, syncVisionRoute, syncToolRegistration) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      return webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const stored = readConfigFile()
              const effective = resolveCfg()
              return responseJson(res, 200, {
                ok: true,
                value: {
                  stored,
                  effective,
                  admissionBypass: admissionActive,
                  services: {
                    credentials: Boolean(ctx.credentials),
                    attachments: Boolean(ctx.attachments),
                    llm: Boolean(ctx.llm),
                    tools: Boolean(ctx.get?.('tools')),
                  },
                },
              })
            }
            if (req.method !== 'POST') {
              res.setHeader('Allow', 'GET, POST')
              return responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } })
            }
            if (!sameOriginPost(req)) {
              return responseJson(res, 403, { ok: false, error: { code: 'origin-rejected', message: 'Origin rejected' } })
            }
            const body = await readJsonBody(req)
            if (!isRecord(body) || !isRecord(body.value)) {
              return responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'body.value must be an object' } })
            }
            const saved = writeConfigFile(body.value)
            const cfg = resolveCfg()
            syncToolRegistration(cfg)
            if (saved.enabled !== false) await syncVisionRoute(cfg)
            return responseJson(res, 200, { ok: true, value: { saved } })
          } catch (error) {
            ctx.logger?.warn?.('vision-bridge: settings route error: %s', error instanceof Error ? error.message : String(error))
            return responseJson(res, 400, { ok: false, error: { code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) } })
          }
        },
      })
    }, 'dsh-vision-bridge: settings route')
  })
}

/**
 * Admission-gate bypass.
 *
 * The host api-proxy rejects ANY prompt whose content contains an image block
 * BEFORE the message reaches the agent, whenever the session's current model
 * reports `inputModalities` without "image" — and the DeepSeek adapter reports
 * `["text"]`. We wrap the shared `llm.resolveModelInfo` so the gate admits the
 * message; the marker rewrite then keeps image blocks out of every text-model
 * request. The wrapper only engages while the bridge is enabled (re-read live
 * per call), survives hot reloads idempotently, and restores the original on
 * dispose.
 */
function installAdmissionBypass(ctx, config) {
  try {
    ctx.effect(() => {
      const llm = ctx.llm
      if (!llm || typeof llm.resolveModelInfo !== 'function') return

      let state = llm[ADMISSION_FLAG]
      if (!state || state.patched !== llm.resolveModelInfo || !(state.owners instanceof Set)) {
        state = { original: llm.resolveModelInfo, owners: new Set(), patched: null }
        state.patched = function (provider, model, signal) {
          const result = state.original.call(this, provider, model, signal)
          const enabled = [...state.owners].some((owner) => owner())
          if (!enabled) return result
          return Promise.resolve(result).then((info) => {
            if (!info || info.inputModalities === undefined) return info
            if (info.inputModalities.includes('image')) return info
            return { ...info, inputModalities: [...info.inputModalities, 'image'] }
          })
        }
        llm.resolveModelInfo = state.patched
        llm[ADMISSION_FLAG] = state
      }

      const owner = () => resolveConfig(ctx, config).enabled !== false
      state.owners.add(owner)
      admissionActive = true
      ctx.logger?.info?.('vision-bridge: admission bypass active (llm.resolveModelInfo wrapped)')
      return () => {
        state.owners.delete(owner)
        if (state.owners.size > 0) return
        if (llm.resolveModelInfo === state.patched) llm.resolveModelInfo = state.original
        if (llm[ADMISSION_FLAG] === state) delete llm[ADMISSION_FLAG]
        admissionActive = false
        ctx.logger?.info?.('vision-bridge: admission bypass removed')
      }
    }, 'dsh-vision-bridge: admission bypass')
  } catch (err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    ctx.logger?.warn?.('vision-bridge: admission bypass unavailable (images may still be rejected): %s', msg)
  }
}

/**
 * Build the `vision_describe` tool definition.
 *
 * `deps`:
 *   resolveConfig()  — live effective config
 *   syncVisionRoute(cfg) — ensure the vision-bridge provider route is current
 *   lookupAttachment(session, id) — durable ref for an uploaded attachment id
 *   logger — ctx.logger
 */
function createVisionDescribeTool(ctx, deps) {
  const { resolveConfig: resolveCfg, syncVisionRoute, lookupAttachment, logger } = deps

  const readImageBytes = async (exec, input) => {
    const value = String(input ?? '').trim()
    let bytes
    let ref
    let storedMediaType
    if (isAttachmentIdInput(value)) {
      const session = exec && exec.agent && exec.agent.session
      const hit = lookupAttachment(session, value)
      if (hit === undefined) {
        throw new Error(
          `vision_describe: unknown attachment id "${value}" (it must come from an image uploaded in this conversation)`,
        )
      }
      let stored
      try {
        stored = await ctx.attachments.readImage(hit, exec && exec.signal)
      } catch (error) {
        throw new Error(
          `vision_describe: failed to read attachment ${value} (${error && error.message ? error.message : String(error)})`,
        )
      }
      bytes = stored.data
      ref = stored.ref || hit
      storedMediaType = stored.ref && stored.ref.mediaType
    } else {
      const fs = ctx.get && ctx.get('fs')
      if (fs === undefined) throw new Error('vision_describe: the fs service is not available for path input')
      const target = await fs.resolve(value)
      bytes = await fs.readBytes(target, undefined, MAX_PATH_BYTES)
    }
    const mediaType = sniffMediaType(bytes) || storedMediaType || mediaTypeOf(value)
    if (mediaType === undefined) {
      throw new Error(`vision_describe: unsupported image format "${value}" (png/jpeg/webp/gif only)`)
    }
    return { bytes, mediaType, ref }
  }

  return {
    name: 'vision_describe',
    description:
      'Look at 1-4 images with the configured vision model and answer a focused question about them. ' +
      'For text-only sessions this is the bridge that provides image understanding. Provide ' +
      '`attachmentIds` (ids of images uploaded or produced in this conversation, e.g. "sha256:...") ' +
      'and/or `paths` (absolute local image file paths, png/jpeg/webp/gif). `question` is the question ' +
      'to answer; be specific. Multiple images are sent together so you can compare them.',
    parameters: {
      type: 'object',
      properties: {
        attachmentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attachment ids of images in this conversation, e.g. ["sha256:..."]',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute local image file paths (png/jpeg/webp/gif)',
        },
        question: {
          type: 'string',
          description: 'The focused question for the vision model',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const cfg = resolveCfg()
      if (cfg.enabled === false) throw new Error('vision_describe: the vision bridge is disabled')

      const attachmentIds = Array.isArray(args.attachmentIds) ? args.attachmentIds.map(String) : []
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : []
      const total = attachmentIds.length + paths.length
      if (total === 0 || total > MAX_IMAGES_PER_CALL) {
        throw new Error(`vision_describe: provide 1-${MAX_IMAGES_PER_CALL} images via attachmentIds and/or paths`)
      }
      const question = String(args.question ?? '').trim()
      if (question === '') throw new Error('vision_describe: question is required')

      const blocks = []
      for (const id of attachmentIds) {
        const { bytes, mediaType, ref } = await readImageBytes(exec, id)
        if (ref === undefined) {
          const saved = await ctx.attachments.saveImage({ data: bytes, mediaType })
          blocks.push({ type: 'image', attachment: saved })
        } else {
          blocks.push({ type: 'image', attachment: ref })
        }
      }
      for (const path of paths) {
        const { bytes, mediaType } = await readImageBytes(exec, path)
        const saved = await ctx.attachments.saveImage({ data: bytes, mediaType, name: path.split('/').pop() })
        blocks.push({ type: 'image', attachment: saved })
      }
      blocks.push({ type: 'text', text: question })

      await syncVisionRoute(cfg)
      const model = String(cfg.model || '').trim()
      let text = ''
      let failure = null
      try {
        const request = {
          provider: VISION_PROVIDER,
          model,
          messages: [{ role: 'user', content: blocks }],
          ...(exec && exec.signal ? { signal: exec.signal } : {}),
        }
        for await (const chunk of ctx.llm.stream(request)) {
          if (chunk && chunk.type === 'finish') {
            const kind = chunk.reason && chunk.reason.kind
            if (kind === 'error' || kind === 'aborted') {
              failure = (chunk.reason && chunk.reason.failure && chunk.reason.failure.message) || kind
            }
            continue
          }
          if (chunk && typeof chunk.text === 'string') text += chunk.text
        }
      } catch (error) {
        failure = error && error.message ? error.message : String(error)
      }
      if (failure !== null) {
        throw new Error(`vision_describe: vision request failed (${failure})`)
      }
      const answer = text.trim()
      return answer === '' ? '（视觉模型未返回内容）' : answer
    },
  }
}

export async function apply(ctx, config = {}) {
  // Surface a "vision-bridge" section in the built-in DSH Settings page.
  try {
    ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config })
  } catch (err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    ctx.logger?.warn?.('vision-bridge: settings namespace register failed: %s', msg)
  }

  const bootCfg = resolveConfig(ctx, config)
  const syncVisionRoute = createVisionRouteSync(ctx)
  ctx.logger?.info?.(
    'vision-bridge: registered (model=%s endpoint=%s key=%s; on-demand vision_describe tool)',
    bootCfg.model,
    resolveBaseUrl(bootCfg.baseUrl) || '(unset)',
    bootCfg.apiKey || bootCfg.apiKeyEnv ? 'yes' : 'no',
  )

  // ── session attachment index ────────────────────────────────────────────────
  // session object -> Map<attachmentId, ref> (uploads seen in inbox claims)
  const sessionAttachments = new WeakMap()
  // session.id -> Map<attachmentId, ref> (session objects are recreated on resume)
  const sessionAttachmentsById = new Map()
  // session object / session.id -> incremental event-log scan cursor
  const scannedSessionEventSeqs = new WeakMap()
  const scannedSessionEventSeqsById = new Map()

  const recordUploadedAttachments = (session, refs) => {
    if (!session || !Array.isArray(refs) || refs.length === 0) return
    let map = sessionAttachments.get(session)
    if (map === undefined) {
      map = new Map()
      sessionAttachments.set(session, map)
    }
    let byId
    if (session.id !== undefined) {
      byId = sessionAttachmentsById.get(String(session.id))
      if (byId === undefined) {
        byId = new Map()
        sessionAttachmentsById.set(String(session.id), byId)
      }
    }
    for (const ref of refs) {
      if (ref && ref.attachmentId) {
        map.set(String(ref.attachmentId), ref)
        if (byId !== undefined) byId.set(String(ref.attachmentId), ref)
      }
    }
  }

  const scanSessionEventLog = (session) => {
    if (!session) return
    let events
    try {
      events = session.events
    } catch {
      return // not a host Session (or the getter is unavailable): nothing to scan
    }
    if (!Array.isArray(events) || events.length === 0) return
    let cursor
    if (session.id !== undefined) {
      cursor = scannedSessionEventSeqsById.get(String(session.id))
      if (cursor === undefined) {
        cursor = { seq: 0 }
        scannedSessionEventSeqsById.set(String(session.id), cursor)
      }
    } else {
      cursor = scannedSessionEventSeqs.get(session)
      if (cursor === undefined) {
        cursor = { seq: 0 }
        scannedSessionEventSeqs.set(session, cursor)
      }
    }
    if (cursor.seq >= events.length) return
    const refs = collectEventAttachmentRefs(events.slice(cursor.seq))
    cursor.seq = events.length
    if (refs.length > 0) recordUploadedAttachments(session, refs)
  }

  const lookupAttachment = (session, id) => {
    const key = String(id)
    if (session !== undefined) {
      if (session.id !== undefined) {
        const byId = sessionAttachmentsById.get(String(session.id))
        const hit = byId && byId.get(key)
        if (hit !== undefined) return hit
      }
      const map = sessionAttachments.get(session)
      const hit = map && map.get(key)
      if (hit !== undefined) return hit
      // Miss: rescan the event log (ids announced by the harness for images it
      // persisted itself live there even though they never crossed the inbox
      // claim stream).
      scanSessionEventLog(session)
      if (session.id !== undefined) {
        const byId = sessionAttachmentsById.get(String(session.id))
        const after = byId && byId.get(key)
        if (after !== undefined) return after
      }
      const map2 = sessionAttachments.get(session)
      const afterHit = map2 && map2.get(key)
      if (afterHit !== undefined) return afterHit
    }
    return undefined
  }

  // ── marker rewrite: keep image blocks out of every text-model request ───────
  const wrappedSessions = new WeakSet()
  const installSessionWrap = (session) => {
    if (!session || typeof session.deriveMessages !== 'function' || wrappedSessions.has(session)) return
    const original = session.deriveMessages
    let active = true
    const patched = function () {
      const messages = original.call(this)
      if (!active) return messages
      const cfg = resolveConfig(ctx, config)
      if (cfg.enabled === false) return messages
      if (!messages.some((message) => contentHasImage(message && message.content))) return messages
      try {
        return messages.map((message) => rewriteImageBlocksToMarkers(message))
      } catch (err) {
        ctx.logger?.warn?.(
          'vision-bridge: marker rewrite failed, sending original messages: %s',
          err instanceof Error ? err.message : String(err),
        )
        return messages
      }
    }
    ctx.effect(() => {
      session.deriveMessages = patched
      wrappedSessions.add(session)
      return () => {
        active = false
        if (session.deriveMessages === patched) session.deriveMessages = original
        wrappedSessions.delete(session)
      }
    }, 'dsh-vision-bridge: session marker rewrite')
  }

  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      const session = agent && agent.session
      if (session) installSessionWrap(session)
      const decision = await next()
      if (!session) return decision
      const messages = (decision && decision.messages) || []
      const refs = []
      for (const message of messages) {
        for (const ref of collectMessageAttachmentRefs(message)) refs.push(ref)
      }
      recordUploadedAttachments(session, refs)
      scanSessionEventLog(session)
      return decision
    },
  )

  // ── vision_describe tool (dynamic: registered only while enabled) ───────────
  const visionTool = createVisionDescribeTool(ctx, {
    resolveConfig: () => resolveConfig(ctx, config),
    syncVisionRoute,
    lookupAttachment,
    logger: ctx.logger,
  })
  let toolDisposer = null
  const syncToolRegistration = (cfg) => {
    const tools = ctx.get && ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') return
    const should = cfg.enabled !== false
    if (should && toolDisposer === null) {
      try {
        toolDisposer = tools.register(visionTool)
        ctx.logger?.info?.('vision-bridge: vision_describe tool registered')
      } catch (err) {
        ctx.logger?.warn?.('vision-bridge: vision_describe tool registration failed: %s', err instanceof Error ? err.message : String(err))
      }
    } else if (!should && toolDisposer !== null) {
      try {
        toolDisposer()
      } catch {
        /* ignore disposer failure */
      }
      toolDisposer = null
      ctx.logger?.info?.('vision-bridge: vision_describe tool unregistered')
    }
  }
  syncToolRegistration(bootCfg)

  // Tool-surface routers may narrow the first request. Keep this bridge visible
  // after every downstream filter because image markers explicitly depend on it.
  ctx.on(
    'system-prompt/assemble',
    async (assembly, _context, next) => {
      const ownedAtStart = toolDisposer !== null
      const assembled = await next()
      const cfg = resolveConfig(ctx, config)
      syncToolRegistration(cfg)
      if (cfg.enabled === false) {
        if (!ownedAtStart || !assembled.tools.some((tool) => tool.name === visionTool.name)) return assembled
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => tool.name !== visionTool.name),
        }
      }
      const registeredSchema = assembly.tools.find((tool) => tool.name === visionTool.name)
      if (
        toolDisposer === null ||
        registeredSchema === undefined ||
        assembled.tools.some((tool) => tool.name === visionTool.name)
      ) {
        return assembled
      }
      return {
        ...assembled,
        tools: [...assembled.tools, structuredClone(registeredSchema)],
      }
    },
    { prepend: true },
  )

  // Web Settings form backend route (optional webServer service).
  installSettingsRoute(ctx, () => resolveConfig(ctx, config), syncVisionRoute, syncToolRegistration)

  // Unblock the host admission gate so image prompts reach the agent.
  installAdmissionBypass(ctx, config)

  ctx.effect(
    () => () => {
      if (toolDisposer !== null) {
        try {
          toolDisposer()
        } catch {
          /* ignore disposer failure */
        }
        toolDisposer = null
      }
    },
    'dsh-vision-bridge: vision_describe tool',
  )

  // Keep every request-facing hook/tool visible before the first async boundary.
  if (bootCfg.enabled !== false && bootCfg.baseUrl && bootCfg.model && (bootCfg.apiKey || bootCfg.apiKeyEnv)) {
    try {
      await syncVisionRoute(bootCfg)
    } catch (err) {
      ctx.logger?.warn?.('vision-bridge: vision route setup failed: %s', err instanceof Error ? err.message : String(err))
    }
  }
}
