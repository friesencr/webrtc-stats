import {EventEmitter} from 'events'
import {v4 as uuid} from 'uuid'

import type {
  WebRTCStatsConstructorOptions,
  AddConnectionOptions,
  AddConnectionResponse,
  MonitoredPeersObject,
  RemoveConnectionOptions,
  RemoveConnectionReturn,
  TimelineEvent,
  StatsEvent,
  TimelineTag,
  GetUserMediaResponse, MonitorPeerOptions, ParseStatsOptions, LogLevel
} from './types/index'

import {parseStats, map2obj} from './utils'

// used to keep track of events listeners. useful when we want to remove them
let eventListeners = {}

// tracks that have been obtained from calling getUsermedia
let localTracks = []

/**
 * Shared state for wrapping `navigator.mediaDevices.getUserMedia`.
 *
 * We only ever replace `getUserMedia` once per page. If another WebRTCStats is created
 * later, it just subscribes to the wrapper that's already there.
 *
 * Why: in the past, each new WebRTCStats would wrap `getUserMedia` again and save its
 * own "original" pointer. A second instance would save the first wrapper as the
 * "original", and the first wrapper would end up calling itself — infinite recursion
 * ("Maximum call stack size exceeded"). This happened in apps that recreate
 * WebRTCStats per call/session without reloading the page.
 */
type GetUserMediaFn = typeof navigator.mediaDevices.getUserMedia
type GumSubscriber = (info: { constraints?: MediaStreamConstraints, stream?: MediaStream, error?: Error }) => void

const GUM_WRAP_MARKER = '__webrtcStatsGumWrapped__'
let gumInstalledWrapper: GetUserMediaFn | null = null
let gumPreviousImpl: GetUserMediaFn | null = null
const gumSubscribers: Set<GumSubscriber> = new Set()

/**
 * Shared state for wrapping `navigator.mediaDevices.getDisplayMedia` (screen share).
 * Same contract as the getUserMedia wrap: at most one wrapper per page, instances
 * subscribe, and native is restored only when the last subscriber is destroyed.
 */
type GetDisplayMediaFn = (constraints?: any) => Promise<MediaStream>
type GdmSubscriber = (info: { constraints?: any, stream?: MediaStream, error?: Error }) => void

const GDM_WRAP_MARKER = '__webrtcStatsGdmWrapped__'
let gdmInstalledWrapper: GetDisplayMediaFn | null = null
let gdmPreviousImpl: GetDisplayMediaFn | null = null
const gdmSubscribers: Set<GdmSubscriber> = new Set()

export class WebRTCStats extends EventEmitter {
  private readonly isEdge: boolean
  private _getStatsInterval: number
  private monitoringSetInterval: number = 0
  private connectionMonitoringSetInterval: number = 0
  private connectionMonitoringInterval: number = 1000
  private readonly rawStats: boolean
  private readonly statsObject: boolean
  private readonly filteredStats: boolean
  private readonly shouldWrapGetUserMedia: boolean
  private readonly shouldWrapGetDisplayMedia: boolean
  /** The `getUserMedia` subscriber this instance registered (if `wrapGetUserMedia: true`). */
  private gumSubscriber: GumSubscriber | null = null
  /** The `getDisplayMedia` subscriber this instance registered (if `wrapGetDisplayMedia: true`). */
  private gdmSubscriber: GdmSubscriber | null = null
  private debug: any
  private readonly remote: boolean = true
  private peersToMonitor: MonitoredPeersObject = {}
  private logLevel: LogLevel

  /**
   * Used to keep track of all the events
   */
  private timeline: TimelineEvent[] = []

  /**
   * A list of stats to look after
   */
  private statsToMonitor: string[] = [
    'inbound-rtp',
    'outbound-rtp',
    'remote-inbound-rtp',
    'remote-outbound-rtp',
    'peer-connection',
    'data-channel',
    'stream',
    'track',
    'sender',
    'receiver',
    'transport',
    'candidate-pair',
    'local-candidate',
    'remote-candidate'
  ]

