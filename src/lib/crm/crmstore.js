import fs from 'fs'
import { proto, generateWAMessage, generateWAMessageFromContent, generateMessageIDV2 } from '@whiskeysockets/baileys'
import { prepare, getDatabase, databasePath, checkpointDatabase } from '../../services/database/sqlite.js'

const SELECT_ROW = 'rowid, msg_id, chat, sender, ts, data'

function serializeNode(value) {
    return JSON.stringify(value, (_, value) => {
        if (Buffer.isBuffer(value)) {
            return {
                type: 'Buffer',
                data: value.toString('base64')
            }
        }

        if (value instanceof Uint8Array) {
            return {
                type: 'Buffer',
                data: Buffer.from(value).toString('base64')
            }
        }

        return value
    })
}

function deserializeNode(value) {
    if (!value) return null

    return JSON.parse(value, (_, value) => {
        if (value && value.type === 'Buffer') {
            if (typeof value.data === 'string') {
                return Buffer.from(value.data, 'base64')
            }

            if (Array.isArray(value.data)) {
                return Buffer.from(value.data)
            }
        }

        return value
    })
}

const isQueryableTimestamp = value => typeof value === 'number' && Number.isFinite(value)

function latestMessageRow(id, chat) {
    if (chat !== undefined) {
        return prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE msg_id = ? AND chat = ? ORDER BY rowid DESC LIMIT 1`).get(String(id), String(chat))
    }

    return prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE msg_id = ? ORDER BY rowid DESC LIMIT 1`).get(String(id))
}

function decodeRowData(data) {
    try {
        return proto.WebMessageInfo.decode(data)
    } catch {
        return null
    }
}

function saveMessage(message, chat) {
    if (!message || !chat) return false

    try {
        const id = message?.key?.id

        if (!id) return false

        const encoded = proto.WebMessageInfo.encode(message).finish()
        const timestamp = Number(message.messageTimestamp || Math.floor(Date.now() / 1000))

        prepare('INSERT INTO crm_messages(msg_id, chat, sender, ts, data) VALUES (?, ?, ?, ?, ?)').run(
            String(id),
            String(chat),
            message.participant || message.key?.participant || null,
            isQueryableTimestamp(timestamp) ? timestamp : null,
            Buffer.from(encoded)
        )

        return true
    } catch {
        return false
    }
}

function loadMessage(id, chat) {
    if (!id) return null

    try {
        const row = chat ? latestMessageRow(String(id), String(chat)) : latestMessageRow(String(id), undefined)

        if (!row?.data) return null

        return decodeRowData(row.data)
    } catch {
        return null
    }
}

function loadMessageById(id) {
    if (!id) return null

    try {
        const row = latestMessageRow(String(id), undefined)

        if (!row?.data) return null

        return decodeRowData(row.data)
    } catch {
        return null
    }
}

function saveNode(id, chat, node) {
    if (!id || !chat || !node) return false

    try {
        prepare('INSERT INTO crm_nodes(msg_id, chat, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(msg_id, chat) DO UPDATE SET data = excluded.data, created_at = excluded.created_at').run(
            String(id),
            String(chat),
            serializeNode(node),
            Math.floor(Date.now() / 1000)
        )

        return true
    } catch {
        return false
    }
}

function loadNode(messageId, jid) {
    if (!messageId) return null

    try {
        let data = null

        if (jid) {
            data = prepare('SELECT data FROM crm_nodes WHERE msg_id = ? AND chat = ?').get(String(messageId), String(jid))?.data
        }

        if (!data) {
            data = prepare('SELECT data FROM crm_nodes WHERE msg_id = ? ORDER BY created_at DESC LIMIT 1').get(String(messageId))?.data
        }

        if (!data) return null

        return deserializeNode(data)
    } catch {
        return null
    }
}

function saveAdditionalNode(id, chat, content, attrs = {}) {
    if (!id || !chat) return false

    try {
        const existing = loadNode(id, chat)

        if (existing && typeof existing === 'object') {
            existing.content = content
            existing.attrs = { ...existing.attrs, ...attrs }

            return saveNode(id, chat, existing)
        }

        return saveNode(id, chat, {
            tag: 'message',
            attrs: {
                id: String(id),
                from: String(chat),
                t: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                ...attrs
            },
            content
        })
    } catch {
        return false
    }
}

function loadAdditionalNode(id, chat) {
    const node = loadNode(id, chat)

    if (!node) return null

    return node.content ?? null
}

function hasMessage(id, chat) {
    if (!id) return false

    try {
        const row = chat
            ? prepare('SELECT 1 AS found FROM crm_messages WHERE msg_id = ? AND chat = ? LIMIT 1').get(String(id), String(chat))
            : prepare('SELECT 1 AS found FROM crm_messages WHERE msg_id = ? LIMIT 1').get(String(id))

        return !!row
    } catch {
        return false
    }
}

