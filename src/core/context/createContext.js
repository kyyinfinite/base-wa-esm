import messageWrapper from './wrapper.js'
import outbound from '../outbound/index.js'
import { getAdminState as resolveAdminState } from '../middleware/admin.js'

const toPayload = content => {
    if (typeof content === 'string') return { text: content }
    if (content && typeof content === 'object') return content
    return { text: String(content ?? '') }
}

const createUser = (m) => {
    const jid = m?.userJid || m?.sender
    if (!jid) return null
    const at = jid.indexOf('@')
    const user = at >= 0 ? jid.slice(0, at) : jid
    const server = at >= 0 ? jid.slice(at + 1) : ''

    return {
        id: jid,
        jid,
        user,
        server,
        number: m.identityNumber || (server === 's.whatsapp.net' ? user : null),
        pn: m.senderPn || null,
        lid: m.senderLid || null,
        isOwner: !!m.isOwner,
        isCreator: !!m.isCreator,
        isPremium: !!m.isPremium,
        firstSeen: m.userRecord?.firstSeen || null,
        lastSeen: m.userRecord?.lastSeen || null,
        limit: Number.isFinite(m.userRecord?.limit) ? m.userRecord.limit : 0
    }
}

const createGroup = (m) => {
    if (!m?.isGroup) return null

    return {
        id: m.chat,
        jid: m.chat,
        isGroup: true,
        participant: m.participant || m.sender || null,
        name: m.groupRecord?.name || '',
        createdAt: m.groupRecord?.createdAt || null,
        settings: m.groupRecord?.settings || {}
    }
}

export function createContext({
    conn,
    m,
    args = [],
    text = '',
    rawText = '',
    command = '',
    prefix = '',
    notifReply,
    accessDenied = {},
    signal = null
} = {}) {
    if (!conn) throw new TypeError('createContext requires a conn')
    if (!m) throw new TypeError('createContext requires a message')

    const chat = m.chat || m.key?.remoteJid || null
    const user = createUser(m)
    const group = createGroup(m)

    const send = async (content, options = {}, chatId = chat) => {
        if (!chatId) throw new Error('Cannot send message: chat id is missing')
        return outbound.send(chatId, toPayload(content), options)
    }

    const reply = async (content, options = {}) =>
        send(content, { quoted: m, ...options })

    const quote = async (content, options = {}) =>
        send(content, { quoted: m, ...options })

    const react = async (emoji) => {
        if (!m.key) throw new Error('Cannot react: message key is missing')

        return outbound.send(chat, {
            react: {
                text: String(emoji ?? ''),
                key: m.key
            }
        })
    }

    const context = {
        conn,
        m,
        message: m,
        chat,
        chatKey: m.chatKey || chat,
        sender: m.sender || null,
        senderPn: m.senderPn || null,
        senderLid: m.senderLid || null,
        identityNumber: m.identityNumber || null,
        identityKey: m.identityKey || m.sender || null,
        identityJids: Array.isArray(m.identityJids) ? [...m.identityJids] : [],

        args: Array.isArray(args) ? args : [],
        text: String(text ?? ''),
        rawText: String(rawText ?? ''),
        command: String(command ?? ''),
        prefix: String(prefix ?? ''),
        signal,

        user,
        group,
        isGroup: !!m.isGroup,
        isOwner: !!m.isOwner,
        isCreator: !!m.isCreator,
        isPremium: !!m.isPremium,
        isAdmin: !!m.isAdmin,
        isBotAdmin: !!m.isBotAdmin,
        fromMe: !!m.fromMe,

        
        wrapper: messageWrapper,

        
        reply,
        send,
        react,
        quote,
        notifReply: typeof notifReply === 'function' ? notifReply : reply,
        accessDenied: accessDenied && typeof accessDenied === 'object' ? accessDenied : {},

        id: m.id || m.key?.id || null,
        mtype: m.mtype || null,
        msg: m.msg || null,
        quoted: m.quoted || null
    }

    let adminStatePromise = null

    context.getAdminState = async () => {
        if (!adminStatePromise) {
            adminStatePromise = resolveAdminState(context).then(state => {
                context.isAdmin = state.isAdmin
                context.isBotAdmin = state.isBotAdmin
                return state
            })
        }
        return adminStatePromise
    }

    return context
}

export default createContext
