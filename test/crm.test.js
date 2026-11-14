import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-crm-'))

process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    usePairingCode: true
}))

const { default: crmstore } = await import('../src/lib/crm/crmstore.js')
const { prepare, getDatabase, closeDatabase } = await import('../src/services/database/sqlite.js')
const { proto } = await import('@whiskeysockets/baileys')
const { default: connectToWhatsApp, closeActiveSocket } = await import('../src/core/app/connect.js')
const { loadPlugin, unloadPlugin } = await import('../src/core/plugin/loader.js')
const { plugins } = await import('../src/core/plugin/registry.js')

const CHAT = '628111222333@s.whatsapp.net'
const CHAT2 = '628999888777@s.whatsapp.net'
const GROUP = '120363029900000@g.us'

const resetCrmTables = () => {
    prepare('DELETE FROM crm_messages').run()
    prepare('DELETE FROM crm_nodes').run()
    prepare("DELETE FROM sqlite_sequence WHERE name = 'crm_messages'").run()
}

const waitMicrotasks = () => new Promise(resolve => setImmediate(resolve))

const makeMessage = (id, chat, text, { timestamp = 1700000000, fromMe = false, participant, message } = {}) => ({
    key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
    message: message || { conversation: text || `isi ${id}` },
    messageTimestamp: timestamp
})

const makeNode = (id, chat, content) => ({
    tag: 'message',
    attrs: { id, from: chat, type: 'text' },
    content: content || [{ tag: 'biz', attrs: {}, content: [] }]
})

function makeMockConn(id = 'conn') {
    const conn = {
        id,
        user: { id: '628000@s.whatsapp.net' },
        ev: new EventEmitter(),
        ws: new EventEmitter(),
        sent: [],
        relayed: [],
        async sendMessage(jid, content, options = {}) {
            conn.sent.push({ jid, content, options })
            return { key: { remoteJid: jid, id: `SENT-${conn.sent.length}`, fromMe: true } }
        },
        async relayMessage(jid, content, options = {}) {
            conn.relayed.push({ jid, content, options })
            return `RELAY-${id}-${conn.relayed.length}`
        },
        async waUploadToServer() {
            return { url: 'https://contoh.invalid/x' }
        }
    }
    return conn
}

function makeMockM({ chat = CHAT, quoted = null, text = '', command = 'crm', timestamp = 1700000000 } = {}) {
    const replies = []
    const reacts = []
    return {
        replies,
        reacts,
        m: {
            chat,
            sender: '628111222333@s.whatsapp.net',
            messageTimestamp: timestamp,
            message: { conversation: 'pemicu perintah' },
            key: { remoteJid: chat, fromMe: false, id: 'TRIGGER' },
            quoted,
            reply: async (t) => { replies.push(String(t)); return {} },
            react: async (e) => { reacts.push(e); return {} },
            getQuotedObj: undefined
        },
        ctx: { conn: null, text, command, args: text.split(/\s+/).filter(Boolean), prefix: '.' }
    }
}

async function runHandler(conn, mockM) {
    mockM.ctx.conn = conn
    await crmPluginHandler(mockM.m, mockM.ctx)
    return mockM
}

let crmPluginHandler = null

before(async () => {
    const handler = await import('../plugins/owner/crm.js')
    crmPluginHandler = handler.default
})

beforeEach(() => {
    resetCrmTables()
})

