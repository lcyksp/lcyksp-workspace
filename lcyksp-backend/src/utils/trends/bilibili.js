import { createHash } from 'crypto'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
}

const REORDER_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let wbiKeys = null
let wbiKeysTs = 0

async function getWbiKeys() {
  if (wbiKeys && Date.now() - wbiKeysTs < 30 * 60 * 1000) return wbiKeys
  try {
    const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: HEADERS })
    if (!resp.ok) return null
    const data = await resp.json()
    const imgUrl = data?.data?.wbi_img?.img_url || ''
    const subUrl = data?.data?.wbi_img?.sub_url || ''
    if (!imgUrl || !subUrl) return null
    const imgKey = imgUrl.split('/').pop().split('.')[0]
    const subKey = subUrl.split('/').pop().split('.')[0]
    wbiKeys = { imgKey, subKey }
    wbiKeysTs = Date.now()
    return wbiKeys
  } catch { return null }
}

function getMixinKey(orig) {
  return REORDER_TABLE.map(n => orig[n]).join('').slice(0, 32)
}

function encWbi(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000)
  params.wts = wts
  const sorted = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
  const wRid = createHash('md5').update(sorted + mixinKey).digest('hex')
  return `${sorted}&w_rid=${wRid}`
}

export async function fetchBilibiliHot() {
  try {
    const resp = await fetch('https://api.bilibili.com/x/web-interface/wbi/search/square?limit=50', {
      headers: HEADERS,
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const trending = data?.data?.trending?.list || []
    return trending.map((item, idx) => ({
      platform: 'bilibili',
      keyword: item.keyword || item.show_name || '',
      rank: idx + 1,
      score: item.heat_score || item.hot_id || 0,
      icon: item.icon || '',
    })).filter(item => item.keyword)
  } catch (err) {
    console.error('[Bilibili] hot search error:', err.message)
    return []
  }
}

export async function fetchBilibiliSearchCount(keyword) {
  try {
    console.log(`[Bilibili] calling WBI search API for keyword: '${keyword}'...`)
    const keys = await getWbiKeys()
    if (!keys) {
      console.error('[Bilibili] WBI keys not available')
      return { platform: 'bilibili', keyword, count: 0, rank: 0 }
    }

    console.log('[Bilibili] WBI keys:', keys.imgKey?.slice(0, 8), keys.subKey?.slice(0, 8))
    const mixinKey = getMixinKey(keys.imgKey + keys.subKey)
    console.log('[Bilibili] mixinKey:', mixinKey?.slice(0, 8))
    
    const params = { keyword, search_type: 'video' }
    const query = encWbi(params, mixinKey)

    console.log('[Bilibili] searching:', keyword)
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/all/v2?${query}`, {
      headers: HEADERS,
    })
    const text = await resp.text()
    console.log('[Bilibili] raw response:', text.slice(0, 300))
    
    const data = JSON.parse(text)
    console.log('[Bilibili] search response code:', data.code, 'numResults:', data?.data?.numResults)
    
    if (data.code !== 0) {
      console.error('[Bilibili] search API error:', data.message)
      wbiKeys = null // Clear cache on error to refresh keys next time
      return { platform: 'bilibili', keyword, count: 0, rank: 0 }
    }
    
    const count = data?.data?.numResults || data?.data?.pageinfo?.all?.numResults || 0
    if (count === 0 && !data?.data?.numResults) {
      // If we got 0 count and numResults is undefined, it might be sign error or block. Reset keys.
      console.warn('[Bilibili] Search count is 0 and numResults is undefined, resetting wbiKeys')
      wbiKeys = null
    }
    return { platform: 'bilibili', keyword, count, rank: 0 }
  } catch (err) {
    console.error('[Bilibili] search error:', err.message)
    wbiKeys = null // Clear cache on catch
    return { platform: 'bilibili', keyword, count: 0, rank: 0 }
  }
}

export async function fetchBilibiliHotBgm() {
  try {
    const resp = await fetch('https://api.bilibili.com/x/web-interface/wbi/search/square?limit=20', {
      headers: HEADERS,
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const trending = data?.data?.trending?.list || []
    return trending.slice(0, 20).map((item, idx) => ({
      platform: 'bilibili',
      name: item.keyword || '',
      usageCount: item.heat_score || 0,
      rank: idx + 1,
    })).filter(item => item.name)
  } catch {
    return []
  }
}
