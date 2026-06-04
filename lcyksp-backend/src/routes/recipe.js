/**
 * recipe.js — 赛博菜谱（AI Kitchen & Recipe Bank）
 *
 * 低消耗本地模糊检索 + AI 流式续写做法
 *
 * ⚠️ 安全提醒（存储型 XSS 防御）：
 * 前端在渲染菜名（name）、标签（tags）以及大模型返回的做法文本时，
 * 必须使用 Vue 标准插值表达式 {{ }}（即 v-text 语义），
 * 严禁使用 v-html 指令，防止恶意脚本注入。
 */
import { Router } from 'express';
import { getDb } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// 可选登录（仅为了记录 creator_id）
router.use(authMiddleware);

// ---------- 辅助：AI 续写做法 ----------
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const AI_TIMEOUT_MS = 30_000; // AI 流式请求 30 秒超时

/**
 * 调用 DeepSeek Chat API（stream=true），通过 SSE 将做法逐字泵给前端
 *
 * @param {object} recipe   - 菜谱记录
 * @param {object} res      - Express response 对象
 * @param {AbortSignal} signal - 用于客户端断开时中止 fetch
 */
async function streamRecipeSteps(recipe, res, signal) {
  if (!DEEPSEEK_API_KEY) {
    res.write(`data: ${JSON.stringify({ error: '未配置 AI API Key' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const prompt = `你是一名资深中餐厨师。请为以下菜谱写出详细的做法步骤，包括原料用量、火候、步骤分点：

菜名：${recipe.name}
原料：${recipe.ingredients || '未提供'}
标签：${recipe.tags || '未提供'}

请用中文，按步骤编号（1. 2. 3. ...），每步一句话，简洁实用。`;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个实用的中餐菜谱助手，回答简洁、步骤清晰。' },
          { role: 'user', content: prompt },
        ],
        stream: true,
      }),
      signal, // 客户端断开时 AbortController 会中止此请求；未设超时则由 AI_TIMEOUT_MS 兜底
    });

    if (!response.ok) {
      const errText = await response.text();
      res.write(`data: ${JSON.stringify({ error: `AI 请求失败 (${response.status}): ${errText}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 流式读取 DeepSeek SSE 响应
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      // 客户端已断开 → 中止读取，跳出循环
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 保留最后一个可能不完整的行
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            // 逐块泵给前端
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        } catch {
          // 跳过解析失败的行
        }
      }
    }

    // 消费剩余 buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        } catch { /* ignore */ }
      }
    }

    // 持久化 steps 到数据库
    const fullText = ''; // 后续可通过前端回写，简化处理
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[菜谱] AI 流式请求失败:', err.message);
    if (!res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: `AI 请求异常: ${err.message}` })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    res.end();
  }
}

// ===================================================================
//  API
// ===================================================================

// ---------- GET /api/recipe/search?q=关键词 — 模糊检索 ----------
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ recipes: [] });
    }

    const db = getDb();
    // 前缀匹配（右侧 `%`）让 idx_recipes_name 索引生效，避免全表扫描
    const like = `${q}%`;
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, name, ingredients, tags, steps, creator_id, created_at
         FROM recipes
         WHERE name LIKE ? OR tags LIKE ?
         ORDER BY created_at DESC
         LIMIT 50`,
        [like, like],
        (err, rows) => (err ? reject(err) : resolve(rows)),
      );
    });

    res.json({
      recipes: rows.map((r) => ({
        id: r.id,
        name: r.name,
        ingredients: r.ingredients,
        tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
        hasSteps: !!r.steps,
        creatorId: r.creator_id,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- POST /api/recipe — 添加自创菜式 ----------
router.post('/', async (req, res, next) => {
  try {
    const { name, ingredients, tags } = req.body || {};

    // 【必填】菜名校验：必须存在且非空白
    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: '菜名不能为空' });
    }
    if (name.length > 128) {
      return res.status(400).json({ error: '菜名不超过 128 个字符' });
    }

    const db = getDb();

    // 【安全防线】未登录态 N 层守护：
    //   即使 authMiddleware 未执行 或 req 对象异常，
    //   确保 creatorId 安全降级为 null，绝不抛异常
    let creatorId = null;
    try {
      if (req && req.user && typeof req.user.userId === 'number') {
        creatorId = req.user.userId;
      }
    } catch {
      // 任何意外都静默降级
    }

    // 【可选填】ingredients / tags：前端可以不传 / 传空字符串 / 传空数组
    // 统一归一化为空字符串写入数据库
    const safeIngredients = (typeof ingredients === 'string' && ingredients.trim())
      ? ingredients.trim()
      : '';
    const tagStr = Array.isArray(tags)
      ? tags.filter((t) => typeof t === 'string' && t.trim()).join(',')
      : (typeof tags === 'string' && tags.trim() ? tags : '');

    const result = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO recipes (name, ingredients, tags, creator_id) VALUES (?, ?, ?, ?)`,
        [name.trim(), safeIngredients, tagStr, creatorId],
        function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID });
        },
      );
    });

    res.status(201).json({
      message: '菜谱已添加',
      recipe: {
        id: result.id,
        name: name.trim(),
        ingredients: safeIngredients,
        tags: tagStr ? tagStr.split(',').filter(Boolean) : [],
        creatorId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- POST /api/recipe/:id/stream — SSE 流式续写做法 ----------
router.post('/:id/stream', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: '无效的菜谱 ID' });
    }

    const db = getDb();
    const recipe = await new Promise((resolve, reject) => {
      db.get(
        'SELECT id, name, ingredients, tags, steps FROM recipes WHERE id = ?',
        [id],
        (err, row) => (err ? reject(err) : resolve(row)),
      );
    });

    if (!recipe) {
      return res.status(404).json({ error: '菜谱不存在' });
    }

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    });

    // 先发送菜名信息
    res.write(`data: ${JSON.stringify({ meta: { name: recipe.name, ingredients: recipe.ingredients, tags: recipe.tags } })}\n\n`);

    // 创建 AbortController：客户端断开时取消 fetch，防止循环挂起
    const abortController = new AbortController();
    const signal = abortController.signal;

    // AI 请求超时保护（30 秒），即使客户端一直连接也要释放连接
    const timeoutTimer = setTimeout(() => abortController.abort(), AI_TIMEOUT_MS);

    // 监听客户端断开 → 立即中止 fetch + 安全结束 SSE
    req.on('close', () => {
      // 客户端主动关闭/刷新/断开
      console.log('[菜谱] 客户端断开 SSE 连接，正在释放资源');
      clearTimeout(timeoutTimer);
      abortController.abort();
      try {
        res.end();
      } catch { /* ignore: 连接已关闭 */ }
    });

    // 流式获取 AI 做法（内部处理所有异常和 res.end）
    await streamRecipeSteps(recipe, res, signal);

    // 正常完成 → 清除超时定时器
    clearTimeout(timeoutTimer);
  } catch (err) {
    // 如果是 abort 导致的错误，无需处理
    if (err.name === 'AbortError') return;

    // 如果 headers 已发送，不能再用 next(err)
    if (res.headersSent) {
      console.error('[菜谱] SSE 流异常:', err.message);
      try {
        res.write(`data: ${JSON.stringify({ error: `服务器异常: ${err.message}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch { /* ignore */ }
      return;
    }
    next(err);
  }
});

export default router;
