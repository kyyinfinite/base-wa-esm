import { smsg } from '../../utils/myfunc.js'
import { isDispatchableUpsertType, isDispatchableMessage } from '../ingest/filter.js'
import handleMessage from '../dispatcher/dispatcher.js'
import { reportPluginError } from '../errors/engine.js'
import { events } from '../events/engine.js'
import { captureFromContacts, captureLidMappings } from '../../services/identity-resolver.js'
import { invalidateGroupMetadata } from '../../services/group-cache.js'
import { storeOutgoingMessage } from '../../services/message-store.js'
import { upsertGroup } from '../../services/database/groups.js'
import { getCurrentGeneration, handleConnectionUpdate, queueCredsSave } from './transport.js'

export function attachListeners(sock, { gen, session }) {
    const emitBridge = (event, payload) => {
        if (gen !== getCurrentGeneration()) return
        try {
            events.emit(event, payload)
        } catch (error) {
            reportPluginError('event:bridge', error, { event })
        }
    }

    sock.ev.on('creds.update', () => {
        if (gen === getCurrentGeneration()) queueCredsSave(session.auth.saveCreds)
    })

    sock.ev.on('connection.update', update => {
        handleConnectionUpdate(session, update)
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (gen !== getCurrentGeneration()) return


        if (!isDispatchableUpsertType(type)) {
            for (const mek of messages || []) {
                try {
                    if (mek?.key?.fromMe && mek?.message) storeOutgoingMessage(mek.key, mek.message)
                } catch {}
            }
            return
        }

        for (const mek of messages || []) {
            try {
                if (!isDispatchableMessage(mek)) continue

                const m = smsg(sock, mek)
                if (!m) continue

                Promise.resolve(handleMessage(sock, m)).catch(error => {
                    reportPluginError('message:upsert', error, { id: mek?.key?.id })
                })
            } catch (error) {
                reportPluginError('message:upsert', error, { id: mek?.key?.id })
            }
        }
    })

    sock.ev.on('messages.update', updates => {
        emitBridge('wa:update', updates)
    })

    sock.ev.on('messages.reaction', reactions => {
        emitBridge('wa:reaction', reactions)
    })

    sock.ev.on('call', calls => {
        emitBridge('wa:call', calls)
    })

    sock.ev.on('presence.update', update => {
        emitBridge('wa:presence', update)
    })

    sock.ev.on('contacts.upsert', contacts => {
        captureFromContacts(contacts).catch(() => {})
    })

    sock.ev.on('contacts.update', contacts => {
        captureFromContacts(contacts).catch(() => {})
    })

    sock.ev.on('groups.update', updates => {
        if (gen !== getCurrentGeneration()) return

        for (const update of updates || []) {
            if (!update?.id) continue
            invalidateGroupMetadata(update.id)
            if (!update.subject) continue
            try {
                upsertGroup({ jid: update.id, name: update.subject })
            } catch {}
        }

        emitBridge('wa:group', { source: 'groups.update', updates })
    })

    sock.ev.on('group-participants.update', ({ id, participants, action } = {}) => {
        if (gen !== getCurrentGeneration()) return
        if (!id) return
        invalidateGroupMetadata(id)
        if (Array.isArray(participants)) captureFromContacts(participants).catch(() => {})

        emitBridge('wa:group', { source: 'group-participants.update', id, participants, action })
    })

    sock.ev.on('lid-mapping.update', mapping => {
        if (gen !== getCurrentGeneration()) return
        captureLidMappings([mapping]).catch(() => {})
    })

    sock.ev.on('messaging-history.set', ({ contacts, lidPnMappings } = {}) => {
        if (gen !== getCurrentGeneration()) return
        if (Array.isArray(contacts)) captureFromContacts(contacts).catch(() => {})
        if (Array.isArray(lidPnMappings)) captureLidMappings(lidPnMappings).catch(() => {})
    })
}

export default attachListeners
