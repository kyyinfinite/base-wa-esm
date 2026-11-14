import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { proto } from '@whiskeysockets/baileys'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MIGRATE_SCRIPT = path.join(ROOT, 'scripts/migrate-json-to-sqlite.js')
const EXPORT_SCRIPT = path.join(ROOT, 'scripts/export-sqlite-to-json.js')

const CHAT = '628111222333@s.whatsapp.net'
const nowSec = Math.floor(Date.now() / 1000)

const runScript = (file, args) => spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
})

const parseReport = stdout => {
    const trimmed = stdout.trim()
    let index = trimmed.indexOf('{')
    while (index >= 0) {
        try {
            return JSON.parse(trimmed.slice(index))
        } catch {
            index = trimmed.indexOf('{', index + 1)
        }
    }
    throw new Error('laporan json tidak ditemukan pada output')
}

const encodeMessage = (id, chat, text, timestamp) =>
    Buffer.from(proto.WebMessageInfo.encode(proto.WebMessageInfo.fromObject({
        key: { remoteJid: chat, fromMe: false, id },
        message: { conversation: text },
        messageTimestamp: timestamp
    })).finish()).toString('base64')

const serializeNode = node => JSON.stringify(node, (_, value) => {
    if (Buffer.isBuffer(value)) return { type: 'Buffer', data: value.toString('base64') }
    if (value instanceof Uint8Array) return { type: 'Buffer', data: Buffer.from(value).toString('base64') }
    return value
})

function writeFixture(dir) {
    fs.mkdirSync(dir, { recursive: true })

    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({
        '628111': {
            jid: '628111@s.whatsapp.net',
            name: 'Andi',
            firstSeen: '2026-01-01T00:00:00.000Z',
            lastSeen: '2026-11-01T00:00:00.000Z',
            limit: 3,
            premium: false,
            owner: false,
            creator: false
        },
        '987654321098765@lid': {
            jid: '987654321098765@lid',
            name: 'Andi LID',
            firstSeen: '2025-12-01T00:00:00.000Z',
            lastSeen: '2026-11-14T00:00:00.000Z',
            limit: 2,
            premium: false,
            owner: false,
            creator: false
        },
        '628222': {
            jid: '628222@s.whatsapp.net',
            name: 'Budi',
            firstSeen: '2026-02-01T00:00:00.000Z',
            lastSeen: '2026-11-02T00:00:00.000Z',
            limit: 10,
            premium: true,
            owner: false,
            creator: false
        }
    }, null, 2))

    fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify({
        '111@g.us': {
            jid: '111@g.us',
            name: 'Grup Satu',
            createdAt: '2026-03-01T00:00:00.000Z',
            settings: { muted: true }
        },
        '222@g.us': {
            jid: '222@g.us',
            name: 'Grup Dua',
            createdAt: '2026-04-01T00:00:00.000Z',
            settings: {}
        }
    }, null, 2))

    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
        limitReset: { lastResetDate: '2026-11-14' }
    }, null, 2))

    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
        '628111': '987654321098765'
    }, null, 2))

    fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify({
        FRESH1: { v: 1, id: 'FRESH1', jid: '628111@s.whatsapp.net', content: { conversation: 'baru' }, at: Date.now() },
        OLD1: { v: 1, id: 'OLD1', jid: '628111@s.whatsapp.net', content: { conversation: 'lama' }, at: Date.now() - 2 * 60 * 60_000 },
        LEGACY1: { id: 'LEGACY1', jid: '628111@s.whatsapp.net', content: { conversation: 'tanpa versi' }, at: Date.now() }
    }, null, 2))

    fs.writeFileSync(path.join(dir, 'schedules.json'), JSON.stringify({
        job1: {
            id: 'job1',
            chatJid: '628111@s.whatsapp.net',
            content: { text: 'halo' },
            at: Date.now() + 60_000,
            every: null,
            cron: null,
            nextRunAt: null,
            lastRunAt: null,
            runCount: 0
        },
        job2: {
            id: 'job2',
            chatJid: CHAT,
            content: { text: 'ulang' },
            at: null,
            every: 60_000,
            cron: null,
            nextRunAt: null,
            lastRunAt: 1700000000,
            runCount: 5
        }
    }, null, 2))

    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(['628100', '628101@s.whatsapp.net'], null, 2))
    fs.writeFileSync(path.join(dir, 'premium.json'), JSON.stringify(['628300'], null, 2))

    fs.writeFileSync(path.join(dir, 'crm-messages.json'), JSON.stringify({
        1: { id: 'CRM1', chat: CHAT, sender: '628111@s.whatsapp.net', timestamp: nowSec - 3600, data: encodeMessage('CRM1', CHAT, 'versi satu', nowSec - 3600) },
        2: { id: 'CRM1', chat: CHAT, sender: '628111@s.whatsapp.net', timestamp: nowSec, data: encodeMessage('CRM1', CHAT, 'versi dua', nowSec) },
        3: { id: 'CRMOLD', chat: CHAT, sender: null, timestamp: nowSec - 8 * 24 * 60 * 60, data: encodeMessage('CRMOLD', CHAT, 'sudah tua', nowSec - 8 * 24 * 60 * 60) }
    }))

    fs.writeFileSync(path.join(dir, 'crm-nodes.json'), JSON.stringify({
        [JSON.stringify(['CRM1', CHAT])]: { id: 'CRM1', chat: CHAT, data: serializeNode({ tag: 'message', attrs: { id: 'CRM1', from: CHAT }, content: [] }), created_at: nowSec },
        [JSON.stringify(['ORPHAN', CHAT])]: { id: 'ORPHAN', chat: CHAT, data: serializeNode({ tag: 'message', attrs: { id: 'ORPHAN', from: CHAT }, content: [] }), created_at: nowSec }
    }))

    fs.writeFileSync(path.join(dir, 'crm-meta.json'), JSON.stringify({ seq: 3 }, null, 2))
    fs.writeFileSync(path.join(dir, 'users.json.corrupt-9999'), '{ puing')
    fs.writeFileSync(path.join(dir, 'logs-ignore.txt'), 'bukan data')
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-migr-'))
const fixture = path.join(tmpRoot, 'src-data')
const dbFile = path.join(fixture, 'database.db')

