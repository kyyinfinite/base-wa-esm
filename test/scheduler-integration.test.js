import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mock } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-scheduler-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    timezone: 'Asia/Jakarta',
    schedulerMisfireGraceMs: 300000
}))

const {
    addScheduledJob,
    startScheduler,
    stopScheduler,
    resetSchedulerState,
    listScheduledJobs,
    isDue,
    isSocketInactiveError
} = await import('../src/services/scheduler.js')
const {
    validateCronExpression,
    getNextCronRun,
    parseCronExpression
} = await import('../src/services/cron.js')
const { updateConfig } = await import('../src/services/config.js')
const { closeDatabase } = await import('../src/services/database/sqlite.js')

const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(async () => {
    await stopScheduler()
    resetSchedulerState()
})

after(async () => {
    await stopScheduler()
    resetSchedulerState()
    updateConfig({ schedulerMisfireGraceMs: 300000, timezone: 'Asia/Jakarta' })
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('integration suite: cron parser', () => {
    test('ekspresi valid dan tidak valid', () => {
        assert.equal(validateCronExpression('*/15 * * * *'), true)
        assert.equal(validateCronExpression('30 14 * * 1-5'), true)
        assert.equal(validateCronExpression('0 0 1 1 *'), true)
        assert.equal(validateCronExpression('0,30 8 1 7 0'), true)
        assert.equal(validateCronExpression('0 12 * * 7'), true)

        assert.equal(validateCronExpression('61 * * * *'), false)
        assert.equal(validateCronExpression('* * * *'), false)
        assert.equal(validateCronExpression('* * * * * *'), false)
        assert.equal(validateCronExpression('x x x x x'), false)
        assert.equal(validateCronExpression('*/0 * * * *'), false)
        assert.equal(validateCronExpression(''), false)
    })

    test('zona waktu menentukan waktu lokal yang cocok', () => {
        const from = Date.UTC(2026, 10, 15, 0, 0, 0)

        const jakarta = getNextCronRun('30 14 * * *', from, 'Asia/Jakarta')
        assert.equal(jakarta, Date.UTC(2026, 10, 15, 7, 30, 0))

        const newYork = getNextCronRun('30 14 * * *', from, 'America/New_York')
        assert.equal(newYork, Date.UTC(2026, 10, 15, 19, 30, 0))
    })

    test('tanpa kecocokan tahun depan pada ekspresi harian', () => {
        const from = Date.UTC(2026, 10, 15, 0, 0, 0)

        const next = getNextCronRun('0 0 1 1 *', from, 'Asia/Jakarta')
        assert.equal(next, Date.UTC(2026, 11, 31, 17, 0, 0))

        const every15 = getNextCronRun('*/15 * * * *', from, 'Asia/Jakarta')
        assert.equal(every15, Date.UTC(2026, 10, 15, 0, 15, 0))
    })

    test('batas pencarian mengembalikan null untuk ekspresi tak mungkin', () => {
        const from = Date.UTC(2026, 0, 1, 0, 0, 0)
        assert.equal(getNextCronRun('0 0 31 2 *', from, 'Asia/Jakarta'), null)
    })

    test('parseField menolak nilai di luar batas', () => {
        assert.throws(() => parseCronExpression('0 25 * * *'), /batas/)
        assert.throws(() => parseCronExpression('0 0 32 * *'), /batas/)
        assert.throws(() => parseCronExpression('0 0 * 13 *'), /batas/)
    })
})

describe('integration suite: misfire dan socket tidak aktif', () => {
    test('job satu kali terlambat jauh dijalankan sekali lalu dihapus', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
        try {
            const sent = []
            await startScheduler({ sender: async (chatJid, content) => { sent.push({ chatJid, content }) } })

            addScheduledJob({
                id: 'terlambat-1',
                chatJid: '628400@s.whatsapp.net',
                content: { text: 'telat' },
                at: Date.now() - 3_600_000
            })

            mock.timers.tick(31_000)
            await flush()
            await flush()

            assert.equal(sent.length, 1, 'dijalankan tepat sekali')
            assert.equal(listScheduledJobs().length, 0, 'job dihapus setelah sekali jalan')
        } finally {
            mock.timers.reset()
            await stopScheduler()
        }
    })

    test('job interval tidak menyusul ketinggalan, hanya jalan sekali', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
        try {
            const sent = []
            await startScheduler({ sender: async (chatJid, content) => { sent.push({ chatJid, content }) } })

            addScheduledJob({
                id: 'interval-misfire',
                chatJid: '628401@s.whatsapp.net',
                content: { text: 'ulang' },
                every: 60_000
            })

            mock.timers.tick(31_000)
            await flush()
            await flush()
            assert.equal(sent.length, 1)

            mock.timers.tick(4 * 60_000)
            await flush()
            await flush()
            assert.equal(sent.length, 2, 'interval terlewat beberapa periode hanya dijalankan sekali')

            mock.timers.tick(10_000)
            await flush()
            await flush()
            assert.equal(sent.length, 2, 'belum waktunya untuk eksekusi berikutnya')

            assert.equal(listScheduledJobs().length, 1, 'job interval tetap hidup')
        } finally {
            mock.timers.reset()
            await stopScheduler()
        }
    })

    test('socket tidak aktif tidak menambah percobaan dan tidak menghapus job', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
        try {
            await startScheduler({
                sender: async () => { throw new Error('socket WhatsApp tidak aktif') }
            })

            addScheduledJob({
                id: 'tunggu-socket',
                chatJid: '628402@s.whatsapp.net',
                content: { text: 'menunggu' },
                at: Date.now() - 1000
            })

            for (let i = 0; i < 5; i++) {
                mock.timers.tick(31_000)
                await flush()
                await flush()
            }

            assert.equal(listScheduledJobs().length, 1, 'job tidak dihapus saat socket mati')
        } finally {
            mock.timers.reset()
            await stopScheduler()
        }

        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
        try {
            const sent = []
            await startScheduler({ sender: async (chatJid, content) => { sent.push({ chatJid, content }) } })

            mock.timers.tick(31_000)
            await flush()
            await flush()

            assert.equal(sent.length, 1, 'job yang tertunda jalan setelah socket pulih')
            assert.equal(listScheduledJobs().length, 0, 'job satu kali dihapus setelah berhasil')
        } finally {
            mock.timers.reset()
            await stopScheduler()
        }
    })

    test('isSocketInactiveError mengenali kode dan pesan', () => {
        assert.equal(isSocketInactiveError(Object.assign(new Error('socket WhatsApp tidak aktif'), {})), true)

        const coded = new Error('x')
        coded.code = 'NO_SOCKET'
        assert.equal(isSocketInactiveError(coded), true)
        assert.equal(isSocketInactiveError(new Error('gagal kirim biasa')), false)
        assert.equal(isSocketInactiveError(null), false)
    })
})

