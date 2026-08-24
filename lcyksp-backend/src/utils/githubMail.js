import net from 'net'
import tls from 'tls'
import { getDb } from '../config/db.js'
import { decrypt } from './crypto.js'

const DEFAULT_HOST = process.env.GITHUB_SMTP_HOST || 'smtp-mail.outlook.com'
const DEFAULT_PORT = Number(process.env.GITHUB_SMTP_PORT || 587)

function dbGet(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
}

export async function getGithubMailConfig() {
  const rows = await new Promise((resolve, reject) => {
    getDb().all(
      "SELECT key, value FROM system_config WHERE key IN ('github_smtp_host', 'github_smtp_port', 'github_smtp_user', 'github_smtp_password', 'github_smtp_from')",
      (err, result) => (err ? reject(err) : resolve(result || [])),
    )
  })
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  const encryptedPassword = config.github_smtp_password || ''
  return {
    host: config.github_smtp_host || DEFAULT_HOST,
    port: Number(config.github_smtp_port || DEFAULT_PORT),
    user: config.github_smtp_user || process.env.GITHUB_SMTP_USER || '',
    password: encryptedPassword ? decrypt(encryptedPassword) : (process.env.GITHUB_SMTP_PASSWORD || ''),
    from: config.github_smtp_from || process.env.GITHUB_SMTP_FROM || config.github_smtp_user || process.env.GITHUB_SMTP_USER || '',
  }
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      const last = lines.filter(Boolean).at(-1) || ''
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData)
        resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() })
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

async function command(socket, value, expected = []) {
  socket.write(`${value}\r\n`)
  const response = await readResponse(socket)
  if (expected.length && !expected.includes(response.code)) {
    throw new Error(`SMTP ${response.code}: ${response.text}`)
  }
  return response
}

function dotStuff(value) {
  return value.split(/\r?\n/).map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n')
}

async function sendSmtpMessage({ to, subject, body, contentType = 'text/plain' }) {
  const config = await getGithubMailConfig()
  const safeTo = String(to || '').replace(/^(.{2}).*(@.*)$/, '$1***$2')
  console.log(`[GitHub Mail] begin host=${config.host} port=${config.port} user=${safeToAddress(config.user)} to=${safeTo}`)
  if (!config.password) throw new Error('尚未配置 Outlook SMTP 密码')
  const socket = net.createConnection({ host: config.host, port: config.port })
  socket.setTimeout(30000)
  let stage = 'connect'
  try {
    await readResponse(socket)
    stage = 'ehlo'
    await command(socket, `EHLO lcyksp.xyz`, [220, 250])
    stage = 'starttls'
    await command(socket, 'STARTTLS', [220])
    stage = 'tls'
    const secureSocket = await new Promise((resolve, reject) => {
      const upgraded = tls.connect({ socket, host: config.host, servername: config.host }, () => resolve(upgraded))
      upgraded.once('error', reject)
    })
    stage = 'ehlo-tls'
    await command(secureSocket, 'EHLO lcyksp.xyz', [250])
    stage = 'auth-init'
    await command(secureSocket, 'AUTH LOGIN', [334])
    stage = 'auth-user'
    await command(secureSocket, Buffer.from(config.user).toString('base64'), [334])
    stage = 'auth-password'
    await command(secureSocket, Buffer.from(config.password).toString('base64'), [235])
    stage = 'mail-from'
    await command(secureSocket, `MAIL FROM:<${config.user}>`, [250])
    stage = 'rcpt-to'
    await command(secureSocket, `RCPT TO:<${to}>`, [250, 251])
    stage = 'data'
    await command(secureSocket, 'DATA', [354])
    const message = [
      `From: ${config.from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: ${contentType}; charset=UTF-8`,
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n')
    secureSocket.write(`${dotStuff(message)}\r\n.\r\n`)
    const deliveryResponse = await readResponse(secureSocket)
    if (deliveryResponse.code < 200 || deliveryResponse.code >= 400) throw new Error(`SMTP ${deliveryResponse.code}: ${deliveryResponse.text}`)
    console.log(`[GitHub Mail] sent host=${config.host} to=${safeTo} code=${deliveryResponse.code}`)
    stage = 'quit'
    await command(secureSocket, 'QUIT', [221])
    secureSocket.end()
  } catch (error) {
    console.error(`[GitHub Mail] failed stage=${stage} host=${config.host} port=${config.port} user=${safeToAddress(config.user)} code=${error?.message?.match(/SMTP (\d{3})/)?.[1] || 'n/a'} message=${String(error?.message || 'unknown').slice(0, 240)}`)
    throw error
  } finally {
    socket.destroy()
  }
}

function safeToAddress(value) {
  const text = String(value || '')
  return text.replace(/^(.{2}).*(@.*)$/, '$1***$2') || '(empty)'
}

export async function sendGithubTestEmail(to) {
  return sendSmtpMessage({
    to,
    subject: 'GitHub 项目订阅测试邮件',
    body: [
      '这是一封测试邮件，用于确认您的邮箱可以正常接收 GitHub 项目订阅推送，无需回复。',
      '',
      '如果您已经收到此邮件，请返回网站开启订阅。',
      '如果暂未收到，请检查垃圾邮件目录，稍后重试，或联系客服。',
    ].join('\n'),
  })
}

export async function sendGithubDigestEmail(to, subject, html) {
  return sendSmtpMessage({ to, subject, body: html, contentType: 'text/html' })
}

export async function smtpConfigured() {
  const config = await getGithubMailConfig()
  const row = await dbGet("SELECT value FROM system_config WHERE key = 'github_smtp_password'")
  return Boolean(config.password || row?.value)
}
