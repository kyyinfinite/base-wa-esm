import { getBuffer } from '../../src/utils/myfunc.js'
import { writeExifVid, addExif } from '../../src/lib/image/exif.js'

const API_URL = 'https://api.kyyinfinite.my.id/api/v1/maker/bratvid'
const MAX_TEXT_LENGTH = 200

const isWebp = (buffer) =>
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'

let handler = async (m, { conn, text, prefix, command, notifReply }) => {
    const input = String(text || m.quoted?.text || '').trim()

    if (!input) {
        return notifReply(`Contoh:\n${prefix}${command} halo dunia\n\nAtau reply pesan teks dengan *${prefix}${command}*`, 'Brat Video')
    }

    if (input.length > MAX_TEXT_LENGTH) {
        return notifReply(`Teks maksimal ${MAX_TEXT_LENGTH} karakter.`, 'Brat Video')
    }

    try {
        const data = await getBuffer(`${API_URL}?text=${encodeURIComponent(input)}`, { timeout: 60000 })
        const media = Buffer.from(data)

        const sticker = isWebp(media)
            ? await addExif(media)
            : await writeExifVid(media)

        await conn.sendMessage(m.chat, { sticker }, { quoted: m })
    } catch (e) {
        console.error(e)
        await notifReply(`❌ Gagal membuat brat video: ${e.message}`, 'Brat Video')
    }
}

handler.command = ['bratvid', 'bratvideo']
handler.description = 'Buat sticker brat animasi dari teks'

export default handler