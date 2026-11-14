import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-runtime-observability-'))
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-runtime-observability-logs-'))
process.env.WA_DATABASE_DIR = tmp
process.env.WA_CONFIG_PATH = path.join(tmp, 'config.json')
process.env.WA_LOG_DIR = logDir
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({
    botName: 'Uji Bot',
    botMode: 'public',
    dailyLimit: 5,
    prefix: ['.'],
    creator: [],
    logToFile: true,
    outboundMinIntervalMs: 0,
    shutdownTimeoutMs: 2000
}))

const { updateConfig } = await import('../src/services/config.js')
const { closeDatabase } = await import('../src/services/database/sqlite.js')
const metrics = await import('../src/services/metrics.js')
const { getRuntimeHealth, formatDiagnosticReport } = await import('../src/services/health.js')
const { logInfo, logWarn, getLogStats, getLogFileState } = await import('../src/services/logger.js')
const { queueStats } = await import('../src/core/queue/engine.js')
const statusPlugin = await import('../plugins/owner/status.js')
const { validatePlugin } = await import('../src/core/plugin/registry.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

beforeEach(() => {
    metrics.resetMetrics()
})

before(() => {
    updateConfig({ logToFile: true })
})

after(async () => {
    updateConfig({ logToFile: false })
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(logDir, { recursive: true, force: true })
})

describe('integration suite: metrics command', () => {
    test('hitungan, error, timeout, dan latensi tercatat per command', () => {
        for (let i = 1; i <= 10; i++) {
            metrics.recordCommandResult('menu', { ok: i !== 10, latencyMs: i * 10 })
        }
        metrics.recordCommandResult('menu', { ok: false, timedOut: true, latencyMs: 999 })

        const summary = metrics.getMetricsSummary()
        const menu = summary.topCommands.find(item => item.command === 'menu')

        assert.equal(menu.count, 11)
        assert.equal(menu.errors, 2)
        assert.equal(menu.timeouts, 1)
        assert.ok(menu.samples <= 500)
        assert.equal(menu.avgMs > 0, true)
        assert.ok(menu.p95Ms >= menu.avgMs, 'p95 tidak boleh lebih kecil dari rata-rata')
        assert.equal(summary.global.commandsExecuted, 11)
        assert.equal(summary.global.commandsFailed, 2)
        assert.equal(summary.global.commandsTimedOut, 1)
    })

    test('jendela latensi dibatasi', () => {
        for (let i = 0; i < 600; i++) {
            metrics.recordCommandResult('jendela', { latencyMs: i })
        }

        const summary = metrics.getMetricsSummary()
        const entry = summary.topCommands.find(item => item.command === 'jendela')

        assert.equal(entry.samples, 500, 'jumlah sampel latensi dibatasi 500')
    })

    test('penghitung global dan outbound tercatat', () => {
        metrics.recordMessageReceived()
        metrics.recordMessageReceived()
        metrics.recordMessageFiltered('duplicate')
        metrics.recordOutboundResult({ ok: true })
        metrics.recordOutboundResult({ ok: true })
        metrics.recordOutboundResult({ ok: false })

        const summary = metrics.getMetricsSummary()

        assert.equal(summary.global.messagesReceived, 2)
        assert.equal(summary.global.messagesFiltered, 1)
        assert.equal(summary.global.outboundSent, 2)
        assert.equal(summary.global.outboundFailed, 1)
        assert.ok(summary.filters.some(item => item.command === 'filter:duplicate'))
    })

    test('ringkasan masuk ke getRuntimeHealth dan formatDiagnosticReport', () => {
        metrics.recordCommandResult('ping', { ok: true, latencyMs: 12 })
        metrics.recordMessageReceived()
        metrics.recordOutboundResult({ ok: true })

        const health = getRuntimeHealth()

        assert.ok(health.metrics, 'runtime health memuat metrics')
        assert.equal(health.metrics.global.messagesReceived >= 1, true)
        assert.ok(typeof health.queue.running === 'number', 'queue.running tersedia')
        assert.ok(typeof health.queue.waiting === 'number', 'queue.waiting tersedia')
        assert.ok(typeof health.queue.timedOut === 'number', 'queue.timedOut tersedia')
        assert.ok(typeof health.outbound.sent === 'number', 'outbound stats tersedia')

        const report = formatDiagnosticReport({ logLimit: 2 })

        assert.match(report, /outbound: sent=\d+/)
        assert.match(report, /metrics: received=\d+/)
        assert.match(report, /topCommand: /)
        assert.match(report, /running=\d+ waiting=\d+ timedOut=\d+/)
    })
})

describe('integration suite: rotasi log ke file', () => {
    test('entri ditulis sebagai JSON baris dan rotasi menjaga maksimum file', async () => {
        updateConfig({ logToFile: true })
        try {
            const current = path.join(logDir, 'bot.log')
            fs.rmSync(current, { force: true })
            fs.rmSync(`${current}.1`, { force: true })
            fs.rmSync(`${current}.2`, { force: true })

            logInfo('uji', 'log.pertama', {pesan: 'satu'})

            const firstLines = fs.readFileSync(current, 'utf8').trim().split('\n')
            for (const line of firstLines) {
                const parsed = JSON.parse(line)
                assert.equal(typeof parsed.ts, 'number')
                assert.equal(typeof parsed.level, 'string')
            }
            assert.equal(firstLines.length, 1)

            const filler = 'x'.repeat(1024 * 1024)
            fs.writeFileSync(current, filler.repeat(6))

            logWarn('uji', 'log.rotasi', {pesan: 'dua'})

            const state = getLogFileState()
            assert.ok(fs.existsSync(`${current}.1`), 'file lama dipindah ke .1')
            assert.ok(fs.statSync(current).size < 1024, 'file aktif dimulai ulang kecil')
            assert.ok(state.maxFiles === 3)
            assert.ok(state.maxBytes === 5 * 1024 * 1024)

            fs.writeFileSync(current, filler.repeat(6))
            logInfo('uji', 'log.rotasi2', {pesan: 'tiga'})
            assert.ok(fs.existsSync(`${current}.2`), 'rotasi kedua membuat .2')

            fs.writeFileSync(current, filler.repeat(6))
            logInfo('uji', 'log.rotasi3', {pesan: 'empat'})

            const kept = fs.readdirSync(logDir).filter(name => name.startsWith('bot.log'))
            assert.ok(kept.length <= 3, `jumlah file dibatasi 3, ada ${kept.length}`)

            const ringBuffer = getLogStats()
            assert.ok(ringBuffer.entries >= 4, 'ring buffer memori tetap aktif')
        } finally {
            updateConfig({ logToFile: false })
        }
    })
})

describe('integration suite: plugin status', () => {
    test('status menampilkan laporan diagnostik dan metrik top command', async () => {
        assert.equal(statusPlugin.default.owner, true)
        assert.deepEqual(statusPlugin.default.command, ['status'])
        assert.doesNotThrow(() => validatePlugin(statusPlugin.default))

        metrics.recordCommandResult('ping', { ok: true, latencyMs: 15 })
        metrics.recordCommandResult('ping', { ok: true, latencyMs: 25 })
        metrics.recordCommandResult('ping', { ok: false, latencyMs: 35 })

        const replies = []
        const notifReply = async (text, title) => { replies.push({ text, title }) }

        await statusPlugin.default({ chat: '628700@s.whatsapp.net' }, { notifReply })

        assert.equal(replies.length, 1)
        assert.equal(replies[0].title, 'Bot Status')
        assert.match(replies[0].text, /DIAGNOSTIC REPORT/)
        assert.match(replies[0].text, /uptime: \d+s/)
        assert.match(replies[0].text, /Top Command/)
        assert.match(replies[0].text, /ping.*3x/)
    })
})

describe('integration suite: shutdown terbatas waktu', () => {
    test('SIGTERM mematikan bot dalam batas shutdownTimeoutMs', { timeout: 30000 }, async () => {
        const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shutdown-'))
        const configPath = path.join(runTmp, 'config.json')
        const dbDir = path.join(runTmp, 'database')
        fs.mkdirSync(dbDir, { recursive: true })
        fs.writeFileSync(configPath, JSON.stringify({
            botName: 'Uji Shutdown',
            botMode: 'public',
            dailyLimit: 5,
            prefix: ['.'],
            creator: [],
            usePairingCode: true,
            pairingNumber: '628123456789',
            shutdownTimeoutMs: 2500,
            hotReload: false,
            maxMessageAgeSec: 60
        }))

        const child = spawn(process.execPath, ['index.js'], {
            cwd: ROOT,
            env: {
                ...process.env,
                WA_CONFIG_PATH: configPath,
                WA_DATABASE_DIR: dbDir,
                WA_LOG_DIR: path.join(runTmp, 'logs'),
                WA_PAIRING_NUMBER: '628123456789'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        })

        let output = ''
        child.stdout.on('data', chunk => { output += String(chunk) })
        child.stderr.on('data', chunk => { output += String(chunk) })

        await sleep(2500)
        assert.equal(child.exitCode, null, 'bot masih hidup sebelum sinyal')

        const startedAt = Date.now()
        child.kill('SIGTERM')

        const code = await new Promise(resolve => {
            child.on('exit', (exitCode, signal) => resolve({ exitCode, signal }))
        })

        const elapsed = Date.now() - startedAt
        assert.ok(elapsed < 15000, `shutdown selesai dalam ${elapsed}ms`)
        assert.equal(code.exitCode, 0, `proses keluar 0, output:\n${output.slice(0, 1200)}`)

        fs.rmSync(runTmp, { recursive: true, force: true })
    })
})
