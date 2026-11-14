import { getCachedGroupMetadata } from '../../services/group-cache.js'
import { resolveSenderIdentity, peekPNForLID, peekLIDForPN } from '../../services/identity-resolver.js'

const normalize = (conn, jid) => {
    if (!jid) return ''
    return String(conn?.decodeJid?.(jid) || jid).toLowerCase()
}

function participantJids(conn, participant) {
    if (!participant) return []
    const raw = [
        participant.id,
        participant.jid,
        participant.lid,
        participant.phoneNumber
    ]
    return [...new Set(raw.filter(Boolean).map(jid => normalize(conn, jid)))]
}

function botJids(conn) {
    const user = conn?.user
    if (!user) return []
    const raw = [user.id, user.jid, user.lid, user.phoneNumber]
    return [...new Set(raw.filter(Boolean).map(jid => normalize(conn, jid)))]
}

async function expandIdentities(conn, jids) {
    const expanded = new Set(jids.map(jid => normalize(conn, jid)))

    for (const jid of jids) {
        const normalized = normalize(conn, jid)
        const lid = peekLIDForPN(normalized)
        const pn = peekPNForLID(normalized)
        if (lid) expanded.add(normalize(conn, lid))
        if (pn) expanded.add(normalize(conn, pn))
    }

    return expanded
}

async function findParticipant(conn, participants, targetIds) {
    for (const participant of participants) {
        const ids = participantJids(conn, participant)
        for (const target of targetIds) {
            if (ids.includes(target)) return participant
        }
    }
    return null
}

const isAdminParticipant = participant =>
    participant?.admin === 'admin' || participant?.admin === 'superadmin'

async function getAdminState(ctx) {
    if (!ctx.isGroup) return { isAdmin: false, isBotAdmin: false }
    if (ctx.m?.isAdmin !== undefined && ctx.m?.isBotAdmin !== undefined) {
        return { isAdmin: !!ctx.m.isAdmin, isBotAdmin: !!ctx.m.isBotAdmin }
    }

    const conn = ctx.conn
    const metadata = await getCachedGroupMetadata(ctx.chat, conn)
    const participants = metadata?.participants || []

    const source = ctx.m && typeof ctx.m === 'object' ? ctx.m : {}
    const sender = source.sender || ctx.sender
    const identity = await resolveSenderIdentity({ ...source, sender })
    const senderIds = await expandIdentities(conn, identity.jids)

    const bots = botJids(conn)
    const botIds = await expandIdentities(conn, bots)

    const senderParticipant = await findParticipant(conn, participants, [...senderIds])
    const botParticipant = await findParticipant(conn, participants, [...botIds])

    const state = {
        isAdmin: isAdminParticipant(senderParticipant),
        isBotAdmin: isAdminParticipant(botParticipant)
    }

    ctx.isAdmin = state.isAdmin
    ctx.isBotAdmin = state.isBotAdmin
    if (ctx.m) {
        ctx.m.isAdmin = state.isAdmin
        ctx.m.isBotAdmin = state.isBotAdmin
    }
    if (ctx.group) {
        ctx.group.isAdmin = state.isAdmin
        ctx.group.isBotAdmin = state.isBotAdmin
    }

    return state
}

export async function adminMiddleware(ctx, handler) {
    if (!handler.admin) return null

    try {
        const { isAdmin } = await getAdminState(ctx)
        if (isAdmin) return null
    } catch (error) {
        console.error('[MIDDLEWARE] Failed to resolve group admin state:', error)
    }

    return {
        allowed: false,
        title: 'Admin Only',
        message: ctx.accessDenied?.admin || 'Perintah ini hanya dapat digunakan oleh admin group.'
    }
}

export { getAdminState }
