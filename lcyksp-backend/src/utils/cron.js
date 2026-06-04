import fs from 'fs';
import { getDb } from '../config/db.js';

const INTERVAL_MS = 60 * 60 * 1000; // 每小时
let timer = null;

/**
 * 清理过期记录：扫描所有 expire_time < now 的记录，
 * 物理删除对应文件并清库。
 */
async function cleanExpiredRecords() {
  let db;
  try {
    db = getDb();
  } catch {
    // DB 尚未初始化，跳过本轮
    return;
  }

  const now = new Date().toISOString();

  db.all('SELECT id, file_path FROM transfers WHERE expire_time < ?', [now], (err, rows) => {
    if (err) {
      console.error('[清道夫] 查询过期记录失败:', err.message);
      return;
    }

    if (!rows || rows.length === 0) return;

    let deletedCount = 0;
    let errorCount = 0;

    rows.forEach((record) => {
      // 物理删除文件
      fs.unlink(record.file_path, (unlinkErr) => {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          console.error(`[清道夫] 删除文件失败: ${record.file_path}`, unlinkErr.message);
          errorCount++;
        }
      });

      // 删除数据库记录
      db.run('DELETE FROM transfers WHERE id = ?', [record.id], (delErr) => {
        if (delErr) {
          console.error(`[清道夫] 删除记录失败: ${record.id}`, delErr.message);
          errorCount++;
        } else {
          deletedCount++;
        }
      });
    });

    // 延迟输出日志（等异步回调跑完一部分）
    setTimeout(() => {
      if (deletedCount > 0) {
        console.log(`[清道夫] 本轮清理完成: 删除 ${deletedCount} 条过期记录${errorCount > 0 ? `，${errorCount} 个错误` : ''}`);
      }
    }, 500).unref();
  });
}

/** 启动定时轮询 */
export function startCron() {
  if (timer) return; // 防止重复启动
  console.log('[清道夫] 定时任务已启动（每 60 分钟轮询）');
  // 立即执行一次
  cleanExpiredRecords();
  timer = setInterval(cleanExpiredRecords, INTERVAL_MS);

  // 允许 Node.js 在仅剩此定时器时退出
  if (timer.unref) timer.unref();
}

/** 停止定时轮询（用于测试） */
export function stopCron() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[清道夫] 定时任务已停止');
  }
}

export default { startCron, stopCron };
