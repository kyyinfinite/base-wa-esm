import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-'))

process.env.WA_DATABASE_DIR = tmp
process.env.WA_DATABASE_FILE = path.join(tmp, 'database.db')

const results = []

async function step(name, fn) {
    try {
        await fn()
        results.push([name, 'PASS', null])
        console.log(`PASS: ${name}`)
    } catch (error) {
        results.push([name, 'FAIL', error?.message || String(error)])
        console.log(`FAIL: ${name} (${error?.message || error})`)
    }
}

const assert = (condition, message) => {
    if (!condition) throw new Error(message)
}

const { getDatabase, closeDatabase, backupDatabase, databasePath } = await import('../src/services/database/sqlite.js')
const { upsertUser, getUser, tryConsumeUserLimit, refundUserLimit, resetAllUserLimits } = await import('../src/services/database/users.js')
const { upsertGroup, getGroup } = await import('../src/services/database/groups.js')
const { getSetting, setSetting } = await import('../src/services/database/settings.js')
const { owners, premiums } = await import('../src/services/access.js')
const { storeIdentityMapping, peekPNForLID, peekLIDForPN, resetResolverState, setResolverSocket } = await import('../src/services/identity-resolver.js')
const { storeOutgoingMessage, getMessageForRetry, resetMessageStore } = await import('../src/services/message-store.js')
const { addScheduledJob, listScheduledJobs, startScheduler, stopScheduler, resetSchedulerState } = await import('../src/services/scheduler.js')
const crmstore = (await import('../src/lib/crm/crmstore.js')).default

const CHAT = '628111222333@s.whatsapp.net'
const makeMessage = (id, text, timestamp) => ({
    key: { remoteJid: CHAT, fromMe: false, id },
    message: { conversation: text },
    messageTimestamp: timestamp
})

