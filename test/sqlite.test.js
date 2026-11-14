import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sqlite-'))
process.env.WA_DATABASE_DIR = tmp
delete process.env.WA_DATABASE_FILE

const sqlite = await import('../src/services/database/sqlite.js')
const { getDatabase, databasePath, transaction, checkpointDatabase, closeDatabase, backupDatabase, resetDatabaseForTests, getDatabaseStats, prepare } = sqlite
const { migrations, runMigrations } = await import('../src/services/database/migrations/index.js')

const dbFile = path.join(tmp, 'database.db')

before(() => {
    getDatabase()
})

after(() => {
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('sqlite: koneksi dan pragma', () => {
    test('pragma aktif sesuai spesifikasi', () => {
        const db = getDatabase()

        assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
        assert.equal(db.pragma('synchronous', { simple: true }), 1)
        assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
        assert.equal(db.pragma('busy_timeout', { simple: true }), 5000)
        assert.equal(db.pragma('temp_store', { simple: true }), 2)
        assert.equal(db.pragma('cache_size', { simple: true }), -65536)
        assert.equal(db.pragma('auto_vacuum', { simple: true }), 2)
    })

    test('databasePath dari WA_DATABASE_DIR', () => {
        assert.equal(databasePath(), dbFile)
    })

    test('databasePath memakai WA_DATABASE_FILE bila di-set', () => {
        const custom = path.join(tmp, 'custom', 'kustom.db')
        process.env.WA_DATABASE_FILE = custom
        try {
            assert.equal(databasePath(), custom)
            resetDatabaseForTests()
            getDatabase()
            assert.ok(fs.existsSync(custom), 'database dibuat di WA_DATABASE_FILE')
            assert.equal(getDatabaseStats().path, custom)
        } finally {
            delete process.env.WA_DATABASE_FILE
            resetDatabaseForTests()
        }
        assert.equal(databasePath(), dbFile)
    })

    test('skema lengkap terpasang', () => {
        const db = getDatabase()
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)

        assert.deepEqual(tables, [
            'access_roles',
            'crm_messages',
            'crm_nodes',
            'identity_map',
            'outgoing_messages',
            'schedules',
            'schema_migrations',
            'settings',
            'users',
            'wa_groups'
        ])
    })
})

describe('sqlite: migrasi', () => {
    test('migrasi tercatat di schema_migrations', () => {
        const db = getDatabase()
        const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()

        assert.deepEqual(rows, migrations.map(migration => ({ version: migration.version, name: migration.name })))
    })

    test('migrasi idempoten saat dijalankan ulang', () => {
        const db = getDatabase()
        runMigrations(db)

        const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
        assert.deepEqual(rows.map(row => row.version), migrations.map(migration => migration.version))
    })

    test('migrasi dijalankan ulang setelah close tanpa duplikasi tabel', () => {
        closeDatabase()
        const db = getDatabase()

        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").all()
        assert.equal(tables.length, 1, 'tabel users tetap tunggal')
    })
})

describe('sqlite: transaksi', () => {
    test('rollback saat error di dalam transaction', () => {
        const key = 'tx-rollback'
        prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify('awal'), Date.now())

        assert.throws(() => transaction(() => {
            prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify('diganti'), Date.now())
            throw new Error('gagal sengaja')
        }), /gagal sengaja/)

        const stored = prepare('SELECT value FROM settings WHERE key = ?').get(key)
        assert.equal(JSON.parse(stored.value), 'awal', 'perubahan di dalam transaksi dibatalkan')
    })

    test('commit saat transaksi selesai tanpa error', () => {
        const key = 'tx-commit'
        transaction(() => {
            prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify('tersimpan'), Date.now())
        })

        const stored = prepare('SELECT value FROM settings WHERE key = ?').get(key)
        assert.equal(JSON.parse(stored.value), 'tersimpan')
    })
})

describe('sqlite: persistensi dan checkpoint', () => {
    test('data bertahan setelah closeDatabase dan buka ulang', () => {
        const key = 'persist-key'
        prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ ok: true }), Date.now())

        closeDatabase()
        assert.equal(fs.existsSync(dbFile), true, 'file database utama ada')

        getDatabase()
        const stored = prepare('SELECT value FROM settings WHERE key = ?').get(key)
        assert.deepEqual(JSON.parse(stored.value), { ok: true })
    })

    test('wal mengecil setelah checkpoint TRUNCATE', () => {
        const db = getDatabase()
        prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run('wal-key', JSON.stringify('x'), Date.now())
        checkpointDatabase()

        closeDatabase()

        const walSize = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0
        assert.equal(walSize, 0, 'wal kosong setelah checkpoint TRUNCATE')

        getDatabase()
    })
})

describe('sqlite: backup dan rotasi', () => {
    test('backupDatabase memakai VACUUM INTO dengan nama timestamp', () => {
        const dir = path.join(tmp, 'backups')
        const result = backupDatabase(dir, 7)

        assert.match(path.basename(result.file), /^database-\d{8}-\d{6}\.db$/)
        assert.ok(fs.existsSync(result.file))
        assert.ok(result.size > 0)

        const copy = getDatabase().prepare("SELECT count(*) AS total FROM sqlite_master WHERE type = 'table'").get()
        assert.ok(copy.total > 0)
    })

    test('backup cadangan lama dihapus melebihi keep', () => {
        const dir = path.join(tmp, 'backups-rotasi')
        fs.mkdirSync(dir, { recursive: true })

        for (let i = 0; i < 3; i++) {
            const stamp = `2000010${i + 1}-000000`
            fs.writeFileSync(path.join(dir, `database-${stamp}.db`), 'lama')
        }

        const created = backupDatabase(dir, 2)
        assert.ok(fs.existsSync(created.file))

        const files = fs.readdirSync(dir).filter(name => name.startsWith('database-')).sort()
        assert.equal(files.length, 2, 'hanya 2 file terbaru tersisa')
        assert.equal(fs.existsSync(path.join(dir, 'database-20000101-000000.db')), false, 'backup tertua dihapus')
        assert.ok(files.includes(path.basename(created.file)), 'backup baru dipertahankan')
    })
})

describe('sqlite: statistik', () => {
    test('getDatabaseStats melaporkan ukuran file dan jumlah baris', () => {
        prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run('stat-key', JSON.stringify(1), Date.now())

        const stats = getDatabaseStats()

        assert.equal(stats.path, dbFile)
        assert.ok(stats.sizeBytes.database > 0)
        assert.ok(typeof stats.sizeBytes.wal === 'number')
        assert.ok(stats.tables.settings >= 1)
        assert.ok(stats.tables.users === 0)
        assert.ok(stats.tables.crm_messages === 0)
    })

    test('resetDatabaseForTests memulihkan database kosong', () => {
        prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run('reset-key', JSON.stringify(1), Date.now())

        resetDatabaseForTests()
        assert.equal(fs.existsSync(dbFile), false, 'file database terhapus')

        const stats = getDatabaseStats()
        assert.equal(stats.tables.settings, 0, 'tabel bersih setelah reset')
    })
})
