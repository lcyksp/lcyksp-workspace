import { getDb } from '../config/db.js'
import { decrypt, encrypt } from './crypto.js'

const DEVICE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const SCOPE = 'https://graph.microsoft.com/Mail.Send offline_access openid profile'

function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ changes: this.changes }) })) }
function safeAddress(value) { const text = String(value || ''); return text.replace(/^(.{2}).*(@.*)$/, '$1***$2') || '(empty)' }

async function loadConfig() {
  const rows = await dbAll("SELECT key, value FROM system_config WHERE key IN ('github_graph_client_id','github_graph_refresh_token','github_graph_user')")
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  return {
    clientId: config.github_graph_client_id || process.env.GITHUB_GRAPH_CLIENT_ID || '',
    refreshToken: config.github_graph_refresh_token ? decrypt(config.github_graph_refresh_token) : (process.env.GITHUB_GRAPH_REFRESH_TOKEN || ''),
    user: config.github_graph_user || process.env.GITHUB_GRAPH_USER || '',
  }
}

async function postToken(body) {
  const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  return { response, data: await response.json() }
}

export async function startGraphDeviceLogin(clientId) {
  const id = String(clientId || '').trim()
  if (!/^[0-9a-f-]{20,}$/i.test(id)) throw new Error('请输入有效的 Azure 应用程序(客户端) ID')
  const response = await fetch(DEVICE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, scope: SCOPE }) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error_description || data.error || '无法启动 Microsoft 授权')
  return data
}

export async function finishGraphDeviceLogin({ clientId, deviceCode }) {
  const { response, data } = await postToken({ client_id: String(clientId || '').trim(), device_code: String(deviceCode || '').trim(), grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
  if (!response.ok) return { pending: ['authorization_pending', 'slow_down'].includes(data.error), message: data.error_description || data.error }
  const claims = data.id_token ? JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8')) : {}
  return { pending: false, refreshToken: data.refresh_token, user: claims.preferred_username || claims.email || '' }
}

async function accessToken(config) {
  const { response, data } = await postToken({ client_id: config.clientId, grant_type: 'refresh_token', refresh_token: config.refreshToken, scope: SCOPE })
  if (!response.ok) throw new Error('Microsoft 授权已失效：' + (data.error_description || data.error || 'unknown'))
  if (data.refresh_token) await dbRun("INSERT OR REPLACE INTO system_config (key,value) VALUES ('github_graph_refresh_token',?)", [encrypt(data.refresh_token)])
  return data.access_token
}

async function sendMail({ to, subject, body, contentType }) {
  const config = await loadConfig()
  if (!config.clientId || !config.refreshToken || !config.user) throw new Error('请先在管理员后台完成 Microsoft Graph 邮件授权')
  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await accessToken(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: contentType === 'text/html' ? 'HTML' : 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
  })
  if (!response.ok) throw new Error('Graph 发信失败 HTTP ' + response.status + ': ' + (await response.text()).slice(0, 300))
  console.log(`[GitHub Mail] Graph sent from=${safeAddress(config.user)} to=${safeAddress(to)}`)
}

export async function sendGithubTestEmail(to) {
  return sendMail({ to, subject: 'GitHub 项目订阅测试邮件', body: '这是一封测试邮件，用于确认您的邮箱可以正常接收 GitHub 项目订阅推送，无需回复。\n\n如果暂未收到，请检查垃圾邮件目录，稍后重试，或联系客服。', contentType: 'text/plain' })
}
export async function sendGithubDigestEmail(to, subject, html) { return sendMail({ to, subject, body: html, contentType: 'text/html' }) }
export async function smtpConfigured() { const c = await loadConfig(); return Boolean(c.clientId && c.refreshToken && c.user) }
