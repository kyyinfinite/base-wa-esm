import { getSetting, setSetting } from '../../services/database/settings.js'
import { resetAllUserLimits } from '../../services/database/users.js'
import { getDailyLimit, getConfig } from '../../services/config.js'

const CHECK_INTERVAL_MS = 15 * 60 * 1000
const SETTINGS_KEY = 'limitReset'
const FALLBACK_TIMEZONE = 'Asia/Jakarta'

const formatters = new Map()

function getFormatter(timezone) {
    let formatter = formatters.get(timezone)
    if (formatter === undefined) {
        try {
            formatter = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            })
        } catch {
            formatter = null
        }
        formatters.set(timezone, formatter)
    }
    return formatter
}

export function resolveTimezone() {
    const timezone = String(getConfig().timezone || '').trim() || FALLBACK_TIMEZONE
    return getFormatter(timezone) ? timezone : FALLBACK_TIMEZONE
}

export function zoneDayKey(now = new Date(), timezone = resolveTimezone()) {
    const formatter = getFormatter(timezone) || getFormatter(FALLBACK_TIMEZONE)
    const date = now instanceof Date ? now : new Date(now)
    return formatter.format(date)
}

export function checkLimitReset(now = new Date()) {
    const today = zoneDayKey(now)
    const state = getSetting(SETTINGS_KEY) || {}
    if (state.lastResetDate === today) return { reset: false, day: today, count: 0 }

    const count = resetAllUserLimits(getDailyLimit())
    setSetting(SETTINGS_KEY, { lastResetDate: today })
    console.log(`[SCHEDULER] Daily limit reset applied to ${count} user(s).`)
    return { reset: true, day: today, count }
}

export function startLimitResetScheduler() {
    checkLimitReset()
    const interval = setInterval(() => checkLimitReset(), CHECK_INTERVAL_MS)
    interval.unref?.()
    return interval
}
