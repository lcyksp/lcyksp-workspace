// 考点判分「语义复核」出口配置（服务端运行）。
//
// 与 GitHub 日报的 LLM 配置**完全分开**：写在 system_config 的 kaodian_llm_* 命名空间，
// key 用 utils/crypto.js 加密（与站点其它密钥同一套 AES-256-CBC），不会互相覆盖。
//
// 用法（在 lcyksp-backend 目录下）：
//   node scripts/kaodian-llm-config.mjs show
//   node scripts/kaodian-llm-config.mjs set offpeak https://api.deepseek.com deepseek-v4-flash sk-xxxxxxxx
//   node scripts/kaodian-llm-config.mjs set peak    https://api.mimo.mi.com/v1 mimo-v2.6-flash sk-yyyyyyyy
//   node scripts/kaodian-llm-config.mjs mode auto            # auto | offpeak | peak | off
//   node scripts/kaodian-llm-config.mjs limits 1500 150      # 全站日上限 / 单用户日上限
//   node scripts/kaodian-llm-config.mjs maxout 700           # 每次调用的输出 token 上限
//   node scripts/kaodian-llm-config.mjs clear offpeak|peak   # 清掉某一档
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import { encrypt, decrypt } from '../src/utils/crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_DIR = process.env.LCYKSP_DB_DIR
  ? path.resolve(process.env.LCYKSP_DB_DIR)
  : path.resolve(__dirname, '../data/db')
const DB_PATH = path.join(DB_DIR, 'database.db')
if (!fs.existsSync(DB_PATH)) {
  console.error('找不到数据库:', DB_PATH, '（先确认在 lcyksp-backend 目录下运行）')
  process.exit(1)
}

const NS = 'kaodian_llm_'
const db = await new Promise((res, rej) => { const d = new sqlite3.Database(DB_PATH, (e) => (e ? rej(e) : res(d))) })
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this) }))
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))))
const set = (k, v) => run('INSERT INTO system_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [NS + k, v])
const del = (k) => run('DELETE FROM system_config WHERE key=?', [NS + k])
const mask = (s) => (s ? String(s).slice(0, 6) + '…' + String(s).slice(-4) : '')

const [cmd, ...args] = process.argv.slice(2)

async function show() {
  const rows = await all(`SELECT key, value FROM system_config WHERE key LIKE '${NS}%' ORDER BY key`)
  const m = Object.fromEntries(rows.map((r) => [r.key.slice(NS.length), r.value]))
  const line = (k) => {
    let v = m[k] ?? '(未设置)'
    if (k.endsWith('_key') && m[k]) v = mask(decrypt(m[k])) || '(解密失败)'
    return `  ${k.padEnd(20)} ${v}`
  }
  console.log('当前考点判分语义复核配置：')
  for (const k of ['mode', 'offpeak_url', 'offpeak_model', 'offpeak_key', 'peak_url', 'peak_model', 'peak_key',
    'daily_limit', 'user_daily_limit', 'max_tokens', 'timeout_ms', 'proxy_url']) {
    console.log(line(k))
  }
  console.log('\n提示：offpeak/peak 三件套齐全才会启用该档；两档都没配 = 只跑算法（零成本）。')
}

if (cmd === 'show') {
  await show()
} else if (cmd === 'set') {
  const [slot, url, model, key] = args
  if (!['offpeak', 'peak'].includes(slot) || !url || !model || !key) {
    console.error('用法: set <offpeak|peak> <url> <model> <key>')
    process.exit(1)
  }
  await set(`${slot}_url`, url)
  await set(`${slot}_model`, model)
  await set(`${slot}_key`, encrypt(key))
  console.log(`已配置 ${slot}：${url} / ${model} / ${mask(key)}`)
  await show()
} else if (cmd === 'mode') {
  const v = args[0]
  if (!['auto', 'offpeak', 'peak', 'off'].includes(v)) {
    console.error('用法: mode <auto|offpeak|peak|off>')
    process.exit(1)
  }
  await set('mode', v)
  console.log('mode =', v)
} else if (cmd === 'limits') {
  const [daily, userDaily] = args
  if (!daily || !userDaily) { console.error('用法: limits <全站日上限> <单用户日上限>'); process.exit(1) }
  await set('daily_limit', String(Number(daily) || 0))
  await set('user_daily_limit', String(Number(userDaily) || 0))
  console.log(`limits: 全站 ${daily}/天，单用户 ${userDaily}/天`)
} else if (cmd === 'maxout') {
  const v = Number(args[0])
  if (!v) { console.error('用法: maxout <输出token上限>'); process.exit(1) }
  await set('max_tokens', String(v))
  console.log('max_tokens =', v)
} else if (cmd === 'proxy') {
  await set('proxy_url', String(args[0] || ''))
  console.log('proxy_url =', args[0] || '(空 = 直连)')
} else if (cmd === 'clear') {
  const slot = args[0]
  if (!['offpeak', 'peak'].includes(slot)) { console.error('用法: clear <offpeak|peak>'); process.exit(1) }
  for (const k of ['url', 'model', 'key']) await del(`${slot}_${k}`)
  console.log(`已清掉 ${slot} 档配置`)
  await show()
} else {
  console.log(`考点判分语义复核配置工具

  show                                      查看当前配置
  set <offpeak|peak> <url> <model> <key>    配置某一档的出口
  mode <auto|offpeak|peak|off>              切换策略（默认 auto：空闲用 offpeak，高峰用 peak）
  limits <全站日上限> <单用户日上限>           配额
  maxout <输出token上限>                     单次输出上限（默认 700）
  proxy <url>                               指定代理；留空 = 直连
  clear <offpeak|peak>                      清空某一档
`)
}

await new Promise((r) => db.close(r))
