import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { plugins, registerPlugin, unregisterPlugin, replacePlugin, getKeysOf, validatePlugin } from './registry.js'
import { events } from '../events/engine.js'
import { reportPluginError } from '../errors/engine.js'
import { getConfig } from '../../services/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultPluginDir = path.join(__dirname, '../../../plugins')

const pluginCache = new Map()
const watchers = new Map()
const pendingReloads = new Map()
const initializedDirs = new Set()
const eventSubscriptions = new Map()

let cacheCounter = 0
let coreObject = null

export function isPluginsLoaded(pluginDir = defaultPluginDir) {
    return initializedDirs.has(pluginDir)
}

export function getPluginFiles(dir) {
    let files = []
    if (!fs.existsSync(dir)) return files
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) files.push(...getPluginFiles(full))
        else if (item.isFile() && item.name.endsWith('.js') && !item.name.startsWith('.')) files.push(full)
    }
    return files
}

async function getCore() {
    if (coreObject) return coreObject

    const [transport, outboundModule, configModule] = await Promise.all([
        import('../app/transport.js'),
        import('../outbound/index.js'),
        import('../../services/config.js')
    ])

    coreObject = {
        bus: events,
        outbound: outboundModule.default,
        getSocket: transport.getActiveSocket,
        config: configModule.getConfig
    }

    return coreObject
}

async function runInit(handler, file) {
    if (typeof handler?.init !== 'function') return true

    try {
        const core = await getCore()
        await handler.init(core)
        return true
    } catch (error) {
        reportPluginError('plugin:init', error, { file })
        events.emit('plugin:error', file, error)
        return false
    }
}

async function runDispose(handler, file) {
    if (!handler || typeof handler.dispose !== 'function') return

    try {
        await handler.dispose()
    } catch (error) {
        reportPluginError('plugin:dispose', error, { file })
    }
}

function subscribePluginEvents(file, handler) {
    const map = handler?.on
    if (!map || typeof map !== 'object' || Array.isArray(map)) return

    const subs = []
    for (const [event, listener] of Object.entries(map)) {
        if (typeof listener !== 'function') continue
        events.on(event, listener)
        subs.push({ event, listener })
    }

    if (subs.length) eventSubscriptions.set(file, subs)
}

function unsubscribePluginEvents(file) {
    const subs = eventSubscriptions.get(file)
    if (!subs) return
    for (const { event, listener } of subs) {
        events.off(event, listener)
    }
    eventSubscriptions.delete(file)
}

export async function loadPlugin(file) {
    try {
        const cacheBust = `${Date.now()}-${cacheCounter++}`
        const module = await import(`${pathToFileURL(file).href}?update=${cacheBust}`)
        const handler = module.default

        if (!handler) return null

        validatePlugin(handler)

        const previous = pluginCache.has(file) ? pluginCache.get(file) : null
        const previousHandler = previous && previous.length ? plugins.get(previous[0]) : null

        if (previous) {
            unsubscribePluginEvents(file)
            await runDispose(previousHandler, file)
            pluginCache.set(file, replacePlugin(file, previous, handler))
        } else {
            pluginCache.set(file, registerPlugin(file, handler))
        }

        if (!(await runInit(handler, file))) {
            const keys = pluginCache.get(file)
            unregisterPlugin(file, keys)
            pluginCache.delete(file)

            if (previous) {
                try {
                    pluginCache.set(file, registerPlugin(file, previousHandler))
                } catch {}
            }

            return null
        }

        subscribePluginEvents(file, handler)
        events.emit('plugin:file-loaded', file)
        return handler
    } catch (e) {
        reportPluginError('plugin:load', e, { file })
        events.emit('plugin:error', file, e)
        return null
    }
}

export async function unloadPlugin(file) {
    if (!pluginCache.has(file)) return false

    const keys = pluginCache.get(file)
    const handler = keys && keys.length ? plugins.get(keys[0]) : null

    unsubscribePluginEvents(file)
    unregisterPlugin(file, keys)
    pluginCache.delete(file)
    await runDispose(handler, file)
    return true
}

export async function initPlugins(pluginDir = defaultPluginDir) {
    if (initializedDirs.has(pluginDir)) return pluginCache.size
    initializedDirs.add(pluginDir)

    for (const file of getPluginFiles(pluginDir)) {
        await loadPlugin(file)
    }
    watch(pluginDir)
    return pluginCache.size
}

function watch(dir) {
    if (watchers.has(dir)) return
    if (!getConfig().hotReload) return

    const watcher = fs.watch(dir, (_, filename) => {
        if (!filename || filename.startsWith('.')) return

        if (!filename.endsWith('.js')) {
            handleNewDir(dir, filename)
            return
        }

        const file = path.join(dir, filename)
        if (pendingReloads.has(file)) clearTimeout(pendingReloads.get(file))
        pendingReloads.set(file, setTimeout(() => {
            pendingReloads.delete(file)
            if (fs.existsSync(file)) loadPlugin(file)
            else unloadPlugin(file)
        }, 200))
    })

    watchers.set(dir, watcher)

    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) watch(path.join(dir, item.name))
    }
}

function handleNewDir(parentDir, dirname) {
    const dir = path.join(parentDir, dirname)
    let stat
    try {
        stat = fs.statSync(dir)
    } catch {
        return
    }

    if (!stat.isDirectory()) return

    for (const file of getPluginFiles(dir)) {
        if (!pluginCache.has(file)) loadPlugin(file)
    }
    watch(dir)
}

export function stopWatching() {
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    for (const timer of pendingReloads.values()) clearTimeout(timer)
    pendingReloads.clear()
}

export function getLoadedPluginFiles() {
    return [...pluginCache.keys()]
}

export { plugins }

export default { initPlugins, loadPlugin, unloadPlugin, getPluginFiles }
