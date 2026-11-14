import { isPnUser, isLidUser, jidDecode } from '@whiskeysockets/baileys'
import { normalizePersonalJid, toNumber } from '../utils/identity.js'
import { prepare, transaction } from './database/sqlite.js'
import { getConfig } from './config.js'

const pnToLid = new Map()
const lidToPn = new Map()
const negativeLookups = new Map()
const inflight = new Map()
const mappingListeners = new Set()

let activeSocket = null
let storeLoaded = false
let lastWrittenAt = 0

const MAX_CACHE = 10000
const NEGATIVE_TTL_MS = 5 * 60_000

export function subscribeIdentityMappings(listener) {
    if (typeof listener !== 'function') return () => {}
    mappingListeners.add(listener)
    return () => {
        mappingListeners.delete(listener)
    }
}

function notifyMappingApplied(pnUser, lidUser) {
    for (const listener of mappingListeners) {
        try {
            listener({ pn: pnUser, lid: lidUser })
        } catch {}
    }
}

function ensureLoaded() {
    if (storeLoaded) return
    storeLoaded = true
    try {
        const rows = prepare('SELECT pn, lid FROM identity_map').all()
        for (const row of rows) {
            if (typeof row.pn !== 'string' || typeof row.lid !== 'string') continue
            pnToLid.set(row.pn, row.lid)
            lidToPn.set(row.lid, row.pn)
        }
    } catch {}
}

const getMappingStore = () => activeSocket?.signalRepository?.lidMapping || null

export function setResolverSocket(sock) {
    activeSocket = sock || null
    negativeLookups.clear()
}

const jidUser = jid => {
    try {
        return jidDecode(jid)?.user || null
    } catch {
        return null
    }
}

function normalizePair(a, b) {
    const first = normalizePersonalJid(a)
    const second = normalizePersonalJid(b)
    if (!first || !second) return null

    if (isLidUser(first) && isPnUser(second)) return { lid: first, pn: second }
    if (isPnUser(first) && isLidUser(second)) return { lid: second, pn: first }
    return null
}

function trimCache() {
    if (pnToLid.size <= MAX_CACHE) return
    const excess = pnToLid.size - Math.floor(MAX_CACHE * 0.9)
    let removed = 0
    for (const pnUser of pnToLid.keys()) {
        if (removed >= excess) break
        const lidUser = pnToLid.get(pnUser)
        pnToLid.delete(pnUser)
        if (lidToPn.get(lidUser) === pnUser) lidToPn.delete(lidUser)
        removed++
    }
}

function rememberNegative(kind, user) {
    if (negativeLookups.size >= MAX_CACHE) {
        const oldest = negativeLookups.keys().next().value
        negativeLookups.delete(oldest)
    }
    negativeLookups.set(`${kind}:${user}`, Date.now() + NEGATIVE_TTL_MS)
}

function isNegative(kind, user) {
    const key = `${kind}:${user}`
    const expiry = negativeLookups.get(key)
    if (expiry === undefined) return false
    if (expiry <= Date.now()) {
        negativeLookups.delete(key)
        return false
    }
    return true
}

async function coalesce(key, task) {
    const existing = inflight.get(key)
    if (existing) return existing
    const promise = task().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
}

function identityLimit() {
    const limit = Number(getConfig().identityMaxStored)
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
}

function nextUpdatedAt() {
    lastWrittenAt = Math.max(Date.now(), lastWrittenAt + 1)
    return lastWrittenAt
}

function pruneStoredMappings() {
    const limit = identityLimit()
    if (limit <= 0) return

    const count = prepare('SELECT count(*) AS total FROM identity_map').get().total
    if (count <= limit) return

    const excess = count - limit
    prepare('DELETE FROM identity_map WHERE pn IN (SELECT pn FROM identity_map ORDER BY updated_at ASC, pn ASC LIMIT ?)').run(excess)
}

function persistPair(pnUser, lidUser) {
    transaction(() => {
        prepare('DELETE FROM identity_map WHERE lid = ? AND pn <> ?').run(lidUser, pnUser)
        prepare('INSERT INTO identity_map(pn, lid, updated_at) VALUES (?, ?, ?) ON CONFLICT(pn) DO UPDATE SET lid = excluded.lid, updated_at = excluded.updated_at').run(pnUser, lidUser, nextUpdatedAt())
        pruneStoredMappings()
    })
}

