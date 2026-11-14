import { test, describe, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpMs = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ms-'))
process.env.WA_DATABASE_DIR = tmpMs
process.env.WA_CONFIG_PATH = path.join(tmpMs, 'config.json')
fs.writeFileSync(process.env.WA_CONFIG_PATH, JSON.stringify({ botMode: 'public', prefix: ['.'], dailyLimit: 5, creator: [] }))

const { storeOutgoingMessage, getMessageForRetry, getMessageStoreStats, resetMessageStore } =
    await import('../src/services/message-store.js')
const { prepare, closeDatabase } = await import('../src/services/database/sqlite.js')

const CONTENT = { conversation: 'halo dari bot' }

after(() => {
    closeDatabase()
    fs.rmSync(tmpMs, { recursive: true, force: true })
})

describe('message store (F-6)', () => {
    beforeEach(() => {
        resetMessageStore()
    })

    test('pesan terkirim tersimpan dan diambil untuk retry', () => {
        const key = { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'MSG1' }
        assert.equal(storeOutgoingMessage(key, CONTENT), true)
        assert.deepEqual(getMessageForRetry({ ...key, id: 'MSG1' }), CONTENT)
    })

    test('pesan non-own dan konten tidak valid ditolak', () => {
        assert.equal(storeOutgoingMessage({ id: 'MSG2' }, null), false)
        assert.equal(storeOutgoingMessage(null, CONTENT), false)
        assert.equal(getMessageForRetry({ id: 'missing' }), undefined)
        assert.equal(getMessageForRetry({}), undefined)
    })

    test('store ter-persist ke tabel dan dapat dimuat ulang', async () => {
        resetMessageStore()
        storeOutgoingMessage({ remoteJid: '628112@s.whatsapp.net', id: 'MSG3' }, CONTENT)

        const row = prepare('SELECT jid, content FROM outgoing_messages WHERE id = ?').get('MSG3')
        assert.equal(row.jid, '628112@s.whatsapp.net')
        assert.equal(JSON.parse(row.content).conversation, 'halo dari bot')

        const fresh = await import('../src/services/message-store.js?reload=1')
        assert.deepEqual(fresh.getMessageForRetry({ id: 'MSG3' }), CONTENT, 'record dimuat ulang oleh instance baru')
    })

    test('rekaman kedaluwarsa dibuang dan dihapus saat dimuat', async () => {
        resetMessageStore()
        prepare('INSERT INTO outgoing_messages(id, jid, content, created_at) VALUES (?, ?, ?, ?)').run('LEGACY1', '628111@s.whatsapp.net', JSON.stringify({ conversation: 'lama' }), Date.now() - 2 * 60 * 60_000)

        const fresh = await import('../src/services/message-store.js?expired=1')
        assert.equal(fresh.getMessageForRetry({ id: 'LEGACY1' }), undefined, 'rekaman kedaluwarsa tidak diteruskan')
        assert.equal(prepare('SELECT 1 AS found FROM outgoing_messages WHERE id = ?').get('LEGACY1'), undefined, 'rekaman kedaluwarsa dihapus dari tabel')
    })

    test('LRU: entri terlama dibuang saat melebihi kapasitas', () => {
        const { max } = getMessageStoreStats()
        for (let i = 0; i <= max; i++) {
            storeOutgoingMessage({ remoteJid: '628113@s.whatsapp.net', id: `BULK${i}` }, { conversation: String(i) })
        }

        assert.equal(getMessageStoreStats().entries, max)
        assert.ok(getMessageForRetry({ id: `BULK${max}` }), 'entri terbaru tersedia')
        assert.equal(getMessageForRetry({ id: 'BULK0' }), undefined, 'entri terlama sudah terbuang')
    })

    test('TTL kedaluwarsa menghapus entri', async () => {
        mock.timers.enable({ apis: ['Date'] })
        try {
            storeOutgoingMessage({ remoteJid: '628114@s.whatsapp.net', id: 'TTL1' }, CONTENT)
            assert.deepEqual(getMessageForRetry({ id: 'TTL1' }), CONTENT)

            mock.timers.tick(60 * 60_000 + 1)
            assert.equal(getMessageForRetry({ id: 'TTL1' }), undefined)
        } finally {
            mock.timers.reset()
        }
    })
})
