import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-outbound-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    outboundMinIntervalMs: 120,
    outboundMaxRetries: 3
}))

const { createOutbound } = await import('../src/core/outbound/queue.js')
const { updateConfig } = await import('../src/services/config.js')
const { closeDatabase } = await import('../src/services/database/sqlite.js')
const { events } = await import('../src/core/events/engine.js')
const { default: connectToWhatsApp, closeActiveSocket } = await import('../src/core/app/connect.js')
const { resetResolverState } = await import('../src/services/identity-resolver.js')
const { resetGroupCache } = await import('../src/services/group-cache.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const makeSock = (behavior = {}) => {
    const calls = []
    const sock = {
        user: { id: '628000@s.whatsapp.net' },
        calls,
        sendMessage: async (jid, content, options) => {
            calls.push({ jid, content, options, fn: 'first' })
            if (behavior.failTimes) {
                behavior.failTimes -= 1
                const error = new Error(behavior.errorMessage || 'rate-overlimit')
                error.output = { statusCode: behavior.statusCode ?? 429 }
                throw error
            }
            if (behavior.alwaysFail) {
                const error = new Error(behavior.errorMessage || 'rate-overlimit')
                error.output = { statusCode: behavior.statusCode ?? 429 }
                throw error
            }
            return { sent: true, jid }
        },
        ev: {
            on() {},
            removeAllListeners() {},
            async emit() {}
        }
    }
    return sock
}

beforeEach(async () => {
    await closeActiveSocket()
    resetResolverState()
    resetGroupCache()
})

