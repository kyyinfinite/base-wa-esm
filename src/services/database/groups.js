import { prepare } from './sqlite.js'

const now = () => new Date().toISOString()
const toEpoch = iso => Date.parse(iso)

export function getGroupKey(jid) {
    const value = String(jid || '').trim()
    return value.endsWith('@g.us') ? value : null
}

export function getGroup(jid) {
    const key = getGroupKey(jid)
    if (!key) return null

    const row = prepare('SELECT jid, name, created_at, settings FROM wa_groups WHERE jid = ?').get(key)
    if (!row) return null

    let settings = {}
    try {
        const parsed = JSON.parse(row.settings)
        if (parsed && typeof parsed === 'object') settings = parsed
    } catch {}

    return {
        jid: row.jid,
        name: row.name,
        createdAt: new Date(row.created_at).toISOString(),
        settings
    }
}

export function upsertGroup({ jid, name = '', settings } = {}) {
    const key = getGroupKey(jid)
    if (!key) return null

    const existing = getGroup(key)
    const record = {
        jid: key,
        name: String(name || existing?.name || ''),
        createdAt: existing?.createdAt || now(),
        settings: settings && typeof settings === 'object'
            ? settings
            : (existing?.settings && typeof existing.settings === 'object' ? existing.settings : {})
    }

    const isNew = !existing
    const changed = isNew ||
        record.name !== existing.name ||
        JSON.stringify(record.settings) !== JSON.stringify(existing.settings)

    if (changed) {
        prepare('INSERT INTO wa_groups(jid, name, created_at, settings) VALUES (?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name, settings = excluded.settings').run(key, record.name, toEpoch(record.createdAt), JSON.stringify(record.settings))
    }

    return record
}
