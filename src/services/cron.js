const FIELD_RANGES = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12 },
    { min: 0, max: 6 }
]

const WEEKDAY_NAMES = new Map([
    ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6]
])

const MONTH_NAMES = new Map([
    ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
    ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12]
])

const WEEKDAY_PARTS = new Map([
    ['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]
])

const MINUTE_MS = 60_000
const SEARCH_LIMIT_MS = 400 * 24 * 60 * MINUTE_MS

const formatters = new Map()

function getFormatter(timeZone) {
    let formatter = formatters.get(timeZone)
    if (formatter === undefined) {
        try {
            formatter = new Intl.DateTimeFormat('en-GB', {
                timeZone,
                hour: '2-digit',
                minute: '2-digit',
                weekday: 'short',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour12: false
            })
        } catch {
            formatter = null
        }
        formatters.set(timeZone, formatter)
    }
    return formatter
}

function normalizeName(value) {
    const text = String(value || '').trim().toLowerCase()
    if (WEEKDAY_NAMES.has(text)) return { kind: 'weekday', value: WEEKDAY_NAMES.get(text) }
    if (MONTH_NAMES.has(text)) return { kind: 'month', value: MONTH_NAMES.get(text) }
    return { kind: 'unknown', value: text }
}

function expandRange(start, end, step) {
    const values = []
    const stride = step && Number.isFinite(step) && step > 0 ? Math.floor(step) : 1
    for (let value = start; value <= end; value += stride) values.push(value)
    return values
}

function parseField(field, index) {
    const text = String(field || '').trim()
    if (!text) throw new TypeError(`Kolom cron ke-${index + 1} kosong`)

    const { min, max } = FIELD_RANGES[index]
    const wildcard = text === '*'

    if (wildcard) {
        return { set: new Set(expandRange(min, max, 1)), wildcard: true }
    }

    const parts = text.split('/')
    if (parts.length > 2) throw new TypeError(`Kolom cron ke-${index + 1} tidak valid: ${text}`)

    const rangeText = parts[0]
    const step = parts.length === 2 ? Number(parts[1]) : NaN
    if (parts.length === 2 && (!Number.isFinite(step) || step <= 0)) {
        throw new TypeError(`Langkah cron ke-${index + 1} tidak valid: ${text}`)
    }

    const values = []

    if (rangeText === '*') {
        if (parts.length !== 2) throw new TypeError(`Kolom cron ke-${index + 1} tidak valid: ${text}`)
        values.push(...expandRange(min, max, step))
    } else if (rangeText.includes('-')) {
        const [startText, endText] = rangeText.split('-')
        let start = Number(startText)
        let end = Number(endText)

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            const startNamed = normalizeName(startText)
            const endNamed = normalizeName(endText)
            if (index === 4 && startNamed.kind === 'weekday' && endNamed.kind === 'weekday') {
                start = startNamed.value
                end = endNamed.value
            } else if (index === 3 && startNamed.kind === 'month' && endNamed.kind === 'month') {
                start = startNamed.value
                end = endNamed.value
            }
        }

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            throw new TypeError(`Rentang cron ke-${index + 1} tidak valid: ${text}`)
        }
        if (start < min || end > max || start > end) {
            throw new TypeError(`Rentang cron ke-${index + 1} di luar batas: ${text}`)
        }

        values.push(...expandRange(start, end, parts.length === 2 ? step : 1))
    } else {
        for (const piece of rangeText.split(',')) {
            const trimmed = piece.trim()
            let value = Number(trimmed)
            if (!Number.isFinite(value)) {
                const named = normalizeName(trimmed)
                if (index === 4 && named.kind === 'weekday') value = named.value
                else if (index === 3 && named.kind === 'month') value = named.value
            }
            if (!Number.isFinite(value)) throw new TypeError(`Nilai cron ke-${index + 1} tidak valid: ${trimmed}`)
            if (index === 4 && value === 7) value = 0
            if (value < min || value > max) throw new TypeError(`Nilai cron ke-${index + 1} di luar batas: ${trimmed}`)
            values.push(value)
        }
    }

    return { set: new Set(values), wildcard: false }
}

export function parseCronExpression(expression) {
    const text = String(expression || '').trim()
    const fields = text.split(/\s+/)

    if (fields.length !== 5) {
        throw new TypeError('Ekspresi cron harus 5 kolom: menit jam tanggal bulan hari-minggu')
    }

    return {
        minute: parseField(fields[0], 0),
        hour: parseField(fields[1], 1),
        dayOfMonth: parseField(fields[2], 2),
        month: parseField(fields[3], 3),
        dayOfWeek: parseField(fields[4], 4)
    }
}

export function validateCronExpression(expression) {
    try {
        parseCronExpression(expression)
        return true
    } catch {
        return false
    }
}

function matchesCron(parsed, parts) {
    if (!parsed.minute.set.has(parts.minute)) return false
    if (!parsed.hour.set.has(parts.hour)) return false
    if (!parsed.month.set.has(parts.month)) return false

    const dayOfMonthOk = parsed.dayOfMonth.set.has(parts.dayOfMonth)
    const dayOfWeekOk = parsed.dayOfWeek.set.has(parts.dayOfWeek)

    if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true
    if (parsed.dayOfMonth.wildcard) return dayOfWeekOk
    if (parsed.dayOfWeek.wildcard) return dayOfMonthOk
    return dayOfMonthOk || dayOfWeekOk
}

function extractParts(formatter, date) {
    const parts = {}
    for (const part of formatter.formatToParts(date)) {
        if (part.type === 'hour') parts.hour = Number(part.value)
        else if (part.type === 'minute') parts.minute = Number(part.value)
        else if (part.type === 'weekday') parts.dayOfWeek = WEEKDAY_PARTS.get(part.value) ?? -1
        else if (part.type === 'day') parts.dayOfMonth = Number(part.value)
        else if (part.type === 'month') parts.month = Number(part.value)
    }
    return parts
}

export function getNextCronRun(expression, fromMs = Date.now(), timeZone = 'Asia/Jakarta') {
    const parsed = parseCronExpression(expression)
    const formatter = getFormatter(timeZone)
    if (!formatter) throw new TypeError(`Zona waktu tidak valid: ${timeZone}`)

    const origin = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now()
    let ts = Math.floor(origin / MINUTE_MS) * MINUTE_MS + MINUTE_MS
    const limit = ts + SEARCH_LIMIT_MS

    while (ts <= limit) {
        const parts = extractParts(formatter, new Date(ts))
        if (parts.dayOfWeek !== -1 && matchesCron(parsed, parts)) return ts
        ts += MINUTE_MS
    }

    return null
}

export function isValidTimeZone(timeZone) {
    return !!getFormatter(timeZone)
}
