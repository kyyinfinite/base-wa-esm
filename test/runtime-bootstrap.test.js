import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-runtime-bootstrap-'))
process.env.WA_DATABASE_DIR = tmpRoot
process.env.WA_CONFIG_PATH = path.join(tmpRoot, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    usePairingCode: true
}))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')

const shellPlugin = await import('../plugins/shell/shell.js')
const evalPlugin = await import('../plugins/shell/eval.js')
const { updateConfig, getConfig } = await import('../src/services/config.js')
const { closeDatabase } = await import('../src/services/database/sqlite.js')
const { upsertUser, getUser, tryConsumeUserLimit } = await import('../src/services/database/users.js')
const limitReset = await import('../src/core/scheduler/limitReset.js')
const connectModule = await import('../src/core/app/connect.js')
const { default: connectToWhatsApp, closeActiveSocket } = connectModule
const { events } = await import('../src/core/events/engine.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makePairingSocket(requests) {
    const listeners = new Map()
    const sock = {
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
        async requestPairingCode(number) {
            requests.push(number)
            return 'ABCD-EFGH'
        },
        async end() {}
    }
    return sock
}

const makeCreateSocket = sockets => {
    const shared = { registered: false }
    const createSocket = async () => {
        const requests = []
        const sock = makePairingSocket(requests)
        sockets.push({ sock, requests })
        return {
            sock,
            state: { creds: { registered: shared.registered } },
            saveCreds: () => {}
        }
    }
    return { createSocket, shared }
}

const quickBackoff = () => 15

async function withConnection(options, fn) {
    const sockets = []
    const { createSocket } = makeCreateSocket(sockets)
    const sock = await connectToWhatsApp({
        createSocket,
        reconnectDelay: quickBackoff,
        initPluginStack: async () => {},
        ...options
    })
    try {
        return await fn(sockets, sock)
    } finally {
        await closeActiveSocket()
    }
}

beforeEach(async () => {
    await closeActiveSocket()
})

before(() => {
    updateConfig({ pairingNumber: '', timezone: 'Asia/Jakarta' })
})

