const {app,BrowserWindow,ipcMain,dialog,Menu,shell,nativeTheme,safeStorage}=require('electron');
const path=require('path'),fs=require('fs');
// 데이터 위치: exe 옆에 data 폴더가 있으면(바탕화면 폴더판) 그대로, 설치판은 [문서\Y-MATH시간표 데이터]
const EXEDIR=app.isPackaged?path.dirname(process.execPath):path.join(__dirname,'..');
const ROOT=process.env.YMT_ROOT||(fs.existsSync(path.join(EXEDIR,'data'))||fs.existsSync(path.join(EXEDIR,'portable.txt'))?EXEDIR:path.join(app.getPath('documents'),'Y-MATH시간표 데이터'));
const DATA=path.join(ROOT,'data'),BAK=path.join(DATA,'backup'),OUT=path.join(ROOT,'PDF');
const FILE=path.join(DATA,'timetable.json');
for(const d of [DATA,BAK,OUT])fs.mkdirSync(d,{recursive:true});
app.setName('Y-MATH 시간표');
// 창은 하나만: 이미 켜져 있으면 새로 켜지 않고 기존 창을 앞으로
if(!process.env.YMT_MULTI&&!app.requestSingleInstanceLock()){app.quit();process.exit(0)}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus()}});
let win,zoom=0,lastBak=0;
function stamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`}
function backup(){
  if(!fs.existsSync(FILE)||Date.now()-lastBak<30*60*1000)return;
  lastBak=Date.now();fs.copyFileSync(FILE,path.join(BAK,`timetable_${stamp()}.json`));
  const list=fs.readdirSync(BAK).filter(f=>f.startsWith('timetable_')).sort();
  while(list.length>60)fs.unlinkSync(path.join(BAK,list.shift()));
}
/* 적용 기록은 history.json에 따로 — timetable.json·draft.json에 들어 있던 옛 기록은 처음 읽을 때 옮김 (파일이 작아져 저장·동기화가 가벼움) */
const HISTF=path.join(DATA,'history.json');
function histRead(){try{const a=JSON.parse(fs.readFileSync(HISTF,'utf8'));return Array.isArray(a)?a:[]}catch(e){return []}}
function stripHist(txt,file){if(!txt||txt.indexOf('"history"')<0)return txt;let d;try{d=JSON.parse(txt)}catch(e){return txt}if(!Array.isArray(d.history))return txt;
  if(file===FILE&&d.history.length){const cur=histRead();const ids=new Set(cur.map(h=>h&&h.id));d.history.forEach(h=>{if(h&&h.id&&!ids.has(h.id))cur.push(h)});cur.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));if(cur.length>200)cur.length=200;wr(HISTF,JSON.stringify(cur))}
  delete d.history;const out=JSON.stringify(d);try{if(file)wr(file,out)}catch(e){}return out}
ipcMain.handle('load',()=>fs.existsSync(FILE)?stripHist(fs.readFileSync(FILE,'utf8'),FILE):null);
ipcMain.handle('histLoad',()=>histRead());
ipcMain.handle('histSave',(e,txt)=>{wr(HISTF,txt);return true});
ipcMain.handle('save',(e,txt,o)=>{backup();if(!(o&&o.quiet))setTimeout(()=>{try{nasLater()}catch(err){}},0);const tmp=FILE+'.tmp';fs.writeFileSync(tmp,txt,'utf8');fs.renameSync(tmp,FILE);return true});
ipcMain.handle('pdf',async(e,o)=>{
  const buf=await win.webContents.printToPDF({landscape:!!o.landscape,pageSize:o.pageSize||'A4',printBackground:true,margins:{marginType:'custom',top:0.25,bottom:0.25,left:0.25,right:0.25}});
  const r=await dialog.showSaveDialog(win,{title:'PDF 저장',defaultPath:path.join(OUT,(o.name||'시간표')+'.pdf'),filters:[{name:'PDF',extensions:['pdf']}]});
  if(r.canceled||!r.filePath)return {saved:false};
  fs.writeFileSync(r.filePath,buf);shell.openPath(r.filePath);return {saved:true,path:r.filePath};
});
ipcMain.handle('exportFile',async(e,o)=>{
  const r=await dialog.showSaveDialog(win,{title:'백업 저장',defaultPath:path.join(ROOT,o.name),filters:[{name:'JSON',extensions:['json']}]});
  if(r.canceled||!r.filePath)return {saved:false};fs.writeFileSync(r.filePath,o.text,'utf8');return {saved:true,path:r.filePath};
});
const DRAFT=path.join(DATA,'draft.json');
ipcMain.handle('saveDraft',(e,txt)=>{const tmp=DRAFT+'.tmp';fs.writeFileSync(tmp,txt,'utf8');fs.renameSync(tmp,DRAFT);return true});
ipcMain.handle('loadDraft',()=>fs.existsSync(DRAFT)?stripHist(fs.readFileSync(DRAFT,'utf8'),DRAFT):null);
ipcMain.handle('clearDraft',()=>{if(fs.existsSync(DRAFT))fs.unlinkSync(DRAFT);return true});
ipcMain.handle('backupNamed',(e,txt,label)=>{fs.writeFileSync(path.join(BAK,`timetable_${label||'백업'}_${stamp()}.json`),txt,'utf8');return true});
// 창 닫기·새로고침 직전 마지막 저장 (동기)
ipcMain.on('saveSync',(e,txt,isDraft)=>{try{const f=isDraft?DRAFT:FILE;if(!isDraft){backup();setTimeout(()=>{try{nasLater()}catch(err){}},0)}fs.writeFileSync(f+'.tmp',txt,'utf8');fs.renameSync(f+'.tmp',f);e.returnValue=true}catch(err){e.returnValue=false}});

/* ================= 폰으로 보기: 같은 와이파이 안에서 보기 전용 웹 화면 =================
   PC가 작은 웹서버가 됨. 폰은 http://PC주소:포트 로 접속 → mobile.html → view.json(PIN 확인).
   view.json은 [적용]된 시간표(timetable.json)만 씀 (수정 중 초안은 안 나감).
   나중에 인터넷 서버로 옮길 때도 mobile.html + view.json 구조 그대로 쓰면 됨. */
const http=require('http'),os=require('os');
const MOB=path.join(DATA,'mobile.json');
let mob={on:false,pin:'',port:8787},srv=null,srvErr='';
try{mob=Object.assign(mob,JSON.parse(fs.readFileSync(MOB,'utf8')))}catch(e){}
function lanIPs(){const out=[];Object.values(os.networkInterfaces()).forEach(a=>(a||[]).forEach(i=>{if(i.family==='IPv4'&&!i.internal&&!/^169\.254/.test(i.address))out.push(i.address)}));return out}
/* ===== 연락처: 선생님마다 '연락처 코드'로 따로 잠금 — 그 선생님 반(지금 시간표·특강) 학생 것만, 코드를 아는 선생님 폰에서만 풀림 =====
   (폰용 파일 전체는 선생님용 번호로 한 번 더 잠김) · 같은 내용이면 같은 암호문을 다시 써서 '내용 같으면 안 올림'이 그대로 동작 */
const CT_IT=200000,CTK={},CTC={};
function ctKey(code,br,tid){const salt=crypto.createHash('sha256').update('ymath-ct\0'+br+'\0'+tid).digest().subarray(0,16);const k=code+'|'+salt.toString('hex');
  return CTK[k]||(CTK[k]=crypto.pbkdf2Sync(String(code),salt,CT_IT,32,'sha256'))}
// 그 선생님 반·특강 학생의 연락처(학생·보호자). withEmpty면 번호 없는 담당 학생도 {}로 넣음(= 담당이지만 번호 없음)
function ctPlain(b,v,t,withEmpty){const digits=x=>String(x||'').replace(/\D/g,'');const ids=new Set();(v.classes||[]).forEach(c=>((c.members||{})[t.id]||[]).forEach(id=>ids.add(id)));(b.specials||[]).filter(x=>x.t===t.id).forEach(x=>(x.members||[]).forEach(id=>ids.add(id)));
  const m={};(b.students||[]).forEach(st=>{if(!ids.has(st.id))return;const ph=digits(st.ph),pa=(st.pa||[]).filter(x=>digits(x.n)).map(x=>({l:String(x.l||'학부모').slice(0,10),n:digits(x.n)}));if(ph||pa.length)m[st.id]={...(ph?{p:ph}:{}),...(pa.length?{a:pa}:{})};else if(withEmpty)m[st.id]={}});return m}
function ctPack(b,v){const out={};
  (b.teachers||[]).forEach(t=>{if(!t.ck)return;const m=ctPlain(b,v,t,false);
    const pt=JSON.stringify(m);const ck=b.id+'|'+t.id+'|'+t.ck;const h=crypto.createHash('sha256').update(pt).digest('hex');
    if(CTC[ck]&&CTC[ck].h===h){out[t.id]=CTC[ck].o;return}
    const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',ctKey(t.ck,b.id,t.id),iv);const ct=Buffer.concat([c.update(Buffer.from(pt,'utf8')),c.final(),c.getAuthTag()]);
    const o={it:CT_IT,iv:iv.toString('base64'),ct:ct.toString('base64'),n:Object.keys(m).length};CTC[ck]={h,o};out[t.id]=o});
  return out}
/* ===== 강사용 v2: 선생님마다 개인 코드로 로그인 — 이름이 있는 지점만 열림 =====
   지점마다 새 열쇠로 따로 잠그고, 선생님(이름)마다 '열쇠 묶음'(볼 수 있는 지점 열쇠 + 담당 학생 연락처)을 개인 코드로 잠금.
   개인 코드 → PBKDF2(소금은 저장소마다 고정 → 폰은 한 번 만든 키를 계속 씀) → HMAC으로 묶음 번호(id)와 잠금 열쇠.
   같은 이름 = 같은 선생님(여러 지점에 있으면 그 지점들 모두). '모든 지점 보기'(t.all, 관리자만 켬)면 전 지점. */
const LG_IT=300000,LGK={};
function lgSalt(){return crypto.createHash('sha256').update('ymath-login-v1\0'+String((mob.ghOwner||'')+'/'+(mob.ghRepo||'')).toLowerCase()).digest().subarray(0,16)}
function lgKey(code,salt){const k=code+'|'+salt.toString('hex');if(!LGK[k]){LGK[k]=new Promise((res,rej)=>crypto.pbkdf2(Buffer.from(String(code),'utf8'),salt,LG_IT,32,'sha256',(e,d)=>e?rej(e):res(d)));LGK[k].catch(()=>{delete LGK[k]})}return LGK[k]}
const lgH=(k,s)=>crypto.createHmac('sha256',k).update(s).digest();
function lgSeal(key,obj){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',key,iv);const ct=Buffer.concat([c.update(Buffer.from(JSON.stringify(obj),'utf8')),c.final(),c.getAuthTag()]);return {iv:iv.toString('base64'),ct:ct.toString('base64')}}
async function encV2(v,extra){let db;try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){db={branches:[]}}
  const salt=lgSalt();const nm=x=>String(x||'').replace(/\s+/g,'');const kc=crypto.randomBytes(32),kb={},br={};
  v.branches.forEach(b=>{const k=crypto.randomBytes(32);kb[b.id]=k;const o=Object.assign({},b);delete o.ct;br[b.id]=lgSeal(k,o)});
  const com=lgSeal(kc,Object.assign({at:v.at},extra||{}));
  const ppl={};(db.branches||[]).filter(b=>kb[b.id]).forEach(b=>{const ver=(b.versions||[]).find(x=>x.id===b.current)||(b.versions||[])[0]||{classes:[],sessions:[]};
    (b.teachers||[]).forEach(t=>{const k=nm(t.name);if(k)(ppl[k]=ppl[k]||[]).push({b,t,ver})})});
  const ctAll=b=>{const digits=x=>String(x||'').replace(/\D/g,'');const m={};(b.students||[]).filter(st=>st.status!=='퇴원').forEach(st=>{const ph=digits(st.ph),pa=(st.pa||[]).filter(x=>digits(x.n)).map(x=>({l:String(x.l||'학부모').slice(0,10),n:digits(x.n)}));m[st.id]=ph||pa.length?{...(ph?{p:ph}:{}),...(pa.length?{a:pa}:{})}:{}});return m};
  const inqPack=b=>(b.inq||[]).filter(q=>q.st==='open'||q.st==='cancel').map(q=>({id:q.id,name:q.name,school:q.school||'',grade:q.grade||'',ph:q.ph||'',pa:(q.pa||[]).map(x=>({l:x.l||'',n:x.n||'',...(x.nm?{nm:x.nm}:{})})),want:q.want||'',reg:q.reg||'',src:q.src||'',st:q.st,cancelAt:q.cancelAt||''}));
  const mgPack=b=>{const c=b.cns||{};return {inq:inqPack(b),
    out:(b.students||[]).filter(st=>st.status==='퇴원').map(st=>({id:st.id,name:st.name,school:st.school||'',grade:st.grade||'',out:st.out||''})),
    cns:{per:c.per||0,kper:c.kper||0,exam:!!c.exam,start:c.start||'',hold:Object.fromEntries(Object.entries(c.hold||{}).map(([k,v])=>[k,{why:(v&&v.why)||'',at:(v&&v.at)||''}]))},
    exam:exPack(db,b).exam}};
  const u=[],sig=[];
  for(const rs of Object.values(ppl)){const codes=[...new Set(rs.map(r=>String(r.t.ck||'')).filter(c=>/^\d{6}$/.test(c)))];if(!codes.length)continue;
    const all=rs.some(r=>r.t.all);const bids=all?v.branches.map(b=>b.id):[...new Set(rs.map(r=>r.b.id))];
    const ct={};rs.forEach(r=>{ct[r.b.id]=Object.assign(ct[r.b.id]||{},ctPlain(r.b,r.ver,r.t,true))});
    const mk={};rs.forEach(r=>{if((r.b.mgr||[]).includes(r.t.id)&&r.b.mgk)mk[r.b.id]=r.b.mgk});const mq={};Object.keys(mk).forEach(id=>{const mb=rs.find(r=>r.b.id===id).b;ct[id]=Object.assign({},ctAll(mb),ct[id]||{});mq[id]=mgPack(mb)}); /* 지점장: 그 지점 학생 연락처 전체 */
    const P={kc:kc.toString('base64'),kb:Object.fromEntries(bids.map(id=>[id,kb[id].toString('base64')])),me:rs.map(r=>({br:r.b.id,t:r.t.id})),nm:rs[0].t.name,all:all?1:0,ct,...(Object.keys(mk).length?{mk,mq}:{})};
    for(const c of codes){const dk=await lgKey(c,salt);u.push({id:lgH(dk,'ymath-id').subarray(0,12).toString('base64'),...lgSeal(lgH(dk,'ymath-wrap'),P)});sig.push(c+':'+bids.join('+')+':'+all+':'+crypto.createHash('sha256').update(JSON.stringify([ct,mk,mq])).digest('hex'))}}
  /* 행정 선생님(지점마다 b.staff): 개인 코드 · 모든 지점 · 학생 전체 연락처 · 내 수업 없음 */
  const sts=[];(db.branches||[]).filter(b=>kb[b.id]).forEach(b=>(b.staff||[]).forEach(a=>{if(/^\d{6}$/.test(String(a.ck||''))&&nm(a.name))sts.push({b,a})}));
  if(sts.length){const ctA={};(db.branches||[]).filter(b=>kb[b.id]).forEach(b=>{ctA[b.id]=ctAll(b)});const allK=Object.fromEntries(v.branches.map(b=>[b.id,kb[b.id].toString('base64')]));const ctH=crypto.createHash('sha256').update(JSON.stringify(ctA)).digest('hex');
    const byC={};for(const {b,a} of sts){const c=String(a.ck);if(!byC[c])byC[c]={b,a}} // 같은 사람(여러 지점·같은 코드)은 묶음 하나 · 소속은 앞 지점
    for(const [c,{b,a}] of Object.entries(byC)){const P={kc:kc.toString('base64'),kb:allK,me:[],nm:a.name,role:'admin',home:b.id,all:1,ct:ctA};const dk=await lgKey(c,salt);
      u.push({id:lgH(dk,'ymath-id').subarray(0,12).toString('base64'),...lgSeal(lgH(dk,'ymath-wrap'),P)});sig.push('A'+c+':'+nm(a.name)+':'+b.id+':'+ctH)}}
  /* 프로그램 관리자 폰(b.own · 10자리 코드): 전 지점 · 학생 전체 연락처 · 관리용 추가 자료(ox) · 폰 요청 서명 키(ak) */
  {const ob=(db.branches||[]).find(b=>kb[b.id]&&b.own&&/^\d{10}$/.test(String(b.own.ck||''))&&b.own.ak);
    if(ob){const own=ob.own;const ctA={};(db.branches||[]).filter(b=>kb[b.id]).forEach(b=>{ctA[b.id]=ctAll(b)});
      const ox={};(db.branches||[]).filter(b=>kb[b.id]).forEach(b=>{const c=b.cns||{};
        ox[b.id]={...mgPack(b),
          mstat:Object.fromEntries(Object.keys(b.mstat||{}).sort().slice(-13).map(k=>[k,b.mstat[k]]))}});
      const mine=ppl[nm(own.nm)]||[];const P={kc:kc.toString('base64'),kb:Object.fromEntries(v.branches.map(b=>[b.id,kb[b.id].toString('base64')])),me:mine.map(r=>({br:r.b.id,t:r.t.id})),nm:own.nm||'',role:'owner',home:(mine[0]&&mine[0].b.id)||ob.id,all:1,ct:ctA,ak:own.ak,ox};
      const dk=await lgKey(String(own.ck),salt);u.push({id:lgH(dk,'ymath-id').subarray(0,12).toString('base64'),...lgSeal(lgH(dk,'ymath-wrap'),P)});
      sig.push('O'+own.ck+':'+crypto.createHash('sha256').update(JSON.stringify([P.me,P.nm,P.home,own.ak,ctA,ox])).digest('hex'))}}
  for(let i=u.length-1;i>0;i--){const j=crypto.randomInt(i+1);[u[i],u[j]]=[u[j],u[i]]} // 순서로 누군지 짐작 못 하게
  const o=Object.assign({},v);delete o.at;
  const h=crypto.createHash('sha256').update(JSON.stringify(o)+'\0'+JSON.stringify(extra||{})+'\0'+sig.sort().join(',')).digest('hex').slice(0,32);
  return {app:'ymath-view',enc:2,kdf:'pbkdf2-sha256',it:LG_IT,salt:salt.toString('base64'),h,com,br,u}}
/* 학교 정보(db.schools)에서 지점의 중등·고등 시험 기간 — 렌더러 examPeriods와 같은 규칙 */
const exTd=()=>new Date(Date.now()+9*3600e3).toISOString().slice(0,10);const exPlus=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const exNorm=n=>String(n||'').trim().replace('여자고등학교','여고').replace('고등학교','고').replace('중학교','중').replace('초등학교','초').replace(/\s+/g,'');const exKind=n=>/여고$|고$/.test(n)?'고':/중$/.test(n)?'중':'';const exStuKind=s=>{const m=/^(초|중|고)/.exec(s.grade||'');return m?m[1]:exKind(exNorm(s.school))};
const EXLAB={m1:'1학기 중간',f1:'1학기 기말',m2:'2학기 중간',f2:'2학기 기말'};
function exSchool(db,k){const o=((db.schools||{}).list||{})[k];if(!o)return [];const out=[];Object.entries(o.cal||{}).forEach(([y,c])=>['m1','f1','m2','f2'].forEach(mk=>{const r=c[mk];if(r&&r[0]&&r[1])out.push({ek:`${y}|${mk[1]}|${mk[0]==='m'?'중간':'기말'}`,from:r[0],to:r[1],lab:EXLAB[mk],dm:Object.entries(c.dm||{}).filter(([d])=>d>=r[0]&&d<=r[1]).map(([d,t])=>({d,t}))})}));return out.sort((a,z)=>a.from.localeCompare(z.from))}
const exPadOf=(b,kd)=>Object.assign({a:14,z:7},((b&&b.exPad)||{})[kd]||{});const exPadP=(b,kd,p)=>{if(!p||!p.from)return p;const q=exPadOf(b,kd);return Object.assign({},p,{mf:exPlus(p.from,-q.a),mt:exPlus(p.to,q.z)})};
function exPeriods(db,b){const td=exTd();const out={};if(b.examAuto===false){out.중=b.exam&&b.exam.from?{from:b.exam.from,to:b.exam.to}:null;out.고=b.examH&&b.examH.from?{from:b.examH.from,to:b.examH.to}:out.중;out.중=exPadP(b,'중',out.중);out.고=exPadP(b,'고',out.고);return out}
  ['중','고'].forEach(kd=>{const ks=new Set((b.students||[]).filter(s=>s.status!=='퇴원'&&s.status!=='휴원'&&s.status!=='예정'&&exStuKind(s)===kd).map(s=>exNorm(s.school)).filter(Boolean));const ps=[];const z=exPadOf(b,kd).z;ks.forEach(k=>exSchool(db,k).forEach(x=>{if(x.to>=exPlus(td,-z))ps.push(x)}));ps.sort((a,z)=>a.from.localeCompare(z.from));
    const C=[];ps.forEach(p=>{const c=C[C.length-1];if(c&&p.from<=exPlus(c.to,7)){if(p.to>c.to)c.to=p.to}else C.push({from:p.from,to:p.to})});const c=C.find(c=>exPlus(c.to,z)>=td)||null;out[kd]=exPadP(b,kd,c?{from:c.from,to:c.to}:(b.exam&&b.exam.from?{from:b.exam.from,to:b.exam.to}:null))});return out}
function exPack(db,b){const td=exTd();const P=exPeriods(db,b);const both=[P.중,P.고].filter(x=>x&&x.from&&x.to);const exam=both.length?{from:both.map(x=>x.mf).sort()[0],to:both.map(x=>x.mt).sort().pop()}:null; /* 폰 응원·예전 폰: 관리 기간 합친 것 */
  const ks=new Set((b.students||[]).filter(s=>s.status!=='퇴원').map(s=>exNorm(s.school)).filter(k=>k&&exKind(k)));const lim=exPlus(td,60);const exl=[],rng={};
  ks.forEach(k=>{const o=((db.schools||{}).list||{})[k]||{};const kd=exKind(k);const z=exPadOf(b,kd).z;const x=exSchool(db,k).find(x=>exPlus(x.to,z)>=td);if(!x||x.from>lim)return;const nm=(o.base&&o.base.name)||k;const pp=exPadP(b,kd,{from:x.from,to:x.to});exl.push({k,nm,kd,lab:x.lab,from:x.from,to:x.to,mf:pp.mf,mt:pp.mt,al:(o.base&&o.base.alias)||[],dm:x.dm.map(d=>[d.d,d.t])});
    Object.entries(o.rng||{}).forEach(([rk,r])=>{if(!rk.startsWith(x.ek+'|')||!r||(!r.a&&!r.z&&!r.free))return;const un=p=>(p||[]).filter(Boolean).pop()||'';let t=r.free&&!(r.a&&r.a.length)?r.free:(un(r.a)&&un(r.z)?(un(r.a)===un(r.z)?un(r.a):`${un(r.a)} ~ ${un(r.z)}`):(un(r.a)||un(r.z)||''));if(r.memo)t+=` · ${r.memo}`;if(r.free&&(r.a&&r.a.length))t+=` (${r.free})`;rng[`${k}|${rk.split('|').slice(3).join('|')}`]=t})});
  return {exam,exams:{중:P.중||null,고:P.고||null},...(exl.length?{exl,rng}:{})}}
function publicView(){let db;try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){return null}
  const at=Math.max(0,...(db.branches||[]).map(b=>(b._sync&&b._sync.at)||0))||fs.statSync(FILE).mtimeMs; // 적용 시각: 연동 중엔 모든 PC가 같은 값
  return {app:'ymath-view',at,branches:(db.branches||[]).map(b=>{const v=(b.versions||[]).find(x=>x.id===b.current)||(b.versions||[])[0]||{classes:[],sessions:[]};
    return {id:b.id,name:b.name,version:v.name||'',days:b.days,teachers:(b.teachers||[]).map(t=>({id:t.id,name:t.name,off:t.off||[]})),
      students:(b.students||[]).filter(st=>st.status!=='퇴원').map(st=>({id:st.id,name:st.name,grade:st.grade||'',school:st.school||'',away:st.status==='휴원',...(st.from?{from:st.from}:{}),...(st.status==='예정'?{pre:1}:{}),...(st.cs?{cs:st.cs,csBy:st.csBy||''}:{}),...(st.key?{key:1}:{}),...(st.subj&&Object.keys(st.subj).length?{subj:st.subj}:{})})),
      noteLabel:b.noteLabel||'보강',notes:(b.notes||[]).filter(n=>!n.until||n.until>=new Date(Date.now()+9*3600e3).toISOString().slice(0,10)).map(n=>({d:n.d,p:n.p,t:n.t,k:n.k||b.noteLabel||'보강',cls:n.cls||'',names:n.names||'',...(n.until?{cnt:n.cnt,from:n.from,until:n.until}:{})})),
      specials:(b.specials||[]).map(s=>({id:s.id,name:s.name,color:s.color,t:s.t,days:s.days||[],start:s.start,dur:s.dur,from:s.from||'',to:s.to||'',members:s.members||[]})),
      classes:(v.classes||[]).map(c=>({id:c.id,name:c.name,color:c.color,members:c.members||{}})),
      sessions:(v.sessions||[]).map(o=>({id:o.id,cls:o.cls,t:o.t,d:o.d,p:o.p})),
      ct:ctPack(b,v),
      // 정기 상담: 주기 설정 · 최근 기록(200일) · 보류 · 지정 상담(대기) — 강사용이 '상담할 학생'을 스스로 계산
      ...(b.cns&&(b.cns.per||b.cns.exam||b.cns.kper)?{cns:{per:b.cns.per||0,kper:b.cns.kper||0,exam:!!b.cns.exam,start:b.cns.start||'',rec:(b.cns.recs||[]).filter(r=>r.at>=new Date(Date.now()-200*864e5).toISOString().slice(0,10)).map(r=>[r.sid,r.at,r.by||'']),hold:Object.keys(b.cns.hold||{}),asg:(b.cns.asg||[]).filter(x=>!x.done).map(x=>({id:x.id,sid:x.sid,t:x.t||'',note:x.note||'',by:x.by||'',at:x.at||''}))}}:{}),
      ...(()=>{const e=exPack(db,b);return {...(e.exam?{exam:e.exam}:{}),exams:e.exams,...(e.exl?{exl:e.exl,rng:e.rng}:{})}})(),
      tk:(()=>{const W=new Set((b.teachers||[]).map(t=>String(t.name||'').replace(/\s+/g,'').replace(/T$/,'')));return Object.values(((db.tasks||{}).list)||{}).filter(t=>t&&!t.del&&!t.done&&String(t.who||'').split(',').some(n=>W.has(n.replace(/\s+/g,'').replace(/T$/,'')))).map(t=>({id:t.id,k:t.kind||'기타',g:t.grade||'',s:t.school||'',t:t.title||'',j:t.subj||'',w:String(t.who||'').replace(/\s+/g,'').replace(/T$/,''),n:t.n||0,a:t.ans?1:0,d:t.due||'',m:t.memo||''}))})(),
      ann:(b.ann||[]).filter(a=>!a.until||a.until>=new Date(Date.now()+9*3600e3).toISOString().slice(0,10)).map(a=>({id:a.id,tx:a.tx,until:a.until||'',at:a.at||0})),
      ex:(b.ex||[]).filter(x=>x.date>=new Date(Date.now()+9*3600e3).toISOString().slice(0,10)).map(x=>({date:x.date,sid:x.sid,kind:x.kind,t:x.t||'',p:x.p,memo:x.memo||''})),
      // 예정 시간표: 날짜가 되면 폰이 스스로 이걸로 바꿔 보여 줌 · pub이면 그 전에도 미리 보기
      ...(()=>{const sc=b.sched;const nv=sc&&(b.versions||[]).find(x=>x.id===sc.ver);if(!nv||nv.id===v.id)return {};
        return {next:{from:sc.from,pub:!!sc.pub,version:nv.name||'',classes:(nv.classes||[]).map(c=>({id:c.id,name:c.name,color:c.color,members:c.members||{}})),sessions:(nv.sessions||[]).map(o=>({cls:o.cls,t:o.t,d:o.d,p:o.p}))}}})()}})}}
const MANIFEST=JSON.stringify({name:'Y-MATH 시간표',short_name:'Y-MATH',start_url:'./',scope:'./',display:'standalone',background_color:'#17243F',theme_color:'#17243F',icons:[{src:'icon.png',sizes:'256x256',type:'image/png',purpose:'any'}]});
const FAIL={};
function handle(req,res){const u=new URL(req.url,'http://x');const ip=req.socket.remoteAddress||'';
  const send=(code,type,body)=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body)};
  if(u.pathname==='/'||u.pathname==='/index.html'){try{return send(200,'text/html; charset=utf-8',fs.readFileSync(path.join(__dirname,'mobile.html')))}catch(e){return send(500,'text/plain','no page')}}
  if(/^\/fonts\/[\w.-]+\.woff2$/.test(u.pathname)){const f=path.join(__dirname,u.pathname);if(fs.existsSync(f)){res.writeHead(200,{'Content-Type':'font/woff2','Cache-Control':'max-age=86400'});return res.end(fs.readFileSync(f))}}
  if(u.pathname==='/manifest.webmanifest')return send(200,'application/manifest+json; charset=utf-8',MANIFEST);
  if(u.pathname==='/icon.png'){try{res.writeHead(200,{'Content-Type':'image/png'});return res.end(fs.readFileSync(path.join(__dirname,'icon.png')))}catch(e){}}
  if(u.pathname==='/view.json'){const f=FAIL[ip]||{n:0,until:0};if(Date.now()<f.until)return send(429,'application/json','{"err":"wait"}');
    const pin=req.headers['x-pin']||u.searchParams.get('pin')||'';
    FAIL[ip]={n:0,until:0};const v=publicView();if(!v)return send(503,'application/json','{"err":"nodata"}');encV2(v).then(x=>send(200,'application/json; charset=utf-8',JSON.stringify(x)),()=>send(500,'application/json','{"err":"enc"}'));return}
  send(404,'text/plain','not found')}
function startServer(){if(srv){try{srv.close()}catch(e){}srv=null}srvErr='';if(!mob.on)return;
  srv=http.createServer(handle);srv.on('error',e=>{srvErr=e.code==='EADDRINUSE'?`포트 ${mob.port}을(를) 다른 프로그램이 쓰고 있어요`:e.message;srv=null});
  srv.listen(mob.port,'0.0.0.0')}
function mobInfo(){return {on:mob.on,pin:mob.pin,port:mob.port,running:!!(srv&&srv.listening),err:srvErr,gh:ghInfo(),nas:{on:!!mob.nasOn,base:mob.nasBase||'',sub:mob.nasSub||'',host:mob.nasHost||'',last:NAS.last,err:NAS.err},urls:lanIPs().map(ip=>`http://${ip}:${mob.port}`)}}
ipcMain.handle('mobileGet',()=>new Promise(r=>setTimeout(()=>r(mobInfo()),150)));
ipcMain.handle('mobileSet',async(e,o)=>{mob.on=!!o.on;{const np=String(o.pin||'').trim().slice(0,32);if(np!==mob.pin&&syCfg().role!=='branch'&&syCfg().role!=='staff'){mob.pin=np;mob.pinAt=Date.now();try{await rqPublish()}catch(err){}}}const pt=+o.port;if(pt>=1024&&pt<=65535)mob.port=pt;
  fs.writeFileSync(MOB,JSON.stringify(mob),'utf8');startServer();return new Promise(r=>setTimeout(()=>r(mobInfo()),400))});

