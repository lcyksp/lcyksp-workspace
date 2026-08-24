import net from 'net'
import tls from 'tls'
import { getDb } from '../config/db.js'
import { decrypt } from './crypto.js'

const DEFAULT_HOST = 'smtp.163.com'
const DEFAULT_PORT = 465
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
async function getConfig() {
  const rows = await dbAll("SELECT key,value FROM system_config WHERE key IN ('github_smtp_host','github_smtp_port','github_smtp_user','github_smtp_password','github_smtp_from')")
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { host: c.github_smtp_host || DEFAULT_HOST, port: Number(c.github_smtp_port || DEFAULT_PORT), user: c.github_smtp_user || '', password: c.github_smtp_password ? decrypt(c.github_smtp_password) : '', from: c.github_smtp_from || c.github_smtp_user || '' }
}
function safeAddress(value) { const text = String(value || ''); return text.replace(/^(.{2}).*(@.*)$/, '$1***$2') || '(empty)' }
function readResponse(socket) { return new Promise((resolve, reject) => { let buffer = ''; const onData = (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); const last = lines.filter(Boolean).at(-1) || ''; if (/^\d{3} /.test(last)) { socket.off('data', onData); resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() }) } }; socket.on('data', onData); socket.once('error', reject) }) }
async function command(socket, value, expected = []) { socket.write(`${value}\r\n`); const r = await readResponse(socket); if (expected.length && !expected.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text}`); return r }
function dotStuff(value) { return value.split(/\r?\n/).map((line) => line.startsWith('.') ? `.${line}` : line).join('\r\n') }

export async function sendGithubTestEmail(to) { return sendSmtpMessage({ to, subject: 'GitHub 项目订阅测试邮件', body: '这是一封测试邮件，用于确认您的邮箱可以正常接收 GitHub 项目订阅推送，无需回复。\n\n如果您没有主动申请 GitHub 日报订阅，请忽略此邮件。' }) }
export async function sendGithubDigestEmail(to, subject, html) { return sendSmtpMessage({ to, subject, body: html, contentType: 'text/html' }) }
export async function smtpConfigured() { const c = await getConfig(); return Boolean(c.user && c.password) }
export async function getGithubMailConfig() { return getConfig() }

async function sendSmtpMessage({ to, subject, body, contentType = 'text/plain' }) {
  const c = await getConfig(); if (!c.user || !c.password) throw new Error('尚未配置 163 邮箱 SMTP 授权码')
  const secure = c.port === 465
  console.log(`[GitHub Mail] begin host=${c.host} port=${c.port} user=${safeAddress(c.user)} to=${safeAddress(to)}`)
  const socket = secure ? tls.connect({ host: c.host, port: c.port, servername: c.host }) : net.createConnection({ host: c.host, port: c.port })
  socket.setTimeout(30000); let stage = 'connect'
  try {
    await readResponse(socket); stage = 'ehlo'; await command(socket, 'EHLO lcyksp.xyz', [220, 250])
    let s = socket
    if (!secure) { stage = 'starttls'; await command(socket, 'STARTTLS', [220]); stage = 'tls'; s = await new Promise((resolve, reject) => { const upgraded = tls.connect({ socket, host: c.host, servername: c.host }, () => resolve(upgraded)); upgraded.once('error', reject) }); await command(s, 'EHLO lcyksp.xyz', [250]) }
    stage = 'auth'; await command(s, 'AUTH LOGIN', [334]); await command(s, Buffer.from(c.user).toString('base64'), [334]); await command(s, Buffer.from(c.password).toString('base64'), [235])
    stage = 'mail'; await command(s, `MAIL FROM:<${c.user}>`, [250]); await command(s, `RCPT TO:<${to}>`, [250, 251]); await command(s, 'DATA', [354])
    const message = [`From: ${c.from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0', `Content-Type: ${contentType}; charset=UTF-8`, 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n')
    s.write(`${dotStuff(message)}\r\n.\r\n`); const delivered = await readResponse(s); if (delivered.code < 200 || delivered.code >= 400) throw new Error(`SMTP ${delivered.code}: ${delivered.text}`)
    console.log(`[GitHub Mail] sent host=${c.host} to=${safeAddress(to)} code=${delivered.code}`); await command(s, 'QUIT', [221]); s.end()
  } catch (error) { console.error(`[GitHub Mail] failed stage=${stage} host=${c.host} port=${c.port} user=${safeAddress(c.user)} message=${String(error?.message || 'unknown').slice(0, 240)}`); throw error } finally { socket.destroy() }
}