after(async () => {
    await closeActiveSocket()
    updateConfig({ outboundMinIntervalMs: 120, outboundMaxRetries: 3 })
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('integration suite: outbound throttle dan retry', () => {
    test('jeda minimal per chat dijaga', async () => {
        const sock = makeSock()
        const outbound = createOutbound(() => sock, { retryBaseMs: 10 })

        const started = Date.now()
        await outbound.send('628100@s.whatsapp.net', { text: 'satu' })
        await outbound.send('628100@s.whatsapp.net', { text: 'dua' })
        const elapsed = Date.now() - started

        assert.ok(elapsed >= 100, `jeda antar kirim terjaga, lewat ${elapsed}ms`)
        assert.equal(sock.calls.length, 2)
    })

    test('chat berbeda tidak saling menunggu throttle', async () => {
        const sock = makeSock()
        const outbound = createOutbound(() => sock, { retryBaseMs: 10 })

        const started = Date.now()
        await Promise.all([
            outbound.send('628201@s.whatsapp.net', { text: 'a' }),
            outbound.send('628202@s.whatsapp.net', { text: 'b' }),
            outbound.send('628203@s.whatsapp.net', { text: 'c' })
        ])
        const elapsed = Date.now() - started

        assert.ok(elapsed < 100, `kirim paralel tidak menunggu jeda chat lain, lewat ${elapsed}ms`)
        assert.equal(sock.calls.length, 3)
    })

    test('rate-limit dicoba ulang dengan backoff lalu berhasil', async () => {
        const sock = makeSock({ failTimes: 2 })
        const outbound = createOutbound(() => sock, { retryBaseMs: 15, retryMaxMs: 40 })

        const result = await outbound.send('628300@s.whatsapp.net', { text: 'tahan' })

        assert.deepEqual(result, { sent: true, jid: '628300@s.whatsapp.net' })
        assert.equal(sock.calls.length, 3, 'dua percobaan gagal lalu berhasil')
        const stats = outbound.stats()
        assert.equal(stats.retried, 2)
        assert.equal(stats.sent, 1)
        assert.equal(stats.failed, 0)
    })

    test('error validasi tidak dicoba ulang', async () => {
        const sock = makeSock({ failTimes: 1, statusCode: 400, errorMessage: 'bad request' })
        const outbound = createOutbound(() => sock, { retryBaseMs: 10 })

        await assert.rejects(
            () => outbound.send('628301@s.whatsapp.net', { text: 'salah' }),
            /bad request/
        )
        assert.equal(sock.calls.length, 1, 'tidak ada percobaan ulang untuk error validasi')
        assert.equal(outbound.stats().failed, 1)
    })

    test('rate-limit melebihi batas percobaan gagal permanen', async () => {
        updateConfig({ outboundMaxRetries: 1 })
        try {
            const sock = makeSock({ alwaysFail: true })
            const outbound = createOutbound(() => sock, { retryBaseMs: 10 })

            await assert.rejects(
                () => outbound.send('628302@s.whatsapp.net', { text: 'kebanjiran' }),
                /rate-overlimit/
            )
            assert.equal(sock.calls.length, 2, 'satu retry lalu berhenti sesuai konfigurasi')
        } finally {
            updateConfig({ outboundMaxRetries: 3 })
        }
    })

    test('sendMessage selalu dicari saat eksekusi, bukan referensi cache', async () => {
        const sock = makeSock()
        const outbound = createOutbound(() => sock)

        await outbound.send('628303@s.whatsapp.net', { text: 'pertama' })
        assert.equal(sock.calls[0].fn, 'first')

        const second = async (jid, content) => ({ jid, content, via: 'second' })
        sock.sendMessage = second

        const result = await outbound.send('628303@s.whatsapp.net', { text: 'kedua' })
        assert.deepEqual(result, { jid: '628303@s.whatsapp.net', content: { text: 'kedua' }, via: 'second' })
    })

    test('socket tidak aktif melempar error jelas', async () => {
        const outbound = createOutbound(() => null)
        await assert.rejects(
            () => outbound.send('628304@s.whatsapp.net', { text: 'x' }),
            /socket WhatsApp tidak aktif/
        )
    })

    test('pesan tetap lewat conn.sendMessage milik conn aktif', async () => {
        const sock = makeSock()
        const outbound = createOutbound(() => sock)
        await outbound.send('628305@s.whatsapp.net', { text: 'lewat-conn' })
        assert.equal(sock.calls.length, 1)
        assert.deepEqual(sock.calls[0].content, { text: 'lewat-conn' })
    })
})

describe('integration suite: jembatan event dengan guard generasi', () => {
    function makeBridgeSocket() {
        const listeners = new Map()
        return {
            user: { id: '628000@s.whatsapp.net' },
            sendMessage: async () => ({}),
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

    const makeCreateSocket = sockets => ({
        createSocket: async () => {
            const sock = makeBridgeSocket()
            sockets.push(sock)
            return { sock, state: { creds: { registered: true } }, saveCreds: () => {} }
        }
    })

    test('wa:reaction, wa:call, wa:presence, wa:update, dan wa:group diteruskan ke bus', async () => {
        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const sock = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        const seen = {}
        const handlers = {
            'wa:reaction': payload => { seen.reaction = payload },
            'wa:call': payload => { seen.call = payload },
            'wa:presence': payload => { seen.presence = payload },
            'wa:update': payload => { seen.update = payload },
            'wa:group': payload => { seen.group = payload }
        }
        for (const [event, handler] of Object.entries(handlers)) events.on(event, handler)

        try {
            await sock.ev.emit('messages.reaction', [{ key: { id: 'R1' }, reaction: { text: '👍' } }])
            await sock.ev.emit('call', [{ id: 'C1', from: '628111@s.whatsapp.net' }])
            await sock.ev.emit('presence.update', { id: '628111@s.whatsapp.net', presences: {} })
            await sock.ev.emit('messages.update', [{ key: { id: 'U1' } }])
            await sock.ev.emit('group-participants.update', {
                id: '120363000@g.us',
                participants: [{ id: '628111@s.whatsapp.net' }],
                action: 'add'
            })

            assert.equal(seen.reaction[0].key.id, 'R1')
            assert.equal(seen.call[0].id, 'C1')
            assert.equal(seen.presence.id, '628111@s.whatsapp.net')
            assert.equal(seen.update[0].key.id, 'U1')
            assert.equal(seen.group.source, 'group-participants.update')
            assert.equal(seen.group.id, '120363000@g.us')
        } finally {
            for (const [event, handler] of Object.entries(handlers)) events.off(event, handler)
            await closeActiveSocket()
        }
    })

    test('handler bus yang melempar tidak menjatuhkan bot', async () => {
        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const sock = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        const errors = []
        const onBotError = payload => errors.push(payload)
        const boom = () => { throw new Error('handler plugin melempar') }

        events.on('bot:error', onBotError)
        events.on('wa:reaction', boom)
        try {
            await sock.ev.emit('messages.reaction', [{ key: { id: 'R2' } }])
            assert.equal(errors.length, 1)
            assert.equal(errors[0].scope, 'event:bridge')
        } finally {
            events.off('bot:error', onBotError)
            events.off('wa:reaction', boom)
            await closeActiveSocket()
        }
    })

    test('event dari socket lama tidak diteruskan setelah reconnect', async () => {
        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const first = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        await first.ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 515 } } }
        })
        await sleep(60)

        const count = { group: 0 }
        const onGroup = () => { count.group += 1 }
        events.on('wa:group', onGroup)
        try {
            await first.ev.emit('groups.update', [{ id: '120363001@g.us', subject: 'Dari Socket Basi' }])
            assert.equal(count.group, 0, 'event socket lama diabaikan')
        } finally {
            events.off('wa:group', onGroup)
            await closeActiveSocket()
        }
    })

    test('bot:ready dan bot:disconnect tersedia di bus', async () => {
        const sockets = []
        const { createSocket } = makeCreateSocket(sockets)
        const seen = { ready: 0, disconnect: 0 }
        const onReady = () => { seen.ready += 1 }
        const onDisconnect = () => { seen.disconnect += 1 }

        events.on('bot:ready', onReady)
        events.on('bot:disconnect', onDisconnect)
        try {
            const sock = await connectToWhatsApp({
                createSocket,
                reconnectDelay: () => 15,
                initPluginStack: async () => {}
            })
            await sock.ev.emit('connection.update', { connection: 'open' })
            await sleep(40)
            assert.equal(seen.ready, 1)

            await closeActiveSocket()
            await sleep(20)
            assert.ok(seen.disconnect >= 1)
        } finally {
            events.off('bot:ready', onReady)
            events.off('bot:disconnect', onDisconnect)
        }
    })
})
