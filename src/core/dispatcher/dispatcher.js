import { normalizeMessage } from '../message/normalize.js'
import { plugins, getPatternPlugins } from '../plugin/registry.js'
import { createContext } from '../context/createContext.js'
import { runMiddleware } from '../middleware/engine.js'
import { parseCommand, parseButtonResponse, matchPatternPlugin } from './parse.js'
import { getConfiguredNumbers, toNumber, toUserJid } from '../../utils/identity.js'
import { captureFromMessage, captureFromGroupMetadata, resolveSenderIdentity, peekSenderIdentity } from '../../services/identity-resolver.js'
import { owners, premiums } from '../../services/access.js'
import { getConfig } from '../../services/config.js'
import { getCachedGroupMetadata } from '../../services/group-cache.js'
import { upsertUser } from '../../services/database/users.js'
import { getGroup, upsertGroup } from '../../services/database/groups.js'
import { messageQueue } from '../queue/engine.js'
import { isDuplicateMessage } from '../queue/dedupe.js'
import { reportPluginError } from '../errors/engine.js'
import { events } from '../events/engine.js'
import { logWarn } from '../../services/logger.js'
import outbound, { bindOutboundSocket } from '../outbound/index.js'
import { recordMessageReceived, recordMessageFiltered, recordCommandResult } from '../../services/metrics.js'

const MAX_BUFFERED_MESSAGES = 200
const BUSY_NOTICE_INTERVAL_MS = 60_000
const BUSY_NOTICE_TRACK_MAX = 1000

let ready = true
let buffered = []
const busyNoticeAt = new Map()

export function setDispatcherReady(value) {
    if (value === true) {
        ready = true
        if (buffered.length) {
            const entries = buffered
            buffered = []
            for (const entry of entries) {
                entry.resolve(dispatchPipeline(entry.conn, entry.m).catch(() => undefined))
            }
        }
        return
    }

    ready = false
    for (const entry of buffered) entry.resolve(undefined)
    buffered = []
}

export function getDispatcherState() {
    return { ready, buffered: buffered.length }
}

events.on('bot:ready', () => setDispatcherReady(true))
events.on('bot:disconnect', () => setDispatcherReady(false))

function bufferMessage(conn, m) {
    if (buffered.length >= MAX_BUFFERED_MESSAGES) {
        logWarn('dispatcher', 'dispatcher.buffer.penuh', { size: buffered.length })
        return Promise.resolve(undefined)
    }

    return new Promise(resolve => {
        buffered.push({ conn, m, resolve })
    })
}

async function executePlugin(handler, m, context) {
    try {
        if (typeof handler !== 'function') {
            throw new TypeError('Plugin handler must be a function')
        }

        const result = await handler(m, {
            conn: context.conn,
            args: context.args,
            text: context.text,
            command: context.command,
            prefix: context.prefix,
            notifReply: context.notifReply,
            accessDenied: context.accessDenied,
            context
        })

        return { ok: true, result }
    } catch (error) {
        reportPluginError('plugin:execute', error, {
            plugin: handler?.__pluginFile || handler?.name || 'unknown',
            command: context?.command,
            chat: m?.chat,
            messageId: m?.id
        })
        return { ok: false }
    }
}

function applyMinimalIdentity(conn, m, config) {
    const identity = peekSenderIdentity(m)

    const identityNumbers = new Set(identity.jids.map(toNumber).filter(Boolean))
    const botNumber = toNumber(toUserJid(conn?.user?.id || ''))
    const creatorNumbers = new Set([
        ...(config.creator || []),
        botNumber
    ].flatMap(value => getConfiguredNumbers(value)))
    const ownerNumbers = new Set(owners.numbers())

    m.identityJids = identity.jids
    m.identityNumber = identity.number
    m.senderPn = identity.pn
    m.senderLid = identity.lid
    m.identityKey = identity.number || identity.lid || String(m.sender || 'unknown')
    m.chatKey = m.isGroup ? m.chat : (identity.pn || m.chat || 'unknown')

    m.isCreator = [...identityNumbers].some(number => creatorNumbers.has(number))
    m.isOwner = m.isCreator || [...identityNumbers].some(number => ownerNumbers.has(number))
}

