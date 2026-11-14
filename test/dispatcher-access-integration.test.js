import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-dispatcher-access-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    usePairingCode: true,
    accessDenied: { limit: 'Batas penggunaan perintah ini sudah habis.' }
}))

const { parseCommand, parseButtonResponse } = await import('../src/core/dispatcher/parse.js')
const { registerPlugin, unregisterPlugin, getKeysOf } = await import('../src/core/plugin/registry.js')
const { upsertUser, getUser, consumeUserLimit } = await import('../src/services/database/users.js')
const { prepare, closeDatabase } = await import('../src/services/database/sqlite.js')
const { updateConfig } = await import('../src/services/config.js')
const dispatcherModule = await import('../src/core/dispatcher/dispatcher.js')
const handleMessage = dispatcherModule.default
const { setDispatcherReady, getDispatcherState } = dispatcherModule
const { clearCooldowns } = await import('../src/core/middleware/cooldown.js')
const { queueStats } = await import('../src/core/queue/engine.js')
const { setResolverSocket, resetResolverState } = await import('../src/services/identity-resolver.js')
const { default: connectToWhatsApp, closeActiveSocket } = await import('../src/core/app/connect.js')

const BOT_JID = '628000@s.whatsapp.net'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const makeConn = () => {
    const sent = []
    return {
        sent,
        user: { id: BOT_JID },
        sendMessage: async (jid, content, opts) => {
            sent.push({ jid, content, opts })
            return {}
        },
        groupMetadata: async () => ({ subject: 'Grup Uji' })
    }
}

const makeM = (text, {
    id = crypto.randomUUID(),
    chat = '628900@s.whatsapp.net',
    sender = '628900@s.whatsapp.net',
    fromMe = false,
    button = false
} = {}) => ({
    key: {
        remoteJid: chat,
        fromMe,
        id,
        participant: chat.endsWith('@g.us') ? sender : undefined
    },
    id,
    chat,
    sender,
    fromMe,
    isGroup: chat.endsWith('@g.us'),
    pushName: 'Tester',
    message: button
        ? { buttonsResponseMessage: { selectedButtonId: text } }
        : { conversation: text }
})

const pluginsToClean = []

function register(file, handler) {
    registerPlugin(file, handler)
    pluginsToClean.push(file)
    return handler
}

const plugin = (fn, meta = {}) => {
    const handler = async (...args) => fn(...args)
    Object.assign(handler, meta)
    return handler
}

let capturedRaw = null
let capturedText = null
let gateOpen = false
let gateWaiters = []

function makeMockSocket() {
    const listeners = new Map()
    const sent = []
    return {
        sent,
        user: { id: BOT_JID },
        sendMessage: async (jid, content, opts) => {
            sent.push({ jid, content, opts })
            return {}
        },
        ev: {
            on(event, fn) {
                if (!listeners.has(event)) listeners.set(event, [])
                listeners.get(event).push(fn)
            },
            removeAllListeners() {
                listeners.clear()
            },
            async emit(event, payload) {
                for (const fn of [...(listeners.get(event) || [])]) await fn(payload)
            },
            listenerCount(event) {
                return (listeners.get(event) || []).length
            }
        },
        async requestPairingCode() {
            return 'ABCD-EFGH'
        },
        async end() {}
    }
}

const makeCreateSocket = sockets => {
    const state = { registered: true }
    return {
        createSocket: async () => {
            const sock = makeMockSocket()
            sockets.push(sock)
            return { sock, state: { creds: state }, saveCreds: () => {} }
        }
    }
}

const openGate = () => {
    gateOpen = true
    for (const release of gateWaiters) release()
    gateWaiters = []
}

