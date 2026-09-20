import fs from 'fs';
import { getDb } from '../config/db.js';
import { fetchBilibiliHot } from './trends/bilibili.js';
import { fetchDouyinHot } from './trends/douyin.js';
import { discoverActiveGithubSubscriptions } from './githubJobs.js';
import { runGithubDigests, runPendingGithubSimulations } from './githubDigest.js';
import { processSiteMonitorDeliveries } from './siteMonitorMailer.js';
import { recoverInterruptedSiteMonitorRuns, runDueSiteMonitors } from './siteMonitorService.js';
import { runDailySnapshot as runWtMarketSnapshot } from './wtMarket.js';

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;
let digestTimer = null;
let lastGithubRadarRun = 0;
let lastDailyGithubPrepKey = '';
let lastWtMarketSnapshotKey = '';

async function cleanExpiredRecords() {
  let db;
  try { db = getDb(); } catch { return; }

  const now = new Date().toISOString();

  db.run("DELETE FROM download_logs WHERE created_at < datetime('now', '-7 days')", (err) => {
    if (err) console.error('[清道夫] 清理 7 天前下载日志失败:', err.message);
  });

  // 登录失败计数只在当前 15 分钟窗口内有效，1 天前的行一定是陈旧残留
  db.run("DELETE FROM login_attempts WHERE updated_at < datetime('now', '-1 day')", (err) => {
    if (err) console.error('[清道夫] 清理登录失败计数失败:', err.message);
  });

  db.run("DELETE FROM trend_snapshots WHERE created_at < datetime('now', '-30 days')", (err) => {
    if (err) console.error('[清道夫] 清理 30 天前趋势数据失败:', err.message);
  });

  // 战争雷霆操作日志保留 30 天（诊断用，够回溯一个月的登录/快照/搜索历史）
  db.run("DELETE FROM wt_market_logs WHERE created_at < datetime('now', '-30 days')", (err) => {
    if (err) console.error('[清道夫] 清理 30 天前战争雷霆日志失败:', err.message);
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

// 站点监测：到期判断由数据库里的 next_run_at 决定，心跳只负责唤醒，实际周期仍是 30/60 分钟。
// 抓取与投递分两段容错，抓取失败不影响已入队的邮件继续重试。
async function runSiteMonitorHeartbeat() {
  try {
    await runDueSiteMonitors();
  } catch (error) {
    console.error('[Site Monitor] due sweep failed:', error.message);
  }
  try {
    await processSiteMonitorDeliveries();
  } catch (error) {
    console.error('[Site Monitor] delivery pass failed:', error.message);
  }
}

export function startCron() {
  if (timer) return;
  console.log('[清道夫] 定时任务已启动（每 5 分钟维护轮询，GitHub 采集仍按 4 小时冷却）');
  cleanExpiredRecords();
  discoverActiveGithubSubscriptions().catch((error) => console.error('[GitHub Radar] initial run failed:', error.message));
  lastGithubRadarRun = Date.now();
  recoverInterruptedSiteMonitorRuns()
    .then((count) => { if (count) console.log(`[Site Monitor] 已把 ${count} 条中断的运行记录标记为失败`); })
    .then(() => runSiteMonitorHeartbeat())
    .catch((error) => console.error('[Site Monitor] startup recovery failed:', error.message));
  // snapshotTrends(); // 已下架
  timer = setInterval(() => {
    cleanExpiredRecords();
    runSiteMonitorHeartbeat();
    const beijing = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
    const dailyKey = `${beijing.year}-${beijing.month}-${beijing.day}`
    if (beijing.hour === '06' && Number(beijing.minute) >= 45 && lastDailyGithubPrepKey !== dailyKey) {
      lastDailyGithubPrepKey = dailyKey
      discoverActiveGithubSubscriptions().catch((error) => console.error('[GitHub Radar] daily preparation run failed:', error.message))
    }
    // 战争雷霆交易所：每天北京时间 07:20 后拉一次全目录快照（错开 GitHub 06:45）。
    // 未配置凭据时 runDailySnapshot 自己静默跳过，不抛错。
    if (beijing.hour === '07' && Number(beijing.minute) >= 20 && lastWtMarketSnapshotKey !== dailyKey) {
      lastWtMarketSnapshotKey = dailyKey
      runWtMarketSnapshot('auto').catch((error) => console.error('[WT Market] 每日快照失败:', error.message))
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
