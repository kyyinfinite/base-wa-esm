import { getConnectionStatus } from '../core/app/connect.js'
import { queueStats } from '../core/queue/engine.js'
import { getResolverStats } from './identity-resolver.js'
import { getGroupCacheStats } from './group-cache.js'
import { getMessageStoreStats } from './message-store.js'
import { getConversationStats } from './conversation-state.js'
import { listScheduledJobs } from './scheduler.js'
import { getLogStats, getRecentLogs } from './logger.js'
import { getMetricsSummary } from './metrics.js'
import { getOutboundStats } from '../core/outbound/index.js'
import { getDatabaseStats } from './database/sqlite.js'

export function getRuntimeHealth() {
    const memory = process.memoryUsage()

    return {
        ts: Date.now(),
        uptimeSec: Math.floor(process.uptime()),
        connection: getConnectionStatus(),
        queue: queueStats(),
        identity: getResolverStats(),
        groupCache: getGroupCacheStats(),
        messageStore: getMessageStoreStats(),
        conversation: getConversationStats(),
        scheduler: { jobs: listScheduledJobs().length },
        database: getDatabaseStats(),
        logs: getLogStats(),
        metrics: getMetricsSummary(),
        outbound: getOutboundStats(),
        process: {
            pid: process.pid,
            nodeVersion: process.version,
            memory: {
                rssMb: Math.round(memory.rss / 1024 / 1024),
                heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
                externalMb: Math.round(memory.external / 1024 / 1024)
            }
        }
    }
}

function formatTopCommands(metrics) {
    if (!metrics.topCommands.length) return 'belum ada command tercatat'
    return metrics.topCommands
        .slice(0, 5)
        .map(item => `${item.command} ${item.count}x err=${item.errors} avg=${item.avgMs}ms p95=${item.p95Ms}ms`)
        .join(' | ')
}

export function formatDiagnosticReport({ logLimit = 30 } = {}) {
    const health = getRuntimeHealth()
    const logs = getRecentLogs({ limit: logLimit })

    const lines = [
        `=== DIAGNOSTIC REPORT (${new Date(health.ts).toISOString()}) ===`,
        `uptime: ${health.uptimeSec}s | pid: ${health.process.pid} | node: ${health.process.nodeVersion}`,
        `connection: state=${health.connection.state} loggedOut=${health.connection.loggedOut} reconnectScheduled=${health.connection.reconnectScheduled} attempts=${health.connection.attempts}`,
        `queue: keys=${health.queue.keys} pending=${health.queue.pending} running=${health.queue.running} waiting=${health.queue.waiting} timedOut=${health.queue.timedOut} rejected=${health.queue.rejected}`,
        `identity: pn=${health.identity.pnCount} lid=${health.identity.lidCount} negative=${health.identity.negativeCount}`,
        `groupCache: ${health.groupCache.entries}/${health.groupCache.max} (ttl ${health.groupCache.ttlMs}ms)`,
        `messageStore: ${health.messageStore.entries}/${health.messageStore.max}`,
        `conversation: ${health.conversation.entries}/${health.conversation.max}`,
        `scheduler: ${health.scheduler.jobs} job(s)`,
        `outbound: sent=${health.outbound.sent} failed=${health.outbound.failed} retried=${health.outbound.retried} throttled=${health.outbound.throttled}`,
        `metrics: received=${health.metrics.global.messagesReceived} filtered=${health.metrics.global.messagesFiltered} executed=${health.metrics.global.commandsExecuted} failed=${health.metrics.global.commandsFailed} timedOut=${health.metrics.global.commandsTimedOut}`,
        `topCommand: ${formatTopCommands(health.metrics)}`,
        `logs: ${JSON.stringify(health.logs.byLevel)} (${health.logs.entries}/${health.logs.max})`,
        `memory: rss=${health.process.memory.rssMb}MB heap=${health.process.memory.heapUsedMb}/${health.process.memory.heapTotalMb}MB external=${health.process.memory.externalMb}MB`,
        `--- log terakhir (${logs.length}) ---`
    ]

    for (const entry of logs) {
        lines.push(`[${new Date(entry.ts).toISOString()}] ${entry.level.toUpperCase()} ${entry.subsystem} ${entry.event} ${JSON.stringify(entry.data)}`)
    }

    return lines.join('\n')
}
