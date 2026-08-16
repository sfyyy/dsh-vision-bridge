import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'

import {
  apply,
  inject,
  SETTINGS_ROUTE,
  contentHasImage,
  isAttachmentIdInput,
  sniffMediaType,
  collectEventAttachmentRefs,
  collectMessageAttachmentRefs,
  rewriteImageBlocksToMarkers,
} from '../lib/index.js'

/** A minimal valid PNG header (>= 12 bytes so sniffMediaType can decide). */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

/**
 * Real durable attachment ids look like "sha256:<64 hex chars>" — that is what
 * isAttachmentIdInput matches. Short fake ids would fall through to the path
 * branch, so build realistic ones.
 */
function AID(seed) {
  return 'sha256:' + String(seed).padStart(64, '0')
}

function makeImageBlock(id, name = 'photo.png') {
  return { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', name } }
}

function createFakeCtx(config, overrides = {}) {
  const handlers = new Map()
  const handlerOptions = new Map()
  const routes = []
  const credentials = new Map()
  const storedImages = new Map()
  const effects = []
  let active = true
  const calls = { stream: [], readImage: [], readBytes: [], saveImage: [] }

  const effect = (install) => {
    const dispose = install()
    if (typeof dispose === 'function') effects.push(dispose)
  }

  const tools = {
    registered: [],
    register(def) {
      this.registered.push(def)
      let disposed = false
      return () => {
        disposed = true
        this.registered = this.registered.filter((d) => d !== def)
      }
    },
  }

  const fs = {
    async resolve(path) {
      return path
    },
    async readBytes() {
      calls.readBytes.push(arguments[0])
      return PNG
    },
  }

  const llm = overrides.llm ?? {
    async resolveModelInfo(...args) {
      if (overrides.resolveModelInfo) return overrides.resolveModelInfo(...args)
      return { inputModalities: ['text'] }
    },
    async *stream(request) {
      calls.stream.push(request)
      if (overrides.stream) {
        yield* overrides.stream(request)
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '答案：图里有一只猫。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '答案：图里有一只猫。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const settings = {
    get: (namespace) => (namespace === 'vision-bridge' ? config : undefined),
    register: () => ({ get: () => config }),
    mutate: async () => {},
  }

  const ctx = {
    attachments: {
      async readImage(ref) {
        calls.readImage.push(ref)
        const hit = storedImages.get(String(ref.attachmentId)) || { data: PNG, mediaType: ref.mediaType || 'image/png' }
        return { data: hit.data, ref: { attachmentId: ref.attachmentId, mediaType: hit.mediaType } }
      },
      async saveImage(input) {
        calls.saveImage.push(input)
        const ref = {
          attachmentId: `sha256:${String(input.data.length)}`,
          mediaType: input.mediaType,
          ...(input.name ? { name: input.name } : {}),
        }
        storedImages.set(String(ref.attachmentId), { data: input.data, mediaType: input.mediaType })
        return ref
      },
    },
    credentials: {
      async resolve(ref) {
        return credentials.has(ref) ? { value: credentials.get(ref) } : undefined
      },
      async set(ref, value) {
        credentials.set(ref, value)
      },
    },
    llm,
    get settings() {
      if (!active) throw new Error('cannot get required service "settings" in inactive context')
      return settings
    },
    get(name) {
      if (name === 'tools') return tools
      if (name === 'fs') return fs
      return undefined
    },
    logger: { info() {}, warn() {} },
    effect,
    inject(services, callback) {
      if (services.includes('webServer')) {
        callback({
          webServer: { register: (def) => { routes.push(def); return () => {} } },
          effect,
        })
        return
      }
      callback({ llm, effect })
    },
    on(name, handler, options) {
      handlers.set(name, handler)
      handlerOptions.set(name, options)
    },
    _handlers: handlers,
    _handlerOptions: handlerOptions,
    _routes: routes,
    _tools: tools,
    _calls: calls,
    async _dispose() {
      while (effects.length > 0) await effects.pop()()
      active = false
    },
  }
  return ctx
}

function fakeSession(messages, events = [], id = 's1') {
  return {
    id,
    events,
    deriveMessages() {
      return messages
    },
  }
}

const CONFIG = {
  enabled: true,
  baseUrl: 'https://vision.example/v1',
  apiKey: 'test-key',
  model: 'vision-model',
}

// Isolate from any real ~/.dsh/vision-bridge.json on this machine.
const PREV_CONFIG = process.env.DSH_VISION_BRIDGE_CONFIG
process.env.DSH_VISION_BRIDGE_CONFIG = '/nonexistent/dsh-vision-bridge-test.json'

test('AC1: image blocks become markers; session log untouched', async () => {
  const ctx = createFakeCtx(CONFIG)
  const image = makeImageBlock(AID('a1'))
  const nested = { type: 'tool-result', toolCallId: 's1', content: [image] }
  const original = [
    { role: 'user', content: [image] },
    { role: 'assistant', content: [nested] },
  ]
  const session = fakeSession(structuredClone(original))
  await apply(ctx)

  const preStep = ctx._handlers.get('agent/pre-step')
  assert.ok(preStep, 'agent/pre-step handler must be registered')
  const decision = await preStep(
    { agent: { session } },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [image] }] }),
  )
  assert.equal(decision.kind, 'enter')

  const derived = session.deriveMessages()
  // top-level image → marker
  assert.equal(contentHasImage(derived[0].content), false)
  assert.ok(derived[0].content.some((b) => b.type === 'text' && /vision_describe/.test(b.text) && new RegExp(AID('a1')).test(b.text)))
  // nested tool-result image → marker too
  const toolResult = derived[1].content[0]
  assert.equal(toolResult.type, 'tool-result')
  assert.equal(contentHasImage(toolResult.content), false)
  assert.ok(toolResult.content.some((b) => b.type === 'text' && /vision_describe/.test(b.text)))
  // the session log (the messages we fed in) keeps the originals
  assert.equal(contentHasImage(original[0].content), true)
  assert.equal(contentHasImage(original[1].content[0].content), true)
})

