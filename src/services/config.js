import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = process.env.WA_CONFIG_PATH || path.join(__dirname, '../../config.json')

let cache = null
let cachedMtimeMs = 0
let lastCheckedAt = 0

const FALLBACK_TIMEZONE = 'Asia/Jakarta'
const CONFIG_RECHECK_MS = 2000

function buildDefaults() {
    return {
        pairingNumber: '',
        timezone: FALLBACK_TIMEZONE,
        maxMessageAgeSec: 60,
        queueTaskTimeoutMs: 120000,
        maxConcurrentTasks: 8,
        prefixlessCommands: false,
        enableShell: false,
        enableEval: false,
        markOnlineOnConnect: false,
        identityMaxStored: 20000,
        outboundMinIntervalMs: 400,
        outboundMaxRetries: 3,
        schedulerMisfireGraceMs: 300000,
        hotReload: process.env.NODE_ENV !== 'production',
        logToFile: false,
        shutdownTimeoutMs: 10000,
        dbBackupKeep: 7
    }
}

function forceRead() {
    const stat = fs.statSync(configPath)
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    cache = raw && typeof raw === 'object' ? raw : {}
    cachedMtimeMs = stat.mtimeMs
    lastCheckedAt = Date.now()
    return cache
}

function readFromDisk() {
    if (!cache) return forceRead()

    const now = Date.now()
    if (now - lastCheckedAt < CONFIG_RECHECK_MS) return cache
    lastCheckedAt = now

    const stat = fs.statSync(configPath)
    if (stat.mtimeMs === cachedMtimeMs) return cache

    return forceRead()
}

export function getConfig() {
    return { ...buildDefaults(), ...readFromDisk() }
}

export function updateConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('Config patch must be a plain object')
    }

    const current = readFromDisk()
    const next = { ...current, ...patch }

    const temp = `${configPath}.tmp`
    fs.writeFileSync(temp, JSON.stringify(next, null, 2))
    fs.renameSync(temp, configPath)

    cache = next
    cachedMtimeMs = fs.statSync(configPath).mtimeMs
    lastCheckedAt = Date.now()

    return next
}

export function getDailyLimit() {
    const limit = Number(getConfig().dailyLimit)
    return Number.isFinite(limit) && limit > 0 ? limit : 10
}

export default { getConfig, updateConfig, getDailyLimit }
