import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';
import { getDb } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { encrypt, decrypt } from '../utils/crypto.js';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);

var router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

var SALT_ROUNDS = 10;

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
        fileName: r.file_name,
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
    var setClauses = [];
    var params = [];

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

    fs.unlink(record.file_path, function (unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.error('[管理员] 删除文件失败:', record.file_path, unlinkErr.message);
      }
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
    var rows = await new Promise(function (resolve, reject) {
      db.all(
        'SELECT u.id, u.username, u.role, u.group_id, u.created_at, COALESCE(fg.group_name, \'\') AS group_name FROM users u LEFT JOIN family_groups fg ON u.group_id = fg.id ORDER BY u.id ASC',
        function (err, rows) {
          if (err) return reject(err);
          resolve(rows);
        },
      );
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
    var userRole = role === 'admin' ? 'admin' : 'user';

    var result = await new Promise(function (resolve, reject) {
      db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashed, userRole], function (err) {
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
      setClauses.push('role = ?');
      params.push(role);
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

export default router;