before(() => {
    writeFixture(fixture)
})

after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('migrasi json ke sqlite', () => {
    test('migrasi penuh berhasil dan laporan akurat', () => {
        const result = runScript(MIGRATE_SCRIPT, ['--dir', fixture, '--db', dbFile])
        assert.equal(result.status, 0, `gagal: ${result.stderr}`)

        const report = parseReport(result.stdout)
        assert.equal(report.dryRun, false)
        assert.equal(report.skipCrm, false)
        assert.ok(report.backupDir && fs.existsSync(report.backupDir))
        assert.deepEqual(report.usingBackupFor, [])

        assert.deepEqual(report.tables.users, { read: 3, written: 2, merged: 1, skipped: 0 })
        assert.deepEqual(report.tables.access_roles, { read: 3, written: 3, merged: 0, skipped: 0 })
        assert.deepEqual(report.tables.wa_groups, { read: 2, written: 2, merged: 0, skipped: 0 })
        assert.deepEqual(report.tables.settings, { read: 1, written: 1, merged: 0, skipped: 0 })
        assert.deepEqual(report.tables.identity_map, { read: 1, written: 1, merged: 0, skipped: 0 })
        assert.deepEqual(report.tables.outgoing_messages, { read: 3, written: 1, merged: 0, skipped: 2 })
        assert.deepEqual(report.tables.schedules, { read: 2, written: 2, merged: 0, skipped: 0 })
        assert.deepEqual(report.tables.crm_messages, { read: 3, written: 2, merged: 0, skipped: 1 })
        assert.deepEqual(report.tables.crm_nodes, { read: 2, written: 2, merged: 0, skipped: 0 })

        assert.deepEqual(report.stalePremiumFlags, ['628222'])
        assert.equal(report.marked, true)
    })

    test('baris users tergabung dan flag tidak dibawa', () => {
        const db = new Database(dbFile)
        try {
            const merged = db.prepare('SELECT * FROM users WHERE key = ?').get('628111')
            assert.equal(merged.jid, '628111@s.whatsapp.net')
            assert.equal(merged.name, 'Andi')
            assert.equal(merged.first_seen, Date.parse('2025-12-01T00:00:00.000Z'), 'first_seen terkecil')
            assert.equal(merged.last_seen, Date.parse('2026-11-14T00:00:00.000Z'), 'last_seen terbesar')
            assert.equal(merged.remaining_limit, 2, 'limit terkecil')

            assert.equal(db.prepare('SELECT count(*) AS t FROM users').get().t, 2)
            const columns = db.prepare('PRAGMA table_info(users)').all().map(col => col.name)
            assert.equal(columns.includes('premium'), false, 'kolom flag tidak ada')

            const standalone = db.prepare('SELECT * FROM users WHERE key = ?').get('628222')
            assert.equal(standalone.remaining_limit, 10)
        } finally {
            db.close()
        }
    })

    test('access_roles dinormalisasi lewat utils/identity', () => {
        const db = new Database(dbFile)
        try {
            const owners = db.prepare("SELECT number, jid FROM access_roles WHERE role = 'owner' ORDER BY number").all()
            assert.deepEqual(owners, [
                { number: '628100', jid: '628100@s.whatsapp.net' },
                { number: '628101', jid: '628101@s.whatsapp.net' }
            ])
            const premiums = db.prepare("SELECT number, jid FROM access_roles WHERE role = 'premium'").all()
            assert.deepEqual(premiums, [{ number: '628300', jid: '628300@s.whatsapp.net' }])
        } finally {
            db.close()
        }
    })

    test('tabel pendukung terpasang dengan bentuk lama', () => {
        const db = new Database(dbFile)
        try {
            const group = db.prepare('SELECT * FROM wa_groups WHERE jid = ?').get('111@g.us')
            assert.equal(group.name, 'Grup Satu')
            assert.equal(group.created_at, Date.parse('2026-03-01T00:00:00.000Z'))
            assert.deepEqual(JSON.parse(group.settings), { muted: true })

            const settings = db.prepare('SELECT value FROM settings WHERE key = ?').get('limitReset')
            assert.deepEqual(JSON.parse(settings.value), { lastResetDate: '2026-11-14' })

            const identity = db.prepare('SELECT pn, lid FROM identity_map').get()
            assert.deepEqual(identity, { pn: '628111', lid: '987654321098765' })

            const outgoing = db.prepare('SELECT id, jid, content, created_at FROM outgoing_messages').all()
            assert.deepEqual(outgoing.map(row => row.id), ['FRESH1'])
            assert.equal(JSON.parse(outgoing[0].content).conversation, 'baru')

            const job2 = db.prepare('SELECT * FROM schedules WHERE id = ?').get('job2')
            assert.equal(job2.chat_jid, CHAT)
            assert.equal(job2.every, 60_000)
            assert.equal(job2.last_run_at, 1700000000)
            assert.equal(job2.run_count, 5)
            assert.deepEqual(JSON.parse(job2.content), { text: 'ulang' })
        } finally {
            db.close()
        }
    })

    test('crm mempertahankan rowid, duplikat, dan sqlite_sequence', () => {
        const db = new Database(dbFile)
        try {
            const rows = db.prepare('SELECT rowid, msg_id, chat, ts FROM crm_messages ORDER BY rowid').all()
            assert.deepEqual(rows.map(row => [row.rowid, row.msg_id]), [[1, 'CRM1'], [2, 'CRM1']])
            assert.equal(rows.some(row => row.msg_id === 'CRMOLD'), false, 'pesan lebih tua dari 7 hari dilewati')

            const latest = db.prepare('SELECT rowid, msg_id FROM crm_messages WHERE msg_id = ? ORDER BY rowid DESC LIMIT 1').get('CRM1')
            assert.equal(latest.rowid, 2, 'duplikat id+chat: rowid terbaru menang')

            const decoded = proto.WebMessageInfo.decode(db.prepare('SELECT data FROM crm_messages WHERE rowid = 2').get().data)
            assert.equal(decoded.key.id, 'CRM1')
            assert.equal(decoded.message.conversation, 'versi dua')

            const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'crm_messages'").get()
            assert.equal(seq.seq, 3, 'sqlite_sequence mengikuti meta.seq terbesar')

            const nodeKeys = db.prepare('SELECT msg_id, chat FROM crm_nodes ORDER BY msg_id').all()
            assert.deepEqual(nodeKeys.map(row => [row.msg_id, row.chat]), [['CRM1', CHAT], ['ORPHAN', CHAT]])
            const nodeRow = db.prepare('SELECT data FROM crm_nodes WHERE msg_id = ?').get('CRM1')
            assert.equal(typeof nodeRow.data, 'string')
        } finally {
            db.close()
        }
    })

    test('file sumber di-rename jadi .migrated dan marker terpasang', () => {
        assert.equal(fs.existsSync(path.join(fixture, 'users.json')), false)
        assert.equal(fs.existsSync(path.join(fixture, 'users.json.migrated')), true)
        assert.equal(fs.existsSync(path.join(fixture, 'crm-messages.json.migrated')), true)
        assert.equal(fs.existsSync(path.join(fixture, 'users.json.corrupt-9999')), true, 'puing korup tidak dihapus')

        const db = new Database(dbFile)
        try {
            const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get('jsonMigration')
            const parsed = JSON.parse(marker.value)
            assert.equal(typeof parsed.at, 'number')
            assert.equal(parsed.from, fixture)
        } finally {
            db.close()
        }
    })

    test('backup sumber berisi salinan data json', () => {
        const db = new Database(dbFile)
        let backupDir = null
        try {
            backupDir = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get('jsonMigration').value).backup || null
        } finally {
            db.close()
        }

        const listing = fs.readdirSync(path.join(path.dirname(fixture)))
        const backup = listing.find(name => name.startsWith('database.backup-'))
        assert.ok(backup, 'direktori backup tercipta')
        const backupFiles = fs.readdirSync(path.join(path.dirname(fixture), backup))
        assert.ok(backupFiles.includes('users.json'))
        assert.ok(backupFiles.includes('crm-nodes.json'))
        assert.equal(backupFiles.includes('database.db'), false, 'file database tidak ikut di-backup')
    })

    test('jalan ulang ditolak tanpa --force', () => {
        const result = runScript(MIGRATE_SCRIPT, ['--dir', fixture, '--db', dbFile])
        assert.notEqual(result.status, 0, 'harus gagal dengan exit non-zero')
        assert.match(result.stderr, /jsonMigration/)
    })

    test('jalan ulang dengan --force tetap berhasil', () => {
        const result = runScript(MIGRATE_SCRIPT, ['--dir', fixture, '--db', dbFile, '--force'])
        assert.equal(result.status, 0, `gagal: ${result.stderr}`)
        const report = parseReport(result.stdout)
        assert.equal(report.marked, true)
    })

    test('proses bot hidup ditolak lewat file shm', () => {
        const dir = path.join(tmpRoot, 'shm-case')
        writeFixture(dir)
        const dbPath = path.join(dir, 'database.db')
        fs.writeFileSync(`${dbPath}-shm`, 'indikasi koneksi aktif')

        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', dbPath])
        assert.equal(result.status, 2, 'exit 2 untuk penolakan pra-kondisi')
        assert.match(result.stderr, /bot|shm/i)
        assert.equal(fs.existsSync(dbPath), false, 'database tidak dibuka saat bot hidup')
    })

    test('pid lock mencegah migrasi paralel', () => {
        const dir = path.join(tmpRoot, 'lock-case')
        writeFixture(dir)
        const dbPath = path.join(dir, 'database.db')
        fs.writeFileSync(`${dbPath}.migrating`, String(process.pid))

        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', dbPath])
        assert.equal(result.status, 2, 'exit 2 saat pid lain memegang lock')
        assert.match(result.stderr, /pid/)
    })
})

