import path from 'path'
import connectToWhatsApp, { closeActiveSocket } from './src/core/app/connect.js'
import { startLimitResetScheduler } from './src/core/scheduler/limitReset.js'
import { closeDatabase, backupDatabase, databasePath } from './src/services/database/sqlite.js'
import { startScheduler, stopScheduler } from './src/services/scheduler.js'
import { startConversationSweeper } from './src/services/conversation-state.js'
import { initPlugins, stopWatching } from './src/core/plugin/loader.js'
import outbound from './src/core/outbound/index.js'
import { getConfig } from './src/services/config.js'
import { logWarn, logError } from './src/services/logger.js'

startLimitResetScheduler()
startConversationSweeper()

startScheduler({
    sender: async (chatJid, content) => outbound.send(chatJid, content)
}).catch(error => console.error('[SCHEDULER] Gagal start:', error.message))

let shuttingDown = false

function resolveShutdownTimeoutMs() {
    const value = Number(getConfig().shutdownTimeoutMs)
    return Number.isFinite(value) && value > 0 ? value : 10000
}

function resolveBackupKeep() {
    const value = Number(getConfig().dbBackupKeep)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 7
}

function runDailyBackup() {
    try {
        const dir = path.join(path.dirname(databasePath()), 'backups')
        const result = backupDatabase(dir, resolveBackupKeep())
        console.log(`[BACKUP] Database dibackup ke ${result.file} (${result.pruned} file lama dihapus).`)
    } catch (error) {
        logError('runtime', 'backup.gagal', { message: error?.message })
    }
}

function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`[SHUTDOWN] Received ${signal}, closing database and exiting.`)

    const timeoutMs = resolveShutdownTimeoutMs()
    const forceExit = setTimeout(() => {
        logWarn('runtime', 'shutdown.terpaksa', { signal, timeoutMs })
        process.exit(1)
    }, timeoutMs)
    forceExit.unref?.()

    stopScheduler()
    stopWatching()

    try {
        closeDatabase()
    } catch (error) {
        logError('runtime', 'shutdown.gagal-tutup-database', { message: error?.message })
    }

    closeActiveSocket()
        .catch(error => {
            logError('runtime', 'shutdown.gagal-tutup-socket', { message: error?.message })
            return undefined
        })
        .finally(() => {
            clearTimeout(forceExit)
            process.exit(0)
        })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason)
})
process.on('uncaughtException', (error) => {
    shuttingDown = true

    try {
        closeDatabase()
    } catch {}

    logError('runtime', 'process.uncaughtException', { message: error?.message })
    console.error('[UNCAUGHT EXCEPTION]', error)
    process.exit(1)
})

try {
    await initPlugins()
} catch (error) {
    console.error('[PLUGIN] Gagal memuat plugin awal:', error.message)
}

const dailyBackupTimer = setInterval(runDailyBackup, 24 * 60 * 60 * 1000)
dailyBackupTimer.unref?.()

connectToWhatsApp()
