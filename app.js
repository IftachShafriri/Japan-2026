(() => {
  'use strict';

  const CURRENCIES = {
    ILS: { symbol: '₪', decimals: 2, name: 'שקל ישראלי' },
    USD: { symbol: '$', decimals: 2, name: 'דולר אמריקאי' },
    JPY: { symbol: '¥', decimals: 0, name: 'ין יפני' }
  };
  const DEFAULT_CATEGORIES = ['🍔 אוכל','🏨 מלונות','🚆 תחבורה','🎟️ אטרקציות','🛍️ קניות','✈️ טיסות','🚕 מוניות','🎉 בילויים','📦 אחר'];
  const CONFIG = window.SPLITFLOW_CONFIG || {};
  const CLOUD_ENABLED = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase);
  const sb = CLOUD_ENABLED ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY) : null;
  const LS_KEY = 'splitflow_local_v1';

  const state = {
    user: null,
    groups: [], participants: [], expenses: [], splits: [], settlements: [], categories: [],
    currentGroupId: null, currentPage: 'dashboard', charts: [], filters: {}
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now();
  const today = () => new Date().toISOString().slice(0,10);
  const fmtDate = d => d ? new Intl.DateTimeFormat('he-IL').format(new Date(d+'T00:00:00')) : '';
  const info = (msg, error=false) => { const t=document.createElement('div');t.className='toast'+(error?' error':'');t.textContent=msg;$('#toastHost').appendChild(t);setTimeout(()=>t.remove(),2800); };
  const money = (minor,currency) => { const c=CURRENCIES[currency]; const val=Number(minor||0)/10**c.decimals; return `${c.symbol}${new Intl.NumberFormat('he-IL',{minimumFractionDigits:c.decimals,maximumFractionDigits:c.decimals}).format(val)}`; };
  const parseMoney = (value,currency) => { const c=CURRENCIES[currency]; const n=Number(String(value).replace(',','.')); if(!Number.isFinite(n)) throw new Error('סכום לא תקין'); return Math.round(n*10**c.decimals); };
  const currencyOptions = (selected='ILS') => Object.entries(CURRENCIES).map(([k,v])=>`<option value="${k}" ${k===selected?'selected':''}>${v.symbol} ${v.name} – ${k}</option>`).join('');
  const person = id => state.participants.find(p=>p.id===id);
  const currentGroup = () => state.groups.find(g=>g.id===state.currentGroupId);
  const groupItems = arr => arr.filter(x=>x.group_id===state.currentGroupId);

  function blankLocal(){ return {groups:[],participants:[],expenses:[],splits:[],settlements:[],categories:[]}; }
  function readLocal(){ try{return {...blankLocal(),...JSON.parse(localStorage.getItem(LS_KEY)||'{}')}}catch{return blankLocal()} }
  function writeLocal(){ localStorage.setItem(LS_KEY, JSON.stringify({groups:state.groups,participants:state.participants,expenses:state.expenses,splits:state.splits,settlements:state.settlements,categories:state.categories})); }

  async function dbLoad(){
    if(!CLOUD_ENABLED){ Object.assign(state,readLocal()); ensureLocalSeed(); return; }
    const tables=['groups','participants','expenses','expense_splits','settlements','categories'];
    const results=await Promise.all(tables.map(t=>sb.from(t).select('*').order('created_at',{ascending:true})));
    for(const r of results) if(r.error) throw r.error;
    state.groups=results[0].data; state.participants=results[1].data; state.expenses=results[2].data;
    state.splits=results[3].data; state.settlements=results[4].data; state.categories=results[5].data;
  }
  function ensureLocalSeed(){
    if(!state.groups.length){ const gid=uid(); state.groups.push({id:gid,name:'הקבוצה הראשונה',created_at:new Date().toISOString()}); state.currentGroupId=gid; writeLocal(); }
  }

  async function insert(table,row){
    if(!CLOUD_ENABLED){ const obj={id:uid(),created_at:new Date().toISOString(),...row}; ({groups:state.groups,participants:state.participants,expenses:state.expenses,expense_splits:state.splits,settlements:state.settlements,categories:state.categories}[table]).push(obj); writeLocal(); return obj; }
    const {data,error}=await sb.from(table).insert(row).select().single(); if(error) throw error; return data;
  }
  async function update(table,id,patch){
    if(!CLOUD_ENABLED){ const arr=({groups:state.groups,participants:state.participants,expenses:state.expenses,expense_splits:state.splits,settlements:state.settlements,categories:state.categories}[table]); const i=arr.findIndex(x=>x.id===id); arr[i]={...arr[i],...patch}; writeLocal(); return arr[i]; }
    const {data,error}=await sb.from(table).update(patch).eq('id',id).select().single(); if(error) throw error; return data;
  }
  async function remove(table,id){
    if(!CLOUD_ENABLED){ const map={groups:'groups',participants:'participants',expenses:'expenses',expense_splits:'splits',settlements:'settlements',categories:'categories'}; state[map[table]]=state[map[table]].filter(x=>x.id!==id); writeLocal(); return; }
    const {error}=await sb.from(table).delete().eq('id',id); if(error) throw error;
  }

  function calcCurrency(currency){
    const ps=groupItems(state.participants); const ex=groupItems(state.expenses).filter(e=>e.currency===currency); const ss=groupItems(state.settlements).filter(s=>s.currency===currency);
    const net=Object.fromEntries(ps.map(p=>[p.id,0])); const paid=Object.fromEntries(ps.map(p=>[p.id,0])); const owed=Object.fromEntries(ps.map(p=>[p.id,0]));
    ex.forEach(e=>{ if(net[e.payer_id]!==undefined){ net[e.payer_id]+=Number(e.amount_minor); paid[e.payer_id]+=Number(e.amount_minor); } state.splits.filter(s=>s.expense_id===e.id).forEach(s=>{ if(net[s.participant_id]!==undefined){ net[s.participant_id]-=Number(s.amount_minor); owed[s.participant_id]+=Number(s.amount_minor); } }); });
    ss.forEach(s=>{ if(net[s.from_participant_id]!==undefined) net[s.from_participant_id]+=Number(s.amount_minor); if(net[s.to_participant_id]!==undefined) net[s.to_participant_id]-=Number(s.amount_minor); });
    return {net,paid,owed,total:ex.reduce((a,e)=>a+Number(e.amount_minor),0)};
  }
  function directTransfers(currency){
    // שומר חובות ישירים בלבד: כל משתתף חייב ישירות למי ששילם עבורו.
    // אין קיזוז שרשרת בין A→B ו-B→C, ואין איחוד שלהם ל-A→C.
    const ledger=new Map();
    const ex=groupItems(state.expenses).filter(e=>e.currency===currency);
    ex.forEach(e=>{
      state.splits.filter(s=>s.expense_id===e.id).forEach(s=>{
        if(s.participant_id===e.payer_id) return; // מי ששילם עבור עצמו לא חייב לעצמו
        const amount=Number(s.amount_minor)||0;
        if(amount<=0) return;
        const key=`${s.participant_id}|${e.payer_id}`;
        ledger.set(key,(ledger.get(key)||0)+amount);
      });
    });

    // Settlement מפחית רק את החוב הישיר בין אותם שני אנשים ובאותו מטבע.
    groupItems(state.settlements).filter(s=>s.currency===currency).forEach(s=>{
      const key=`${s.from_participant_id}|${s.to_participant_id}`;
      ledger.set(key,Math.max(0,(ledger.get(key)||0)-Number(s.amount_minor||0)));
    });

    return [...ledger.entries()]
      .filter(([,amount])=>amount>0)
      .map(([key,amount])=>{const [from,to]=key.split('|');return {from,to,amount,currency};})
      .sort((a,b)=>(person(a.from)?.name||'').localeCompare(person(b.from)?.name||'','he') || (person(a.to)?.name||'').localeCompare(person(b.to)?.name||'','he'));
  }
  function allTransfers(){ return Object.keys(CURRENCIES).flatMap(directTransfers); }
  function directDebtAmount(from,to,currency){ return directTransfers(currency).find(t=>t.from===from&&t.to===to)?.amount||0; }
  function personMetrics(id){
    const out={}; for(const c of Object.keys(CURRENCIES)){ const x=calcCurrency(c); out[c]={paid:x.paid[id]||0,owed:x.owed[id]||0,net:x.net[id]||0}; } return out;
  }
  function currencyLines(obj, field=null){ return Object.keys(CURRENCIES).map(c=>{ const val=field?obj[c]?.[field]||0:obj[c]||0; return `<div class="currency-line"><span>${c}</span><strong>${money(val,c)}</strong></div>`; }).join(''); }

  function setPage(page){ state.currentPage=page; $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===page)); const meta={dashboard:['Dashboard','תמונת מצב של הקבוצה'],expenses:['Expenses','כל ההוצאות במקום אחד'],balances:['Balances','מי חייב למי'],people:['People','משתתפים וסיכומים'],statistics:['Statistics','גרפים ותובנות'],settlements:['Settlements','היסטוריית החזרי תשלום']}[page]; $('#pageTitle').textContent=meta[0]; $('#pageSubtitle').textContent=meta[1]; render(); closeMobileMenu(); }
  function render(){ renderGroupSelect(); ({dashboard:renderDashboard,expenses:renderExpenses,balances:renderBalances,people:renderPeople,statistics:renderStatistics,settlements:renderSettlements}[state.currentPage])(); }
  function renderGroupSelect(){ $('#groupSelect').innerHTML=state.groups.map(g=>`<option value="${g.id}" ${g.id===state.currentGroupId?'selected':''}>${esc(g.name)}</option>`).join(''); }
  function noGroup(){ if(!state.currentGroupId){ $('#content').innerHTML=`<div class="card empty"><h2>אין עדיין קבוצה</h2><p>צור קבוצה חדשה כדי להתחיל.</p><button class="btn primary" onclick="document.getElementById('newGroupBtn').click()">+ יצירת קבוצה</button></div>`; return true;} return false; }

  function renderDashboard(){
    if(noGroup())return; const totals={}; const paid={}; const owed={}; Object.keys(CURRENCIES).forEach(c=>{const x=calcCurrency(c);totals[c]=x.total;paid[c]=Object.values(x.paid).reduce((a,b)=>a+b,0);owed[c]=Object.values(x.owed).reduce((a,b)=>a+b,0)}); const transfers=allTransfers(); const ps=groupItems(state.participants);
    const peopleCards=ps.map(p=>{const m=personMetrics(p.id);return `<div class="card person-card" data-person="${p.id}"><div class="row-between"><div class="top-payer"><div class="avatar">${esc(p.name).slice(0,1)}</div><strong>${esc(p.name)}</strong></div><span class="muted">פרטים ←</span></div><div class="person-metrics"><div class="mini-metric"><small>שילם</small>${Object.keys(CURRENCIES).map(c=>`<div>${money(m[c].paid,c)}</div>`).join('')}</div><div class="mini-metric"><small>אמור לשלם</small>${Object.keys(CURRENCIES).map(c=>`<div>${money(m[c].owed,c)}</div>`).join('')}</div><div class="mini-metric"><small>נטו</small>${Object.keys(CURRENCIES).map(c=>`<div class="${m[c].net>=0?'kpi-positive':'kpi-negative'}">${money(m[c].net,c)}</div>`).join('')}</div></div></div>`}).join('');
    $('#content').innerHTML=`<div class="grid cards"><div class="card stat-card"><div class="label">סה״כ הוצאות</div><div class="big">${Object.keys(CURRENCIES).map(c=>`<div>${money(totals[c],c)}</div>`).join('')}</div></div><div class="card stat-card"><div class="label">משתתפים</div><div class="big">${ps.length}</div></div><div class="card stat-card"><div class="label">הוצאות שנרשמו</div><div class="big">${groupItems(state.expenses).length}</div></div><div class="card stat-card"><div class="label">העברות פתוחות</div><div class="big">${transfers.length}</div></div></div><section class="section"><div class="section-head"><h2>מי חייב למי</h2><button class="btn ghost small" data-go="balances">לכל החובות</button></div>${balanceHtml(transfers.slice(0,6),true)}</section><section class="section"><div class="section-head"><h2>משתתפים</h2><button class="btn ghost small" id="quickAddPerson">+ הוסף משתתף</button></div><div class="grid cards">${peopleCards||'<div class="card empty">אין משתתפים עדיין.</div>'}</div></section>`;
    bindCommon(); $('#quickAddPerson')?.addEventListener('click',()=>openPersonModal());
  }

  function balanceHtml(transfers,compact=false){
    if(!transfers.length)return `<div class="card empty">אין חובות פתוחים 🎉</div>`;
    return `<div class="balance-list">${transfers.map(t=>`<div class="balance-row"><span class="person-link" data-person="${t.from}">${esc(person(t.from)?.name||'')}</span><span class="arrow">← חייב ל־</span><span class="person-link" data-person="${t.to}">${esc(person(t.to)?.name||'')}</span><div><strong class="money">${money(t.amount,t.currency)}</strong>${compact?'':` <button class="btn primary small settle-btn" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}" data-currency="${t.currency}">סומן כשולם</button>`}</div></div>`).join('')}</div>`;
  }
  function renderBalances(){ if(noGroup())return; $('#content').innerHTML=`<div class="card"><div class="section-head"><h2>חובות ישירים</h2><span class="muted">ללא קיזוז שרשרת · כל חוב נשאר בין מי שחייב למי ששילם</span></div>${balanceHtml(allTransfers())}</div>`; bindCommon(); $$('.settle-btn').forEach(b=>b.addEventListener('click',()=>openSettlementModal(b.dataset))); }

  function renderExpenses(){
    if(noGroup())return; const ps=groupItems(state.participants); const f=state.filters; let ex=groupItems(state.expenses);
    if(f.q) ex=ex.filter(e=>[e.description,e.category,person(e.payer_id)?.name].join(' ').toLowerCase().includes(f.q.toLowerCase())); if(f.payer)ex=ex.filter(e=>e.payer_id===f.payer); if(f.currency)ex=ex.filter(e=>e.currency===f.currency); if(f.date)ex=ex.filter(e=>e.expense_date===f.date); if(f.participant) ex=ex.filter(e=>state.splits.some(s=>s.expense_id===e.id&&s.participant_id===f.participant));
    ex.sort((a,b)=>(b.expense_date||'').localeCompare(a.expense_date||''));
    const rows=ex.map(e=>{const sp=state.splits.filter(s=>s.expense_id===e.id);return `<tr><td>${fmtDate(e.expense_date)}</td><td><strong>${esc(e.description)}</strong><div class="chips"><span class="chip category">${esc(e.category||'📦 אחר')}</span></div></td><td>${esc(person(e.payer_id)?.name||'')}</td><td class="money">${money(e.amount_minor,e.currency)}</td><td><span class="chip currency">${e.currency}</span></td><td><div class="chips">${sp.map(s=>`<span class="chip">${esc(person(s.participant_id)?.name||'')}</span>`).join('')}</div></td><td>${e.split_type==='custom'?'מותאמת':'שווה'}</td><td class="actions"><button class="btn small edit-expense" data-id="${e.id}">עריכה</button><button class="btn small danger delete-expense" data-id="${e.id}">מחיקה</button></td></tr>`}).join('');
    $('#content').innerHTML=`<div class="filters"><input id="fQ" placeholder="חיפוש חופשי..." value="${esc(f.q||'')}"><select id="fParticipant"><option value="">כל המשתתפים</option>${ps.map(p=>`<option value="${p.id}" ${f.participant===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select><select id="fPayer"><option value="">כל המשלמים</option>${ps.map(p=>`<option value="${p.id}" ${f.payer===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select><select id="fCurrency"><option value="">כל המטבעות</option>${Object.keys(CURRENCIES).map(c=>`<option ${f.currency===c?'selected':''}>${c}</option>`).join('')}</select><input id="fDate" type="date" value="${esc(f.date||'')}"></div><div class="table-wrap"><table class="table"><thead><tr><th>תאריך</th><th>תיאור</th><th>מי שילם</th><th>סכום</th><th>מטבע</th><th>עבור מי</th><th>חלוקה</th><th>פעולות</th></tr></thead><tbody>${rows||`<tr><td colspan="8" class="empty">לא נמצאו הוצאות.</td></tr>`}</tbody></table></div>`;
    ['fQ','fParticipant','fPayer','fCurrency','fDate'].forEach(id=>$('#'+id).addEventListener('input',e=>{state.filters[{fQ:'q',fParticipant:'participant',fPayer:'payer',fCurrency:'currency',fDate:'date'}[id]]=e.target.value;renderExpenses()})); $$('.edit-expense').forEach(b=>b.addEventListener('click',()=>openExpenseModal(b.dataset.id))); $$('.delete-expense').forEach(b=>b.addEventListener('click',()=>deleteExpense(b.dataset.id)));
  }

  function renderPeople(){ if(noGroup())return; const ps=groupItems(state.participants); $('#content').innerHTML=`<div class="section-head"><h2>משתתפים</h2><button id="addPersonBtn" class="btn primary">+ משתתף</button></div><div class="grid cards">${ps.map(p=>{const m=personMetrics(p.id);return `<div class="card person-card" data-person="${p.id}"><div class="row-between"><div class="top-payer"><div class="avatar">${esc(p.name).slice(0,1)}</div><div><strong>${esc(p.name)}</strong><div class="muted small-text">לחץ לפרטים</div></div></div><div class="actions"><button class="btn small edit-person" data-id="${p.id}">עריכה</button><button class="btn small danger delete-person" data-id="${p.id}">מחיקה</button></div></div><div class="divider"></div>${Object.keys(CURRENCIES).map(c=>`<div class="currency-line"><span>${c}: שילם ${money(m[c].paid,c)}</span><strong class="${m[c].net>=0?'kpi-positive':'kpi-negative'}">נטו ${money(m[c].net,c)}</strong></div>`).join('')}</div>`}).join('')||'<div class="card empty">אין משתתפים.</div>'}</div>`; bindCommon(); $('#addPersonBtn').addEventListener('click',()=>openPersonModal()); $$('.edit-person').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openPersonModal(b.dataset.id)})); $$('.delete-person').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();deletePerson(b.dataset.id)})); }

  function renderStatistics(){
    if(noGroup())return; destroyCharts(); $('#content').innerHTML=`<div class="charts"><div class="card chart-card"><h3>מי שילם כמה — לפי מטבע</h3><canvas id="paidChart"></canvas></div><div class="card chart-card"><h3>הוצאות לפי קטגוריה</h3><canvas id="categoryChart"></canvas></div><div class="card chart-card"><h3>הוצאות לאורך זמן</h3><canvas id="timeChart"></canvas></div><div class="card chart-card"><h3>המובילים בתשלום</h3><div id="topPayers"></div></div></div>`;
    const ps=groupItems(state.participants); const datasets=Object.keys(CURRENCIES).map(c=>({label:c,data:ps.map(p=>calcCurrency(c).paid[p.id]/10**CURRENCIES[c].decimals)})); state.charts.push(new Chart($('#paidChart'),{type:'bar',data:{labels:ps.map(p=>p.name),datasets},options:{responsive:true,maintainAspectRatio:false}}));
    const cats=[...new Set(groupItems(state.expenses).map(e=>e.category||'📦 אחר'))]; const catSets=Object.keys(CURRENCIES).map(c=>({label:c,data:cats.map(cat=>groupItems(state.expenses).filter(e=>e.currency===c&&(e.category||'📦 אחר')===cat).reduce((a,e)=>a+Number(e.amount_minor),0)/10**CURRENCIES[c].decimals)})); state.charts.push(new Chart($('#categoryChart'),{type:'bar',data:{labels:cats,datasets:catSets},options:{responsive:true,maintainAspectRatio:false}}));
    const dates=[...new Set(groupItems(state.expenses).map(e=>e.expense_date))].sort(); const timeSets=Object.keys(CURRENCIES).map(c=>({label:c,data:dates.map(d=>groupItems(state.expenses).filter(e=>e.currency===c&&e.expense_date===d).reduce((a,e)=>a+Number(e.amount_minor),0)/10**CURRENCIES[c].decimals)})); state.charts.push(new Chart($('#timeChart'),{type:'line',data:{labels:dates.map(fmtDate),datasets:timeSets},options:{responsive:true,maintainAspectRatio:false}}));
    $('#topPayers').innerHTML=Object.keys(CURRENCIES).map(c=>{const x=calcCurrency(c);const sorted=ps.map(p=>({p,n:x.paid[p.id]})).sort((a,b)=>b.n-a.n).slice(0,3);return `<div class="section"><strong>${c}</strong>${sorted.map((x,i)=>`<div class="row-between" style="padding:10px 0"><span>${i+1}. ${esc(x.p.name)}</span><strong>${money(x.n,c)}</strong></div>`).join('')||'<div class="muted">אין נתונים</div>'}</div>`}).join('');
  }
  function destroyCharts(){ state.charts.forEach(c=>c.destroy()); state.charts=[]; }

  function renderSettlements(){ if(noGroup())return; const ss=groupItems(state.settlements).sort((a,b)=>(b.settlement_date||'').localeCompare(a.settlement_date||'')); $('#content').innerHTML=`<div class="section-head"><h2>היסטוריית Settlements</h2><button id="manualSettlementBtn" class="btn primary">+ החזר ידני</button></div><div class="table-wrap"><table class="table"><thead><tr><th>תאריך</th><th>מי שילם</th><th>למי</th><th>סכום</th><th>מטבע</th><th>הערה</th><th></th></tr></thead><tbody>${ss.map(s=>`<tr><td>${fmtDate(s.settlement_date)}</td><td>${esc(person(s.from_participant_id)?.name||'')}</td><td>${esc(person(s.to_participant_id)?.name||'')}</td><td class="money">${money(s.amount_minor,s.currency)}</td><td>${s.currency}</td><td>${esc(s.note||'')}</td><td><button class="btn small danger undo-settlement" data-id="${s.id}">ביטול</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">אין החזרים עדיין.</td></tr>'}</tbody></table></div>`; $('#manualSettlementBtn').addEventListener('click',()=>openSettlementModal()); $$('.undo-settlement').forEach(b=>b.addEventListener('click',()=>undoSettlement(b.dataset.id))); }

  function bindCommon(){ $$('[data-go]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.go))); $$('[data-person]').forEach(el=>el.addEventListener('click',()=>openPersonDetails(el.dataset.person))); }

  function modal(html){ $('#modalContent').innerHTML=html; $('#modal').showModal(); $$('.modal-close').forEach(b=>b.addEventListener('click',()=>$('#modal').close())); }
  function modalFrame(title,body,submit='שמירה'){ return `<form id="modalForm" class="modal-box"><div class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn modal-close">✕</button></div>${body}<div class="modal-footer"><button class="btn primary" type="submit">${submit}</button><button class="btn ghost modal-close" type="button">ביטול</button></div></form>`; }

  function openGroupModal(){ modal(modalFrame('קבוצה חדשה',`<label>שם הקבוצה<input id="groupName" required placeholder="למשל: יפן 2026"></label>`,'יצירה')); $('#modalForm').onsubmit=async e=>{e.preventDefault();try{const g=await insert('groups',{name:$('#groupName').value.trim(),...(CLOUD_ENABLED?{user_id:state.user.id}:{})});if(CLOUD_ENABLED) state.groups.push(g); state.currentGroupId=g.id; $('#modal').close(); render();info('הקבוצה נוצרה');}catch(err){info(err.message,true)}}; }

  function openPersonModal(id=null){ const p=id?person(id):null; modal(modalFrame(p?'עריכת משתתף':'משתתף חדש',`<label>שם<input id="personName" required value="${esc(p?.name||'')}" placeholder="שם המשתתף"></label>`)); $('#modalForm').onsubmit=async e=>{e.preventDefault();try{if(p){await update('participants',p.id,{name:$('#personName').value.trim()});p.name=$('#personName').value.trim();}else{const x=await insert('participants',{group_id:state.currentGroupId,name:$('#personName').value.trim(),...(CLOUD_ENABLED?{user_id:state.user.id}:{})});if(CLOUD_ENABLED)state.participants.push(x);}$('#modal').close();await refresh();info('נשמר בהצלחה');}catch(err){info(err.message,true)}}; }

  async function deletePerson(id){ if(state.expenses.some(e=>e.payer_id===id)||state.splits.some(s=>s.participant_id===id)||state.settlements.some(s=>s.from_participant_id===id||s.to_participant_id===id)){info('אי אפשר למחוק משתתף שיש לו הוצאות או settlements. אפשר לשנות את שמו במקום.',true);return;} if(!confirm('למחוק את המשתתף?'))return; try{await remove('participants',id);state.participants=state.participants.filter(p=>p.id!==id);render();}catch(e){info(e.message,true)} }

  function categoryOptions(selected=''){ const custom=groupItems(state.categories).map(c=>c.name); return [...DEFAULT_CATEGORIES,...custom].map(c=>`<option ${c===selected?'selected':''}>${esc(c)}</option>`).join(''); }
  function openExpenseModal(id=null){
    const ex=id?state.expenses.find(e=>e.id===id):null; const ps=groupItems(state.participants); if(!ps.length){info('קודם צריך להוסיף לפחות משתתף אחד',true);setPage('people');return;} const oldSplits=ex?state.splits.filter(s=>s.expense_id===id):[]; const selectedIds=new Set(oldSplits.map(s=>s.participant_id));
    modal(modalFrame(ex?'עריכת הוצאה':'הוצאה חדשה',`<div class="modal-grid"><label class="full">תיאור<input id="eDesc" required value="${esc(ex?.description||'')}" placeholder="למשל: מלון"></label><label>מי שילם<select id="ePayer">${ps.map(p=>`<option value="${p.id}" ${p.id===ex?.payer_id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>תאריך<input id="eDate" type="date" required value="${ex?.expense_date||today()}"></label><label>סכום<input id="eAmount" type="number" min="0" step="0.01" required value="${ex?Number(ex.amount_minor)/10**CURRENCIES[ex.currency].decimals:''}"></label><label>מטבע<select id="eCurrency">${currencyOptions(ex?.currency||'ILS')}</select></label><label>קטגוריה<select id="eCategory">${categoryOptions(ex?.category||'📦 אחר')}</select></label><label>קטגוריה חדשה <small>אופציונלי</small><input id="eCustomCategory" placeholder="למשל: ספא"></label><div class="full"><div class="row-between"><strong>על מי שילמו?</strong><button id="selectAllPeople" type="button" class="btn small ghost">כולם</button></div><div class="checkbox-grid" id="peopleChecks">${ps.map(p=>`<label class="check-row"><input type="checkbox" value="${p.id}" ${!ex||selectedIds.has(p.id)?'checked':''}>${esc(p.name)}</label>`).join('')}</div></div><div class="full"><strong>אופן חלוקה</strong><div class="segmented" style="margin-top:8px"><button type="button" data-split="equal" class="${ex?.split_type!=='custom'?'active':''}">חלוקה שווה</button><button type="button" data-split="custom" class="${ex?.split_type==='custom'?'active':''}">מותאמת אישית</button></div><input id="splitType" type="hidden" value="${ex?.split_type||'equal'}"></div><div id="customSplits" class="full"></div><div id="splitNotice" class="full"></div></div>`));
    const renderCustom=()=>{const ids=$$('#peopleChecks input:checked').map(x=>x.value);const cur=$('#eCurrency').value;const existing=Object.fromEntries(oldSplits.map(s=>[s.participant_id,Number(s.amount_minor)/10**CURRENCIES[ex?.currency||cur].decimals]));$('#customSplits').innerHTML=$('#splitType').value==='custom'?`<div class="card" style="box-shadow:none"><strong>סכום לכל משתתף</strong><div style="display:grid;gap:8px;margin-top:10px">${ids.map(pid=>`<label class="split-row"><span>${esc(person(pid)?.name||'')}</span><input class="custom-split-input" data-pid="${pid}" type="number" min="0" step="${CURRENCIES[cur].decimals?'.01':'1'}" value="${existing[pid]??''}" required></label>`).join('')}</div></div>`:'';};
    $$('#peopleChecks input').forEach(x=>x.addEventListener('change',renderCustom)); $('#selectAllPeople').onclick=()=>{$$('#peopleChecks input').forEach(x=>x.checked=true);renderCustom()}; $$('[data-split]').forEach(b=>b.onclick=()=>{$$('[data-split]').forEach(x=>x.classList.toggle('active',x===b));$('#splitType').value=b.dataset.split;renderCustom()}); $('#eCurrency').onchange=()=>{const c=CURRENCIES[$('#eCurrency').value];$('#eAmount').step=c.decimals?'.01':'1';renderCustom()}; renderCustom();
    $('#modalForm').onsubmit=async e=>{e.preventDefault(); try{const selected=$$('#peopleChecks input:checked').map(x=>x.value);if(!selected.length)throw new Error('צריך לבחור לפחות משתתף אחד');const currency=$('#eCurrency').value;const amount=parseMoney($('#eAmount').value,currency);if(amount<=0)throw new Error('הסכום חייב להיות גדול מאפס');let splits=[];if($('#splitType').value==='equal'){const base=Math.floor(amount/selected.length),rem=amount-base*selected.length;splits=selected.map((pid,i)=>({participant_id:pid,amount_minor:base+(i<rem?1:0)}));}else{splits=$$('.custom-split-input').map(x=>({participant_id:x.dataset.pid,amount_minor:parseMoney(x.value,currency)}));const sum=splits.reduce((a,s)=>a+s.amount_minor,0);if(sum!==amount)throw new Error(`סכום החלוקה חייב להיות בדיוק ${money(amount,currency)}. כרגע: ${money(sum,currency)}`);}let category=$('#eCustomCategory').value.trim()||$('#eCategory').value;if($('#eCustomCategory').value.trim()&&!groupItems(state.categories).some(c=>c.name===category)){await insert('categories',{group_id:state.currentGroupId,name:category,...(CLOUD_ENABLED?{user_id:state.user.id}:{})});}
      const row={group_id:state.currentGroupId,description:$('#eDesc').value.trim(),payer_id:$('#ePayer').value,amount_minor:amount,currency,expense_date:$('#eDate').value,category,split_type:$('#splitType').value,...(CLOUD_ENABLED?{user_id:state.user.id}:{})}; let expenseId=id;
      if(ex){await update('expenses',id,row); if(CLOUD_ENABLED){const {error}=await sb.from('expense_splits').delete().eq('expense_id',id);if(error)throw error;}else{state.splits=state.splits.filter(s=>s.expense_id!==id);writeLocal();}}
      else{const created=await insert('expenses',row);expenseId=created.id;if(CLOUD_ENABLED)state.expenses.push(created);}
      if(CLOUD_ENABLED){const payload=splits.map(s=>({...s,expense_id:expenseId,group_id:state.currentGroupId,user_id:state.user.id}));const {error}=await sb.from('expense_splits').insert(payload);if(error)throw error;}else{splits.forEach(s=>state.splits.push({id:uid(),created_at:new Date().toISOString(),expense_id:expenseId,group_id:state.currentGroupId,...s}));writeLocal();}
      $('#modal').close();await refresh();info('ההוצאה נשמרה');
    }catch(err){info(err.message,true)}};
  }

  async function deleteExpense(id){ if(!confirm('למחוק את ההוצאה? החובות יתעדכנו מיד.'))return; try{if(CLOUD_ENABLED){const {error}=await sb.from('expense_splits').delete().eq('expense_id',id);if(error)throw error;}else state.splits=state.splits.filter(s=>s.expense_id!==id);await remove('expenses',id);state.expenses=state.expenses.filter(e=>e.id!==id);writeLocal();render();info('ההוצאה נמחקה');}catch(e){info(e.message,true)} }

  function openSettlementModal(pref={}){ const ps=groupItems(state.participants); if(ps.length<2){info('צריך לפחות שני משתתפים',true);return;} const cur=pref.currency||'ILS'; const amt=pref.amount?Number(pref.amount)/10**CURRENCIES[cur].decimals:''; modal(modalFrame('סימון החזר תשלום',`<div class="modal-grid"><label>מי שילם<select id="sFrom">${ps.map(p=>`<option value="${p.id}" ${p.id===pref.from?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>למי<select id="sTo">${ps.map(p=>`<option value="${p.id}" ${p.id===pref.to?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>סכום<input id="sAmount" type="number" min="0" step="0.01" required value="${amt}"></label><label>מטבע<select id="sCurrency">${currencyOptions(cur)}</select></label><label>תאריך<input id="sDate" type="date" value="${today()}" required></label><label>הערה<input id="sNote" placeholder="אופציונלי"></label></div>`,'סומן כשולם')); $('#modalForm').onsubmit=async e=>{e.preventDefault();try{if($('#sFrom').value===$('#sTo').value)throw new Error('המשלם והמקבל חייבים להיות שונים');const currency=$('#sCurrency').value;const amount=parseMoney($('#sAmount').value,currency);const from=$('#sFrom').value,to=$('#sTo').value;const openDebt=directDebtAmount(from,to,currency);if(amount<=0)throw new Error('הסכום חייב להיות גדול מאפס');if(openDebt<=0)throw new Error('אין חוב ישיר פתוח בין המשתתפים האלה במטבע שנבחר');if(amount>openDebt)throw new Error(`הסכום גבוה מהחוב הישיר הפתוח (${money(openDebt,currency)})`);const x=await insert('settlements',{group_id:state.currentGroupId,from_participant_id:from,to_participant_id:to,amount_minor:amount,currency,settlement_date:$('#sDate').value,note:$('#sNote').value.trim(),...(CLOUD_ENABLED?{user_id:state.user.id}:{})});if(CLOUD_ENABLED)state.settlements.push(x);$('#modal').close();await refresh();info('החזר התשלום נשמר');}catch(err){info(err.message,true)}}; }
  async function undoSettlement(id){ if(!confirm('לבטל את ההחזר? החוב יחזור מיד.'))return;try{await remove('settlements',id);state.settlements=state.settlements.filter(s=>s.id!==id);render();info('ה-settlement בוטל');}catch(e){info(e.message,true)} }

  function openPersonDetails(id){ const p=person(id);if(!p)return;const m=personMetrics(id);const participated=groupItems(state.expenses).filter(e=>state.splits.some(s=>s.expense_id===e.id&&s.participant_id===id));const paid=groupItems(state.expenses).filter(e=>e.payer_id===id);const transferIn=allTransfers().filter(t=>t.to===id),transferOut=allTransfers().filter(t=>t.from===id);modal(`<div class="modal-box"><div class="modal-head"><h2>${esc(p.name)}</h2><button type="button" class="icon-btn modal-close">✕</button></div><div class="grid cards" style="grid-template-columns:repeat(3,1fr)"><div class="mini-metric"><small>שילם</small>${Object.keys(CURRENCIES).map(c=>`<div>${money(m[c].paid,c)}</div>`).join('')}</div><div class="mini-metric"><small>אמור לשלם</small>${Object.keys(CURRENCIES).map(c=>`<div>${money(m[c].owed,c)}</div>`).join('')}</div><div class="mini-metric"><small>נטו</small>${Object.keys(CURRENCIES).map(c=>`<div class="${m[c].net>=0?'kpi-positive':'kpi-negative'}">${money(m[c].net,c)}</div>`).join('')}</div></div><div class="section"><h3>חייב לאחרים</h3>${balanceHtml(transferOut,true)}</div><div class="section"><h3>אחרים חייבים לו</h3>${balanceHtml(transferIn,true)}</div><div class="section"><h3>הוצאות שבהן השתתף (${participated.length})</h3><div class="chips">${participated.map(e=>`<span class="chip">${esc(e.description)} — ${money(e.amount_minor,e.currency)}</span>`).join('')||'<span class="muted">אין</span>'}</div></div><div class="section"><h3>הוצאות ששילם עליהן (${paid.length})</h3><div class="chips">${paid.map(e=>`<span class="chip">${esc(e.description)} — ${money(e.amount_minor,e.currency)}</span>`).join('')||'<span class="muted">אין</span>'}</div></div></div>`); $$('.modal-close').forEach(b=>b.addEventListener('click',()=>$('#modal').close())); }

  async function refresh(){ await dbLoad(); if(!state.currentGroupId||!state.groups.some(g=>g.id===state.currentGroupId))state.currentGroupId=state.groups[0]?.id||null; render(); }
  function exportCSV(){ const ex=groupItems(state.expenses); const lines=[['date','description','payer','amount','currency','category','participants','split_type'],...ex.map(e=>{const c=CURRENCIES[e.currency];return[e.expense_date,e.description,person(e.payer_id)?.name||'',Number(e.amount_minor)/10**c.decimals,e.currency,e.category,state.splits.filter(s=>s.expense_id===e.id).map(s=>person(s.participant_id)?.name).join('|'),e.split_type]})]; const csv='\ufeff'+lines.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n'); const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=`splitflow-${currentGroup()?.name||'group'}.csv`;a.click();URL.revokeObjectURL(a.href); }
  function exportPDF(){ const ex=groupItems(state.expenses).sort((a,b)=>(b.expense_date||'').localeCompare(a.expense_date||'')); const w=window.open('','_blank'); if(!w){info('הדפדפן חסם את חלון ה-PDF. אפשר פופאפים לאתר ונסה שוב.',true);return;} const rows=ex.map(e=>`<tr><td>${fmtDate(e.expense_date)}</td><td>${esc(e.description)}</td><td>${esc(person(e.payer_id)?.name||'')}</td><td>${money(e.amount_minor,e.currency)}</td><td>${e.currency}</td><td>${esc(e.category||'')}</td></tr>`).join(''); w.document.write(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>SplitFlow - ${esc(currentGroup()?.name||'')}</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#111827}h1{margin:0 0 6px}p{color:#64748b}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #e5e7eb;padding:9px;text-align:right}th{background:#f8fafc}@media print{body{padding:0}}</style></head><body><h1>SplitFlow — ${esc(currentGroup()?.name||'')}</h1><p>דוח הוצאות</p><table><thead><tr><th>תאריך</th><th>תיאור</th><th>מי שילם</th><th>סכום</th><th>מטבע</th><th>קטגוריה</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),100)<\/script></body></html>`); w.document.close(); }

  function openMobileMenu(){ $('.sidebar').classList.add('open');$('#mobileOverlay').classList.remove('hidden'); }
  function closeMobileMenu(){ $('.sidebar').classList.remove('open');$('#mobileOverlay').classList.add('hidden'); }

  async function initAuth(){
    if(!CLOUD_ENABLED){ $('#authView').classList.add('hidden');$('#appShell').classList.remove('hidden');$$('.cloud-only').forEach(x=>x.classList.add('hidden'));await refresh();info('מצב מקומי פעיל — חבר Supabase לסנכרון בין מכשירים');return; }
    const {data:{session}}=await sb.auth.getSession(); if(session){state.user=session.user;showApp();await refresh();}else showAuth(); sb.auth.onAuthStateChange(async(_,session2)=>{state.user=session2?.user||null;if(session2){showApp();await refresh();}else showAuth();});
  }
  function showAuth(){ $('#appShell').classList.add('hidden');$('#authView').classList.remove('hidden'); }
  function showApp(){ $('#authView').classList.add('hidden');$('#appShell').classList.remove('hidden'); }

  let authMode='login'; $$('[data-auth-tab]').forEach(b=>b.onclick=()=>{authMode=b.dataset.authTab;$$('[data-auth-tab]').forEach(x=>x.classList.toggle('active',x===b));$('#authSubmitText').textContent=authMode==='login'?'התחברות':'הרשמה';$('#authHint').textContent=authMode==='login'?'אין לך חשבון? עבור להרשמה.':'כבר יש לך חשבון? עבור להתחברות.';});
  $('#authForm').onsubmit=async e=>{e.preventDefault();if(!CLOUD_ENABLED)return;try{const email=$('#authEmail').value,password=$('#authPassword').value;if(authMode==='login'){const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;}else{const {error}=await sb.auth.signUp({email,password});if(error)throw error;info('נרשמת. אם אימות אימייל פעיל ב-Supabase, אשר את המייל ואז התחבר.');}}catch(err){info(err.message,true)}};
  $('#logoutBtn').onclick=()=>sb?.auth.signOut();
  $('#newGroupBtn').onclick=openGroupModal; $('#addExpenseBtn').onclick=()=>openExpenseModal(); $('#groupSelect').onchange=e=>{state.currentGroupId=e.target.value;state.filters={};render()}; $('#exportCsvBtn').onclick=exportCSV; $('#exportPdfBtn').onclick=exportPDF; $('#mobileMenuBtn').onclick=openMobileMenu; $('#mobileOverlay').onclick=closeMobileMenu; $$('.nav-item').forEach(b=>b.onclick=()=>setPage(b.dataset.page));

  initAuth().catch(e=>{console.error(e);info('שגיאה בטעינת האתר: '+e.message,true)});
})();