describe('integration suite: job cron pada scheduler', () => {
    test('validateJob menerima at, every, atau cron', () => {
        assert.doesNotThrow(() => addScheduledJob({ id: 'a1', chatJid: '628410@s.whatsapp.net', content: {}, cron: '*/5 * * * *' }))
        assert.doesNotThrow(() => addScheduledJob({ id: 'a2', chatJid: '628410@s.whatsapp.net', content: {}, at: Date.now() + 1000 }))
        assert.doesNotThrow(() => addScheduledJob({ id: 'a3', chatJid: '628410@s.whatsapp.net', content: {}, every: 5000 }))
        assert.throws(() => addScheduledJob({ id: 'a4', chatJid: '628410@s.whatsapp.net', content: {} }), /butuh/)
        assert.throws(() => addScheduledJob({ id: 'a5', chatJid: '628410@s.whatsapp.net', content: {}, cron: '61 * * * *' }), /cron/)
    })

    test('job cron jalan sesuai jadwal menit dan dijadwalkan ulang', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
        try {
            const sent = []
            await startScheduler({ sender: async (chatJid, content) => { sent.push(content) } })

            const job = addScheduledJob({
                id: 'cron-1',
                chatJid: '628411@s.whatsapp.net',
                content: { text: 'per menit' },
                cron: '*/2 * * * *'
            })

            assert.ok(job.nextRunAt > Date.now())
            assert.equal(isDue(job, Date.now()), false)

            mock.timers.tick(121_000)
            await flush()
            await flush()

            assert.equal(sent.length, 1, 'job cron berjalan tepat sekali pada menit genap')

            const after = listScheduledJobs().find(item => item.id === 'cron-1')
            assert.ok(after, 'job cron tetap hidup')
            assert.ok(after.nextRunAt > Date.now(), 'kejadian berikutnya dijadwalkan ulang')
        } finally {
            mock.timers.reset()
            await stopScheduler()
        }
    })

    test('job cron dievaluasi di config.timezone', async () => {
        updateConfig({ timezone: 'America/New_York' })
        try {
            const sent = []
            await startScheduler({ sender: async (chatJid, content) => { sent.push(content) } })

            const job = addScheduledJob({
                id: 'cron-tz',
                chatJid: '628412@s.whatsapp.net',
                content: { text: 'zona' },
                cron: '30 14 * * *'
            })

            const formatter = new Intl.DateTimeFormat('en-GB', {
                timeZone: 'America/New_York',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            })
            const parts = {}
            for (const part of formatter.formatToParts(new Date(job.nextRunAt))) {
                if (part.type === 'hour') parts.hour = Number(part.value)
                if (part.type === 'minute') parts.minute = Number(part.value)
            }

            assert.equal(parts.hour, 14)
            assert.equal(parts.minute, 30)
        } finally {
            updateConfig({ timezone: 'Asia/Jakarta' })
            await stopScheduler()
        }
    })
})
