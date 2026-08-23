let browser = null

async function getBrowser() {
  if (browser && browser.isConnected()) return browser
  try {
    const { chromium } = await import('playwright-core')
    const execPath = process.env.CHROME_PATH || '/home/admin/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell'
    browser = await chromium.launch({
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    return browser
  } catch (err) {
    console.error('[XHS] browser launch error:', err.message)
    return null
  }
}

export async function fetchXiaohongshuHot() {
  try {
    const b = await getBrowser()
    if (!b) return []

    const page = await b.newPage()
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
    })

    await page.goto('https://www.xiaohongshu.com/explore', {
      waitUntil: 'networkidle',
      timeout: 15000,
    })

    await page.waitForTimeout(3000)

    const hotList = await page.evaluate(() => {
      const items = []
      const hotElements = document.querySelectorAll('[class*="hot"] a, [class*="trending"] a, .search-result-item')
      hotElements.forEach((el, idx) => {
        const text = el.textContent?.trim()
        if (text && text.length > 1 && text.length < 50) {
          items.push({ keyword: text, rank: idx + 1 })
        }
      })

      if (items.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/search_result/"]')
        allLinks.forEach((el, idx) => {
          const text = el.textContent?.trim()
          if (text && text.length > 1) {
            items.push({ keyword: text, rank: idx + 1 })
          }
        })
      }

      return items.slice(0, 30)
    })

    await page.close()

    return hotList.map(item => ({
      platform: 'xiaohongshu',
      keyword: item.keyword,
      rank: item.rank,
      score: 0,
    }))
  } catch (err) {
    console.error('[XHS] hot search error:', err.message)
    return []
  }
}

export async function fetchXiaohongshuSearchCount(keyword) {
  try {
    console.log(`[XHS] calling Playwright search count for keyword: '${keyword}'...`)
    const b = await getBrowser()
    if (!b) return { platform: 'xiaohongshu', keyword, count: 0, rank: 0 }

    const page = await b.newPage()
    try {
      await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      })
      await page.waitForTimeout(3000)

      const count = await page.evaluate(() => {
        const countEl = document.querySelector('[class*="count"], [class*="total"], .search-result-num')
        if (countEl) {
          const match = countEl.textContent?.match(/(\d+)/)
          if (match) return parseInt(match[1], 10)
        }
        return document.querySelectorAll('[class*="note-item"], a[href*="/explore/"]').length
      })

      return { platform: 'xiaohongshu', keyword, count: count || 0, rank: 0 }
    } finally {
      await page.close()
    }
  } catch (err) {
    console.error('[XHS] search error:', err.message)
    return { platform: 'xiaohongshu', keyword, count: 0, rank: 0 }
  }
}

export async function closeBrowser() {
  if (browser) {
    try { await browser.close() } catch {}
    browser = null
  }
}