  constructor (constructorOptions: WebRTCStatsConstructorOptions) {
    super()

    // only works in the browser
    if (typeof window === 'undefined') {
      throw new Error('WebRTCStats only works in browser')
    }

    const options = {...constructorOptions}

    this.isEdge = !!(window as unknown as { RTCIceGatherer?: unknown }).RTCIceGatherer

    this.getStatsInterval = options.getStatsInterval || 1000
    this.rawStats = !!options.rawStats
    this.statsObject = !!options.statsObject
    this.filteredStats = !!options.filteredStats

    this.shouldWrapGetUserMedia = !!options.wrapGetUserMedia
    this.shouldWrapGetDisplayMedia = !!options.wrapGetDisplayMedia

    if (typeof options.remote === 'boolean') {
      this.remote = options.remote
    }

    // If we want to enable debug
    this.debug = !!options.debug
    this.logLevel = options.logLevel || "none"

    if (this.shouldWrapGetUserMedia) {
      this.wrapGetUserMedia()
    }

    if (this.shouldWrapGetDisplayMedia) {
      this.wrapGetDisplayMedia()
    }
  }

  public async addPeer (peerId: string, pc: RTCPeerConnection): Promise<AddConnectionResponse> {
    console.warn('The addPeer() method has been deprecated, please use addConnection()')
    return this.addConnection({
      peerId,
      pc
    })
  }

  /**
   * Start tracking a RTCPeerConnection
   * @param {Object} options The options object
   */
  public async addConnection (options: AddConnectionOptions): Promise<AddConnectionResponse> {
    const {pc, peerId} = options
    let {connectionId, remote} = options

    remote = typeof remote === 'boolean' ? remote : this.remote

    if (!pc || !(pc instanceof RTCPeerConnection)) {
      throw new Error(`Missing argument 'pc' or is not of instance RTCPeerConnection`)
    }

    if (!peerId) {
      throw new Error('Missing argument peerId')
    }

    if (this.isEdge) {
      throw new Error('Can\'t monitor peers in Edge at this time.')
    }

    // if we are already monitoring this peerId, check if the user sent the same connection twice
    if (this.peersToMonitor[peerId]) {
      // if the user sent a connectionId
      if (connectionId && connectionId in this.peersToMonitor[peerId]) {
        throw new Error(`We are already monitoring connection with id ${connectionId}.`)
      } else {
        for (let id in this.peersToMonitor[peerId]) {
          const peerConnection = this.peersToMonitor[peerId][id]
          if (peerConnection.pc === pc) {
            throw new Error(`We are already monitoring peer with id ${peerId}.`)
          }

          // remove an connection if it's already closed.
          if(peerConnection.pc.connectionState === 'closed') {
            this.removeConnection({pc: peerConnection.pc})
          }
        }
      }
    }

    const config = pc.getConfiguration()

    // don't log credentials
    if (config.iceServers) {
      config.iceServers.forEach(function (server) {
        delete server.credential
      })
    }

    // if the user didn't send a connectionId, we should generate one
    if (!connectionId) {
      connectionId = uuid()
    }

    this.emitEvent({
      event: 'addConnection',
      tag: 'peer',
      peerId,
      connectionId,
      data: {
        options: options,
        peerConfiguration: config
      }
    })

    this.monitorPeer({
      peerId,
      connectionId,
      pc,
      remote
    })

    return {
      connectionId
    }
  }

  /**
   * Returns the timeline of events
   * If a tag is it will filter out events based on it
   * @param  {String} tag The tag to filter events (optional)
   * @return {Array}     The timeline array (or sub array if tag is defined)
   */
  public getTimeline (tag: TimelineTag): TimelineEvent[] {
    // sort the events by timestamp
    this.timeline = this.timeline.sort(
      (event1, event2) => event1.timestamp.getTime() - event2.timestamp.getTime()
    )

    if (tag) {
      return this.timeline.filter((event) => event.tag === tag)
    }

    return this.timeline
  }

  public get logger () {
    const canLog = (requestLevel: LogLevel) => {
      const allLevels: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug']
      return allLevels.slice(0, allLevels.indexOf(this.logLevel) + 1).indexOf(requestLevel) > -1
    }

    return {
      error (...msg) {
        if (this.debug && canLog('error'))
          console.error(`[webrtc-stats][error] `, ...msg)
      },
      warn (...msg) {
        if (this.debug && canLog('warn'))
          console.warn(`[webrtc-stats][warn] `, ...msg)
      },
      info (...msg) {
        if (this.debug && canLog('info'))
          console.log(`[webrtc-stats][info] `, ...msg)
      },
      debug (...msg) {
        if (this.debug && canLog('debug'))
          console.debug(`[webrtc-stats][debug] `, ...msg)
      }
    }
  }

