import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { proto } from '@whiskeysockets/baileys'
import { toUserJid, toNumber } from '../src/utils/identity.js'
import { runMigrations } from '../src/services/database/migrations/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const CRM_RETENTION_SEC = 7 * 24 * 60 * 60
const OUTGOING_TTL_MS = 60 * 60 * 1000
const LOCK_FILE_SUFFIX = '.migrating'
const MARKER_KEY = 'jsonMigration'

const JSON_FILES = [
    'users.json',
    'groups.json',
    'settings.json',
    'identity.json',
    'messages.json',
    'schedules.json',
    'owner.json',
    'premium.json',
    'crm-messages.json',
    'crm-nodes.json',
    'crm-meta.json'
]

function parseArgs(argv) {
    const flags = new Set()
    const values = {}

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=')
            if (eq > 2) {
                values[arg.slice(2, eq)] = arg.slice(eq + 1)
            } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
                values[arg.slice(2)] = argv[i + 1]
                i += 1
            } else {
                flags.add(arg.slice(2))
            }
        }
    }

    return { flags, values }
}

function readJson(dir, name) {
    const file = path.join(dir, name)
    let raw = null

    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch {
        raw = null
    }

    if (raw !== null) {
        try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: parsed, source: name }
        } catch {}
    }

    const backup = `${file}.bak`
    try {
        const rawBackup = fs.readFileSync(backup, 'utf8')
        const parsed = JSON.parse(rawBackup)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: parsed, source: `${name}.bak` }
    } catch {}

    return { data: {}, source: null }
}

function readList(dir, name) {
    const file = path.join(dir, name)

    for (const candidate of [file, `${file}.bak`]) {
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
            if (Array.isArray(parsed)) return { data: parsed, source: path.basename(candidate) }
        } catch {}
    }

    return { data: [], source: null }
}

function openTargetDatabase(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    const pageCount = db.pragma('page_count', { simple: true })
    if (pageCount === 0) db.pragma('auto_vacuum = INCREMENTAL')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    runMigrations(db)
    return db
}

function hasMarker(db) {
    const row = db.prepare('SELECT 1 AS found FROM settings WHERE key = ?').get(MARKER_KEY)
    return !!row
}

function clearDataTables(db) {
    db.transaction(() => {
        for (const table of ['users', 'access_roles', 'wa_groups', 'settings', 'identity_map', 'outgoing_messages', 'schedules', 'crm_messages', 'crm_nodes']) {
            db.prepare(`DELETE FROM ${table}`).run()
        }
    })()
}

function setMarker(db, dir) {
    db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(MARKER_KEY, JSON.stringify({ at: Date.now(), from: dir }), Date.now())
}

function toEpochMs(iso, fallback) {
    const value = Date.parse(iso)
    return Number.isFinite(value) ? value : fallback
}

function buildIdentityResolution(identityData) {
    const pnToLid = new Map()

    for (const [pn, lid] of Object.entries(identityData || {})) {
        if (typeof pn !== 'string' || typeof lid !== 'string') continue
        let owner = null
        for (const [existingPn, existingLid] of pnToLid) {
            if (existingLid === lid && existingPn !== pn) {
                owner = existingPn
                break
            }
        }
        if (owner !== null) pnToLid.delete(owner)
        pnToLid.set(pn, lid)
    }

    const lidToPn = new Map()
    for (const [pn, lid] of pnToLid) lidToPn.set(lid, pn)

    return { pnToLid, lidToPn }
}

