const INIT_SQL = `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
CREATE TABLE users(key TEXT PRIMARY KEY, jid TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, remaining_limit INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE access_roles(number TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','premium')), jid TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY(number, role)) WITHOUT ROWID;
CREATE TABLE wa_groups(jid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(settings))) WITHOUT ROWID;
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)), updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE identity_map(pn TEXT PRIMARY KEY, lid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX ix_identity_updated ON identity_map(updated_at);
CREATE TABLE outgoing_messages(id TEXT PRIMARY KEY, jid TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX ix_outgoing_created ON outgoing_messages(created_at);
CREATE TABLE schedules(id TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, content TEXT NOT NULL CHECK(json_valid(content)), at INTEGER, every INTEGER, cron TEXT, next_run_at INTEGER, last_run_at INTEGER, run_count INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE INDEX ix_schedules_next ON schedules(next_run_at);
CREATE TABLE crm_messages(rowid INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL, chat TEXT NOT NULL, sender TEXT, ts INTEGER, data BLOB NOT NULL);
CREATE INDEX ix_crm_msg_id ON crm_messages(msg_id, chat);
CREATE INDEX ix_crm_chat_ts ON crm_messages(chat, ts DESC, rowid DESC);
CREATE INDEX ix_crm_ts ON crm_messages(ts);
CREATE TABLE crm_nodes(msg_id TEXT NOT NULL, chat TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(msg_id, chat)) WITHOUT ROWID;
CREATE INDEX ix_crm_nodes_created ON crm_nodes(msg_id, created_at DESC);`


const REMOVE_GROUP_REPORT_SQL = `DROP TABLE IF EXISTS group_report_runs;
DROP TABLE IF EXISTS group_report_schedules;
DROP TABLE IF EXISTS group_report_messages;`

export const migrations = [
    { version: 1, name: '001-init', sql: INIT_SQL },
    { version: 4, name: '004-remove-group-report', sql: REMOVE_GROUP_REPORT_SQL }
]

function appliedVersions(db) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    if (!exists) return new Set()
    return new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version))
}

export function runMigrations(db) {
    const applied = appliedVersions(db)

    for (const migration of migrations) {
        if (applied.has(migration.version)) continue
        db.transaction(() => {
            db.exec(migration.sql)
            db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, Date.now())
        })()
    }
}

export default migrations
