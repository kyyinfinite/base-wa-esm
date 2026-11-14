import { createOutbound } from './queue.js'
import { getActiveSocket } from '../app/transport.js'

let boundSocket = null

export function bindOutboundSocket(sock) {
    boundSocket = sock || null
}

const resolveSocket = () => boundSocket ?? getActiveSocket()

export const outbound = createOutbound(resolveSocket)

export function getOutboundStats() {
    return outbound.stats()
}

export { createOutbound } from './queue.js'
export default outbound
