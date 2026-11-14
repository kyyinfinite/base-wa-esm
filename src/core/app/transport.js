import readline from 'readline'
import path from 'path'
import fs from 'fs'
import pino from 'pino'
import chalk from 'chalk'
import { fileURLToPath } from 'url'

import {
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    makeWASocket
} from '@whiskeysockets/baileys'

import { initPlugins, isPluginsLoaded } from '../plugin/loader.js'
import { classifyDisconnect, reconnectDelayFor, describeDisconnect } from './reconnect.js'
import { defaultAuthStore, AUTH_DIR } from './auth-store.js'
import { getConfig } from '../../services/config.js'
import { reportPluginError } from '../errors/engine.js'
import { setResolverSocket } from '../../services/identity-resolver.js'
import { setGroupCacheSocket, getCachedGroupMetadataShared } from '../../services/group-cache.js'
import { getMessageForRetry } from '../../services/message-store.js'
import { logInfo, logWarn, logError } from '../../services/logger.js'
import { events } from '../events/engine.js'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FAST_RESTART_LIMIT = 5
const BAD_SESSION_LIMIT = 5
const REPLACED_LIMIT = 5
const RESTART_COOLDOWN_MS = 1000
const LOG_REPEAT_LIMIT = 3
const LOG_REPEAT_EVERY = 10
const VERSION_TTL_MS = 24 * 60 * 60 * 1000

let rl = null

const question = text => {
    if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    }
    return new Promise(resolve => rl.question(text, resolve))
}

const closePrompt = () => {
    if (!rl) return
    rl.close()
    rl = null
}

async function defaultPromptPhoneNumber() {
    const answer = await question('\nSilahkan masukkan nomor (628xxx):\n')
    closePrompt()
    return answer
}

let activeSession = null
let generation = 0
let reconnectAttempts = 0
let restartStreak = 0
let reconnectTimer = null
let pluginsStarted = false
let activeOptions = null
let loggedOut = false
let lastAuth = null
let waVersion = null
let waVersionAt = 0
let saveChain = Promise.resolve()
let saveFailed = false
let reconnectLog = { key: null, count: 0 }
let connecting = null
let restartConnection = null
let badSessionStreak = 0
let replacedStreak = 0

const log = (text, color = chalk.cyan) => console.log(color(`[WA] ${text}`))

export function getActiveSocket() {
    return activeSession?.sock ?? null
}

export function getConnectionStatus() {
    return {
        state: activeSession?.state ?? 'closed',
        loggedOut,
        reconnectScheduled: reconnectTimer !== null,
        attempts: reconnectAttempts
    }
}

export function getCurrentGeneration() {
    return generation
}

export function getActiveOptions() {
    return activeOptions
}

export function setActiveOptions(options) {
    activeOptions = options
}

export function hasUsableSession() {
    return !!activeSession && activeSession.state !== 'closed'
}

export function getConnecting() {
    return connecting
}

export function setConnecting(promise) {
    connecting = promise
}

export function setRestartConnection(fn) {
    restartConnection = fn
}

function createSession(sock, gen, auth) {
    let release
    const released = new Promise(resolve => {
        release = resolve
    })
    return { sock, gen, auth, state: 'connecting', released, release, readyEmitted: false }
}

function cleanupSocket(sock) {
    try {
        sock.ev?.removeAllListeners?.()
    } catch {}
    try {
        sock.end?.(new Error('socket ditutup'))
    } catch {}
    try {
        sock.signalRepository?.close?.()
    } catch {}
}

function endSession(session) {
    if (session.state === 'closed') return
    session.state = 'closed'
    session.release()
    cleanupSocket(session.sock)

    if (activeSession === session) {
        activeSession = null
        setResolverSocket(null)
        setGroupCacheSocket(null)
        events.emit('bot:disconnect', { reason: 'session-ended' })
    }
}

function clearReconnectTimer() {
    if (!reconnectTimer) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
}

export function prepareConnect() {
    clearReconnectTimer()
    loggedOut = false
}

export async function closeActiveSocket() {
    generation += 1
    pluginsStarted = false
    loggedOut = false
    lastAuth = null
    activeOptions = null
    reconnectAttempts = 0
    restartStreak = 0
    badSessionStreak = 0
    replacedStreak = 0
    reconnectLog = { key: null, count: 0 }
    clearReconnectTimer()

    if (activeSession) endSession(activeSession)

    await saveChain
}

