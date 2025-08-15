import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({limit:'5mb'}));

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-secret';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data.db';

// ensure db folder exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;
async function initDb(){
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY,
      currency TEXT DEFAULT 'ر.س',
      tax_income REAL DEFAULT 15.0,
      tax_expense REAL DEFAULT 15.0,
      monthly_expense_cap REAL DEFAULT 50000.0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      category TEXT NOT NULL,
      base REAL NOT NULL,
      tax REAL NOT NULL,
      total REAL NOT NULL,
      employee TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id,date);
    CREATE TABLE IF NOT EXISTS debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      employee TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('advance','repay')),
      amount REAL NOT NULL,
      delta REAL NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_debt_user_date ON debts(user_id,date);
  `);
}
await initDb();

function sign(u){ return jwt.sign({uid:u.id,email:u.email}, JWT_SECRET, {expiresIn:'7d'}); }
function auth(req,res,next){
  const h=req.headers.authorization||''; const tok=h.startsWith('Bearer ')? h.slice(7):'';
  try{ req.user = jwt.verify(tok, JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({error:'UNAUTHORIZED'}); }
}
function adminOnly(req,res,next){
  if(!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({error:'UNAUTHORIZED'});
  next();
}

// ---- Minimal UI (served from memory, no folders needed) ----
const UI = `<!doctype html>
<html lang="ar" dir="rtl"><meta charset="utf-8"/>
<title>لوحة الشركة — نسخة مدمجة</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
:root{--bg:#0b1020;--panel:#0e152b;--muted:#a9b1c7;--text:#e8ecf6;--brand:#5b8cff;--border:#1e2a46}
*{box-sizing:border-box}body{margin:0;background:#0b1020;color:var(--text);font-family:system-ui,'Noto Kufi Arabic',sans-serif}
.container{max-width:980px;margin:0 auto;padding:16px}
.card{background:#0f1833;border:1px solid var(--border);border-radius:14px;padding:14px;margin:10px 0}
label{display:block;margin:.5rem 0 .25rem;color:var(--muted);font-size:12px}
input,select,button{padding:10px;border-radius:10px;border:1px solid var(--border);background:#0a1226;color:var(--text)}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid var(--border);padding:8px;text-align:right}
.btn{cursor:pointer}
.grid{display:grid;gap:12px;grid-template-columns:1fr 1fr}
@media(max-width:820px){.grid{grid-template-columns:1fr}}
.toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:#0a1226;border:1px solid var(--border);padding:8px 12px;border-radius:10px}
</style>
<div class="container">
  <h2>لوحة الشركة — نسخة مدمجة (API + واجهة)</h2>
  <div class="card">
    <div class="grid">
      <div>
        <h3>تسجيل الدخول</h3>
        <label>API URL (مثال: https://your-api.onrender.com)</label>
        <input id="apiUrl" placeholder="اكتب رابط API ثم اضغط دخول"/>
        <label>الإيميل</label><input id="loginEmail" type="email"/>
        <label>كلمة المرور</label><input id="loginPass" type="password"/>
        <button id="btnLogin" class="btn">دخول</button>
      </div>
      <div>
        <h3>تسجيل جديد</h3>
        <label>API URL</label><input id="apiUrl2"/>
        <label>الإيميل</label><input id="regEmail" type="email"/>
        <label>كلمة المرور</label><input id="regPass" type="password"/>
        <label>اسم الشركة (اختياري)</label><input id="regCompany"/>
        <button id="btnRegister" class="btn">إنشاء</button>
      </div>
    </div>
    <div id="toast" class="toast" style="display:none"></div>
  </div>

  <div class="card" id="dash" style="display:none">
    <h3>إضافة عملية</h3>
    <div class="grid">
      <div>
        <label>التاريخ</label><input id="txDate" type="date"/>
        <label>النوع</label><select id="txType"><option value="income">دخل</option><option value="expense">مصروف</option></select>
        <label>الفئة</label><input id="txCat"/>
        <label>المبلغ قبل الضريبة</label><input id="txBase" inputmode="decimal"/>
        <label>الموظف</label><input id="txEmp"/>
        <label>ملاحظات</label><input id="txNotes"/>
        <button id="btnAddTx" class="btn">إضافة</button>
      </div>
      <div>
        <h4>آخر العمليات</h4>
        <table id="txTable"><thead><tr><th>التاريخ</th><th>النوع</th><th>الفئة</th><th>قبل الضريبة</th><th>الضريبة</th><th>الإجمالي</th><th>موظف</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>
</div>
<script>
(function(){
  const $=s=>document.querySelector(s); const toast=m=>{const t=$('#toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',1800)};
  let API=localStorage.getItem('API_URL')||''; let token=localStorage.getItem('token')||'';
  if(API) $('#apiUrl').value = API; if(API) $('#apiUrl2').value = API;
  async function api(path,opts={}){
    if(!API){ API = prompt('اكتب رابط API'); localStorage.setItem('API_URL', API||''); }
    const res = await fetch(API+path,{headers:{'Content-Type':'application/json','Authorization': token?('Bearer '+token):''},...opts});
    if(!res.ok){ let e=await res.json().catch(()=>({error:'ERR'})); throw new Error(e.error||res.status); }
    return res.json();
  }
  $('#btnRegister').onclick=async()=>{
    try{ const _api=$('#apiUrl2').value||$('#apiUrl').value||API||''; if(_api){API=_api;localStorage.setItem('API_URL',API);} 
      const data=await api('/auth/register',{method:'POST',body:JSON.stringify({email:$('#regEmail').value,password:$('#regPass').value,company_name:$('#regCompany').value})});
      token=data.token; localStorage.setItem('token',token); $('#dash').style.display=''; toast('تم التسجيل'); await loadTx();
    }catch(e){ toast('فشل التسجيل: '+e.message); }
  };
  $('#btnLogin').onclick=async()=>{
    try{ const _api=$('#apiUrl').value||API||''; if(_api){API=_api;localStorage.setItem('API_URL',API);} 
      const data=await api('/auth/login',{method:'POST',body:JSON.stringify({email:$('#loginEmail').value,password:$('#loginPass').value})});
      token=data.token; localStorage.setItem('token',token); $('#dash').style.display=''; toast('تم الدخول'); await loadTx();
    }catch(e){ toast('خطأ الدخول'); }
  };
  $('#btnAddTx').onclick=async()=>{
    try{ await api('/transactions',{method:'POST',body:JSON.stringify({date:$('#txDate').value||new Date().toISOString().slice(0,10),type:$('#txType').value,category:$('#txCat').value,base:Number(($('#txBase').value||'0').replace(',','.')),employee:$('#txEmp').value,notes:$('#txNotes').value})}); 
      $('#txCat').value=''; $('#txBase').value=''; $('#txEmp').value=''; $('#txNotes').value=''; await loadTx(); toast('تمت الإضافة'); }catch(e){ toast('فشل الإضافة: '+e.message); }
  };
  async function loadTx(){ const rows=await api('/transactions'); const tb=$('#txTable tbody'); tb.innerHTML=''; rows.slice(0,10).forEach(t=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${t.date}</td><td>${t.type==='income'?'دخل':'مصروف'}</td><td>${t.category}</td><td>${t.base}</td><td>${t.tax}</td><td>${t.total}</td><td>${t.employee||''}</td>`; tb.appendChild(tr); }); }
})();
</script>
</html>`;

app.get('/', (req,res)=> res.type('html').send(UI));

// ---- API Endpoints ----
app.post('/auth/register', async (req,res)=>{
  const {email,password,company_name} = req.body||{};
  if(!email || !password) return res.status(400).json({error:'email & password required'});
  const hash = await bcrypt.hash(password, 10);
  try{
    const r = await db.run('INSERT INTO users(email,password_hash,company_name) VALUES (?,?,?)',[String(email).trim().toLowerCase(),hash,company_name||null]);
    await db.run('INSERT INTO settings(user_id) VALUES (?)',[r.lastID]);
    const user = await db.get('SELECT id,email,company_name FROM users WHERE id=?',[r.lastID]);
    res.json({token:sign(user), user});
  }catch(e){
    if(String(e).includes('UNIQUE')) return res.status(409).json({error:'EMAIL_IN_USE'});
    res.status(500).json({error:'REG_FAILED', details:String(e)});
  }
});
app.post('/auth/login', async (req,res)=>{
  const {email,password} = req.body||{};
  const u = await db.get('SELECT * FROM users WHERE email=?',[String(email||'').trim().toLowerCase()]);
  if(!u) return res.status(401).json({error:'INVALID_CREDENTIALS'});
  const ok = await bcrypt.compare(password||'', u.password_hash);
  if(!ok) return res.status(401).json({error:'INVALID_CREDENTIALS'});
  res.json({token:sign(u), user:{id:u.id,email:u.email,company_name:u.company_name}});
});

app.get('/settings', auth, async (req,res)=>{
  const s = await db.get('SELECT currency,tax_income,tax_expense,monthly_expense_cap FROM settings WHERE user_id=?',[req.user.uid]);
  res.json(s||{});
});
app.put('/settings', auth, async (req,res)=>{
  const {currency,tax_income,tax_expense,monthly_expense_cap} = req.body||{};
  await db.run('UPDATE settings SET currency=COALESCE(?,currency), tax_income=COALESCE(?,tax_income), tax_expense=COALESCE(?,tax_expense), monthly_expense_cap=COALESCE(?,monthly_expense_cap) WHERE user_id=?',
    [currency,tax_income,tax_expense,monthly_expense_cap,req.user.uid]);
  const s = await db.get('SELECT currency,tax_income,tax_expense,monthly_expense_cap FROM settings WHERE user_id=?',[req.user.uid]);
  res.json(s);
});

app.get('/transactions', auth, async (req,res)=>{
  const rows = await db.all('SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC, created_at DESC',[req.user.uid]);
  res.json(rows);
});
app.post('/transactions', auth, async (req,res)=>{
  const {date,type,category,base,employee,notes} = req.body||{};
  if(!date||!type||!category||base==null) return res.status(400).json({error:'Missing fields'});
  const s = await db.get('SELECT tax_income,tax_expense FROM settings WHERE user_id=?',[req.user.uid]);
  const rate = (type==='income'? (s.tax_income||0) : (s.tax_expense||0))/100.0;
  const tax = Math.round((Number(base)||0)*rate*100)/100;
  const total = Math.round(((Number(base)||0)+tax)*100)/100;
  const r = await db.run('INSERT INTO transactions(user_id,date,type,category,base,tax,total,employee,notes) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.user.uid,date,type,category,base,tax,total,employee||null,notes||null]);
  const row = await db.get('SELECT * FROM transactions WHERE id=?',[r.lastID]);
  res.json(row);
});
app.put('/transactions/:id', auth, async (req,res)=>{
  const id = Number(req.params.id);
  const t = await db.get('SELECT * FROM transactions WHERE id=? AND user_id=?',[id,req.user.uid]);
  if(!t) return res.status(404).json({error:'NOT_FOUND'});
  const n = {...t, ...req.body};
  const s = await db.get('SELECT tax_income,tax_expense FROM settings WHERE user_id=?',[req.user.uid]);
  const rate = (n.type==='income'? (s.tax_income||0) : (s.tax_expense||0))/100.0;
  const base = Number(n.base||0);
  const tax = Math.round(base*rate*100)/100;
  const total = Math.round((base+tax)*100)/100;
  await db.run('UPDATE transactions SET date=?,type=?,category=?,base=?,tax=?,total=?,employee=?,notes=? WHERE id=? AND user_id=?',
    [n.date,n.type,n.category,base,tax,total,n.employee||null,n.notes||null,id,req.user.uid]);
  const row = await db.get('SELECT * FROM transactions WHERE id=?',[id]);
  res.json(row);
});
app.delete('/transactions/:id', auth, async (req,res)=>{
  await db.run('DELETE FROM transactions WHERE id=? AND user_id=?',[req.params.id, req.user.uid]);
  res.json({ok:true});
});

app.get('/debts', auth, async (req,res)=>{
  const rows = await db.all('SELECT * FROM debts WHERE user_id=? ORDER BY date ASC, created_at ASC',[req.user.uid]);
  res.json(rows);
});
app.post('/debts', auth, async (req,res)=>{
  const {date,employee,kind,amount,notes} = req.body||{};
  if(!date||!employee||!kind||amount==null) return res.status(400).json({error:'Missing fields'});
  const amt = Number(amount||0); const delta = (kind==='advance'? +amt : -amt);
  const r = await db.run('INSERT INTO debts(user_id,date,employee,kind,amount,delta,notes) VALUES (?,?,?,?,?,?,?)',
    [req.user.uid,date,employee,kind,amt,delta,notes||null]);
  const row = await db.get('SELECT * FROM debts WHERE id=?',[r.lastID]);
  res.json(row);
});
app.put('/debts/:id', auth, async (req,res)=>{
  const id = Number(req.params.id);
  const d = await db.get('SELECT * FROM debts WHERE id=? AND user_id=?',[id, req.user.uid]);
  if(!d) return res.status(404).json({error:'NOT_FOUND'});
  const n = {...d, ...req.body};
  const amt = Number(n.amount||0); const delta = (n.kind==='advance'? +amt : -amt);
  await db.run('UPDATE debts SET date=?,employee=?,kind=?,amount=?,delta=?,notes=? WHERE id=? AND user_id=?',
    [n.date,n.employee,n.kind,amt,delta,n.notes||null,id,req.user.uid]);
  const row = await db.get('SELECT * FROM debts WHERE id=?',[id]);
  res.json(row);
});
app.delete('/debts/:id', auth, async (req,res)=>{
  await db.run('DELETE FROM debts WHERE id=? AND user_id=?',[req.params.id, req.user.uid]);
  res.json({ok:true});
});

app.get('/admin/backup/json', async (req,res)=>{
  if(!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({error:'UNAUTHORIZED'});
  const users = await db.all('SELECT id,email,company_name,created_at FROM users');
  const settings = await db.all('SELECT * FROM settings');
  const transactions = await db.all('SELECT * FROM transactions');
  const debts = await db.all('SELECT * FROM debts');
  res.setHeader('Content-Disposition','attachment; filename="backup.json"');
  res.json({users,settings,transactions,debts,exported_at:new Date().toISOString()});
});
app.get('/admin/backup/sqlite', async (req,res)=>{
  if(!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({error:'UNAUTHORIZED'});
  res.setHeader('Content-Disposition','attachment; filename="data.db"');
  res.sendFile(path.resolve(DB_PATH));
});

app.listen(PORT, ()=> console.log('[OK] All-in-one API listening on', PORT, 'DB=', DB_PATH));