function deleteMessage(id, chat) {
    if (!id) return false

    try {
        if (chat) {
            prepare('DELETE FROM crm_messages WHERE msg_id = ? AND chat = ?').run(String(id), String(chat))
            prepare('DELETE FROM crm_nodes WHERE msg_id = ? AND chat = ?').run(String(id), String(chat))
        } else {
            prepare('DELETE FROM crm_messages WHERE msg_id = ?').run(String(id))
            prepare('DELETE FROM crm_nodes WHERE msg_id = ?').run(String(id))
        }

        return true
    } catch {
        return false
    }
}

const mapDecodedRow = row => ({
    rowid: row.rowid,
    id: row.msg_id,
    chat: row.chat,
    sender: row.sender ?? null,
    timestamp: row.ts ?? null,
    data: decodeRowData(row.data)
})

function getMessages(chat, limit = 100) {
    if (!chat) return []

    try {
        return prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE chat = ? ORDER BY rowid DESC LIMIT ?`)
            .all(String(chat), Math.max(1, Number(limit) || 100))
            .map(mapDecodedRow)
    } catch {
        return []
    }
}

function getAllMessages(limit = 100) {
    try {
        return prepare(`SELECT ${SELECT_ROW} FROM crm_messages ORDER BY rowid DESC LIMIT ?`)
            .all(Math.max(1, Number(limit) || 100))
            .map(mapDecodedRow)
    } catch {
        return []
    }
}

function countMessages() {
    try {
        return prepare('SELECT count(*) AS total FROM crm_messages').get().total
    } catch {
        return 0
    }
}

function getMessageRowByRowid(rowid) {
    const value = Number(rowid)

    if (!Number.isFinite(value)) return null

    const row = prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE rowid = ?`).get(value)

    if (!row?.data) return null

    return {
        rowid: value,
        id: row.msg_id,
        chat: row.chat,
        sender: row.sender ?? null,
        timestamp: row.ts ?? null,
        data: row.data
    }
}

function getMessageRow(id, chat) {
    if (!id) return null

    const row = chat ? latestMessageRow(String(id), String(chat)) : latestMessageRow(String(id), undefined)

    if (!row?.data) return null

    return {
        timestamp: row.ts ?? null,
        data: row.data
    }
}

function getMessageTimestamp(id, chat) {
    if (!id) return null

    const row = chat ? latestMessageRow(String(id), String(chat)) : latestMessageRow(String(id), undefined)

    if (!row) return null

    return row.ts ?? null
}

function getMessagesBefore(chat, timestamp, limit = 50) {
    if (!chat) return []

    const reference = Number(timestamp)

    if (!Number.isFinite(reference)) return []

    try {
        return prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE chat = ? AND ts IS NOT NULL AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
            .all(String(chat), reference, Math.max(1, Number(limit) || 50))
            .map(row => ({ id: row.msg_id, data: row.data }))
    } catch {
        return []
    }
}

function getMessagesAfter(chat, timestamp, limit = 50) {
    if (!chat) return []

    const reference = Number(timestamp)

    if (!Number.isFinite(reference)) return []

    try {
        return prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE chat = ? AND ts IS NOT NULL AND ts > ? ORDER BY ts ASC, rowid ASC LIMIT ?`)
            .all(String(chat), reference, Math.max(1, Number(limit) || 50))
            .map(row => ({ id: row.msg_id, data: row.data }))
    } catch {
        return []
    }
}

function getLastChatRows(chat, timestamp, limit = 100) {
    if (!chat) return []

    const reference = Number(timestamp)

    if (!Number.isFinite(reference)) return []

    try {
        return prepare(`SELECT ${SELECT_ROW} FROM crm_messages WHERE chat = ? AND ts IS NOT NULL AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
            .all(String(chat), reference, Math.max(1, Number(limit) || 100))
            .map(row => ({
                rowid: row.rowid,
                id: row.msg_id,
                chat: row.chat,
                sender: row.sender ?? null,
                timestamp: row.ts ?? null,
                data: row.data
            }))
    } catch {
        return []
    }
}

