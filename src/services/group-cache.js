const cache = new Map()
const inflight = new Map()
const negative = new Map()

const TTL_MS = 5 * 60_000
const MAX_ENTRIES = 500
const NEGATIVE_TTL_MS = 30_000

let boundSocket = null

export function setGroupCacheSocket(sock) {
    boundSocket = sock || null
}

export function getGroupCacheStats() {
    return { entries: cache.size, ttlMs: TTL_MS, max: MAX_ENTRIES }
}

export function resetGroupCache() {
    cache.clear()
    inflight.clear()
    negative.clear()
}

function cloneMetadata(metadata) {
    if (!metadata) return undefined
    try {
        return structuredClone(metadata)
    } catch {
        return undefined
    }
}

async function fetchMetadata(conn, jid) {
    if (!conn?.groupMetadata) return undefined
    try {
        return await conn.groupMetadata(jid)
    } catch {
        return undefined
    }
}

function touchEntry(key) {
    if (!cache.has(key)) return
    const entry = cache.get(key)
    cache.delete(key)
    cache.set(key, entry)
}

function trimCache() {
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        cache.delete(oldest)
    }
}

function isNegative(key) {
    const expiry = negative.get(key)
    if (expiry === undefined) return false
    if (expiry <= Date.now()) {
        negative.delete(key)
        return false
    }
    return true
}

export async function getCachedGroupMetadata(jid, conn = boundSocket) {
    const key = String(jid || '')
    if (!key) return undefined

    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) {
        touchEntry(key)
        return cloneMetadata(hit.metadata)
    }
    if (hit) cache.delete(key)
    if (isNegative(key)) return undefined

    const existing = inflight.get(key)
    if (existing) return existing.then(cloneMetadata)

    const pending = (async () => {
        const metadata = await fetchMetadata(conn, key)
        if (metadata) {
            cache.delete(key)
            cache.set(key, { metadata, at: Date.now() })
            negative.delete(key)
            trimCache()
            return metadata
        }
        negative.set(key, Date.now() + NEGATIVE_TTL_MS)
        return undefined
    })()

    inflight.set(key, pending)

    try {
        const metadata = await pending
        return cloneMetadata(metadata)
    } finally {
        inflight.delete(key)
    }
}

export async function getCachedGroupMetadataShared(jid, conn = boundSocket) {
    const key = String(jid || '')
    if (!key) return undefined

    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) {
        touchEntry(key)
        return hit.metadata
    }
    if (hit) cache.delete(key)

    await getCachedGroupMetadata(key, conn)

    const refreshed = cache.get(key)
    return refreshed ? refreshed.metadata : undefined
}

export function captureGroupMetadata(metadata, jid) {
    if (!metadata) return
    const key = String(jid || metadata.id || '')
    if (!key) return
    cache.delete(key)
    cache.set(key, { metadata, at: Date.now() })
    negative.delete(key)
    trimCache()
}

export function invalidateGroupMetadata(jid) {
    if (!jid) return
    const key = String(jid)
    cache.delete(key)
    negative.delete(key)
}
