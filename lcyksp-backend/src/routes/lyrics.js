import { Router } from 'express'

const router = Router()

const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://music.163.com/',
  'Origin': 'https://music.163.com',
  'Accept': 'application/json, text/plain, */*',
}

router.get('/search', async (req, res, next) => {
  try {
    const keyword = String(req.query.s || '').trim()
    if (!keyword) {
      return res.json({ songs: [] })
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 30)
    const params = new URLSearchParams({
      s: keyword,
      type: '1',
      limit: String(limit),
      offset: '0',
    })

    const resp = await fetch(`https://music.163.com/api/search/get/web?${params.toString()}`, {
      headers: NETEASE_HEADERS,
    })

    if (!resp.ok) {
      return res.status(502).json({ error: '网易云 API 请求失败' })
    }

    const data = await resp.json()
    const songs = (data?.result?.songs || []).map(s => ({
      id: s.id,
      name: s.name,
      artists: (s.artists || []).map(a => a.name).join(' / '),
      album: s.album?.name || '',
      duration: s.duration || 0,
    }))

    res.json({ songs })
  } catch (err) {
    next(err)
  }
})

router.get('/lyric', async (req, res, next) => {
  try {
    const id = parseInt(req.query.id, 10)
    if (!id) {
      return res.status(400).json({ error: '请提供歌曲 ID' })
    }

    const resp = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1`, {
      headers: NETEASE_HEADERS,
    })

    if (!resp.ok) {
      return res.status(502).json({ error: '网易云 API 请求失败' })
    }

    const data = await resp.json()
    const lrc = data?.lrc?.lyric || ''
    const tlyric = data?.tlyric?.lyric || ''

    res.json({ lrc, tlyric })
  } catch (err) {
    next(err)
  }
})

router.get('/url', async (req, res, next) => {
  try {
    const id = parseInt(req.query.id, 10)
    if (!id) {
      return res.status(400).json({ error: '请提供歌曲 ID' })
    }

    const resp = await fetch(`https://music.163.com/song/media/outer/url?id=${id}`, {
      headers: NETEASE_HEADERS,
      redirect: 'manual',
    })

    const url = resp.headers.get('location') || ''
    res.json({ url })
  } catch (err) {
    next(err)
  }
})

export default router