after(() => {
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('crmstore penyimpanan pesan (JSON-native)', () => {
    test('saveMessage dan loadMessage round-trip', () => {
        const msg = makeMessage('M1', CHAT, 'halo dunia')

        assert.equal(crmstore.saveMessage(msg, CHAT), true)
        assert.equal(crmstore.hasMessage('M1', CHAT), true)
        assert.equal(crmstore.hasMessage('M1', CHAT2), false)
        assert.equal(crmstore.hasMessage('NOPE'), false)

        const loaded = crmstore.loadMessage('M1', CHAT)
        assert.equal(loaded.message.conversation, 'halo dunia')
        assert.equal(loaded.key.id, 'M1')

        const byId = crmstore.loadMessageById('M1')
        assert.equal(byId.message.conversation, 'halo dunia')

        assert.equal(crmstore.loadMessage('M1', CHAT2), null)
        assert.equal(crmstore.loadMessage(null), null)
        assert.equal(crmstore.loadMessageById('NOPE'), null)
    })

    test('saveMessage menolak input tidak valid', () => {
        assert.equal(crmstore.saveMessage(null, CHAT), false)
        assert.equal(crmstore.saveMessage({}, CHAT), false)
        assert.equal(crmstore.saveMessage({ key: { id: 'X' } }, null), false)
    })

    test('duplikat id+chat disimpan sebagai row terpisah dan terbaru menang', () => {
        crmstore.saveMessage(makeMessage('D1', CHAT, 'versi satu'), CHAT)
        crmstore.saveMessage(makeMessage('D1', CHAT, 'versi dua'), CHAT)

        assert.equal(crmstore.countMessages(), 2)
        assert.equal(crmstore.loadMessage('D1', CHAT).message.conversation, 'versi dua')
        assert.equal(crmstore.getMessages(CHAT).length, 2)
    })

    test('rowid bersifat auto increment dan tidak dipakai ulang', () => {
        crmstore.saveMessage(makeMessage('A1', CHAT), CHAT)
        crmstore.saveMessage(makeMessage('A2', CHAT), CHAT)

        const rows = crmstore.getMessages(CHAT)
        assert.equal(rows[0].rowid, 2)
        assert.equal(rows[1].rowid, 1)

        assert.equal(crmstore.deleteMessage('A2', CHAT), true)
        crmstore.saveMessage(makeMessage('A3', CHAT), CHAT)

        const rowsAfter = crmstore.getMessages(CHAT)
        assert.equal(rowsAfter[0].rowid, 3)
        assert.equal(rowsAfter[0].id, 'A3')
    })

    test('getMessages dan getAllMessages mengembalikan baris terdekode', () => {
        crmstore.saveMessage(makeMessage('G1', CHAT, 'satu'), CHAT)
        crmstore.saveMessage(makeMessage('G2', CHAT2, 'dua'), CHAT2)
        crmstore.saveMessage(makeMessage('G3', CHAT, 'tiga'), CHAT)

        const rows = crmstore.getMessages(CHAT)
        assert.equal(rows.length, 2)
        assert.equal(rows[0].data.message.conversation, 'tiga')
        assert.deepEqual(Object.keys(rows[0]).sort(), ['chat', 'data', 'id', 'rowid', 'sender', 'timestamp'])

        const all = crmstore.getAllMessages(10)
        assert.equal(all.length, 3)
        assert.equal(all[0].id, 'G3')

        assert.deepEqual(crmstore.getMessages(CHAT, 1).map(r => r.id), ['G3'])
        assert.deepEqual(crmstore.getMessages(null), [])
    })

    test('deleteMessage menghapus pesan beserta node terkait', () => {
        crmstore.saveMessage(makeMessage('DEL1', CHAT), CHAT)
        crmstore.saveNode('DEL1', CHAT, makeNode('DEL1', CHAT))

        assert.equal(crmstore.hasMessage('DEL1', CHAT), true)
        assert.ok(crmstore.loadNode('DEL1', CHAT))

        assert.equal(crmstore.deleteMessage('DEL1', CHAT), true)

        assert.equal(crmstore.hasMessage('DEL1', CHAT), false)
        assert.equal(crmstore.loadNode('DEL1', CHAT), null)
        assert.equal(crmstore.deleteMessage(null), false)
    })
})

describe('crmstore penyimpanan node (Buffer/Base64)', () => {
    test('saveNode dan loadNode round-trip dengan konten Buffer', () => {
        const node = {
            tag: 'message',
            attrs: { id: 'N1', from: CHAT, type: 'text' },
            content: [
                { tag: 'body', attrs: {}, content: Buffer.from('payload-rahasia') }
            ]
        }

        assert.equal(crmstore.saveNode('N1', CHAT, node), true)

        const loaded = crmstore.loadNode('N1', CHAT)
        assert.equal(loaded.tag, 'message')
        assert.ok(Buffer.isBuffer(loaded.content[0].content))
        assert.equal(loaded.content[0].content.toString('utf8'), 'payload-rahasia')

        const fallback = crmstore.loadNode('N1')
        assert.ok(fallback, 'loadNode tanpa jid menemukan node lewat fallback id')

        assert.equal(crmstore.loadNode('NOPE', CHAT), null)
        assert.equal(crmstore.loadNode(null), null)
        assert.equal(crmstore.saveNode(null, CHAT, node), false)
        assert.equal(crmstore.saveNode('N1', null, node), false)
        assert.equal(crmstore.saveNode('N1', CHAT, null), false)
    })

    test('saveNode upsert memperbarui node dengan id dan chat sama', () => {
        crmstore.saveNode('U1', CHAT, makeNode('U1', CHAT, [{ tag: 'satu' }]))
        crmstore.saveNode('U1', CHAT, makeNode('U1', CHAT, [{ tag: 'dua' }]))

        const loaded = crmstore.loadNode('U1', CHAT)
        assert.equal(loaded.content[0].tag, 'dua')
        assert.equal(prepare('SELECT count(*) AS total FROM crm_nodes').get().total, 1)
    })

    test('saveAdditionalNode dan loadAdditionalNode', () => {
        assert.equal(crmstore.saveAdditionalNode('AD1', CHAT, [{ tag: 'biz', attrs: {}, content: [] }], { t: '123' }), true)

        const additional = crmstore.loadAdditionalNode('AD1', CHAT)
        assert.equal(additional[0].tag, 'biz')

        const node = crmstore.loadNode('AD1', CHAT)
        assert.equal(node.attrs.t, '123')

        crmstore.saveAdditionalNode('AD1', CHAT, [{ tag: 'biz', attrs: {}, content: [{ tag: 'baru' }] }])

        const updated = crmstore.loadAdditionalNode('AD1', CHAT)
        assert.equal(updated[0].content[0].tag, 'baru')
        assert.equal(crmstore.loadAdditionalNode('NOPE', CHAT), null)
    })

    test('loadFullMessage menggabungkan pesan dan additional node', () => {
        crmstore.saveMessage(makeMessage('F1', CHAT, 'lengkap'), CHAT)
        crmstore.saveAdditionalNode('F1', CHAT, [{ tag: 'biz', attrs: {}, content: [] }])

        const full = crmstore.loadFullMessage('F1', CHAT)
        assert.equal(full.message.message.conversation, 'lengkap')
        assert.equal(full.additionalNode[0].tag, 'biz')
    })
})

describe('crmstore query JSON-native untuk plugin', () => {
    beforeEach(() => {
        crmstore.saveMessage(makeMessage('Q1', CHAT, null, { timestamp: 100 }), CHAT)
        crmstore.saveMessage(makeMessage('Q2', CHAT, null, { timestamp: 200 }), CHAT)
        crmstore.saveMessage(makeMessage('Q3', CHAT, null, { timestamp: 300 }), CHAT)
        crmstore.saveMessage(makeMessage('Q4', CHAT, null, { timestamp: 400 }), CHAT)
        crmstore.saveMessage(makeMessage('Q5', CHAT2, null, { timestamp: 350 }), CHAT2)

        const encoded = proto.WebMessageInfo.encode(proto.WebMessageInfo.fromObject(makeMessage('QNULL', CHAT))).finish()
        prepare('INSERT INTO crm_messages(rowid, msg_id, chat, sender, ts, data) VALUES (?, ?, ?, ?, ?, ?)').run(9999, 'QNULL', CHAT, null, null, Buffer.from(encoded))
    })

    test('getMessageRowByRowid mengembalikan baris dengan data Buffer', () => {
        const row = crmstore.getMessageRowByRowid(1)

        assert.equal(row.id, 'Q1')
        assert.equal(row.chat, CHAT)
        assert.ok(Buffer.isBuffer(row.data))
        assert.equal(proto.WebMessageInfo.decode(row.data).message.conversation, 'isi Q1')

        assert.equal(crmstore.getMessageRowByRowid(9999).id, 'QNULL')
        assert.equal(crmstore.getMessageRowByRowid(123456), null)
        assert.equal(crmstore.getMessageRowByRowid('bukan-angka'), null)
    })

    test('getMessageRow dan getMessageTimestamp mengambil baris terbaru', () => {
        const row = crmstore.getMessageRow('Q1', CHAT)
        assert.equal(row.timestamp, 100)
        assert.ok(Buffer.isBuffer(row.data))

        assert.equal(crmstore.getMessageTimestamp('Q3', CHAT), 300)
        assert.equal(crmstore.getMessageTimestamp('NOPE', CHAT), null)
        assert.equal(crmstore.getMessageTimestamp(null, CHAT), null)
    })

    test('getMessagesBefore: timestamp <= referensi, terbaru duluan', () => {
        const older = crmstore.getMessagesBefore(CHAT, 300, 50)

        assert.deepEqual(older.map(r => r.id), ['Q3', 'Q2', 'Q1'])
        assert.ok(Buffer.isBuffer(older[0].data))
        assert.deepEqual(crmstore.getMessagesBefore(CHAT, 99, 50), [])
        assert.deepEqual(crmstore.getMessagesBefore(null, 300, 50), [])
        assert.deepEqual(crmstore.getMessagesBefore(CHAT, null, 50), [])
    })

    test('getMessagesAfter: timestamp > referensi, terlama duluan', () => {
        const newer = crmstore.getMessagesAfter(CHAT, 300, 50)

        assert.deepEqual(newer.map(r => r.id), ['Q4'])
        assert.deepEqual(crmstore.getMessagesAfter(CHAT, 100, 50).map(r => r.id), ['Q2', 'Q3', 'Q4'])
    })

    test('getLastChatRows: chat + timestamp <= referensi, desc lalu di-reverse plugin', () => {
        const rows = crmstore.getLastChatRows(CHAT, 400, 10)

        assert.deepEqual(rows.map(r => r.id), ['Q4', 'Q3', 'Q2', 'Q1'])
        assert.deepEqual(rows.map(r => r.rowid), [4, 3, 2, 1])
        assert.equal(rows[0].chat, CHAT)
        assert.deepEqual(crmstore.getLastChatRows(CHAT, 400, 2).map(r => r.id), ['Q4', 'Q3'])

        const reversed = [...rows].reverse()
        assert.equal(reversed[0].id, 'Q1')
    })

    test('timestamp null tidak ikut query window (semantik SQL NULL)', () => {
        const before = crmstore.getMessagesBefore(CHAT, 999999, 50)
        const after = crmstore.getMessagesAfter(CHAT, 0, 50)
        const last = crmstore.getLastChatRows(CHAT, 999999, 50)

        assert.ok(!before.some(r => r.id === 'QNULL'))
        assert.ok(!after.some(r => r.id === 'QNULL'))
        assert.ok(!last.some(r => r.id === 'QNULL'))
    })
})

describe('crmstore cleanup', () => {
    test('pesan lebih tua dari 7 hari dihapus, node yatim dibersihkan', async () => {
        const now = Math.floor(Date.now() / 1000)

        crmstore.saveMessage(makeMessage('OLD', CHAT, null, { timestamp: now - 8 * 24 * 60 * 60 }), CHAT)
        crmstore.saveMessage(makeMessage('NEW1', CHAT, null, { timestamp: now }), CHAT)
        crmstore.saveMessage(makeMessage('NEW2', CHAT, null, { timestamp: now }), CHAT)
        crmstore.saveNode('OLD', CHAT, makeNode('OLD', CHAT))
        crmstore.saveNode('NEW1', CHAT, makeNode('NEW1', CHAT))
        crmstore.saveNode('ORPHAN', CHAT, makeNode('ORPHAN', CHAT))

        await crmstore.cleanup()

        assert.equal(crmstore.hasMessage('OLD', CHAT), false)
        assert.equal(crmstore.hasMessage('NEW1', CHAT), true)
        assert.equal(crmstore.hasMessage('NEW2', CHAT), true)
        assert.equal(crmstore.loadNode('OLD', CHAT), null)
        assert.equal(crmstore.loadNode('ORPHAN', CHAT), null)
        assert.ok(crmstore.loadNode('NEW1', CHAT), 'node dengan pesan hidup tetap tersimpan')
    })

    test('MESSAGE_CACHE_LIMIT memangkas pesan terlama', async () => {
        const previous = global.MESSAGE_CACHE_LIMIT
        global.MESSAGE_CACHE_LIMIT = 2

        try {
            const now = Math.floor(Date.now() / 1000)
            crmstore.saveMessage(makeMessage('K1', CHAT, null, { timestamp: now }), CHAT)
            crmstore.saveMessage(makeMessage('K2', CHAT, null, { timestamp: now }), CHAT)
            crmstore.saveMessage(makeMessage('K3', CHAT, null, { timestamp: now }), CHAT)
            crmstore.saveMessage(makeMessage('K4', CHAT, null, { timestamp: now }), CHAT)

            await crmstore.cleanup()

            const remaining = crmstore.getAllMessages(10).map(r => r.id)
            assert.deepEqual(remaining, ['K4', 'K3'])
        } finally {
            if (previous === undefined) delete global.MESSAGE_CACHE_LIMIT
            else global.MESSAGE_CACHE_LIMIT = previous
        }
    })
})

describe('crmstore getStats', () => {
    test('statistik lengkap dengan struktur payload, files, dan ratio', () => {
        const previous = global.MESSAGE_CACHE_LIMIT
        global.MESSAGE_CACHE_LIMIT = 10

        try {
            crmstore.saveMessage(makeMessage('S1', CHAT, 'statistik'), CHAT)
            crmstore.saveNode('S1', CHAT, makeNode('S1', CHAT))

            const stats = crmstore.getStats()

            assert.equal(stats.cache.messages, 1)
            assert.equal(stats.cache.limit, 10)
            assert.equal(stats.cache.remaining, 9)
            assert.equal(stats.cache.usagePercent, '10.00%')

            assert.equal(stats.payload.messages.count, 1)
            assert.ok(stats.payload.messages.size > 0)
            assert.ok(stats.payload.messages.sizeHuman.includes('B'))
            assert.equal(stats.payload.nodes.count, 1)
            assert.ok(stats.payload.nodes.size > 0)

            assert.ok(stats.files.messages.size > 0)
            assert.ok(stats.files.nodes.size > 0)
            assert.ok(stats.files.total.size >= stats.files.messages.size + stats.files.nodes.size)

            assert.ok(stats.ratio.dbPerMessage.includes('B'))
            assert.ok(stats.ratio.nodePerMessage.includes('B'))
        } finally {
            if (previous === undefined) delete global.MESSAGE_CACHE_LIMIT
            else global.MESSAGE_CACHE_LIMIT = previous
        }
    })

    test('usagePercent infinity tanpa limit', () => {
        crmstore.saveMessage(makeMessage('S2', CHAT), CHAT)

        const stats = crmstore.getStats()
        assert.equal(stats.cache.usagePercent, '∞')
        assert.equal(stats.cache.limit, 0)
    })
})

describe('crmstore bind socket', () => {
    test('pesan masuk via messages.upsert tersimpan', () => {
        const conn = makeMockConn()
        crmstore.bind(conn)

        conn.ev.emit('messages.upsert', {
            messages: [
                makeMessage('IN1', CHAT, 'dari pengguna', { timestamp: 1700000100 }),
                makeMessage('IN2', GROUP, 'dari grup', { timestamp: 1700000101, participant: '62811@s.whatsapp.net' }),
                { key: { remoteJid: CHAT } },
                null
            ],
            type: 'notify'
        })

        assert.equal(crmstore.loadMessage('IN1', CHAT).message.conversation, 'dari pengguna')
        assert.equal(crmstore.loadMessage('IN2', GROUP).message.conversation, 'dari grup')
        assert.equal(crmstore.countMessages(), 2)
    })

    test('node WhatsApp via CB:message tersimpan dan dapat dipulihkan', () => {
        const conn = makeMockConn()
        crmstore.bind(conn)

        conn.ws.emit('CB:message', {
            tag: 'message',
            attrs: { id: 'W1', from: CHAT, type: 'text', t: '1700000000' },
            content: [
                { tag: 'participants', attrs: {}, content: Buffer.from('node-wa') }
            ]
        })

        const node = crmstore.loadNode('W1', CHAT)
        assert.equal(node.tag, 'message')
        assert.equal(node.attrs.id, 'W1')
        assert.equal(node.content[0].content.toString('utf8'), 'node-wa')
    })

    test('pesan keluar via sendMessage ter-patch tersimpan', async () => {
        const conn = makeMockConn()
        crmstore.bind(conn)

        assert.equal(conn.sendMessage.__crmStorePatched, true)

        await conn.sendMessage(CHAT, { text: 'keluar via patch' }, { messageId: 'OUT1' })
        await waitMicrotasks()

        assert.equal(conn.sent.length, 1, 'sendMessage asli tetap dipanggil')
        assert.equal(conn.sent[0].options.messageId, 'OUT1')

        const saved = crmstore.loadMessage('OUT1', CHAT)
        assert.ok(saved, 'pesan keluar tersimpan')
        assert.equal(saved.message.extendedTextMessage?.text ?? saved.message.conversation, 'keluar via patch')
    })

    test('pesan keluar via relayMessage ter-patch tersimpan', async () => {
        const conn = makeMockConn()
        crmstore.bind(conn)

        assert.equal(conn.relayMessage.__crmStorePatched, true)

        await conn.relayMessage(CHAT, { conversation: 'keluar via relay' }, { messageId: 'OUT2' })
        await waitMicrotasks()

        assert.equal(conn.relayed.length, 1)
        const saved = crmstore.loadMessage('OUT2', CHAT)
        assert.equal(saved.message.conversation, 'keluar via relay')
    })

    test('additionalNodes pada opsi sendMessage ikut tersimpan', async () => {
        const conn = makeMockConn()
        crmstore.bind(conn)

        await conn.sendMessage(CHAT, { text: 'dengan node' }, {
            messageId: 'OUT3',
            additionalNodes: [{ tag: 'biz', attrs: {}, content: [] }]
        })
        await waitMicrotasks()

        const additional = crmstore.loadAdditionalNode('OUT3', CHAT)
        assert.equal(additional[0].tag, 'biz')
    })

    test('bind dua kali pada socket sama tidak menggandakan listener', () => {
        const conn = makeMockConn()

        crmstore.bind(conn)
        crmstore.bind(conn)

        assert.equal(conn.ev.listenerCount('messages.upsert'), 1)
        assert.equal(conn.ws.listenerCount('CB:message'), 1)

        conn.ev.emit('messages.upsert', { messages: [makeMessage('DUP1', CHAT)], type: 'notify' })

        assert.equal(crmstore.countMessages(), 1)
        assert.equal(conn.sendMessage.__crmStorePatched, true)
    })

    test('bind pada socket berbeda masing-masing sekali', () => {
        const conn1 = makeMockConn('a')
        const conn2 = makeMockConn('b')

        crmstore.bind(conn1)
        crmstore.bind(conn2)

        conn1.ev.emit('messages.upsert', { messages: [makeMessage('B1', CHAT)], type: 'notify' })
        conn2.ev.emit('messages.upsert', { messages: [makeMessage('B2', CHAT)], type: 'notify' })

        assert.equal(crmstore.countMessages(), 2)
        assert.equal(conn1.ev.listenerCount('messages.upsert'), 1)
        assert.equal(conn2.ev.listenerCount('messages.upsert'), 1)
    })

    test('bind tanpa ws tidak gagal (mis. mock socket)', () => {
        const conn = makeMockConn()
        delete conn.ws

        crmstore.bind(conn)

        assert.equal(conn.ev.listenerCount('messages.upsert'), 1)
        conn.ev.emit('messages.upsert', { messages: [makeMessage('NOWS', CHAT)], type: 'notify' })
        assert.equal(crmstore.countMessages(), 1)
    })

    test('bind mengembalikan conn dan menolak nilai kosong', () => {
        const conn = makeMockConn()
        assert.equal(crmstore.bind(conn), conn)
        assert.equal(crmstore.bind(null), null)
    })
})

describe('crmstore pada lifecycle socket Base WA ESM', () => {
    function makeLifecycleConn(sockets, id) {
        const conn = makeMockConn(id)
        conn.requestPairingCode = async () => 'ABCD-EFGH'
        conn.end = async () => {
            conn.ev.emit('connection.update', {
                connection: 'close',
                lastDisconnect: { error: { output: { statusCode: 515 } } }
            })
        }
        sockets.push(conn)
        return conn
    }

    test('socket baru dari reconnect ter-bind tepat sekali, socket lama bersih', async () => {
        const sockets = []
        const created = { count: 0 }
        const createSocket = async () => {
            created.count += 1
            const sock = makeLifecycleConn(sockets, `s${created.count}`)
            return { sock, state: { creds: { registered: true } }, saveCreds: () => {} }
        }

        const first = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        await first.ev.emit('connection.update', { connection: 'open' })

        assert.equal(first.ev.listenerCount('messages.upsert'), 2, 'satu listener CRM + satu listener base')

        first.ev.emit('messages.upsert', {
            messages: [makeMessage('LC1', CHAT, 'sebelum reconnect', { timestamp: 1700000000 })],
            type: 'append'
        })
        assert.equal(crmstore.countMessages(), 1)

        await first.ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 515 } } }
        })
        await new Promise(resolve => setTimeout(resolve, 80))

        assert.equal(created.count, 2, 'socket baru dibuat')
        const second = sockets[1]
        assert.equal(second.ev.listenerCount('messages.upsert'), 2, 'socket baru ter-bind sekali')
        assert.equal(first.ev.listenerCount('messages.upsert'), 0, 'listener socket lama dibersihkan')

        first.ev.emit('messages.upsert', {
            messages: [makeMessage('LC-OLD', CHAT, 'dari socket mati', { timestamp: 1700000000 })],
            type: 'append'
        })
        assert.equal(crmstore.countMessages(), 1, 'event dari socket lama tidak menyimpan data')

        second.ev.emit('messages.upsert', {
            messages: [makeMessage('LC2', CHAT, 'sesudah reconnect', { timestamp: 1700000002 })],
            type: 'append'
        })
        assert.equal(crmstore.countMessages(), 2, 'socket baru menyimpan tanpa duplikasi')

        assert.equal(crmstore.loadMessage('LC2', CHAT).message.conversation, 'sesudah reconnect')

        await closeActiveSocket()
    })

    test('pesan tersimpan langsung ke crm_messages tanpa flush tambahan', async () => {
        const sockets = []
        const createSocket = async () => {
            const sock = makeMockConn('sh')
            sock.requestPairingCode = async () => 'ABCD-EFGH'
            sock.end = async () => {}
            sockets.push(sock)
            return { sock, state: { creds: { registered: true } }, saveCreds: () => {} }
        }

        const sock = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        sock.ev.emit('messages.upsert', {
            messages: [makeMessage('SHUT1', CHAT, 'sebelum shutdown', { timestamp: 1700000000 })],
            type: 'append'
        })

        await closeActiveSocket()

        const rows = prepare('SELECT msg_id FROM crm_messages').all()
        assert.deepEqual(rows.map(row => row.msg_id), ['SHUT1'], 'pesan CRM tersimpan ke tabel')
    })
})

