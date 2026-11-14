import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-group-context-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    identityMaxStored: 4
}))

const { getAdminState } = await import('../src/core/middleware/admin.js')
const {
    getCachedGroupMetadata,
    getCachedGroupMetadataShared,
    captureGroupMetadata,
    resetGroupCache,
    setGroupCacheSocket,
    getGroupCacheStats
} = await import('../src/services/group-cache.js')
const {
    storeIdentityMapping,
    resetResolverState,
    setResolverSocket
} = await import('../src/services/identity-resolver.js')
const { prepare, closeDatabase } = await import('../src/services/database/sqlite.js')
const { getConfig, updateConfig } = await import('../src/services/config.js')
const { createContext } = await import('../src/core/context/createContext.js')
const { owners } = await import('../src/services/access.js')

const BOT_PN = '628000@s.whatsapp.net'
const BOT_LID = '555222@lid'

const groupMeta = (participants, subject = 'Grup Uji') => ({
    id: '120363000@g.us',
    subject,
    participants
})

const makeConn = (metadata, counter) => ({
    sent: [],
    user: { id: BOT_PN, lid: BOT_LID },
    sendMessage: async () => ({}),
    groupMetadata: async jid => {
        counter.calls += 1
        if (typeof metadata === 'function') return metadata()
        return groupMeta(metadata)
    },
    decodeJid: jid => jid
})

beforeEach(() => {
    resetGroupCache()
    resetResolverState()
    setResolverSocket(null)
    setGroupCacheSocket(null)
})

after(() => {
    resetGroupCache()
    resetResolverState()
    updateConfig({ identityMaxStored: 4 })
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('integration suite: admin di grup PN dan grup LID', () => {
    test('grup PN: sender PN cocok dengan participant id', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([
            { id: '628111@s.whatsapp.net', admin: 'admin' },
            { id: BOT_PN }
        ], counter)
        setGroupCacheSocket(conn)

        const state = await getAdminState({
            isGroup: true,
            chat: '120363000@g.us',
            sender: '628111@s.whatsapp.net',
            conn,
            m: {},
            group: {}
        })

        assert.deepEqual(state, { isAdmin: true, isBotAdmin: false })
    })

    test('grup LID: sender PN cocok lewat participant phoneNumber', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([
            { id: '555111@lid', lid: '555111@lid', phoneNumber: '628222@s.whatsapp.net', admin: 'superadmin' },
            { id: BOT_LID, phoneNumber: BOT_PN, admin: 'admin' }
        ], counter)
        setGroupCacheSocket(conn)

        const state = await getAdminState({
            isGroup: true,
            chat: '120363000@g.us',
            sender: '628222@s.whatsapp.net',
            conn,
            m: {},
            group: {}
        })

        assert.deepEqual(state, { isAdmin: true, isBotAdmin: true })
    })

    test('grup LID: sender LID cocok lewat participant id', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([
            { id: '555111@lid', phoneNumber: '628222@s.whatsapp.net', admin: 'superadmin' },
            { id: BOT_LID, phoneNumber: BOT_PN, admin: 'admin' }
        ], counter)
        setGroupCacheSocket(conn)

        const state = await getAdminState({
            isGroup: true,
            chat: '120363000@g.us',
            sender: '555111@lid',
            conn,
            m: {},
            group: {}
        })

        assert.deepEqual(state, { isAdmin: true, isBotAdmin: true })
    })

    test('bot dikenali lewat conn.user.lid pada grup LID', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([
            { id: '555111@lid', phoneNumber: '628222@s.whatsapp.net' },
            { id: BOT_LID, phoneNumber: BOT_PN, admin: 'admin' }
        ], counter)
        setGroupCacheSocket(conn)

        const state = await getAdminState({
            isGroup: true,
            chat: '120363000@g.us',
            sender: '555111@lid',
            conn,
            m: {},
            group: {}
        })

        assert.deepEqual(state, { isAdmin: false, isBotAdmin: true })
    })

    test('ctx.getAdminState menyimpan hasil dan memakai cache metadata', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([
            { id: '628111@s.whatsapp.net', admin: 'admin' }
        ], counter)
        setGroupCacheSocket(conn)

        const m = {
            chat: '120363000@g.us',
            sender: '628111@s.whatsapp.net',
            isGroup: true,
            key: { remoteJid: '120363000@g.us' },
            userJid: '628111@s.whatsapp.net',
            pushName: 'Uji'
        }
        const ctx = createContext({ conn, m })

        const first = await ctx.getAdminState()
        const second = await ctx.getAdminState()

        assert.deepEqual(first, { isAdmin: true, isBotAdmin: false })
        assert.deepEqual(second, first)
        assert.equal(counter.calls, 1, 'metadata hanya di-fetch sekali untuk dua panggilan')
        assert.equal(ctx.isAdmin, true)
        assert.equal(ctx.m.isAdmin, true)
    })
})

