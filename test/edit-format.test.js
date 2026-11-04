/**
 * The edit transport: how reference images reach the provider.
 *
 * Regression this guards: before 0.2.0 an edit always POSTed a JSON body with
 * data urls to `/images/edits`. Providers that implement the endpoint per the
 * OpenAI spec expect a multipart/form-data upload, so every edit failed even
 * though plain generation worked. `editFormat` (Settings → 插件 → 插件配置 →
 * 图形生成 → 改图方式) now picks the transport, and `auto` falls back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const providers = {
  openai: {
    id: 'relay',
    name: 'relay',
    baseUrl: 'https://relay.test/v1',
    apiFormat: 'openai-images',
  },
  xai: {
    id: 'grok',
    name: 'grok',
    baseUrl: 'https://grok.test/v1',
    apiFormat: 'xai-images',
  },
}

// 1×1 transparent PNG, used as the reference image and as the answer.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const REFERENCE = `data:image/png;base64,${PIXEL}`

function referenceAt(index) {
  return {
    attachmentId: `sha256:${'0'.repeat(60)}${index}`,
    mediaType: 'image/png',
    bytes: 8,
    width: 1,
    height: 1,
    name: `ref-${index}.png`,
  }
}

/** Record every request and answer with a b64 image unless a handler says otherwise. */
function stubFetch(handler = () => null) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init }
    calls.push(call)
    const override = handler(call, calls.length)
    if (override !== null) return override
    return new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

async function runEdit(options) {
  const { generateEdit: generate } = await import('../index.js')
  const refs = Array.from({ length: options.references ?? 1 }, (_value, index) => referenceAt(index))
  return generate({
    provider: providers[options.provider ?? 'openai'],
    model: 'gpt-image-1',
    args: { prompt: 'make it blue' },
    runtime: {
      defaultSize: '1024x1024',
      defaultQuality: 'auto',
      editFormat: options.editFormat,
    },
    apiKey: 'sk-test',
    signal: undefined,
    references: refs.map(() => REFERENCE),
  })
}

test('an edit posts the reference as a multipart upload', async () => {
  const stub = stubFetch()
  try {
    const images = await runEdit({ editFormat: 'multipart', fetchStub: stub })
    assert.equal(images.length, 1)
    assert.equal(stub.calls.length, 1)
    assert.match(stub.calls[0].url, /\/images\/edits$/)
    assert.ok(stub.calls[0].init.body instanceof FormData, 'multipart mode must send FormData')
    const form = stub.calls[0].init.body
    assert.equal(form.get('model'), 'gpt-image-1')
    assert.equal(form.get('prompt'), 'make it blue')
    assert.equal(form.get('size'), '1024x1024')
    assert.ok(form.get('image') instanceof Blob, 'the reference travels as a file part')
    assert.equal(stub.calls[0].init.headers['content-type'], undefined, 'never set a JSON content type')
  } finally {
    stub.restore()
  }
});

test('auto falls back to the legacy JSON body when the upload is rejected', async () => {
  const stub = stubFetch((call, count) => {
    if (count === 1) {
      return new Response(JSON.stringify({ error: { message: 'unsupported media type' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return null
  })
  try {
    const images = await runEdit({ editFormat: 'auto', fetchStub: stub })
    assert.equal(images.length, 1)
    assert.equal(stub.calls.length, 2, 'multipart first, then the JSON body')
    assert.ok(stub.calls[0].init.body instanceof FormData)
    const second = JSON.parse(stub.calls[1].init.body)
    assert.deepEqual(second.images, [{ image_url: REFERENCE }])
    assert.match(stub.calls[1].init.headers['content-type'], /application\/json/)
  } finally {
    stub.restore()
  }
});

test('json mode keeps a single request and the pre-0.2.0 body', async () => {
  const stub = stubFetch()
  try {
    await runEdit({ editFormat: 'json', fetchStub: stub })
    assert.equal(stub.calls.length, 1)
    const body = JSON.parse(stub.calls[0].init.body)
    assert.deepEqual(body.images, [{ image_url: REFERENCE }])
  } finally {
    stub.restore()
  }
});

test('the xai flavour keeps its own image shape', async () => {
  const stub = stubFetch()
  try {
    await runEdit({ editFormat: 'json', provider: 'xai', fetchStub: stub })
    const body = JSON.parse(stub.calls[0].init.body)
    assert.deepEqual(body.image, { type: 'image_url', url: REFERENCE })
  } finally {
    stub.restore()
  }
});

test('chat mode sends the reference through /chat/completions', async () => {
  const stub = stubFetch()
  try {
    await runEdit({ editFormat: 'chat', fetchStub: stub })
    assert.equal(stub.calls.length, 1)
    assert.match(stub.calls[0].url, /\/chat\/completions$/)
    const body = JSON.parse(stub.calls[0].init.body)
    assert.equal(body.messages[0].content[0].text, 'make it blue')
    assert.equal(body.messages[0].content[1].image_url.url, REFERENCE)
  } finally {
    stub.restore()
  }
});

test('off refuses the edit without touching the network', async () => {
  const stub = stubFetch()
  try {
    await assert.rejects(
      () => runEdit({ editFormat: 'off', fetchStub: stub }),
      /改图已关闭/,
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
});