function migrateUsers(db, report, usersData, identity) {
    const read = Object.entries(usersData || {})
    const mergedRows = new Map()
    let merged = 0
    let skipped = 0

    const insert = db.prepare('INSERT OR REPLACE INTO users(key, jid, name, first_seen, last_seen, remaining_limit) VALUES (?, ?, ?, ?, ?, ?)')

    for (const [key, record] of read) {
        if (!record || typeof record !== 'object' || typeof record.jid !== 'string') {
            skipped += 1
            continue
        }

        let targetKey = key
        if (key.endsWith('@lid')) {
            const lidUserPart = key.slice(0, key.indexOf('@'))
            if (identity.lidToPn.has(lidUserPart)) targetKey = identity.lidToPn.get(lidUserPart)
        }
        if (targetKey !== key) merged += 1

        const entry = mergedRows.get(targetKey) || {
            jid: '',
            name: '',
            first_seen: Number.POSITIVE_INFINITY,
            last_seen: Number.NEGATIVE_INFINITY,
            remaining_limit: Number.POSITIVE_INFINITY
        }

        const firstSeen = toEpochMs(record.firstSeen, null)
        const lastSeen = toEpochMs(record.lastSeen, null)
        if (firstSeen === null || lastSeen === null || !Number.isFinite(Number(record.limit))) {
            skipped += 1
            continue
        }

        if (!entry.jid || entry.jid.endsWith('@lid')) entry.jid = record.jid
        if (!entry.name && typeof record.name === 'string' && record.name) entry.name = record.name
        entry.first_seen = Math.min(entry.first_seen, firstSeen)
        entry.last_seen = Math.max(entry.last_seen, lastSeen)
        entry.remaining_limit = Math.min(entry.remaining_limit, Number(record.limit))
        mergedRows.set(targetKey, entry)
    }

    db.transaction(() => {
        for (const [key, entry] of mergedRows) {
            insert.run(
                key,
                entry.jid,
                entry.name,
                entry.first_seen,
                entry.last_seen,
                entry.remaining_limit
            )
        }
    })()

    report.users = { read: read.length, written: mergedRows.size, merged, skipped }
}

function migrateAccess(db, report, ownerList, premiumList) {
    const insert = db.prepare('INSERT OR REPLACE INTO access_roles(number, role, jid, created_at, expires_at) VALUES (?, ?, ?, ?, NULL)')
    let merged = 0

    db.transaction(() => {
        for (const role of ['owner', 'premium']) {
            const list = role === 'owner' ? ownerList : premiumList
            const seen = new Set()

            for (const entry of list) {
                const jid = toUserJid(entry)
                if (!jid) continue

                const number = toNumber(jid)
                if (seen.has(number)) {
                    merged += 1
                    continue
                }
                seen.add(number)
                insert.run(number, role, jid, Date.now())
            }
        }
    })()

    report.access_roles = {
        read: ownerList.length + premiumList.length,
        written: db.prepare('SELECT count(*) AS total FROM access_roles').get().total,
        merged,
        skipped: 0
    }
}

function collectStalePremiumFlags(usersData, premiumList) {
    const premiumNumbers = new Set(premiumList.map(toNumber).filter(Boolean))
    const stale = []

    for (const [key, record] of Object.entries(usersData || {})) {
        if (!record?.premium) continue
        const number = key.endsWith('@lid') ? null : toNumber(key)
        if (number && !premiumNumbers.has(number)) stale.push(key)
    }

    return stale
}

function migrateGroups(db, report, groupsData) {
    const insert = db.prepare('INSERT OR REPLACE INTO wa_groups(jid, name, created_at, settings) VALUES (?, ?, ?, ?)')
    let skipped = 0
    const valid = []

    for (const [jid, record] of Object.entries(groupsData || {})) {
        if (!jid.endsWith('@g.us') || !record || typeof record !== 'object') {
            skipped += 1
            continue
        }
        valid.push([jid, record])
    }

    db.transaction(() => {
        for (const [jid, record] of valid) {
            insert.run(
                jid,
                String(record.name || ''),
                toEpochMs(record.createdAt, Date.now()),
                JSON.stringify(record.settings && typeof record.settings === 'object' ? record.settings : {})
            )
        }
    })()

    report.wa_groups = { read: Object.keys(groupsData || {}).length, written: valid.length, merged: 0, skipped }
}

function migrateSettings(db, report, settingsData) {
    const insert = db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)')
    const entries = Object.entries(settingsData || {}).filter(([, value]) => value && typeof value === 'object')
    const stamp = Date.now()

    db.transaction(() => {
        for (const [key, value] of entries) {
            insert.run(key, JSON.stringify(value), stamp)
        }
    })()

    report.settings = { read: Object.keys(settingsData || {}).length, written: entries.length, merged: 0, skipped: Object.keys(settingsData || {}).length - entries.length }
}