export function queueCredsSave(saveCreds) {
    saveChain = saveChain.then(async () => {
        try {
            await saveCreds()
            saveFailed = false
        } catch (error) {
            saveFailed = true
            reportPluginError('runtime:creds', error, {})
        }
    })
    return saveChain
}

async function flushCreds() {
    await saveChain
    if (saveFailed && lastAuth) await queueCredsSave(lastAuth.saveCreds)
    if (saveFailed) log('Kredensial belum berhasil tersimpan, cek izin tulis folder session.', chalk.red)
}

function logReconnect(statusCode, type, delay) {
    const key = `${type}:${statusCode ?? '-'}`
    reconnectLog = key === reconnectLog.key ? { key, count: reconnectLog.count + 1 } : { key, count: 1 }
    if (reconnectLog.count > LOG_REPEAT_LIMIT && reconnectLog.count % LOG_REPEAT_EVERY !== 0) return

    if (type === 'restart') {
        log('Status 515 terdeteksi, membuat socket baru...', chalk.yellow)
        return
    }

    const seconds = (delay / 1000).toFixed(1)
    const repeat = reconnectLog.count > LOG_REPEAT_LIMIT ? ` (percobaan ke-${reconnectLog.count})` : ''

    if (type === 'error') {
        log(`Gagal membuat socket. Coba lagi dalam ${seconds}s...${repeat}`, chalk.yellow)
        return
    }

    log(
        `Koneksi terputus (status ${statusCode ?? 'unknown'}: ${describeDisconnect(type, statusCode)}). Reconnect dalam ${seconds}s...${repeat}`,
        chalk.yellow
    )

    if (type === 'replaced') {
        log('Pastikan tidak ada instance bot lain yang memakai folder session yang sama.', chalk.yellow)
    }
}

export function scheduleReconnect(statusCode, type) {
    if (reconnectTimer) return

    const options = activeOptions || {}
    let delay

    if (type === 'restart') {
        restartStreak += 1
        delay = restartStreak > FAST_RESTART_LIMIT ? RESTART_COOLDOWN_MS : 0
    } else {
        const attempt = reconnectAttempts
        reconnectAttempts += 1
        delay = options.reconnectDelay ? options.reconnectDelay(attempt, type) : reconnectDelayFor(type, attempt)
    }

    logReconnect(statusCode, type, delay)

    const scheduledGen = generation

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        reconnectNow(scheduledGen, type)
    }, delay)
}

async function reconnectNow(scheduledGen, type) {
    try {
        if (connecting) await connecting
        if (scheduledGen !== generation) return

        await flushCreds()
        if (scheduledGen !== generation) return

        if (type === 'restart') log('Menggunakan authentication state terbaru...')
        log('Menghubungkan kembali...')

        if (restartConnection) await restartConnection()
    } catch (error) {
        reportPluginError('runtime:reconnect', error, {})
        logWarn('runtime', 'connection.reconnect.failed', { message: error?.message })
        if (scheduledGen === generation) scheduleReconnect(null, 'error')
    }
}

async function ensurePlugins() {
    if (pluginsStarted || isPluginsLoaded()) return
    pluginsStarted = true

    const init = activeOptions?.initPluginStack || initPlugins

    try {
        await init()
    } catch (error) {
        pluginsStarted = false
        reportPluginError('plugin:init', error, {})
    }
}

function resolveMarkOnlineOnConnect() {
    const config = getConfig()
    return config?.markOnlineOnConnect === true
}

async function resolveBaileysVersion() {
    if (waVersion && Date.now() - waVersionAt < VERSION_TTL_MS) return waVersion
    try {
        ({ version: waVersion } = await fetchLatestBaileysVersion())
        waVersionAt = Date.now()
    } catch (error) {
        reportPluginError('runtime:version', error, {})
    }
    return waVersion
}

function ensureSessionDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        } else {
            fs.chmodSync(dir, 0o700)
        }
    } catch (error) {
        reportPluginError('runtime:session-dir', error, {})
    }
}

async function defaultCreateSocket({ auth, authStore } = {}) {
    ensureSessionDir(AUTH_DIR)
    const store = authStore || defaultAuthStore
    const { state, saveCreds } = auth || (await store.load())
    const version = await resolveBaileysVersion()

    const sock = makeWASocket({
        version: version || undefined,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        syncFullHistory: false,
        markOnlineOnConnect: resolveMarkOnlineOnConnect(),
        cachedGroupMetadata: async jid => getCachedGroupMetadataShared(jid),
        getMessage: async key => getMessageForRetry(key)
    })

    return { sock, state, saveCreds }
}

