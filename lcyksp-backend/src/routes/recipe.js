/**
 * recipe.js — 赛博菜谱（AI Kitchen & Recipe Bank）
 *
 * 低消耗本地模糊检索 + AI 流式续写做法
 */
import { Router } from 'express';
import { getDb } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// 可选登录（仅为了记录 creator_id）
router.use(authMiddleware);

// ---------- 辅助：AI 续写做法 ----------
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

/**
 * 调用 DeepSeek Chat API（stream=true），通过 SSE 将做法逐字泵给前端
 */
async function streamRecipeSteps(recipe, res) {
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
    const like = `%${q}%`;
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
    const { name, ingredients, tags } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: '菜名不能为空' });
    }
    if (name.length > 128) {
      return res.status(400).json({ error: '菜名不超过 128 个字符' });
    }

    const db = getDb();
    const creatorId = req.user?.userId || null;
    const tagStr = Array.isArray(tags) ? tags.join(',') : (tags || '');

    const result = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO recipes (name, ingredients, tags, creator_id) VALUES (?, ?, ?, ?)`,
        [name.trim(), ingredients || '', tagStr, creatorId],
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
        ingredients: ingredients || '',
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

    // 流式获取 AI 做法（内部处理所有异常和 res.end）
    await streamRecipeSteps(recipe, res);
  } catch (err) {
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
