import { Router } from 'express';

const router = Router();
const ALS_API_KEY = '1d096ca7b1f78852a73c8c0754851566';

// Platform map: origin -> PC, psn -> PS4, xbl -> X1
const platformMap = {
  origin: 'PC',
  psn: 'PS4',
  xbl: 'X1'
};

// Get player profile
router.get('/profile', async (req, res, next) => {
  try {
    const { platform, username } = req.query;

    if (!platform || !username) {
      return res.status(400).json({ error: '缺少必填参数 platform 或 username' });
    }

    const mappedPlatform = platformMap[platform.toLowerCase()];
    if (!mappedPlatform) {
      return res.status(400).json({ error: '无效的平台参数，必须为 origin, psn 或 xbl' });
    }

    const url = `https://api.mozambiquehe.re/bridge?player=${encodeURIComponent(username)}&platform=${mappedPlatform}&auth=${ALS_API_KEY}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 404) {
      let errDetail = '未找到该玩家的战绩信息，请确认用户名和平台是否正确。';
      try {
        const data = await response.json();
        if (data.Error) {
          errDetail = data.Error;
        }
      } catch (e) {}
      
      if (errDetail.includes('low priority') || errDetail.includes('Player not found')) {
        errDetail = '未在数据库中找到该玩家。首次查询的新玩家，需先在 https://apexlegendsstatus.com 搜索一次建立缓存，或当前 EA 官方查询接口繁忙。';
      }
      return res.status(404).json({ error: errDetail });
    }

    if (response.status === 429) {
      const data = await response.json();
      return res.status(429).json({ error: data.Error || '请求过于频繁，请稍后再试。' });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error('[ALS API Error]', response.status, errText);
      return res.status(response.status).json({ error: `第三方接口错误 (${response.status})` });
    }

    const data = await response.json();
    
    // Check if MozambiqueHe.re API returned an internal error message inside 200 OK
    if (data.Error) {
      return res.status(400).json({ error: data.Error });
    }

    res.json(data);
  } catch (err) {
    console.error('[ALS Proxy Error]', err);
    next(err);
  }
});

// Get player sessions (match history)
router.get('/sessions', async (req, res, next) => {
  try {
    const { platform, username } = req.query;

    if (!platform || !username) {
      return res.status(400).json({ error: '缺少必填参数 platform 或 username' });
    }

    const mappedPlatform = platformMap[platform.toLowerCase()];
    if (!mappedPlatform) {
      return res.status(400).json({ error: '无效的平台参数，必须为 origin, psn 或 xbl' });
    }

    const url = `https://api.mozambiquehe.re/bridge?player=${encodeURIComponent(username)}&platform=${mappedPlatform}&auth=${ALS_API_KEY}&history=1&action=get`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 404) {
      return res.status(404).json({ error: '未找到该玩家的场次历史。' });
    }

    if (response.status === 429) {
      const data = await response.json();
      return res.status(429).json({ error: data.Error || '请求过于频繁，请稍后再试。' });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error('[ALS Sessions API Error]', response.status, errText);
      return res.status(response.status).json({ error: `第三方接口错误 (${response.status})` });
    }

    const data = await response.json();
    
    if (data.Error) {
      return res.status(400).json({ error: data.Error });
    }

    res.json(data);
  } catch (err) {
    console.error('[ALS Sessions Proxy Error]', err);
    next(err);
  }
});

export default router;