before(() => {
    register('p1://rawcapture', plugin(async (m, { context }) => {
        capturedRaw = context.rawText
        capturedText = context.text
    }, { command: ['p1rawcap'] }))

    register('p1://noprefix', plugin(async (m, { conn }) => {
        await conn.sendMessage(m.chat, { text: 'noprefix-ok' })
    }, { command: ['p1np'] }))

    register('p1://prefixless', plugin(async (m, { conn }) => {
        await conn.sendMessage(m.chat, { text: 'prefixless-ok' })
    }, { command: ['p1pl'], prefixless: true }))

    register('p1://alias', plugin(async (m, { conn }) => {
        await conn.sendMessage(m.chat, { text: 'alias-ok' })
    }, { command: ['p1al1', 'p1al2'], cooldown: 30_000 }))

    register('p1://limitcd', plugin(async (m, { conn }) => {
        await conn.sendMessage(m.chat, { text: 'limitcd-ok' })
    }, { command: ['p1lcd'], cooldown: 30_000, limit: 1 }))

    register('p1://signal', plugin(async (m, { context }) => {
        if (!(context.signal instanceof AbortSignal)) throw new Error('ctx.signal tidak tersedia')
        await new Promise((resolve, reject) => {
            if (context.signal.aborted) {
                reject(new Error('sudah dibatalkan'))
                return
            }
            context.signal.addEventListener('abort', () => reject(new Error('dibatalkan')))
        })
    }, { command: ['p1sig'], timeoutMs: 80 }))

    register('p1://gate', plugin(async () => {
        if (gateOpen) return
        await new Promise(resolve => gateWaiters.push(resolve))
    }, { command: ['p1gate'] }))
})

after(async () => {
    setDispatcherReady(true)
    for (const file of pluginsToClean) {
        unregisterPlugin(file, getKeysOf(file))
    }
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(async () => {
    setDispatcherReady(true)
    clearCooldowns()
    resetResolverState()
    setResolverSocket(null)
    await closeActiveSocket()
    gateOpen = false
    gateWaiters = []
})

describe('integration suite: filter tidak menyentuh database', () => {
    test('pesan tanpa teks tidak membuat user record', async () => {
        const conn = makeConn()
        const m = makeM('', { sender: '628910@s.whatsapp.net', chat: '628910@s.whatsapp.net' })
        await handleMessage(conn, m)

        assert.equal(getUser('628910@s.whatsapp.net'), null)
    })

    test('pesan duplikat tidak menulis ulang database', async () => {
        const conn = makeConn()
        const id = crypto.randomUUID()
        const sender = '628911@s.whatsapp.net'

        await handleMessage(conn, makeM('.p1rawcap', { id, sender, chat: sender }))
        assert.ok(getUser(sender))

        prepare('DELETE FROM users WHERE key = ?').run('628911')

        await handleMessage(conn, makeM('.p1rawcap', { id, sender, chat: sender }))
        assert.equal(getUser(sender), null, 'pesan duplikat tidak boleh menulis user record')
    })

    test('mode self memblokir non-owner tanpa tulis database', async () => {
        updateConfig({ botMode: 'self' })
        try {
            const conn = makeConn()
            const sender = '628912@s.whatsapp.net'
            await handleMessage(conn, makeM('.p1rawcap', { sender, chat: sender }))

            assert.equal(getUser(sender), null, 'tidak ada user record untuk pesan yang diblokir')

            await handleMessage(conn, makeM('.p1rawcap', { sender: BOT_JID, chat: BOT_JID, fromMe: true }))
            assert.ok(getUser(BOT_JID))
        } finally {
            updateConfig({ botMode: 'public' })
        }
    })

    test('pesan tua dibuang sebelum dispatch lewat listener', async () => {
        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const sock = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })
        try {
            await sock.ev.emit('connection.update', { connection: 'open' })
            await sleep(30)

            const oldSender = '628913@s.whatsapp.net'
            const nowSec = Math.floor(Date.now() / 1000)

            await sock.ev.emit('messages.upsert', {
                messages: [{
                    key: { remoteJid: oldSender, fromMe: false, id: 'OLD-' + crypto.randomUUID() },
                    message: { conversation: '.p1rawcap' },
                    messageTimestamp: nowSec - 7200
                }],
                type: 'notify'
            })
            await sleep(60)

            assert.equal(getUser(oldSender), null, 'pesan tua tidak boleh membuat user record')
        } finally {
            await closeActiveSocket()
            setDispatcherReady(true)
        }
    })
})