async function cleanup() {
    try {
        const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60

        while (true) {
            const result = prepare('DELETE FROM crm_messages WHERE rowid IN (SELECT rowid FROM crm_messages WHERE ts IS NOT NULL AND ts < ? LIMIT 2000)').run(cutoff)
            if (result.changes < 2000) break
            await new Promise(setImmediate)
        }

        if (global.MESSAGE_CACHE_LIMIT) {
            const limit = Number(global.MESSAGE_CACHE_LIMIT)

            if (limit > 0) {
                while (true) {
                    const result = prepare('DELETE FROM crm_messages WHERE rowid IN (SELECT rowid FROM crm_messages ORDER BY rowid DESC LIMIT 2000 OFFSET ?)').run(limit)
                    if (result.changes < 2000) break
                    await new Promise(setImmediate)
                }
            }
        }

        prepare('DELETE FROM crm_nodes WHERE NOT EXISTS (SELECT 1 FROM crm_messages m WHERE m.msg_id = crm_nodes.msg_id AND m.chat = crm_nodes.chat)').run()

        getDatabase().pragma('incremental_vacuum(500)')
        checkpointDatabase()
    } catch {}
}

function tableBytes(name) {
    try {
        return prepare('SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat WHERE name = ?').get(name).bytes
    } catch {
        return 0
    }
}

function fileSizeOf(file) {
    try {
        return fs.existsSync(file) ? fs.statSync(file).size : 0
    } catch {
        return 0
    }
}

const formatBytes = bytes => {
    if (!bytes) return '0 B'

    const units = ['B', 'KB', 'MB', 'GB', 'TB']

    let value = Number(bytes)
    let index = 0

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index++
    }

    return `${value.toFixed(2)} ${units[index]}`
}

function getStats() {
    try {
        const messagesRow = prepare('SELECT count(*) AS total, coalesce(sum(length(data)), 0) AS bytes FROM crm_messages').get()
        const nodesRow = prepare('SELECT count(*) AS total, coalesce(sum(length(data)), 0) AS bytes FROM crm_nodes').get()

        const totalMessages = messagesRow.total
        const messagesSize = messagesRow.bytes

        const messages = {
            count: totalMessages,
            size: messagesSize,
            avg: totalMessages ? messagesSize / totalMessages : 0
        }

        const nodes = {
            count: nodesRow.total,
            size: nodesRow.bytes,
            avg: nodesRow.total ? nodesRow.bytes / nodesRow.total : 0
        }

        const dbFile = databasePath()
        const messagesFileSize = tableBytes('crm_messages')
        const nodesFileSize = tableBytes('crm_nodes')
        const metaFileSize = tableBytes('sqlite_sequence')

        const totalFileSize = fileSizeOf(dbFile) + fileSizeOf(`${dbFile}-wal`)

        const limit = Number(global.MESSAGE_CACHE_LIMIT || 0)

        return {
            cache: {
                messages: totalMessages,
                limit,
                remaining: limit
                    ? Math.max(0, limit - totalMessages)
                    : 0,
                usagePercent: limit
                    ? (totalMessages / limit * 100).toFixed(2) + '%'
                    : '∞'
            },
            payload: {
                messages: {
                    count: messages.count,
                    size: messages.size,
                    sizeHuman: formatBytes(messages.size),
                    avgSize: Math.round(messages.avg || 0),
                    avgSizeHuman: formatBytes(messages.avg || 0)
                },
                nodes: {
                    count: nodes.count,
                    size: nodes.size,
                    sizeHuman: formatBytes(nodes.size),
                    avgSize: Math.round(nodes.avg || 0),
                    avgSizeHuman: formatBytes(nodes.avg || 0)
                }
            },
            files: {
                messages: {
                    size: messagesFileSize,
                    human: formatBytes(messagesFileSize)
                },
                nodes: {
                    size: nodesFileSize,
                    human: formatBytes(nodesFileSize)
                },
                meta: {
                    size: metaFileSize,
                    human: formatBytes(metaFileSize)
                },
                total: {
                    size: totalFileSize,
                    human: formatBytes(totalFileSize)
                }
            },
            ratio: {
                dbPerMessage: totalMessages
                    ? formatBytes(messages.size / totalMessages)
                    : '0 B',
                nodePerMessage: nodes?.count
                    ? formatBytes(nodes.size / nodes.count)
                    : '0 B'
            }
        }
    } catch {
        return {
            cache: {
                messages: 0,
                limit: Number(global.MESSAGE_CACHE_LIMIT || 0),
                remaining: 0,
                usagePercent: '0%'
            },
            payload: {
                messages: {
                    count: 0,
                    size: 0,
                    sizeHuman: '0 B',
                    avgSize: 0,
                    avgSizeHuman: '0 B'
                },
                nodes: {
                    count: 0,
                    size: 0,
                    sizeHuman: '0 B',
                    avgSize: 0,
                    avgSizeHuman: '0 B'
                }
            },
            files: {
                messages: {
                    size: 0,
                    human: '0 B'
                },
                nodes: {
                    size: 0,
                    human: '0 B'
                },
                meta: {
                    size: 0,
                    human: '0 B'
                },
                total: {
                    size: 0,
                    human: '0 B'
                }
            },
            ratio: {
                dbPerMessage: '0 B',
                nodePerMessage: '0 B'
            }
        }
    }
}

