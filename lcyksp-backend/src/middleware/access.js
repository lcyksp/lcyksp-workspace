export function requirePremiumOrAdmin(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: '请先登录' })
  }

  if (req.user.role === 'admin' || req.user.role === 'premium' || req.user.role === 'pro') {
    return next()
  }

  return res.status(403).json({ error: '当前用户仅对高级用户开放' })
}

export function requireGalleryAccess(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: '请先登录' })
  }

  if (req.user.role === 'admin' || req.user.role === 'premium' || req.user.role === 'pro' || req.user.groupId) {
    return next()
  }

  return res.status(403).json({ error: '当前用户仅对高级用户开放' })
}

export default {
  requirePremiumOrAdmin,
  requireGalleryAccess,
}
