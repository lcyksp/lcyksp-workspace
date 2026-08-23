import { generateABogus } from '../douyin-a-bogus.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../../data')
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function loadDouyinCookies() {
  const paths = [
    path.join(DATA_DIR, 'cookies.douyin.txt'),
    path.join(DATA_DIR, 'cookies.txt'),
  ]
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue
      const content = fs.readFileSync(p, 'utf-8')
      return content
        .split(/\r?\n/)
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split('\t'))
        .filter(parts => parts.length >= 7)
        .map(parts => `${parts[5]}=${parts.slice(6).join('\t')}`)
        .join('; ')
    } catch { /* continue */ }
  }
  return ''
}

function buildHotParams() {
  return new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '290100',
    version_name: '29.1.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '130.0.0.0',
    browser_online: 'true',
    platform: 'PC',
  })
}

export async function fetchDouyinHot() {
  try {
    const cookieHeader = loadDouyinCookies()
    const params = buildHotParams()
    const query = params.toString()
    const aBogus = generateABogus(query, DEFAULT_UA)
    const endpoint = `https://www.douyin.com/aweme/v1/web/hot/search/list/?${query}&a_bogus=${encodeURIComponent(aBogus)}`

    const resp = await fetch(endpoint, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.douyin.com/',
        'Origin': 'https://www.douyin.com',
        'Accept': 'application/json, text/plain, */*',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    })

    if (!resp.ok) return []
    const data = await resp.json()
    const wordList = data?.data?.word_list || data?.word_list || []
    return wordList.map((item, idx) => ({
      platform: 'douyin',
      keyword: item.word || '',
      rank: idx + 1,
      score: item.hot_value || item.word_type || 0,
      icon: item.icon?.url_list?.[0] || '',
    })).filter(item => item.keyword)
  } catch (err) {
    console.error('[Douyin] hot search error:', err.message)
    return []
  }
}

export async function fetchDouyinSearchCount(keyword) {
  try {
    console.log(`[Douyin] calling search API for keyword: '${keyword}'...`)
    const cookieHeader = loadDouyinCookies()
    const params = new URLSearchParams({
      keyword,
      search_channel: 'aweme_general',
      sort_type: '0',
      publish_time: '0',
      count: '1',
      offset: '0',
    })
    const query = params.toString()
    const aBogus = generateABogus(query, DEFAULT_UA)
    const endpoint = `https://www.douyin.com/aweme/v1/web/general/search/single/?${query}&a_bogus=${encodeURIComponent(aBogus)}`

    const resp = await fetch(endpoint, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.douyin.com/',
        'Accept': 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    })

    if (!resp.ok) return { platform: 'douyin', keyword, count: 0, rank: 0 }
    const data = await resp.json()
    return { platform: 'douyin', keyword, count: data?.data?.length || 0, rank: 0 }
  } catch (err) {
    console.error('[Douyin] search error:', err.message)
    return { platform: 'douyin', keyword, count: 0, rank: 0 }
  }
}
