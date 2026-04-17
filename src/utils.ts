import {StatsObject, CodecInfo, TrackReport, ParseStatsOptions} from './types/index'

/**
 * A set of methods used to parse the rtc stats
 */

/** Inbound/outbound RTP rows: add bitrate + packetRate from delta vs previous sample */
function addDerivedRatesForMedia (
  current: StatsObject['audio'],
  previous: StatsObject['audio']
): void {
  current.inbound.forEach((report) => {
    const prev = previous.inbound.find(r => r.id === report.id)
    report.bitrate = computeBitrate(report, prev, 'bytesReceived')
    report.packetRate = computeBitrate(report, prev, 'packetsReceived')
  })
  current.outbound.forEach((report) => {
    const prev = previous.outbound.find(r => r.id === report.id)
    report.bitrate = computeBitrate(report, prev, 'bytesSent')
    report.packetRate = computeBitrate(report, prev, 'packetsSent')
  })
}

function addAdditionalData (currentStats: StatsObject, previousStats?: StatsObject) {
  if (!previousStats) return currentStats

  addDerivedRatesForMedia(currentStats.audio, previousStats.audio)
  addDerivedRatesForMedia(currentStats.video, previousStats.video)

  if (currentStats.remote && previousStats.remote) {
    addDerivedRatesForMedia(currentStats.remote.audio, previousStats.remote.audio)
    addDerivedRatesForMedia(currentStats.remote.video, previousStats.remote.video)
  }

  return currentStats
}

function getCandidatePairInfo (candidatePair, stats) {
  if (!candidatePair || !stats) return {}

  const connection = {...candidatePair}

  if (connection.localCandidateId) {
    const localCandidate = stats.get(connection.localCandidateId)
    connection.local = {...localCandidate}
  }

  if (connection.remoteCandidateId) {
    const remoteCandidate = stats.get(connection.remoteCandidateId)
    connection.remote = {...remoteCandidate}
  }

  return connection
}

// Takes two stats reports and determines the rate based on two counter readings
// and the time between them (which is in units of milliseconds).
export function computeRate (newReport: TrackReport, oldReport: TrackReport, statName: string): number | null {
  if (!oldReport) return null
  const newVal = newReport[statName]
  const oldVal = oldReport[statName]
  if (newVal == null || oldVal == null) return null
  const n = Number(newVal)
  const o = Number(oldVal)
  if (Number.isNaN(n) || Number.isNaN(o)) return null
  const dt = newReport.timestamp - oldReport.timestamp
  // Same timestamp (common for some remote-* reports) → avoid 0/0 → NaN
  if (!(dt > 0)) return null
  return ((n - o) / dt) * 1000
}

// Convert a byte rate to a bit rate.
export function computeBitrate (newReport: TrackReport, oldReport: TrackReport, statName: string): number | null {
  const rate = computeRate(newReport, oldReport, statName)
  if (rate == null) return null
  return rate * 8
}

export function map2obj (stats: any) {
  if (!stats.entries) {
    return stats
  }
  const o = {}
  stats.forEach(function (v, k) {
    o[k] = v
  })
  return o
}

