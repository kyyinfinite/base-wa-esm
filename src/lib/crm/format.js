const EMPTY = '-'

const toText = value => {
    if (value === null || value === undefined) return EMPTY
    const text = String(value).trim()
    return text || EMPTY
}

export function formatInfoBlock(sections, { markup = true } = {}) {
    const visible = (Array.isArray(sections) ? sections : [])
        .map(section => ({ title: String(section?.title || '').toUpperCase(), rows: Array.isArray(section?.rows) ? section.rows : [] }))
        .filter(section => section.title && section.rows.length)

    const width = Math.max(0, ...visible.flatMap(section => section.rows.map(([key]) => String(key).length)))

    return visible
        .map(({ title, rows }) => {
            const header = markup ? `\`[ ${title} ]\`` : `[ ${title} ]`
            const lines = rows.map(([key, value]) => `${String(key).padEnd(width)} : ${toText(value)}`)
            return [header, ...lines].join('\n')
        })
        .join('\n\n')
}

export function buildMessageInfoSections({ type, source, id, sender, chat, nodeChat, tag, nodeId, attrs, children } = {}) {
    return [
        { title: 'message', rows: [['type', type], ['source', source], ['id', id], ['sender', sender]] },
        { title: 'chat', rows: [['chat', chat], ['nodeChat', nodeChat]] },
        { title: 'node', rows: [['tag', tag], ['nodeId', nodeId], ['attrs', attrs], ['children', children]] }
    ]
}

export default { formatInfoBlock, buildMessageInfoSections }
