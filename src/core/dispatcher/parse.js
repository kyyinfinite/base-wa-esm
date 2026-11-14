export function parseCommand(m, prefixes) {
    const text = String(m?.text || '')
    if (!text.trim()) return null

    const body = text.replace(/^\s+/, '')
    const prefix = prefixes.find(p => body.startsWith(p))

    if (prefix !== undefined) {
        const after = body.slice(prefix.length).trim()
        if (!after) return null

        const parts = after.split(/\s+/)
        const command = parts.shift().toLowerCase()
        const rawText = after.slice(command.length).trim()
        return { prefix, command, args: parts, text: parts.join(' '), rawText }
    }

    const trimmed = text.trim()
    if (/\s/.test(trimmed)) return null

    return { prefix: '', command: trimmed.toLowerCase(), args: [], text: '', rawText: '' }
}

export function parseButtonResponse(m, prefixes) {
    let body = String(m?.text || '')
    if (!body.trim()) return null

    body = body.replace(/^\s+/, '')

    let prefix = ''
    for (const p of prefixes) {
        if (body.startsWith(p)) {
            prefix = p
            body = body.slice(p.length)
            break
        }
    }

    const trimmed = body.trim()
    if (!trimmed) return null

    const parts = trimmed.split(/\s+/).filter(Boolean)
    const command = parts.shift().toLowerCase()
    if (!command) return null

    const rawText = trimmed.slice(command.length).trim()
    return { prefix, command, args: parts, text: parts.join(' '), rawText }
}

export function matchPatternPlugin(m, patternPlugins) {
    const text = m.text || ''
    if (!text) return null

    let looseMatch = null

    for (const handler of patternPlugins) {
        const { customPrefix } = handler
        if (!customPrefix) continue

        const anchored = customPrefix.source.startsWith('^')
        customPrefix.lastIndex = 0
        if (!customPrefix.test(text)) continue

        if (anchored) return handler
        if (!looseMatch) looseMatch = handler
    }

    return looseMatch
}
