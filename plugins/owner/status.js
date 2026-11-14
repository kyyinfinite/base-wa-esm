import { formatDiagnosticReport } from '../../src/services/health.js'
import { getMetricsSummary } from '../../src/services/metrics.js'

const renderTopCommands = summary => {
    if (!summary.topCommands.length) return 'Belum ada command yang tercatat.'
    return summary.topCommands
        .slice(0, 5)
        .map(item => `*${item.command}* — ${item.count}x, error ${item.errors}, timeout ${item.timeouts}, rata-rata ${item.avgMs}ms, p95 ${item.p95Ms}ms`)
        .join('\n')
}

let handler = async (m, { notifReply }) => {
    const summary = getMetricsSummary()
    const report = formatDiagnosticReport({ logLimit: 5 })

    await notifReply(`\`\`\`\n${report}\n\`\`\`\n\n*Top Command*\n${renderTopCommands(summary)}`, 'Bot Status')
}

handler.command = ['status']
handler.help = ['status']
handler.tags = ['owner']
handler.description = 'Menampilkan status runtime bot dan metrik command'
handler.owner = true

export default handler
