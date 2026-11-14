import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildMessageInfoSections, formatInfoBlock } from '../src/lib/crm/format.js'

const sample = {
    type: 'imageMessage',
    source: 'crmstore',
    id: '3EB0223A98D50CE5D8FD59',
    sender: '628123456789',
    chat: '120363000000000000@g.us',
    nodeChat: '120363000000000000@g.us',
    tag: 'message',
    nodeId: 'A5B7C9',
    attrs: 5,
    children: '2 (1 fail)'
}

describe('format info CRM: gaya memory usage', () => {
    test('header memakai backtick dan nilai sejajar seperti memory usage', () => {
        const text = formatInfoBlock(buildMessageInfoSections(sample))

        assert.equal(text, [
            '`[ MESSAGE ]`',
            'type     : imageMessage',
            'source   : crmstore',
            'id       : 3EB0223A98D50CE5D8FD59',
            'sender   : 628123456789',
            '',
            '`[ CHAT ]`',
            'chat     : 120363000000000000@g.us',
            'nodeChat : 120363000000000000@g.us',
            '',
            '`[ NODE ]`',
            'tag      : message',
            'nodeId   : A5B7C9',
            'attrs    : 5',
            'children : 2 (1 fail)'
        ].join('\n'))
    })

    test('markup: false menghasilkan header polos untuk tampilan snip', () => {
        const text = formatInfoBlock(buildMessageInfoSections(sample), { markup: false })

        assert.ok(text.startsWith('[ MESSAGE ]\n'))
        assert.ok(text.includes('\n\n[ CHAT ]\n'))
        assert.ok(!text.includes('`'))
        assert.ok(text.includes('children : 2 (1 fail)'))
    })

    test('lebar kunci sama di semua bagian dan titik dua sejajar', () => {
        const lines = formatInfoBlock(buildMessageInfoSections(sample)).split('\n').filter(line => line.includes(' : '))
        const columns = new Set(lines.map(line => line.indexOf(' : ')))

        assert.equal(columns.size, 1)
    })

    test('nilai kosong menjadi tanda hubung dan angka nol tetap tampil', () => {
        const text = formatInfoBlock(buildMessageInfoSections({ type: 'conversation', attrs: 0, children: 0, tag: '', source: null }))

        assert.ok(text.includes('source   : -'))
        assert.ok(text.includes('tag      : -'))
        assert.ok(text.includes('attrs    : 0'))
        assert.ok(text.includes('children : 0'))
        assert.ok(!text.includes('undefined'))
        assert.ok(!text.includes('null'))
    })

    test('bagian tanpa baris atau judul dilewati dan masukan tidak valid aman', () => {
        assert.equal(formatInfoBlock(null), '')
        assert.equal(formatInfoBlock([{ title: 'kosong', rows: [] }, { title: '', rows: [['a', 1]] }]), '')

        const text = formatInfoBlock([{ title: 'satu', rows: [['k', 'v']] }])
        assert.equal(text, '`[ SATU ]`\nk : v')
    })
})
