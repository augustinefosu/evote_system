// Authentication middleware backed by Supabase Auth.
//
// Drop-in replacement for the jsonwebtoken pair in server.js. The only change
// in behaviour is where identity comes from: the token is now minted and
// verified by Supabase rather than signed with a local JWT_SECRET, so there is
// no local signing secret to leak or rotate.
require('./env');
const { row, verifyAccessToken } = require('./supabase');

const USER_COLUMNS =
  'id, auth_id, student_id, name, email, role, faculty, department, level, verified, is_active';

function getTokenFromReq(req) {
  if (req.cookies && req.cookies.evs_token) return req.cookies.evs_token;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function authRequired(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let authUser;
  try {
    authUser = await verifyAccessToken(token);
  } catch (err) {
    console.error('[auth] verification error:', err.message);
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }
  if (!authUser) return res.status(401).json({ error: 'Session expired. Please log in again.' });

  let user;
  try {
    user = await row(`SELECT ${USER_COLUMNS} FROM users WHERE auth_id=$1`, [authUser.id]);
  } catch (err) {
    console.error('[auth] profile lookup failed:', err.message);
    return res.status(500).json({ error: 'Failed to load account' });
  }

  // Role is always re-read from the database so a demoted or disabled account
  // loses access immediately instead of when its token happens to expire.
  if (!user || !user.is_active) return res.status(401).json({ error: 'Account disabled or not found' });

  req.user = user;
  req.authUser = authUser;
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    return next();
  };
}

module.exports = { authRequired, requireRole, getTokenFromReq, USER_COLUMNS };