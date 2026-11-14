import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { writeExifImg, writeExifVid } from '../../src/lib/image/exif.js'

const SUPPORTED_TYPES = new Set(['imageMessage', 'videoMessage'])
const MAX_VIDEO_SECONDS = 10

const resolveTarget = (m) => {
    if (SUPPORTED_TYPES.has(m.mtype)) {
        return { mtype: m.mtype, msg: m.msg, key: m.key }
    }

    if (m.quoted && SUPPORTED_TYPES.has(m.quoted.mtype)) {
        return { mtype: m.quoted.mtype, msg: m.quoted.msg, key: m.quoted.key }
    }

    return null
}

let handler = async (m, { conn, text, prefix, command, notifReply }) => {
    const target = resolveTarget(m)

    if (!target) {
        return notifReply(`Kirim atau reply gambar/video dengan caption *${prefix}${command}*\n\nCustom pack:\n${prefix}${command} packname|author`, 'Sticker')
    }

    if (target.mtype === 'videoMessage' && Number(target.msg.seconds) > MAX_VIDEO_SECONDS) {
        return notifReply(`Durasi video maksimal ${MAX_VIDEO_SECONDS} detik.`, 'Sticker')
    }

    const [packname, author] = String(text || '').split('|').map(v => v.trim())

    try {
        const media = await downloadMediaMessage(
            { key: target.key, message: { [target.mtype]: target.msg } },
            'buffer',
            {},
            { reuploadRequest: conn.updateMediaMessage }
        )

        const sticker = target.mtype === 'videoMessage'
            ? await writeExifVid(media, { packname, author })
            : await writeExifImg(media, { packname, author })

        await conn.sendMessage(m.chat, { sticker }, { quoted: m })
    } catch (e) {
        console.error(e)
        await notifReply(`❌ Gagal membuat sticker: ${e.message}`, 'Sticker')
    }
}

handler.command = ['s', 'sticker', 'stiker']
handler.description = 'Ubah gambar atau video jadi sticker'

export default handler