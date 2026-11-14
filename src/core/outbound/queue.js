import { getConfig } from '../../services/config.js'
import { logWarn } from '../../services/logger.js'
import { recordOutboundResult } from '../../services/metrics.js'

const DEFAULT_RETRY_BASE_MS = 1000
const DEFAULT_RETRY_MAX_MS = 30000

export function createOutbound(getSock, { retryBaseMs = DEFAULT_RETRY_BASE_MS, retryMaxMs = DEFAULT_RETRY_MAX_MS } = {}) {
    if (typeof getSock !== 'function') {
        throw new TypeError('getSock harus berupa function')
    }

    const lastSentAt = new Map()
    const chains = new Map()
    const counters = { sent: 0, failed: 0, retried: 0, throttled: 0 }

    const resolveConfig = () => {
        const config = getConfig()
        const minInterval = Number(config.outboundMinIntervalMs)
        const maxRetries = Number(config.outboundMaxRetries)

        return {
            minIntervalMs: Number.isFinite(minInterval) && minInterval > 0 ? minInterval : 400,
            maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : 3
        }
    }

    const isRateLimitError = error => {
        if (!error) return false
        if (error?.output?.statusCode === 429) return true
        const text = `${error?.message || ''} ${typeof error?.data === 'string' ? error.data : ''}`
        return /rate-overlimit|rate overlimit|too many requests/i.test(text)
    }

    const backoffMs = attempt => Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempt - 1))

    async function performSend(jid, content, options) {
        const sock = getSock()
        if (!sock || typeof sock.sendMessage !== 'function') {
            const error = new Error('socket WhatsApp tidak aktif')
            error.code = 'NO_SOCKET'
            throw error
        }
        return sock.sendMessage(jid, content, options)
    }

    async function sendWithRetry(jid, content, options) {
        const { maxRetries } = resolveConfig()
        let attempt = 0

        while (true) {
            try {
                return await performSend(jid, content, options)
            } catch (error) {
                if (!isRateLimitError(error) || attempt >= maxRetries) {
                    counters.failed += 1
                    recordOutboundResult({ ok: false })
                    throw error
                }

                attempt += 1
                counters.retried += 1
                const delay = backoffMs(attempt)
                logWarn('outbound', 'outbound.retry', { jid, attempt, delay, message: error?.message })
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
    }

    async function enqueue(jid, content, options) {
        const key = String(jid || 'global')
        const { minIntervalMs } = resolveConfig()

        const previous = chains.get(key) || Promise.resolve()
        const run = previous.catch(() => undefined).then(async () => {
            const wait = (lastSentAt.get(key) || 0) + minIntervalMs - Date.now()
            if (wait > 0) {
                counters.throttled += 1
                await new Promise(resolve => setTimeout(resolve, wait))
            }

            const startedAt = Date.now()
            const result = await sendWithRetry(jid, content, options)
            lastSentAt.set(key, startedAt)
            counters.sent += 1
            recordOutboundResult({ ok: true })
            return result
        })

        const tracked = run
            .catch(() => undefined)
            .finally(() => {
                if (chains.get(key) === tracked) chains.delete(key)
            })
        chains.set(key, tracked)

        return run
    }

    return {
        send: (jid, content, options) => enqueue(jid, content, options),
        stats: () => ({ ...counters, chats: chains.size })
    }
}

export default createOutbound
