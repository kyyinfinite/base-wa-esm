import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-queueq-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    queueTaskTimeoutMs: 20000,
    maxConcurrentTasks: 8
}))

const { messageQueue, queueStats, resetQueueState } = await import('../src/core/queue/engine.js')
const { updateConfig } = await import('../src/services/config.js')
const { closeDatabase } = await import('../src/services/database/sqlite.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

beforeEach(() => {
    resetQueueState()
})

after(() => {
    updateConfig({ maxConcurrentTasks: 8, queueTaskTimeoutMs: 20000 })
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('integration suite: queue timeout', () => {
    test('task yang menggantung ditolak setelah batas waktu', async () => {
        const started = Date.now()
        await assert.rejects(
            () => messageQueue.add('timeout-key', async () => {
                await sleep(5000)
                return 'terlalu lama'
            }, { timeoutMs: 100 }),
            /batas waktu/
        )
        assert.ok(Date.now() - started < 1500)
    })

    test('timeout melepas rantai antrean chat', async () => {
        await assert.rejects(
            () => messageQueue.add('chain-key', async () => {
                await sleep(5000)
            }, { timeoutMs: 80 }),
            /batas waktu/
        )

        const after = await messageQueue.add('chain-key', async () => 'lanjut')
        assert.equal(after, 'lanjut')
    })

    test('timeout memanggil onTimeout dan mencatat statistik', async () => {
        let aborted = false
        await assert.rejects(
            () => messageQueue.add('signal-key', async () => {
                await sleep(3000)
            }, { timeoutMs: 80, onTimeout: () => { aborted = true } }),
            /batas waktu/
        )

        assert.equal(aborted, true)
        assert.ok(queueStats().timedOut >= 1)
    })

    test('task normal tanpa timeout tetap selesai', async () => {
        const value = await messageQueue.add('normal-key', async () => 'ok-value', { timeoutMs: 0 })
        assert.equal(value, 'ok-value')
    })
})

describe('integration suite: semaphore concurrency', () => {
    test('maxConcurrentTasks 1 membatasi eksekusi lintas chat', async () => {
        updateConfig({ maxConcurrentTasks: 1 })
        try {
            let running = 0
            let maxRunning = 0

            const task = async () => {
                running += 1
                maxRunning = Math.max(maxRunning, running)
                await sleep(40)
                running -= 1
                return 'done'
            }

            const results = await Promise.all([
                messageQueue.add('c-1', task),
                messageQueue.add('c-2', task),
                messageQueue.add('c-3', task)
            ])

            assert.equal(maxRunning, 1)
            assert.deepEqual(results, ['done', 'done', 'done'])
        } finally {
            updateConfig({ maxConcurrentTasks: 8 })
        }
    })

    test('task prioritas melompati antrean semaphore', async () => {
        updateConfig({ maxConcurrentTasks: 1 })
        try {
            let releaseGate
            const gate = new Promise(resolve => { releaseGate = resolve })
            const order = []

            const first = messageQueue.add('prio-0', async () => {
                await gate
                order.push('pertama')
                return 'pertama'
            })

            const low = messageQueue.add('prio-1', async () => {
                order.push('rendah')
                return 'rendah'
            })

            const high = messageQueue.add('prio-2', async () => {
                order.push('tinggi')
                return 'tinggi'
            }, { priority: true })

            await sleep(40)
            releaseGate()

            await Promise.all([first, low, high])
            assert.deepEqual(order, ['pertama', 'tinggi', 'rendah'])
        } finally {
            updateConfig({ maxConcurrentTasks: 8 })
        }
    })

    test('queueStats menampilkan running dan waiting', async () => {
        updateConfig({ maxConcurrentTasks: 1 })
        try {
            let releaseGate
            const gate = new Promise(resolve => { releaseGate = resolve })

            const first = messageQueue.add('stats-0', async () => {
                await gate
                return 'selesai'
            })
            const second = messageQueue.add('stats-1', async () => 'selesai-2')
            const third = messageQueue.add('stats-2', async () => 'selesai-3')

            await sleep(40)
            assert.equal(queueStats().running, 1)
            assert.equal(queueStats().waiting, 2)

            releaseGate()
            await Promise.all([first, second, third])
        } finally {
            updateConfig({ maxConcurrentTasks: 8 })
        }
    })
})

describe('integration suite: queue overflow', () => {
    test('overflow menolak task baru dengan kode QUEUE_OVERFLOW', async () => {
        let releaseGate
        const gate = new Promise(resolve => { releaseGate = resolve })

        const first = messageQueue.add('of-key', async () => {
            await gate
            return 'selesai'
        })

        const pending = []
        for (let i = 0; i < 49; i++) {
            pending.push(messageQueue.add('of-key', async () => i))
        }

        let rejected = null
        try {
            await messageQueue.add('of-key', async () => 'terlalu banyak')
        } catch (error) {
            rejected = error
        }

        assert.ok(rejected, 'overflow harus melempar error ke pemanggil langsung')
        assert.match(rejected.message, /overflow/i)
        assert.equal(rejected.code, 'QUEUE_OVERFLOW')
        assert.ok(queueStats().rejected >= 1)

        releaseGate()
        await first
        await Promise.all(pending)

        await messageQueue.add('of-key', async () => 'pulih')
    })

    test('urutan antar pesan satu chat tetap terjaga dengan semaphore aktif', async () => {
        const order = []
        const tasks = []
        for (let i = 0; i < 5; i++) {
            tasks.push(messageQueue.add('order-key', async () => {
                await sleep((i % 3) * 5)
                order.push(i)
                return i
            }))
        }
        const results = await Promise.all(tasks)
        assert.deepEqual(order, [0, 1, 2, 3, 4])
        assert.deepEqual(results, [0, 1, 2, 3, 4])
    })
})
