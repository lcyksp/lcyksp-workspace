import fs from 'fs';
import { getDb } from '../config/db.js';
import { fetchBilibiliHot } from './trends/bilibili.js';
import { fetchDouyinHot } from './trends/douyin.js';
import { discoverActiveGithubSubscriptions } from './githubJobs.js';
import { runGithubDigests, runPendingGithubSimulations } from './githubDigest.js';

const INTERVAL_MS = 60 * 60 * 1000;
let timer = null;
let digestTimer = null;
let lastGithubRadarRun = 0;
let lastDailyGithubPrepKey = '';

async function cleanExpiredRecords() {
  let db;
  try { db = getDb(); } catch { return; }

  const now = new Date().toISOString();

  db.run("DELETE FROM download_logs WHERE created_at < datetime('now', '-7 days')", (err) => {
    if (err) console.error('[清道夫] 清理 7 天前下载日志失败:', err.message);
  });

  db.run("DELETE FROM trend_snapshots WHERE created_at < datetime('now', '-30 days')", (err) => {
    if (err) console.error('[清道夫] 清理 30 天前趋势数据失败:', err.message);
  });

  db.all('SELECT id, file_path FROM transfers WHERE expire_time < ?', [now], (err, rows) => {
    if (err) { console.error('[清道夫] 查询过期记录失败:', err.message); return; }
    if (!rows || rows.length === 0) return;

    let deletedCount = 0;
    rows.forEach((record) => {
      let paths = [];
      try { paths = JSON.parse(record.file_path); } catch { paths = [record.file_path]; }
      paths.forEach((fp) => {
        fs.unlink(fp, (e) => { if (e && e.code !== 'ENOENT') console.error(`[清道夫] 删除文件失败: ${fp}`, e.message); });
      });
      db.run('DELETE FROM transfers WHERE id = ?', [record.id], (e) => {
        if (!e) deletedCount++;
      });
    });

    setTimeout(() => { if (deletedCount > 0) console.log(`[清道夫] 本轮清理: 删除 ${deletedCount} 条过期记录`); }, 500).unref();
  });
}

async function snapshotTrends() {
  let db;
  try { db = getDb(); } catch { return; }

  const fetchers = [
    { name: 'bilibili', fn: fetchBilibiliHot },
    { name: 'douyin', fn: fetchDouyinHot },
  ]

  for (const { name, fn } of fetchers) {
    try {
      const items = await fn()
      for (const item of items.slice(0, 50)) {
        await new Promise((resolve, reject) => {
          db.run(
            'INSERT INTO trend_snapshots (platform, keyword, rank, score) VALUES (?, ?, ?, ?)',
            [name, item.keyword, item.rank, item.score],
            (err) => err ? reject(err) : resolve()
          )
        })
      }
      console.log(`[趋势] ${name} 快照完成: ${items.length} 条`)
    } catch (err) {
      console.error(`[趋势] ${name} 快照失败:`, err.message)
    }
  }
}

export function startCron() {
  if (timer) return;
  console.log('[清道夫] 定时任务已启动（每 60 分钟轮询，已下架热点趋势快照）');
  cleanExpiredRecords();
  discoverActiveGithubSubscriptions().catch((error) => console.error('[GitHub Radar] initial run failed:', error.message));
  lastGithubRadarRun = Date.now();
  // snapshotTrends(); // 已下架
  timer = setInterval(() => {
    cleanExpiredRecords();
    const beijing = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
    const dailyKey = `${beijing.year}-${beijing.month}-${beijing.day}`
    if (beijing.hour === '06' && Number(beijing.minute) >= 45 && lastDailyGithubPrepKey !== dailyKey) {
      lastDailyGithubPrepKey = dailyKey
      discoverActiveGithubSubscriptions().catch((error) => console.error('[GitHub Radar] daily preparation run failed:', error.message))
    }
    if (Date.now() - lastGithubRadarRun >= 4 * 60 * 60 * 1000) {
      lastGithubRadarRun = Date.now();
      discoverActiveGithubSubscriptions().catch((error) => console.error('[GitHub Radar] scheduled run failed:', error.message));
    }
    // snapshotTrends(); // 已下架
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  runGithubDigests().catch((error) => console.error('[GitHub Radar] digest check failed:', error.message));
  runPendingGithubSimulations().catch((error) => console.error('[GitHub Radar] simulation check failed:', error.message));
  digestTimer = setInterval(() => {
    runGithubDigests().catch((error) => console.error('[GitHub Radar] digest check failed:', error.message));
    runPendingGithubSimulations().catch((error) => console.error('[GitHub Radar] simulation check failed:', error.message));
  }, 60 * 1000);
  if (digestTimer.unref) digestTimer.unref();
}

export function stopCron() {
  if (timer) { clearInterval(timer); timer = null; console.log('[清道夫] 定时任务已停止'); }
  if (digestTimer) { clearInterval(digestTimer); digestTimer = null; }
}

export default { startCron, stopCron };