// Enumerates the new standard compliant stats using local and remote track ids.
export function parseStats (stats: any, previousStats: StatsObject | null, options: ParseStatsOptions | null = {}): StatsObject {
  // Create an object structure with all the needed stats and types that we care
  // about. This allows to map the getStats stats to other stats names.

  if (!stats) return null

  /**
   * The starting object where we will save the details from the stats report
   * @type {Object}
   */
  let statsObject = {
    audio: {
      inbound: [],
      outbound: []
    },
    video: {
      inbound: [],
      outbound: []
    },
    connection: {
      inbound: [],
      outbound: []
    }
  } as StatsObject

  // if we want to collect remote data also
  if (options.remote) {
    statsObject.remote = {
      audio:{
        inbound: [],
        outbound: []
      },
      video:{
        inbound: [],
        outbound: []
      }
    }
  }

  for (const report of stats.values()) {
    switch (report.type) {
      case 'outbound-rtp': {
        let outbound = {}
        const mediaType = report.mediaType || report.kind
        const codecInfo = {} as CodecInfo
        let trackData = {}
        if (!['audio', 'video'].includes(mediaType)) continue

        if (report.codecId) {
          const codec = stats.get(report.codecId)
          if (codec) {
            codecInfo.clockRate = codec.clockRate
            codecInfo.mimeType = codec.mimeType
            codecInfo.payloadType = codec.payloadType
          }
        }

        trackData = stats.get(report.mediaSourceId) || stats.get(report.trackId) || {}

        statsObject[mediaType].outbound.push({...report, ...codecInfo, track: {...trackData}})
        break
      }
      case 'inbound-rtp': {
        let inbound = {}
        let mediaType = report.mediaType || report.kind
        let trackData = {}
        const codecInfo = {} as CodecInfo

        // Safari is missing mediaType and kind for 'inbound-rtp'
        if (!['audio', 'video'].includes(mediaType)) {
          if (report.id.includes('Video')) mediaType = 'video'
          else if (report.id.includes('Audio')) mediaType = 'audio'
          else continue
        }

        if (report.codecId) {
          const codec = stats.get(report.codecId)
          if (codec) {
            codecInfo.clockRate = codec.clockRate
            codecInfo.mimeType = codec.mimeType
            codecInfo.payloadType = codec.payloadType
          }
        }

        // if we don't have connection details already saved
        // and the transportId is present (most likely chrome)
        // get the details from the candidate-pair
        if (!statsObject.connection.id && report.transportId) {
          const transport = stats.get(report.transportId)
          if (transport && transport.selectedCandidatePairId) {
            const candidatePair = stats.get(transport.selectedCandidatePairId)
            statsObject.connection = getCandidatePairInfo(candidatePair, stats)
          }
        }

        trackData = stats.get(report.mediaSourceId) || stats.get(report.trackId) || {}

        statsObject[mediaType].inbound.push({...report, ...codecInfo, track: {...trackData}})
        break
      }
      case 'peer-connection': {
        statsObject.connection.dataChannelsClosed = report.dataChannelsClosed
        statsObject.connection.dataChannelsOpened = report.dataChannelsOpened
        break
      }
      case 'remote-inbound-rtp': {
        if(!options.remote) break
        let inbound = {}
        let mediaType = report.mediaType || report.kind
        const codecInfo = {} as CodecInfo

        // Safari is missing mediaType and kind for 'inbound-rtp'
        if (!['audio', 'video'].includes(mediaType)) {
          if (report.id.includes('Video')) mediaType = 'video'
          else if (report.id.includes('Audio')) mediaType = 'audio'
          else continue
        }

        if (report.codecId) {
          const codec = stats.get(report.codecId)
          if (codec) {
            codecInfo.clockRate = codec.clockRate
            codecInfo.mimeType = codec.mimeType
            codecInfo.payloadType = codec.payloadType
          }
        }

        // if we don't have connection details already saved
        // and the transportId is present (most likely chrome)
        // get the details from the candidate-pair
        if (!statsObject.connection.id && report.transportId) {
          const transport = stats.get(report.transportId)
          if (transport && transport.selectedCandidatePairId) {
            const candidatePair = stats.get(transport.selectedCandidatePairId)
            statsObject.connection = getCandidatePairInfo(candidatePair, stats)
          }
        }

        statsObject.remote[mediaType].inbound.push({...report, ...codecInfo})
        break
      }
      case 'remote-outbound-rtp': {
        if(!options.remote) break
        let outbound = {}
        const mediaType = report.mediaType || report.kind
        const codecInfo = {} as CodecInfo
        if (!['audio', 'video'].includes(mediaType)) continue

        if (report.codecId) {
          const codec = stats.get(report.codecId)
          if (codec) {
            codecInfo.clockRate = codec.clockRate
            codecInfo.mimeType = codec.mimeType
            codecInfo.payloadType = codec.payloadType
          }
        }

        statsObject.remote[mediaType].outbound.push({...report, ...codecInfo})
        break
      }
      default:
    }
  }

  // if we didn't find a candidate-pair while going through inbound-rtp
  // look for it again
  if (!statsObject.connection.id) {
    for (const report of stats.values()) {
      // select the current active candidate-pair report
      if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
        statsObject.connection = getCandidatePairInfo(report, stats)
      }
    }
  }

  statsObject = addAdditionalData(statsObject, previousStats)

  return statsObject
}
