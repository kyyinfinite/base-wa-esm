import { prepare } from './sqlite.js'

export function getSetting(key) {
    if (typeof key !== 'string' || !key) return null

    const row = prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (!row) return null

    try {
        const parsed = JSON.parse(row.value)
        return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
        return null
    }
}

export function setSetting(key, value) {
    if (typeof key !== 'string' || !key) return value

    const safeValue = value && typeof value === 'object' ? value : {}
    prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(safeValue), Date.now())
    return safeValue
}
