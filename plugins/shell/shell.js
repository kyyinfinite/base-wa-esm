import { promisify, inspect } from 'util'
import { exec } from 'child_process'
import { getConfig } from '../../src/services/config.js'

const shell = promisify(exec)

export const SHELL_TIMEOUT_MS = 30_000
export const SHELL_MAX_BUFFER = 1024 * 1024
export const SHELL_MAX_OUTPUT_CHARS = 4000

export function clipShellOutput(text, max = SHELL_MAX_OUTPUT_CHARS) {
    const value = String(text ?? '')
    if (value.length <= max) return value
    return `${value.slice(0, max)}\n… (${value.length - max} karakter terpotong)`
}

export async function shellExec(cmd, { timeoutMs = SHELL_TIMEOUT_MS, maxBuffer = SHELL_MAX_BUFFER } = {}) {
    return shell(cmd, { shell: '/bin/bash', timeout: timeoutMs, maxBuffer })
}

let handler = async (m, { notifReply }) => {
    if (!getConfig().enableShell) {
        return notifReply('Perintah shell dinonaktifkan lewat config.enableShell.', 'Shell Disabled')
    }

    const cmd = m.text.replace(/^\$/, '').trim()
    if (!cmd) return notifReply('Contoh:\n$ ls', 'Shell Command')

    try {
        const { stdout, stderr } = await shellExec(cmd)
        await notifReply(clipShellOutput(stderr || stdout || 'Done.'), 'Shell Result')
    } catch (e) {
        if (e.killed || /TIMEDOUT/i.test(String(e.message || ''))) {
            return notifReply(`Perintah melebihi batas waktu ${SHELL_TIMEOUT_MS / 1000} detik dan dihentikan.`, 'Shell Timeout')
        }
        await notifReply(clipShellOutput(e.stderr || e.stdout || inspect(e)), 'Shell Error')
    }
}

handler.customPrefix = /^\$/
handler.creator = true

export default handler