async function main() {
    await step('koneksi dan pragma aktif', () => {
        const db = getDatabase()
        assert(db.pragma('journal_mode', { simple: true }) === 'wal', 'journal_mode bukan wal')
        assert(db.pragma('foreign_keys', { simple: true }) === 1, 'foreign_keys mati')
        assert(db.pragma('busy_timeout', { simple: true }) === 5000, 'busy_timeout salah')
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
        for (const table of ['users', 'access_roles', 'wa_groups', 'settings', 'identity_map', 'outgoing_messages', 'schedules', 'crm_messages', 'crm_nodes', 'schema_migrations']) {
            assert(tables.includes(table), `tabel ${table} hilang`)
        }
    })

    await step('users: upsert, reserve, refund, reset', () => {
        const created = upsertUser({ jid: '628900@s.whatsapp.net', name: 'Smoke User' })
        assert(created.limit > 0, 'limit awal tidak positif')

        const cost = 1
        const reserved = tryConsumeUserLimit('628900@s.whatsapp.net', cost)
        assert(reserved && reserved.limit === created.limit - cost, 'reserve tidak mengurangi limit')

        refundUserLimit('628900@s.whatsapp.net', cost)
        assert(getUser('628900@s.whatsapp.net').limit === created.limit, 'refund tidak mengembalikan limit')

        const count = resetAllUserLimits(5)
        assert(count >= 1, 'reset tidak menyentuh baris')
        assert(getUser('628900@s.whatsapp.net').limit === 5, 'reset tidak menulis default')
    })

    await step('groups: upsert dan baca', () => {
        upsertGroup({ jid: '120363000@g.us', name: 'Grup Smoke', settings: { muted: true } })
        const group = getGroup('120363000@g.us')
        assert(group?.name === 'Grup Smoke', 'nama grup tidak tersimpan')
        assert(group?.settings?.muted === true, 'settings grup tidak tersimpan')
    })

    await step('settings: set dan get', () => {
        setSetting('limitReset', { lastResetDate: '2026-11-14' })
        assert(getSetting('limitReset')?.lastResetDate === '2026-11-14', 'settings tidak terbaca')
    })

    await step('access: add, has, remove', () => {
        assert(owners.add('628555') === true, 'add owner gagal')
        assert(owners.has('628555@s.whatsapp.net') === true, 'has owner gagal')
        assert(premiums.add('628556') === true, 'add premium gagal')
        assert(premiums.has('628556@s.whatsapp.net') === true, 'has premium gagal')
        assert(owners.has('628556@s.whatsapp.net') === false, 'premium bocor ke owner')
        assert(owners.remove('628555') === true, 'remove owner gagal')
        assert(premiums.remove('628556') === true, 'remove premium gagal')
    })

    await step('identity mapping: simpan dan lihat dua arah', async () => {
        setResolverSocket(null)
        const stored = await storeIdentityMapping('555444333222111@lid', '628111222333@s.whatsapp.net')
        assert(stored === true, 'mapping tidak tersimpan')
        assert(peekPNForLID('555444333222111@lid') === '628111222333@s.whatsapp.net', 'peekPNForLID gagal')
        assert(peekLIDForPN('628111222333@s.whatsapp.net') === '555444333222111@lid', 'peekLIDForPN gagal')
        resetResolverState()
    })

    await step('message store: simpan dan retry', () => {
        assert(storeOutgoingMessage({ remoteJid: CHAT, fromMe: true, id: 'SMOKE-MSG-1' }, { conversation: 'halo' }) === true, 'store gagal')
        const retry = getMessageForRetry({ id: 'SMOKE-MSG-1' })
        assert(retry?.conversation === 'halo', 'retry tidak mengembalikan konten')
        resetMessageStore()
    })

    await step('scheduler: simpan, muat ulang, dan bersihkan', async () => {
        addScheduledJob({ id: 'smoke-job', chatJid: CHAT, content: { text: 'ping' }, at: Date.now() + 60_000 })
        await stopScheduler()
        await startScheduler({ sender: async () => {} })
        const restored = listScheduledJobs().find(job => job.id === 'smoke-job')
        assert(restored?.content?.text === 'ping', 'job tidak dipulihkan')
        await stopScheduler()
        resetSchedulerState()
        assert(listScheduledJobs().length === 0, 'tabel schedules tidak bersih')
    })

    await step('crm: simpan, baca, hapus, cleanup', async () => {
        const now = Math.floor(Date.now() / 1000)
        assert(crmstore.saveMessage(makeMessage('SMOKE-CRM-1', 'isi crm', now), CHAT) === true, 'saveMessage gagal')
        assert(crmstore.loadMessage('SMOKE-CRM-1', CHAT)?.message?.conversation === 'isi crm', 'loadMessage gagal')
        assert(crmstore.countMessages() === 1, 'countMessages salah')
        assert(crmstore.getMessages(CHAT)[0]?.id === 'SMOKE-CRM-1', 'getMessages salah')
        assert(crmstore.deleteMessage('SMOKE-CRM-1', CHAT) === true, 'deleteMessage gagal')
        assert(crmstore.countMessages() === 0, 'pesan tidak terhapus')

        crmstore.saveMessage(makeMessage('SMOKE-CRM-OLD', 'tua', now - 8 * 24 * 60 * 60), CHAT)
        await crmstore.cleanup()
        assert(crmstore.hasMessage('SMOKE-CRM-OLD', CHAT) === false, 'retensi 7 hari tidak bekerja')
    })

    await step('backup: VACUUM INTO dan rotasi', () => {
        const dir = path.join(tmp, 'backups')
        const first = backupDatabase(dir, 2)
        assert(fs.existsSync(first.file), 'backup tidak dibuat')
        backupDatabase(dir, 2)
        backupDatabase(dir, 2)
        const files = fs.readdirSync(dir).filter(name => name.startsWith('database-'))
        assert(files.length <= 2, `rotasi gagal, ada ${files.length} file`)
    })

    await step('restart: close dan buka ulang dengan data utuh', () => {
        upsertUser({ jid: '628901@s.whatsapp.net', name: 'Persist Smoke' })
        closeDatabase()
        getDatabase()
        assert(getUser('628901@s.whatsapp.net')?.name === 'Persist Smoke', 'data hilang setelah restart')
        assert(databasePath() === path.join(tmp, 'database.db'), 'path berubah')
    })

    await step('integritas akhir', () => {
        assert(getDatabase().pragma('integrity_check', { simple: true }) === 'ok', 'integrity_check gagal')
    })

    closeDatabase()

    const failed = results.filter(([, status]) => status === 'FAIL')
    console.log('')
    console.log(`HASIL: ${results.length - failed.length}/${results.length} langkah PASS`)

    fs.rmSync(tmp, { recursive: true, force: true })
    process.exit(failed.length ? 1 : 0)
}

main()