describe('dry-run', () => {
    test('dry-run tidak menulis database dan tidak me-rename sumber', () => {
        const dir = path.join(tmpRoot, 'dry-case')
        writeFixture(dir)
        const dbPath = path.join(dir, 'database.db')

        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', dbPath, '--dry-run'])
        assert.equal(result.status, 0, `gagal: ${result.stderr}`)

        const report = parseReport(result.stdout)
        assert.equal(report.dryRun, true)
        assert.equal(report.marked, false)
        assert.equal(report.backupDir, null)

        assert.equal(fs.existsSync(dbPath), false, 'database.db tidak dibuat saat dry-run')
        assert.ok(fs.existsSync(path.join(dir, 'users.json')), 'sumber tidak direname saat dry-run')
        assert.equal(fs.existsSync(path.join(dir, 'users.json.migrated')), false)
        assert.equal(fs.existsSync(path.join(dir, 'database.backup-1')), false)
    })

    test('dry-run tetap memverifikasi data', () => {
        const dir = path.join(tmpRoot, 'dry-case')
        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', path.join(dir, 'database.db'), '--dry-run'])
        assert.equal(result.status, 0)

        const report = parseReport(result.stdout)
        assert.deepEqual(report.tables.users, { read: 3, written: 2, merged: 1, skipped: 0 })
        assert.deepEqual(report.tables.crm_messages, { read: 3, written: 2, merged: 0, skipped: 1 })
    })
})

