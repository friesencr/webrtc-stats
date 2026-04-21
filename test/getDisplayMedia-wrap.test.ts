/**
 * Mirrors the getUserMedia wrap tests for getDisplayMedia (screen share).
 * Same invariants: single wrap per page, native invoked once, destroy order irrelevant,
 * restore native only when the last subscriber is destroyed, and an external wrapper
 * installed on top of ours is preserved on destroy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

type GDM = (constraints?: any) => Promise<MediaStream>

function installBrowserMocks () {
  const g = globalThis as Record<string, unknown>
  const priorWindow = g.window
  const priorNavigator = g.navigator

  const mediaDevices: { getDisplayMedia: GDM, getUserMedia?: any } = {
    getDisplayMedia: null as unknown as GDM
  }

  let nativeInvocations = 0
  const nativeImpl: GDM = function (this: unknown, _constraints?: any) {
    nativeInvocations++
    return Promise.resolve({ getTracks: () => [] } as MediaStream)
  }
  mediaDevices.getDisplayMedia = nativeImpl.bind(mediaDevices) as GDM
  const initialGetDisplayMedia = mediaDevices.getDisplayMedia

  g.window = g
  g.navigator = { mediaDevices }

  return {
    mediaDevices,
    initialGetDisplayMedia,
    get nativeInvocations () { return nativeInvocations },
    resetCounter () { nativeInvocations = 0 },
    restore () {
      if (priorWindow !== undefined) g.window = priorWindow
      else delete g.window
      if (priorNavigator !== undefined) g.navigator = priorNavigator
      else delete g.navigator
    }
  }
}

async function loadWebRTCStats () {
  // Cache-bust so module-level state resets per test.
  const mod = await import('../src/index.ts?t=' + Math.random())
  return mod.WebRTCStats
}

test('getDisplayMedia: two instances share a single wrap', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })
    const wrapperAfterFirst = (globalThis.navigator.mediaDevices as any).getDisplayMedia
    const s2 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })

    assert.strictEqual(
      (globalThis.navigator.mediaDevices as any).getDisplayMedia,
      wrapperAfterFirst,
      'second instance must NOT replace the wrapper (single wrap)'
    )

    await (globalThis.navigator.mediaDevices as any).getDisplayMedia({ video: true })
    assert.equal(env.nativeInvocations, 1, 'native getDisplayMedia invoked once per call')

    s1.destroy()
    s2.destroy()
    assert.strictEqual(
      (globalThis.navigator.mediaDevices as any).getDisplayMedia,
      env.initialGetDisplayMedia,
      'native restored after all instances destroyed'
    )
  } finally {
    env.restore()
  }
})

test('getDisplayMedia: all subscribed instances receive timeline events', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })
    const s2 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })

    let s1Events = 0
    let s2Events = 0
    s1.on('timeline', (ev: any) => { if (ev.tag === 'getDisplayMedia') s1Events++ })
    s2.on('timeline', (ev: any) => { if (ev.tag === 'getDisplayMedia') s2Events++ })

    await (globalThis.navigator.mediaDevices as any).getDisplayMedia({ video: true })

    assert.equal(s1Events, 2, 'first instance observes request + stream')
    assert.equal(s2Events, 2, 'second instance observes request + stream')
    assert.equal(env.nativeInvocations, 1)

    s1.destroy()
    s2.destroy()
  } finally {
    env.restore()
  }
})

test('getDisplayMedia: destroy order does not matter (no LIFO requirement)', async () => {
  const env = installBrowserMocks()
  try {
    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })
    const s2 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })

    s1.destroy()
    env.resetCounter()
    await (globalThis.navigator.mediaDevices as any).getDisplayMedia({ video: true })
    assert.equal(env.nativeInvocations, 1)

    s2.destroy()
    assert.strictEqual(
      (globalThis.navigator.mediaDevices as any).getDisplayMedia,
      env.initialGetDisplayMedia
    )
  } finally {
    env.restore()
  }
})

test('getDisplayMedia: error path fans out and propagates rejection', async () => {
  const env = installBrowserMocks()
  try {
    // Replace native with a rejecting impl.
    const err = new Error('denied')
    ;(globalThis.navigator.mediaDevices as any).getDisplayMedia = function () {
      return Promise.reject(err)
    }

    const WebRTCStats = await loadWebRTCStats()
    const s1 = new WebRTCStats({ wrapGetDisplayMedia: true, getStatsInterval: 60_000 })
    let errorEvents = 0
    s1.on('timeline', (ev: any) => {
      if (ev.tag === 'getDisplayMedia' && ev.data && ev.data.error) errorEvents++
    })

    await assert.rejects(
      (globalThis.navigator.mediaDevices as any).getDisplayMedia({ video: true }),
      /denied/
    )
    assert.equal(errorEvents, 1, 'error subscriber fires exactly once')

    s1.destroy()
  } finally {
    env.restore()
  }
})
