// @ts-check
import { pinningServiceTemplates } from '../constants/pinning'
import memoize from 'p-memoize'
import CID from 'cids'
import all from 'it-all'

import { readSetting, writeSetting } from './local-storage'

// This bundle leverages createCacheBundle and persistActions for
// the persistence layer that keeps pins in IndexDB store
// to ensure they are around across restarts/reloads/refactors/releases.

const CID_PIN_CHECK_BATCH_SIZE = 10 // Pinata returns error when >10

// id = `${serviceName}:${cid}`
const cacheId2Cid = (id) => id.split(':').at(-1)
const cacheId2ServiceName = (id) => id.split(':').at(0)

const parseService = async (service, remoteServiceTemplates, ipfs) => {
  const template = remoteServiceTemplates.find(t => service.endpoint.toString() === t.apiEndpoint.toString())
  const icon = template?.icon
  const visitServiceUrl = template?.visitServiceUrl
  const parsedService = { ...service, name: service.service, icon, visitServiceUrl }

  if (service?.stat?.status === 'invalid') {
    return { ...parsedService, numberOfPins: -1, online: false }
  }

  const numberOfPins = service.stat?.pinCount?.pinned
  const online = typeof numberOfPins === 'number'
  const autoUpload = online ? await mfsPolicyEnableFlag(service.service, ipfs) : undefined

  return { ...parsedService, numberOfPins, online, autoUpload }
}

const mfsPolicyEnableFlag = memoize(async (serviceName, ipfs) => {
  try {
    return await ipfs.config.get(`Pinning.RemoteServices.${serviceName}.Policies.MFS.Enable`)
  } catch (e) {
    if (e.message?.includes('key has no attribute')) {
      try { // retry with notation from https://github.com/ipfs/go-ipfs/pull/8096
        return await ipfs.config.get(`Pinning.RemoteServices["${serviceName}"].Policies.MFS.Enable`)
      } catch (_) {}
    }
    console.error(`unexpected config.get error for "${serviceName}": ${e.message}`)
  }
  return false
}, { maxAge: 3000 })

const uniqueCidBatches = (arrayOfCids, size) => {
  const array = [...new Set(arrayOfCids)] // deduplicate CIDs
  const result = []
  for (let i = 0; i < array.length; i += size) {
    const chunk = array.slice(i, i + size)
    result.push(chunk)
  }
  return result
}