describe('integration suite: group cache lanjutan', () => {
    test('100 panggilan serentak ke grup sama hanya satu groupMetadata', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([{ id: '628111@s.whatsapp.net' }], counter)
        conn.groupMetadata = async () => {
            counter.calls += 1
            await new Promise(r => setTimeout(r, 20))
            return { id: '120363000@g.us', subject: 'Grup Serentak', participants: [] }
        }
        setGroupCacheSocket(conn)

        const results = await Promise.all(
            Array.from({ length: 100 }, () => getCachedGroupMetadata('120363000@g.us'))
        )

        assert.equal(counter.calls, 1, 'fetch metadata harus digabung')
        assert.ok(results.every(r => r && r.subject === 'Grup Serentak'))
    })

    test('negative cache 30 detik mencegah fetch berulang', async () => {
        const counter = { calls: 0 }
        const conn = {
            groupMetadata: async () => {
                counter.calls += 1
                throw new Error('grup tidak ditemukan')
            }
        }
        setGroupCacheSocket(conn)

        const first = await getCachedGroupMetadata('120363001@g.us')
        const second = await getCachedGroupMetadata('120363001@g.us')

        assert.equal(first, undefined)
        assert.equal(second, undefined)
        assert.equal(counter.calls, 1, 'kegagalan diingat dalam negative cache')
        assert.equal(getGroupCacheStats().entries, 0)
    })

    test('negative cache dibersihkan saat invalidate', async () => {
        const counter = { calls: 0 }
        let fail = true
        const conn = {
            groupMetadata: async () => {
                counter.calls += 1
                if (fail) throw new Error('offline')
                return { id: '120363002@g.us', subject: 'Pulih', participants: [] }
            }
        }
        setGroupCacheSocket(conn)

        await getCachedGroupMetadata('120363002@g.us')
        const { invalidateGroupMetadata } = await import('../src/services/group-cache.js')
        invalidateGroupMetadata('120363002@g.us')

        fail = false
        const recovered = await getCachedGroupMetadata('120363002@g.us')

        assert.equal(recovered.subject, 'Pulih')
        assert.equal(counter.calls, 2)
    })

    test('hit memperbarui urutan LRU sehingga entri terbaru dipakai', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([{ id: '628111@s.whatsapp.net' }], counter)
        conn.groupMetadata = async jid => {
            counter.calls += 1
            return { id: jid, subject: `Grup ${jid}`, participants: [] }
        }
        setGroupCacheSocket(conn)

        const keyOf = i => `12099${String(i).padStart(6, '0')}@g.us`

        for (let i = 0; i < 500; i++) {
            captureGroupMetadata({ id: keyOf(i), subject: `G${i}`, participants: [] }, keyOf(i))
        }

        await getCachedGroupMetadata(keyOf(0), conn)
        assert.equal(counter.calls, 0, 'entri lama masih ter-cache')

        captureGroupMetadata({ id: keyOf(1000), subject: 'Baru', participants: [] }, keyOf(1000))
        assert.ok(getGroupCacheStats().entries <= 500)

        await getCachedGroupMetadata(keyOf(0), conn)
        assert.equal(counter.calls, 0, 'entri yang baru dipakai tidak tereviksi')

        await getCachedGroupMetadata(keyOf(1), conn)
        assert.equal(counter.calls, 1, 'entri terlama tanpa akses terakhir tereviksi')
    })

    test('getCachedGroupMetadataShared mengembalikan referensi sama tanpa klon', async () => {
        const counter = { calls: 0 }
        const conn = makeConn([{ id: '628111@s.whatsapp.net' }], counter)
        setGroupCacheSocket(conn)

        const first = await getCachedGroupMetadataShared('120363003@g.us')
        const second = await getCachedGroupMetadataShared('120363003@g.us')

        assert.equal(first, second, 'varian shared tidak mengklon tiap kirim')
        assert.equal(counter.calls, 1)
        assert.equal(first.subject, 'Grup Uji')
    })
})

describe('integration suite: batas entri identity.json', () => {
    beforeEach(() => {
        resetResolverState()
    })

    test('identityMaxStored membatasi jumlah entri tersimpan', async () => {
        updateConfig({ identityMaxStored: 4 })
        try {
            setResolverSocket(null)

            for (let i = 0; i < 6; i++) {
                await storeIdentityMapping(`${900000000000000 + i}@lid`, `${628700000000 + i}@s.whatsapp.net`)
            }

            const stored = prepare('SELECT pn FROM identity_map').all().map(row => row.pn)
            assert.ok(stored.length <= 4, `entri tersimpan ${stored.length} harus <= 4`)
            assert.ok(
                stored.includes('628700000005'),
                `entri terbaru dipertahankan, tersimpan: ${stored.join(',')}`
            )
            assert.equal(stored.includes('628700000000'), false, 'entri tertua dibuang')
        } finally {
            updateConfig({ identityMaxStored: 4 })
        }
    })
})

describe('integration suite: cache config dan owners', () => {
    test('perubahan file config terlihat setelah jendela cek 2 detik', async () => {
        const before = getConfig().botMode
        assert.equal(before, 'public')

        await new Promise(r => setTimeout(r, 30))

        const raw = JSON.parse(fs.readFileSync(process.env.WA_CONFIG_PATH, 'utf8'))
        raw.botMode = 'self'
        fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify(raw))

        assert.equal(getConfig().botMode, 'public', 'masih nilai lama dalam jendela 2 detik')

        await new Promise(r => setTimeout(r, 2100))
        assert.equal(getConfig().botMode, 'self', 'nilai baru terlihat setelah jendela')

        raw.botMode = 'public'
        fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify(raw))
        await new Promise(r => setTimeout(r, 2100))
        assert.equal(getConfig().botMode, 'public')
    })

    test('updateConfig langsung terlihat tanpa menunggu jendela', () => {
        updateConfig({ botName: 'Uji Langsung' })
        assert.equal(getConfig().botName, 'Uji Langsung')
        updateConfig({ botName: 'Uji Bot' })
        assert.equal(getConfig().botName, 'Uji Bot')
    })

    test('owners.add dan remove langsung terlihat pada numbers cache', () => {
        owners.add('628555')
        try {
            assert.ok(owners.numbers().includes('628555'))
            assert.equal(owners.has('628555@s.whatsapp.net'), true)

            const first = owners.numbers()
            const second = owners.numbers()
            assert.equal(first, second, 'hasil numbers di-cache per jendela invalidasi')
        } finally {
            owners.remove('628555')
        }
        assert.equal(owners.has('628555@s.whatsapp.net'), false)
    })
})
