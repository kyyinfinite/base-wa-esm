import fs from 'node:fs'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'
import ffmpeg from 'fluent-ffmpeg'
import webp from 'node-webpmux'
import { getConfig } from '../../services/config.js'

const EXIF_HEADER = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])

const STICKER_FILTER = "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"

const tmpFile = (ext) => path.join(tmpdir(), `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.${ext}`)

const removeFiles = (...files) => {
    for (const file of files) fs.rmSync(file, { force: true })
}

async function convertToWebp(media, inputExt, outputOptions) {
    const tmpFileIn = tmpFile(inputExt)
    const tmpFileOut = tmpFile('webp')

    try {
        fs.writeFileSync(tmpFileIn, media)

        await new Promise((resolve, reject) => {
            ffmpeg(tmpFileIn)
                .on('error', reject)
                .on('end', () => resolve(true))
                .addOutputOptions(outputOptions)
                .toFormat('webp')
                .save(tmpFileOut)
        })

        return fs.readFileSync(tmpFileOut)
    } finally {
        removeFiles(tmpFileIn, tmpFileOut)
    }
}

async function imageToWebp(media) {
    return convertToWebp(media, 'jpg', [
        '-vcodec', 'libwebp',
        '-vf', STICKER_FILTER
    ])
}

async function videoToWebp(media) {
    return convertToWebp(media, 'mp4', [
        '-vcodec', 'libwebp',
        '-vf', STICKER_FILTER,
        '-loop', '0',
        '-ss', '00:00:00',
        '-t', '00:00:05',
        '-preset', 'default',
        '-an',
        '-vsync', '0'
    ])
}

async function addExif(webpSticker, packname, author, categories = [''], extra = {}) {
    const config = getConfig()
    const img = new webp.Image()
    const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': packname || config.botName || 'MyBot',
        'sticker-pack-publisher': author || config.ownerName || 'Owner',
        'emojis': categories,
        ...extra
    }

    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8')
    const exif = Buffer.concat([EXIF_HEADER, jsonBuffer])
    exif.writeUIntLE(jsonBuffer.length, 14, 4)

    await img.load(webpSticker)
    img.exif = exif
    return await img.save(null)
}

async function writeExifImg(media, metadata = {}) {
    const { packname, author, categories = [''], ...extra } = metadata
    const webpSticker = await imageToWebp(media)
    return addExif(webpSticker, packname, author, categories, extra)
}

async function writeExifVid(media, metadata = {}) {
    const { packname, author, categories = [''], ...extra } = metadata
    const webpSticker = await videoToWebp(media)
    return addExif(webpSticker, packname, author, categories, extra)
}

export { imageToWebp, videoToWebp, writeExifImg, writeExifVid, addExif }