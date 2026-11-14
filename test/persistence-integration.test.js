import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-persistence-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_OWNER_PATH = path.join(tmp, 'owner.json')
process.env.WA_PREMIUM_PATH = path.join(tmp, 'premium.json')
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: []
}))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const { prepare, closeDatabase } = await import('../src/services/database/sqlite.js')
const { storeOutgoingMessage } = await import('../src/services/message-store.js')
const { default: connectToWhatsApp, closeActiveSocket } = await import('../src/core/app/connect.js')
const { getConnectionStatus } = await import('../src/core/app/connect.js')
const { resetResolverState, setResolverSocket } = await import('../src/services/identity-resolver.js')
const { resetGroupCache } = await import('../src/services/group-cache.js')
const { resetMessageStore } = await import('../src/services/message-store.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const runNode = script => new Promise((resolve, reject) => {
    execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        { cwd: ROOT, env: process.env },
        (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stderr}`))
            else resolve(stdout.trim())
        }
    )
})

function makeMockSocket() {
    const listeners = new Map()
    return {
        user: { id: '628000@s.whatsapp.net' },
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

const makeCreateSocket = (sockets, auths) => {
    const state = { registered: true }
    return {
        createSocket: async ({ auth }) => {
            auths.push(auth ?? null)
            const sock = makeMockSocket()
            sockets.push(sock)
            return { sock, state: { creds: state }, saveCreds: () => {} }
        }
    }
}

beforeEach(async () => {
    await closeActiveSocket()
    resetResolverState()
    resetGroupCache()
})

after(async () => {
    await closeActiveSocket()
    resetResolverState()
    resetMessageStore()
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('integration suite: message-store BufferJSON', () => {
    beforeEach(() => {
        resetMessageStore()
    })

    test('konten biner pulih setelah restart proses baru', async () => {
        const bytes = Buffer.from([104, 97, 108, 111, 0, 1, 2, 255])
        storeOutgoingMessage(
            { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'BIN1' },
            { conversation: 'tes biner', imageMessage: { jpegThumbnail: bytes } }
        )

        const script = [
            `process.env.WA_DATABASE_DIR = ${JSON.stringify(tmp)}`,
            `const { getMessageForRetry } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/services/message-store.js')).href)})`,
            `const content = getMessageForRetry({ id: 'BIN1' })`,
            `const thumb = content?.imageMessage?.jpegThumbnail`,
            `console.log(JSON.stringify({ conversation: content?.conversation, isBuffer: Buffer.isBuffer(thumb), hex: thumb ? thumb.toString('hex') : null }))`
        ].join('\n')

        const output = await runNode(script)
        const parsed = JSON.parse(output)

        assert.equal(parsed.conversation, 'tes biner')
        assert.equal(parsed.isBuffer, true, 'field biner menjadi Buffer setelah restart')
        assert.equal(parsed.hex, bytes.toString('hex'), 'isi byte identik')
    })

    test('rekaman kedaluwarsa dibuang saat dimuat', async () => {
        resetMessageStore()
        prepare('INSERT INTO outgoing_messages(id, jid, content, created_at) VALUES (?, ?, ?, ?)').run('LEGACY1', '628111@s.whatsapp.net', JSON.stringify({ conversation: 'lama' }), Date.now() - 2 * 60 * 60_000)

        const script = [
            `process.env.WA_DATABASE_DIR = ${JSON.stringify(tmp)}`,
            `const { getMessageForRetry } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/services/message-store.js')).href)})`,
            `const { prepare } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/services/database/sqlite.js')).href)})`,
            `const nilai = getMessageForRetry({ id: 'LEGACY1' })`,
            `const sisa = prepare('SELECT 1 AS found FROM outgoing_messages WHERE id = ?').get('LEGACY1')`,
            `console.log(JSON.stringify({ nilai, tersisa: sisa === undefined ? [] : ['LEGACY1'] }))`
        ].join('\n')

        const output = await runNode(script)
        const parsed = JSON.parse(output)

        assert.equal(parsed.nilai, undefined, 'rekaman kedaluwarsa tidak diteruskan')
        assert.deepEqual(parsed.tersisa, [], 'rekaman kedaluwarsa dihapus dari tabel')
    })
})

describe('integration suite: auth store', () => {
    test('authStore kustom dipakai saat auth belum tersedia', async () => {
        const loads = []
        const customAuthStore = {
            load: async () => {
                loads.push(1)
                return {
                    state: { creds: { registered: true } },
                    saveCreds: () => {}
                }
            }
        }

        const sockets = []
        const created = []
        const createSocket = async ({ auth, authStore }) => {
            created.push({ auth: auth ?? null })
            const sock = makeMockSocket()
            sockets.push(sock)
            const { state, saveCreds } = auth || (await authStore.load())
            return { sock, state, saveCreds }
        }

        const sock = await connectToWhatsApp({
            createSocket,
            authStore: customAuthStore,
            reconnectDelay: () => 15,
            initPluginStack: async () => {}
        })

        assert.ok(sock, 'socket dibuat memakai authStore kustom')
        assert.equal(loads.length, 1, 'authStore.load dipanggil saat auth belum ada')
        assert.equal(created[0].auth, null)

        await closeActiveSocket()
    })
})

describe('integration suite: batas badSession dan connectionReplaced', () => {
    const driveDisconnects = async statusCode => {
        const sockets = []
        const auths = []
        const { createSocket } = makeCreateSocket(sockets, auths)

        const first = await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 10,
            initPluginStack: async () => {}
        })
        first.ev.emit('connection.update', { connection: 'open' })

        for (let i = 0; i < 5; i++) {
            const sock = sockets[sockets.length - 1]
            sock.ev.emit('connection.update', {
                connection: 'close',
                lastDisconnect: { error: { output: { statusCode } } }
            })
            await sleep(60)
        }

        await sleep(120)
        return { sockets, auths }
    }

    test('badSession berhenti setelah 5 kali berturut-turut', async () => {
        const { sockets, auths } = await driveDisconnects(500)

        assert.equal(sockets.length, 5, `socket dibuat 5 kali, dibuat ${sockets.length}`)
        assert.ok(auths.every(auth => auth === null), 'auth lama tidak dipakai ulang setelah badSession')
    })

    test('connectionReplaced berhenti setelah 5 kali berturut-turut', async () => {
        const { sockets } = await driveDisconnects(440)

        assert.equal(sockets.length, 5, `socket dibuat 5 kali, dibuat ${sockets.length}`)
    })

    test('streak reset saat koneksi open', async () => {
        const sockets = []
        const auths = []
        const { createSocket } = makeCreateSocket(sockets, auths)

        await connectToWhatsApp({
            createSocket,
            reconnectDelay: () => 10,
            initPluginStack: async () => {}
        })
        sockets[0].ev.emit('connection.update', { connection: 'open' })

        for (let round = 0; round < 3; round++) {
            const closing = sockets[sockets.length - 1]
            closing.ev.emit('connection.update', {
                connection: 'close',
                lastDisconnect: { error: { output: { statusCode: 500 } } }
            })
            await sleep(60)

            const current = sockets[sockets.length - 1]
            current.ev.emit('connection.update', { connection: 'open' })
            await sleep(10)
        }

        assert.ok(sockets.length >= 4, `badSession dengan open di antaranya tidak berhenti, dibuat ${sockets.length}`)
        assert.equal(getConnectionStatus().state, 'open')

        await closeActiveSocket()
    })
})
