/**
 * Validates getUserMedia wrapping when multiple WebRTCStats instances exist (SPA / re-init).
 *
 * Regression: a module-level "original" ref was overwritten on each init, which caused
 * infinite recursion (RangeError: Maximum call stack size exceeded) once more than one
 * WebRTCStats wrapped gUM on the same page.
 *
 * New contract (single-wrap + subscriber registry):
 *   - gUM is wrapped at most once per page, no matter how many WebRTCStats instances exist.
 *   - Each instance subscribes to receive timeline events for every gUM call.
 *   - Native gUM is invoked exactly once per call.
 *   - Only when the LAST subscribing instance is destroyed is native gUM restored.
 *   - Destroy order does not matter (no LIFO requirement).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

type GUM = typeof navigator.mediaDevices.getUserMedia

function installBrowserMocks () {
  const g = globalThis as Record<string, unknown>
  const priorWindow = g.window
  const priorNavigator = g.navigator

  const mediaDevices: { getUserMedia: GUM } = { getUserMedia: null as unknown as GUM }

  let nativeInvocations = 0
  const nativeImpl: GUM = function (this: unknown, _constraints: MediaStreamConstraints) {
    nativeInvocations++
    return Promise.resolve({
      getTracks: () => []
    } as MediaStream)
  }
  mediaDevices.getUserMedia = nativeImpl.bind(mediaDevices) as GUM
  const initialGetUserMedia = mediaDevices.getUserMedia

  g.window = g
  g.navigator = { mediaDevices }

  return {
    mediaDevices,
    initialGetUserMedia,
    get nativeInvocations () {
      return nativeInvocations
    },
    resetCounter () {
      nativeInvocations = 0
    },
    restore () {
      if (priorWindow !== undefined) g.window = priorWindow
      else delete g.window
      if (priorNavigator !== undefined) g.navigator = priorNavigator
      else delete g.navigator
    }
  }
}

async function loadWebRTCStats () {
  // Import with a cache-busting query so each test gets its own module-level state
  // (installed wrapper / previous / subscribers are module-scoped by design).
  const mod = await import('../src/index.ts?t=' + Math.random())
  return mod.WebRTCStats
}

test('getUserMedia: two instances share a single wrap (no recursion, native called once)', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })
    const wrapperAfterFirst = globalThis.navigator.mediaDevices.getUserMedia
    const s2 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })

    assert.strictEqual(
      globalThis.navigator.mediaDevices.getUserMedia,
      wrapperAfterFirst,
      'second instance must NOT replace the wrapper (single wrap)'
    )

    await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
    assert.equal(env.nativeInvocations, 1, 'native getUserMedia is invoked once per call')

    s1.destroy()
    s2.destroy()
    assert.strictEqual(
      globalThis.navigator.mediaDevices.getUserMedia,
      env.initialGetUserMedia,
      'after all subscribers destroyed, native is restored'
    )
  } finally {
    env.restore()
  }
})

test('getUserMedia: wrapper stays installed until the LAST subscriber is destroyed', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })
    const s2 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })
    const s3 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })

    const wrapperRef = globalThis.navigator.mediaDevices.getUserMedia

    s2.destroy()
    assert.strictEqual(globalThis.navigator.mediaDevices.getUserMedia, wrapperRef)
    s1.destroy()
    assert.strictEqual(globalThis.navigator.mediaDevices.getUserMedia, wrapperRef)

    env.resetCounter()
    await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
    assert.equal(env.nativeInvocations, 1, 'wrapper remains functional while any subscriber is alive')

    s3.destroy()
    assert.strictEqual(
      globalThis.navigator.mediaDevices.getUserMedia,
      env.initialGetUserMedia,
      'destroying the last subscriber restores native gUM'
    )
  } finally {
    env.restore()
  }
})

test('getUserMedia: destroy order does not matter (no LIFO requirement)', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })
    const s2 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })

    s1.destroy()
    env.resetCounter()
    await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
    assert.equal(env.nativeInvocations, 1, 'still works after first instance destroyed')

    s2.destroy()
    assert.strictEqual(
      globalThis.navigator.mediaDevices.getUserMedia,
      env.initialGetUserMedia,
      'native restored after last instance destroyed'
    )
  } finally {
    env.restore()
  }
})

test('getUserMedia: subscriber callbacks fire for every instance on a single gUM call', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })
    const s2 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })

    let s1Events = 0
    let s2Events = 0
    s1.on('timeline', (ev: any) => { if (ev.tag === 'getUserMedia') s1Events++ })
    s2.on('timeline', (ev: any) => { if (ev.tag === 'getUserMedia') s2Events++ })

    await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })

    // One "constraints" event + one "stream" event per instance
    assert.equal(s1Events, 2, 'first instance observes request + stream')
    assert.equal(s2Events, 2, 'second instance observes request + stream')
    assert.equal(env.nativeInvocations, 1, 'native gUM still invoked exactly once')

    s1.destroy()
    s2.destroy()
  } finally {
    env.restore()
  }
})

test('getUserMedia: creating N instances does not deepen the wrap', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const instances = Array.from({ length: 5 }, () => new WebRTCStats({
      wrapGetUserMedia: true,
      getStatsInterval: 60_000
    }))

    env.resetCounter()
    await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
    assert.equal(env.nativeInvocations, 1, 'native called once regardless of instance count')

    instances.forEach((s) => s.destroy())
    assert.strictEqual(
      globalThis.navigator.mediaDevices.getUserMedia,
      env.initialGetUserMedia,
      'native restored after all instances destroyed'
    )
  } finally {
    env.restore()
  }
})

test('getUserMedia: external wrapper installed AFTER us is preserved on destroy', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetUserMedia: true, getStatsInterval: 60_000 })

    const ourWrapper = globalThis.navigator.mediaDevices.getUserMedia
    let thirdPartyInvocations = 0
    const thirdPartyWrapper: GUM = function (this: unknown, constraints: MediaStreamConstraints) {
      thirdPartyInvocations++
      return ourWrapper.call(globalThis.navigator.mediaDevices, constraints)
    }
    globalThis.navigator.mediaDevices.getUserMedia = thirdPartyWrapper.bind(globalThis.navigator.mediaDevices) as GUM
    const afterExternal = globalThis.navigator.mediaDevices.getUserMedia

    s1.destroy()
    assert.strictEqual(
      globalThis.navigator.mediaDevices.getUserMedia,
      afterExternal,
      'must not remove a wrapper installed on top of ours'
    )

    env.resetCounter()
    await globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
    assert.equal(thirdPartyInvocations, 1, 'third-party wrapper still runs')
    assert.equal(env.nativeInvocations, 1, 'native still runs through pass-through')
  } finally {
    env.restore()
  }
})
