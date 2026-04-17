import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStats, computeRate, map2obj } from '../src/utils.ts'

/** Minimal RTCStatsReport-like map (values + get + forEach for map2obj) */
function mockStatsMap (reports: Record<string, any>) {
  const m = new Map(Object.entries(reports))
  return {
    values: () => m.values(),
    get: (id: string) => m.get(id),
    forEach: (fn: (v: any, k: any) => void) => m.forEach(fn)
  }
}

test('computeRate: byte delta per second', () => {
  const prev = { timestamp: 1000, bytesReceived: 100 }
  const next = { timestamp: 2000, bytesReceived: 600 }
  assert.equal(computeRate(next as any, prev as any, 'bytesReceived'), 500)
})

test('computeRate: null when timestamps identical (no NaN)', () => {
  const prev = { timestamp: 1000, bytesReceived: 100 }
  const next = { timestamp: 1000, bytesReceived: 200 }
  assert.equal(computeRate(next as any, prev as any, 'bytesReceived'), null)
})

test('map2obj: Map to plain object', () => {
  const m = new Map<string, number>([['k', 1]])
  assert.equal((map2obj(m) as any).k, 1)
})

test('parseStats: inbound audio row + codec merge', () => {
  const inbound = {
    id: 'in-audio',
    type: 'inbound-rtp',
    timestamp: 5000,
    kind: 'audio',
    bytesReceived: 100,
    packetsReceived: 1,
    codecId: 'codec1'
  }
  const codec = {
    id: 'codec1',
    type: 'codec',
    clockRate: 48000,
    mimeType: 'audio/opus',
    payloadType: 111
  }
  const stats = mockStatsMap({ 'in-audio': inbound, codec1: codec })
  const out = parseStats(stats, null)
  assert.equal(out!.audio.inbound.length, 1)
  assert.equal(out!.audio.inbound[0].mimeType, 'audio/opus')
})

test('parseStats: bitrate on second sample (local + remote)', () => {
  const base = {
    id: 'r1',
    type: 'inbound-rtp',
    kind: 'audio',
    bytesReceived: 1000,
    packetsReceived: 10
  }
  const remoteBase = {
    id: 'r2',
    type: 'remote-inbound-rtp',
    kind: 'audio',
    bytesReceived: 100,
    packetsReceived: 1
  }
  const map1 = mockStatsMap({
    r1: { ...base, timestamp: 1000 },
    r2: { ...remoteBase, timestamp: 1000 }
  })
  const first = parseStats(map1, null, { remote: true })

  const map2 = mockStatsMap({
    r1: { ...base, timestamp: 2000, bytesReceived: 5000, packetsReceived: 50 },
    r2: { ...remoteBase, timestamp: 2000, bytesReceived: 500, packetsReceived: 5 }
  })
  const second = parseStats(map2, first, { remote: true })

  const localBr = second!.audio.inbound[0].bitrate
  assert.ok(typeof localBr === 'number' && localBr > 0, 'local inbound bitrate')

  const remoteBr = second!.remote!.audio.inbound[0].bitrate
  assert.ok(typeof remoteBr === 'number' && remoteBr > 0, 'remote inbound bitrate')
})