function parseIncoming(m, config) {
    const prefixes = Array.isArray(config.prefix) && config.prefix.length ? config.prefix : ['.']

    if (m.isButtonResponse) {
        const parsed = parseButtonResponse(m, prefixes)
        const handler = parsed?.command ? plugins.get(parsed.command) : null
        return handler ? { parsed, handler } : null
    }

    const leadTrimmed = String(m.text || '').replace(/^\s+/, '')
    const hasConfigPrefix = prefixes.some(p => leadTrimmed.startsWith(p))

    if (!hasConfigPrefix) {
        const patternHandler = matchPatternPlugin(m, getPatternPlugins())
        if (patternHandler) {
            return {
                parsed: { prefix: '', command: '', args: [], text: m.text, rawText: m.text },
                handler: patternHandler
            }
        }
    }

    const parsed = parseCommand(m, prefixes)
    if (!parsed) return null

    const candidate = parsed.command ? plugins.get(parsed.command) : null
    if (!candidate) return null
    if (!parsed.prefix && !config.prefixlessCommands && !candidate.prefixless) return null

    return { parsed, handler: candidate }
}

async function notifyQueueBusy(conn, m) {
    const key = m?.chat || m?.chatKey || 'global'
    const now = Date.now()
    const last = busyNoticeAt.get(key) || 0
    if (now - last < BUSY_NOTICE_INTERVAL_MS) return

    busyNoticeAt.set(key, now)
    if (busyNoticeAt.size > BUSY_NOTICE_TRACK_MAX) {
        for (const [mapKey, at] of busyNoticeAt) {
            if (now - at >= BUSY_NOTICE_INTERVAL_MS) busyNoticeAt.delete(mapKey)
        }
    }

    if (!m?.chat || !conn?.sendMessage) return
    try {
        await conn.sendMessage(m.chat, { text: 'Antrean pesan sedang penuh, perintah tadi dibatalkan. Silakan coba lagi beberapa saat.' })
    } catch {}
}

function enqueueMessage(conn, m, config, incoming) {
    const { parsed, handler } = incoming
    const controller = new AbortController()

    const timeoutMs = handler.timeoutMs !== undefined ? Number(handler.timeoutMs) : undefined
    const priority = !!(m.isOwner || m.isCreator)

    const task = () => processMessage(conn, m, config, parsed, handler, controller.signal)

    const queued = messageQueue.add(m.chat || 'global', task, {
        timeoutMs,
        priority,
        onTimeout: () => controller.abort(new Error('batas waktu task tercapai'))
    })

    return queued.catch(error => {
        if (error?.code === 'QUEUE_OVERFLOW') {
            notifyQueueBusy(conn, m)
            return undefined
        }
        if (/batas waktu/.test(String(error?.message || ''))) {
            recordCommandResult(parsed.command, { ok: false, timedOut: true })
        }
        reportPluginError('message:queue', error, {
            chat: m?.chat,
            messageId: m?.id,
            command: m?.text
        })
    })
}

async function processMessage(conn, m, config, parsed, handler, signal) {
    const startedAt = Date.now()

    const notifReply = async (text, title = 'Notification') => {
        await outbound.send(m.chat, {
            text: `*${title}*\n\n${text}`
        }, { quoted: m })
    }

    const accessDenied = config.accessDenied || {}

    const context = createContext({
        conn,
        m,
        args: parsed.args,
        text: parsed.text,
        rawText: parsed.rawText,
        command: parsed.command,
        prefix: parsed.prefix,
        signal,
        notifReply,
        accessDenied
    })

    const middleware = await runMiddleware(context, handler)
    if (!middleware.allowed) return

    const proceed = await runBeforeHook(handler, m, context)
    if (!proceed) {
        try { context._cooldownRelease?.() } catch {}
        try { context._limitRefund?.() } catch {}
        recordCommandResult(parsed.command, { ok: false, latencyMs: Date.now() - startedAt })
        await runAfterHook(handler, m, context, { ok: false, skipped: true })
        return
    }

    const outcome = await executePlugin(handler, m, context)
    await runAfterHook(handler, m, context, { ok: outcome.ok, result: outcome.result })

    recordCommandResult(parsed.command, {
        ok: outcome.ok,
        latencyMs: Date.now() - startedAt
    })

    if (!outcome.ok) {
        context._limitRefund?.()
        context._cooldownRelease?.()
    }
}