test('AC2: vision_describe resolves an attachment id and returns the vision answer', async () => {
  const ctx = createFakeCtx(CONFIG)
  const image = makeImageBlock(AID('a1'))
  const session = fakeSession([])
  await apply(ctx)

  // index the attachment through the inbox claim of agent/pre-step
  const preStep = ctx._handlers.get('agent/pre-step')
  await preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [image] }] }))

  const tool = ctx._tools.registered.find((d) => d.name === 'vision_describe')
  assert.ok(tool, 'vision_describe must be registered while enabled')
  const answer = await tool.execute(
    { attachmentIds: [AID('a1')], question: '图里有什么？' },
    { agent: { session }, signal: new AbortController().signal },
  )
  assert.equal(answer, '答案：图里有一只猫。')
  assert.deepEqual(tool.output.render({}, answer), [{ type: 'text', text: answer }])

  assert.ok(ctx._calls.readImage.some((ref) => String(ref.attachmentId) === AID('a1')))
  const request = ctx._calls.stream[0]
  assert.equal(request.provider, 'vision-bridge')
  assert.equal(request.model, 'vision-model')
  const content = request.messages[0].content
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].attachment.attachmentId, AID('a1'))
  assert.equal(content[1].type, 'text')
  assert.equal(content[1].text, '图里有什么？')
})

test('first request: vision_describe survives routing while async route warmup is pending', async () => {
  let markWarmupEntered
  let releaseWarmup
  const warmupEntered = new Promise((resolve) => { markWarmupEntered = resolve })
  const warmupGate = new Promise((resolve) => { releaseWarmup = resolve })
  const ctx = createFakeCtx(CONFIG, {
    async resolveModelInfo(provider) {
      if (provider === 'vision-bridge') {
        markWarmupEntered()
        await warmupGate
      }
      return { inputModalities: ['text'] }
    },
  })

  const applying = apply(ctx)
  await warmupEntered
  try {
    const definition = ctx._tools.registered.find((tool) => tool.name === 'vision_describe')
    assert.ok(
      definition,
      'the first model request must see vision_describe even while route warmup is pending',
    )
    const assemble = ctx._handlers.get('system-prompt/assemble')
    const filtered = { sections: [], contexts: [], tools: [{ name: 'bash' }], variables: {} }
    const unfiltered = {
      ...filtered,
      tools: [...filtered.tools, {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }],
    }
    const firstRequest = await assemble(unfiltered, {}, async () => filtered)
    assert.deepEqual(firstRequest.tools.map((tool) => tool.name), ['bash', 'vision_describe'])
  } finally {
    releaseWarmup()
    await applying
  }
})

test('lifecycle: request-facing registries are required startup dependencies', () => {
  assert.ok(inject.includes('tools'), 'Cordis must park the plugin until the tool registry is available')
  assert.ok(inject.includes('systemPrompt'), 'Cordis must park the plugin until prompt assembly is available')
})

