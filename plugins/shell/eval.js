import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { LANGUAGES, detectLanguage, runCode } from '../../src/services/code-runner.js'
import { getConfig } from '../../src/services/config.js'

const REQUEST_PATTERN = /^(=>|run)\s*([\s\S]*)$/i
const FENCE_PATTERN = /^```([\w+-]*)[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/
const TEXT_TYPES = new Set(['conversation', 'extendedTextMessage'])

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_OUTPUT_CHARS = 3500

const USAGE = `
\`=>\` / \`run\`  jalankan kode

*Inline*
=> 1 + 1
run console.log('halo')
run py print('halo')
run sh ls

*File / pesan*
Reply file atau kode lalu ketik: run
Kirim file dengan caption: run

*Bahasa*
js (default, akses conn & m), node (proses terpisah), py, sh, json
Contoh: run node  (sambil reply file js)
`.trim()

const toNumber = (value) => {
    if (typeof value === 'number') return value
    if (typeof value?.toNumber === 'function') return value.toNumber()
    return Number(value)
}

const clip = (text, max = MAX_OUTPUT_CHARS) => {
    if (text.length <= max) return text
    return `${text.slice(0, max)}\n… (${text.length - max} karakter terpotong)`
}

const parseFence = (text) => {
    const match = text.trim().match(FENCE_PATTERN)
    if (!match) return { code: text.trim(), hint: null }
    return { code: match[2], hint: LANGUAGES[match[1].toLowerCase()] || null }
}

const parseRequest = (text) => {
    const [, trigger, rest] = text.trim().match(REQUEST_PATTERN)

    let body = rest
    let hint = trigger === '=>' ? 'js' : null

    if (!hint) {
        const first = body.match(/^(\S+)\s*([\s\S]*)$/)
        if (first && LANGUAGES[first[1].toLowerCase()]) {
            hint = LANGUAGES[first[1].toLowerCase()]
            body = first[2]
        }
    }

    const fenced = parseFence(body)
    return { hint: hint || fenced.hint, code: fenced.code }
}

const resolveTarget = (m) => {
    if (m.mtype === 'documentMessage') {
        return { mtype: m.mtype, msg: m.msg, key: m.key }
    }

    if (m.quoted) {
        return { mtype: m.quoted.mtype, msg: m.quoted.msg, key: m.quoted.key, text: m.quoted.text }
    }

    return null
}

const loadSource = async (conn, m, request) => {
    if (request.code) {
        return { code: request.code, filename: '', hint: request.hint || 'js' }
    }

    const target = resolveTarget(m)
    if (!target) return null

    if (target.mtype === 'documentMessage') {
        if (toNumber(target.msg.fileLength) > MAX_SOURCE_BYTES) {
            throw new Error(`Ukuran file maksimal ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`)
        }

        const buffer = await downloadMediaMessage(
            { key: target.key, message: { [target.mtype]: target.msg } },
            'buffer',
            {},
            { reuploadRequest: conn.updateMediaMessage }
        )

        if (!buffer?.length) throw new Error('Gagal mendownload file.')
        if (buffer.includes(0)) throw new Error('File bukan teks, tidak bisa dijalankan.')

        return {
            code: buffer.toString('utf8'),
            filename: target.msg.fileName || '',
            hint: request.hint
        }
    }

    if (TEXT_TYPES.has(target.mtype) && target.text) {
        const fenced = parseFence(target.text)
        return { code: fenced.code, filename: '', hint: request.hint || fenced.hint }
    }

    throw new Error(`Tipe pesan tidak didukung: ${target.mtype || 'tidak diketahui'}`)
}

let handler = async (m, { conn, args, text, prefix, command, notifReply }) => {
    if (!getConfig().enableEval) {
        return notifReply('Perintah eval dinonaktifkan lewat config.enableEval.', 'Eval Disabled')
    }

    try {
        const request = parseRequest(m.text)
        const source = await loadSource(conn, m, request)

        if (!source) return notifReply(USAGE, 'Run')
        if (!source.code.trim()) return notifReply('Kode kosong.', 'Run')

        const language = request.code
            ? source.hint
            : detectLanguage({ hint: source.hint, filename: source.filename, code: source.code })

        const result = await runCode({
            language,
            code: source.code,
            context: {
                conn,
                m,
                args,
                text,
                prefix,
                command,
                notifReply,
                reply: (content, options = {}) =>
                    conn.sendMessage(m.chat, typeof content === 'string' ? { text: content } : content, { quoted: m, ...options }),
                quoted: m.quoted || null
            }
        })

        const body = [result.output, result.error].filter(Boolean).join('\n\n') || 'Selesai tanpa output.'
        const label = source.filename ? `${source.filename} • ${result.language}` : result.language

        await notifReply(`${clip(body)}\n\n_${label} • ${result.durationMs} ms_`, result.failed ? 'Run Error' : 'Run Result')
    } catch (e) {
        await notifReply(e.message, 'Run Error')
    }
}

handler.customPrefix = /^(=>|run(?=\s|$))/i
handler.creator = true

export default handler