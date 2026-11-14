import { getBuffer } from '../../src/utils/myfunc.js'
import { writeExifImg, addExif } from '../../src/lib/image/exif.js'

const API_URL = 'https://api.kyyinfinite.my.id/api/v1/maker/brat'
const MAX_TEXT_LENGTH = 200

const isWebp = (buffer) =>
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'

let handler = async (m, { conn, text, prefix, command, notifReply }) => {
    const input = String(text || m.quoted?.text || '').trim()

    if (!input) {
        return notifReply(`Contoh:\n${prefix}${command} halo dunia\n\nAtau reply pesan teks dengan *${prefix}${command}*`, 'Brat')
    }

    if (input.length > MAX_TEXT_LENGTH) {
        return notifReply(`Teks maksimal ${MAX_TEXT_LENGTH} karakter.`, 'Brat')
    }

    try {
        const data = await getBuffer(`${API_URL}?text=${encodeURIComponent(input)}`)
        const media = Buffer.from(data)

        const sticker = isWebp(media)
            ? await addExif(media)
            : await writeExifImg(media)

        await conn.sendMessage(m.chat, { sticker }, { quoted: m })
    } catch (e) {
        console.error(e)
        await notifReply(`❌ Gagal membuat brat: ${e.message}`, 'Brat')
    }
}

handler.command = ['brat']
handler.description = 'Buat sticker brat dari teks'

export default handler