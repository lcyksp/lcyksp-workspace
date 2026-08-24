import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getDb } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);

var router = Router();
var DEFAULT_AFDIAN_URL = 'https://ifdian.net/a/lcyksp';
var MEMBERSHIP_PLANS = [
  { key: 'monthly', name: '高级用户 30 天', amount: 500, durationDays: 30, description: '5 元 / 30 天' },
  { key: 'quarterly', name: '高级用户 90 天', amount: 1000, durationDays: 90, description: '10 元 / 90 天' },
  { key: 'yearly', name: '高级用户 365 天', amount: 2000, durationDays: 365, description: '20 元 / 365 天' },
];

router.use(authMiddleware);
router.use(requireAdmin);

var SALT_ROUNDS = 10;
var execFileAsync = promisify(execFile);

async function runGithubProxyCommand(action, subscriptionUrl = '') {
  const helper = process.env.MIHOMO_ADMIN_HELPER || '/usr/local/bin/lcyksp-mihomo-update';
  const args = [action];
  if (subscriptionUrl) args.push(subscriptionUrl);
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('sudo', [helper, ...args], { timeout: 90000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    let message = '';
    try {
      const result = JSON.parse(String(error.stdout || '').trim());
      message = String(result.message || '');
    } catch {}
    throw new Error(message || '代理更新或节点检测失败，请稍后重试');
  }
  try { return JSON.parse(stdout); } catch { return { ok: true, output: stdout.slice(-2000) }; }
}

function generateCardCode() {
  var raw = crypto.randomBytes(10).toString('hex').toUpperCase();
  return [raw.slice(0, 4), raw.slice(4, 8), raw.slice(8, 12), raw.slice(12, 16)].join('-');
}

function getMembershipPlan(planKey) {
  for (var i = 0; i < MEMBERSHIP_PLANS.length; i++) {
    if (MEMBERSHIP_PLANS[i].key === planKey) return MEMBERSHIP_PLANS[i];
  }
  return null;
}

function normalizeImportedMembershipCode(value) {
  var input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';

  var redeemMatch = input.match(/\/redeem\/([A-Za-z0-9_-]+)/i);
  var token = (redeemMatch && redeemMatch[1]) ? redeemMatch[1] : input;
  return token.toUpperCase();
}

function maskMembershipDisplayCode(value) {
  var input = normalizeImportedMembershipCode(value);
  if (!input || input.length < 8) return input || '';
  return input;
}

// ===================================================================
//  文件资产管理
// ===================================================================

router.get('/files', async function (req, res, next) {
  try {
    var db = getDb();
    var rows = await new Promise(function (resolve, reject) {
      db.all(
        'SELECT t.id, t.file_name, t.file_path, t.file_size, t.password, t.max_downloads, t.current_downloads, t.expire_time, t.owner_id, t.is_private, t.created_at, u.username AS owner_name FROM transfers t LEFT JOIN users u ON t.owner_id = u.id ORDER BY t.created_at DESC',
        function (err, rows) {
          if (err) return reject(err);
          resolve(rows);
        },
      );
    });

    var fileList = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      fileList.push({
        id: r.id,
        fileName: (function() {
          try {
            var parsed = JSON.parse(r.file_name);
            return Array.isArray(parsed) ? parsed.join(', ') : r.file_name;
          } catch { return r.file_name; }
        })(),
        fileSize: r.file_size,
        hasPassword: !!r.password,
        maxDownloads: r.max_downloads,
        currentDownloads: r.current_downloads,
        expireTime: r.expire_time,
        ownerId: r.owner_id,
        ownerName: r.owner_name || '(游客)',
        isPrivate: !!r.is_private,
        createdAt: r.created_at,
      });
    }

    res.json({ files: fileList });
  } catch (err) {
    next(err);
  }
});