  /**
   * Removes a connection from the list of connections to watch
   * @param {RemoveConnectionOptions} options The options object for this method
   */
  public removeConnection (options: RemoveConnectionOptions): RemoveConnectionReturn {
    let {connectionId, pc} = options

    let peerId

    if (!pc && !connectionId) {
      throw new Error('Missing arguments. You need to either send pc or a connectionId.')
    }

    // if the user sent a connectionId
    if (connectionId) {
      if (typeof connectionId !== 'string') {
        throw new Error('connectionId must be a string.')
      }

      for (let pId in this.peersToMonitor) {
        if (connectionId in this.peersToMonitor[pId]) {
          pc = this.peersToMonitor[pId][connectionId].pc
          peerId = pId
        }
      }

    // else, if the user sent a pc
    } else if (pc) {
      if (!(pc instanceof RTCPeerConnection)) {
        throw new Error('pc must be an instance of RTCPeerConnection.')
      }

      // loop through all the peers
      for (let pId in this.peersToMonitor) {
        // loop through all the connections
        for (let cId in this.peersToMonitor[pId]) {
          // until we find the one we're searching for
          if (this.peersToMonitor[pId][cId].pc === pc) {
            connectionId = cId
            peerId = pId
          }
        }
      }
    }

    if (!pc || !connectionId) {
      throw new Error('Could not find the desired connection.')
    }

    // remove listeners
    this.removePeerConnectionEventListeners(connectionId, pc)
    // delete it
    delete this.peersToMonitor[peerId][connectionId]

    // check if the user has no more connections
    if (Object.values(this.peersToMonitor[peerId]).length === 0) {
      delete this.peersToMonitor[peerId]
    }

    return {
      connectionId
    }
  }

  /**
   * Used to stop listeners on all connections and remove all other event listeners
   */
  public removeAllPeers() {
    for (let peerId in this.peersToMonitor) {
      this.removePeer(peerId)
    }
  }

  /**
   * Removes all the connection for a peer
   * @param {string} id The peer id
   */
  public removePeer (id: string) {
    this.logger.info(`Removing PeerConnection with id ${id}.`)
    if (!this.peersToMonitor[id]) return

    for (let connectionId in this.peersToMonitor[id]) {
      let pc = this.peersToMonitor[id][connectionId].pc

      this.removePeerConnectionEventListeners(connectionId, pc)
    }

    // remove from peersToMonitor
    delete this.peersToMonitor[id]
  }

  /**
   * Clears the timeline of events
   */
  public clearTimeline (): void {
    this.timeline = []
  }

  /**
   * Used to remove all event listeners and reset the state of the lib
   */
  public destroy () {
    // remove all peer connection event listeners
    this.removeAllPeers()

    localTracks.forEach((track) => {
      this.removeTrackEventListeners(track)
    })

    localTracks = []

    if (this.gumSubscriber) {
      this.unwrapGetUserMedia()
    }

    if (this.gdmSubscriber) {
      this.unwrapGetDisplayMedia()
    }

    // clear the timeline
    this.clearTimeline()
  }

  /**
   * Used to add to the list of peers to get stats for
   * @param  {string} peerId
   * @param  {RTCPeerConnection} pc
   * @param {MonitorPeerOptions} options
   */
  private monitorPeer (options: MonitorPeerOptions): void {
    let {peerId, connectionId, pc, remote} = options

    if (!pc) {
      this.logger.warn('Did not receive pc argument when calling monitorPeer()')
      return
    }

    const monitorPeerObject = {
      pc: pc,
      connectionId,
      stream: null,
      stats: {
        // keep a reference of the current stat
        parsed: null,
        raw: null
      },
      options: {
        remote
      }
    }

    if (this.peersToMonitor[peerId]) {
      // if we are already watching this connectionId
      if (connectionId in this.peersToMonitor[peerId]) {
        this.logger.warn(`Already watching connection with ID ${connectionId}`)
        return
      }

      this.peersToMonitor[peerId][connectionId] = monitorPeerObject
    } else {
      this.peersToMonitor[peerId] = {[connectionId]: monitorPeerObject}
    }

    this.addPeerConnectionEventListeners(peerId, connectionId, pc)

    // start monitoring from the first peer added
    if (this.numberOfMonitoredPeers === 1) {
      this.startStatsMonitoring()
      this.startConnectionStateMonitoring()
    }
  }