function migrateIdentity(db, report, identityData) {
    const base = Date.now()
    const entries = Object.entries(identityData || {}).filter(([pn, lid]) => typeof pn === 'string' && typeof lid === 'string')
    const seenPn = new Set()
    const seenLid = new Map()
    let merged = 0

    db.transaction(() => {
        entries.forEach(([pn, lid], index) => {
            if (seenPn.has(pn)) {
                merged += 1
                return
            }
            if (seenLid.has(lid) && seenLid.get(lid) !== pn) {
                merged += 1
            }
            seenPn.add(pn)
            seenLid.set(lid, pn)

            db.prepare('DELETE FROM identity_map WHERE lid = ? AND pn <> ?').run(lid, pn)
            db.prepare('INSERT INTO identity_map(pn, lid, updated_at) VALUES (?, ?, ?) ON CONFLICT(pn) DO UPDATE SET lid = excluded.lid, updated_at = excluded.updated_at')
                .run(pn, lid, base - entries.length + index)
        })
    })()

    report.identity_map = { read: Object.keys(identityData || {}).length, written: seenPn.size, merged, skipped: Object.keys(identityData || {}).length - entries.length }
}

function migrateOutgoing(db, report, messagesData) {
    const insert = db.prepare('INSERT OR REPLACE INTO outgoing_messages(id, jid, content, created_at) VALUES (?, ?, ?, ?)')
    const now = Date.now()
    let skipped = 0
    const valid = []

    for (const [id, record] of Object.entries(messagesData || {})) {
        const isFresh = record?.v === 1 && record?.id && record?.content && typeof record.content === 'object' && Number.isFinite(Number(record.at)) && now - Number(record.at) < OUTGOING_TTL_MS
        if (!isFresh) {
            skipped += 1
            continue
        }
        valid.push([record.id, typeof record.jid === 'string' ? record.jid : null, JSON.stringify(record.content), Number(record.at)])
    }

    db.transaction(() => {
        for (const row of valid) insert.run(...row)
    })()

    report.outgoing_messages = { read: Object.keys(messagesData || {}).length, written: valid.length, merged: 0, skipped }
}