test('integration: vision_describe remains visible after downstream tool filters', async () => {
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx)

  const assemble = ctx._handlers.get('system-prompt/assemble')
  assert.ok(assemble, 'the plugin must own the final model-visible tool boundary')
  assert.equal(ctx._handlerOptions.get('system-prompt/assemble')?.prepend, true)
  const filtered = {
    sections: [],
    contexts: [],
    tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }],
    variables: {},
  }
  const definition = ctx._tools.registered.find((tool) => tool.name === 'vision_describe')
  const unfiltered = {
    ...filtered,
    tools: [...filtered.tools, {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }],
  }
  const result = await assemble(unfiltered, {}, async () => filtered)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'vision_describe'])

  const restricted = await assemble(filtered, {}, async () => filtered)
  assert.deepEqual(restricted.tools.map((tool) => tool.name), ['bash'])
})

test('AC3: vision_describe reads local paths through fs', async () => {
  const ctx = createFakeCtx(CONFIG)
  const session = fakeSession([])
  await apply(ctx)

  const tool = ctx._tools.registered.find((d) => d.name === 'vision_describe')
  const answer = await tool.execute(
    { paths: ['/tmp/photo.png'], question: '描述图片' },
    { agent: { session } },
  )
  assert.equal(answer, '答案：图里有一只猫。')
  assert.ok(ctx._calls.readBytes.length >= 1, 'fs.readBytes must be used for paths')
  assert.ok(ctx._calls.saveImage.length >= 1, 'path images are saved as durable attachments')
  const content = ctx._calls.stream[0].messages[0].content
  assert.equal(content[0].type, 'image')
  assert.ok(content[0].attachment.attachmentId)
})

test('AC4: tool-produced tool/result images are indexed from the event log', async () => {
  const ctx = createFakeCtx(CONFIG)
  const screenshot = makeImageBlock(AID('b2'), 'shot.png')
  const events = [
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 't1', content: [screenshot] }],
        },
      },
    },
  ]
  const session = fakeSession([], events, 's2')
  await apply(ctx)

  const preStep = ctx._handlers.get('agent/pre-step')
  await preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))

  const tool = ctx._tools.registered.find((d) => d.name === 'vision_describe')
  const answer = await tool.execute(
    { attachmentIds: [AID('b2')], question: '截图里有什么？' },
    { agent: { session } },
  )
  assert.equal(answer, '答案：图里有一只猫。')
  assert.ok(ctx._calls.stream[0].messages[0].content[0].attachment.attachmentId === AID('b2'))
})

test('AC5: disabled bridge registers no tool and rewrites nothing', async () => {
  const ctx = createFakeCtx({ ...CONFIG, enabled: false })
  const image = makeImageBlock(AID('a1'))
  const original = [{ role: 'user', content: [image] }]
  const session = fakeSession(structuredClone(original))
  await apply(ctx)

  assert.equal(ctx._tools.registered.some((d) => d.name === 'vision_describe'), false)

  const filtered = { sections: [], contexts: [], tools: [{ name: 'bash' }], variables: {} }
  const assembled = await ctx._handlers.get('system-prompt/assemble')(filtered, {}, async () => filtered)
  assert.deepEqual(assembled.tools.map((tool) => tool.name), ['bash'])

  const preStep = ctx._handlers.get('agent/pre-step')
  await preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  const derived = session.deriveMessages()
  assert.deepEqual(derived, original, 'deriveMessages must pass through when disabled')

  const info = await ctx.llm.resolveModelInfo('deepseek', 'text-model')
  assert.deepEqual(info.inputModalities, ['text'], 'admission bypass must be off when disabled')
})

test('AC5: live disable removes the tool from an in-flight assembly', async () => {
  const config = { ...CONFIG }
  const ctx = createFakeCtx(config)
  await apply(ctx)

  const definition = ctx._tools.registered.find((tool) => tool.name === 'vision_describe')
  const assembly = {
    sections: [],
    contexts: [],
    tools: [{ name: definition.name, description: definition.description, parameters: definition.parameters }],
    variables: {},
  }
  config.enabled = false

  const assemble = ctx._handlers.get('system-prompt/assemble')
  const result = await assemble(assembly, {}, async () => assembly)
  assert.deepEqual(result.tools, [])
  assert.equal(ctx._tools.registered.some((tool) => tool.name === 'vision_describe'), false)
})

test('AC6: text-only sessions are untouched', async () => {
  const ctx = createFakeCtx(CONFIG)
  const original = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  const session = fakeSession(structuredClone(original))
  await apply(ctx)

  const preStep = ctx._handlers.get('agent/pre-step')
  await preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(session.deriveMessages(), original)
})

