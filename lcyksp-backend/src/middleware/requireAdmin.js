export function requireAdmin(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: '请先登录' })
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，仅管理员可执行此操作' })
  }

  next()
}

export default { requireAdmin }