/* ================= 학원 서버(시놀로지 NAS)로 올리기 =================
   [적용]으로 timetable.json이 저장될 때마다 NAS의 웹 폴더(예: Z:\web\ymt-xxxxxxxx)에 index.html(=mobile.html)·view.json·글꼴을 복사.
   view.json은 선생님용 번호로 잠금(AES-256-GCM, 키 = PBKDF2-SHA256 20만 회) → 폰에서 번호를 넣어야 풀림. PC가 꺼져 있어도 마지막 적용본을 볼 수 있음. */
const crypto=require('crypto');
/* 다시 시작 필요 감지: 켤 때 읽은 main.js·preload.js와 지금 디스크의 파일이 다르면(자동 업데이트로 바뀜) 아직 옛 엔진으로 도는 중
   → 이 상태에선 선생님 화면(view.json)을 올리지 않고, 화면에선 [적용]·바로 저장을 막고 다시 시작하라고 안내 (예전 방식으로 덮어쓰는 사고 방지) */
const BOOT_SHA=(()=>{try{return ['main.js','preload.js'].map(f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,f))).digest('hex')).join('|')}catch(e){return ''}})();
function appStale(){if(!BOOT_SHA)return false;try{return ['main.js','preload.js'].map(f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,f))).digest('hex')).join('|')!==BOOT_SHA}catch(e){return false}}
const STALE_MSG='새 버전을 받았어요 · 프로그램을 다시 시작해야 선생님 화면에 올라가요';
const NAS={last:0,err:''};let nasT=null;
function nasDir(){return mob.nasOn&&mob.nasBase&&mob.nasSub?path.join(mob.nasBase,mob.nasSub):null}
/* 폰용 파일 암호화. 키 = PBKDF2(번호, 소금, 60만 회) — 소금은 번호에서 정해져 모든 PC·폰이 같음 → 키는 한 번만 만들어 두고 다시 씀(PC는 메모리, 폰도 캐시).
   IV는 매번 새로. 헤더 h = 시간표 내용(적용 시각 제외)의 해시 → 내용이 같으면 다시 올리지 않음(PC가 달라도) */