function loadFullMessage(id, chat) {
    const node = loadNode(id, chat)

    return {
        message: loadMessage(id, chat),
        additionalNode: node?.content ?? null
    }
}

function persist(message, id, jid, options) {
    queueMicrotask(() => {
        try {
            saveMessage(proto.WebMessageInfo.fromObject(message), jid)

            saveAdditionalNode(id, jid, options.additionalNodes || [], {
                t: String(Math.floor(Date.now() / 1000)),
                ...options.additionalAttributes
            })
        } catch {}
    })
}

if (!global.__crmStoreBoundConns) {
    global.__crmStoreBoundConns = new WeakSet()
}

function bind(conn) {
    if (!conn) return conn
    if (global.__crmStoreBoundConns.has(conn)) return conn

    global.__crmStoreBoundConns.add(conn)

    conn.ev.on('messages.upsert', ({ messages }) => {
        try {
            for (const message of messages || []) {
                if (!message?.key?.id) continue

                const chat = message.key.remoteJid

                if (!chat) continue

                saveMessage(message, chat)
            }
        } catch {}
    })

    if (conn.ws && typeof conn.ws.on === 'function') {
        conn.ws.on('CB:message', node => {
            try {
                const id = node?.attrs?.id

                if (!id) return

                const chat =
                    node?.attrs?.from ||
                    node?.attrs?.recipient ||
                    node?.attrs?.participant

                if (!chat) return

                saveNode(
                    id,
                    chat,
                    node
                )
            } catch {}
        })
    }

    if (typeof conn.sendMessage === 'function' && !conn.sendMessage.__crmStorePatched) {
        const originalSendMessage = conn.sendMessage.bind(conn)

        const patchedSendMessage = async (jid, content, options = {}) => {
            const messageId = options.messageId || generateMessageIDV2()

            const generated = await generateWAMessage(jid, content, {
                ...options,
                messageId,
                userJid: conn.user?.id,
                upload: conn.waUploadToServer
            })

            const sent = await originalSendMessage(jid, content, { ...options, messageId })

            persist(generated, messageId, jid, options)

            return sent
        }

        patchedSendMessage.__crmStorePatched = true
        conn.sendMessage = patchedSendMessage
    }

    if (typeof conn.relayMessage === 'function' && !conn.relayMessage.__crmStorePatched) {
        const originalRelayMessage = conn.relayMessage.bind(conn)

        const patchedRelayMessage = async (jid, content, options = {}) => {
            const messageId = options.messageId || generateMessageIDV2()

            const generated = generateWAMessageFromContent(jid, content, {
                ...options,
                messageId,
                userJid: conn.user?.id,
                upload: conn.waUploadToServer
            })

            const resultPromise = originalRelayMessage(jid, content, { ...options, messageId })

            persist(generated, messageId, jid, options)

            return resultPromise
        }

        patchedRelayMessage.__crmStorePatched = true
        conn.relayMessage = patchedRelayMessage
    }

    return conn
}

if (!global.__crmStoreCleanupTimer) {
    let lastCleanup = 0

    global.__crmStoreCleanupTimer = setInterval(() => {
        const now = Date.now()

        if (now - lastCleanup < 60 * 60 * 1000) {
            return
        }

        lastCleanup = now

        Promise.resolve(cleanup()).catch(() => {})
    }, 60 * 1000)

    global.__crmStoreCleanupTimer.unref?.()
}

export {
    bind,
    saveMessage,
    loadMessage,
    loadMessageById,
    saveNode,
    loadNode,
    saveAdditionalNode,
    loadAdditionalNode,
    hasMessage,
    deleteMessage,
    getMessages,
    getAllMessages,
    countMessages,
    getMessageRowByRowid,
    getMessageRow,
    getMessageTimestamp,
    getMessagesBefore,
    getMessagesAfter,
    getLastChatRows,
    cleanup,
    getStats,
    loadFullMessage
}

export default {
    bind,
    saveMessage,
    loadMessage,
    loadMessageById,
    saveNode,
    loadNode,
    saveAdditionalNode,
    loadAdditionalNode,
    hasMessage,
    deleteMessage,
    getMessages,
    getAllMessages,
    countMessages,
    getMessageRowByRowid,
    getMessageRow,
    getMessageTimestamp,
    getMessagesBefore,
    getMessagesAfter,
    getLastChatRows,
    cleanup,
    getStats,
    loadFullMessage
}
