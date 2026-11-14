import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
const execFileAsync = util.promisify(execFile)
const nodeRequire = createRequire(import.meta.url)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP_DIR = path.join(ROOT, '.run-tmp')

const JS_TIMEOUT_MS = 60_000
const PROCESS_TIMEOUT_MS = 30_000
const PROCESS_MAX_BUFFER = 5 * 1024 * 1024

const ESM_PATTERN = /^\s*(import\s+[\w{*'"]|export\s)/m
const CJS_PATTERN = /\brequire\(|module\.exports/
const SHEBANG_PATTERN = /^#!.*\b(node|python3?|bash|sh)\b/

globalThis.__runSandboxes ??= new Map()

export const LANGUAGES = {
    js: 'js',
    javascript: 'js',
    mjs: 'js',
    cjs: 'js',
    node: 'node',
    py: 'py',
    python: 'py',
    sh: 'sh',
    bash: 'sh',
    shell: 'sh',
    json: 'json'
}

const EXTENSIONS = {
    js: 'js',
    mjs: 'js',
    cjs: 'js',
    json: 'json',
    py: 'py',
    sh: 'sh',
    bash: 'sh'
}

const SHEBANGS = {
    node: 'node',
    python: 'py',
    python3: 'py',
    bash: 'sh',
    sh: 'sh'
}

const PROCESS_RUNNERS = {
    node: {
        commands: [process.execPath],
        ext: (code) => (ESM_PATTERN.test(code) || !CJS_PATTERN.test(code) ? 'mjs' : 'cjs')
    },
    py: {
        commands: ['python3', 'python'],
        ext: () => 'py'
    },
    sh: {
        commands: ['bash', 'sh'],
        ext: () => 'sh'
    }
}

const buildChildEnv = () => {
    const env = {}
    for (const key of ['PATH', 'HOME', 'LANG', 'NODE_ENV']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    return env
}

const formatErrorName = (name) => String(name).replace(/([a-z])([A-Z])/g, '$1 $2')

const formatError = (err) => {
    if (!(err instanceof Error)) return String(err)

    const stack = String(err.stack || '')
        .split('\n')
        .slice(1, 4)
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n')
        .replaceAll(ROOT, '.')

    return `${formatErrorName(err.name)}: ${err.message}${stack ? `\n${stack}` : ''}`
}

const withTimeout = (promise, ms) => {
    let timer

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout setelah ${ms / 1000} detik`)), ms)
    })

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const tmpFile = (ext) => {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    return path.join(TMP_DIR, `${crypto.randomBytes(6).toString('hex')}.${ext}`)
}

const stripShebang = (code) => code.replace(/^#!.*\r?\n/, '')

const buildBody = (code) => {
    const trimmed = code.trim()
    if (!trimmed) return 'return undefined'
    if (/(^|[^.\w])return[\s;]/.test(trimmed)) return trimmed
    try {
        new Function(`return (${trimmed})`)
        return `return (${trimmed})`
    } catch {
        return trimmed
    }
}

const createConsole = (lines) => {
    const write = (...args) => {
        lines.push(util.format(...args))
    }

    return {
        log: write,
        info: write,
        warn: write,
        error: write,
        debug: write,
        trace: write,
        table: write,
        dir: (value, options = {}) => {
            lines.push(util.inspect(value, { depth: 2, colors: false, ...options }))
        }
    }
}

const createScope = (context, lines) => ({
    ...context,
    sock: context.conn,
    console: createConsole(lines),
    util,
    fs,
    path,
    os,
    require: nodeRequire,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms))
})

async function runModule(code, scope, timeoutMs) {
    const id = crypto.randomBytes(6).toString('hex')
    const file = tmpFile('mjs')

    globalThis.__runSandboxes.set(id, scope)

    const source = `const ctx = globalThis.__runSandboxes.get('${id}')\nconst console = ctx.console\n${code}`
    fs.writeFileSync(file, source)

    try {
        const mod = await withTimeout(import(pathToFileURL(file).href), timeoutMs)
        if (typeof mod.default === 'function') {
            return await withTimeout(Promise.resolve(mod.default(scope)), timeoutMs)
        }
        return undefined
    } finally {
        globalThis.__runSandboxes.delete(id)
        fs.rmSync(file, { force: true })
    }
}

async function runJavaScript(code, context, lines, timeoutMs) {
    const source = stripShebang(code)
    const scope = createScope(context, lines)

    if (ESM_PATTERN.test(source)) {
        return runModule(source, scope, timeoutMs)
    }

    const fn = new AsyncFunction(...Object.keys(scope), buildBody(source))
    return withTimeout(fn(...Object.values(scope)), timeoutMs)
}

async function runProcess(language, code, timeoutMs) {
    const runner = PROCESS_RUNNERS[language]
    const file = tmpFile(runner.ext(code))
    fs.writeFileSync(file, stripShebang(code))

    try {
        for (const command of runner.commands) {
            try {
                const { stdout, stderr } = await execFileAsync(command, [file], {
                    cwd: ROOT,
                    timeout: timeoutMs,
                    maxBuffer: PROCESS_MAX_BUFFER,
                    windowsHide: true,
                    env: buildChildEnv()
                })
                return { stdout, stderr, exitCode: 0, timedOut: false }
            } catch (err) {
                if (err.code === 'ENOENT') continue
                return {
                    stdout: err.stdout || '',
                    stderr: err.stderr || '',
                    exitCode: typeof err.code === 'number' ? err.code : 1,
                    timedOut: !!err.killed
                }
            }
        }

        throw new Error(`${runner.commands[0]} tidak ditemukan di sistem`)
    } finally {
        fs.rmSync(file, { force: true })
    }
}

const describeJson = (code) => {
    const data = JSON.parse(code)

    const kind = Array.isArray(data)
        ? `array (${data.length} item)`
        : data === null
            ? 'null'
            : typeof data === 'object'
                ? `object (${Object.keys(data).length} key)`
                : typeof data

    return `JSON valid • ${kind}\n\n${JSON.stringify(data, null, 2)}`
}

const formatJavaScriptOutput = (lines, value) => {
    const parts = []

    if (lines.length) parts.push(lines.join('\n'))

    if (value !== undefined) {
        const text = typeof value === 'string' ? value : util.inspect(value, { depth: 2, colors: false })
        parts.push(lines.length ? `⇒ ${text}` : text)
    }

    return parts.join('\n')
}

const formatProcessOutput = (result, timeoutMs) => {
    const parts = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean)

    if (result.timedOut) parts.push(`Timeout setelah ${timeoutMs / 1000} detik, proses dihentikan.`)
    else if (result.exitCode !== 0) parts.push(`exit code ${result.exitCode}`)

    return parts.join('\n')
}

export function detectLanguage({ hint, filename = '', code = '' } = {}) {
    if (hint && LANGUAGES[hint]) return LANGUAGES[hint]

    const ext = path.extname(filename).slice(1).toLowerCase()
    if (EXTENSIONS[ext]) return EXTENSIONS[ext]

    const shebang = code.match(SHEBANG_PATTERN)
    if (shebang) return SHEBANGS[shebang[1]]

    try {
        const data = JSON.parse(code)
        if (data !== null && typeof data === 'object') return 'json'
    } catch {}

    return 'js'
}

export async function runCode({ language, code, context = {}, timeoutMs } = {}) {
    const started = Date.now()
    const lines = []
    let output = ''
    let error = ''
    let failed = false

    try {
        if (language === 'json') {
            output = describeJson(code)
        } else if (language === 'js') {
            const value = await runJavaScript(code, context, lines, timeoutMs ?? JS_TIMEOUT_MS)
            output = formatJavaScriptOutput(lines, value)
        } else if (PROCESS_RUNNERS[language]) {
            const limit = timeoutMs ?? PROCESS_TIMEOUT_MS
            const result = await runProcess(language, code, limit)
            output = formatProcessOutput(result, limit)
            failed = result.timedOut || result.exitCode !== 0
        } else {
            throw new Error(`Bahasa tidak didukung: ${language}`)
        }
    } catch (err) {
        error = formatError(err)
        output = lines.join('\n')
    }

    return {
        language,
        output,
        error,
        failed: failed || !!error,
        durationMs: Date.now() - started
    }
}

export default { LANGUAGES, detectLanguage, runCode }