function applyLocalPair(lidJid, pnJid) {
    const lidUser = jidUser(lidJid)
    const pnUser = jidUser(pnJid)
    if (!lidUser || !pnUser) return null

    ensureLoaded()

    if (pnToLid.get(pnUser) === lidUser && lidToPn.get(lidUser) === pnUser) {
        return null
    }

    const previousLid = pnToLid.get(pnUser)
    const previousPn = lidToPn.get(lidUser)

    if (previousLid && lidToPn.get(previousLid) === pnUser) lidToPn.delete(previousLid)
    if (previousPn && pnToLid.get(previousPn) === lidUser) pnToLid.delete(previousPn)

    pnToLid.set(pnUser, lidUser)
    lidToPn.set(lidUser, pnUser)
    trimCache()

    negativeLookups.delete(`pn:${pnUser}`)
    negativeLookups.delete(`lid:${lidUser}`)

    try {
        persistPair(pnUser, lidUser)
    } catch {}

    notifyMappingApplied(pnUser, lidUser)

    return { lidUser, pnUser }
}

async function syncRemoteBatch(applied) {
    const store = getMappingStore()
    if (!store?.storeLIDPNMappings || !applied.length) return

    try {
        await store.storeLIDPNMappings(
            applied.map(({ lidUser, pnUser }) => ({ lid: `${lidUser}@lid`, pn: `${pnUser}@s.whatsapp.net` }))
        )
    } catch {}
}

export async function storeIdentityMapping(lid, pn, { syncRemote = true } = {}) {
    const pair = normalizePair(lid, pn)
    if (!pair) return false

    const applied = applyLocalPair(pair.lid, pair.pn)
    if (!applied) return false

    if (syncRemote) await syncRemoteBatch([applied])
    return true
}

export async function resolvePN(lid) {
    const lidJid = normalizePersonalJid(lid)
    if (!lidJid || !isLidUser(lidJid)) return null

    const user = jidUser(lidJid)
    ensureLoaded()

    const cached = lidToPn.get(user)
    if (cached) return `${cached}@s.whatsapp.net`

    if (isNegative('lid', user)) return null

    return coalesce(`lid:${user}`, async () => {
        const store = getMappingStore()
        if (!store?.getPNForLID) return null

        try {
            const pn = await store.getPNForLID(lidJid)
            const normalized = pn ? normalizePersonalJid(pn) : null

            if (!normalized || !isPnUser(normalized)) {
                rememberNegative('lid', user)
                return null
            }

            await storeIdentityMapping(lidJid, normalized)
            return normalized
        } catch {
            return null
        }
    })
}

export async function resolveLID(pn) {
    const pnJid = normalizePersonalJid(pn)
    if (!pnJid || !isPnUser(pnJid)) return null

    const user = jidUser(pnJid)
    ensureLoaded()

    const cached = pnToLid.get(user)
    if (cached) return `${cached}@lid`

    if (isNegative('pn', user)) return null

    return coalesce(`pn:${user}`, async () => {
        const store = getMappingStore()
        if (!store?.getLIDForPN) return null

        try {
            const lid = await store.getLIDForPN(pnJid)
            const normalized = lid ? normalizePersonalJid(lid) : null

            if (!normalized || !isLidUser(normalized)) {
                rememberNegative('pn', user)
                return null
            }

            await storeIdentityMapping(normalized, pnJid)
            return normalized
        } catch {
            return null
        }
    })
}

export async function resolveIdentity(jid) {
    const normalized = normalizePersonalJid(jid)
    if (!normalized) return { pn: null, lid: null }

    if (isPnUser(normalized)) {
        return { pn: normalized, lid: await resolveLID(normalized) }
    }

    return { pn: await resolvePN(normalized), lid: normalized }
}

export async function getIdentityJids(jid) {
    const { pn, lid } = await resolveIdentity(jid)
    return [...new Set([pn, lid].filter(Boolean))]
}