function migrateSchedules(db, report, schedulesData) {
    const insert = db.prepare('INSERT OR REPLACE INTO schedules(id, chat_jid, content, at, every, cron, next_run_at, last_run_at, run_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    let skipped = 0
    const valid = []

    for (const [id, record] of Object.entries(schedulesData || {})) {
        if (!record?.id || typeof record.chatJid !== 'string' || !record.content || typeof record.content !== 'object') {
            skipped += 1
            continue
        }
        valid.push([
            String(record.id),
            record.chatJid,
            JSON.stringify(record.content),
            Number.isFinite(Number(record.at)) ? Number(record.at) : null,
            Number.isFinite(Number(record.every)) ? Number(record.every) : null,
            typeof record.cron === 'string' ? record.cron : null,
            Number.isFinite(Number(record.nextRunAt)) ? Number(record.nextRunAt) : null,
            Number.isFinite(Number(record.lastRunAt)) ? Number(record.lastRunAt) : null,
            Number.isFinite(Number(record.runCount)) ? Number(record.runCount) : 0
        ])
    }

    db.transaction(() => {
        for (const row of valid) insert.run(...row)
    })()

    report.schedules = { read: Object.keys(schedulesData || {}).length, written: valid.length, merged: 0, skipped }
}

function migrateCrm(db, report, crmMessagesData, crmNodesData, crmMetaData) {
    const cutoff = Math.floor(Date.now() / 1000) - CRM_RETENTION_SEC
    const insertMessage = db.prepare('INSERT INTO crm_messages(rowid, msg_id, chat, sender, ts, data) VALUES (?, ?, ?, ?, ?, ?)')
    const insertNode = db.prepare('INSERT OR REPLACE INTO crm_nodes(msg_id, chat, data, created_at) VALUES (?, ?, ?, ?)')

    let messageSkipped = 0
    let nodeSkipped = 0
    let maxRowid = 0
    const validMessages = []

    for (const [key, record] of Object.entries(crmMessagesData || {})) {
        const rowid = Number(key)
        if (!Number.isFinite(rowid) || rowid <= 0 || !record?.id || typeof record.chat !== 'string' || typeof record.data !== 'string') {
            messageSkipped += 1
            continue
        }
        if (Number.isFinite(Number(record.timestamp)) && Number(record.timestamp) < cutoff) {
            messageSkipped += 1
            continue
        }
        validMessages.push([rowid, String(record.id), record.chat, typeof record.sender === 'string' ? record.sender : null, Number.isFinite(Number(record.timestamp)) ? Number(record.timestamp) : null, Buffer.from(record.data, 'base64')])
        maxRowid = Math.max(maxRowid, rowid)
    }

    const validNodes = []
    for (const [key, record] of Object.entries(crmNodesData || {})) {
        let msgId = null
        let chat = null
        try {
            const pair = JSON.parse(key)
            if (Array.isArray(pair) && pair.length === 2) [msgId, chat] = pair
        } catch {}

        if (!msgId || !chat || !record?.data || typeof record.data !== 'string') {
            nodeSkipped += 1
            continue
        }
        validNodes.push([String(msgId), String(chat), record.data, Number.isFinite(Number(record.created_at)) ? Number(record.created_at) : Math.floor(Date.now() / 1000)])
    }

    const metaSeq = Number(crmMetaData?.seq)

    db.transaction(() => {
        for (const row of validMessages) insertMessage.run(...row)
        for (const row of validNodes) insertNode.run(...row)

        const sequence = Number.isFinite(metaSeq) && metaSeq > maxRowid ? Math.floor(metaSeq) : maxRowid
        if (sequence > 0) {
            db.prepare("DELETE FROM sqlite_sequence WHERE name = 'crm_messages'").run()
            db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('crm_messages', ?)").run(sequence)
        }
    })()

    report.crm_messages = { read: Object.keys(crmMessagesData || {}).length, written: validMessages.length, merged: 0, skipped: messageSkipped }
    report.crm_nodes = { read: Object.keys(crmNodesData || {}).length, written: validNodes.length, merged: 0, skipped: nodeSkipped }
}

function verify(db, report, expectedCounts) {
    const problems = []

    for (const [table, expected] of Object.entries(expectedCounts)) {
        const actual = db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total
        if (actual !== expected) problems.push(`tabel ${table}: ${actual} baris, diharapkan ${expected}`)
    }

    if (db.pragma('integrity_check', { simple: true }) !== 'ok') problems.push('integrity_check gagal')
    const fkIssues = db.pragma('foreign_key_check')
    if (Array.isArray(fkIssues) && fkIssues.length) problems.push('foreign_key_check menemukan pelanggaran')

    const sample = db.prepare('SELECT rowid, msg_id, data FROM crm_messages ORDER BY random() LIMIT 200').all()
    for (const row of sample) {
        try {
            const decoded = proto.WebMessageInfo.decode(row.data)
            if (decoded?.key?.id !== row.msg_id) problems.push(`pesan CRM rowid ${row.rowid}: key.id tidak cocok msg_id`)
        } catch {
            problems.push(`pesan CRM rowid ${row.rowid}: gagal didecode`)
        }
    }

    return problems
}

function backupSourceDir(dir, dryRun) {
    if (dryRun) return null

    const stamp = new Date()
    const pad = value => String(value).padStart(2, '0')
    const name = `database.backup-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
    const target = path.join(path.dirname(path.resolve(dir)), name)
    fs.mkdirSync(target, { recursive: true })

    const copyRecursive = (from, to) => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name === 'backups') continue
                copyRecursive(path.join(from, entry.name), path.join(to, entry.name))
                continue
            }
            if (/^database\.db(-wal|-shm)?$/.test(entry.name) || entry.name.endsWith(LOCK_FILE_SUFFIX)) continue
            fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name))
        }
    }

    copyRecursive(dir, target)
    return target
}

function acquirePidLock(dbPath) {
    const lockFile = `${dbPath}${LOCK_FILE_SUFFIX}`
    if (fs.existsSync(lockFile)) {
        const raw = fs.readFileSync(lockFile, 'utf8').trim()
        const pid = Number(raw)
        if (Number.isFinite(pid) && pid > 0) {
            try {
                process.kill(pid, 0)
                return { ok: false, reason: `proses migrasi lain (pid ${pid}) masih berjalan` }
            } catch {}
        }
    }
    fs.writeFileSync(lockFile, String(process.pid))
    return { ok: true, lockFile }
}

function releasePidLock(lockFile) {
    if (lockFile) {
        try {
            fs.rmSync(lockFile, { force: true })
        } catch {}
    }
}

function renameMigratedSources(dir) {
    const renamed = []
    for (const name of JSON_FILES) {
        const file = path.join(dir, name)
        if (fs.existsSync(file)) {
            fs.renameSync(file, `${file}.migrated`)
            renamed.push(name)
        }
    }
    return renamed
}

function printReport(summary) {
    console.log(JSON.stringify(summary, null, 2))
}

async function main() {
    const { flags, values } = parseArgs(process.argv.slice(2))
    const dryRun = flags.has('dry-run')
    const skipCrm = flags.has('skip-crm')
    const force = flags.has('force')
    const dir = path.resolve(values.dir || path.join(ROOT, 'database'))
    const dbPath = path.resolve(values.db || path.join(dir, 'database.db'))

    if (!fs.existsSync(dir)) {
        console.error(`Direktori sumber tidak ditemukan: ${dir}`)
        process.exit(2)
    }

    const shmFile = `${dbPath}-shm`
    if (fs.existsSync(shmFile)) {
        console.error(`Terdeteksi ${path.basename(shmFile)}: indikasi proses bot masih memegang database. Hentikan bot (SIGTERM) sebelum migrasi; bila file sisa crash, hapus manual dan jalankan ulang.`)
        process.exit(2)
    }

    const report = {}
    const summary = {
        source: dir,
        database: dbPath,
        dryRun,
        skipCrm,
        backupDir: null,
        stalePremiumFlags: [],
        tables: report,
        marked: false,
        renamed: []
    }

    if (!dryRun) {
        const lock = acquirePidLock(dbPath)
        if (!lock.ok) {
            console.error(`Pengecekan pid: ${lock.reason}. Hapus ${dbPath}${LOCK_FILE_SUFFIX} bila proses tersebut sudah tidak ada.`)
            process.exit(2)
        }
        summary.lockFile = lock.lockFile

        try {
            const backupDir = backupSourceDir(dir, dryRun)
            summary.backupDir = backupDir
        } catch (error) {
            releasePidLock(summary.lockFile)
            console.error(`Backup sumber gagal: ${error.message}`)
            process.exit(2)
        }

        try {
            const db = openTargetDatabase(dbPath)
            let alreadyMarked = false
            try {
                alreadyMarked = hasMarker(db)
            } finally {
                db.close()
            }
            if (alreadyMarked && !force) {
                console.error(`Database sudah ditandai migrasi selesai (key ${MARKER_KEY} di settings). Gunakan --force untuk migrasi ulang.`)
                releasePidLock(summary.lockFile)
                process.exit(3)
            }
        } catch (error) {
            releasePidLock(summary.lockFile)
            console.error(`Gagal membuka database: ${error.message}`)
            process.exit(2)
        }

        try {
            await runMigration(dir, dbPath, summary, report, { dryRun, skipCrm, force })
            releasePidLock(summary.lockFile)
            printReport(summary)
            process.exit(0)
        } catch (error) {
            releasePidLock(summary.lockFile)
            console.error(`Migrasi gagal: ${error.message}`)
            process.exit(1)
        }
        return
    }

    try {
        await runMigration(dir, ':memory:', summary, report, { dryRun, skipCrm, force })
        printReport(summary)
        process.exit(0)
    } catch (error) {
        console.error(`Dry-run gagal: ${error.message}`)
        process.exit(1)
    }
}

async function runMigration(dir, dbPath, summary, report, { dryRun, skipCrm, force }) {
    const users = readJson(dir, 'users.json')
    const groups = readJson(dir, 'groups.json')
    const settings = readJson(dir, 'settings.json')
    const identity = readJson(dir, 'identity.json')
    const messages = readJson(dir, 'messages.json')
    const schedules = readJson(dir, 'schedules.json')
    const owner = readList(dir, 'owner.json')
    const premium = readList(dir, 'premium.json')
    const crmMessages = readJson(dir, 'crm-messages.json')
    const crmNodes = readJson(dir, 'crm-nodes.json')
    const crmMeta = readJson(dir, 'crm-meta.json')

    summary.usingBackupFor = [
        ['users.json', users.source],
        ['groups.json', groups.source],
        ['settings.json', settings.source],
        ['identity.json', identity.source],
        ['messages.json', messages.source],
        ['schedules.json', schedules.source],
        ['owner.json', owner.source],
        ['premium.json', premium.source],
        ['crm-messages.json', crmMessages.source],
        ['crm-nodes.json', crmNodes.source],
        ['crm-meta.json', crmMeta.source]
    ].filter(([name, source]) => source === `${name}.bak`).map(([name]) => name)

    const db = openTargetDatabase(dbPath)

    try {
        if (hasMarker(db) && !force && dbPath !== ':memory:') {
            throw new Error(`database sudah ditandai migrasi selesai (key ${MARKER_KEY})`)
        }

        const markerExisted = hasMarker(db)
        const sourceRecords =
            Object.keys(users.data || {}).length +
            Object.keys(groups.data || {}).length +
            Object.keys(settings.data || {}).length +
            Object.keys(identity.data || {}).length +
            Object.keys(messages.data || {}).length +
            Object.keys(schedules.data || {}).length +
            owner.data.length +
            premium.data.length +
            Object.keys(crmMessages.data || {}).length +
            Object.keys(crmNodes.data || {}).length

        if (!dryRun && force && sourceRecords === 0) {
            setMarker(db, dir)
            summary.marked = true
            return
        }

        if (!dryRun && force) clearDataTables(db)

        const identityResolution = buildIdentityResolution(identity.data)
        const stalePremiumFlags = collectStalePremiumFlags(users.data, premium.data)
        summary.stalePremiumFlags = stalePremiumFlags

        migrateUsers(db, report, users.data, identityResolution)
        migrateAccess(db, report, owner.data, premium.data)
        migrateGroups(db, report, groups.data)
        migrateSettings(db, report, settings.data)
        migrateIdentity(db, report, identity.data)
        migrateOutgoing(db, report, messages.data)
        migrateSchedules(db, report, schedules.data)

        if (skipCrm) {
            report.crm_messages = { read: Object.keys(crmMessages.data || {}).length, written: 0, merged: 0, skipped: 0 }
            report.crm_nodes = { read: Object.keys(crmNodes.data || {}).length, written: 0, merged: 0, skipped: 0 }
        } else {
            migrateCrm(db, report, crmMessages.data, crmNodes.data, crmMeta.data)
        }

        const expectedCounts = {
            users: report.users.written,
            access_roles: report.access_roles.written,
            wa_groups: report.wa_groups.written,
            settings: report.settings.written + (markerExisted ? 1 : 0),
            identity_map: report.identity_map.written,
            outgoing_messages: report.outgoing_messages.written,
            schedules: report.schedules.written
        }

        if (!skipCrm) {
            expectedCounts.crm_messages = report.crm_messages.written
            expectedCounts.crm_nodes = report.crm_nodes.written
        }

        const problems = verify(db, report, expectedCounts)
        if (problems.length) throw new Error(`verifikasi gagal: ${problems.join('; ')}`)

        if (!dryRun) {
            setMarker(db, dir)
            summary.marked = true
            summary.renamed = renameMigratedSources(dir)
        }
    } finally {
        db.close()
    }
}

main().catch(error => {
    console.error(`Kesalahan tak terduga: ${error.message}`)
    process.exit(1)
})
