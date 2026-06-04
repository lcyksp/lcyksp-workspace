import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'lcyksp-jwt-secret-dev-2026';

/** JWT 签名负载 — 携带 userId, username, role, groupId */
export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * JWT 鉴权中间件（可选解析）
 * 将 { userId, username, role, groupId } 注入 req.user
 * 无 Token 时 req.user = null（游客模式）
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role || 'user',
      groupId: decoded.groupId || null,
    };
  } catch {
    req.user = null;
  }
  next();
}

/**
 * 强制登录中间件 — 要求必须有有效 Token
 */
export function requireAuth(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

export default { signToken, authMiddleware, requireAuth };
