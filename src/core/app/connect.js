import {
    establishSession,
    requestPairingIfNeeded,
    setActiveOptions,
    getActiveOptions,
    hasUsableSession,
    getCurrentGeneration,
    getConnecting,
    setConnecting,
    setRestartConnection,
    prepareConnect,
    scheduleReconnect,
    closeActiveSocket,
    getActiveSocket,
    getConnectionStatus
} from './transport.js'

import { attachListeners } from './listeners.js'
import crmstore from '../../lib/crm/crmstore.js'
import { normalizeLid } from '../../utils/jid.js'
import { setResolverSocket } from '../../services/identity-resolver.js'
import { setGroupCacheSocket } from '../../services/group-cache.js'
import { setDispatcherReady } from '../dispatcher/dispatcher.js'
import { reportPluginError } from '../errors/engine.js'

async function startConnection(options) {
    const established = await establishSession(options)
    if (!established) return null

    const { sock, session, gen } = established

    try {
        crmstore.bind(sock)
    } catch (error) {
        reportPluginError('crm:bind', error, { generation: gen })
    }
    sock.decodeJid = normalizeLid
    sock.public = true
    setResolverSocket(sock)
    setGroupCacheSocket(sock)

    setDispatcherReady(false)
    attachListeners(sock, { gen, session })

    await requestPairingIfNeeded(session, options)

    return sock
}

export default async function connectToWhatsApp(options = {}) {
    if (options.createSocket !== undefined && typeof options.createSocket !== 'function') {
        throw new TypeError('createSocket harus berupa function')
    }

    setActiveOptions({ ...options })

    if (getConnecting()) return getConnecting()
    if (hasUsableSession()) return getActiveSocket()

    prepareConnect()

    const startGen = getCurrentGeneration()

    const connectingPromise = startConnection(getActiveOptions()).catch(error => {
        reportPluginError('runtime:connect', error, {})
        if (startGen === getCurrentGeneration()) scheduleReconnect(null, 'error')
        return null
    })

    setConnecting(connectingPromise)

    try {
        return await connectingPromise
    } finally {
        setConnecting(null)
    }
}

setRestartConnection(() => connectToWhatsApp(getActiveOptions() || {}))

export {
    closeActiveSocket,
    getActiveSocket,
    getConnectionStatus
}
