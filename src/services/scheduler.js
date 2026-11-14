import { prepare } from './database/sqlite.js'
import { getNextCronRun, validateCronExpression } from './cron.js'
import { getConfig } from './config.js'
import { logWarn } from './logger.js'

const running = new Set()
const jobs = new Map()
const attempts = new Map()

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 30_000
const TICK_MS = 30_000

const FALLBACK_TIMEZONE = 'Asia/Jakarta'

let ticker = null
let sender = null

const isFuture = ms => Number.isFinite(ms) && ms > Date.now()

function resolveTimezone() {
    const timezone = String(getConfig().timezone || '').trim() || FALLBACK_TIMEZONE
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
        return timezone
    } catch {
        return FALLBACK_TIMEZONE
    }
}

function resolveGraceMs() {
    const grace = Number(getConfig().schedulerMisfireGraceMs)
    return Number.isFinite(grace) && grace >= 0 ? grace : 300000
}

function validateJob({ id, chatJid, content, at, every, cron }) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('id harus string non-kosong')
    if (typeof chatJid !== 'string' || !chatJid.trim()) throw new TypeError('chatJid harus string non-kosong')
    if (!content || typeof content !== 'object') throw new TypeError('content harus berupa object')

    const hasAt = Number.isFinite(Number(at))
    const hasEvery = Number.isFinite(Number(every)) && Number(every) >= 1000
    const hasCron = typeof cron === 'string' && cron.trim().length > 0

    if (!hasAt && !hasEvery && !hasCron) {
        throw new TypeError('butuh `at` (epoch ms), `every` (ms, >= 1000), atau `cron` (5 kolom)')
    }
    if (hasCron && !validateCronExpression(cron)) {
        throw new TypeError(`ekspresi cron tidak valid: ${cron}`)
    }

    return {
        id: id.trim(),
        chatJid,
        content,
        at: hasAt ? Number(at) : null,
        every: hasEvery ? Number(every) : null,
        cron: hasCron ? cron.trim() : null,
        nextRunAt: null,
        lastRunAt: null,
        runCount: 0
    }
}

function computeNextRun(job, fromMs = Date.now()) {
    if (!job.cron) return null
    return getNextCronRun(job.cron, fromMs, resolveTimezone())
}

function persistJob(job) {
    try {
        prepare('INSERT INTO schedules(id, chat_jid, content, at, every, cron, next_run_at, last_run_at, run_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_jid = excluded.chat_jid, content = excluded.content, at = excluded.at, every = excluded.every, cron = excluded.cron, next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at, run_count = excluded.run_count').run(
            job.id,
            job.chatJid,
            JSON.stringify(job.content),
            job.at ?? null,
            job.every ?? null,
            job.cron ?? null,
            job.nextRunAt ?? null,
            job.lastRunAt ?? null,
            job.runCount ?? 0
        )
    } catch {}
}

function removeJob(id) {
    jobs.delete(id)
    attempts.delete(id)
    try {
        prepare('DELETE FROM schedules WHERE id = ?').run(id)
    } catch {}
}

function isDue(job, now) {
    if (job.every) {
        return job.lastRunAt === undefined || job.lastRunAt === null || now - job.lastRunAt >= job.every
    }
    if (job.cron) {
        return job.nextRunAt !== null && job.nextRunAt !== undefined && now >= job.nextRunAt
    }
    return job.at !== null && now >= job.at
}

const isSocketInactiveError = error => {
    if (!error) return false
    if (error?.code === 'NO_SOCKET') return true
    return /socket WhatsApp tidak aktif/i.test(String(error?.message || ''))
}

