const LATENCY_WINDOW = 500
const TOP_COMMANDS_LIMIT = 10

const commandStats = new Map()
const globalCounters = {
    messagesReceived: 0,
    messagesFiltered: 0,
    commandsExecuted: 0,
    commandsFailed: 0,
    commandsTimedOut: 0,
    outboundSent: 0,
    outboundFailed: 0
}

function ensureEntry(command) {
    const key = String(command || 'unknown').slice(0, 60)
    let entry = commandStats.get(key)
    if (!entry) {
        entry = { command: key, count: 0, errors: 0, timeouts: 0, latencies: [] }
        commandStats.set(key, entry)
    }
    return entry
}

export function recordCommandResult(command, { ok = true, timedOut = false, latencyMs = 0 } = {}) {
    const entry = ensureEntry(command)
    entry.count += 1
    globalCounters.commandsExecuted += 1

    if (!ok) {
        entry.errors += 1
        globalCounters.commandsFailed += 1
    }
    if (timedOut) {
        entry.timeouts += 1
        globalCounters.commandsTimedOut += 1
    }

    const value = Number(latencyMs)
    if (Number.isFinite(value) && value >= 0) {
        entry.latencies.push(value)
        if (entry.latencies.length > LATENCY_WINDOW) {
            entry.latencies.splice(0, entry.latencies.length - LATENCY_WINDOW)
        }
    }
}

export function recordMessageReceived() {
    globalCounters.messagesReceived += 1
}

export function recordMessageFiltered(reason) {
    globalCounters.messagesFiltered += 1
    if (reason === undefined || reason === null) return
    const key = `filter:${String(reason).slice(0, 60)}`
    const entry = ensureEntry(key)
    entry.count += 1
}

export function recordOutboundResult({ ok = true } = {}) {
    if (ok) globalCounters.outboundSent += 1
    else globalCounters.outboundFailed += 1
}

function percentile(sorted, fraction) {
    if (!sorted.length) return 0
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
    return Math.round(sorted[index])
}

function summarizeEntry(entry) {
    const sorted = [...entry.latencies].sort((a, b) => a - b)
    const total = sorted.reduce((sum, value) => sum + value, 0)
    return {
        command: entry.command,
        count: entry.count,
        errors: entry.errors,
        timeouts: entry.timeouts,
        samples: sorted.length,
        avgMs: sorted.length ? Math.round(total / sorted.length) : 0,
        p95Ms: percentile(sorted, 0.95)
    }
}

export function getMetricsSummary() {
    const commands = [...commandStats.values()].map(summarizeEntry)
    const topCommands = commands
        .filter(entry => !entry.command.startsWith('filter:'))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_COMMANDS_LIMIT)

    return {
        global: { ...globalCounters },
        commandCount: commands.filter(entry => !entry.command.startsWith('filter:')).length,
        topCommands,
        filters: commands.filter(entry => entry.command.startsWith('filter:')).map(entry => ({ command: entry.command, count: entry.count }))
    }
}

export function resetMetrics() {
    commandStats.clear()
    for (const key of Object.keys(globalCounters)) {
        globalCounters[key] = 0
    }
}
