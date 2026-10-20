// 开发期安装脚本（lead 用）：把 windowseat-bridge 装进 desktop profile 的依赖与 bundles。
// 用法：node scripts/dev-install.mjs [profileName]
// 注意：安装/重载 DSH 插件属于环境变更，团队内只由 lead 执行。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = process.argv[2] || 'desktop'
const repo = path.resolve(import.meta.dirname, '..')
const profileDir = path.join(os.homedir(), '.dsh', 'profiles', profile)
const pkgPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const dshBin = process.env.DSH_BIN || 'dsh'

if (!fs.existsSync(pkgPath)) {
  console.error('[install] profile not found:', profileDir)
  process.exit(1)
}

// 1) 依赖：dsh plugin add link:<repo>（转发给 pnpm）
const depName = 'windowseat-bridge'
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const deps = pkg.dependencies || (pkg.dependencies = {})
if (!deps[depName]) {
  console.log('[install] adding dependency link:', repo)
  execFileSync(dshBin, ['plugin', '--profile', profile, 'add', `link:${repo}`], {
    stdio: 'inherit',
    cwd: profileDir,
    shell: process.platform === 'win32',
  })
  const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (!after.dependencies?.[depName]) after.dependencies = { ...(after.dependencies || {}), [depName]: `link:${repo}` }
  fs.writeFileSync(pkgPath, JSON.stringify(after, null, 2) + '\n', 'utf8')
} else {
  console.log('[install] dependency exists:', deps[depName])
}

// 2) bundles 数组：追加条目（幂等）
const before = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const bundles = before.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('[install] dsh.profile.bundles missing in profile package.json')
  process.exit(1)
}
if (!bundles.includes(depName)) {
  bundles.push(depName)
  before.dsh.profile.bundles = bundles
  fs.writeFileSync(pkgPath, JSON.stringify(before, null, 2) + '\n', 'utf8')
  console.log('[install] bundles +=', depName)
} else {
  console.log('[install] bundles already contains', depName)
}

// 3) 触发 HMR 重载：往 profile cordis.patch.yml 追加注释行
fs.appendFileSync(patchPath, `\n# windowseat-bridge reload ${new Date().toISOString()}\n`, 'utf8')
console.log('[install] HMR reload requested; wait 4-6s then: curl -s http://127.0.0.1:34281/windowseat/health')
