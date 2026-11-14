import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { runMigrations } from './migrations/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATABASE_DIR = path.join(__dirname, '../../../database')
const LEGACY_DATABASE_DIR = path.join(__dirname, '../../database')
const LEGACY_DATABASE_FILES = ['database.db', 'database.db-wal', 'database.db-shm']
const LEGACY_DATABASE_FOLDERS = ['backups', 'logs']
const BACKUP_NAME_PATTERN = /^database-\d{8}-\d{6}\.db$/

let instance = null
const statementCache = new Map()

export function databasePath() {
    if (process.env.WA_DATABASE_FILE) return path.resolve(process.env.WA_DATABASE_FILE)
    const dir = process.env.WA_DATABASE_DIR || DEFAULT_DATABASE_DIR
    return path.resolve(dir, 'database.db')
}

function applyConnectionPragmas(db) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma('temp_store = MEMORY')
    db.pragma('cache_size = -65536')
}

export function migrateLegacyDatabase({ legacyDir = LEGACY_DATABASE_DIR, targetDir = DEFAULT_DATABASE_DIR } = {}) {
    const legacyFile = path.join(legacyDir, 'database.db')
    const targetFile = path.join(targetDir, 'database.db')

    if (path.resolve(legacyDir) === path.resolve(targetDir)) return { moved: false, reason: 'same-dir' }
    if (!fs.existsSync(legacyFile)) return { moved: false, reason: 'no-legacy' }
    if (fs.existsSync(targetFile)) return { moved: false, reason: 'target-exists' }

    fs.mkdirSync(targetDir, { recursive: true })

    const copied = []
    const moved = []

    try {
        for (const name of LEGACY_DATABASE_FILES) {
            const from = path.join(legacyDir, name)
            if (!fs.existsSync(from)) continue

            const to = path.join(targetDir, name)
            fs.copyFileSync(from, to)
            copied.push(to)

            if (fs.statSync(to).size !== fs.statSync(from).size) {
                throw new Error(`ukuran salinan ${name} tidak sama dengan aslinya`)
            }
            moved.push(name)
        }

        for (const name of LEGACY_DATABASE_FOLDERS) {
            const from = path.join(legacyDir, name)
            const to = path.join(targetDir, name)
            if (!fs.existsSync(from) || fs.existsSync(to)) continue

            fs.cpSync(from, to, { recursive: true })
            copied.push(to)
            moved.push(`${name}/`)
        }
    } catch (error) {
        for (const target of copied.reverse()) fs.rmSync(target, { recursive: true, force: true })
        throw new Error(`Gagal memindahkan database dari ${legacyDir} ke ${targetDir}: ${error.message}`)
    }

    for (const name of moved) fs.rmSync(path.join(legacyDir, name), { recursive: true, force: true })

    try {
        fs.rmdirSync(legacyDir)
    } catch {}

    return { moved: true, items: moved, from: legacyDir, to: targetDir }
}

function migrateLegacyDefaultLocation() {
    if (process.env.WA_DATABASE_FILE || process.env.WA_DATABASE_DIR) return

    const result = migrateLegacyDatabase()
    if (result.moved) {
        console.log(`[database] data dipindahkan dari ${result.from} ke ${result.to}: ${result.items.join(', ')}`)
    }
}

function openDatabase() {
    migrateLegacyDefaultLocation()

    const file = databasePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })

    const db = new Database(file)
    const pageCount = db.pragma('page_count', { simple: true })
    if (pageCount === 0) db.pragma('auto_vacuum = INCREMENTAL')

    applyConnectionPragmas(db)
    runMigrations(db)
    return db
}

export function getDatabase() {
    if (!instance) instance = openDatabase()
    return instance
}

export function isDatabaseOpen() {
    return instance !== null
}

export function prepare(sql) {
    const db = getDatabase()
    let statement = statementCache.get(sql)
    if (!statement || statement.database !== db) {
        statement = db.prepare(sql)
        statementCache.set(sql, statement)
    }
    return statement
}

export function transaction(fn) {
    return getDatabase().transaction(fn)()
}

export function checkpointDatabase() {
    if (!instance) return
    instance.pragma('wal_checkpoint(PASSIVE)')
}

export function closeDatabase() {
    if (!instance) return
    try {
        instance.pragma('wal_checkpoint(TRUNCATE)')
    } catch {}
    statementCache.clear()
    instance.close()
    instance = null
}

function backupStamp(date) {
    const pad = value => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function pruneBackups(dir, keep) {
    const limit = Number(keep)
    if (!Number.isFinite(limit) || limit <= 0) return 0

    const files = fs.readdirSync(dir)
        .filter(name => BACKUP_NAME_PATTERN.test(name))
        .sort()
        .reverse()

    let pruned = 0
    for (const name of files.slice(Math.floor(limit))) {
        try {
            fs.rmSync(path.join(dir, name), { force: true })
            pruned += 1
        } catch {}
    }
    return pruned
}

export function backupDatabase(dir, keep = 7) {
    const db = getDatabase()
    fs.mkdirSync(dir, { recursive: true })

    let stamp = backupStamp(new Date())
    let target = path.join(dir, `database-${stamp}.db`)
    let guard = 0
    while (fs.existsSync(target) && guard < 86400) {
        stamp = backupStamp(new Date(Date.now() + (guard + 1) * 1000))
        target = path.join(dir, `database-${stamp}.db`)
        guard += 1
    }

    db.prepare('VACUUM INTO ?').run(target)
    const pruned = pruneBackups(dir, keep)
    return { file: target, size: fs.statSync(target).size, pruned }
}

export function resetDatabaseForTests() {
    closeDatabase()
    const file = databasePath()
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            fs.rmSync(`${file}${suffix}`, { force: true })
        } catch {}
    }
}

export function getDatabaseStats() {
    const db = getDatabase()
    const file = databasePath()

    const sizeOf = target => {
        try {
            return fs.statSync(target).size
        } catch {
            return 0
        }
    }

    const tables = {}
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    for (const row of rows) {
        tables[row.name] = db.prepare(`SELECT count(*) AS total FROM "${row.name}"`).get().total
    }

    return {
        path: file,
        sizeBytes: {
            database: sizeOf(file),
            wal: sizeOf(`${file}-wal`)
        },
        tables
    }
}

export default { getDatabase, isDatabaseOpen, databasePath, transaction, checkpointDatabase, closeDatabase, backupDatabase, resetDatabaseForTests, getDatabaseStats, prepare }