describe('file json rusak', () => {
    test('json rusak dipulihkan dari .bak dan puing diabaikan', () => {
        const dir = path.join(tmpRoot, 'bak-case')
        writeFixture(dir)

        fs.writeFileSync(path.join(dir, 'groups.json'), '{ ini bukan json')
        fs.writeFileSync(path.join(dir, 'groups.json.bak'), JSON.stringify({
            '333@g.us': {
                jid: '333@g.us',
                name: 'Grup Backup',
                createdAt: '2026-05-01T00:00:00.000Z',
                settings: {}
            }
        }, null, 2))

        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', path.join(dir, 'database.db')])
        assert.equal(result.status, 0, `gagal: ${result.stderr}`)

        const report = parseReport(result.stdout)
        assert.deepEqual(report.usingBackupFor, ['groups.json'])
        assert.deepEqual(report.tables.wa_groups, { read: 1, written: 1, merged: 0, skipped: 0 })

        const db = new Database(path.join(dir, 'database.db'))
        try {
            assert.equal(db.prepare('SELECT name FROM wa_groups WHERE jid = ?').get('333@g.us').name, 'Grup Backup')
        } finally {
            db.close()
        }
    })

    test('json rusak tanpa .bak dilewati tanpa crash', () => {
        const dir = path.join(tmpRoot, 'nobak-case')
        writeFixture(dir)
        fs.writeFileSync(path.join(dir, 'schedules.json'), '[[[ rusak total')
        fs.rmSync(path.join(dir, 'schedules.json.bak'), { force: true })

        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', path.join(dir, 'database.db')])
        assert.equal(result.status, 0, `gagal: ${result.stderr}`)
    })
})

