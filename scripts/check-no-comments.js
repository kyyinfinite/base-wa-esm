import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const TARGETS = ['index.js', 'src', 'plugins', 'test', 'scripts']
const REGEX_KEYWORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await'
])

function collectFiles(entry, out) {
    const full = path.join(ROOT, entry)
    let stat
    try {
        stat = fs.statSync(full)
    } catch {
        return out
    }

    if (stat.isDirectory()) {
        for (const item of fs.readdirSync(full)) {
            if (item === 'node_modules' || item === '.run-tmp' || item === 'session') continue
            collectFiles(path.join(entry, item), out)
        }
    } else if (entry.endsWith('.js')) {
        out.push(full)
    }

    return out
}

function trackToken(ch, state) {
    state.prevChar = ch
    if (/[A-Za-z0-9_$]/.test(ch)) state.prevWord += ch
    else state.prevWord = ''
}

function pushValueEnd(state) {
    state.prevChar = ')'
    state.prevWord = ''
}

function regexAllowed(state) {
    if (!state.prevChar) return true
    if (/[A-Za-z0-9_$]/.test(state.prevChar)) return REGEX_KEYWORDS.has(state.prevWord)
    if (state.prevChar === ')' || state.prevChar === ']') return false
    return true
}

function scanComments(code) {
    const comments = []
    const state = { prevChar: '', prevWord: '' }
    const frames = []
    let mode = 'code'
    let i = 0
    let line = 1

    while (i < code.length) {
        const ch = code[i]
        const next = code[i + 1]

        if (ch === '\n') {
            line += 1
            i += 1
            continue
        }

        if (mode === 'code') {
            if (ch === '/' && next === '/') {
                const end = code.indexOf('\n', i)
                comments.push({ line, kind: 'line', snippet: code.slice(i, end < 0 ? code.length : end) })
                while (i < code.length && code[i] !== '\n') i += 1
                continue
            }

            if (ch === '/' && next === '*') {
                comments.push({ line, kind: 'block', snippet: code.slice(i, i + 40) })
                i += 2
                while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
                    if (code[i] === '\n') line += 1
                    i += 1
                }
                i += 2
                continue
            }

            if (ch === '/' && regexAllowed(state)) {
                mode = 'regex'
                i += 1
                continue
            }

            if (ch === "'") {
                mode = 'sq'
                i += 1
                continue
            }

            if (ch === '"') {
                mode = 'dq'
                i += 1
                continue
            }

            if (ch === '`') {
                mode = 'tpl'
                i += 1
                continue
            }

            if (ch === '{') {
                if (frames.length) frames[frames.length - 1].depth += 1
                trackToken(ch, state)
                i += 1
                continue
            }

            if (ch === '}') {
                const top = frames[frames.length - 1]
                if (top) {
                    if (top.depth === 0) {
                        frames.pop()
                        mode = 'tpl'
                    } else {
                        top.depth -= 1
                    }
                    i += 1
                    continue
                }
                trackToken(ch, state)
                i += 1
                continue
            }

            trackToken(ch, state)
            i += 1
            continue
        }

        if (mode === 'tpl') {
            if (ch === '\\') {
                i += 2
                continue
            }
            if (ch === '`') {
                mode = 'code'
                pushValueEnd(state)
                i += 1
                continue
            }
            if (ch === '$' && next === '{') {
                frames.push({ depth: 0 })
                mode = 'code'
                i += 2
                continue
            }
            i += 1
            continue
        }

        if (mode === 'sq' || mode === 'dq') {
            if (ch === '\\') {
                i += 2
                continue
            }
            if ((mode === 'sq' && ch === "'") || (mode === 'dq' && ch === '"')) {
                mode = 'code'
                pushValueEnd(state)
            }
            i += 1
            continue
        }

        if (mode === 'regex') {
            if (ch === '\\') {
                i += 2
                continue
            }
            if (ch === '[') {
                mode = 'regex-class'
                i += 1
                continue
            }
            if (ch === '/') {
                mode = 'code'
                i += 1
                while (i < code.length && /[a-z]/i.test(code[i])) i += 1
                pushValueEnd(state)
                continue
            }
            i += 1
            continue
        }

        if (mode === 'regex-class') {
            if (ch === '\\') {
                i += 2
                continue
            }
            if (ch === ']') mode = 'regex'
            i += 1
            continue
        }
    }

    return comments
}

const files = TARGETS.flatMap(entry => collectFiles(entry, []))
const findings = []

for (const file of files) {
    let code
    try {
        code = fs.readFileSync(file, 'utf8')
    } catch (error) {
        console.error(`Gagal membaca ${file}: ${error.message}`)
        process.exitCode = 1
        continue
    }

    for (const comment of scanComments(code)) {
        findings.push(`${path.relative(ROOT, file)}:${comment.line} komentar ${comment.kind}: ${comment.snippet.slice(0, 60).trim()}`)
    }
}

if (findings.length) {
    console.error(`Ditemukan ${findings.length} komentar di ${files.length} file yang dipindai:`)
    for (const item of findings) console.error(` - ${item}`)
    process.exit(1)
}

console.log(`OK: tidak ada komentar di ${files.length} file yang dipindai.`)
