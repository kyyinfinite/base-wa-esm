import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

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

const writeJson = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function exportUsers(db, dir) {
    const rows = db.prepare('SELECT key, jid, name, first_seen, last_seen, remaining_limit FROM users').all()
    const data = {}

    for (const row of rows) {
        data[row.key] = {
            jid: row.jid,
            name: row.name,
            firstSeen: new Date(row.first_seen).toISOString(),
            lastSeen: new Date(row.last_seen).toISOString(),
            limit: row.remaining_limit,
            premium: false,
            owner: false,
            creator: false
        }
    }

    writeJson(path.join(dir, 'users.json'), data)
    return Object.keys(data).length
}

function exportAccess(db, dir) {
    const write = (role, file) => {
        const rows = db.prepare('SELECT jid FROM access_roles WHERE role = ? ORDER BY created_at, number').all(role)
        writeJson(path.join(dir, file), rows.map(row => row.jid))
        return rows.length
    }

    return { owners: write('owner', 'owner.json'), premiums: write('premium', 'premium.json') }
}

function exportGroups(db, dir) {
    const rows = db.prepare('SELECT jid, name, created_at, settings FROM wa_groups').all()
    const data = {}

    for (const row of rows) {
        let settings = {}
        try {
            const parsed = JSON.parse(row.settings)
            if (parsed && typeof parsed === 'object') settings = parsed
        } catch {}

        data[row.jid] = {
            jid: row.jid,
            name: row.name,
            createdAt: new Date(row.created_at).toISOString(),
            settings
        }
    }

    writeJson(path.join(dir, 'groups.json'), data)
    return Object.keys(data).length
}

function exportSettings(db, dir) {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key <> 'jsonMigration'").all()
    const data = {}

    for (const row of rows) {
        try {
            data[row.key] = JSON.parse(row.value)
        } catch {}
    }

    writeJson(path.join(dir, 'settings.json'), data)
    return Object.keys(data).length
}

function exportIdentity(db, dir) {
    const rows = db.prepare('SELECT pn, lid FROM identity_map').all()
    const data = {}

    for (const row of rows) {
        data[row.pn] = row.lid
    }

    writeJson(path.join(dir, 'identity.json'), data)
    return Object.keys(data).length
}

function exportSchedules(db, dir) {
    const rows = db.prepare('SELECT id, chat_jid, content, at, every, cron, next_run_at, last_run_at, run_count FROM schedules').all()
    const data = {}

    for (const row of rows) {
        let content = {}
        try {
            const parsed = JSON.parse(row.content)
            if (parsed && typeof parsed === 'object') content = parsed
        } catch {}

        data[row.id] = {
            id: row.id,
            chatJid: row.chat_jid,
            content,
            at: row.at ?? null,
            every: row.every ?? null,
            cron: row.cron ?? null,
            nextRunAt: row.next_run_at ?? null,
            lastRunAt: row.last_run_at ?? null,
            runCount: row.run_count ?? 0
        }
    }

    writeJson(path.join(dir, 'schedules.json'), data)
    return Object.keys(data).length
}

function main() {
    const { values } = parseArgs(process.argv.slice(2))
    const dbPath = path.resolve(values.db || path.join(ROOT, 'database', 'database.db'))
    const dir = path.resolve(values.dir || path.join(ROOT, 'rollback-json'))

    if (!fs.existsSync(dbPath)) {
        console.error(`Database tidak ditemukan: ${dbPath}`)
        process.exit(2)
    }

    fs.mkdirSync(dir, { recursive: true })

    const db = new Database(dbPath)

    try {
        const access = exportAccess(db, dir)
        const summary = {
            database: dbPath,
            output: dir,
            files: {
                users: exportUsers(db, dir),
                owners: access.owners,
                premiums: access.premiums,
                groups: exportGroups(db, dir),
                settings: exportSettings(db, dir),
                identity: exportIdentity(db, dir),
                schedules: exportSchedules(db, dir)
            }
        }

        console.log(JSON.stringify(summary, null, 2))
    } finally {
        db.close()
    }
}

main()