test('lifecycle: session rewrite is removed before plugin services become inactive', async () => {
  const oldCtx = createFakeCtx(CONFIG)
  const image = makeImageBlock(AID('a1'))
  const session = fakeSession([{ role: 'user', content: [image] }])
  const originalDeriveMessages = session.deriveMessages
  await apply(oldCtx)

  const oldPreStep = oldCtx._handlers.get('agent/pre-step')
  await oldPreStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(contentHasImage(session.deriveMessages()[0].content), false)
  const staleDeriveMessages = session.deriveMessages
  await oldCtx._dispose()
  assert.throws(
    () => oldCtx.settings,
    { message: 'cannot get required service "settings" in inactive context' },
  )
  let staleDerived
  assert.doesNotThrow(() => {
    staleDerived = staleDeriveMessages.call(session)
  })
  assert.equal(contentHasImage(staleDerived[0].content), true)
  assert.equal(session.deriveMessages, originalDeriveMessages)
  assert.equal(oldCtx._tools.registered.some((d) => d.name === 'vision_describe'), false)

  const freshCtx = createFakeCtx(CONFIG)
  await apply(freshCtx)
  const freshPreStep = freshCtx._handlers.get('agent/pre-step')
  await freshPreStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))

  let derived
  assert.doesNotThrow(() => {
    derived = session.deriveMessages()
  })
  assert.equal(contentHasImage(derived[0].content), false)
})

test('lifecycle: admission bypass survives overlapping reload and stale calls', async () => {
  const original = async () => ({ inputModalities: ['text'] })
  const sharedLlm = {
    resolveModelInfo: original,
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const oldCtx = createFakeCtx(CONFIG, { llm: sharedLlm })
  const freshCtx = createFakeCtx(CONFIG, { llm: sharedLlm })

  await apply(oldCtx)
  const staleResolveModelInfo = sharedLlm.resolveModelInfo
  await apply(freshCtx)
  assert.equal(sharedLlm.resolveModelInfo, staleResolveModelInfo, 'reloads must share one owned wrapper')

  await oldCtx._dispose()
  assert.deepEqual(
    (await sharedLlm.resolveModelInfo('deepseek', 'text-model')).inputModalities,
    ['text', 'image'],
    'disposing the old context must not remove the fresh context bypass',
  )

  await freshCtx._dispose()
  assert.equal(sharedLlm.resolveModelInfo, original)
  await assert.doesNotReject(async () => {
    const info = await staleResolveModelInfo('deepseek', 'text-model')
    assert.deepEqual(info.inputModalities, ['text'])
  })
})

test('vision_describe reports terminal stream failures as rendered tool errors', async () => {
  const ctx = createFakeCtx(CONFIG, {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream failed' } } }
    },
  })
  await apply(ctx)
  const tool = ctx._tools.registered.find((definition) => definition.name === 'vision_describe')

  await assert.rejects(
    tool.execute({ paths: ['/tmp/photo.png'], question: '描述图片' }, { agent: { session: fakeSession([]) } }),
    { message: 'vision_describe: vision request failed (upstream failed)' },
  )
})

test('AC7: settings route, admission bypass and vision profile are wired', async () => {
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx)

  assert.ok(ctx._routes.some((r) => r.kind === 'exact' && r.path === SETTINGS_ROUTE))
  const info = await ctx.llm.resolveModelInfo('deepseek', 'text-model')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('pure helpers: id sniffing, media sniffing, ref collection, marker rewrite', () => {
  assert.equal(isAttachmentIdInput(AID('aa')), true)
  assert.equal(isAttachmentIdInput('/tmp/photo.png'), false)
  assert.equal(sniffMediaType(PNG), 'image/png')

  const image = makeImageBlock(AID('aa'))
  const message = { role: 'user', content: [image, { type: 'text', text: 'hi' }] }
  const refs = collectMessageAttachmentRefs(message)
  assert.deepEqual(refs.map((r) => r.attachmentId), [AID('aa')])

  const events = [{ type: 'user/message', data: message }]
  assert.deepEqual(collectEventAttachmentRefs(events).map((r) => r.attachmentId), [AID('aa')])

  const rewritten = rewriteImageBlocksToMarkers(message)
  assert.equal(contentHasImage(rewritten.content), false)
  assert.equal(contentHasImage(message.content), true)
})

test('teardown: restore DSH_VISION_BRIDGE_CONFIG', () => {
  if (PREV_CONFIG === undefined) delete process.env.DSH_VISION_BRIDGE_CONFIG
  else process.env.DSH_VISION_BRIDGE_CONFIG = PREV_CONFIG
})