  /**
   * Used to start the setTimeout and request getStats from the peers
   */
  private startStatsMonitoring (): void {
    if (this.monitoringSetInterval) return

    this.monitoringSetInterval = window.setInterval(() => {
      // if we ran out of peers to monitor
      if (!this.numberOfMonitoredPeers) {
        this.stopStatsMonitoring()
      }

      this.getStats() // get stats from all peer connections
        .then((statsEvents) => {
          statsEvents.forEach((statsEventObject) => {
            // add it to the timeline and also emit the stats event
            this.emitEvent(statsEventObject)
          })
        })
    }, this._getStatsInterval)
  }

  private stopStatsMonitoring (): void {
    if (this.monitoringSetInterval) {
      window.clearInterval(this.monitoringSetInterval)
      this.monitoringSetInterval = 0
    }
  }

  private async getStats (id: string = null): Promise<StatsEvent[]> {
    this.logger.info(id ? `Getting stats from peer ${id}` : `Getting stats from all peers`)
    let peersToAnalyse: MonitoredPeersObject = {}

    // if we want the stats for a specific peer
    if (id) {
      if (!this.peersToMonitor[id]) {
        throw new Error(`Cannot get stats. Peer with id ${id} does not exist`)
      }

      peersToAnalyse[id] = this.peersToMonitor[id]
    } else {
      // else, get stats for all of them
      peersToAnalyse = this.peersToMonitor
    }

    let statsEventList: StatsEvent[] = []

    for (const id in peersToAnalyse) {
      for (const connectionId in peersToAnalyse[id]) {
        const peerObject = peersToAnalyse[id][connectionId]
        const pc = peerObject.pc

        // if this connection is closed, continue
        if (!pc || this.checkIfConnectionIsClosed(id, connectionId, pc)) {
          continue
        }

        try {
          const before = this.getTimestamp()
          const prom = pc.getStats(null)
          if (prom) {
            // TODO modify the promise to yield responses over time
            const res = await prom
            const after = this.getTimestamp()

            // create an object from the RTCStats map
            const statsObject = map2obj(res)


            const parseStatsOptions: ParseStatsOptions = {remote: peerObject.options.remote}
            const parsedStats = parseStats(res, peerObject.stats.parsed, parseStatsOptions)

            const statsEventObject = {
              event: 'stats',
              tag: 'stats',
              peerId: id,
              connectionId: connectionId,
              timeTaken: after - before,
              data: parsedStats
            } as StatsEvent

            if (this.rawStats === true) {
              statsEventObject['rawStats'] = res
            }
            if (this.statsObject === true) {
              statsEventObject['statsObject'] = statsObject
            }
            if (this.filteredStats === true) {
              statsEventObject['filteredStats'] = this.filteroutStats(statsObject)
            }

            statsEventList.push(statsEventObject)

            peerObject.stats.parsed = parsedStats
            // peerObject.stats.raw = res

          } else {
            this.logger.error(`PeerConnection from peer ${id} did not return any stats data`)
          }
        } catch (e) {
          this.logger.error(e)
        }
      }
    }

    return statsEventList
  }

  private startConnectionStateMonitoring (): void {
    this.connectionMonitoringSetInterval = window.setInterval(() => {
      if (!this.numberOfMonitoredPeers) {
        this.stopConnectionStateMonitoring()
      }

      for (const id in this.peersToMonitor) {
        for (const connectionId in this.peersToMonitor[id]) {
          const pc = this.peersToMonitor[id][connectionId].pc

          this.checkIfConnectionIsClosed(id, connectionId, pc)
        }
      }
    }, this.connectionMonitoringInterval)
  }

  private checkIfConnectionIsClosed (peerId: string, connectionId: string, pc: RTCPeerConnection): boolean {
    const isClosed = this.isConnectionClosed(pc)

    if (isClosed) {
      this.removeConnection({pc})

      // event name should be deppending on what we detect as closed
      let event = pc.connectionState === 'closed' ? 'onconnectionstatechange' : 'oniceconnectionstatechange'
      this.emitEvent({
        event,
        peerId,
        connectionId,
        tag: 'connection',
        data: 'closed'
      })
    }

    return isClosed
  }

  private isConnectionClosed (pc: RTCPeerConnection): boolean {
    return pc.connectionState === 'closed' || pc.iceConnectionState === 'closed'
  }