const pinningBundle = {
  name: 'pinning',
  persistActions: ['UPDATE_REMOTE_PINS'],
  init: store => {
    // Starts periodic remote pins checker.
    setInterval(() => {
      const pins = [
        ...store.selectPendingPins(),
        ...store.selectFailedPins()
      ].map(serviceCid => ({ cid: serviceCid.split(':')[1] }))
      console.info('Checking Pins', pins)
      store.doFetchRemotePins(pins, true)
    }, 30000)
  },
  reducer: (state = {
    pinningServices: [],
    remotePins: [],
    pendingPins: [],
    failedPins: [],
    notRemotePins: [],
    localPinsSize: 0,
    localNumberOfPins: 0,
    arePinningServicesSupported: false
  }, action) => {
    if (action.type === 'UPDATE_REMOTE_PINS') {
      const { adds = [], removals = [], pending = [], failed = [] } = action.payload
      const uniq = (arr) => [...new Set(arr)]
      const notIn = (...arrays) => p => arrays.every(array => !array.some(a => a === p))
      const remotePins = uniq([...state.remotePins, ...adds].filter(notIn(removals, pending, failed)))
      const notRemotePins = uniq([...state.notRemotePins, ...removals].filter(notIn(adds, pending, failed)))
      const pendingPins = uniq([...state.pendingPins, ...pending].filter(notIn(adds, removals, failed)))
      const failedPins = uniq([...state.failedPins, ...failed].filter(notIn(adds, removals, pending)))

      return { ...state, remotePins, notRemotePins, pendingPins, failedPins }
    }
    if (action.type === 'SET_LOCAL_PINS_STATS') {
      const { localPinsSize, localNumberOfPins } = action.payload
      return { ...state, localNumberOfPins, localPinsSize }
    }
    if (action.type === 'SET_REMOTE_PINNING_SERVICES') {
      const oldServices = state.pinningServices
      const newServices = action.payload
      // Skip update when list length did not change and new one has no stats
      if (oldServices.length === newServices.length) {
        const withPinStats = s => (s && typeof s.numberOfPins !== 'undefined')
        const oldStats = oldServices.some(withPinStats)
        const newStats = newServices.some(withPinStats)
        if (oldStats && !newStats) return state
      }
      return { ...state, pinningServices: newServices }
    }
    if (action.type === 'SET_REMOTE_PINNING_SERVICES_AVAILABLE') {
      return { ...state, arePinningServicesSupported: action.payload }
    }
    return state
  },

  doFetchRemotePins: (files, skipCache = false) => async ({ dispatch, store, getIpfs }) => {
    const pinningServices = store.selectPinningServices()
    if (!pinningServices?.length) return
    const ipfs = getIpfs()
    if (!ipfs || store?.ipfs?.ipfs?.ready || !ipfs.pin.remote) return

    const allCids = files ? files.map(f => f.cid.toString()) : []

    // Reuse known state for some CIDs to avoid unnecessary requests
    const remotePins = store.selectRemotePins()
    const notRemotePins = store.selectNotRemotePins()

    // Check remaining CID status in chunks based on API limitation seen in real world
    const cids = uniqueCidBatches(allCids, CID_PIN_CHECK_BATCH_SIZE)

    const adds = []
    const removals = []
    const failed = []
    const pending = []

    const lsWithBackoff = (params) => {
      const backoffs = readSetting('remotesServicesBackoffs') || {}
      const { service } = params

      const { lastTry, tryAfter } = backoffs[service] || { lastTry: 0, tryAfter: 30000 } // Start with 30s
      if (lastTry + tryAfter > new Date().getTime()) {
        throw new Error('still within backoff period')
      }

      try {
        return ipfs.pin.remote.ls(params)
      } catch (e) {
        if (e.toString().includes('429 Too Many Requests')) {
          backoffs[service] = {
            lastTry: new Date().getTime(),
            tryAfter: tryAfter * 3
          }
          writeSetting('remotesServicesBackoffs', backoffs)
        }

        throw e
      }
    }

    await Promise.allSettled(pinningServices.map(async service => {
      try {
        // skip CIDs that we know the state of at this service
        const skipCids = skipCache ? new Set() : new Set(
          [...remotePins, ...notRemotePins]
            .filter(id => id.startsWith(service.name))
            .map(cacheId2Cid)
        )
        for (const cidChunk of cids) {
          const cidsToCheck = cidChunk.filter(cid => !skipCids.has(cid.toString()))
          if (!cidsToCheck.length) continue // skip if no new cids to check
          const notPins = new Set(cidsToCheck.map(cid => cid.toString()))
          try {
            const pins = lsWithBackoff({ service: service.name, cid: cidsToCheck.map(cid => new CID(cid)), status: ['queued', 'pinning', 'pinned', 'failed'] })
            for await (const pin of pins) {
              console.log(pin)
              const pinCid = pin.cid.toString()
              notPins.delete(pinCid)

              if (pin.status === 'queued' || pin.status === 'pinning') {
                pending.push(`${service.name}:${pinCid}`)
              } else if (pin.status === 'failed') {
                failed.push(`${service.name}:${pinCid}`)
              } else {
                adds.push(`${service.name}:${pinCid}`)
              }
            }
            // store 'not pinned remotely on this service' to avoid future checks
          } catch (e) {
            console.error(`Error: pin.remote.ls service=${service.name} cid=${cidsToCheck}: ${e.toString()}`)
          }
          // cache remaining ones as not pinned
          for (const notPinCid of notPins) {
            removals.push(`${service.name}:${notPinCid}`)
          }
        }
      } catch (e) {
        // ignore service and network errors for now
        // and continue checking remaining ones
        console.error('unexpected error during doFetchRemotePins', e)
      }
    }))
    dispatch({ type: 'UPDATE_REMOTE_PINS', payload: { adds, removals, pending, failed } })
  },

  selectRemotePins: (state) => state.pinning.remotePins || [],
  selectNotRemotePins: (state) => state.pinning.notRemotePins || [],
  selectPendingPins: (state) => state.pinning.pendingPins || [],
  selectFailedPins: (state) => state.pinning.failedPins || [],

  selectLocalPinsSize: (state) => state.pinning.localPinsSize,
  selectLocalNumberOfPins: (state) => state.pinning.localNumberOfPins,

  doSelectRemotePinsForFile: (file) => ({ store }) => {
    const pinningServicesNames = store.selectPinningServices().map(remote => remote.name)
    const remotePinForFile = store.selectRemotePins().filter(pin => cacheId2Cid(pin) === file.cid.toString())
    const servicesBeingUsed = remotePinForFile.map(pin => cacheId2ServiceName(pin)).filter(name => pinningServicesNames.includes(name))
    return servicesBeingUsed
  },

  // gets the amount of local pins
  doFetchLocalPinsStats: () => async ({ getIpfs, dispatch }) => {
    const ipfs = getIpfs()
    if (!ipfs) return null

    const localPins = await all(ipfs.pin.ls({ type: 'recursive' }))
    const localPinsSize = -1 // TODO: right now calculating size of all pins is too expensive (requires ipfs.files.stat per CID)
    const localNumberOfPins = localPins.length

    dispatch({ type: 'SET_LOCAL_PINS_STATS', payload: { localPinsSize, localNumberOfPins } })
  },

  // list of services without online check (reads list from config, should be instant)
  doFetchPinningServices: () => async ({ getIpfs, store, dispatch }) => {
    const ipfs = getIpfs()
    if (!ipfs || store?.ipfs?.ipfs?.ready || !ipfs.pin.remote) return null

    const isPinRemotePresent = (await ipfs.commands()).Subcommands.find(c => c.Name === 'pin').Subcommands.some(c => c.Name === 'remote')
    dispatch({ type: 'SET_REMOTE_PINNING_SERVICES_AVAILABLE', payload: isPinRemotePresent })
    if (!isPinRemotePresent) return null

    const remoteServiceTemplates = store.selectRemoteServiceTemplates()
    const offlineListOfServices = await ipfs.pin.remote.service.ls()
    const remoteServices = await Promise.all(offlineListOfServices.map(service => parseService(service, remoteServiceTemplates, ipfs)))
    dispatch({ type: 'SET_REMOTE_PINNING_SERVICES', payload: remoteServices })
  },

  // fetching pin stats for services is slower/expensive, so we only do that on Settings
  doFetchPinningServicesStats: () => async ({ getIpfs, store, dispatch }) => {
    const ipfs = getIpfs()
    if (!ipfs || store?.ipfs?.ipfs?.ready || !ipfs.pin.remote) return null
    const isPinRemotePresent = (await ipfs.commands()).Subcommands.find(c => c.Name === 'pin').Subcommands.some(c => c.Name === 'remote')
    if (!isPinRemotePresent) return null

    const remoteServiceTemplates = store.selectRemoteServiceTemplates()
    const servicesWithStats = await ipfs.pin.remote.service.ls({ stat: true })
    const remoteServices = await Promise.all(servicesWithStats.map(service => parseService(service, remoteServiceTemplates, ipfs)))

    dispatch({ type: 'SET_REMOTE_PINNING_SERVICES', payload: remoteServices })
  },

  selectPinningServices: (state) => state.pinning.pinningServices || [],

  selectRemoteServiceTemplates: () => pinningServiceTemplates,

  selectArePinningServicesSupported: (state) => state.pinning.arePinningServicesSupported,

  selectPinningServicesDefaults: () => pinningServiceTemplates.reduce((prev, curr) => ({
    ...prev,
    [curr.name]: {
      ...curr,
      nickname: curr.name
    }
  }), {}),

  doSetPinning: (file, services = [], wasLocallyPinned, previousRemotePins = []) => async ({ getIpfs, store, dispatch }) => {
    const ipfs = getIpfs()
    const { cid, name } = file

    const pinLocally = services.includes('local')
    if (wasLocallyPinned !== pinLocally) {
      try {
        pinLocally ? await ipfs.pin.add(cid) : await ipfs.pin.rm(cid)
      } catch (e) {
        console.error(`unexpected local pin error for ${cid} (${name})`, e)
        const msgArgs = { serviceName: 'local', errorMsg: e.toString() }
        dispatch({ type: 'IPFS_PIN_FAILED', msgArgs })
      }
    }

    const adds = []
    const pending = []
    const failed = []
    const removals = []

    store.selectPinningServices().forEach(async service => {
      const shouldPin = services.includes(service.name)
      const wasPinned = previousRemotePins.includes(service.name)
      if (wasPinned === shouldPin) return

      const id = `${service.name}:${cid}`
      try {
        if (shouldPin) {
          pending.push(id)
          await ipfs.pin.remote.add(cid, { service: service.name, name, background: true })
        } else {
          removals.push(id)
          await ipfs.pin.remote.rm({ cid: [cid], service: service.name })
        }
      } catch (e) {
        // log error and continue with other services
        console.error(`ipfs.pin.remote error for ${cid}@${service.name}`, e)
        const msgArgs = { serviceName: service.name, errorMsg: e.toString() }
        failed.push(id)
        dispatch({ type: 'IPFS_PIN_FAILED', msgArgs })
      }
    })

    dispatch({ type: 'UPDATE_REMOTE_PINS', payload: { adds, removals, pending, failed } })

    await store.doPinsFetch()
  },
  doAddPinningService: ({ apiEndpoint, nickname, secretApiKey }) => async ({ getIpfs }) => {
    const ipfs = getIpfs()

    // temporary mitigation for https://github.com/ipfs/ipfs-webui/issues/1770
    // update: still present a year later – i think there is a lesson here :-)
    nickname = nickname.replaceAll('.', '_')

    await ipfs.pin.remote.service.add(nickname, {
      endpoint: apiEndpoint,
      key: secretApiKey
    })
  },

  doRemovePinningService: (name) => async ({ getIpfs, store }) => {
    const ipfs = getIpfs()

    await ipfs.pin.remote.service.rm(name)

    store.doFetchPinningServices()
  },

  doSetAutoUploadForService: (name) => async ({ getIpfs, store }) => {
    const ipfs = getIpfs()

    const configName = `Pinning.RemoteServices.${name}.Policies.MFS.Enable`

    const previousPolicy = await ipfs.config.get(configName)

    await ipfs.config.set(configName, !previousPolicy)

    store.doFetchPinningServices()
  }
}
export default pinningBundle
