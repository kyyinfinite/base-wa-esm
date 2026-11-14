import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

delete process.env.WA_DATABASE_DIR
delete process.env.WA_DATABASE_FILE

const { databasePath, migrateLegacyDatabase } = await import('../src/services/database/sqlite.js')

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dbloc-'))

let counter = 0
function makeDirs() {
    counter += 1
    const base = path.join(tmp, `case-${counter}`)
    const legacyDir = path.join(base, 'src', 'database')
    const targetDir = path.join(base, 'database')
    fs.mkdirSync(legacyDir, { recursive: true })
    return { legacyDir, targetDir }
}

function seedLegacy(legacyDir) {
    const db = new Database(path.join(legacyDir, 'database.db'))
    db.exec('CREATE TABLE contoh (id INTEGER PRIMARY KEY, nilai TEXT)')
    db.prepare('INSERT INTO contoh (nilai) VALUES (?)').run('data lama')
    db.close()
}

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('lokasi database', () => {
    test('default berada di root proyek, sejajar dengan src dan plugins', () => {
        assert.equal(databasePath(), path.join(REPO_ROOT, 'database', 'database.db'))
        assert.ok(!databasePath().includes(`${path.sep}src${path.sep}`))
    })
})

describe('pemindahan database lama dari src/database', () => {
    test('memindahkan db, wal, shm, backups, dan logs lalu membersihkan lokasi lama', () => {
        const { legacyDir, targetDir } = makeDirs()
        seedLegacy(legacyDir)
        fs.writeFileSync(path.join(legacyDir, 'database.db-wal'), 'wal-bytes')
        fs.writeFileSync(path.join(legacyDir, 'database.db-shm'), 'shm-bytes')
        fs.mkdirSync(path.join(legacyDir, 'backups'))
        fs.writeFileSync(path.join(legacyDir, 'backups', 'database-20260101-000000.db'), 'backup')
        fs.mkdirSync(path.join(legacyDir, 'logs'))
        fs.writeFileSync(path.join(legacyDir, 'logs', 'bot.log'), 'log')

        const result = migrateLegacyDatabase({ legacyDir, targetDir })

        assert.equal(result.moved, true)
        assert.deepEqual(result.items, ['database.db', 'database.db-wal', 'database.db-shm', 'backups/', 'logs/'])
        assert.equal(fs.readFileSync(path.join(targetDir, 'database.db-wal'), 'utf8'), 'wal-bytes')
        assert.equal(fs.readFileSync(path.join(targetDir, 'database.db-shm'), 'utf8'), 'shm-bytes')
        assert.equal(fs.readFileSync(path.join(targetDir, 'backups', 'database-20260101-000000.db'), 'utf8'), 'backup')
        assert.equal(fs.readFileSync(path.join(targetDir, 'logs', 'bot.log'), 'utf8'), 'log')

        for (const name of ['database.db', 'database.db-wal', 'database.db-shm', 'backups', 'logs']) {
            assert.equal(fs.existsSync(path.join(legacyDir, name)), false, name)
        }
    })

    test('isi database tetap utuh setelah dipindah', () => {
        const { legacyDir, targetDir } = makeDirs()
        seedLegacy(legacyDir)

        migrateLegacyDatabase({ legacyDir, targetDir })

        const db = new Database(path.join(targetDir, 'database.db'))
        const row = db.prepare('SELECT nilai FROM contoh WHERE id = 1').get()
        db.close()
        assert.equal(row.nilai, 'data lama')
    })

    test('tidak menimpa database yang sudah ada di lokasi baru', () => {
        const { legacyDir, targetDir } = makeDirs()
        seedLegacy(legacyDir)
        fs.mkdirSync(targetDir, { recursive: true })
        fs.writeFileSync(path.join(targetDir, 'database.db'), 'database baru')

        const result = migrateLegacyDatabase({ legacyDir, targetDir })

        assert.deepEqual(result, { moved: false, reason: 'target-exists' })
        assert.equal(fs.readFileSync(path.join(targetDir, 'database.db'), 'utf8'), 'database baru')
        assert.equal(fs.existsSync(path.join(legacyDir, 'database.db')), true, 'file lama tidak disentuh')
    })

    test('tidak melakukan apa pun bila tidak ada database lama atau direktori sama', () => {
        const { legacyDir, targetDir } = makeDirs()

        assert.deepEqual(migrateLegacyDatabase({ legacyDir, targetDir }), { moved: false, reason: 'no-legacy' })
        assert.equal(fs.existsSync(targetDir), false, 'direktori baru tidak dibuat tanpa alasan')

        seedLegacy(legacyDir)
        assert.deepEqual(migrateLegacyDatabase({ legacyDir, targetDir: legacyDir }), { moved: false, reason: 'same-dir' })
        assert.equal(fs.existsSync(path.join(legacyDir, 'database.db')), true)
    })

    test('kegagalan di tengah jalan membatalkan salinan dan membiarkan data lama utuh', () => {
        const { legacyDir, targetDir } = makeDirs()
        seedLegacy(legacyDir)
        fs.mkdirSync(path.join(legacyDir, 'database.db-wal'))

        assert.throws(() => migrateLegacyDatabase({ legacyDir, targetDir }), /Gagal memindahkan database/)

        assert.equal(fs.existsSync(path.join(targetDir, 'database.db')), false, 'salinan sebagian dihapus')
        assert.equal(fs.existsSync(path.join(legacyDir, 'database.db')), true, 'database lama tetap ada')
    })

    test('folder backups atau logs yang sudah ada di lokasi baru tidak ditimpa', () => {
        const { legacyDir, targetDir } = makeDirs()
        seedLegacy(legacyDir)
        fs.mkdirSync(path.join(legacyDir, 'logs'))
        fs.writeFileSync(path.join(legacyDir, 'logs', 'bot.log'), 'lama')
        fs.mkdirSync(path.join(targetDir, 'logs'), { recursive: true })
        fs.writeFileSync(path.join(targetDir, 'logs', 'bot.log'), 'baru')

        const result = migrateLegacyDatabase({ legacyDir, targetDir })

        assert.equal(result.moved, true)
        assert.deepEqual(result.items, ['database.db'])
        assert.equal(fs.readFileSync(path.join(targetDir, 'logs', 'bot.log'), 'utf8'), 'baru')
        assert.equal(fs.readFileSync(path.join(legacyDir, 'logs', 'bot.log'), 'utf8'), 'lama')
    })
})
