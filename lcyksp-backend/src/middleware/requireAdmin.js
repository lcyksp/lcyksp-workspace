/**
 * requireAdmin.js — 管理员权限强制校验中间件
 *
 * 必须配合 authMiddleware 使用（先解析 Token 再到 req.user）
 * 校验 req.user.role === 'admin'，否则返回 403
 */
export function requireAdmin(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，仅管理员可执行此操作' });
  }
  next();
}

export default { requireAdmin };
