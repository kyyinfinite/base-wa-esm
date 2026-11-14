import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-plugin-lifecycle-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    hotReload: false
}))

const { loadPlugin, unloadPlugin, initPlugins, stopWatching } = await import('../src/core/plugin/loader.js')
const { plugins, registerPlugin, unregisterPlugin, getKeysOf, metadata } = await import('../src/core/plugin/registry.js')
const { updateConfig } = await import('../src/services/config.js')
const { closeDatabase } = await import('../src/services/database/sqlite.js')
const { getUser, upsertUser } = await import('../src/services/database/users.js')
const handleMessage = (await import('../src/core/dispatcher/dispatcher.js')).default
const { setDispatcherReady } = await import('../src/core/dispatcher/dispatcher.js')
const { clearCooldowns } = await import('../src/core/middleware/cooldown.js')
const { events } = await import('../src/core/events/engine.js')
const { getMenuData, getMenuCommands } = await import('../src/services/menu-engine.js')
const { resetResolverState } = await import('../src/services/identity-resolver.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const pluginFile = (version, extra = '') => `
const state = (globalThis.__p5state ??= { order: [], sent: [], reactions: [], afterLog: [] })
let handler = async (m, { conn }) => {
    state.sent.push('${version}')
    await conn.sendMessage(m.chat, { text: 'jalanan-${version}' })
}
handler.command = ['p5cmd']
handler.init = async core => {
    state.order.push('init:${version}')
    state.coreOk = !!(core?.bus && core?.outbound && typeof core?.getSocket === 'function' && typeof core?.config === 'function')
    ${extra}
}
handler.dispose = () => { state.order.push('dispose:${version}') }
export default handler
`

const makeConn = () => {
    const sent = []
    return {
        sent,
        user: { id: '628000@s.whatsapp.net' },
        sendMessage: async (jid, content, opts) => {
            sent.push({ jid, content, opts })
            return {}
        },
        groupMetadata: async () => ({ subject: 'Grup Uji' })
    }
}

const makeM = (text, opts = {}) => ({
    key: {
        remoteJid: opts.chat || '628600@s.whatsapp.net',
        fromMe: false,
        id: crypto.randomUUID(),
        participant: undefined
    },
    id: crypto.randomUUID(),
    chat: opts.chat || '628600@s.whatsapp.net',
    sender: opts.sender || '628600@s.whatsapp.net',
    fromMe: false,
    isGroup: false,
    pushName: 'Tester',
    message: { conversation: text }
})

beforeEach(() => {
    globalThis.__p5state = { order: [], sent: [], reactions: [], afterLog: [], coreOk: null }
    clearCooldowns()
    resetResolverState()
    setDispatcherReady(true)
})

before(async () => {
    updateConfig({ hotReload: false })
})

after(async () => {
    stopWatching()
    updateConfig({ hotReload: false })
    setDispatcherReady(true)
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('integration suite: lifecycle init dan dispose', () => {
    test('init dipanggil sekali setelah registrasi dengan core lengkap', async () => {
        const file = path.join(tmp, 'lifecycle.js')
        fs.writeFileSync(file, pluginFile('v1'))

        const handler = await loadPlugin(file)

        assert.ok(handler, 'plugin dimuat')
        assert.deepEqual(globalThis.__p5state.order, ['init:v1'])
        assert.equal(globalThis.__p5state.coreOk, true, 'core berisi bus, outbound, getSocket, config')
        assert.ok(plugins.get('p5cmd'))

        await unloadPlugin(file)
        assert.equal(plugins.get('p5cmd'), undefined)
        assert.deepEqual(globalThis.__p5state.order, ['init:v1', 'dispose:v1'])
    })

    test('dispose dipanggil saat diganti sebelum versi baru diregistrasi', async () => {
        const file = path.join(tmp, 'lifecycle.js')
        fs.writeFileSync(file, pluginFile('v1'))
        await loadPlugin(file)

        globalThis.__p5state.order.length = 0
        fs.writeFileSync(file, pluginFile('v2'))
        await loadPlugin(file)

        assert.deepEqual(globalThis.__p5state.order, ['dispose:v1', 'init:v2'])
        assert.ok(plugins.get('p5cmd'))
    })

    test('init gagal membatalkan registrasi dan versi lama dipulihkan', async () => {
        const file = path.join(tmp, 'lifecycle.js')
        fs.writeFileSync(file, pluginFile('v1'))
        await loadPlugin(file)

        fs.writeFileSync(file, pluginFile('v3', 'throw new Error("init meledak")'))
        const result = await loadPlugin(file)

        assert.equal(result, null, 'plugin versi gagal init tidak dimuat')
        assert.equal(plugins.get('p5cmd') !== undefined, true, 'versi lama tetap terdaftar')

        const conn = makeConn()
        await handleMessage(conn, makeM('.p5cmd'))
        assert.deepEqual(globalThis.__p5state.sent, ['v1'])

        await unloadPlugin(file)
    })

    test('init gagal pada plugin baru tidak mengganggu plugin lain', async () => {
        const fileA = path.join(tmp, 'stable.js')
        fs.writeFileSync(fileA, pluginFile('v1'))
        await loadPlugin(fileA)

        const fileB = path.join(tmp, 'broken-init.js')
        fs.writeFileSync(fileB, `
let handler = async () => {}
handler.command = ['p5broken']
handler.init = async () => { throw new Error('init gagal total') }
export default handler
`)

        const loaded = await loadPlugin(fileB)

        assert.equal(loaded, null)
        assert.equal(plugins.get('p5broken'), undefined, 'plugin gagal init tidak terdaftar')
        assert.ok(plugins.get('p5cmd'), 'plugin lain tetap terdaftar dan tidak terpengaruh')

        await unloadPlugin(fileA)
        fs.rmSync(fileB, { force: true })
    })
})

describe('integration suite: hot reload terkendali config', () => {
    test('hotReload false tidak membuat watcher', async () => {
        updateConfig({ hotReload: false })
        try {
            const dir = fs.mkdtempSync(path.join(tmp, 'hr-off-'))
            fs.writeFileSync(path.join(dir, 'awal.js'), pluginFile('v1'))
            await initPlugins(dir)

            fs.writeFileSync(path.join(dir, 'tambahan.js'), pluginFile('v1x'))
            await sleep(400)

            assert.equal(plugins.get('p5cmd') !== undefined, true, 'plugin awal terdaftar lewat initPlugins')
            assert.equal(globalThis.__p5state.order.filter(item => item === 'init:v1x').length, 0, 'file baru tidak otomatis dimuat tanpa watcher')

            stopWatching()
            fs.rmSync(dir, { recursive: true, force: true })
        } finally {
            updateConfig({ hotReload: false })
        }
    })

    test('hotReload true memuat ulang file baru otomatis', async () => {
        updateConfig({ hotReload: true })
        try {
            const dir = fs.mkdtempSync(path.join(tmp, 'hr-on-'))
            fs.writeFileSync(path.join(dir, 'awal.js'), pluginFile('v1'))
            await initPlugins(dir)

            fs.writeFileSync(path.join(dir, 'tambahan.js'), `
let handler = async () => {}
handler.command = ['p5tambahan']
export default handler
`)
            await sleep(500)

            assert.ok(plugins.get('p5tambahan'), 'file baru dimuat otomatis oleh watcher')

            stopWatching()
            fs.rmSync(dir, { recursive: true, force: true })
        } finally {
            updateConfig({ hotReload: false })
        }
    })
})

describe('integration suite: before dan after', () => {
    test('before menghentikan eksekusi, melepas cooldown dan limit', async () => {
        const sender = '628601@s.whatsapp.net'
        const file = 'test://p5before'
        const handler = async (m, { conn }) => {
            await conn.sendMessage(m.chat, { text: 'sebelum-dijalankan' })
        }
        handler.command = ['p5beforecmd']
        handler.cooldown = 30_000
        handler.limit = 1
        handler.before = () => false
        handler.after = (m, ctx, outcome) => {
            globalThis.__p5state.afterLog.push(outcome)
        }
        registerPlugin(file, handler)

        try {
            const conn = makeConn()
            await handleMessage(conn, makeM('.p5beforecmd', { sender }))
            await handleMessage(conn, makeM('.p5beforecmd', { sender }))

            assert.equal(conn.sent.filter(s => s.content.text === 'sebelum-dijalankan').length, 0, 'eksekusi plugin dihentikan')
            assert.ok(conn.sent.every(s => !/Tunggu/.test(String(s.content?.text || ''))), 'cooldown tidak aktif setelah before berhenti')
            assert.equal(getUser(sender).limit, 5, 'limit dikembalikan penuh')
            assert.deepEqual(globalThis.__p5state.afterLog, [
                { ok: false, skipped: true },
                { ok: false, skipped: true }
            ])
        } finally {
            unregisterPlugin(file, getKeysOf(file))
        }
    })

    test('after selalu dipanggil: sukses, gagal, dan after melempar', async () => {
        const file = 'test://p5after'
        const handler = async () => { throw new Error('plugin meledak') }
        handler.command = ['p5afterfail']
        handler.after = (m, ctx, outcome) => { globalThis.__p5state.afterLog.push(outcome) }
        registerPlugin(file, handler)

        const fileOk = 'test://p5afterok'
        const handlerOk = async (m, { conn }) => { await conn.sendMessage(m.chat, { text: 'ok' }) }
        handlerOk.command = ['p5afterok']
        handlerOk.after = (m, ctx, outcome) => { globalThis.__p5state.afterLog.push(outcome) }
        registerPlugin(fileOk, handlerOk)

        const errors = []
        const onBotError = payload => errors.push(payload)
        events.on('bot:error', onBotError)

        try {
            const conn = makeConn()
            await handleMessage(conn, makeM('.p5afterok', { sender: '628602@s.whatsapp.net' }))
            await handleMessage(conn, makeM('.p5afterfail', { sender: '628603@s.whatsapp.net' }))

            assert.deepEqual(globalThis.__p5state.afterLog, [{ ok: true, result: undefined }, { ok: false, result: undefined }])
            assert.ok(errors.some(error => error.scope === 'plugin:execute'), 'kegagalan plugin dilaporkan')
        } finally {
            events.off('bot:error', onBotError)
            unregisterPlugin(file, getKeysOf(file))
            unregisterPlugin(fileOk, getKeysOf(fileOk))
        }
    })

    test('after yang melempar hanya dilaporkan tanpa menjatuhkan pesan lain', async () => {
        const file = 'test://p5afterthrow'
        const handler = async (m, { conn }) => { await conn.sendMessage(m.chat, { text: 'jalan-dulu' }) }
        handler.command = ['p5afterthrowcmd']
        handler.after = () => { throw new Error('after meledak') }
        registerPlugin(file, handler)

        const errors = []
        const onBotError = payload => errors.push(payload)
        events.on('bot:error', onBotError)

        try {
            const conn = makeConn()
            await handleMessage(conn, makeM('.p5afterthrowcmd', { sender: '628604@s.whatsapp.net' }))

            assert.ok(conn.sent.some(s => s.content.text === 'jalan-dulu'), 'plugin tetap berjalan')
            assert.ok(errors.some(error => error.scope === 'plugin:after'), 'kegagalan after dilaporkan')
        } finally {
            events.off('bot:error', onBotError)
            unregisterPlugin(file, getKeysOf(file))
        }
    })
})

describe('integration suite: langganan event bus handler.on', () => {
    test('langganan dipasang saat load dan dicabut saat unload/replace tanpa kebocoran', async () => {
        const reactionPlugin = reactionVersion => {
            const state = globalThis.__p5state
            const handler = async () => {}
            handler.command = ['p5eventcmd']
            handler.on = {
                'wa:reaction': event => { state.reactions.push(`${reactionVersion}:${event?.key?.id ?? 'x'}`) }
            }
            return handler
        }

        const file = path.join(tmp, 'eventsub.js')
        globalThis.__p5reactionPluginFactory = reactionPlugin

        fs.writeFileSync(file, `
const reactionPlugin = globalThis.__p5reactionPluginFactory
let handler = reactionPlugin('v1')
export default handler
`)

        const baseCount = events.listenerCount('wa:reaction')

        await loadPlugin(file)
        assert.equal(events.listenerCount('wa:reaction'), baseCount + 1)

        await events.emit('wa:reaction', { key: { id: 'E1' } })
        assert.deepEqual(globalThis.__p5state.reactions, ['v1:E1'])

        globalThis.__p5reactionPluginFactory = () => reactionPlugin('v2')
        fs.writeFileSync(file, `
const reactionPlugin = globalThis.__p5reactionPluginFactory
let handler = reactionPlugin('v2')
export default handler
`)
        await loadPlugin(file)
        assert.equal(events.listenerCount('wa:reaction'), baseCount + 1, 'listener tidak bocor saat replace')

        await events.emit('wa:reaction', { key: { id: 'E2' } })
        assert.deepEqual(globalThis.__p5state.reactions, ['v1:E1', 'v2:E2'])

        await unloadPlugin(file)
        assert.equal(events.listenerCount('wa:reaction'), baseCount, 'listener dicabut saat unload')

        await events.emit('wa:reaction', { key: { id: 'E3' } })
        assert.deepEqual(globalThis.__p5state.reactions, ['v1:E1', 'v2:E2'])
    })
})

describe('integration suite: kategori menu', () => {
    test('urutan prioritas kategori: category lalu tags lalu folder', () => {
        const files = []

        const register = (file, meta) => {
            const handler = async () => {}
            Object.assign(handler, { command: [meta.command], ...meta })
            registerPlugin(file, handler)
            files.push(file)
        }

        register('repo/plugins/maker/sticker.js', { command: 'p5mk1', category: 'maker', description: 'sticker' })
        register('repo/plugins/general/tagsuser.js', { command: 'p5tg1', tags: ['owner'], description: 'tag owner' })
        register('repo/plugins/tools/uploading.js', { command: 'p5tl1', description: 'upload' })

        try {
            const data = getMenuData({})
            const ids = data.categories.map(category => category.id)

            assert.ok(ids.includes('maker'), 'kategori maker tersedia lewat handler.category')
            assert.ok(ids.includes('tools'), 'kategori tools tersedia lewat nama folder')
            assert.ok(ids.includes('owner'), 'tags dipakai bila category kosong')

            const byId = new Map(data.categories.map(category => [category.id, category]))
            assert.deepEqual(byId.get('maker').commands.map(item => item.command), ['p5mk1'])
            assert.deepEqual(byId.get('tools').commands.map(item => item.command), ['p5tl1'])
            assert.deepEqual(byId.get('owner').commands.map(item => item.command), ['p5tg1'])

            const flat = getMenuCommands({})
            assert.equal(flat.find(item => item.command === 'p5mk1').category, 'maker')
        } finally {
            for (const file of files) {
                unregisterPlugin(file, getKeysOf(file))
            }
        }
    })
})
