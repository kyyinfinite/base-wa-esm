import { prepare } from './database/sqlite.js'
import { toUserJid, toNumber, getConfiguredNumbers } from '../utils/identity.js'

const nowMs = () => Date.now()

function createRoleStore(role) {
    let cachedAll = null
    let cachedNumbers = null

    const invalidate = () => {
        cachedAll = null
        cachedNumbers = null
    }

    const loadAll = () => {
        if (cachedAll) return cachedAll

        const rows = prepare('SELECT jid FROM access_roles WHERE role = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, number').all(role, nowMs())
        cachedAll = rows.map(row => row.jid)
        return cachedAll
    }

    const numbers = () => {
        if (!cachedNumbers) cachedNumbers = Object.freeze(getConfiguredNumbers(loadAll()))
        return cachedNumbers
    }

    return {
        all: () => loadAll(),
        numbers,
        has: value => {
            const number = toNumber(value)
            if (!number) return false
            return numbers().includes(number)
        },
        add: value => {
            const jid = toUserJid(value)
            if (!jid) throw new TypeError('Nomor tidak valid')

            const number = toNumber(jid)
            if (numbers().includes(number)) return false

            prepare('INSERT INTO access_roles(number, role, jid, created_at, expires_at) VALUES (?, ?, ?, ?, NULL)').run(number, role, jid, nowMs())
            invalidate()
            return true
        },
        remove: value => {
            const number = toNumber(value)
            if (!number) return false

            const result = prepare('DELETE FROM access_roles WHERE number = ? AND role = ?').run(number, role)
            invalidate()
            return result.changes > 0
        }
    }
}

export const owners = createRoleStore('owner')
export const premiums = createRoleStore('premium')