const VIEW_IT=600000;const KEYC={pin:null,p:null};
const viewSalt=pin=>crypto.createHash('sha256').update('ymath-view-salt-v2\0'+pin,'utf8').digest().subarray(0,16);
function viewKey(pin){if(KEYC.pin===pin&&KEYC.p)return KEYC.p;const salt=viewSalt(pin);KEYC.pin=pin;
  KEYC.p=new Promise((res,rej)=>crypto.pbkdf2(Buffer.from(pin,'utf8'),salt,VIEW_IT,32,'sha256',(e,k)=>e?rej(e):res({salt,key:k})));KEYC.p.catch(()=>{KEYC.p=null});return KEYC.p}
function viewHash(obj){const o=Object.assign({},obj);delete o.at;return crypto.createHash('sha256').update(JSON.stringify(o),'utf8').digest('hex').slice(0,32)}
async function encView(obj,pass){const {salt,key}=await viewKey(pass);const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm',key,iv);const ct=Buffer.concat([c.update(Buffer.from(JSON.stringify(obj),'utf8')),c.final(),c.getAuthTag()]);
  return {app:'ymath-view',enc:1,kdf:'pbkdf2-sha256',it:VIEW_IT,salt:salt.toString('base64'),iv:iv.toString('base64'),ct:ct.toString('base64'),h:viewHash(obj)}}
function wr(f,data){const t=f+'.tmp';fs.writeFileSync(t,data);try{fs.renameSync(t,f)}catch(e){fs.copyFileSync(t,f);fs.unlinkSync(t)}}
async function publishNas(){const d=nasDir();if(!d)return;NAS.err='';if(appStale()){NAS.err=STALE_MSG;return}
  try{if(!fs.existsSync(mob.nasBase))throw new Error('서버 폴더가 안 보여요 ('+mob.nasBase+') · Z드라이브 연결을 확인해 주세요');
    fs.mkdirSync(path.join(d,'fonts'),{recursive:true});const v=publicView();if(!v)throw new Error('시간표 파일을 읽지 못했어요');
    wr(path.join(d,'view.json'),JSON.stringify(await encV2(v)));
    wr(path.join(d,'index.html'),fs.readFileSync(path.join(__dirname,'mobile.html')));
    try{fs.copyFileSync(path.join(__dirname,'icon.png'),path.join(d,'icon.png'))}catch(e){}
    try{wr(path.join(d,'manifest.webmanifest'),MANIFEST)}catch(e){}
    for(const f of fs.readdirSync(path.join(__dirname,'fonts')).filter(x=>x.endsWith('.woff2'))){const to=path.join(d,'fonts',f);if(!fs.existsSync(to))fs.copyFileSync(path.join(__dirname,'fonts',f),to)}
    NAS.last=Date.now()}catch(e){NAS.err=e.message}
  try{if(win&&!win.isDestroyed())win.webContents.send('nasState',{last:NAS.last,err:NAS.err})}catch(e){}}
function nasLater(){if(nasDir()){clearTimeout(nasT);nasT=setTimeout(publishNas,2500)}if(mob.ghOn){clearTimeout(ghT);ghT=setTimeout(publishGh,3000)}}
/* ================= 인터넷(GitHub Pages)으로 올리기 =================
   저장소(예: ymath-timetable)에 index.html·view.json(암호화)·글꼴을 GitHub API로 올림 → https://아이디.github.io/저장소/
   연결 키는 윈도우 보안 저장(safeStorage)으로 암호화해서 data/mobile.json에 둠. 같은 내용이면 다시 안 올림(git blob sha 비교). */