export function peekPNForLID(lid) {
    const lidJid = normalizePersonalJid(lid)
    if (!lidJid || !isLidUser(lidJid)) return null

    ensureLoaded()
    const pnUser = lidToPn.get(jidUser(lidJid))
    return pnUser ? `${pnUser}@s.whatsapp.net` : null
}

export function peekLIDForPN(pn) {
    const pnJid = normalizePersonalJid(pn)
    if (!pnJid || !isPnUser(pnJid)) return null

    ensureLoaded()
    const lidUser = pnToLid.get(jidUser(pnJid))
    return lidUser ? `${lidUser}@lid` : null
}

async function storePairs(pairs, { syncRemote = true } = {}) {
    const applied = []

    for (const [a, b] of pairs) {
        if (!a || !b) continue
        const pair = normalizePair(a, b)
        if (!pair) continue

        const result = applyLocalPair(pair.lid, pair.pn)
        if (result) applied.push(result)
    }

    if (syncRemote) await syncRemoteBatch(applied)
}

export async function captureLidMappings(mappings) {
    if (!Array.isArray(mappings)) return
    await storePairs(
        mappings.map(mapping => [mapping?.lid, mapping?.pn]).filter(([lid, pn]) => !!lid && !!pn),
        { syncRemote: false }
    )
}

export async function captureFromMessage(key) {
    if (!key) return

    await storePairs([
        [key.remoteJid, key.remoteJidAlt],
        [key.participant, key.participantAlt],
        [key.participant || key.remoteJid, key.senderPn]
    ])
}

function contactPairs(contact) {
    return [
        [contact.lid, contact.phoneNumber],
        [contact.id, contact.lid],
        [contact.id, contact.phoneNumber]
    ]
}

export async function captureFromContacts(contacts) {
    if (!Array.isArray(contacts)) return

    const pairs = []
    for (const contact of contacts) {
        if (!contact) continue
        pairs.push(...contactPairs(contact))
    }

    await storePairs(pairs)
}

export async function captureFromGroupMetadata(metadata) {
    if (!metadata) return

    const pairs = [
        [metadata.owner, metadata.ownerPn],
        [metadata.author, metadata.authorPn],
        [metadata.subjectOwner, metadata.subjectOwnerPn]
    ]

    if (Array.isArray(metadata.participants)) {
        for (const participant of metadata.participants) {
            if (!participant) continue
            pairs.push(...contactPairs(participant))
        }
    }

    await storePairs(pairs)
}

export async function resolveSenderIdentity(m) {
    const sender = normalizePersonalJid(m?.sender)
        || normalizePersonalJid(m?.key?.participant)
        || normalizePersonalJid(m?.key?.remoteJid)

    if (!sender) return { jids: [], pn: null, lid: null, number: null }

    if (isPnUser(sender)) {
        const lid = await resolveLID(sender)
        const jids = [sender]
        if (lid) jids.push(lid)
        return { jids, pn: sender, lid, number: toNumber(sender) }
    }

    const pn = await resolvePN(sender)
    const jids = [sender]
    if (pn) jids.push(pn)
    return { jids, pn, lid: sender, number: pn ? toNumber(pn) : null }
}

export function peekSenderIdentity(m) {
    const sender = normalizePersonalJid(m?.sender)
        || normalizePersonalJid(m?.key?.participant)
        || normalizePersonalJid(m?.key?.remoteJid)

    if (!sender) return { jids: [], pn: null, lid: null, number: null }

    if (isPnUser(sender)) {
        const lid = peekLIDForPN(sender)
        const jids = [sender]
        if (lid) jids.push(lid)
        return { jids, pn: sender, lid, number: toNumber(sender) }
    }

    const pn = peekPNForLID(sender)
    const jids = [sender]
    if (pn) jids.push(pn)
    return { jids, pn, lid: sender, number: pn ? toNumber(pn) : null }
}

export function getResolverStats() {
    return {
        pnCount: pnToLid.size,
        lidCount: lidToPn.size,
        negativeCount: negativeLookups.size
    }
}

export function resetResolverState() {
    pnToLid.clear()
    lidToPn.clear()
    negativeLookups.clear()
    inflight.clear()
    activeSocket = null
    storeLoaded = false
    lastWrittenAt = 0
    try {
        prepare('DELETE FROM identity_map').run()
    } catch {}
}
