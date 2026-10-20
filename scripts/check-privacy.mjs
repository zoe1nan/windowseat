#!/usr/bin/env node
// 公开仓库隐私守卫：扫描 git 跟踪文件里的个人路径 / 用户名 / 联系方式 / 令牌。
// 用法：node scripts/check-privacy.mjs
// 退出码：0 = 干净；1 = 发现问题（CI 会失败）。
//
// 注意：本文件自身会出现在公开仓库里，因此签名字符串用拼接方式构造，
// 避免守卫脚本本身成为敏感词命中项。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const u = 'User' + 's'
const localProject = 'dshoffice' + 'F'
const dshDist = 'dshar' + 'ness'
const personalHandles = ['zo' + 'e1nan', 'Mr' + 'Nan']

const PATTERNS = [
  {
    name: 'Windows 用户目录',
    re: new RegExp(`[A-Za-z]:[\\\\/]+${u}[\\\\/]+(?!demo\\b|Public\\b|Default\\b|<)[A-Za-z0-9._-]+`, 'gi'),
  },
  {
    name: '已知本机路径',
    re: new RegExp(`[A-Za-z]:[\\\\/]+(?:${localProject}|${dshDist})(?:[\\\\/]|$)`, 'gi'),
  },
  { name: 'QQ/163 邮箱', re: /[A-Za-z0-9._%+-]+@(?:qq\.com|163\.com|126\.com)/gi },
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  {
    name: '个人 GitHub 账号',
    re: new RegExp(`github\\.com/(?:${personalHandles.join('|')})\\b`, 'gi'),
  },
  { name: 'API Key / Token', re: /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g },
]

const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  // 二进制与生成物不做文本扫描
  .filter((f) => !/\.(png|jpe?g|gif|webp|mp4|mov|webm|ico|woff2?|ttf|zip)$/i.test(f))

let hits = 0
for (const file of files) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0
      const m = re.exec(lines[i])
      if (!m) continue
      console.log(`${file}:${i + 1} [${name}] ${lines[i].trim().slice(0, 160)}`)
      hits += 1
    }
  }
}

if (hits > 0) {
  console.error(`\n✗ 发现 ${hits} 处可能的隐私/凭据，公开前必须处理。`)
  process.exit(1)
}
console.log(`✓ 隐私检查通过（${files.length} 个文本文件）`)
