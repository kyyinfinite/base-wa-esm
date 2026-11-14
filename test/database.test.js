import { test, describe, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-db-'))
const tmpConfig = path.join(tmpDb, 'config.json')
fs.writeFileSync(tmpConfig, JSON.stringify({ dailyLimit: 7, botMode: 'public', prefix: ['.'] }))

process.env.WA_DATABASE_DIR = tmpDb
process.env.WA_CONFIG_PATH = tmpConfig

const { prepare, closeDatabase, getDatabase, resetDatabaseForTests } = await import('../src/services/database/sqlite.js')
const { getUserKey, getUser, upsertUser, consumeUserLimit, tryConsumeUserLimit, refundUserLimit, resetAllUserLimits } = await import('../src/services/database/users.js')
const { getGroup, getGroupKey, upsertGroup } = await import('../src/services/database/groups.js')
const { getSetting, setSetting } = await import('../src/services/database/settings.js')
const { getDailyLimit, updateConfig, getConfig } = await import('../src/services/config.js')
const limitReset = await import('../src/core/scheduler/limitReset.js')

const dbFile = path.join(tmpDb, 'database.db')

after(() => {
    closeDatabase()
    fs.rmSync(tmpDb, { recursive: true, force: true })
})

describe('user database sql', () => {
    test('getUserKey menolak JID non-personal', () => {
        assert.equal(getUserKey('123456@g.us'), null)
        assert.equal(getUserKey('status@broadcast'), null)
        assert.equal(getUserKey('12345@newsletter'), null)
        assert.equal(getUserKey(''), null)
        assert.equal(getUserKey(null), null)
    })

    test('getUserKey menerima JID personal dengan namespace terjaga', () => {
        assert.equal(getUserKey('628123@s.whatsapp.net'), '628123')
        assert.equal(getUserKey('628123'), '628123')
        assert.equal(getUserKey('628123:2@s.whatsapp.net'), '628123')
        assert.equal(getUserKey('628123@lid'), '628123@lid', 'LID tidak boleh jadi nomor telepon')
    })

    test('upsertUser membuat record baru dengan limit dari config', () => {
        const record = upsertUser({ jid: '628111@s.whatsapp.net', name: 'Andi' })
        assert.equal(record.limit, 7)
        assert.equal(record.name, 'Andi')
        assert.equal(record.premium, false)
        assert.equal(record.owner, false)
        assert.equal(record.creator, false)
        assert.equal(record.firstSeen, record.lastSeen)
    })

    test('upsertUser menjaga firstSeen dan limit yang sudah ada', () => {
        const first = upsertUser({ jid: '628112@s.whatsapp.net', name: 'Budi' })
        consumeUserLimit('628112@s.whatsapp.net', 4)

        const second = upsertUser({ jid: '628112@s.whatsapp.net', name: 'Budi' })
        assert.equal(second.firstSeen, first.firstSeen)
        assert.equal(second.limit, 3)
    })

    test('upsertUser menolak JID grup', () => {
        assert.equal(upsertUser({ jid: '1203@g.us', name: 'Grup' }), null)
    })

    test('upsertUser pada LID membuat record terpisah dari PN', () => {
        const lidRecord = upsertUser({ jid: '987654321098765@lid', name: 'Lid User' })
        assert.equal(lidRecord.jid, '987654321098765@lid')
        assert.equal(getUserKey('987654321098765@lid'), '987654321098765@lid')
        assert.equal(getUser('987654321098765@lid').name, 'Lid User')
    })

    test('flag premium owner creator dikembalikan tanpa disimpan', () => {
        upsertUser({ jid: '628114@s.whatsapp.net', name: 'Flag', isPremium: true, isOwner: true })

        const row = prepare('SELECT key, jid, name, first_seen, last_seen, remaining_limit FROM users WHERE key = ?').get('628114')
        assert.deepEqual(Object.keys(row).sort(), ['first_seen', 'jid', 'key', 'last_seen', 'name', 'remaining_limit'], 'kolom flag tidak ada di tabel')

        const stored = getUser('628114@s.whatsapp.net')
        assert.deepEqual(Object.keys(stored).sort(), ['firstSeen', 'jid', 'lastSeen', 'limit', 'name'], 'getUser tidak memuat flag')
    })

    test('consumeUserLimit mengurangi limit tanpa negatif', () => {
        upsertUser({ jid: '628113@s.whatsapp.net', name: 'Cici' })
        const after1 = consumeUserLimit('628113@s.whatsapp.net', 2)
        assert.equal(after1.limit, 5)

        const after2 = consumeUserLimit('628113@s.whatsapp.net', 99)
        assert.equal(after2.limit, 0)
    })

    test('consumeUserLimit pada user yang belum terdaftar mengembalikan null', () => {
        assert.equal(consumeUserLimit('628999@s.whatsapp.net', 1), null)
    })

    test('tryConsumeUserLimit atomik dan menolak saat saldo kurang', () => {
        upsertUser({ jid: '628115@s.whatsapp.net', name: 'Atom' })
        assert.equal(tryConsumeUserLimit('628115@s.whatsapp.net', 5).limit, 2)
        assert.equal(tryConsumeUserLimit('628115@s.whatsapp.net', 3), false, 'limit kurang mengembalikan false')
        assert.equal(getUser('628115@s.whatsapp.net').limit, 2, 'saldo tidak berubah saat ditolak')
        assert.equal(tryConsumeUserLimit('628998@s.whatsapp.net', 1), null, 'user tidak ada mengembalikan null')
    })

    test('reserve atomik: dua tryConsume paralel dengan limit 1 hanya satu lolos', () => {
        upsertUser({ jid: '628116@s.whatsapp.net', name: 'Race' })
        consumeUserLimit('628116@s.whatsapp.net', 6)

        const results = []
        for (let i = 0; i < 2; i++) {
            results.push(tryConsumeUserLimit('628116@s.whatsapp.net', 1))
        }

        assert.equal(results.filter(r => r !== null && r !== false).length, 1, 'hanya satu reserve berhasil')
        assert.equal(getUser('628116@s.whatsapp.net').limit, 0, 'saldo tidak minus')
    })

    test('refundUserLimit mengembalikan saldo', () => {
        upsertUser({ jid: '628117@s.whatsapp.net', name: 'Refund' })
        consumeUserLimit('628117@s.whatsapp.net', 3)
        assert.equal(refundUserLimit('628117@s.whatsapp.net', 2).limit, 6)
        assert.equal(refundUserLimit('628997@s.whatsapp.net', 1), null)
    })

    test('resetAllUserLimits satu UPDATE dan mengembalikan jumlah baris', () => {
        const count = resetAllUserLimits(7)
        assert.ok(count >= 6)
        assert.equal(getUser('628113@s.whatsapp.net').limit, 7)
        assert.equal(getUser('628116@s.whatsapp.net').limit, 7)
    })

    test('data bertahan setelah close dan buka ulang', () => {
        upsertUser({ jid: '628119@s.whatsapp.net', name: 'Persist' })
        consumeUserLimit('628119@s.whatsapp.net', 1)

        closeDatabase()
        getDatabase()

        const stored = getUser('628119@s.whatsapp.net')
        assert.equal(stored.name, 'Persist')
        assert.equal(stored.limit, 6)
    })

    test('waktu user disimpan epoch ms dan dikembalikan sebagai ISO', () => {
        upsertUser({ jid: '628120@s.whatsapp.net', name: 'Waktu' })

        const row = prepare('SELECT first_seen, last_seen FROM users WHERE key = ?').get('628120')
        assert.ok(Number.isInteger(row.first_seen) && row.first_seen > 1_600_000_000_000, 'first_seen epoch ms')

        const stored = getUser('628120@s.whatsapp.net')
        assert.equal(stored.firstSeen, new Date(row.first_seen).toISOString())
    })
})

describe('lastSeen throttle sql', () => {
    test('lastSeen fresh di memori, persist sql dibatasi per menit', () => {
        mock.timers.enable({ apis: ['Date'] })
        try {
            upsertUser({ jid: '628118@s.whatsapp.net', name: 'Throttle' })
            const persisted = prepare('SELECT last_seen FROM users WHERE key = ?').get('628118').last_seen

            mock.timers.tick(5000)
            const fresh = upsertUser({ jid: '628118@s.whatsapp.net', name: 'Throttle' })
            const afterFiveSec = prepare('SELECT last_seen FROM users WHERE key = ?').get('628118').last_seen

            assert.equal(afterFiveSec, persisted, 'belum 1 menit: tidak ada tulis ulang last_seen')
            assert.notEqual(fresh.lastSeen, new Date(persisted).toISOString(), 'lastSeen memori tetap fresh')

            mock.timers.tick(61_000)
            upsertUser({ jid: '628118@s.whatsapp.net', name: 'Throttle' })
            const afterMinute = prepare('SELECT last_seen FROM users WHERE key = ?').get('628118').last_seen
            assert.notEqual(afterMinute, persisted, 'setelah 1 menit: lastSeen ter-persist')
        } finally {
            mock.timers.reset()
        }
    })
})

describe('group database sql', () => {
    test('getGroupKey hanya menerima JID grup', () => {
        assert.equal(getGroupKey('123@g.us'), '123@g.us')
        assert.equal(getGroupKey('123@s.whatsapp.net'), null)
    })

    test('upsertGroup membuat dan memperbarui record', () => {
        const created = upsertGroup({ jid: '111@g.us', name: 'Grup Satu' })
        assert.equal(created.name, 'Grup Satu')
        assert.deepEqual(created.settings, {})
        assert.ok(created.createdAt)

        const updated = upsertGroup({ jid: '111@g.us', name: 'Grup Baru' })
        assert.equal(updated.name, 'Grup Baru')
        assert.equal(updated.createdAt, created.createdAt)
        assert.equal(getGroup('111@g.us').jid, '111@g.us')
    })

    test('upsertGroup menyimpan settings sebagai JSON dan hanya menulis saat berubah', () => {
        const first = upsertGroup({ jid: '222@g.us', name: 'Setting', settings: { muted: true, level: 2 } })

        const rowBefore = prepare('SELECT settings, created_at FROM wa_groups WHERE jid = ?').get('222@g.us')
        const unchanged = upsertGroup({ jid: '222@g.us', name: 'Setting' })
        const rowAfter = prepare('SELECT settings, created_at FROM wa_groups WHERE jid = ?').get('222@g.us')

        assert.deepEqual(unchanged.settings, { muted: true, level: 2 })
        assert.equal(rowAfter.settings, rowBefore.settings, 'settings tidak ditulis ulang tanpa perubahan')
        assert.equal(rowAfter.created_at, rowBefore.created_at, 'createdAt dijaga')

        upsertGroup({ jid: '222@g.us', settings: { muted: false } })
        assert.deepEqual(getGroup('222@g.us').settings, { muted: false })
        assert.equal(first.createdAt, getGroup('222@g.us').createdAt)
    })

    test('getGroup pada grup asing mengembalikan null', () => {
        assert.equal(getGroup('999@g.us'), null)
    })
})

describe('settings helper sql', () => {
    test('setSetting dan getSetting round-trip', () => {
        setSetting('helper-key', { a: 1 })
        assert.deepEqual(getSetting('helper-key'), { a: 1 })

        setSetting('helper-key', { a: 2, b: 'x' })
        assert.deepEqual(getSetting('helper-key'), { a: 2, b: 'x' })

        assert.equal(getSetting('tidak-ada'), null)
    })

    test('setSetting menulis value json valid dengan updated_at', () => {
        setSetting('stamp-key', { n: 1 })

        const row = prepare('SELECT value, updated_at FROM settings WHERE key = ?').get('stamp-key')
        assert.equal(row.updated_at > 1_600_000_000_000, true)
        assert.deepEqual(JSON.parse(row.value), { n: 1 })
    })
})

describe('limitReset sql', () => {
    test('reset terjadi sekali per hari zona', () => {
        resetDatabaseForTests()
        updateConfig({ dailyLimit: 5 })

        try {
            upsertUser({ jid: '628777000111@s.whatsapp.net', name: 'Uji Zona' })
            tryConsumeUserLimit('628777000111@s.whatsapp.net', 3)

            const soreJakarta = new Date('2026-11-14T10:00:00Z')
            const hasil1 = limitReset.checkLimitReset(soreJakarta)
            assert.equal(hasil1.reset, true)
            assert.equal(hasil1.day, '2026-11-14')
            assert.equal(getUser('628777000111@s.whatsapp.net').limit, 5)

            const hasil2 = limitReset.checkLimitReset(new Date('2026-11-14T12:00:00Z'))
            assert.equal(hasil2.reset, false, 'hari zona yang sama tidak reset dua kali')
        } finally {
            updateConfig({ dailyLimit: 7 })
        }
    })
})

describe('paritas perilaku lama users', () => {
    test('urutan operasi lama menghasilkan hasil sama', () => {
        resetDatabaseForTests()

        const a = upsertUser({ jid: '628201@s.whatsapp.net', name: 'A' })
        const legacyA = { jid: '628201@s.whatsapp.net', name: 'A', firstSeen: a.firstSeen, lastSeen: a.lastSeen, limit: 7, premium: false, owner: false, creator: false }

        consumeUserLimit('628201@s.whatsapp.net', 2)
        legacyA.limit = 5
        legacyA.lastSeen = getUser('628201@s.whatsapp.net').lastSeen

        assert.deepEqual(getUser('628201@s.whatsapp.net'), { jid: legacyA.jid, name: legacyA.name, firstSeen: legacyA.firstSeen, lastSeen: legacyA.lastSeen, limit: legacyA.limit })

        const b = tryConsumeUserLimit('628201@s.whatsapp.net', 5)
        assert.equal(b.limit, 0)
        assert.equal(tryConsumeUserLimit('628201@s.whatsapp.net', 1), false)

        consumeUserLimit('628201@s.whatsapp.net', 3)
        assert.equal(getUser('628201@s.whatsapp.net').limit, 0, 'consume memangkas minimal ke 0')

        refundUserLimit('628201@s.whatsapp.net', 4)
        assert.equal(getUser('628201@s.whatsapp.net').limit, 4)

        resetAllUserLimits(9)
        assert.equal(getUser('628201@s.whatsapp.net').limit, 9)
    })
})

describe('config service', () => {
    test('getConfig membaca config', () => {
        assert.equal(getConfig().dailyLimit, 7)
        assert.equal(getDailyLimit(), 7)
    })

    test('getDailyLimit fallback ke 10 jika tidak valid', () => {
        updateConfig({ dailyLimit: null })
        assert.equal(getDailyLimit(), 10)
        updateConfig({ dailyLimit: 7 })
    })

    test('updateConfig menulis patch ke disk dan cache konsisten', () => {
        updateConfig({ botName: 'Uji Bot' })
        const raw = JSON.parse(fs.readFileSync(tmpConfig, 'utf8'))
        assert.equal(raw.botName, 'Uji Bot')
        assert.equal(getConfig().botName, 'Uji Bot')
        updateConfig({ botName: 'kyyinfinite' })
    })

    test('updateConfig menolak patch non-object', () => {
        assert.throws(() => updateConfig('bukan-object'), TypeError)
        assert.throws(() => updateConfig([1, 2]), TypeError)
    })
})