const GH={last:0,err:'',url:'',busy:false,sha:{},skipped:false};let ghT=null;
function ghToken(){try{if(mob.ghTok&&safeStorage.isEncryptionAvailable())return safeStorage.decryptString(Buffer.from(mob.ghTok,'base64'));return mob.ghTokPlain||''}catch(e){return ''}}
function ghSetToken(t){if(!t)return;if(safeStorage.isEncryptionAvailable()){mob.ghTok=safeStorage.encryptString(t).toString('base64');delete mob.ghTokPlain}else mob.ghTokPlain=t}
async function gh(method,url,body,_re){const r=await fetch((process.env.YMT_GH_API||'https://api.github.com')+url,{method,headers:{'Authorization':'Bearer '+ghToken(),'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ymath-timetable'},body:body?JSON.stringify(body):undefined});
  if(r.status===401&&!_re&&await tokenRefresh())return gh(method,url,body,true);
  try{const ex=r.headers.get('github-authentication-token-expiration');if(ex){const t=Date.parse(ex.replace(' UTC','Z').replace(' ','T'));if(t&&mob.ghExp!==t){mob.ghExp=t;fs.writeFileSync(MOB,JSON.stringify(mob),'utf8')}}}catch(e){}
  let j=null;try{j=await r.json()}catch(e){}return {status:r.status,j}}
/* 연결 키 자동 갱신: 원장님이 새 키를 넣으면 sync/token.json(관리자 키로 암호화)에 올려 두고,
   다른 PC는 401(만료)이 나면 공개 저장소에서 키 없이 그 파일을 읽어 새 키로 바꿈 (10분에 한 번만 시도) */
let tokTried=0;
async function tokenRefresh(){try{const c=mob.sync||{};if(!c.on||!syKey()||!mob.ghOwner||!mob.ghRepo)return false;if(Date.now()-tokTried<600000)return false;tokTried=Date.now();
    const r=await fetch((process.env.YMT_GH_API||'https://api.github.com')+`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/sync/token.json`,{headers:{'Accept':'application/vnd.github.raw+json','User-Agent':'ymath-timetable'}});
    if(!r.ok)return false;const o=syDec(Buffer.from(await r.arrayBuffer()));if(!o||!o.t||o.t===ghToken())return false;ghSetToken(o.t);fs.writeFileSync(MOB,JSON.stringify(mob),'utf8');return true}catch(e){return false}}
async function tokenPublish(){try{const c=mob.sync||{};if(!c.on||c.role!=='owner'||!syKey()||!ghToken())return;if(!mob.ghOwner)await ghConnect();await ghPut('sync/token.json',syEnc({t:ghToken(),at:Date.now()}),'연결 키 갱신')}catch(e){}}
const blobSha=buf=>crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+buf.length+'\0'),buf])).digest('hex');
// 409/422(판 번호가 어긋남 — 다른 PC가 막 올렸거나 GitHub가 옛 번호를 알려 줌)이면 잠깐 쉬고 최신 번호로 두 번까지 다시
async function ghPut(file,buf,msg,pre){const u=`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/${file}`;
  for(let k=0;;k++){const g=(k===0&&pre)?pre:await gh('GET',u+(k?`?t=${Date.now()}`:''));
    if(g.status===200&&g.j&&g.j.sha===blobSha(buf))return false;
    const p=await gh('PUT',u,{message:msg,content:buf.toString('base64'),...(g.status===200&&g.j?{sha:g.j.sha}:{})});
    if(p.status===200||p.status===201)return true;
    if((p.status===409||p.status===422)&&k<2){await new Promise(r=>setTimeout(r,1200+k*1500));continue}
    throw new Error(ghErr(p,file))}}
function ghErr(r,what){if(r.status===401)return '연결 키가 맞지 않거나 기한이 지났어요';if(r.status===403)return '연결 키에 쓰기 권한이 없어요 (Contents: Read and write)';if(r.status===404)return `저장소 ${mob.ghOwner}/${mob.ghRepo}을(를) 찾지 못했어요 · 이름과 키의 저장소 선택을 확인해 주세요`;return `GitHub 오류 ${r.status}${what?' ('+what+')':''}: ${(r.j&&r.j.message)||''}`}
async function ghConnect(){const me=await gh('GET','/user');if(me.status!==200)throw new Error(ghErr(me));mob.ghOwner=me.j.login;
  const rp=await gh('GET',`/repos/${mob.ghOwner}/${mob.ghRepo}`);if(rp.status!==200)throw new Error(ghErr(rp));
  if(rp.j.private)throw new Error('저장소가 비공개(Private)예요 · 무료 GitHub Pages는 공개(Public) 저장소만 돼요 (시간표는 암호화돼 있어서 공개여도 안전해요)');
  GH.branch=rp.j.default_branch||'main'}
async function ghPages(){const u=`/repos/${mob.ghOwner}/${mob.ghRepo}/pages`;const g=await gh('GET',u);if(g.status===200){GH.url=g.j.html_url||'';return true}
  const c=await gh('POST',u,{source:{branch:GH.branch||'main',path:'/'}});if(c.status===201||c.status===200){GH.url=(c.j&&c.j.html_url)||'';return true}
  GH.url='';GH.pagesOff=true;return false}
async function publishGh(){if(!mob.ghOn)return;if(appStale()){GH.err=STALE_MSG;try{if(win&&!win.isDestroyed())win.webContents.send('nasState',{gh:ghInfo()})}catch(e){}return}if(GH.busy){GH.again=true;return}GH.busy=true;GH.again=false;GH.err='';GH.pagesOff=false;
  try{if(!ghToken())throw new Error('연결 키를 넣어 주세요');if(!mob.ghRepo)throw new Error('저장소 이름을 넣어 주세요');
    await ghConnect();await rqRefresh(true);const v=publicView();if(!v)throw new Error('시간표 파일을 읽지 못했어요');const rqv=rqView();
    const st=new Date().toISOString().slice(0,16).replace('T',' ');
    // 화면·글꼴 같은 고정 파일: 한 번 확인한 뒤엔 내용(sha)이 바뀔 때만 다시 확인 (매번 9번 묻던 걸 0번으로)
    const stat=async(file,buf,msg)=>{const s=blobSha(buf);if(GH.sha[file]===s)return;await ghPut(file,buf,msg);GH.sha[file]=s};
    await stat('index.html',fs.readFileSync(path.join(__dirname,'mobile.html')),'화면 '+st);
    await stat('.nojekyll',Buffer.from(''),'설정');
    await stat('manifest.webmanifest',Buffer.from(MANIFEST),'앱 아이콘 정보');
    await stat('icon.png',fs.readFileSync(path.join(__dirname,'icon.png')),'아이콘');
    for(const f of ['IBMPlexSansKR-Regular.woff2','IBMPlexSansKR-SemiBold.woff2','IBMPlexSansKR-Bold.woff2','IBMPlexMono-Medium.woff2'])await stat('fonts/'+f,fs.readFileSync(path.join(__dirname,'fonts',f)),'글꼴');
    // 시간표: 올라가 있는 파일의 내용 해시가 같으면(다른 PC가 올렸어도) 건너뜀 → 커밋·Pages 빌드 없음
    const vj=await encV2(v,rqv?{rq:rqv}:{});const vu=`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/view.json`;const cur=await gh('GET',vu+`?t=${Date.now()}`);
    let same=false;if(cur.status===200&&cur.j&&cur.j.content){try{const j=JSON.parse(Buffer.from(String(cur.j.content).replace(/\n/g,''),'base64').toString('utf8'));same=j.enc===2&&!!j.h&&j.h===vj.h&&j.salt===vj.salt}catch(e){}}
    GH.skipped=same;if(!same)await ghPut('view.json',Buffer.from(JSON.stringify(vj)),'시간표 '+st,cur.status===200?cur:null);
    await ghPages();if(!GH.url)GH.url=`https://${mob.ghOwner.toLowerCase()}.github.io/${mob.ghRepo}/`;GH.last=Date.now()}
  catch(e){GH.err=e.message||String(e)}
  GH.busy=false;try{if(win&&!win.isDestroyed())win.webContents.send('nasState',{gh:ghInfo()})}catch(e){}
  if(GH.again){GH.again=false;clearTimeout(ghT);ghT=setTimeout(publishGh,1500)}}
