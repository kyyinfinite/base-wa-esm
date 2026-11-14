import os from 'os'
import v8 from 'v8'
import { formatp, runtime } from '../../src/utils/myfunc.js'

let handler = async (m, { notifReply }) => {
    const mem = process.memoryUsage()
    const heapLimit = v8.getHeapStatistics().heap_size_limit
    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free
    const percent = ((used / total) * 100).toFixed(1)
    const heapPercent = ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1)

    const body = `
\`[ PROCESS ]\`
rss          : ${formatp(mem.rss)}
heapTotal    : ${formatp(mem.heapTotal)}
heapUsed     : ${formatp(mem.heapUsed)} (${heapPercent}%)
heapLimit    : ${formatp(heapLimit)}
external     : ${formatp(mem.external)}
arrayBuffers : ${formatp(mem.arrayBuffers)}

\`[ SYSTEM ]\`
total        : ${formatp(total)}
used         : ${formatp(used)} (${percent}%)
free         : ${formatp(free)}

\`[ RUNTIME ]\`
pid          : ${process.pid}
node         : ${process.version}
uptime       : ${runtime(process.uptime())}
`.trim()

    await notifReply(body, 'Memory Usage')
}

handler.command = ['mem', 'memory', 'ram']
handler.description = 'Lihat penggunaan memory bot dan sistem'

export default handler