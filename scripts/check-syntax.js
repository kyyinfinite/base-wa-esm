import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const files = []
function walk(p) {
    const st = fs.statSync(p)
    if (st.isDirectory()) {
        for (const item of fs.readdirSync(p)) {
            if (item === 'node_modules' || item === '.run-tmp' || item === 'session') continue
            walk(path.join(p, item))
        }
    } else if (p.endsWith('.js')) {
        files.push(p)
    }
}
walk(ROOT)

let failed = 0
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
        failed += 1
        console.error(`Gagal sintaks: ${path.relative(ROOT, file)}`)
        console.error(String(error.stderr || error.message).slice(0, 500))
    }
}

if (failed) process.exit(1)
console.log(`OK: ${files.length} file lolos node --check.`)