  private stopConnectionStateMonitoring(): void {
    if (this.connectionMonitoringSetInterval) {
      window.clearInterval(this.connectionMonitoringSetInterval)
      this.connectionMonitoringSetInterval = 0
    }
  }

  private wrapGetUserMedia (): void {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.logger.warn(`'navigator.mediaDevices.getUserMedia' is not available in browser. Will not wrap getUserMedia.`)
      return
    }

    // Register this instance's subscriber — it will be called for every gUM invocation
    // while this instance is alive.
    const subscriber: GumSubscriber = this.parseGetUserMedia.bind(this)
    this.gumSubscriber = subscriber
    gumSubscribers.add(subscriber)

    // If another WebRTCStats already wrapped gUM on this page, just subscribe; do not wrap again.
    // This keeps the wrapper chain at depth 1 no matter how many instances coexist.
    const current = navigator.mediaDevices.getUserMedia as GetUserMediaFn & { [GUM_WRAP_MARKER]?: boolean }
    if (current && current[GUM_WRAP_MARKER]) {
      this.logger.info('getUserMedia already wrapped by WebRTCStats; subscribing this instance.')
      return
    }

    this.logger.info('Wrapping getUserMedia.')

    // Remember whatever was installed before us (native or another library's wrapper) so we
    // can restore it when the last subscriber is destroyed.
    gumPreviousImpl = navigator.mediaDevices.getUserMedia

    const previous = gumPreviousImpl
    const wrapped = function (this: MediaDevices, constraints: MediaStreamConstraints) {
      // Fan out the "request" event before delegating so consumers see constraints immediately.
      gumSubscribers.forEach((sub) => {
        try { sub({ constraints }) } catch (_e) { /* isolate subscriber errors */ }
      })

      return previous.apply(navigator.mediaDevices, [constraints])
        .then((stream) => {
          gumSubscribers.forEach((sub) => {
            try { sub({ stream }) } catch (_e) { /* isolate subscriber errors */ }
          })
          return stream
        }, (err) => {
          gumSubscribers.forEach((sub) => {
            try { sub({ error: err }) } catch (_e) { /* isolate subscriber errors */ }
          })
          return Promise.reject(err)
        })
    }

