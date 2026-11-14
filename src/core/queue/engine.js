import { getConfig } from '../../services/config.js'
import { logWarn } from '../../services/logger.js'

const queues = new Map()
const MAX_PENDING_PER_KEY = 50

const semState = { active: 0, waiters: [] }
const counters = { timedOut: 0, rejected: 0 }
let waiterSeq = 0

function resolveLimits() {
    const config = getConfig()
    const timeoutMs = Number(config.queueTaskTimeoutMs)
    const maxConcurrent = Number(config.maxConcurrentTasks)

    return {
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
        maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 8
    }
}

function createRelease() {
    let released = false
    return () => {
        if (released) return
        released = true
        semState.active -= 1
        pumpWaiters()
    }
}

function pumpWaiters() {
    const { maxConcurrent } = resolveLimits()
    while (semState.active < maxConcurrent && semState.waiters.length) {
        const waiter = semState.waiters.shift()
        semState.active += 1
        waiter.settle(createRelease())
    }
}

function acquireSlot(priority) {
    const waiter = { priority: priority ? 1 : 0, seq: waiterSeq++, settle: null }

    let index = semState.waiters.length
    for (let i = 0; i < semState.waiters.length; i++) {
        if (semState.waiters[i].priority < waiter.priority) {
            index = i
            break
        }
    }
    semState.waiters.splice(index, 0, waiter)

    const promise = new Promise(resolve => {
        waiter.settle = resolve
    })

    pumpWaiters()
    return promise
}

function runWithTimeout(task, timeoutMs, onTimeout) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.resolve().then(task)
    }

    return new Promise((resolve, reject) => {
        let timer = null
        let settled = false

        const settle = finish => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            finish()
        }

        timer = setTimeout(() => {
            counters.timedOut += 1
            try {
                onTimeout?.()
            } catch {}
            settle(() => reject(new Error(`Task melebihi batas waktu ${timeoutMs}ms dan dianggap gagal`)))
        }, timeoutMs)

        Promise.resolve().then(task).then(
            value => settle(() => resolve(value)),
            error => settle(() => reject(error))
        )
    })
}

class MessageQueue {
    async add(key, task, options = {}) {
        const queueKey = String(key || 'global')
        const current = queues.get(queueKey)

        if (current && current.pending >= MAX_PENDING_PER_KEY) {
            counters.rejected += 1
            logWarn('queue', 'queue.overflow', { key: queueKey, pending: current.pending })
            const error = new Error(`Message queue overflow for ${queueKey}`)
            error.code = 'QUEUE_OVERFLOW'
            throw error
        }

        const state = current || { tail: Promise.resolve(), pending: 0 }
        state.pending += 1
        queues.set(queueKey, state)

        const { timeoutMs } = resolveLimits()
        const overrideTimeout = Number(options.timeoutMs)
        const effectiveTimeout = options.timeoutMs !== undefined && Number.isFinite(overrideTimeout) && overrideTimeout >= 0
            ? overrideTimeout
            : timeoutMs

        const priority = options.priority === true || options.priority === 1
        const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : null

        const execute = async () => {
            const release = await acquireSlot(priority)
            try {
                return await runWithTimeout(task, effectiveTimeout, onTimeout)
            } finally {
                release()
            }
        }

        const run = state.tail.then(execute, execute)
        state.tail = run.catch(() => undefined)

        try {
            return await run
        } finally {
            state.pending -= 1
            if (state.pending === 0) queues.delete(queueKey)
        }
    }
}

export const messageQueue = new MessageQueue()

export const queueStats = () => ({
    keys: queues.size,
    pending: [...queues.values()].reduce((n, q) => n + q.pending, 0),
    running: semState.active,
    waiting: semState.waiters.length,
    timedOut: counters.timedOut,
    rejected: counters.rejected
})

export function resetQueueState() {
    queues.clear()
    semState.waiters.length = 0
    counters.timedOut = 0
    counters.rejected = 0
}
