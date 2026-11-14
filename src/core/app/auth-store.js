import path from 'path'
import { fileURLToPath } from 'url'
import { useMultiFileAuthState } from '@whiskeysockets/baileys'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const AUTH_DIR = path.join(PROJECT_ROOT, 'session')

export const defaultAuthStore = {
    load: () => useMultiFileAuthState(AUTH_DIR)
}

export default defaultAuthStore