router.put('/files/:code', async function (req, res, next) {
  try {
    var code = req.params.code;
    var db = getDb();

    var record = await new Promise(function (resolve, reject) {
      db.get('SELECT id, file_path FROM transfers WHERE id = ?', [code], function (err, row) {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }

    var expireTime = req.body.expireTime;
    var maxDownloads = req.body.maxDownloads;
    var fileName = typeof req.body.fileName === 'string' ? req.body.fileName.trim() : '';
    var newCode = typeof req.body.newCode === 'string' ? req.body.newCode.trim() : '';

    var setClauses = [];
    var params = [];

    if (fileName) {
      setClauses.push('file_name = ?');
      params.push(fileName);
    }

    if (newCode && newCode !== code) {
      var exists = await new Promise(function (resolve, reject) {
        db.get('SELECT id FROM transfers WHERE id = ?', [newCode], function (err, row) {
          if (err) return reject(err);
          resolve(row);
        });
      });
      if (exists) {
        return res.status(400).json({ error: '该提取码已被占用，请使用其他提取码' });
      }
      setClauses.push('id = ?');
      params.push(newCode);
    }

    if (expireTime !== undefined) {
      if (expireTime === 'permanent') {
        setClauses.push('expire_time = ?');
        params.push('2099-12-31T23:59:59.000Z');
      } else {
        var d = new Date(expireTime);
        setClauses.push('expire_time = ?');
        params.push(d.toISOString());
      }
    }

    if (maxDownloads !== undefined) {
      var num = parseInt(maxDownloads, 10);
      setClauses.push('max_downloads = ?');
      params.push(num === 0 ? -1 : num);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: '未提供任何修改字段' });
    }

    params.push(code);
    await new Promise(function (resolve, reject) {
      db.run('UPDATE transfers SET ' + setClauses.join(', ') + ' WHERE id = ?', params, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '文件属性已更新' });
  } catch (err) {
    next(err);
  }
});

router.delete('/files/:code', async function (req, res, next) {
  try {
    var code = req.params.code;
    var db = getDb();

    var record = await new Promise(function (resolve, reject) {
      db.get('SELECT id, file_path FROM transfers WHERE id = ?', [code], function (err, row) {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }

    let paths = [];
    try {
      paths = JSON.parse(record.file_path);
    } catch {
      paths = [record.file_path];
    }
    paths.forEach(function (fp) {
      fs.unlink(fp, function (unlinkErr) {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          console.error('[管理员] 删除文件失败:', fp, unlinkErr.message);
        }
      });
    });

    await new Promise(function (resolve, reject) {
      db.run('DELETE FROM transfers WHERE id = ?', [code], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '文件已删除', code: code });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  用户管理
// ===================================================================

router.get('/users', async function (req, res, next) {
  try {
    var db = getDb();
    var keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    var sql = "SELECT u.id, u.username, u.role, u.quota_plan, u.premium_expires_at, u.is_banned, u.banned_reason, u.group_id, u.created_at, COALESCE(fg.group_name, '') AS group_name FROM users u LEFT JOIN family_groups fg ON u.group_id = fg.id";
    var params = [];

    if (keyword) {
      sql += ' WHERE u.username LIKE ?';
      params.push('%' + keyword + '%');
    }

    sql += ' ORDER BY u.id ASC';

    var rows = await new Promise(function (resolve, reject) {
      db.all(sql, params, function (err, rows) {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/users', async function (req, res, next) {
  try {
    var username = req.body.username;
    var password = req.body.password;
    var role = req.body.role;
    var premiumExpiresAt = req.body.premiumExpiresAt;
    var isBanned = req.body.isBanned;
    var bannedReason = req.body.bannedReason;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    var db = getDb();

    var existing = await new Promise(function (resolve, reject) {
      db.get('SELECT id FROM users WHERE username = ?', [username], function (err, row) {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (existing) {
      return res.status(409).json({ error: '用户名已被使用' });
    }

    var hashed = await bcrypt.hash(password, SALT_ROUNDS);
    var userRole = role === 'admin' ? 'admin' : role === 'pro' ? 'pro' : role === 'premium' ? 'premium' : 'user';
    var quotaPlan = userRole === 'admin' ? 'admin' : userRole === 'pro' ? 'pro' : userRole === 'premium' ? 'premium' : 'free';
    if (userRole === 'premium' && premiumExpiresAt && Number.isNaN(new Date(premiumExpiresAt).getTime())) {
      return res.status(400).json({ error: '??????????' });
    }
    var safePremiumExpiresAt = userRole === 'premium' && premiumExpiresAt ? new Date(premiumExpiresAt).toISOString() : null;
    var safeIsBanned = isBanned ? 1 : 0;
    var safeBannedReason = typeof bannedReason === 'string' ? bannedReason.trim() : '';

    var result = await new Promise(function (resolve, reject) {
      db.run('INSERT INTO users (username, password, role, quota_plan, premium_expires_at, is_banned, banned_reason) VALUES (?, ?, ?, ?, ?, ?, ?)', [username, hashed, userRole, quotaPlan, safePremiumExpiresAt, safeIsBanned, safeBannedReason], function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID });
      });
    });

    res.status(201).json({ message: '用户创建成功', user: { id: result.id, username: username, role: userRole } });
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', async function (req, res, next) {
  try {
    var userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: '无效的用户 ID' });

    var db = getDb();
    var username = req.body.username;
    var password = req.body.password;
    var role = req.body.role;
    var premiumExpiresAt = req.body.premiumExpiresAt;
    var isBanned = req.body.isBanned;
    var bannedReason = req.body.bannedReason;
    var setClauses = [];
    var params = [];

    if (username !== undefined) {
      var dup = await new Promise(function (resolve, reject) {
        db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId], function (err, row) {
          if (err) return reject(err);
          resolve(row);
        });
      });
      if (dup) return res.status(409).json({ error: '用户名已被使用' });
      setClauses.push('username = ?');
      params.push(username);
    }

    if (password !== undefined) {
      var hashed = await bcrypt.hash(password, SALT_ROUNDS);
      setClauses.push('password = ?');
      params.push(hashed);
    }

    if (role !== undefined) {
      var nextRole = role === 'admin' ? 'admin' : role === 'pro' ? 'pro' : role === 'premium' ? 'premium' : 'user';
      var nextQuotaPlan = nextRole === 'admin' ? 'admin' : nextRole === 'pro' ? 'pro' : nextRole === 'premium' ? 'premium' : 'free';
      setClauses.push('role = ?');
      params.push(nextRole);
      setClauses.push('quota_plan = ?');
      params.push(nextQuotaPlan);
      if (nextRole !== 'premium') {
        setClauses.push('premium_expires_at = NULL');
      }
    }

    if (premiumExpiresAt !== undefined) {
      if (premiumExpiresAt) {
        if (Number.isNaN(new Date(premiumExpiresAt).getTime())) {
          return res.status(400).json({ error: '??????????' });
        }
        setClauses.push('premium_expires_at = ?');
        params.push(new Date(premiumExpiresAt).toISOString());
      } else {
        setClauses.push('premium_expires_at = NULL');
      }
    }

    if (isBanned !== undefined) {
      setClauses.push('is_banned = ?');
      params.push(isBanned ? 1 : 0);
    }

    if (bannedReason !== undefined) {
      setClauses.push('banned_reason = ?');
      params.push(typeof bannedReason === 'string' ? bannedReason.trim() : '');
    }

    if (setClauses.length === 0) return res.status(400).json({ error: '未提供修改字段' });

    params.push(userId);
    await new Promise(function (resolve, reject) {
      db.run('UPDATE users SET ' + setClauses.join(', ') + ' WHERE id = ?', params, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '用户信息已更新' });
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', async function (req, res, next) {
  try {
    var userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: '无效的用户 ID' });
    if (userId === req.user.userId) return res.status(400).json({ error: '不能删除自己' });

    var db = getDb();

    await new Promise(function (resolve, reject) {
      db.run('DELETE FROM users WHERE id = ?', [userId], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '用户已删除' });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  LLM 配置历史记录
// ===================================================================

// GET /api/admin/config/llm/history?type=url|key|model
// 返回指定类型的历史记录（最多 5 条，按时间倒序）
router.get('/config/llm/history', async function (req, res, next) {
  try {
    var type = req.query.type;
    if (!type || !['apiUrl', 'apiKey', 'model'].includes(type)) {
      return res.status(400).json({ error: '无效的类型，可用值: apiUrl, apiKey, model' });
    }

    // 将前端类型名映射为数据库 type 值（保持与前端一致更好，不过这里直接用）
    // 前端类型: apiUrl, apiKey, model → 对应存储的前缀
    var db = getDb();
    var rows = await new Promise(function (resolve, reject) {
      db.all(
        'SELECT value, created_at FROM llm_config_history WHERE type = ? ORDER BY created_at DESC LIMIT 5',
        [type],
        function (err, rows) {
          if (err) return reject(err);
          resolve(rows);
        },
      );
    });

    var history = rows.map(function (r) { return { value: r.value, createdAt: r.created_at } });
    res.json({ history: history });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/config/llm/history
// 保存一组历史记录
router.post('/config/llm/history', async function (req, res, next) {
  try {
    var items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items 必须是非空数组' });
    }

    var db = getDb();

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.type || !['apiUrl', 'apiKey', 'model'].includes(item.type)) continue;
      if (!item.value || typeof item.value !== 'string' || item.value.trim().length < 1) continue;

      var trimmed = item.value.trim();

      // 去重：如果已存在相同 type+value 的记录，先删旧的
      await new Promise(function (resolve, reject) {
        db.run('DELETE FROM llm_config_history WHERE type = ? AND value = ?', [item.type, trimmed], function (err) {
          if (err) return reject(err);
          resolve();
        });
      });

      // 插入新记录（当前时间）
      await new Promise(function (resolve, reject) {
        db.run('INSERT INTO llm_config_history (type, value) VALUES (?, ?)', [item.type, trimmed], function (err) {
          if (err) return reject(err);
          resolve();
        });
      });

      // 超出 5 条时删除最旧的
      await new Promise(function (resolve, reject) {
        db.run(
          'DELETE FROM llm_config_history WHERE type = ? AND id NOT IN (SELECT id FROM llm_config_history WHERE type = ? ORDER BY created_at DESC LIMIT 5)',
          [item.type, item.type],
          function (err) {
            if (err) return reject(err);
            resolve();
          },
        );
      });
    }

    res.json({ message: '历史记录已保存' });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  大模型配置管理（当前活跃配置）
// ===================================================================

router.get('/config/github-radar', async function (req, res, next) {
  try {
    const db = getDb()
    const rows = await new Promise((resolve, reject) => db.all("SELECT key, value FROM system_config WHERE key LIKE 'github_%' OR key IN ('llm_url', 'llm_model', 'llm_key')", (err, result) => err ? reject(err) : resolve(result || [])))
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]))
    res.json({
      primaryAiUrl: values.llm_url || 'https://api.deepseek.com',
      primaryAiModel: values.llm_model || 'deepseek-chat',
      primaryAiConfigured: Boolean(values.llm_key),
      githubTokenConfigured: Boolean(values.github_token),
      smtpConfigured: Boolean(values.github_smtp_password),
      smtpHost: values.github_smtp_host || 'smtp-mail.outlook.com',
      smtpPort: Number(values.github_smtp_port || 587),
      smtpUser: values.github_smtp_user || '',
      smtpFrom: values.github_smtp_from || values.github_smtp_user || '',
      aiFallbackUrl: values.github_ai_fallback_url || '',
      aiFallbackModel: values.github_ai_fallback_model || '',
      aiFallbackConfigured: Boolean(values.github_ai_fallback_key),
      proxyConfigured: Boolean(values.github_proxy_subscription),
      proxyStatus: values.github_proxy_status || '未检测',
      proxyNode: values.github_proxy_node || '',
      proxyCheckedAt: values.github_proxy_checked_at || '',
    })
  } catch (err) {
    next(err)
  }
})

router.post('/config/github-radar', async function (req, res, next) {
  try {
    const values = [
      ['llm_url', req.body?.primaryAiUrl],
      ['llm_model', req.body?.primaryAiModel],
      ['llm_key', req.body?.primaryAiKey],
      ['github_token', req.body?.githubToken],
      ['github_smtp_password', req.body?.smtpPassword],
      ['github_smtp_host', req.body?.smtpHost || 'smtp-mail.outlook.com'],
      ['github_smtp_port', String(req.body?.smtpPort || 587)],
      ['github_smtp_user', req.body?.smtpUser],
      ['github_smtp_from', req.body?.smtpFrom || req.body?.smtpUser],
      ['github_ai_fallback_url', req.body?.aiFallbackUrl],
      ['github_ai_fallback_model', req.body?.aiFallbackModel],
      ['github_ai_fallback_key', req.body?.aiFallbackKey],
    ]
    const db = getDb()
    for (const [key, value] of values) {
      if (value === undefined || value === null || String(value).trim() === '') continue
      const encrypted = ['llm_key', 'github_token', 'github_smtp_password', 'github_ai_fallback_key', 'github_proxy_subscription'].includes(key) ? encrypt(String(value).trim()) : String(value).trim()
      await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [key, encrypted], (err) => err ? reject(err) : resolve()))
    }
    if (req.body?.proxySubscription && String(req.body.proxySubscription).trim()) {
      try {
        const result = await runGithubProxyCommand('update', String(req.body.proxySubscription).trim())
        const now = new Date().toISOString()
        await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_subscription', encrypt(String(req.body.proxySubscription).trim())], (err) => err ? reject(err) : resolve()))
        await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_status', result.ok === false ? '失败' : '已连接'], (err) => err ? reject(err) : resolve()))
        await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_node', String(result.node || '')], (err) => err ? reject(err) : resolve()))
        await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_checked_at', now], (err) => err ? reject(err) : resolve()))
      } catch (proxyError) {
        return res.status(502).json({ error: '机场订阅更新或节点检测失败：' + proxyError.message })
      }
    }
    res.json({ message: 'GitHub 趋势配置已保存' })
  } catch (err) {
    next(err)
  }
})

router.post('/config/github-radar/proxy-test', async function (req, res, next) {
  try {
    const result = await runGithubProxyCommand('test')
    const db = getDb()
    const now = new Date().toISOString()
    await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_status', result.ok === false ? '失败' : '已连接'], (err) => err ? reject(err) : resolve()))
    await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_node', String(result.node || '')], (err) => err ? reject(err) : resolve()))
    await new Promise((resolve, reject) => db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['github_proxy_checked_at', now], (err) => err ? reject(err) : resolve()))
    res.json(result)
  } catch (err) { next(err) }
})

router.get('/github-radar/categories', async function (req, res, next) {
  try {
    const db = getDb()
    const rows = await new Promise((resolve, reject) => db.all('SELECT id, name, description, keywords, languages, enabled FROM github_categories ORDER BY id DESC', (err, result) => err ? reject(err) : resolve(result || [])))
    res.json({ categories: rows.map((row) => ({ ...row, keywords: JSON.parse(row.keywords || '[]'), languages: JSON.parse(row.languages || '[]') })) })
  } catch (err) { next(err) }
})

router.post('/github-radar/categories', async function (req, res, next) {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 64)
    const description = String(req.body?.description || '').trim().slice(0, 240)
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : String(req.body?.keywords || '').split(/[,，\n]/)
    const languages = Array.isArray(req.body?.languages) ? req.body.languages : String(req.body?.languages || '').split(/[,，\n]/)
    const clean = (items, max) => [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, max)
    if (!name || !clean(keywords, 30).length) return res.status(400).json({ error: '方向名称和关键词不能为空' })
    const db = getDb()
    await new Promise((resolve, reject) => db.run('INSERT INTO github_categories (name, description, keywords, languages) VALUES (?, ?, ?, ?)', [name, description, JSON.stringify(clean(keywords, 30)), JSON.stringify(clean(languages, 20))], (err) => err ? reject(err) : resolve()))
    res.json({ message: '预设方向已创建' })
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: '方向名称已存在' })
    next(err)
  }
})

router.delete('/github-radar/categories/:id', async function (req, res, next) {
  try {
    const db = getDb()
    await new Promise((resolve, reject) => db.run('DELETE FROM github_categories WHERE id = ?', [req.params.id], (err) => err ? reject(err) : resolve()))
    res.json({ message: '预设方向已删除' })
  } catch (err) { next(err) }
})

router.get('/config/llm', async function (req, res, next) {
  try {
    var db = getDb();

    var rows = await new Promise(function (resolve, reject) {
      db.all('SELECT key, value FROM system_config WHERE key IN (\'llm_url\', \'llm_model\', \'llm_key\')', function (err, rows) {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    var config = {};
    for (var i = 0; i < rows.length; i++) {
      config[rows[i].key] = rows[i].value;
    }

    if (!config.llm_url && !config.llm_model && !config.llm_key) {
      return res.json({ configured: false });
    }

    var decryptedKey = '';
    if (config.llm_key) {
      decryptedKey = decrypt(config.llm_key);
    }

    res.json({
      configured: true,
      apiUrl: config.llm_url || 'https://api.deepseek.com/chat/completions',
      model: config.llm_model || 'deepseek-chat',
      apiKey: decryptedKey,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/config/llm', async function (req, res, next) {
  try {
    var apiKey = req.body.apiKey;
    var apiUrl = req.body.apiUrl;
    var model = req.body.model;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 1) {
      return res.status(400).json({ error: 'API Key 不能为空' });
    }

    var encryptedKey = encrypt(apiKey.trim());

    var safeUrl = (typeof apiUrl === 'string' && apiUrl.trim().length > 0) ? apiUrl.trim() : 'https://api.deepseek.com/chat/completions';
    var safeModel = (typeof model === 'string' && model.trim().length > 0) ? model.trim() : 'deepseek-chat';

    var db = getDb();

    db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['llm_key', encryptedKey]);
    db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['llm_url', safeUrl]);
    db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['llm_model', safeModel]);

    // 同步保存到历史记录表（去重 + 最多 5 条）
    var historyItems = [
      { type: 'apiUrl', value: safeUrl },
      { type: 'apiKey', value: apiKey.trim() },
      { type: 'model', value: safeModel },
    ];
    for (var h = 0; h < historyItems.length; h++) {
      var hItem = historyItems[h];
      await new Promise(function (resolve, reject) {
        db.run('DELETE FROM llm_config_history WHERE type = ? AND value = ?', [hItem.type, hItem.value], function (err) {
          if (err) return reject(err);
          resolve();
        });
      });
      await new Promise(function (resolve, reject) {
        db.run('INSERT INTO llm_config_history (type, value) VALUES (?, ?)', [hItem.type, hItem.value], function (err) {
          if (err) return reject(err);
          resolve();
        });
      });
      // 限制每个类型最多 5 条
      await new Promise(function (resolve, reject) {
        db.run(
          'DELETE FROM llm_config_history WHERE type = ? AND id NOT IN (SELECT id FROM llm_config_history WHERE type = ? ORDER BY created_at DESC LIMIT 5)',
          [hItem.type, hItem.type],
          function (err) {
            if (err) return reject(err);
            resolve();
          },
        );
      });
    }

    res.json({ message: '配置已保存' });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/config/llm/test
// 不保存数据库，测试大模型连接
router.post('/config/llm/test', async function (req, res, next) {
  try {
    var apiKey = req.body.apiKey;
    var apiUrl = req.body.apiUrl;
    var model = req.body.model;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 1) {
      return res.json({ success: false, error: 'API Key 未提供' });
    }

    // 自动补全 /chat/completions
    function normalizeEndpoint(url) {
      if (!url || typeof url !== 'string') return 'https://api.deepseek.com/chat/completions';
      var trimmed = url.trim();
      if (trimmed.slice(-18) === '/chat/completions') return trimmed;
      if (trimmed.slice(-1) === '/') return trimmed + 'chat/completions';
      return trimmed + '/chat/completions';
    }

    var targetUrl = normalizeEndpoint(apiUrl);
    var targetModel = (typeof model === 'string' && model.trim().length > 0) ? model.trim() : 'deepseek-chat';

    var abortController = new AbortController();
    var timeoutTimer = setTimeout(function () { abortController.abort(); }, 10000);

    try {
      var response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey.trim(),
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'user', content: 'ping' },
          ],
        }),
        signal: abortController.signal,
      });

      clearTimeout(timeoutTimer);

      if (!response.ok) {
        var errText = '';
        try { errText = await response.text(); } catch (e) { errText = '无法读取错误详情'; }
        return res.json({ success: false, error: 'HTTP ' + response.status + ': ' + errText });
      }

      return res.json({ success: true, model: targetModel, message: '连接测试成功' });
    } catch (fetchErr) {
      clearTimeout(timeoutTimer);
      if (fetchErr.name === 'AbortError') {
        return res.json({ success: false, error: '连接超时（10秒）' });
      }
      return res.json({ success: false, error: fetchErr.message || '请求失败' });
    }
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  会员配置与卡密管理
// ===================================================================

router.get('/config/membership', async function (req, res, next) {
  try {
    var db = getDb();
    var rows = await new Promise(function (resolve, reject) {
      db.all(
        'SELECT key, value FROM system_config WHERE key IN (\'membership_afdian_url\', \'membership_notice\', \'membership_afdian_user_id\', \'membership_afdian_token\', \'membership_afdian_webhook_token\', \'membership_plan_id_monthly\', \'membership_plan_id_quarterly\', \'membership_plan_id_yearly\', \'membership_afdian_reply_template\')',
        function (err, rows) {
          if (err) return reject(err);
          resolve(rows);
        },
      );
    });

    var config = {};
    for (var i = 0; i < rows.length; i++) {
      config[rows[i].key] = rows[i].value;
    }

    res.json({
      afdianUrl: config.membership_afdian_url || DEFAULT_AFDIAN_URL,
      notice: config.membership_notice || '登录本站账号后，前往爱发电下单，并在订单备注里填写本站用户名。支付成功后，系统会自动为对应账号开通高级用户。',
      afdianUserId: config.membership_afdian_user_id || '',
      afdianToken: config.membership_afdian_token || '',
      webhookToken: config.membership_afdian_webhook_token || '',
      planIdMonthly: config.membership_plan_id_monthly || '',
      planIdQuarterly: config.membership_plan_id_quarterly || '',
      planIdYearly: config.membership_plan_id_yearly || '',
      afdianReplyTemplate: config.membership_afdian_reply_template || '',
      plans: MEMBERSHIP_PLANS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/config/membership', async function (req, res, next) {
  try {
    var afdianUrl = typeof req.body.afdianUrl === 'string' ? req.body.afdianUrl.trim() : DEFAULT_AFDIAN_URL;
    var notice = typeof req.body.notice === 'string' ? req.body.notice.trim() : '';
    var afdianUserId = typeof req.body.afdianUserId === 'string' ? req.body.afdianUserId.trim() : '';
    var afdianToken = typeof req.body.afdianToken === 'string' ? req.body.afdianToken.trim() : '';
    var webhookToken = typeof req.body.webhookToken === 'string' ? req.body.webhookToken.trim() : '';
    var planIdMonthly = typeof req.body.planIdMonthly === 'string' ? req.body.planIdMonthly.trim() : '';
    var planIdQuarterly = typeof req.body.planIdQuarterly === 'string' ? req.body.planIdQuarterly.trim() : '';
    var planIdYearly = typeof req.body.planIdYearly === 'string' ? req.body.planIdYearly.trim() : '';
    var afdianReplyTemplate = typeof req.body.afdianReplyTemplate === 'string' ? req.body.afdianReplyTemplate.trim() : '';
    var db = getDb();

    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_afdian_url', afdianUrl], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_notice', notice], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_afdian_user_id', afdianUserId], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_afdian_token', afdianToken], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_afdian_webhook_token', webhookToken], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_plan_id_monthly', planIdMonthly], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_plan_id_quarterly', planIdQuarterly], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_plan_id_yearly', planIdYearly], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
    await new Promise(function (resolve, reject) {
      db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['membership_afdian_reply_template', afdianReplyTemplate], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '会员配置已保存' });
  } catch (err) {
    next(err);
  }
});

router.get('/membership/cards', async function (req, res, next) {
  try {
    var db = getDb();
    var status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    var sql = 'SELECT c.id, c.code, c.plan_key, c.duration_days, c.status, c.source, c.source_order_id, c.note, c.created_by, c.used_by, c.used_at, c.granted_expires_at, c.created_at, u.username AS used_by_name FROM membership_cards c LEFT JOIN users u ON c.used_by = u.id';
    var params = [];
    if (status) {
      sql += ' WHERE c.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY c.id DESC LIMIT 100';

    var rows = await new Promise(function (resolve, reject) {
      db.all(sql, params, function (err, rows) {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    res.json({
      cards: rows.map(function (row) {
        var plan = getMembershipPlan(row.plan_key);
        return {
          id: row.id,
          code: maskMembershipDisplayCode(row.code),
          planKey: row.plan_key,
          planName: plan ? plan.name : row.plan_key,
          durationDays: row.duration_days,
          status: row.status,
          source: row.source,
          sourceOrderId: row.source_order_id || '',
          note: row.note || '',
          createdBy: row.created_by || null,
          usedBy: row.used_by || null,
          usedByName: row.used_by_name || '',
          usedAt: row.used_at || null,
          grantedExpiresAt: row.granted_expires_at || null,
          createdAt: row.created_at,
        };
      }),
      plans: MEMBERSHIP_PLANS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/membership/cards/generate', async function (req, res, next) {
  try {
    var planKey = typeof req.body.planKey === 'string' ? req.body.planKey.trim() : '';
    var quantity = parseInt(req.body.quantity, 10) || 1;
    var note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    var plan = getMembershipPlan(planKey);

    if (!plan) {
      return res.status(400).json({ error: '无效的会员套餐' });
    }
    if (quantity < 1 || quantity > 50) {
      return res.status(400).json({ error: '一次最多生成 50 张卡密' });
    }

    var db = getDb();
    var created = [];

    for (var i = 0; i < quantity; i++) {
      var code = generateCardCode();
      await new Promise(function (resolve, reject) {
        db.run(
          'INSERT INTO membership_cards (code, plan_key, duration_days, status, source, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [code, plan.key, plan.durationDays, 'unused', 'manual', note, req.user.userId],
          function (err) {
            if (err) return reject(err);
            resolve();
          },
        );
      });
      created.push(code);
    }

    res.json({
      message: '卡密已生成',
      plan: plan,
      cards: created,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/membership/cards/import', async function (req, res, next) {
  try {
    var planKey = typeof req.body.planKey === 'string' ? req.body.planKey.trim() : '';
    var note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    var rawText = typeof req.body.codesText === 'string' ? req.body.codesText : '';
    var plan = getMembershipPlan(planKey);

    if (!plan) {
      return res.status(400).json({ error: '无效的会员套餐' });
    }

    var codes = rawText
      .split(/\r?\n/g)
      .map(normalizeImportedMembershipCode)
      .filter(Boolean);

    if (!codes.length) {
      return res.status(400).json({ error: '请至少输入一条兑换码或兑换链接' });
    }
    if (codes.length > 200) {
      return res.status(400).json({ error: '单次最多导入 200 条' });
    }

    var db = getDb();
    var imported = [];
    var duplicates = [];

    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      try {
        await new Promise(function (resolve, reject) {
          db.run(
            'INSERT INTO membership_cards (code, plan_key, duration_days, status, source, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [code, plan.key, plan.durationDays, 'unused', 'afdian_import', note, req.user.userId],
            function (err) {
              if (err) return reject(err);
              resolve();
            },
          );
        });
        imported.push(code);
      } catch (error) {
        if (String(error.message || '').includes('UNIQUE')) {
          duplicates.push(code);
        } else {
          throw error;
        }
      }
    }

    res.json({
      message: '导入完成',
      importedCount: imported.length,
      duplicateCount: duplicates.length,
      imported: imported,
      duplicates: duplicates,
    });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  问题反馈管理
// ===================================================================

router.get('/feedback', async function (req, res, next) {
  try {
    var db = getDb();
    var rows = await new Promise(function (resolve, reject) {
      db.all(
        'SELECT id, page_name, feature_name, problem_summary, details, reporter_id, reporter_name, created_at FROM feedback_reports ORDER BY created_at DESC, id DESC',
        function (err, rows) {
          if (err) return reject(err);
          resolve(rows);
        },
      );
    });

    res.json({
      feedback: rows.map(function (row) {
        return {
          id: row.id,
          pageName: row.page_name,
          featureName: row.feature_name,
          problemSummary: row.problem_summary,
          details: row.details,
          reporterId: row.reporter_id,
          reporterName: row.reporter_name || 'guest',
          createdAt: row.created_at,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/feedback/:id', async function (req, res, next) {
  try {
    var feedbackId = parseInt(req.params.id, 10);
    if (isNaN(feedbackId)) {
      return res.status(400).json({ error: '无效的反馈 ID' });
    }

    var db = getDb();
    var exists = await new Promise(function (resolve, reject) {
      db.get('SELECT id FROM feedback_reports WHERE id = ?', [feedbackId], function (err, row) {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!exists) {
      return res.status(404).json({ error: '反馈记录不存在' });
    }

    await new Promise(function (resolve, reject) {
      db.run('DELETE FROM feedback_reports WHERE id = ?', [feedbackId], function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '反馈记录已删除' });
  } catch (err) {
    next(err);
  }
});

export default router;