describe('integration suite: rawText multi-baris dan prefixless', () => {
    test('rawText mempertahankan baris baru dan spasi asli', async () => {
        const conn = makeConn()
        await handleMessage(conn, makeM('.p1rawcap baris1\n  baris2  x ', { sender: '628920@s.whatsapp.net', chat: '628920@s.whatsapp.net' }))

        assert.equal(capturedRaw, 'baris1\n  baris2  x')
        assert.equal(capturedText, 'baris1 baris2 x')
    })

    test('spasi di awal pesan diabaikan saat mencocokkan prefix', () => {
        const parsed = parseCommand({ text: '   .menu x' }, ['.'])
        assert.equal(parsed.command, 'menu')
        assert.equal(parsed.prefix, '.')
        assert.deepEqual(parsed.args, ['x'])
    })

    test('parse unit: rawText pada button response', () => {
        const parsed = parseButtonResponse({ text: '.p1raw x' }, ['.'])
        assert.equal(parsed.rawText, 'x')
        assert.equal(parsed.text, 'x')
    })

    test('command tanpa prefix hanya berjalan bila opt-in', async () => {
        const conn = makeConn()
        const opts = { sender: '628921@s.whatsapp.net', chat: '628921@s.whatsapp.net' }

        await handleMessage(conn, makeM('p1np', opts))
        assert.equal(conn.sent.length, 0, 'plugin tanpa prefixless tidak boleh jalan tanpa prefix')

        await handleMessage(conn, makeM('.p1np', { ...opts, sender: '628922@s.whatsapp.net', chat: '628922@s.whatsapp.net' }))
        assert.ok(conn.sent.some(s => s.content.text === 'noprefix-ok'))

        await handleMessage(conn, makeM('p1pl', { ...opts, sender: '628923@s.whatsapp.net', chat: '628923@s.whatsapp.net' }))
        assert.ok(conn.sent.some(s => s.content.text === 'prefixless-ok'), 'plugin prefixless jalan tanpa prefix')
    })

    test('config.prefixlessCommands mengaktifkan semua command satu kata', async () => {
        updateConfig({ prefixlessCommands: true })
        try {
            const conn = makeConn()
            await handleMessage(conn, makeM('p1np', { sender: '628924@s.whatsapp.net', chat: '628924@s.whatsapp.net' }))
            assert.ok(conn.sent.some(s => s.content.text === 'noprefix-ok'))
        } finally {
            updateConfig({ prefixlessCommands: false })
        }
    })
})

describe('integration suite: cooldown dan limit', () => {
    test('alias tidak melewati cooldown handler', async () => {
        const conn = makeConn()
        const opts = { sender: '628925@s.whatsapp.net', chat: '628925@s.whatsapp.net' }

        await handleMessage(conn, makeM('.p1al2', opts))
        assert.ok(conn.sent.some(s => s.content.text === 'alias-ok'))

        await handleMessage(conn, makeM('.p1al1', opts))
        assert.ok(
            conn.sent.some(s => /Tunggu/.test(String(s.content.text || ''))),
            'alias lain harus terkena cooldown command utama'
        )
        assert.equal(conn.sent.filter(s => s.content.text === 'alias-ok').length, 1)
    })

    test('penolakan limit melepas cooldown', async () => {
        const sender = '628926@s.whatsapp.net'
        upsertUser({ jid: sender })
        consumeUserLimit(sender, 5)

        const conn = makeConn()
        const opts = { sender, chat: sender }

        await handleMessage(conn, makeM('.p1lcd', opts))
        const first = conn.sent[conn.sent.length - 1]
        assert.match(String(first.content.text || ''), /Batas penggunaan/)

        await handleMessage(conn, makeM('.p1lcd', opts))
        const second = conn.sent[conn.sent.length - 1]
        assert.match(String(second.content.text || ''), /Batas penggunaan/)
        assert.doesNotMatch(String(second.content.text || ''), /Tunggu/, 'cooldown harus dilepas saat limit menolak')
    })
})

