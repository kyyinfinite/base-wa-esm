import { prepare } from './sqlite.js'
import { toUserJid, toNumber, toLidJid } from '../../utils/identity.js'
import { peekPNForLID } from '../identity-resolver.js'
import { getDailyLimit } from '../config.js'

const now = () => new Date().toISOString()
const toEpoch = iso => Date.parse(iso)

const SELECT_COLUMNS = 'jid, name, first_seen, last_seen, remaining_limit'

function toRecord(row) {
    if (!row) return null

    return {
        jid: row.jid,
        name: row.name,
        firstSeen: new Date(row.first_seen).toISOString(),
        lastSeen: new Date(row.last_seen).toISOString(),
        limit: row.remaining_limit
    }
}

const LASTSEEN_PERSIST_MS = 60_000
const LASTSEEN_TRACK_MAX = 5000
const lastSeenPersistAt = new Map()

function pruneLastSeenTracking() {
    if (lastSeenPersistAt.size <= LASTSEEN_TRACK_MAX) return
    let removed = 0
    for (const key of lastSeenPersistAt.keys()) {
        lastSeenPersistAt.delete(key)
        if (++removed >= Math.floor(LASTSEEN_TRACK_MAX / 2)) break
    }
}

export function getUserKey(jid) {
    const value = String(jid || '').trim()
    if (!value) return null

    const pn = toUserJid(value)
    if (pn) return toNumber(pn)

    const lid = toLidJid(value)
    if (lid) {
        const mappedPn = peekPNForLID(lid)
        return mappedPn ? toNumber(mappedPn) : lid
    }

    return toNumber(value)
}

export function getUser(jid) {
    const key = getUserKey(jid)
    if (!key) return null

    const row = prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE key = ?`).get(key)
    return toRecord(row)
}

export function upsertUser({ jid, name = '', isPremium = false, isOwner = false, isCreator = false } = {}) {
    const canonicalJid = toUserJid(jid) || toLidJid(jid) || String(jid || '').trim()
    const key = getUserKey(canonicalJid)
    if (!key) return null

    const existing = prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE key = ?`).get(key)
    const timestamp = now()
    const record = {
        jid: canonicalJid,
        name: String(name || existing?.name || ''),
        firstSeen: existing ? new Date(existing.first_seen).toISOString() : timestamp,
        lastSeen: timestamp,
        limit: Number.isFinite(existing?.remaining_limit) ? existing.remaining_limit : getDailyLimit(),
        premium: !!isPremium,
        owner: !!isOwner,
        creator: !!isCreator
    }

    const isNew = !existing
    const fieldsChanged = !isNew && (
        record.name !== existing.name ||
        record.limit !== existing.remaining_limit
    )

    if (isNew || fieldsChanged) {
        prepare('INSERT INTO users(key, jid, name, first_seen, last_seen, remaining_limit) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET jid = excluded.jid, name = excluded.name, last_seen = excluded.last_seen, remaining_limit = excluded.remaining_limit').run(key, record.jid, record.name, toEpoch(record.firstSeen), toEpoch(record.lastSeen), record.limit)
    } else {
        const last = lastSeenPersistAt.get(key) || 0
        if (Date.now() - last >= LASTSEEN_PERSIST_MS) {
            lastSeenPersistAt.set(key, Date.now())
            pruneLastSeenTracking()
            prepare('UPDATE users SET last_seen = ? WHERE key = ?').run(toEpoch(record.lastSeen), key)
        }
    }

    return record
}

export function consumeUserLimit(jid, cost = 1) {
    const key = getUserKey(jid)
    if (!key) return null

    const row = prepare('UPDATE users SET remaining_limit = MAX(remaining_limit - ?, 0), last_seen = ? WHERE key = ? RETURNING jid, name, first_seen, last_seen, remaining_limit').get(cost, Date.now(), key)
    return toRecord(row)
}

export function tryConsumeUserLimit(jid, cost = 1) {
    const key = getUserKey(jid)
    if (!key) return null

    const row = prepare('UPDATE users SET remaining_limit = remaining_limit - ?, last_seen = ? WHERE key = ? AND remaining_limit >= ? RETURNING jid, name, first_seen, last_seen, remaining_limit').get(cost, Date.now(), key, cost)
    if (row) return toRecord(row)

    const exists = prepare('SELECT 1 AS found FROM users WHERE key = ?').get(key)
    return exists ? false : null
}

export function refundUserLimit(jid, cost = 1) {
    const key = getUserKey(jid)
    if (!key) return null

    const row = prepare('UPDATE users SET remaining_limit = remaining_limit + ?, last_seen = ? WHERE key = ? RETURNING jid, name, first_seen, last_seen, remaining_limit').get(cost, Date.now(), key)
    return toRecord(row)
}

export function resetAllUserLimits(defaultLimit) {
    return prepare('UPDATE users SET remaining_limit = ?').run(defaultLimit).changes
}