    const bound = wrapped.bind(navigator.mediaDevices) as GetUserMediaFn & { [GUM_WRAP_MARKER]?: boolean }
    bound[GUM_WRAP_MARKER] = true
    gumInstalledWrapper = bound
    navigator.mediaDevices.getUserMedia = bound
  }

  private unwrapGetUserMedia (): void {
    if (!this.gumSubscriber) return

    gumSubscribers.delete(this.gumSubscriber)
    this.gumSubscriber = null

    // Only restore when the last subscriber has been removed.
    if (gumSubscribers.size > 0) return
    if (!gumInstalledWrapper) return
    if (!navigator.mediaDevices) return

    if (navigator.mediaDevices.getUserMedia === gumInstalledWrapper) {
      navigator.mediaDevices.getUserMedia = gumPreviousImpl as GetUserMediaFn
    } else {
      // Another library wrapped on top of ours after we installed. Leave the outer wrapper
      // in place; removing it would break that library. Our subscriber set is empty, so our
      // wrapper is now a no-op pass-through.
      this.logger.warn(
        'getUserMedia was wrapped again after WebRTCStats installed; not restoring native. ' +
        'The outer wrapper remains; our wrapper now passes through to the previous implementation.'
      )
    }

    gumInstalledWrapper = null
    gumPreviousImpl = null
  }


  /**
   * Filter out some stats, mainly codec and certificate
   * @param  {Object} stats The parsed rtc stats object
   * @return {Object}       The new object with some keys deleted
   */
  private filteroutStats (stats = {}): object {
    const fullObject = {...stats}
    for (const key in fullObject) {
      var stat = fullObject[key]
      if (!this.statsToMonitor.includes(stat.type)) {
        delete fullObject[key]
      }
    }

    return fullObject
  }

  private get peerConnectionListeners () {
    return {
      icecandidate: (id, connectionId, pc, e) => {
        this.logger.debug('[pc-event] icecandidate | peerId: ${peerId}', e)

        this.emitEvent({
          event: 'onicecandidate',
          tag: 'connection',
          peerId: id,
          connectionId,
          data: e.candidate
        })
      },
      track: (id, connectionId, pc, e) => {
        this.logger.debug(`[pc-event] track | peerId: ${id}`, e)

        const track = e.track
        const stream = e.streams[0]

        // save the remote stream
        if (id in this.peersToMonitor && connectionId in this.peersToMonitor[id]) {
          this.peersToMonitor[id][connectionId].stream = stream
        }

        this.addTrackEventListeners(track, connectionId)
        this.emitEvent({
          event: 'ontrack',
          tag: 'track',
          peerId: id,
          connectionId,
          data: {
            stream: stream ? this.getStreamDetails(stream) : null,
            track: track ? this.getMediaTrackDetails(track) : null,
            title: e.track.kind + ':' + e.track.id + ' ' + e.streams.map(function (stream) {
              return 'stream:' + stream.id
            })
          }
        })
      },
      signalingstatechange: (id, connectionId, pc) => {
        this.logger.debug(`[pc-event] signalingstatechange | peerId: ${id}`)
        this.emitEvent({
          event: 'onsignalingstatechange',
          tag: 'connection',
          peerId: id,
          connectionId,
          data: {
            signalingState: pc.signalingState,
            localDescription: pc.localDescription,
            remoteDescription: pc.remoteDescription
          }
        })
      },
      iceconnectionstatechange: (id, connectionId, pc) => {
        this.logger.debug(`[pc-event] iceconnectionstatechange | peerId: ${id}`)
        this.emitEvent({
          event: 'oniceconnectionstatechange',
          tag: 'connection',
          peerId: id,
          connectionId,
          data: pc.iceConnectionState
        })
      },
      icegatheringstatechange: (id, connectionId, pc) => {
        this.logger.debug(`[pc-event] icegatheringstatechange | peerId: ${id}`)
        this.emitEvent({
          event: 'onicegatheringstatechange',
          tag: 'connection',
          peerId: id,
          connectionId,
          data: pc.iceGatheringState
        })
      },
      icecandidateerror: (id, connectionId, pc, ev) => {
        this.logger.debug(`[pc-event] icecandidateerror | peerId: ${id}`)
        this.emitEvent({
          event: 'onicecandidateerror',
          tag: 'connection',
          peerId: id,
          connectionId,
          error: {
            errorCode: ev.errorCode
          }
        })
      },
      connectionstatechange: (id, connectionId, pc) => {
        this.logger.debug(`[pc-event] connectionstatechange | peerId: ${id}`)
        this.emitEvent({
          event: 'onconnectionstatechange',
          tag: 'connection',
          peerId: id,
          connectionId,
          data: pc.connectionState
        })
      },
      negotiationneeded: (id, connectionId, pc) => {
        this.logger.debug(`[pc-event] negotiationneeded | peerId: ${id}`)
        this.emitEvent({
          event: 'onnegotiationneeded',
          tag: 'connection',
          peerId: id,
          connectionId
        })
      },
      datachannel: (id, connectionId, pc, event) => {
        this.logger.debug(`[pc-event] datachannel | peerId: ${id}`, event)
        this.emitEvent({
          event: 'ondatachannel',
          tag: 'datachannel',
          peerId: id,
          connectionId,
          data: event.channel
        })
      }
    }
  }

  private addPeerConnectionEventListeners (peerId: string, connectionId: string, pc: RTCPeerConnection): void {
    this.logger.debug(`Adding event listeners for peer ${peerId} and connection ${connectionId}.`)

    eventListeners[connectionId] = {}
    Object.keys(this.peerConnectionListeners).forEach(eventName => {
      eventListeners[connectionId][eventName] = this.peerConnectionListeners[eventName].bind(this, peerId, connectionId, pc)
      pc.addEventListener(eventName, eventListeners[connectionId][eventName], false)
    })
  }

  /**
   * Called when we get the stream from getUserMedia. We parse the stream and fire events
   * @param  {Object} options
   */
  private parseGetUserMedia (options: GetUserMediaResponse) {
    try {
      const obj = {
        event: 'getUserMedia',
        tag: 'getUserMedia',
        data: {...options}
      } as TimelineEvent

      // if we received the stream, get the details for the tracks
      if (options.stream) {
        obj.data.details = this.parseStream(options.stream)

        // add event listeners for local tracks as well
        options.stream.getTracks().map((track) => {
          this.addTrackEventListeners(track)
          localTracks.push(track)
        })
      }

      this.emitEvent(obj)
    } catch (e) {}
  }

  private parseStream (stream: MediaStream) {
    const result = {
      audio: [],
      video: []
    }

    const tracks = stream.getTracks()
    tracks.forEach((track) => {
      result[track.kind].push(this.getMediaTrackDetails(track))
    })

    return result
  }

  private getMediaTrackDetails (track: MediaStreamTrack) {
    return {
      enabled: track.enabled,
      id: track.id,
      // @ts-ignore
      contentHint: track.contentHint,
      kind: track.kind,
      label: track.label,
      muted: track.muted,
      readyState: track.readyState,
      constructorName: track.constructor.name,
      capabilities: track.getCapabilities ? track.getCapabilities() : {},
      constraints: track.getConstraints ? track.getConstraints() : {},
      settings: track.getSettings ? track.getSettings() : {},
      _track: track
    }
  }

  private getStreamDetails (stream: MediaStream) {
    return {
      active: stream.active,
      id: stream.id,
      _stream: stream
    }
  }

  private getTrackEventObject (connectionId?: string) {
    return {
      'mute': (ev) => {
        this.emitEvent({
          event: 'mute',
          tag: 'track',
          connectionId,
          data: {
            event: ev
          }
        })
      },
      'unmute': (ev) => {
        this.emitEvent({
          event: 'unmute',
          tag: 'track',
          connectionId,
          data: {
            event: ev
          }
        })
      },
      'overconstrained': (ev) => {
        this.emitEvent({
          event: 'overconstrained',
          tag: 'track',
          connectionId,
          data: {
            event: ev
          }
        })
      },
      'ended': (ev) => {
        this.emitEvent({
          event: 'ended',
          tag: 'track',
          connectionId,
          data: {
            event: ev
          }
        })

        // no need to listen for events on this track anymore
        this.removeTrackEventListeners(ev.target)
      }
    }
  }

  /**
   * Add event listeners for the tracks that are added to the stream
   * @param {MediaStreamTrack} track
   */
  private addTrackEventListeners (track: MediaStreamTrack, connectionId?: string) {
    eventListeners[track.id] = {}
    const events = this.getTrackEventObject(connectionId)
    Object.keys(events).forEach(eventName => {
      eventListeners[track.id][eventName] = events[eventName].bind(this)
      track.addEventListener(eventName, eventListeners[track.id][eventName])
    })

    // check once per second if the track has been stopped
    // calling .stop() does not fire any events
    eventListeners[track.id]['readyState'] = setInterval(() => {
      if (track.readyState === 'ended') {
        let event = new CustomEvent('ended', {detail: {check: 'readyState'}})
        track.dispatchEvent(event)
      }
    }, 1000)
  }

  private removeTrackEventListeners (track: MediaStreamTrack) {
    if (track.id in eventListeners)  {
      const events = this.getTrackEventObject()
      Object.keys(events).forEach(eventName => {
        track.removeEventListener(eventName, eventListeners[track.id][eventName])
      })

      clearInterval(eventListeners[track.id]['readyState'])
      delete eventListeners[track.id]
    }
  }

  private addToTimeline (event: TimelineEvent) {
    this.timeline.push(event)
    this.emit('timeline', event)
  }

  /**
   * Used to emit a custom event and also add it to the timeline
   * @param {String} eventName The name of the custome event: track, getUserMedia, stats, etc
   * @param {Object} options   The object tha will be sent with the event
   */
  private emitEvent (event: TimelineEvent | StatsEvent) {
    const ev = {
      ...event,
      timestamp: new Date()
    }
    // add event to timeline
    this.addToTimeline(ev)

    if (ev.tag) {
      // and emit this event
      this.emit(ev.tag, ev)
    }
  }

  /**
   * Sets the PeerConnection stats reporting interval.
   * @param interval
   *        Interval in milliseconds
   */
  set getStatsInterval (interval: number) {
    if (!Number.isInteger(interval)) {
      throw new Error(`getStatsInterval should be an integer, got: ${interval}`)
    }

    this._getStatsInterval = interval

    // TODO to be tested
    // Reset restart the interval with new value
    if (this.monitoringSetInterval) {
      this.stopStatsMonitoring()
      this.startStatsMonitoring()
    }
  }

  /**
   * Used to return the number of monitored peers
   * @return {number} [description]
   */
  private get numberOfMonitoredPeers (): number {
    return Object.keys(this.peersToMonitor).length
  }

  private removePeerConnectionEventListeners(connectionId: string, pc: RTCPeerConnection) {
    if (connectionId in eventListeners) {
      // remove all PeerConnection listeners
      Object.keys(this.peerConnectionListeners).forEach(eventName => {
        pc.removeEventListener(eventName, eventListeners[connectionId][eventName], false)
      })

      // remove reference for this connection
      delete eventListeners[connectionId]
    }

    // also remove track listeners
    pc.getSenders().forEach(sender => {
      if (sender.track) {
        this.removeTrackEventListeners(sender.track)
      }
    })

    pc.getReceivers().forEach(receiver => {
      if (receiver.track) {
        this.removeTrackEventListeners(receiver.track)
      }
    })
  }

  /**
   * Used to get a now timestamp
   * @return {number}
   */
  private getTimestamp(): number {
    return Date.now()
  }

  private parseGetDisplayMedia (options: { constraints?: any, stream?: MediaStream, error?: Error }) {
    try {
      const obj = {
        event: 'getDisplayMedia',
        tag: 'getDisplayMedia',
        data: {...options}
      } as TimelineEvent

      if (options.stream) {
        obj.data.details = this.parseStream(options.stream)

        // attach track listeners for screen-share tracks (mute/unmute/end fire like for gUM)
        options.stream.getTracks().map((track) => {
          this.addTrackEventListeners(track)
          localTracks.push(track)
        })
      }

      this.emitEvent(obj)
    } catch (e) {}
  }

  private wrapGetDisplayMedia (): void {
    const mediaDevices = navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: GetDisplayMediaFn }) | undefined
    if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
      this.logger.warn(`'navigator.mediaDevices.getDisplayMedia' is not available in browser. Will not wrap getDisplayMedia.`)
      return
    }

    const subscriber: GdmSubscriber = this.parseGetDisplayMedia.bind(this)
    this.gdmSubscriber = subscriber
    gdmSubscribers.add(subscriber)

    const current = mediaDevices.getDisplayMedia as GetDisplayMediaFn & { [GDM_WRAP_MARKER]?: boolean }
    if (current && current[GDM_WRAP_MARKER]) {
      this.logger.info('getDisplayMedia already wrapped by WebRTCStats; subscribing this instance.')
      return
    }

    this.logger.info('Wrapping getDisplayMedia.')

    gdmPreviousImpl = mediaDevices.getDisplayMedia as GetDisplayMediaFn
    const previous = gdmPreviousImpl
    const wrapped = function (this: MediaDevices, constraints?: any) {
      gdmSubscribers.forEach((sub) => {
        try { sub({ constraints }) } catch (_e) { /* isolate subscriber errors */ }
      })

      return previous.apply(navigator.mediaDevices, [constraints])
        .then((stream: MediaStream) => {
          gdmSubscribers.forEach((sub) => {
            try { sub({ stream }) } catch (_e) { /* isolate subscriber errors */ }
          })
          return stream
        }, (err: Error) => {
          gdmSubscribers.forEach((sub) => {
            try { sub({ error: err }) } catch (_e) { /* isolate subscriber errors */ }
          })
          return Promise.reject(err)
        })
    }

    const bound = wrapped.bind(navigator.mediaDevices) as GetDisplayMediaFn & { [GDM_WRAP_MARKER]?: boolean }
    bound[GDM_WRAP_MARKER] = true
    gdmInstalledWrapper = bound
    ;(mediaDevices as any).getDisplayMedia = bound
  }

  private unwrapGetDisplayMedia (): void {
    if (!this.gdmSubscriber) return

    gdmSubscribers.delete(this.gdmSubscriber)
    this.gdmSubscriber = null

    if (gdmSubscribers.size > 0) return
    if (!gdmInstalledWrapper) return
    const mediaDevices = navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: GetDisplayMediaFn }) | undefined
    if (!mediaDevices) return

    if (mediaDevices.getDisplayMedia === gdmInstalledWrapper) {
      ;(mediaDevices as any).getDisplayMedia = gdmPreviousImpl as GetDisplayMediaFn
    } else {
      this.logger.warn(
        'getDisplayMedia was wrapped again after WebRTCStats installed; not restoring native. ' +
        'The outer wrapper remains; our wrapper now passes through to the previous implementation.'
      )
    }

    gdmInstalledWrapper = null
    gdmPreviousImpl = null
  }
}