describe('persistensi sql aman dan konsisten', () => {
    test('tulis aman dan konsisten: baris utuh tanpa file sementara', () => {
        crmstore.saveMessage(makeMessage('P1', CHAT, 'persist'), CHAT)
        crmstore.saveNode('P1', CHAT, makeNode('P1', CHAT))

        const leftovers = fs.readdirSync(tmp).filter(f => f.endsWith('.tmp'))
        assert.deepEqual(leftovers, [], 'tidak ada file tmp tersisa')

        const row = prepare('SELECT rowid, msg_id, chat, sender, ts, data FROM crm_messages').get()
        assert.equal(row.msg_id, 'P1')
        assert.equal(row.chat, CHAT)
        assert.ok(Buffer.isBuffer(row.data))
        assert.ok(row.data.length > 0)

        const nodeRow = prepare('SELECT msg_id, chat, data FROM crm_nodes').get()
        assert.equal(nodeRow.msg_id, 'P1')
        assert.equal(nodeRow.chat, CHAT)
        assert.equal(typeof nodeRow.data, 'string')

        assert.equal(getDatabase().pragma('integrity_check', { simple: true }), 'ok')
    })

    test('simpan dan muat ulang setelah restart (close dan buka lagi)', () => {
        crmstore.saveMessage(makeMessage('RESTART1', CHAT, 'isi restart', { timestamp: 1700000000 }), CHAT)
        crmstore.saveNode('RESTART1', CHAT, makeNode('RESTART1', CHAT))
        const rowid = crmstore.getMessages(CHAT)[0].rowid

        closeDatabase()
        getDatabase()

        assert.equal(crmstore.countMessages(), 1)
        assert.equal(crmstore.loadMessage('RESTART1', CHAT).message.conversation, 'isi restart')
        assert.equal(crmstore.loadNode('RESTART1', CHAT).tag, 'message')
        assert.equal(crmstore.getMessages(CHAT)[0].rowid, rowid)
    })

    test('cold start membaca ulang data dari disk dan lanjut rowid', () => {
        crmstore.saveMessage(makeMessage('COLD1', CHAT, 'isi dingin'), CHAT)
        crmstore.saveNode('COLD1', CHAT, makeNode('COLD1', CHAT))

        const script = [
            `process.env.WA_DATABASE_DIR = ${JSON.stringify(tmp)}`,
            `const { default: crmstore } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/crm/crmstore.js')).href)})`,
            `const loaded = crmstore.loadMessage('COLD1', ${JSON.stringify(CHAT)})`,
            `const node = crmstore.loadNode('COLD1', ${JSON.stringify(CHAT)})`,
            `console.log(JSON.stringify({`,
            `  text: loaded?.message?.conversation,`,
            `  count: crmstore.countMessages(),`,
            `  nodeTag: node?.tag,`,
            `  nodeContent: node?.content?.[0]?.tag,`,
            `  rowid: crmstore.getMessages(${JSON.stringify(CHAT)})[0]?.rowid`,
            `}))`
        ].join('\n')

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30000
        })

        assert.equal(result.status, 0, `cold start gagal: ${result.stderr}`)
        const payload = JSON.parse(result.stdout.trim().split('\n').pop())

        assert.equal(payload.text, 'isi dingin')
        assert.equal(payload.count, 1)
        assert.equal(payload.nodeTag, 'message')
        assert.equal(payload.nodeContent, 'biz')
        assert.equal(payload.rowid, 1)

        const growScript = [
            `process.env.WA_DATABASE_DIR = ${JSON.stringify(tmp)}`,
            `const { default: crmstore } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/crm/crmstore.js')).href)})`,
            `crmstore.saveMessage({ key: { remoteJid: ${JSON.stringify(CHAT)}, fromMe: false, id: 'COLD2' }, message: { conversation: 'lanjut' }, messageTimestamp: 1700000099 }, ${JSON.stringify(CHAT)})`,
            `console.log(crmstore.getMessages(${JSON.stringify(CHAT)})[0].rowid)`
        ].join('\n')

        const grow = spawnSync(process.execPath, ['--input-type=module', '-e', growScript], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30000
        })

        assert.equal(grow.status, 0, `rowid lanjutan gagal: ${grow.stderr}`)
        assert.equal(Number(grow.stdout.trim()), 2, 'rowid berlanjut dari meta, tidak restart')
    })

    test('baris data rusak tidak merusak proses (fallback aman)', () => {
        prepare('INSERT INTO crm_messages(msg_id, chat, sender, ts, data) VALUES (?, ?, ?, ?, ?)').run('CORRUPT', CHAT, null, null, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))

        const script = [
            `process.env.WA_DATABASE_DIR = ${JSON.stringify(tmp)}`,
            `const { default: crmstore } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/crm/crmstore.js')).href)})`,
            `console.log(JSON.stringify({ count: crmstore.countMessages(), null: crmstore.loadMessage('CORRUPT', ${JSON.stringify(CHAT)}) }))`
        ].join('\n')

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30000
        })

        assert.equal(result.status, 0, `proses gagal saat data rusak: ${result.stderr}`)
        const payload = JSON.parse(result.stdout.trim().split('\n').pop())
        assert.equal(payload.count, 1)
        assert.equal(payload.null, null)
    })
})

