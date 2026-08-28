import { Router } from 'express'
import crypto from 'crypto'
import { getDb } from '../config/db.js'
import { authMiddleware, requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware, requireAuth)
const pendingOAuth = new Map()
const dbGet = (sql, p=[]) => new Promise((resolve,reject)=>getDb().get(sql,p,(e,r)=>e?reject(e):resolve(r)))
const dbAll = (sql, p=[]) => new Promise((resolve,reject)=>getDb().all(sql,p,(e,r)=>e?reject(e):resolve(r)))
const dbRun = (sql,p=[]) => new Promise((resolve,reject)=>getDb().run(sql,p,function(e){e?reject(e):resolve({lastID:this.lastID,changes:this.changes})}))
const cfg = () => ({ clientId: process.env.TWITCH_CLIENT_ID, clientSecret: process.env.TWITCH_CLIENT_SECRET, redirectUri: process.env.TWITCH_REDIRECT_URI || '' })

router.get('/oauth/start', (req,res) => {
  const c=cfg(); if (!c.clientId || !c.redirectUri) return res.status(503).json({error:'Twitch OAuth 尚未配置'})
  const state=crypto.randomBytes(24).toString('hex'); pendingOAuth.set(state,{userId:req.user.userId,expires:Date.now()+10*60*1000})
  const params=new URLSearchParams({client_id:c.clientId,redirect_uri:c.redirectUri,response_type:'code',scope:'user:read:email',state})
  res.json({url:'https://id.twitch.tv/oauth2/authorize?'+params})
})
router.get('/oauth/callback', async (req,res,next)=>{ try { const p=pendingOAuth.get(req.query.state); pendingOAuth.delete(req.query.state); if(!p||p.expires<Date.now()) return res.status(400).send('OAuth 状态已过期'); const c=cfg(); const tokenRes=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,code:req.query.code,grant_type:'authorization_code',redirect_uri:c.redirectUri})}); const token=await tokenRes.json(); if(!token.access_token) return res.status(400).send('Twitch 授权失败'); const userRes=await fetch('https://api.twitch.tv/helix/users',{headers:{'Client-ID':c.clientId,Authorization:'Bearer '+token.access_token}}); const u=(await userRes.json()).data?.[0]; if(!u) return res.status(400).send('无法读取 Twitch 用户'); await dbRun('INSERT INTO twitch_accounts (user_id,twitch_user_id,login,display_name,access_token,refresh_token,expires_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\')) ON CONFLICT(user_id,twitch_user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,display_name=excluded.display_name,updated_at=datetime(\'now\')',[p.userId,u.id,u.login,u.display_name,token.access_token,token.refresh_token||'',token.expires_in?new Date(Date.now()+token.expires_in*1000).toISOString():null]); res.send('Twitch 登录成功，可关闭此页面返回本站。') } catch(e){next(e)} })
async function helix(path){ const c=cfg(); if(!c.clientId) throw new Error('Twitch Client ID 未配置'); const r=await fetch('https://api.twitch.tv/helix/'+path,{headers:{'Client-ID':c.clientId,Authorization:'Bearer '+(process.env.TWITCH_APP_TOKEN||'')}}); if(!r.ok) throw new Error('Twitch API '+r.status); return r.json() }
router.get('/categories', async(req,res,next)=>{try{const q=String(req.query.query||'').trim(); if(!q)return res.json({data:[]}); res.json(await helix('search/categories?query='+encodeURIComponent(q)+'&first=20'))}catch(e){next(e)}})
router.get('/streams', async(req,res,next)=>{try{const id=String(req.query.gameId||'').trim(); if(!id)return res.json({data:[]}); res.json(await helix('streams?game_id='+encodeURIComponent(id)+'&first=50'))}catch(e){next(e)}})
router.get('/accounts', async(req,res,next)=>{try{res.json({accounts:await dbAll('SELECT id,login,display_name,created_at,updated_at FROM twitch_accounts WHERE user_id=? ORDER BY id DESC',[req.user.userId])})}catch(e){next(e)}})
router.post('/tasks', async(req,res,next)=>{try{const b=req.body||{}; for(const k of ['accountId','gameId','gameName','channelId','channelName','startAt','endAt']) if(!b[k]) return res.status(400).json({error:'缺少 '+k}); const a=await dbGet('SELECT id FROM twitch_accounts WHERE id=? AND user_id=?',[b.accountId,req.user.userId]); if(!a)return res.status(404).json({error:'Twitch 账号不存在'}); const r=await dbRun('INSERT INTO twitch_drop_tasks (user_id,account_id,game_id,game_name,channel_id,channel_name,start_at,end_at) VALUES (?,?,?,?,?,?,?,?)',[req.user.userId,b.accountId,b.gameId,b.gameName,b.channelId,b.channelName,new Date(b.startAt).toISOString(),new Date(b.endAt).toISOString()]); res.status(201).json({id:r.lastID})}catch(e){next(e)}})
router.get('/tasks', async(req,res,next)=>{try{res.json({tasks:await dbAll('SELECT * FROM twitch_drop_tasks WHERE user_id=? ORDER BY id DESC',[req.user.userId])})}catch(e){next(e)}})
router.post('/tasks/:id/stop', async(req,res,next)=>{try{const r=await dbRun("UPDATE twitch_drop_tasks SET status='cancelled',updated_at=datetime('now') WHERE id=? AND user_id=? AND status IN ('pending','running')",[req.params.id,req.user.userId]); if(!r.changes)return res.status(404).json({error:'任务不存在或已结束'}); res.json({success:true})}catch(e){next(e)}})
export default router