function ghInfo(){return {exp:mob.ghExp||0,on:!!mob.ghOn,repo:mob.ghRepo||'',owner:mob.ghOwner||'',hasTok:!!ghToken(),last:GH.last,err:GH.err,url:GH.url||(mob.ghOwner&&mob.ghRepo?`https://${mob.ghOwner.toLowerCase()}.github.io/${mob.ghRepo}/`:''),pagesOff:!!GH.pagesOff,busy:GH.busy}}
ipcMain.handle('ghSet',async(e,o)=>{mob.ghOn=!!o.on;if(o.repo!==undefined)mob.ghRepo=String(o.repo||'').trim().replace(/^.*\//,'');if(o.token)ghSetToken(String(o.token).trim());
  let pinCh=false;if(o.pin!==undefined){const np=String(o.pin||'').trim().slice(0,32);if(np!==mob.pin){mob.pin=np;mob.pinAt=Date.now();pinCh=true}}fs.writeFileSync(MOB,JSON.stringify(mob),'utf8');if(pinCh)await rqPublish();if(mob.ghOn)await publishGh();if(o.token)await tokenPublish();return mobInfo()});
ipcMain.handle('ghNow',async()=>{await publishGh();return mobInfo()});
ipcMain.handle('ghLater',()=>{if(mob.ghOn){clearTimeout(ghT);ghT=setTimeout(publishGh,1500)}return true});
ipcMain.handle('nasSet',(e,o)=>{if(o.pickBase!==undefined){}
  mob.nasOn=!!o.on;if(o.base!==undefined)mob.nasBase=o.base;if(o.host!==undefined)mob.nasHost=String(o.host||'').trim().replace(/^https?:\/\//,'').replace(/\/+$/,'');
  if(o.pin!==undefined)mob.pin=String(o.pin||'').trim().slice(0,32);
  if(mob.nasOn&&!mob.nasSub)mob.nasSub='ymt-'+crypto.randomBytes(5).toString('hex');
  fs.writeFileSync(MOB,JSON.stringify(mob),'utf8');if(mob.nasOn)publishNas();return mobInfo()});
ipcMain.handle('nasPick',async()=>{const r=await dialog.showOpenDialog(win,{title:'시놀로지 웹 폴더 고르기 (예: Z:\\web)',properties:['openDirectory'],defaultPath:fs.existsSync('Z:\\')?'Z:\\':undefined});return r.canceled?null:r.filePaths[0]});
ipcMain.handle('nasNow',()=>{publishNas();return mobInfo()});

/* ================= 지점 연동 (GitHub 저장소를 창고로) =================
   sync/branches/<지점id>.json = 지점 전체(강사·교시·학생·반·버전) — 관리자 키(무작위 32바이트)로 AES-256-GCM 암호화
   sync/locks/<지점id>.json = {by,dev,at} 수정 잠금 (먼저 켠 사람만 수정)
   역할: owner(프로그램 관리자, 모든 지점) / branch(지점 관리자, 자기 지점만). 지점 관리자는 관리자 코드로 연결 */
const SY={last:0,err:''};
function syCfg(){return mob.sync||(mob.sync={})}
function syKey(){const c=syCfg();try{if(c.keyEnc&&safeStorage.isEncryptionAvailable())return Buffer.from(safeStorage.decryptString(Buffer.from(c.keyEnc,'base64')),'base64');if(c.keyPlain)return Buffer.from(c.keyPlain,'base64')}catch(e){}return null}
function sySetKey(b64){const c=syCfg();if(safeStorage.isEncryptionAvailable()){c.keyEnc=safeStorage.encryptString(b64).toString('base64');delete c.keyPlain}else c.keyPlain=b64}
function syEnc(obj){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',syKey(),iv);const ct=Buffer.concat([c.update(Buffer.from(JSON.stringify(obj),'utf8')),c.final(),c.getAuthTag()]);return Buffer.from(JSON.stringify({ymt:'branch',v:1,iv:iv.toString('base64'),ct:ct.toString('base64')}))}
function syDec(buf){const j=JSON.parse(buf.toString('utf8'));const iv=Buffer.from(j.iv,'base64'),all=Buffer.from(j.ct,'base64');const d=crypto.createDecipheriv('aes-256-gcm',syKey(),iv);d.setAuthTag(all.subarray(all.length-16));return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8'))}
const syBase=()=>`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/sync`;
async function syRaw(pathU,_re){const r=await fetch((process.env.YMT_GH_API||'https://api.github.com')+pathU,{headers:{'Authorization':'Bearer '+ghToken(),'Accept':'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ymath-timetable'}});
  if(r.status===401&&!_re&&await tokenRefresh())return syRaw(pathU,true);if(!r.ok)throw new Error(ghErr({status:r.status,j:null}));return Buffer.from(await r.arrayBuffer())}
async function syDir(sub){const r=await gh('GET',`${syBase()}/${sub}`);if(r.status===404)return [];if(r.status!==200)throw new Error(ghErr(r));return (r.j||[]).filter(x=>x.type==='file'&&x.name.endsWith('.json')).map(x=>({id:x.name.replace(/\.json$/,''),sha:x.sha,path:x.path}))}
function syReady(){const c=syCfg();return !!(c.on&&syKey()&&ghToken()&&mob.ghOwner&&mob.ghRepo)}
function syInfo(){const c=syCfg();return {on:!!c.on,role:c.role||'owner',branch:c.branch||'',home:c.home||'',pw:!!(c.admPw&&c.admPw.h),name:c.name||'',dev:c.dev||'',last:SY.last,err:SY.err,ready:syReady(),ghReady:!!(ghToken()&&mob.ghRepo)}}
function sySave(){fs.writeFileSync(MOB,JSON.stringify(mob),'utf8')}
// 받기: 바뀐 지점만 내용까지
const LOCKC={}; // 잠금 파일 내용은 판 번호(sha)가 같으면 다시 받지 않음
ipcMain.handle('syncPull',async(e,known,opt)=>{if(!syReady())return {ok:false,err:'연동이 꺼져 있어요'};
  try{if(!mob.ghOwner)await ghConnect();if(await syRevoked()){syWipe();return {ok:false,revoked:true,err:'프로그램 관리자가 이 PC의 연결을 끊었어요'}}const list=await syDir('branches');const out=[];
    for(const f of list){if(known&&known[f.id]===f.sha)continue;try{out.push({id:f.id,sha:f.sha,data:syDec(await syRaw(`${syBase()}/branches/${f.id}.json`))})}catch(err){out.push({id:f.id,sha:f.sha,err:'풀지 못했어요(관리자 키가 다름)'})}}
    let locks=opt&&opt.noLocks?null:{};if(locks)try{for(const l of await syDir('locks')){try{const hit=LOCKC[l.id];if(hit&&hit.sha===l.sha){locks[l.id]=hit;continue}locks[l.id]=LOCKC[l.id]=Object.assign(JSON.parse((await syRaw(`${syBase()}/locks/${l.id}.json`)).toString('utf8')),{sha:l.sha})}catch(err){}}}catch(err){}
    SY.last=Date.now();SY.err='';return {ok:true,present:list.map(f=>({id:f.id,sha:f.sha})),changed:out,locks}}
  catch(err){SY.err=err.message;return {ok:false,err:err.message}}});
// 올리기: [{id,data,sha}] — sha가 다르면(누가 먼저 올림) 서버 것을 백업해 두고 덮어씀
ipcMain.handle('syncPush',async(e,items)=>{if(!syReady())return {ok:false,err:'연동이 꺼져 있어요'};const done={},conflicts=[];
  try{if(!mob.ghOwner)await ghConnect();
    for(const it of items){const u=`${syBase()}/branches/${it.id}.json`;const cur=await gh('GET',u);let sha=cur.status===200?cur.j.sha:undefined;
      if(sha&&sha!==it.sha){if(!it.force){let by='',at=0;try{const d=syDec(await syRaw(u));by=(d._sync||{}).by||'';at=(d._sync||{}).at||0}catch(err){}conflicts.push({id:it.id,by,at,sha});continue}
        try{fs.writeFileSync(path.join(BAK,`timetable_충돌_상대본_${it.id}_${stamp()}.json`),JSON.stringify(syDec(await syRaw(u))),'utf8')}catch(err){}}
      const p=await gh('PUT',u,{message:`${syCfg().name||'관리자'} · ${(it.data&&it.data.name)||it.id}`,content:syEnc(it.data).toString('base64'),...(sha?{sha}:{})});
      if(p.status!==200&&p.status!==201)throw new Error(ghErr(p,it.id));done[it.id]=p.j.content.sha}
    SY.last=Date.now();SY.err='';return {ok:conflicts.length===0,conflicts,shas:done}}catch(err){SY.err=err.message;return {ok:false,err:err.message,shas:done,conflicts}}});
/* 공유 자료(학교 정보 등): sync/shared/<name>.json — 지점 상관없이 모두 같은 파일 · 관리자 키로 암호화 · 고칠 수 있는 PC 모두 씀
   잠금 없음: 받아서 항목마다 at(마지막 고친 시각)으로 합친 뒤 sha와 함께 올림 · sha가 다르면(누가 먼저 올림) 다시 받아서 합쳐 올림(syncShared에서 반복) */
ipcMain.handle('sharedPull',async(e,name,known)=>{if(!syReady())return {ok:false,err:'연동이 꺼져 있어요'};const u=`${syBase()}/shared/${String(name).replace(/[^a-z0-9_-]/gi,'')}.json`;
  try{if(!mob.ghOwner)await ghConnect();const g=await gh('GET',u);if(g.status===404)return {ok:true,none:true,sha:'',data:null};if(g.status!==200)throw new Error(ghErr(g,name));
    if(known&&known===g.j.sha)return {ok:true,same:true,sha:g.j.sha,data:null};return {ok:true,sha:g.j.sha,data:syDec(Buffer.from(String(g.j.content).replace(/\n/g,''),'base64'))}}catch(err){return {ok:false,err:err.message}}});
ipcMain.handle('sharedPush',async(e,name,data,sha)=>{if(!syReady())return {ok:false,err:'연동이 꺼져 있어요'};const u=`${syBase()}/shared/${String(name).replace(/[^a-z0-9_-]/gi,'')}.json`;
  try{if(!mob.ghOwner)await ghConnect();const p=await gh('PUT',u,{message:`${syCfg().name||'관리자'} · ${name}`,content:syEnc(data).toString('base64'),...(sha?{sha}:{})});
    if(p.status===409||p.status===422)return {ok:false,conflict:true};if(p.status!==200&&p.status!==201)throw new Error(ghErr(p,name));return {ok:true,sha:p.j.content.sha}}catch(err){return {ok:false,err:err.message}}});
ipcMain.handle('syncDelete',async(e,ids)=>{try{for(const id of ids){for(const sub of ['branches','locks']){const u=`${syBase()}/${sub}/${id}.json`;const g=await gh('GET',u);if(g.status===200)await gh('DELETE',u,{message:'지점 삭제',sha:g.j.sha})}}return {ok:true}}catch(err){return {ok:false,err:err.message}}});
// 잠금
ipcMain.handle('syncLock',async(e,id)=>{if(!syReady())return {ok:true,off:true};const c=syCfg();const u=`${syBase()}/locks/${id}.json`;
  try{if(!mob.ghOwner)await ghConnect();const g=await gh('GET',u);
    if(g.status===200){const l=JSON.parse(Buffer.from(g.j.content,'base64').toString('utf8'));if(l.dev===c.dev)return {ok:true};return {ok:false,by:l.by,at:l.at}}
    const body={by:c.name||(c.role==='owner'?'프로그램 관리자':'지점 관리자'),dev:c.dev,at:Date.now()};
    const p=await gh('PUT',u,{message:'잠금 '+body.by,content:Buffer.from(JSON.stringify(body)).toString('base64')});
    if(p.status===201||p.status===200)return {ok:true};const g2=await gh('GET',u);if(g2.status===200){const l=JSON.parse(Buffer.from(g2.j.content,'base64').toString('utf8'));return {ok:false,by:l.by,at:l.at}}
    return {ok:false,err:ghErr(p)}}catch(err){return {ok:false,offline:true,err:err.message}}});
ipcMain.handle('syncUnlock',async(e,ids,force)=>{const c=syCfg();const res={};
  for(const id of ids){try{const u=`${syBase()}/locks/${id}.json`;const g=await gh('GET',u);if(g.status!==200){res[id]=true;continue}
    const l=JSON.parse(Buffer.from(g.j.content,'base64').toString('utf8'));if(l.dev!==c.dev&&!(force&&(c.role==='owner'||(c.role==='branch'&&id===c.branch)))){res[id]=false;continue} /* 강제 풀기: 관리자 PC는 모든 지점, 지점장 PC는 자기 지점만 */
    const d=await gh('DELETE',u,{message:'잠금 풀기',sha:g.j.sha});res[id]=d.status===200}catch(err){res[id]=false}}return res});
// 켜기(원장님) / 코드로 연결(지점 관리자) / 코드 만들기 / 끊기
ipcMain.handle('syncInfo',()=>syInfo());
ipcMain.handle('syncEnable',async(e,o)=>{const c=syCfg();if(!ghToken()||!mob.ghRepo)return {ok:false,err:'먼저 [폰으로 보기 → 인터넷(GitHub)으로 올리기]를 연결해 주세요'};
  try{await ghConnect()}catch(err){return {ok:false,err:err.message}}
  if(!syKey())sySetKey(crypto.randomBytes(32).toString('base64'));c.on=true;c.role='owner';try{updEnsureKeys()}catch(err){}c.name=String(o&&o.name||c.name||'부원장').slice(0,20);c.dev=c.dev||crypto.randomBytes(6).toString('hex');sySave();await tokenPublish();return {ok:true,info:syInfo()}});
ipcMain.handle('syncCode',(e,branchId,opt)=>{const c=syCfg();if(c.role!=='owner'||!syReady())return null;
  try{updEnsureKeys()}catch(err){}const o={v:1,o:mob.ghOwner,r:mob.ghRepo,t:ghToken(),k:syKey().toString('base64'),p:mob.pin||'',b:branchId||'*',u:c.pub||''};
  if(opt&&opt.staff){if(!branchId||branchId==='*')return null;o.st={n:String(opt.staff).slice(0,20)}} // 행정 선생님 PC: 소속 지점만 · 학생 관리 위주
  if(!branchId||branchId==='*'){try{const pk=updPriv();if(pk)o.s=pk.export({type:'pkcs8',format:'pem'})}catch(err){}}return 'YMT1.'+Buffer.from(JSON.stringify(o)).toString('base64url')});
ipcMain.handle('syncJoin',async(e,code,name)=>{let o;try{o=JSON.parse(Buffer.from(String(code).trim().replace(/^YMT1\./,''),'base64url').toString('utf8'));if(!o.t||!o.k||!o.r)throw 0}catch(err){return {ok:false,err:'코드가 올바르지 않아요 · 프로그램 관리자에게 받은 코드를 통째로 붙여넣어 주세요'}}
  const c=syCfg();ghSetToken(o.t);mob.ghRepo=o.r;mob.ghOwner=o.o;if(o.p)mob.pin=o.p;mob.ghOn=true;sySetKey(o.k);c.on=true;if(o.u)c.pub=o.u;if(o.s&&o.b==='*'){try{if(safeStorage.isEncryptionAvailable()){c.signEnc=safeStorage.encryptString(o.s).toString('base64');delete c.signPlain}else c.signPlain=o.s}catch(err){}}c.role=o.b==='*'?'owner':o.st?'staff':'branch';c.branch=o.b==='*'?'':o.b;c.name=String(name||'').slice(0,20)||(o.st&&o.st.n?o.st.n+' 행정':'')||(c.role==='owner'?'원장님':'지점 관리자');c.dev=crypto.randomBytes(6).toString('hex');delete c.beat;sySave();
  try{await ghConnect()}catch(err){return {ok:false,err:err.message}}return {ok:true,info:syInfo()}});
/* 이 PC에서 로그아웃(지점·행정 PC): 내 잠금 풀고 연결된 PC 목록에서 빠진 뒤 열쇠·키·에듀OK 계정을 지움 · data면 시간표·기록·백업까지 → 다시 시작하면 처음 화면 */
ipcMain.handle('syncLogout',async(e,o)=>{const c=syCfg();if(c.on&&c.role==='owner')return {ok:false,err:'관리자 PC는 여기서 로그아웃할 수 없어요'};
  try{if(syReady()){if(!mob.ghOwner)await ghConnect();let ids=[];try{ids=(JSON.parse(fs.readFileSync(FILE,'utf8')).branches||[]).map(b=>b.id)}catch(err){}
    for(const id of ids){try{const u=`${syBase()}/locks/${id}.json`;const g=await gh('GET',u);if(g.status===200){const l=JSON.parse(Buffer.from(g.j.content,'base64').toString('utf8'));if(l.dev===c.dev)await gh('DELETE',u,{message:'잠금 풀기(로그아웃)',sha:g.j.sha})}}catch(err){}}
    try{const u=`${syBase()}/devices/${c.dev}.json`;const g=await gh('GET',u);if(g.status===200)await gh('DELETE',u,{message:'PC 로그아웃',sha:g.j.sha})}catch(err){}}}catch(err){}
  syWipe();delete c.revoked;mob.pin='';try{fs.writeFileSync(MOB,JSON.stringify(mob),'utf8')}catch(err){}try{fs.rmSync(EOKF,{force:true})}catch(err){}
  if(o&&o.data){for(const f of [FILE,HISTF,DRAFT,path.join(DATA,'eok_log.txt')])try{fs.rmSync(f,{force:true})}catch(err){}try{fs.rmSync(BAK,{recursive:true,force:true})}catch(err){}}
  setTimeout(()=>{app.relaunch();app.exit(0)},300);return {ok:true}});
ipcMain.handle('syncOff',()=>{const c=syCfg();c.on=false;sySave();return syInfo()});
ipcMain.handle('syncName',(e,n)=>{syCfg().name=String(n||'').slice(0,20);sySave();return syInfo()});
/* 연결된 PC 목록·원격 끊기: 각 PC가 sync/devices/<dev>.json(관리자 키 암호화)에 이름·역할·지점·버전·날짜를 남김 (바뀔 때·하루 한 번만 씀)
   관리자가 [연결 끊기] → sync/revoke.json에 그 PC 표시 → 그 PC는 다음 동기화 때 연동을 끄고 키를 지움 (시간표 파일은 그 PC에 남음) */
async function syRevoked(){try{const r=await fetch(API()+`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/sync/revoke.json?t=${Date.now()}`,{headers:{'Authorization':'Bearer '+ghToken(),'Accept':'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ymath-timetable'}});
  if(!r.ok)return false;const o=syDec(Buffer.from(await r.arrayBuffer()));const c=syCfg();return !!(o&&o[c.dev])}catch(e){return false}}
function syWipe(){const c=syCfg();c.on=false;['keyEnc','keyPlain','signEnc','signPlain','admPw','beat','home'].forEach(k=>delete c[k]);c.revoked=Date.now();delete mob.ghTok;delete mob.ghTokPlain;mob.ghOn=false;mob.rq={};sySave()}
ipcMain.handle('syncBeat',async(e,ver)=>{const c=syCfg();if(!syReady())return false;const d={name:c.name||'',role:c.role||'owner',branch:c.branch||'',ver:String(ver||''),day:new Date().toISOString().slice(0,10),...(appStale()?{stale:1}:{})};const sig=JSON.stringify(d);
  if(c.beat===sig)return false;try{if(!mob.ghOwner)await ghConnect();await ghPut(`sync/devices/${c.dev}.json`,syEnc(d),'PC 확인 · '+(c.name||''));c.beat=sig;sySave();return true}catch(err){return false}});
ipcMain.handle('syncDevices',async()=>{const c=syCfg();if(!syReady()||c.role!=='owner')return {ok:false,list:[]};
  try{if(!mob.ghOwner)await ghConnect();const out=[];for(const f of await syDir('devices')){try{out.push(Object.assign(syDec(await syRaw(`${syBase()}/devices/${f.id}.json`)),{dev:f.id,me:f.id===c.dev}))}catch(err){}}return {ok:true,list:out}}catch(err){return {ok:false,err:err.message,list:[]}}});
ipcMain.handle('syncRevoke',async(e,dev)=>{const c=syCfg();if(!syReady()||c.role!=='owner'||!dev||dev===c.dev)return {ok:false,err:'끊을 수 없어요'};
  try{if(!mob.ghOwner)await ghConnect();let o={};try{o=syDec(await syRaw(`${syBase()}/revoke.json`))||{}}catch(err){}o[dev]=Date.now();
    await ghPut('sync/revoke.json',syEnc(o),'PC 연결 끊기');const u=`${syBase()}/devices/${dev}.json`;const g=await gh('GET',u);if(g.status===200)await gh('DELETE',u,{message:'PC 연결 끊기',sha:g.j.sha});return {ok:true}}catch(err){return {ok:false,err:err.message}}});
/* 관리자 잠금: 프로그램 관리자 PC를 평소엔 '내 지점 모드'로 — 비밀번호를 넣어야 관리자 기능이 열림 (화면 잠금 · 업데이트 보내기는 계속) */
const ADMF={n:0,until:0};
const admHash=(pw,salt)=>crypto.pbkdf2Sync(Buffer.from(String(pw),'utf8'),salt,200000,32,'sha256');
function admOk(pw){const c=syCfg();if(!c.admPw||!c.admPw.h)return true;const h=admHash(pw,Buffer.from(c.admPw.s,'base64'));return crypto.timingSafeEqual(h,Buffer.from(c.admPw.h,'base64'))}
ipcMain.handle('admCheck',(e,pw)=>{if(Date.now()<ADMF.until)return {ok:false,wait:Math.ceil((ADMF.until-Date.now())/1000)};
  if(admOk(pw)){ADMF.n=0;return {ok:true}}ADMF.n++;if(ADMF.n>=5){ADMF.n=0;ADMF.until=Date.now()+30000}return {ok:false}});
ipcMain.handle('admSet',(e,o)=>{const c=syCfg();if(c.role!=='owner')return {ok:false,err:'프로그램 관리자 PC에서만 정할 수 있어요'};
  if((o.pw!==undefined||o.clear)&&c.admPw&&c.admPw.h&&!admOk(o.old||''))return {ok:false,err:'지금 비밀번호가 맞지 않아요'};
  if(o.home!==undefined)c.home=String(o.home||'');
  if(o.clear)delete c.admPw;else if(o.pw!==undefined){const pw=String(o.pw);if(pw.length<4)return {ok:false,err:'비밀번호는 4자리 이상으로 정해 주세요'};const s=crypto.randomBytes(16);c.admPw={s:s.toString('base64'),h:admHash(pw,s).toString('base64')}}
  sySave();return {ok:true,info:syInfo()}});

/* ================= 선생님 보강 요청 (브라우저 시간표 → GitHub 이슈) =================
   선생님 브라우저는 '요청 남기기'만 되는 키(Issues 권한만)로 저장소에 이슈를 만듦. 내용(지점·칸·이름)은 요청 키(k, 32바이트)로 AES-GCM 암호화.
   요청 키·이슈 키는 선생님용 번호로 잠긴 view.json 안에만 들어감. 프로그램 관리자 PC가 sync/req.json(관리자 키 암호화)에 올려 두면 지점 PC도 받아 씀.
   지점 관리자(자기 지점)·프로그램 관리자(모든 지점)가 [승인]하면 빈 칸 메모로 들어가고 이슈는 닫힘. */
const API=()=>process.env.YMT_GH_API||'https://api.github.com';
function rqCfg(){return mob.rq||(mob.rq={})}
function rqTok(){const r=rqCfg();try{if(r.tokEnc&&safeStorage.isEncryptionAvailable())return safeStorage.decryptString(Buffer.from(r.tokEnc,'base64'));return r.tokPlain||''}catch(e){return ''}}
function rqSetTok(t){const r=rqCfg();if(safeStorage.isEncryptionAvailable()){r.tokEnc=safeStorage.encryptString(t).toString('base64');delete r.tokPlain}else{r.tokPlain=t;delete r.tokEnc}}
const rqOn=()=>{const r=rqCfg();return !!(r.on&&r.k&&rqTok())};
function rqView(){return rqOn()&&mob.ghOwner&&mob.ghRepo?{t:rqTok(),k:rqCfg().k,o:mob.ghOwner,r:mob.ghRepo}:null}
let rqFetched=0;
/* sync/req.json = 관리자 PC들끼리·지점 PC와 나누는 공유 설정 (요청 키·선생님용 번호) — 각 항목은 더 나중에 바꾼 쪽(at)이 이김 → 관리자 PC가 여러 대여도·인수인계해도 그대로 */
async function rqRefresh(force){const c=syCfg();if(!c.on||!syKey()||!mob.ghOwner||!mob.ghRepo)return;if(!force&&Date.now()-rqFetched<600000)return;rqFetched=Date.now();
  try{const r=await fetch(API()+`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/sync/req.json?t=${Date.now()}`,{headers:{'Accept':'application/vnd.github.raw+json','User-Agent':'ymath-timetable',...(ghToken()?{'Authorization':'Bearer '+ghToken()}:{})}});
    if(r.status===404){if(c.role!=='owner'&&mob.rq&&mob.rq.on){mob.rq={};sySave()}return}if(!r.ok)return;
    const o=syDec(Buffer.from(await r.arrayBuffer()));const rq=rqCfg();const before=JSON.stringify([rq.on,rq.k,rqTok(),mob.pin]);
    if((o.at||0)>(rq.at||0)||(c.role!=='owner'&&!rq.at)){rq.on=!!o.on;rq.k=o.k||'';rq.at=o.at||0;if(o.t)rqSetTok(o.t);else{delete rq.tokEnc;delete rq.tokPlain}}
    if(o.pin&&(o.pinAt||0)>(mob.pinAt||0)){mob.pin=o.pin;mob.pinAt=o.pinAt}
    if(JSON.stringify([rq.on,rq.k,rqTok(),mob.pin])!==before)sySave()}catch(e){}}
async function rqPublish(){const c=syCfg();if(!c.on||c.role!=='owner'||!syKey()||!ghToken())return;const r=rqCfg();
  try{if(!mob.ghOwner)await ghConnect();await ghPut('sync/req.json',syEnc({on:!!r.on,t:rqTok(),k:r.k||'',at:r.at||0,pin:mob.pin||'',pinAt:mob.pinAt||0}),'공유 설정')}catch(e){}}
async function rqApi(method,url,body){const r=await fetch(API()+url,{method,headers:{'Authorization':'Bearer '+rqTok(),'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ymath-timetable',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  try{const ex=r.headers.get('github-authentication-token-expiration');if(ex){const t=Date.parse(ex.replace(' UTC','Z').replace(' ','T'));if(t&&rqCfg().exp!==t){rqCfg().exp=t;sySave()}}}catch(e){}
  let j=null;try{j=await r.json()}catch(e){}return {status:r.status,j}}
function rqErr(r){if(r.status===401)return '요청 키가 맞지 않거나 기한이 지났어요';if(r.status===403)return '요청 키에 Issues 권한이 없어요 (Issues: Read and write)';if(r.status===404)return '저장소를 찾지 못했어요 · 요청 키의 저장소 선택을 확인해 주세요';if(r.status===410)return '저장소의 Issues 기능이 꺼져 있어요 · 저장소 Settings → General → Features → Issues 체크';return `GitHub 오류 ${r.status}: ${(r.j&&r.j.message)||''}`}
function rqDec(body){const j=JSON.parse(body);const key=Buffer.from(rqCfg().k,'base64');const iv=Buffer.from(j.iv,'base64'),all=Buffer.from(j.ct,'base64');
  const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(all.subarray(all.length-16));return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8'))}
function rqInfo(){const r=rqCfg(),c=syCfg();return {on:!!r.on,hasTok:!!rqTok(),ready:rqOn(),exp:r.exp||0,owner:!c.on||c.role==='owner',err:RQ.err||''}}
const RQ={err:''};
ipcMain.handle('rqInfo',async()=>{await rqRefresh();return rqInfo()});
ipcMain.handle('rqSet',async(e,o)=>{const c=syCfg();if(c.on&&c.role!=='owner')return Object.assign(rqInfo(),{err:'프로그램 관리자 PC에서만 바꿀 수 있어요'});const r=rqCfg();
  await rqRefresh(true);const old=rqTok();if(o.token)rqSetTok(String(o.token).trim());if(!r.k)r.k=crypto.randomBytes(32).toString('base64');r.on=!!o.on;r.at=Date.now();RQ.err='';
  if(r.on){if(!rqTok()){r.on=false;RQ.err='요청 키를 넣어 주세요'}
    else{try{if(!mob.ghOwner)await ghConnect();const t=await rqApi('GET',`/repos/${mob.ghOwner}/${mob.ghRepo}/issues?per_page=1`);if(t.status!==200){RQ.err=rqErr(t);r.on=false;if(o.token){if(old)rqSetTok(old);else{delete r.tokEnc;delete r.tokPlain}}}}catch(err){RQ.err=err.message;r.on=false}}}
  sySave();await rqPublish();if(mob.ghOn)await publishGh();return rqInfo()});
/* 관리자 폰 요청: 서명(HMAC · b.own.ak)이 맞아야 x.ops를 믿음 · 아니면 adBad(받은 PC가 닫기만) */
function adVerify(x){try{let db;try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){db={branches:[]}}const ob=(db.branches||[]).find(b=>b.own&&b.own.ak);
    if(typeof x.p!=='string'||typeof x.sg!=='string')throw 0;const g=Buffer.from(x.sg,'base64');const eq=k=>{const h=crypto.createHmac('sha256',Buffer.from(k,'base64')).update(x.p,'utf8').digest();return g.length===h.length&&crypto.timingSafeEqual(g,h)};
    let mgr=false;if(!(ob&&eq(ob.own.ak))){const mb=x.kind==='ad'&&(db.branches||[]).find(b=>b.id===x.br&&b.mgk);if(!mb||!eq(mb.mgk))throw 0;mgr=true} /* 지점장 키: 그 지점 · 상담 보류만 */
    const d=JSON.parse(x.p);if(!d||d.br!==x.br||!Array.isArray(d.ops)||!d.n)throw 0;if(mgr&&!d.ops.every(o=>o&&['stAdd','stEd','stSt','stCt','mAdd','mDel','cnSet','cnAsg','cnAsgX','cnHold','cnHoldG','cnAsgG','stKey','iqAdd','iqReg','iqX','anAdd','anDel'].includes(o.op)))throw 0; /* 지점장 키: 자기 지점 관리 탭 일만(그 지점 키라 다른 지점은 안 됨) */if(mgr){x.mgr=1;x.by=String(d.by||'').slice(0,20)}
    x.ops=d.ops;x.n=String(d.n);x.lb=String(d.lb||'').slice(0,200);x.pat=+d.at||0;delete x.p;delete x.sg}
  catch(e){x.adBad=1;delete x.ops;delete x.p;delete x.sg}}
ipcMain.handle('rqList',async()=>{await rqRefresh();if(!rqOn()||!mob.ghOwner||!mob.ghRepo)return {ok:true,off:true,list:[]};
  try{const out=[];for(let pg=1;pg<=3;pg++){const r=await rqApi('GET',`/repos/${mob.ghOwner}/${mob.ghRepo}/issues?state=open&per_page=100&page=${pg}`);if(r.status!==200){RQ.err=rqErr(r);return {ok:false,err:RQ.err,list:out}}
      for(const i of r.j||[]){if(i.pull_request||!/^\[ymt\]/.test(i.title||''))continue;try{const x=rqDec(i.body||'');if(x&&(x.kind==='ad'||x.kind==='pc'))adVerify(x);if(x&&x.br&&(x.d||((x.kind==='cs'||x.kind==='cn')&&x.sid)||((x.kind==='ad'||x.kind==='pc')&&(x.ops||x.adBad))||((x.kind==='cnx'||x.kind==='csx')&&x.sid&&x.num0)||(x.kind==='tk'&&x.id)))out.push(Object.assign(x,{num:i.number,at:Date.parse(i.created_at)||0}))}catch(err){out.push({num:i.number,bad:true,at:Date.parse(i.created_at)||0})}}
      if((r.j||[]).length<100)break}
    RQ.err='';return {ok:true,list:out}}catch(err){RQ.err=err.message;return {ok:false,err:err.message,list:[]}}});
/* PC 상태 확인(관리자 폰): 그 요청에 이 PC 상태를 암호화한 댓글로 남김 */
ipcMain.handle('rqComment',async(e,num,obj)=>{if(!rqOn())return {ok:false};try{const key=Buffer.from(rqCfg().k,'base64'),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const ct=Buffer.concat([c.update(Buffer.from(JSON.stringify(obj),'utf8')),c.final(),c.getAuthTag()]);
  const r=await rqApi('POST',`/repos/${mob.ghOwner}/${mob.ghRepo}/issues/${+num}/comments`,{body:JSON.stringify({v:1,iv:iv.toString('base64'),ct:ct.toString('base64')})});return {ok:r.status===201}}catch(err){return {ok:false,err:err.message}}});
ipcMain.handle('autoStart',(e,on)=>{try{if(on!==undefined)app.setLoginItemSettings({openAtLogin:!!on});return !!app.getLoginItemSettings().openAtLogin}catch(err){return null}});
ipcMain.handle('updRemoteVer',async()=>{try{if(!syReady())return null;if(!mob.ghOwner)await ghConnect();const rv=await updRemote();const m=rv&&JSON.parse(rv.m);return m?{ver:m.ver,at:m.at}:null}catch(err){return null}});
ipcMain.handle('rqClose',async(e,num,ok)=>{if(!rqOn())return {ok:false,err:'꺼져 있어요'};try{const r=await rqApi('PATCH',`/repos/${mob.ghOwner}/${mob.ghRepo}/issues/${+num}`,{state:'closed',state_reason:ok?'completed':'not_planned'});return r.status===200?{ok:true}:{ok:false,err:rqErr(r)}}catch(err){return {ok:false,err:err.message}}});

/* ================= 자동 업데이트 (원장님 PC → 지점 PC) =================
   원장님 PC가 켜질 때 자기 프로그램 파일(index·mobile·main·preload·package)을 저장소 app/에 올리고,
   app/version.json = {m:목록(JSON 글자), sig} 에 원장님 PC만 가진 서명 키(ed25519)로 서명.
   다른 PC는 2분마다 확인 → 서명·파일 해시가 맞고 버전이 더 높을 때만 내려받아 바꿈(index.html은 마지막). 서명 확인용 공개키는 관리자 코드에 들어 있음. */
const UPD_FILES=['main.js','preload.js','package.json','mobile.html','index.html'];
const vcmp=(a,b)=>{const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)-(y[i]||0)}return 0};
function updPriv(){const c=syCfg();try{if(c.signEnc&&safeStorage.isEncryptionAvailable())return crypto.createPrivateKey(safeStorage.decryptString(Buffer.from(c.signEnc,'base64')));if(c.signPlain)return crypto.createPrivateKey(c.signPlain)}catch(e){}return null}
function updEnsureKeys(){const c=syCfg();if(c.pub)return;  // 공개키가 이미 있으면(다른 원장님 PC로 연결된 경우 포함) 새로 만들지 않음
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');const pem=privateKey.export({type:'pkcs8',format:'pem'});
  if(safeStorage.isEncryptionAvailable()){c.signEnc=safeStorage.encryptString(pem).toString('base64');delete c.signPlain}else c.signPlain=pem;
  c.pub=publicKey.export({type:'spki',format:'der'}).toString('base64');sySave()}
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
async function updRemote(){try{return JSON.parse((await syRaw(`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/app/version.json`)).toString('utf8'))}catch(e){return null}}
ipcMain.handle('updPublish',async(e,ver)=>{const c=syCfg();if(!syReady()||c.role!=='owner')return {ok:false};if(!c.pub)try{updEnsureKeys()}catch(err){}const priv=updPriv();if(!priv)return {ok:false,nokey:true};
  try{if(!mob.ghOwner)await ghConnect();const rv=await updRemote();let cur=null;try{cur=rv&&JSON.parse(rv.m)}catch(err){}
    if(cur&&vcmp(cur.ver,ver)>=0)return {ok:true,skipped:true,remote:cur.ver};
    const files={};for(const f of UPD_FILES){const b=fs.readFileSync(path.join(__dirname,f));files[f]=sha256(b);await ghPut('app/'+f,b,`프로그램 ${ver} · ${f}`)}
    const m=JSON.stringify({ver,at:Date.now(),files});const sig=crypto.sign(null,Buffer.from(m),priv).toString('base64');
    await ghPut('app/version.json',Buffer.from(JSON.stringify({m,sig})),`프로그램 ${ver}`);return {ok:true,published:ver}}catch(err){return {ok:false,err:err.message}}});
let updBusy=false;
ipcMain.handle('updCheck',async(e,ver)=>{const c=syCfg();if(!syReady()||!c.pub||updBusy)return {ok:false};updBusy=true;
  try{if(!mob.ghOwner)await ghConnect();const rv=await updRemote();if(!rv)return {ok:true,none:true};
    const pub=crypto.createPublicKey({key:Buffer.from(c.pub,'base64'),format:'der',type:'spki'});
    if(!crypto.verify(null,Buffer.from(rv.m),pub,Buffer.from(rv.sig,'base64')))return {ok:false,err:'업데이트 서명이 맞지 않아 받지 않았어요'};
    const m=JSON.parse(rv.m);if(vcmp(m.ver,ver)<=0)return {ok:true,latest:true};
    const got={};for(const f of UPD_FILES){if(!m.files[f])continue;const local=fs.existsSync(path.join(__dirname,f))?sha256(fs.readFileSync(path.join(__dirname,f))):'';if(local===m.files[f])continue;
      const b=await syRaw(`/repos/${mob.ghOwner}/${mob.ghRepo}/contents/app/${f}`);if(sha256(b)!==m.files[f])return {ok:false,err:`업데이트 파일(${f})이 목록과 달라 받지 않았어요`};got[f]=b}
    const restart=!!(got['main.js']||got['preload.js']||got['package.json']);
    for(const f of UPD_FILES.filter(x=>x!=='index.html'))if(got[f]){fs.writeFileSync(path.join(__dirname,f+'.new'),got[f]);fs.renameSync(path.join(__dirname,f+'.new'),path.join(__dirname,f))}
    if(got['index.html']&&!restart){UPD_PENDING=null; /* 다시 시작 기다리던 예전 화면 파일이 나중에 최신을 덮어쓰지 않게 */fs.writeFileSync(path.join(__dirname,'index.html.new'),got['index.html']);fs.renameSync(path.join(__dirname,'index.html.new'),path.join(__dirname,'index.html'))}
    else if(got['index.html'])UPD_PENDING=got['index.html'];
    return {ok:true,updated:m.ver,restart}}catch(err){return {ok:false,err:err.message}}finally{updBusy=false}});
let UPD_PENDING=null;
app.on('will-quit',()=>{try{if(UPD_PENDING){fs.writeFileSync(path.join(__dirname,'index.html'),UPD_PENDING);UPD_PENDING=null}}catch(e){}});
ipcMain.handle('relaunch',()=>{try{if(UPD_PENDING){fs.writeFileSync(path.join(__dirname,'index.html'),UPD_PENDING);UPD_PENDING=null}}catch(e){}app.relaunch();app.exit(0)});
ipcMain.handle('setTheme',(e,m)=>{nativeTheme.themeSource=m;return true});
ipcMain.handle('win',(e,a)=>{const w=BrowserWindow.fromWebContents(e.sender);if(!w)return null;
  if(a==='min')w.minimize();else if(a==='max'){if(w.isFullScreen())w.setFullScreen(false);else if(w.isMaximized())w.unmaximize();else w.maximize()}else if(a==='close')w.close();
  return {max:w.isMaximized(),full:w.isFullScreen()}});
ipcMain.handle('openFolder',(e,w)=>shell.openPath(w==='out'?OUT:DATA));
ipcMain.handle('zoom',(e,d)=>{zoom=d===0?0:Math.max(-4,Math.min(4,zoom+d));win.webContents.setZoomLevel(zoom*0.5);return zoom});
app.whenReady().then(()=>{
  startServer();setTimeout(()=>{try{publishNas()}catch(e){}if(!(mob.sync&&mob.sync.on))try{publishGh()}catch(e){}},4000); // 연동 PC는 먼저 받은 뒤 올림(렌더러 ghLater)
  Menu.setApplicationMenu(null);
  win=new BrowserWindow({width:1500,height:940,minWidth:900,minHeight:600,title:'Y-MATH 시간표',backgroundColor:'#17243F',
    frame:false,thickFrame:true,icon:path.join(__dirname,process.platform==='win32'?'icon.ico':'icon.png'),
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,spellcheck:false}});
  win.loadFile(path.join(__dirname,'index.html'));
  const st=()=>{try{win.webContents.send('winstate',{max:win.isMaximized(),full:win.isFullScreen()})}catch(e){}};
  ['maximize','unmaximize','enter-full-screen','leave-full-screen','restore'].forEach(ev=>win.on(ev,st));
  win.webContents.on('did-finish-load',st);
  win.webContents.on('before-input-event',(e,i)=>{if(i.type!=='keyDown')return;if(i.key==='F12'&&i.control&&i.shift)win.webContents.toggleDevTools();else if(i.key==='F11'){win.setFullScreen(!win.isFullScreen());e.preventDefault()}});
  win.on('close',e=>{ /* 저장은 변경 즉시 됨 */ });
  // 업데이트 파일(index.html)이 바뀌면 껐다 켜지 않아도 자동 새로고침
  let rt=null,last=0;try{last=fs.statSync(path.join(__dirname,'index.html')).mtimeMs}catch(e){}
  fs.watch(__dirname,(ev,f)=>{if(!f||!/^index\.html$/i.test(f))return;clearTimeout(rt);rt=setTimeout(()=>{try{const m=fs.statSync(path.join(__dirname,'index.html')).mtimeMs;if(m===last)return;last=m}catch(e){return}
    /* 바로 새로고침하지 않고 화면에 알림 — 수정 중이거나 창이 열려 있으면 끝난 뒤에 화면이 스스로 바꿈(작업이 끊기지 않게) */
    if(win&&!win.isDestroyed())win.webContents.send('updated')},800)});
ipcMain.handle('appStale',()=>appStale());
ipcMain.handle('reloadNow',()=>{if(win&&!win.isDestroyed())win.webContents.reloadIgnoringCache();return true});
  // 폰 화면(mobile.html)이 바뀌면 GitHub·NAS에도 바로 다시 올림
  let mt=null,mlast=0;try{mlast=fs.statSync(path.join(__dirname,'mobile.html')).mtimeMs}catch(e){}
  fs.watch(__dirname,(ev,f)=>{if(!f||!/^mobile\.html$/i.test(f))return;clearTimeout(mt);mt=setTimeout(()=>{try{const m=fs.statSync(path.join(__dirname,'mobile.html')).mtimeMs;if(m===mlast)return;mlast=m}catch(e){return}
    try{publishNas()}catch(e){}try{publishGh()}catch(e){}},1500)});
});
app.on('window-all-closed',()=>app.quit());
/* ===== 에듀OK에서 명단 자동으로 받기 (재학생명부·입학희망생명부)
   아이디·비밀번호는 지점마다 이 PC에만 data/eok.json에 저장(비밀번호는 윈도우 보안 저장으로 암호화).
   보이지 않는 창에서 로그인 → 입학희망생 화면(→ 재학생은 메뉴 '재학생' 누름) → 초록 [엑셀] 누름 → 내려받은 파일을 그대로 돌려줌. AI 없이 정해진 순서대로만. */
const EOK_BASE=process.env.YMT_EOK_BASE||'https://newpremium.edu-ok.co.kr:403';
const EOK_HOPE='/content/stud/hope_list.asp?menu1=101&menu2=10101&StateCode=0104&AspUrl=hope_list.asp';
const EOKF=path.join(DATA,'eok.json');
function eokRead(){try{return JSON.parse(fs.readFileSync(EOKF,'utf8'))}catch(e){return {}}}
function eokPw(o){try{if(o.pwEnc&&safeStorage.isEncryptionAvailable())return safeStorage.decryptString(Buffer.from(o.pwEnc,'base64'));return o.pwPlain||''}catch(e){return ''}}
ipcMain.handle('eokInfo',()=>{const c=eokRead();return Object.fromEntries(Object.entries(c).map(([b,o])=>[b,{id:o.id||'',has:!!(o.pwEnc||o.pwPlain),at:o.at||0}]))});
ipcMain.handle('eokSet',(e,o)=>{const c=eokRead();const b=String(o&&o.branch||'');if(!b)return {ok:false};
  if(o.clear){delete c[b]}else{const x=c[b]||{};x.id=String(o.id||'').trim().slice(0,60);if(o.pw){if(safeStorage.isEncryptionAvailable()){x.pwEnc=safeStorage.encryptString(String(o.pw)).toString('base64');delete x.pwPlain}else{x.pwPlain=String(o.pw)}}c[b]=x}
  fs.writeFileSync(EOKF,JSON.stringify(c));return {ok:true}});
let EOKBUSY=false;
// 직접 로그인 창: 자동 로그인이 안 될 때 이 창에서 한 번 로그인하면(같은 저장소) 그 뒤 [받기]는 로그인 없이 됨
ipcMain.handle('eokOpen',()=>{const {session}=require('electron');const w=new BrowserWindow({width:1280,height:900,title:'에듀OK 로그인',autoHideMenuBar:true,webPreferences:{session:session.fromPartition('persist:eok')}});w.loadURL(EOK_BASE+EOK_HOPE).catch(()=>{});return true});
ipcMain.handle('eokFetch',async(e,o)=>{if(EOKBUSY)return {ok:false,err:'이미 받는 중이에요'};const c=eokRead()[String(o&&o.branch||'')];
  const hasC=!!(c&&c.id&&eokPw(c)); // 계정이 없어도 [직접 로그인 창]에서 로그인해 둔 상태면 받을 수 있음
  EOKBUSY=true;const kind=o.kind==='roster'?'roster':'hope';const {session}=require('electron');const ses=session.fromPartition('persist:eok');
  const w=new BrowserWindow({show:!!process.env.YMT_EOK_SHOW,width:1280,height:900,webPreferences:{session:ses,contextIsolation:true,nodeIntegration:false}});
  const wc=w.webContents;const kill=()=>{try{w.destroy()}catch(err){}};
  // 알림창은 띄우지 않고 기록만(무슨 말을 했는지 eok_log.txt에 남겨 어디서 막혔는지 알 수 있게)
  const LOG=[];const lg=m=>{LOG.push(new Date().toTimeString().slice(0,8)+' '+m)};
  const noDlg="window.alert=function(m){console.log('[ALERT] '+m)};window.confirm=function(m){console.log('[CONFIRM] '+m);return true};window.print=function(){};";
  wc.on('dom-ready',()=>{wc.executeJavaScript(noDlg).catch(()=>{});lg('열림 '+wc.getURL().replace(/[?#].*/,''))});
  wc.on('console-message',(ev,lv,msg)=>{if(/^\[(ALERT|CONFIRM)\]/.test(String(msg)))lg(String(msg).slice(0,200))});
  wc.on('did-fail-load',(ev,code,desc,url)=>{if(code!==-3)lg('못 엶 '+code+' '+desc+' '+String(url).replace(/[?#].*/,''))});
  const dom=async()=>{try{return await wc.executeJavaScript(`(function(){const q=s=>[...document.querySelectorAll(s)];return 'URL '+location.href.replace(/[?#].*/,'')+'\\n폼 '+q('form').map(f=>(f.name||f.id||'?')+'→'+(f.getAttribute('action')||'')+' '+(f.method||'')).join(' | ')+'\\n입력 '+q('input').filter(i=>i.type!=='hidden'||i.name).map(i=>i.type+':'+(i.name||i.id||'')+(i.offsetParent===null?'(숨김)':'')).join(', ')+'\\n버튼 '+q('button,input[type=submit],input[type=button],input[type=image],a[onclick],img[onclick]').map(b=>((b.innerText||b.value||b.alt||'').trim().slice(0,12)||b.tagName)+'{'+String(b.getAttribute('onclick')||'').slice(0,60)+'}').slice(0,25).join(', ')+'\\n프레임 '+q('iframe,frame').map(f=>f.src.replace(/[?#].*/,'')).join(', ')})()`)}catch(e){return 'DOM 못 읽음 '+e.message}};
  wc.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{session:ses}}}));
  let dlRes=null;const dlP=new Promise(res=>{dlRes=res});
  const onDl=(ev,item)=>{const fp=path.join(app.getPath('temp'),'ymt_eok_'+Date.now()+'_'+item.getFilename().replace(/[^\w.\-가-힣]/g,'_'));item.setSavePath(fp);
    item.once('done',(ev2,st)=>{if(st==='completed'){try{const buf=fs.readFileSync(fp);fs.unlinkSync(fp);dlRes({buf,name:item.getFilename()})}catch(err){dlRes(null)}}else dlRes(null)})};
  ses.on('will-download',onDl);
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const load=async u=>{try{await wc.loadURL(u)}catch(err){/* 이동 중 다시 이동하면 ERR_ABORTED — 무시 */}await wait(600)};
  const until=async(js,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){try{if(await wc.executeJavaScript(js))return true}catch(err){}await wait(300)}return false};
  // 로그인 화면 = 보이는 비밀번호 칸이 있고 '로그아웃'이 없음 (로그인된 화면에도 숨은 비밀번호 바꾸기 칸이 있어서)
  const HASX="[...document.querySelectorAll('a,button,input,span')].some(b=>(b.innerText||b.value||'').replace(/\\s/g,'')==='엑셀')";
  const frames=()=>{try{return wc.mainFrame.framesInSubtree}catch(e){return [wc.mainFrame]}};
  const inFrames=async js=>{for(const f of frames()){try{const r=await f.executeJavaScript(js);if(r)return r}catch(e){}}return false};
  const frameDump=async()=>{const out=[];for(const f of frames()){try{out.push(f.url.replace(/[?#].*/,'')+' : '+await f.executeJavaScript("[...document.querySelectorAll('a,button,input[type=button]')].map(b=>(b.innerText||b.value||'').trim()).filter(Boolean).slice(0,30).join(', ')"))}catch(e){out.push(f.url+' : 못 읽음')}}return out.join('\n')};
  const hasPw="(function(){const v=[...document.querySelectorAll('input[type=password]')].some(i=>i.offsetParent!==null);const out=[...document.querySelectorAll('a,button,input')].some(b=>/로그아웃/.test(b.innerText||b.value||''));return v&&!out})()";
  try{
    const either=hasPw+"||[...document.querySelectorAll('a,button,input')].some(b=>/엑셀/.test(b.innerText||b.value||''))";
    await load(EOK_BASE+EOK_HOPE);await until(either,10000); // 스크립트로 로그인 화면에 보내는 경우까지 기다림
    if(await wc.executeJavaScript(hasPw).catch(()=>false)){
      if(!hasC){const e0=new Error('에듀OK 아이디·비밀번호를 먼저 넣어 주세요');e0.login=true;throw e0}
      const js=`(function(id,pw){const p=[...document.querySelectorAll('input[type=password]')].find(i=>i.offsetParent!==null);if(!p)return 'noid';if(p.form&&/pass|pwd/i.test((p.form.getAttribute('action')||'')+(p.form.name||'')))return 'noid';const f=p.form||document;const t=[...f.querySelectorAll('input')].find(i=>i!==p&&/^(text|email|tel|)$/.test(i.type)&&i.offsetParent!==null);
        const set=(el,v)=>{el.focus();el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};if(!t)return 'noid';set(t,id);set(p,pw);
        const btn=[...document.querySelectorAll('button,input[type=submit],input[type=button],input[type=image],a,img')].find(b=>/로그인/.test((b.innerText||b.value||b.alt||'').trim())&&!/자동/.test(b.innerText||b.value||''));
        if(btn){btn.click();return 'click'}if(p.form&&!/pass|pwd/i.test(p.form.getAttribute('action')||'')){p.form.submit();return 'submit'}p.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));return 'enter'})(${JSON.stringify(c.id)},${JSON.stringify(eokPw(c))})`;
      lg('로그인 화면\n'+await dom());const r=await wc.executeJavaScript(js).catch(err=>'err');lg('로그인 시도: '+r);if(r==='noid')throw new Error('로그인 칸을 찾지 못했어요 · 에듀OK 화면이 바뀌었을 수 있어요');
      await wait(2500);await load(EOK_BASE+EOK_HOPE);await until(either,10000);
      if(await wc.executeJavaScript(hasPw).catch(()=>false)){lg('로그인 뒤에도 로그인 화면\n'+await dom());const e2=new Error('에듀OK 로그인이 안 됐어요 · 아이디·비밀번호를 확인해 주세요');e2.login=true;throw e2}}
    if(!await until("[...document.querySelectorAll('a,button,input')].some(b=>/엑셀/.test(b.innerText||b.value||''))",8000))throw new Error('입학희망생 화면을 열지 못했어요 · 에듀OK 화면이 바뀌었을 수 있어요');
    if(kind==='roster'){
      const ok=await wc.executeJavaScript("(function(){const a=[...document.querySelectorAll('a')].find(x=>(x.innerText||'').replace(/\\s/g,'')==='재학생');if(!a)return false;a.click();return true})()").catch(()=>false);
      if(!ok)throw new Error("'재학생' 메뉴를 찾지 못했어요 · 에듀OK 화면이 바뀌었을 수 있어요");
      await wait(1500);
      // 재학생 화면은 명단이 페이지 안 작은 창(iframe)에 들어 있음 → 모든 창에서 [엑셀]을 찾음
      const t0=Date.now();let okR=false;while(Date.now()-t0<15000){if(!/hope_list/.test(wc.getURL())&&await inFrames(HASX)){okR=true;break}await wait(400)}
      if(!okR){lg('재학생 화면 창들:\n'+await frameDump());throw new Error('재학생 화면을 열지 못했어요')}}
    const clicked=await inFrames("(function(){const b=[...document.querySelectorAll('a,button,input[type=button],input[type=submit],span,div')].filter(x=>(x.innerText||x.value||'').replace(/\\s/g,'')==='엑셀').pop();if(!b)return false;b.click();return true})()");
    if(!clicked)throw new Error('[엑셀] 버튼을 찾지 못했어요 · 에듀OK 화면이 바뀌었을 수 있어요');
    const got=await Promise.race([dlP,wait(45000).then(()=>null)]);
    if(!got||!got.buf||!got.buf.length)throw new Error('엑셀 파일을 받지 못했어요 · 잠시 뒤 다시 해 주세요');
    const cc=eokRead();if(cc[o.branch]){cc[o.branch].at=Date.now();fs.writeFileSync(EOKF,JSON.stringify(cc))}
    lg('받음 '+got.name+' '+got.buf.length+'바이트');try{fs.writeFileSync(path.join(DATA,'eok_log.txt'),LOG.join('\n'))}catch(e){}
    return {ok:true,b64:got.buf.toString('base64'),name:got.name}
  }catch(err){lg('실패: '+(err.message||err));if(!err.login)lg(await dom());try{fs.writeFileSync(path.join(DATA,'eok_log.txt'),LOG.join('\n'))}catch(e){}return {ok:false,err:err.message||String(err),login:!!err.login}}
  finally{ses.removeListener('will-download',onDl);if(!process.env.YMT_EOK_SHOW)kill();EOKBUSY=false}});
