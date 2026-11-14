import { isJidStatus, isJidBroadcast, isJidNewsletter } from '../../utils/jid.js'
import { getConfig } from '../../services/config.js'

export function isDispatchableUpsertType(type) {
    return type === 'notify'
}

function toTimestampSeconds(raw) {
    let value = raw
    if (value && typeof value.toNumber === 'function') value = value.toNumber()
    value = Number(value)
    if (!Number.isFinite(value) || value <= 0) return null
    if (value > 1e12) value = Math.floor(value / 1000)
    return value
}

export function isMessageTooOld(mek, maxAgeSec) {
    if (!mek || !mek.key) return false
    if (mek.key.fromMe) return false

    const limit = Number(maxAgeSec === undefined ? getConfig().maxMessageAgeSec : maxAgeSec)
    if (!Number.isFinite(limit) || limit <= 0) return false

    const at = toTimestampSeconds(mek.messageTimestamp)
    if (at === null) return false

    return Math.floor(Date.now() / 1000) - at > limit
}

export function isDispatchableMessage(mek) {
    if (!mek?.message) return false

    const jid = mek.key?.remoteJid
    if (!jid) return false
    if (isJidStatus(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return false
    if (isMessageTooOld(mek)) return false

    return true
}