describe('integration suite: timeout task dan abort signal', () => {
    test('handler.timeoutMs membatalkan eksekusi dan melepas antrean', async () => {
        const conn = makeConn()
        const opts = { sender: '628927@s.whatsapp.net', chat: '628927@s.whatsapp.net' }

        const before = queueStats().timedOut
        await handleMessage(conn, makeM('.p1sig', opts))

        assert.ok(queueStats().timedOut >= before + 1, 'timeout tercatat di statistik')

        await handleMessage(conn, makeM('.p1rawcap', { ...opts, sender: '628928@s.whatsapp.net', chat: '628928@s.whatsapp.net' }))
        assert.ok(getUser('628928@s.whatsapp.net'), 'antrean chat tidak terblokir setelah timeout')
    })
})

describe('integration suite: overflow membalas sekali per jendela', () => {
    test('balasan sibuk hanya dikirim sekali untuk banyak overflow', async () => {
        const conn = makeConn()
        const chat = '628929@s.whatsapp.net'
        const opts = { sender: chat, chat }

        const first = handleMessage(conn, makeM('.p1gate', opts))
        await sleep(30)

        const pending = []
        for (let i = 0; i < 60; i++) {
            pending.push(handleMessage(conn, makeM('.p1gate', opts)))
        }

        await sleep(200)
        const busy = conn.sent.filter(s => /Antrean pesan sedang penuh/.test(String(s.content?.text || '')))
        assert.equal(busy.length, 1, 'balasan overflow hanya sekali per jendela waktu')
        assert.ok(queueStats().rejected >= 10, 'penolakan overflow tercatat')

        openGate()
        await first
        await Promise.allSettled(pending)
    })
})

describe('integration suite: dispatch tidak menunggu plugin dan buffer ready', () => {
    test('plugin lambat di chat A tidak menunda chat B dalam satu batch', async () => {
        register('p1://slowfast', plugin(async (m, { conn, command }) => {
            if (command === 'p1slow') {
                await sleep(250)
                await conn.sendMessage(m.chat, { text: 'slow-ok' })
                return
            }
            await conn.sendMessage(m.chat, { text: 'fast-ok' })
        }, { command: ['p1slow', 'p1fast'] }))

        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const sock = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        try {
            await sock.ev.emit('connection.update', { connection: 'open' })
            await sleep(30)

            const mk = (text, chat) => ({
                key: { remoteJid: chat, fromMe: false, id: crypto.randomUUID() },
                message: { conversation: text }
            })

            await sock.ev.emit('messages.upsert', {
                messages: [mk('.p1slow', '628930-a@s.whatsapp.net'), mk('.p1fast', '628930-b@s.whatsapp.net')],
                type: 'notify'
            })

            await sleep(80)
            assert.ok(sock.sent.some(s => s.content.text === 'fast-ok'), 'chat cepat selesai duluan')
            assert.equal(sock.sent.some(s => s.content.text === 'slow-ok'), false, 'chat lambat masih berjalan')

            await sleep(300)
            assert.ok(sock.sent.some(s => s.content.text === 'slow-ok'))
        } finally {
            unregisterPlugin('p1://slowfast', getKeysOf('p1://slowfast'))
            pluginsToClean.splice(pluginsToClean.indexOf('p1://slowfast'), 1)
            await closeActiveSocket()
            setDispatcherReady(true)
        }
    })

    test('pesan sebelum ready ditunda dan diproses setelah ready', async () => {
        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const sock = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        try {
            await sock.ev.emit('messages.upsert', {
                messages: [{
                    key: { remoteJid: '628931@s.whatsapp.net', fromMe: false, id: 'PREREADY1' },
                    message: { conversation: '.p1pl' }
                }],
                type: 'notify'
            })
            await sleep(60)

            assert.equal(getDispatcherState().ready, false, 'dispatcher belum ready sebelum open')
            assert.equal(sock.sent.length, 0, 'pesan belum diproses sebelum ready')

            await sock.ev.emit('connection.update', { connection: 'open' })
            await sleep(100)

            assert.equal(getDispatcherState().ready, true)
            assert.ok(sock.sent.some(s => s.content.text === 'prefixless-ok'), 'pesan buffer diproses setelah ready')
        } finally {
            await closeActiveSocket()
            setDispatcherReady(true)
        }
    })
})
