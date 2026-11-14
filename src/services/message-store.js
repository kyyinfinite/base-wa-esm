import { BufferJSON } from '@whiskeysockets/baileys'
import { prepare } from './database/sqlite.js'

const store = new Map()

const MAX_ENTRIES = 500
const TTL_MS = 60 * 60_000
const STORE_VERSION = 1

let loaded = false

function serializeContent(content) {
    try {
        return JSON.parse(JSON.stringify(content, BufferJSON.replacer))
    } catch {
        return null
    }
}

function reviveContent(content) {
    try {
        return JSON.parse(JSON.stringify(content), BufferJSON.reviver)
    } catch {
        return content
    }
}

function removeFromDisk(id) {
    try {
        prepare('DELETE FROM outgoing_messages WHERE id = ?').run(id)
    } catch {}
}

function ensureLoaded() {
    if (loaded) return
    loaded = true
    try {
        prepare('DELETE FROM outgoing_messages WHERE created_at < ?').run(Date.now() - TTL_MS)

        const rows = prepare('SELECT id, jid, content, created_at FROM outgoing_messages ORDER BY created_at ASC').all()
        for (const row of rows) {
            let content = null
            try {
                content = JSON.parse(row.content)
            } catch {}

            if (!content || typeof content !== 'object' || !row.id) {
                removeFromDisk(row.id)
                continue
            }

            store.set(row.id, {
                v: STORE_VERSION,
                id: row.id,
                jid: row.jid ?? null,
                content,
                at: Number(row.created_at) || 0
            })
        }

        prune()
    } catch {}
}

function prune() {
    const now = Date.now()

    for (const [id, record] of store) {
        if (now - (record.at || 0) > TTL_MS) {
            store.delete(id)
        }
    }

    try {
        prepare('DELETE FROM outgoing_messages WHERE created_at < ?').run(now - TTL_MS)
    } catch {}

    while (store.size > MAX_ENTRIES) {
        const oldest = store.keys().next().value
        store.delete(oldest)
    }

    try {
        prepare('DELETE FROM outgoing_messages WHERE id IN (SELECT id FROM outgoing_messages ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(MAX_ENTRIES)
    } catch {}
}

export function storeOutgoingMessage(key, content) {
    if (!key?.id || !content || typeof content !== 'object') return false

    const serialized = serializeContent(content)
    if (!serialized || typeof serialized !== 'object') return false

    ensureLoaded()

    const record = { v: STORE_VERSION, id: key.id, jid: key.remoteJid || null, content: serialized, at: Date.now() }
    store.delete(key.id)
    store.set(key.id, record)

    try {
        prepare('INSERT INTO outgoing_messages(id, jid, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET jid = excluded.jid, content = excluded.content, created_at = excluded.created_at').run(record.id, record.jid, JSON.stringify(serialized), record.at)
    } catch {}

    prune()
    return true
}

export function getMessageForRetry(key) {
    const id = key?.id
    if (!id) return undefined

    ensureLoaded()

    const record = store.get(id)
    if (!record) return undefined

    if (Date.now() - (record.at || 0) > TTL_MS) {
        store.delete(id)
        removeFromDisk(id)
        return undefined
    }

    store.delete(id)
    store.set(id, record)
    return reviveContent(record.content)
}

export function getMessageStoreStats() {
    ensureLoaded()
    return { entries: store.size, max: MAX_ENTRIES, ttlMs: TTL_MS }
}

export function resetMessageStore() {
    store.clear()
    loaded = false
    try {
        prepare('DELETE FROM outgoing_messages').run()
    } catch {}
}