describe('perintah CRM (plugins/owner/crm.js)', () => {
    test('tanpa reply dan tanpa rowid: teks penggunaan', async () => {
        const conn = makeMockConn()
        const mock = makeMockM({ command: 'crm', text: '' })

        await runHandler(conn, mock)

        assert.equal(mock.replies.length, 1)
        assert.ok(mock.replies[0].includes('.crm #4825'))
        assert.ok(mock.replies[0].includes('.lastchat'))
    })

    test('lastchat menampilkan pesan terakhir sebelum referensi', async () => {
        crmstore.saveMessage(makeMessage('L1', CHAT, 'pesan pertama', { timestamp: 1700000100 }), CHAT)
        crmstore.saveMessage(makeMessage('L2', CHAT, 'pesan kedua', { timestamp: 1700000200 }), CHAT)
        crmstore.saveMessage(makeMessage('L3', CHAT, 'pesan ketiga', { timestamp: 1700000300 }), CHAT)
        crmstore.saveMessage(makeMessage('L4', CHAT, 'pesan keempat', { timestamp: 1700000400 }), CHAT)

        const conn = makeMockConn()
        const mock = makeMockM({
            command: 'lastchat',
            text: '2',
            quoted: { chat: CHAT, id: 'L3' }
        })

        await runHandler(conn, mock)

        assert.equal(mock.replies.length, 1)
        const text = mock.replies[0]
        assert.ok(text.includes('LAST CHAT'), 'header format asli')
        assert.ok(text.includes('2 PESAN'), 'jumlah pesan sesuai limit')
        assert.ok(text.includes('pesan kedua'))
        assert.ok(text.includes('pesan ketiga'))
        assert.ok(!text.includes('pesan pertama'), 'melebihi limit tidak ikut')
        assert.ok(!text.includes('pesan keempat'), 'pesan setelah referensi tidak ikut')
        assert.ok(text.includes('#2'), 'rowid ditampilkan')
        assert.ok(text.includes(CHAT), 'chat di kaki output')
    })

    test('lastchat tanpa pesan membalas pesan kosong', async () => {
        const conn = makeMockConn()
        const mock = makeMockM({ command: 'lastchat', text: '' })

        await runHandler(conn, mock)

        assert.equal(mock.replies.length, 1)
        assert.equal(mock.replies[0], 'Tidak ada pesan yang ditemukan.')
    })

    test('crm via reply: dokumen relay code + metadata', async () => {
        crmstore.saveMessage(makeMessage('R1', CHAT, 'target relay', { timestamp: 1700000100 }), CHAT)
        crmstore.saveNode('R1', CHAT, makeNode('R1', CHAT))

        const conn = makeMockConn()
        const mock = makeMockM({
            command: 'crm',
            text: '',
            quoted: { chat: CHAT, id: 'R1' }
        })

        await runHandler(conn, mock)

        assert.equal(conn.sent.length, 1)
        const { content, options } = conn.sent[0]
        assert.ok(content.document, 'dikirim sebagai dokumen')
        assert.equal(content.fileName, 'conversation.js')
        assert.equal(content.mimetype, 'application/javascript')
        assert.ok(options.quoted, 'dengan quoted message')

        const relayCode = content.document.toString('utf8')
        assert.ok(relayCode.includes('conn.relayMessage'), 'kode relay dihasilkan')
        assert.ok(content.caption.includes('type     : conversation'))
        assert.ok(content.caption.includes('source   : crmstore'))
        assert.ok(content.caption.includes('children : 0'))
    })

    test('crm via rowid: .crm #N mengambil langsung dari penyimpanan', async () => {
        crmstore.saveMessage(makeMessage('ROW1', CHAT, 'via rowid', { timestamp: 1700000100 }), CHAT)

        const rowid = crmstore.getMessages(CHAT)[0].rowid

        const conn = makeMockConn()
        const mock = makeMockM({ command: 'crm', text: `#${rowid}` })

        await runHandler(conn, mock)

        assert.equal(conn.sent.length, 1)
        assert.equal(conn.sent[0].content.fileName, 'conversation.js')
        assert.ok(conn.sent[0].content.document.toString('utf8').includes('via rowid'))
    })

    test('crm rowid tidak ditemukan membalas error', async () => {
        const conn = makeMockConn()
        const mock = makeMockM({ command: 'crm', text: '#99999' })

        await runHandler(conn, mock)

        assert.equal(mock.replies.length, 1)
        assert.ok(mock.replies[0].includes('#99999 tidak ditemukan'))
    })

    test('crm -raw mengirim JSON mentah sebagai balasan', async () => {
        crmstore.saveMessage(makeMessage('RAW1', CHAT, 'raw content', { timestamp: 1700000100 }), CHAT)
        crmstore.saveNode('RAW1', CHAT, makeNode('RAW1', CHAT))

        const conn = makeMockConn()
        const mock = makeMockM({
            command: 'crm',
            text: '-raw',
            quoted: { chat: CHAT, id: 'RAW1' }
        })

        await runHandler(conn, mock)

        assert.equal(mock.replies.length, 1)
        const parsed = JSON.parse(mock.replies[0])
        assert.equal(parsed.message.message.conversation, 'raw content')
        assert.equal(parsed.node.tag, 'message', 'payload raw menyertakan node')
        assert.ok(Array.isArray(parsed.additionalNodes))
    })

    test('relay: pesan di-relay ulang beserta child dengan remap id', async () => {
        crmstore.saveMessage({
            key: { remoteJid: GROUP, fromMe: false, id: 'P1', participant: '62811@s.whatsapp.net' },
            message: { conversation: 'pesan induk' },
            messageTimestamp: 1700000100
        }, GROUP)
        crmstore.saveMessage({
            key: { remoteJid: GROUP, fromMe: false, id: 'C1', participant: '62811@s.whatsapp.net' },
            message: {
                messageContextInfo: { messageAssociation: { parentMessageKey: { id: 'P1', remoteJid: GROUP, fromMe: false } } },
                conversation: 'pesan anak'
            },
            messageTimestamp: 1700000110
        }, GROUP)
        crmstore.saveMessage({
            key: { remoteJid: GROUP, fromMe: false, id: 'UNRELATED', participant: '62899@s.whatsapp.net' },
            message: { conversation: 'bukan anak' },
            messageTimestamp: 1700000120
        }, GROUP)

        const conn = makeMockConn('relay')
        const mock = makeMockM({
            chat: GROUP,
            command: 'relay',
            text: '',
            quoted: { chat: GROUP, id: 'P1' }
        })

        await runHandler(conn, mock)

        assert.ok(conn.relayed.length >= 2, 'induk dan anak di-relay')
        assert.equal(conn.relayed[0].jid, GROUP)
        assert.equal(conn.relayed[0].content.conversation, 'pesan induk')
        assert.equal(conn.relayed[1].content.conversation, 'pesan anak')

        const newParentId = conn.relayed[0] ? 'RELAY-relay-1' : null
        assert.equal(
            conn.relayed[1].content.messageContextInfo.messageAssociation.parentMessageKey.id,
            newParentId,
            'parentMessageKey anak di-remap ke id hasil relay induk'
        )
        assert.ok(!conn.relayed.some(r => r.content?.conversation === 'bukan anak'), 'pesan tak terkait tidak ikut')

        assert.equal(mock.replies.length, 1)
        assert.equal(mock.replies[0], 'RELAY-relay-1')
    })

    test('adn mengirim additionalNodes atau balasan kosong', async () => {
        crmstore.saveMessage(makeMessage('AD1X', CHAT, 'dengan node', { timestamp: 1700000100 }), CHAT)
        crmstore.saveNode('AD1X', CHAT, makeNode('AD1X', CHAT, [{ tag: 'biz', attrs: {}, content: [] }]))

        const conn = makeMockConn()
        const mock = makeMockM({ command: 'adn', text: '', quoted: { chat: CHAT, id: 'AD1X' } })

        await runHandler(conn, mock)

        assert.equal(conn.sent.length, 1)
        assert.equal(conn.sent[0].content.fileName, 'additionalNodes.json')
        assert.equal(conn.sent[0].content.mimetype, 'application/json')

        crmstore.saveMessage(makeMessage('AD2X', CHAT, 'tanpa node', { timestamp: 1700000200 }), CHAT)
        const conn2 = makeMockConn()
        const mock2 = makeMockM({ command: 'adn', text: '', quoted: { chat: CHAT, id: 'AD2X' } })

        await runHandler(conn2, mock2)

        assert.equal(mock2.replies.length, 1)
        assert.equal(mock2.replies[0], 'No AdditionalNodes captured 📷')
    })

    test('insp mengirim payload JSON dengan caption metadata', async () => {
        crmstore.saveMessage(makeMessage('INSP1', CHAT, 'inspeksi', { timestamp: 1700000100 }), CHAT)

        const conn = makeMockConn()
        const mock = makeMockM({ command: 'insp', text: '', quoted: { chat: CHAT, id: 'INSP1' } })

        await runHandler(conn, mock)

        assert.equal(conn.sent.length, 1)
        assert.equal(conn.sent[0].content.fileName, 'conversation.json')
        assert.equal(conn.sent[0].content.mimetype, 'application/json')

        const payload = JSON.parse(conn.sent[0].content.document.toString('utf8'))
        assert.equal(payload.message.message.conversation, 'inspeksi')
        assert.ok(conn.sent[0].content.caption.includes('id       :'))
    })

    test('crm2 mengirim tombol interaktif via relayMessage', async () => {
        crmstore.saveMessage(makeMessage('BTN1', CHAT, 'tombol', { timestamp: 1700000100 }), CHAT)

        const conn = makeMockConn('btn')
        const mock = makeMockM({ command: 'crm2', text: '', quoted: { chat: CHAT, id: 'BTN1' } })

        await runHandler(conn, mock)

        assert.equal(conn.relayed.length, 1)
        assert.ok(conn.relayed[0].content.interactiveMessage, 'konten interactiveMessage')
        assert.ok(Array.isArray(conn.relayed[0].options.additionalNodes))
    })

    test('quoted ala smsg base (key.id tanpa .id) tetap terselesaikan', async () => {
        crmstore.saveMessage(makeMessage('SMSG1', CHAT, 'via smsg shape', { timestamp: 1700000100 }), CHAT)

        const conn = makeMockConn()
        const mock = makeMockM({
            command: 'crm',
            text: '',
            quoted: { key: { id: 'SMSG1', remoteJid: CHAT } }
        })

        await runHandler(conn, mock)

        assert.equal(conn.sent.length, 1)
        assert.ok(conn.sent[0].content.document.toString('utf8').includes('via smsg shape'))
    })
})

