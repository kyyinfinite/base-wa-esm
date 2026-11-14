import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { Button, Toolkit } from '../../src/lib/message/wrapper.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const UPLOAD_TIMEOUT_MS = 60_000
const MAX_FILE_BYTES = 50 * 1024 * 1024

const MEDIA_TYPES = {
    imageMessage: { kind: 'image', ext: 'jpg' },
    videoMessage: { kind: 'video', ext: 'mp4' },
    audioMessage: { kind: 'audio', ext: 'mp3' },
    stickerMessage: { kind: 'sticker', ext: 'webp' },
    documentMessage: { kind: 'document', ext: 'bin' }
}

const resolveTarget = (m) => {
    if (MEDIA_TYPES[m.mtype]) {
        return { mtype: m.mtype, msg: m.msg, key: m.key }
    }

    if (m.quoted && MEDIA_TYPES[m.quoted.mtype]) {
        return { mtype: m.quoted.mtype, msg: m.quoted.msg, key: m.quoted.key }
    }

    return null
}

const postForm = async (url, form) => {
    const res = await fetch(url, {
        method: 'POST',
        body: form,
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })

    const body = (await res.text()).trim()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return body
}

const toBlob = (buffer, mimetype) => new Blob([buffer], { type: mimetype || 'application/octet-stream' })

async function uploadWhatsApp({ conn, buffer, kind }) {
    const url = await Toolkit.toUrl(conn, buffer, kind)
    if (!url) throw new Error('URL tidak dikembalikan')
    return url
}

async function uploadCatbox({ buffer, filename, mimetype }) {
    const form = new FormData()
    form.append('reqtype', 'fileupload')
    form.append('fileToUpload', toBlob(buffer, mimetype), filename)

    const url = await postForm('https://catbox.moe/user/api.php', form)
    if (url.startsWith('https://files.catbox.moe/')) return url
    throw new Error(url.slice(0, 100))
}

async function uploadLitterbox({ buffer, filename, mimetype }) {
    const form = new FormData()
    form.append('reqtype', 'fileupload')
    form.append('time', '1h')
    form.append('fileToUpload', toBlob(buffer, mimetype), filename)

    const url = await postForm('https://litterbox.catbox.moe/resources/internals/api.php', form)
    if (url.startsWith('https://litterbox.catbox.moe/')) return url
    throw new Error(url.slice(0, 100))
}

async function uploadZero({ buffer, filename, mimetype }) {
    const form = new FormData()
    form.append('file', toBlob(buffer, mimetype), filename)

    const url = await postForm('https://0x0.st', form)
    if (url.startsWith('https://0x0.st/')) return url
    throw new Error(url.slice(0, 100))
}

const HOSTS = [
    { name: 'WhatsApp', fn: uploadWhatsApp },
    { name: 'Catbox', fn: uploadCatbox },
    { name: 'Litterbox', fn: uploadLitterbox },
    { name: '0x0.st', fn: uploadZero }
]

async function uploadWithFallback(payload) {
    const errors = []

    for (const host of HOSTS) {
        try {
            const url = await host.fn(payload)
            if (url) return { url, host: host.name }
        } catch (e) {
            errors.push(`${host.name}: ${e.message}`)
        }
    }

    throw new Error(`Semua hosting gagal:\n${errors.join('\n')}`)
}

let handler = async (m, { conn, prefix, command, notifReply }) => {
    const target = resolveTarget(m)

    if (!target) {
        return notifReply(`Kirim atau reply gambar/video/audio/dokumen dengan caption *${prefix}${command}*\n\nFile akan diupload ke hosting dengan fallback otomatis.`, 'Upload')
    }

    if (Number(target.msg.fileLength) > MAX_FILE_BYTES) {
        return notifReply(`Ukuran file maksimal ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 'Upload')
    }

    const react = (emoji) => conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } }).catch(() => {})

    await react('⏳')

    try {
        const buffer = await downloadMediaMessage(
            { key: target.key, message: { [target.mtype]: target.msg } },
            'buffer',
            {},
            { reuploadRequest: conn.updateMediaMessage }
        )

        if (!buffer?.length) throw new Error('Gagal mendownload file')

        const { kind, ext } = MEDIA_TYPES[target.mtype]
        let filename = target.msg.fileName || `file_${Date.now()}`
        if (!filename.includes('.')) filename += `.${ext}`

        const result = await uploadWithFallback({
            conn,
            buffer,
            filename,
            kind,
            mimetype: target.msg.mimetype
        })

        const body = `📁 *File:* ${filename}\n🔗 *URL:* ${result.url}`

        try {
            await new Button(conn)
                .setTitle('✅ Upload Berhasil')
                .setSubtitle(`Host: ${result.host}`)
                .setBody(body)
                .setFooter('Klik tombol di bawah untuk menyalin atau membuka.')
                .addCopy('Copy URL', result.url)
                .addUrl('Buka URL', result.url, false)
                .addReply('Upload Lagi', `${prefix}${command}`)
                .send(m.chat, { quoted: m })
        } catch (e) {
            console.error(e)
            await notifReply(`${body}\n *Host:* ${result.host}`, 'Upload Berhasil')
        }

        await react('✅')
    } catch (e) {
        console.error(e)
        await react('❌')
        await notifReply(`❌ Gagal upload:\n${e.message}`, 'Upload')
    }
}

handler.command = ['upload', 'host', 'catbox', 'uploadfile', 'tourl']
handler.description = 'Upload file ke hosting dan ambil link-nya'
handler.cooldown = 15000

export default handler