describe('skip-crm dan export rollback', () => {
    test('--skip-crm membiarkan tabel crm kosong', () => {
        const dir = path.join(tmpRoot, 'skipcrm-case')
        writeFixture(dir)

        const result = runScript(MIGRATE_SCRIPT, ['--dir', dir, '--db', path.join(dir, 'database.db'), '--skip-crm'])
        assert.equal(result.status, 0, `gagal: ${result.stderr}`)

        const db = new Database(path.join(dir, 'database.db'))
        try {
            assert.equal(db.prepare('SELECT count(*) AS t FROM crm_messages').get().t, 0)
            assert.equal(db.prepare('SELECT count(*) AS t FROM crm_nodes').get().t, 0)
            assert.equal(db.prepare('SELECT count(*) AS t FROM users').get().t, 2)
        } finally {
            db.close()
        }
    })

    test('export balik lalu migrasi ulang menghasilkan data setara', () => {
        const exportDir = path.join(tmpRoot, 'rollback-json')
        const dbPath = path.join(tmpRoot, 'rollback.db')

        const exportResult = runScript(EXPORT_SCRIPT, ['--db', dbFile, '--dir', exportDir])
        assert.equal(exportResult.status, 0, `gagal: ${exportResult.stderr}`)

        const summary = parseReport(exportResult.stdout)
        assert.equal(summary.files.users, 2)
        assert.equal(summary.files.owners, 2)
        assert.equal(summary.files.premiums, 1)
        assert.equal(summary.files.groups, 2)
        assert.equal(summary.files.settings, 1)
        assert.equal(summary.files.identity, 1)
        assert.equal(summary.files.schedules, 2)
        assert.equal(fs.existsSync(path.join(exportDir, 'crm-messages.json')), false, 'CRM tidak diekspor')

        const migratedAgain = runScript(MIGRATE_SCRIPT, ['--dir', exportDir, '--db', dbPath])
        assert.equal(migratedAgain.status, 0, `gagal: ${migratedAgain.stderr}`)

        const first = new Database(dbFile)
        const second = new Database(dbPath)
        try {
            const compare = (sql, args = []) =>
                JSON.stringify(first.prepare(sql).all(...args)) === JSON.stringify(second.prepare(sql).all(...args))

            assert.ok(compare('SELECT key, jid, name, first_seen, last_seen, remaining_limit FROM users ORDER BY key'), 'users setara')
            assert.ok(compare('SELECT number, role, jid FROM access_roles ORDER BY role, number'), 'access setara')
            assert.ok(compare('SELECT jid, name, created_at, settings FROM wa_groups ORDER BY jid'), 'groups setara')
            assert.ok(compare("SELECT key, value FROM settings WHERE key <> 'jsonMigration' ORDER BY key"), 'settings setara')
            assert.ok(compare('SELECT pn, lid FROM identity_map ORDER BY pn'), 'identity setara')
            assert.ok(compare('SELECT id, chat_jid, content, at, every, cron, next_run_at, last_run_at, run_count FROM schedules ORDER BY id'), 'schedules setara')

            assert.equal(second.prepare('SELECT count(*) AS t FROM crm_messages').get().t, 0, 'CRM tidak diekspor memang kosong')
        } finally {
            first.close()
            second.close()
        }
    })
})