async function runBeforeHook(handler, m, context) {
    if (typeof handler.before !== 'function') return true

    try {
        const result = await handler.before(m, context)
        return result !== false
    } catch (error) {
        reportPluginError('plugin:before', error, {
            plugin: handler?.__pluginFile || handler?.name || 'unknown',
            command: context?.command,
            chat: m?.chat,
            messageId: m?.id
        })
        return false
    }
}

async function runAfterHook(handler, m, context, outcome) {
    if (typeof handler.after !== 'function') return

    try {
        await handler.after(m, context, outcome)
    } catch (error) {
        reportPluginError('plugin:after', error, {
            plugin: handler?.__pluginFile || handler?.name || 'unknown',
            command: context?.command,
            chat: m?.chat,
            messageId: m?.id
        })
    }
}

async function dispatchPipeline(conn, m) {
    try {
        normalizeMessage(m)

        const config = getConfig()
        bindOutboundSocket(conn)
        recordMessageReceived()

        if (!m.text) {
            recordMessageFiltered('empty-text')
            return
        }
        if (isDuplicateMessage(m.id)) {
            recordMessageFiltered('duplicate')
            return
        }

        applyMinimalIdentity(conn, m, config)

        if (config.botMode === 'self' && !m.isOwner && !m.fromMe) {
            recordMessageFiltered('self-mode')
            return
        }

        await captureFromMessage(m?.key).catch(() => {})

        const identity = await resolveSenderIdentity(m)

        const identityNumbers = new Set(identity.jids.map(toNumber).filter(Boolean))
        const botJid = toUserJid(conn.user?.id || '')
        const botNumber = toNumber(botJid)

        const creatorNumbers = new Set([
            ...(config.creator || []),
            botNumber
        ].flatMap(value => getConfiguredNumbers(value)))

        const ownerNumbers = new Set(owners.numbers())
        const premiumNumbers = new Set(premiums.numbers())

        m.identityJids = identity.jids
        m.identityNumber = identity.number
        m.senderPn = identity.pn
        m.senderLid = identity.lid
        m.identityKey = identity.number || identity.lid || String(m.sender || 'unknown')
        m.chatKey = m.isGroup ? m.chat : (identity.pn || m.chat || 'unknown')

        m.isCreator = [...identityNumbers].some(number => creatorNumbers.has(number))
        m.isOwner = m.isCreator || [...identityNumbers].some(number => ownerNumbers.has(number))
        m.isPremium = m.isOwner || [...identityNumbers].some(number => premiumNumbers.has(number))

        m.userJid = identity.pn || toUserJid(m.sender) || m.sender || null

        m.userRecord = upsertUser({
            jid: m.userJid,
            name: m.pushName || '',
            isPremium: m.isPremium,
            isOwner: m.isOwner,
            isCreator: m.isCreator
        })

        if (m.isGroup && m.chat) {
            let groupName = m.groupName || ''
            const existingGroup = getGroup(m.chat)

            if (!existingGroup?.name) {
                try {
                    const metadata = await getCachedGroupMetadata(m.chat, conn)
                    groupName = metadata?.subject || groupName
                    if (metadata) {
                        captureFromGroupMetadata(metadata).catch(error => {
                            reportPluginError('identity:group-capture', error, { chat: m.chat, messageId: m.id })
                        })
                    }
                } catch (e) {
                    reportPluginError('group:metadata', e, { chat: m.chat, messageId: m.id })
                }
            }

            m.groupRecord = upsertGroup({ jid: m.chat, name: groupName })
        }

        const incoming = parseIncoming(m, config)
        if (!incoming) {
            recordMessageFiltered('no-handler')
            return
        }

        return enqueueMessage(conn, m, config, incoming)
    } catch (e) {
        reportPluginError('message', e, {
            chat: m?.chat,
            messageId: m?.id,
            command: m?.text
        })
    }
}

export default async function handleMessage(conn, m) {
    if (!ready) return bufferMessage(conn, m)
    return dispatchPipeline(conn, m)
}
