/**
 * Task-based (asynchronous) gateways: the submit answers with a task id and the
 * image only appears after polling. Ported from upstream PR #1, plus the gaps
 * that PR listed as known: a 202 without a task id, and a poll body that carries
 * both a status and images.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.IMAGE_GEN_ASYNC_POLL_INTERVAL_MS = '0'

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const provider = {
  id: 'relay',
  name: 'relay',
  baseUrl: 'https://relay.test/v1',
  apiFormat: 'openai-images',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Answer each request from a queue; record every call for assertions. */
function stubFetch(responses) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (next === undefined) throw new Error(`unexpected request: ${url}`)
    return typeof next === 'function' ? next() : next
  }
  return { calls, restore() { globalThis.fetch = original } }
}

async function run(options) {
  const { generateOpenAiImages } = await import('../index.js')
  return generateOpenAiImages({
    provider,
    model: 'image-model',
    args: { prompt: 'a whale' },
    runtime: {
      defaultSize: '1024x1024',
      defaultQuality: 'auto',
      asyncMode: options.asyncMode ?? 'auto',
      editFormat: options.editFormat,
    },
    apiKey: 'sk-test',
    signal: undefined,
    references: options.references,
  })
}

test('sync mode refuses to poll: a task envelope names the switch', async () => {
  const stub = stubFetch([json({ task_status: 'PENDING', task_id: 'task-1' })])
  try {
    await assert.rejects(() => run({ asyncMode: 'sync' }), /needs async mode/)
    assert.equal(stub.calls.length, 1, 'no polling attempt in sync mode')
  } finally {
    stub.restore()
  }
});

test('auto polls a task envelope and returns the finished image', async () => {
  const stub = stubFetch([
    json({ task_status: 'PENDING', task_id: 'task-1' }),
    json({ task_status: 'SUCCEED', output_images: ['https://cdn.test/one.png'] }),
    () => new Response(Buffer.from(PIXEL, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }),
  ])
  try {
    const images = await run({ asyncMode: 'auto' })
    assert.equal(images.length, 1)
    assert.equal(stub.calls.length, 3)
    assert.match(stub.calls[1].url, /\/v1\/tasks\/task-1$/)
    assert.match(stub.calls[2].url, /one\.png$/, 'the finished url is downloaded')
  } finally {
    stub.restore()
  }
});

test('async mode asks the gateway for a task on the submit', async () => {
  const stub = stubFetch([
    json({ task_status: 'SUCCEED', output_images: ['https://cdn.test/two.png'] }),
    () => new Response(Buffer.from(PIXEL, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }),
  ])
  try {
    await run({ asyncMode: 'async' })
    const submit = JSON.parse(stub.calls[0].init.body)
    assert.equal(submit.async, true, 'aggregators read the opt-in from the body')
    assert.equal(stub.calls[0].init.headers['X-ModelScope-Async-Mode'], undefined)
  } finally {
    stub.restore()
  }
});

test('a poll body carrying both a status and images finishes', async () => {
  const stub = stubFetch([
    json({ task_status: 'PENDING', task_id: 'task-2' }),
    json({ task_status: 'RUNNING', output_images: ['https://cdn.test/three.png'] }),
    () => new Response(Buffer.from(PIXEL, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }),
  ])
  try {
    const images = await run({ asyncMode: 'auto' })
    assert.equal(images.length, 1, 'images win over the stale status')
    assert.equal(stub.calls.length, 3)
  } finally {
    stub.restore()
  }
});

test('an accepted submit without a task id fails with a real explanation', async () => {
  const stub = stubFetch([json({ task_status: 'PROCESSING' }, 202)])
  try {
    await assert.rejects(() => run({ asyncMode: 'auto' }), /returned no task id/)
  } finally {
    stub.restore()
  }
});

test('a SUCCEED poll without an image names the task', async () => {
  const stub = stubFetch([
    json({ task_status: 'PENDING', task_id: 'task-3' }),
    json({ task_status: 'SUCCEED' }),
  ])
  try {
    await assert.rejects(() => run({ asyncMode: 'auto' }), /finished without an image \(task task-3\)/)
  } finally {
    stub.restore()
  }
});

test('editFormat=generations sends references on the generation endpoint', async () => {
  const stub = stubFetch([
    json({ task_status: 'SUCCEED', output_images: ['https://cdn.test/four.png'] }),
    () => new Response(Buffer.from(PIXEL, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }),
  ])
  try {
    const images = await run({
      asyncMode: 'auto',
      editFormat: 'generations',
      references: [`data:image/png;base64,${PIXEL}`],
    })
    assert.equal(images.length, 1)
    assert.match(stub.calls[0].url, /\/images\/generations$/, 'never /images/edits')
    const body = JSON.parse(stub.calls[0].init.body)
    assert.deepEqual(body.image_url, [`data:image/png;base64,${PIXEL}`])
  } finally {
    stub.restore()
  }
});