after(async () => {
    await closeActiveSocket()
    delete process.env.WA_PAIRING_NUMBER
    closeDatabase()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('integration suite: guard shell', () => {
    test('eksekusi shell sederhana mengembalikan output', async () => {
        const { stdout } = await shellPlugin.shellExec('echo ok-shell')
        assert.equal(stdout.trim(), 'ok-shell')
    })

    test('timeout mematikan perintah yang terlalu lama', async () => {
        const started = Date.now()
        await assert.rejects(
            () => shellPlugin.shellExec('sleep 8', { timeoutMs: 150 }),
            () => true
        )
        const elapsed = Date.now() - started
        assert.ok(elapsed < 4000, `perintahan selesai dalam ${elapsed}ms`)
    })

    test('maxBuffer kecil menolak output besar', async () => {
        await assert.rejects(
            () => shellPlugin.shellExec('seq 1 300000', { maxBuffer: 1024 }),
            () => true
        )
    })

    test('output panjang dipotong', () => {
        const clipped = shellPlugin.clipShellOutput('a'.repeat(10_000))
        assert.ok(clipped.length < 5000)
        assert.ok(clipped.includes('terpotong'))
        assert.ok(clipped.startsWith('aaaa'))
    })

    test('handler menolak saat enableShell false', async () => {
        updateConfig({ enableShell: false })
        const replies = []
        const notifReply = async (text, title) => { replies.push({ text, title }) }

        await shellPlugin.default({ text: '$ echo bahaya' }, { notifReply })

        assert.equal(replies.length, 1)
        assert.match(replies[0].text, /dinonaktifkan/)
        assert.equal(replies[0].title, 'Shell Disabled')
    })

    test('handler berjalan saat enableShell true dan tidak lagi memakai owner', async () => {
        updateConfig({ enableShell: true })
        const replies = []
        const notifReply = async (text, title) => { replies.push({ text, title }) }

        try {
            await shellPlugin.default({ text: '$ echo ok-jalan', isOwner: false, isCreator: true }, { notifReply })
        } finally {
            updateConfig({ enableShell: false })
        }

        assert.equal(replies.length, 1)
        assert.match(replies[0].text, /ok-jalan/)
        assert.equal(replies[0].title, 'Shell Result')
        assert.equal(shellPlugin.default.creator, true)
        assert.equal(shellPlugin.default.owner, undefined)
    })
})

describe('integration suite: guard eval', () => {
    test('handler menolak saat enableEval false', async () => {
        updateConfig({ enableEval: false })
        const replies = []
        const notifReply = async (text, title) => { replies.push({ text, title }) }

        await evalPlugin.default({ text: '=> 1 + 1' }, { notifReply })

        assert.equal(replies.length, 1)
        assert.match(replies[0].text, /dinonaktifkan/)
        assert.equal(replies[0].title, 'Eval Disabled')
    })

    test('eval tanpa isOwner tetap dieksekusi saat enableEval true', async () => {
        updateConfig({ enableEval: true })
        const replies = []
        const notifReply = async (text, title) => { replies.push({ text, title }) }

        try {
            await evalPlugin.default({
                text: '=> 6 * 7',
                isOwner: false,
                isButtonResponse: false
            }, { conn: {}, args: [], text: '6 * 7', prefix: '', command: '', notifReply })
        } finally {
            updateConfig({ enableEval: false })
        }

        assert.equal(replies.length, 1)
        assert.match(replies[0].text, /42/)
        assert.equal(evalPlugin.default.creator, true)
    })
})

describe('integration suite: env minimal untuk proses anak', () => {
    test('variabel env sembarangan tidak diteruskan ke proses anak', async () => {
        process.env.WA_ENV_PROBE = 'rahasia-env'
        try {
            const { runCode } = await import('../src/services/code-runner.js')
            const result = await runCode({
                language: 'sh',
                code: 'echo "m=${WA_ENV_PROBE}"\necho "p=${PATH}"'
            })
            assert.equal(result.failed, false)
            assert.ok(!result.output.includes('rahasia-env'), 'env sembarangan bocor ke anak')
            assert.match(result.output, /p=.+/)
        } finally {
            delete process.env.WA_ENV_PROBE
        }
    })
})

describe('integration suite: pairing non-interaktif', () => {
    test('nomor dari prompt dibersihkan menjadi digit saja', async () => {
        const prompts = []
        await withConnection({
            promptPhoneNumber: async () => {
                prompts.push('prompted')
                return '  +62 (812) 345-6789  '
            }
        }, sockets => {
            assert.equal(prompts.length, 1)
            assert.deepEqual(sockets[0].requests, ['628123456789'])
        })
    })

    test('config.pairingNumber dipakai tanpa prompt', async () => {
        updateConfig({ pairingNumber: '+62 812-999-888' })
        try {
            const prompts = []
            await withConnection({
                promptPhoneNumber: async () => {
                    prompts.push('prompted')
                    return '628000000000'
                }
            }, sockets => {
                assert.equal(prompts.length, 0, 'tidak boleh ada prompt interaktif')
                assert.deepEqual(sockets[0].requests, ['62812999888'])
            })
        } finally {
            updateConfig({ pairingNumber: '' })
        }
    })

    test('WA_PAIRING_NUMBER dipakai bila config kosong', async () => {
        process.env.WA_PAIRING_NUMBER = '62 811 777 666'
        try {
            const prompts = []
            await withConnection({
                promptPhoneNumber: async () => {
                    prompts.push('prompted')
                    return '628000000000'
                }
            }, sockets => {
                assert.equal(prompts.length, 0)
                assert.deepEqual(sockets[0].requests, ['62811777666'])
            })
        } finally {
            delete process.env.WA_PAIRING_NUMBER
        }
    })

    test('nomor kosong ditolak dengan pesan jelas tanpa crash', async () => {
        const captured = []
        const onBotError = payload => {
            if (payload?.scope === 'runtime:pairing') captured.push(payload)
        }
        events.on('bot:error', onBotError)
        try {
            await withConnection({
                promptPhoneNumber: async () => '   '
            }, (sockets, sock) => {
                assert.ok(sock, 'koneksi tetap dibuat')
                assert.deepEqual(sockets[0].requests, [], 'requestPairingCode tidak boleh dipanggil')
            })
            await sleep(30)
            assert.equal(captured.length, 1)
            assert.match(captured[0].error.message, /Nomor pairing kosong atau tidak valid/)
        } finally {
            events.off('bot:error', onBotError)
        }
    })
})

describe('integration suite: reset limit berbasis zona waktu', () => {
    test('kunci tanggal mengikuti zona waktu', () => {
        const utc = new Date('2026-11-14T20:00:00Z')
        assert.equal(limitReset.zoneDayKey(utc, 'Asia/Jakarta'), '2026-11-15')
        assert.equal(limitReset.zoneDayKey(utc, 'America/New_York'), '2026-11-14')
        assert.equal(limitReset.zoneDayKey(new Date('2026-11-14T10:00:00Z'), 'Asia/Jakarta'), '2026-11-14')
    })

    test('zona waktu tidak valid jatuh ke Asia/Jakarta', () => {
        updateConfig({ timezone: 'Zona/TidakAda' })
        try {
            assert.equal(limitReset.resolveTimezone(), 'Asia/Jakarta')
        } finally {
            updateConfig({ timezone: 'Asia/Jakarta' })
        }
    })

    test('reset terjadi sekali per hari zona dan lintas tengah malam Jakarta', () => {
        const jid = '628777000111@s.whatsapp.net'
        upsertUser({ jid, name: 'Uji Zona' })
        tryConsumeUserLimit(jid, 3)

        const soreJakarta = new Date('2026-11-14T10:00:00Z')
        const hasil1 = limitReset.checkLimitReset(soreJakarta)
        assert.equal(hasil1.reset, true)
        assert.equal(hasil1.day, '2026-11-14')
        assert.equal(getUser(jid).limit, 5)

        const hasil2 = limitReset.checkLimitReset(new Date('2026-11-14T12:00:00Z'))
        assert.equal(hasil2.reset, false, 'hari zona yang sama tidak reset dua kali')

        tryConsumeUserLimit(jid, 4)

        const pagiJakarta = new Date('2026-11-14T20:00:00Z')
        const hasil3 = limitReset.checkLimitReset(pagiJakarta)
        assert.equal(hasil3.reset, true, 'tengah malam Jakarta memicu reset')
        assert.equal(hasil3.day, '2026-11-15')
        assert.equal(getUser(jid).limit, 5)
    })
})

describe('integration suite: default config baru', () => {
    test('markOnlineOnConnect default false', () => {
        assert.equal(getConfig().markOnlineOnConnect, false)
        updateConfig({ markOnlineOnConnect: true })
        try {
            assert.equal(getConfig().markOnlineOnConnect, true)
        } finally {
            updateConfig({ markOnlineOnConnect: false })
        }
    })

    test('kunci baru punya default di kode', () => {
        const config = getConfig()
        assert.equal(config.pairingNumber, '')
        assert.equal(config.timezone, 'Asia/Jakarta')
        assert.equal(config.maxMessageAgeSec, 60)
        assert.equal(config.queueTaskTimeoutMs, 120000)
        assert.equal(config.maxConcurrentTasks, 8)
        assert.equal(config.prefixlessCommands, false)
        assert.equal(config.enableShell, false)
        assert.equal(config.enableEval, false)
        assert.equal(config.identityMaxStored, 20000)
        assert.equal(config.outboundMinIntervalMs, 400)
        assert.equal(config.outboundMaxRetries, 3)
        assert.equal(config.schedulerMisfireGraceMs, 300000)
        assert.equal(typeof config.hotReload, 'boolean')
        assert.equal(config.logToFile, false)
        assert.equal(config.shutdownTimeoutMs, 10000)
    })

    test('gitignore memuat entri database runtime dan .run-tmp', () => {
        const content = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
        for (const entry of [
            '.run-tmp/',
            'database/logs/',
            'database/database.db',
            'database/database.db-wal',
            'database/database.db-shm',
            'database/backups/'
        ]) {
            assert.ok(content.includes(entry), entry)
        }
    })
})