describe('registrasi plugin CRM di loader', () => {
    test('plugin crm termuat dan mendaftarkan seluruh command', async () => {
        const file = path.join(root, 'plugins', 'owner', 'crm.js')

        const handler = await loadPlugin(file)
        assert.ok(handler, 'plugin crm dimuat')

        for (const cmd of ['crm', 'crm2', 'insp', 'adn', 'relay', 'lastchat']) {
            assert.ok(plugins.get(cmd), `command ${cmd} terdaftar`)
        }

        assert.equal(await unloadPlugin(file), true)
    })
})

describe('arsitektur sqlite', () => {
    test('package.json memuat better-sqlite3 versi terpasang', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

        assert.equal(pkg.dependencies['better-sqlite3'], '12.11.1')
    })

    test('crmstore tidak mengekspos handle database SQL', () => {
        assert.equal(crmstore.db, undefined)
        assert.equal(typeof crmstore.bind, 'function')
        assert.equal(typeof crmstore.saveMessage, 'function')
        assert.equal(typeof crmstore.getStats, 'function')
    })

    test('direktori lib/ root sudah tidak ada', () => {
        assert.equal(fs.existsSync(path.join(root, 'lib')), false)
        assert.equal(fs.existsSync(path.join(root, 'src', 'lib', 'crm', 'crmstore.js')), true)
    })
})