async function runJob(job, now) {
    if (running.has(job.id)) return
    running.add(job.id)

    try {
        await sender(job.chatJid, job.content, job)
        job.runCount = (job.runCount ?? 0) + 1
        attempts.delete(job.id)

        if (job.every) {
            job.lastRunAt = now
            persistJob(job)
        } else if (job.cron) {
            job.nextRunAt = computeNextRun(job, now + 1000)
            persistJob(job)
        } else {
            removeJob(job.id)
        }
    } catch (error) {
        if (isSocketInactiveError(error)) {
            logWarn('scheduler', 'scheduler.socket-nonaktif', { id: job.id, message: error?.message })
            return
        }

        const count = (attempts.get(job.id) || 0) + 1
        attempts.set(job.id, count)

        if (job.every) {
            persistJob(job)
            if (count < MAX_ATTEMPTS) job.lastRunAt = now - job.every + RETRY_DELAY_MS
        } else if (job.cron) {
            if (count < MAX_ATTEMPTS) {
                job.nextRunAt = Date.now() + RETRY_DELAY_MS
                persistJob(job)
            } else {
                removeJob(job.id)
            }
        } else if (count < MAX_ATTEMPTS) {
            job.at = Date.now() + RETRY_DELAY_MS
            persistJob(job)
        } else {
            removeJob(job.id)
        }

        console.error(`[SCHEDULER] Gagal menjalankan job ${job.id} (percobaan ${count}):`, error.message)
    } finally {
        running.delete(job.id)
    }
}

function checkMisfire(job, now) {
    const grace = resolveGraceMs()

    if (job.at !== null && !job.every && !job.cron && now - job.at > grace) {
        logWarn('scheduler', 'scheduler.misfire', { id: job.id, terlambatMs: now - job.at })
        return
    }

    if (job.every && job.lastRunAt && now - job.lastRunAt > job.every + grace) {
        logWarn('scheduler', 'scheduler.misfire', { id: job.id, terlambatMs: now - job.lastRunAt - job.every })
    }
}

async function tick() {
    if (!sender) return
    const now = Date.now()
    for (const job of [...jobs.values()]) {
        if (isDue(job, now)) {
            checkMisfire(job, now)
            await runJob(job, now)
        }
    }
}

export function addScheduledJob(input) {
    const job = validateJob(input)

    if (job.cron) {
        job.nextRunAt = computeNextRun(job)
        if (job.nextRunAt === null) {
            throw new TypeError(`ekspresi cron tidak pernah cocok: ${job.cron}`)
        }
    }

    jobs.delete(job.id)
    jobs.set(job.id, job)
    persistJob(job)
    return job
}

export function cancelScheduledJob(id) {
    let existed = jobs.has(id)
    if (!existed) {
        try {
            existed = !!prepare('SELECT 1 AS found FROM schedules WHERE id = ?').get(id)
        } catch {}
    }
    removeJob(id)
    return !!existed
}

export function listScheduledJobs() {
    return [...jobs.values()].map(job => ({ ...job }))
}

export async function startScheduler({ sender: sendFn } = {}) {
    if (typeof sendFn !== 'function') throw new TypeError('sender harus function')

    sender = sendFn

    try {
        const rows = prepare('SELECT id, chat_jid, content, at, every, cron, next_run_at, last_run_at, run_count FROM schedules').all()
        for (const record of rows) {
            if (!record?.id || jobs.has(record.id)) continue

            let content = null
            try {
                content = JSON.parse(record.content)
            } catch {}

            if (!content || typeof content !== 'object') {
                removeJob(record.id)
                continue
            }

            const job = {
                id: record.id,
                chatJid: record.chat_jid,
                content,
                at: record.at ?? null,
                every: record.every ?? null,
                cron: record.cron ?? null,
                nextRunAt: record.next_run_at ?? null,
                lastRunAt: record.last_run_at ?? null,
                runCount: record.run_count ?? 0
            }

            if (job.cron && !validateCronExpression(job.cron)) {
                removeJob(record.id)
                continue
            }
            if (job.cron && (job.nextRunAt === null || job.nextRunAt === undefined || job.nextRunAt <= Date.now())) {
                job.nextRunAt = computeNextRun(job)
            }

            jobs.set(record.id, job)
        }
    } catch {}

    if (!ticker) {
        ticker = setInterval(() => {
            tick().catch(() => {})
        }, TICK_MS)
        ticker.unref?.()
    }

    return jobs.size
}

export async function stopScheduler() {
    if (ticker) {
        clearInterval(ticker)
        ticker = null
    }
    sender = null
    running.clear()
}

export function resetSchedulerState() {
    if (ticker) {
        clearInterval(ticker)
        ticker = null
    }
    jobs.clear()
    attempts.clear()
    running.clear()
    sender = null
    try {
        prepare('DELETE FROM schedules').run()
    } catch {}
}

export { isDue, isSocketInactiveError }