function handleClose(session, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode
    const { type, reconnect } = classifyDisconnect(statusCode)

    endSession(session)

    if (type === 'badSession') {
        badSessionStreak += 1
        lastAuth = null
        if (badSessionStreak >= BAD_SESSION_LIMIT) {
            logError('runtime', 'connection.badSession.berhenti', { streak: badSessionStreak })
            log(`Sesi tidak valid berulang ${badSessionStreak} kali berturut-turut, koneksi dihentikan. Hapus folder session lalu jalankan ulang bot untuk pairing ulang.`, chalk.red)
            return
        }
    } else if (type === 'replaced') {
        replacedStreak += 1
        if (replacedStreak >= REPLACED_LIMIT) {
            logError('runtime', 'connection.replaced.berhenti', { streak: replacedStreak })
            log(`Sesi dipakai perangkat lain berulang ${replacedStreak} kali berturut-turut, koneksi dihentikan. Pastikan tidak ada instance lain memakai folder session yang sama.`, chalk.red)
            return
        }
    }

    if (!reconnect) {
        loggedOut = true
        lastAuth = null
        log(`Sesi berhenti (status ${statusCode ?? 'unknown'}: ${describeDisconnect(type, statusCode)}), tidak akan reconnect otomatis.`, chalk.red)
        log('Hapus folder session lalu jalankan ulang bot untuk pairing ulang.', chalk.red)
        logError('runtime', 'connection.stop', { statusCode, type })
        return
    }

    logInfo('runtime', 'connection.reconnect.scheduled', { statusCode, type })
    scheduleReconnect(statusCode, type)
}

function handleConnectionUpdate(session, { connection, lastDisconnect, qr, isNewLogin }) {
    if (session.gen !== generation || session.state === 'closed') return

    if (isNewLogin) log('Pairing berhasil, mempersiapkan restart socket...', chalk.green)

    if (connection === 'open') {
        session.state = 'open'
        reconnectAttempts = 0
        restartStreak = 0
        badSessionStreak = 0
        replacedStreak = 0
        reconnectLog = { key: null, count: 0 }
        log('WhatsApp connected.', chalk.green)
        logInfo('runtime', 'connection.open', { user: session.sock?.user?.id })

        if (!session.readyEmitted) {
            session.readyEmitted = true
            ensurePlugins().finally(() => {
                if (session.gen !== generation || session.state === 'closed') return
                events.emit('bot:ready', { user: session.sock?.user?.id })
            }).catch(() => {})
        }
        return
    }

    if (connection === 'close') {
        handleClose(session, lastDisconnect)
        return
    }

    if (connection === 'connecting' && qr && getConfig().usePairingCode === false) {
        console.log(chalk.blue('QR:'), qr)
    }
}

function sanitizePairingNumber(value) {
    return String(value ?? '').replace(/[^0-9]/g, '')
}

async function requestPairingIfNeeded(session, options) {
    if (session.auth.state.creds.registered || getConfig().usePairingCode === false) return

    try {
        let phoneNumber = sanitizePairingNumber(getConfig().pairingNumber || process.env.WA_PAIRING_NUMBER)

        if (!phoneNumber) {
            const prompt = options.promptPhoneNumber || defaultPromptPhoneNumber
            const answer = await Promise.race([prompt(), session.released])

            if (session.state === 'closed') {
                closePrompt()
                return
            }

            phoneNumber = sanitizePairingNumber(answer)
        }

        if (!phoneNumber) {
            throw new Error('Nomor pairing kosong atau tidak valid. Isi config.pairingNumber atau WA_PAIRING_NUMBER dengan nomor telepon.')
        }

        const code = await session.sock.requestPairingCode(phoneNumber, 'KYYINFIN')
        console.log(chalk.blue('\nPAIRING CODE:'), code)
    } catch (error) {
        reportPluginError('runtime:pairing', error, {})
    }
}

export async function establishSession(options) {
    const createSocket = options.createSocket || defaultCreateSocket
    const startGen = generation

    const { sock, state, saveCreds } = await createSocket({ auth: lastAuth, authStore: options.authStore })

    if (startGen !== generation) {
        cleanupSocket(sock)
        return null
    }

    const gen = ++generation
    const session = createSession(sock, gen, { state, saveCreds })

    activeSession = session
    lastAuth = session.auth

    return { sock, session, gen }
}

export {
    defaultCreateSocket,
    handleConnectionUpdate,
    requestPairingIfNeeded
}
