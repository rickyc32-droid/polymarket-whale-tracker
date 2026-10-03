const http=require('http'),fs=require('fs'),path=require('path');
const PORT=process.env.PORT||10000;
const roots={
  '/api/data/':'https://data-api.polymarket.com/',
  '/api/gamma/':'https://gamma-api.polymarket.com/',
  '/api/clob/':'https://clob.polymarket.com/'
};
const cache=new Map();
async function proxy(req,res,prefix,base){
  const rest=req.url.slice(prefix.length);
  const url=base+rest;
  const now=Date.now(), hit=cache.get(url);
  if(hit && now-hit.at<15000){res.writeHead(hit.status,{'content-type':'application/json','cache-control':'public,max-age=10'});return res.end(hit.body)}
  try{
    const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),9000); const r=await fetch(url,{headers:{accept:'application/json','user-agent':'WhaleSignalSportsLab/1.0'},signal:ac.signal}); clearTimeout(tm);
    const body=await r.text();
    if(r.ok)cache.set(url,{at:now,status:r.status,body});
    res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json','cache-control':'no-store'});
    res.end(body);
  }catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'upstream_unavailable',message:e.message}))}
}

const dashboardCache=new Map();
function leagueMatch(title,league){
  const t=String(title||'').toLowerCase();
  const map={
    nfl:['nfl','super bowl','touchdown','passing yards','receiving yards','rushing yards','cardinals','falcons','ravens','bills','panthers','bears','bengals','browns','cowboys','broncos','lions','packers','texans','colts','jaguars','chiefs','raiders','chargers','rams','dolphins','vikings','patriots','saints','giants','jets','eagles','steelers','49ers','seahawks','buccaneers','titans','commanders'],
    nba:['nba','celtics','nets','knicks','76ers','raptors','bulls','cavaliers','pistons','pacers','bucks','hawks','hornets','heat','magic','wizards','nuggets','timberwolves','thunder','trail blazers','jazz','warriors','clippers','lakers','suns','kings','mavericks','rockets','grizzlies','pelicans','spurs'],
    mlb:['mlb','world series','yankees','red sox','blue jays','orioles','rays','guardians','tigers','royals','twins','white sox','astros','mariners','rangers','athletics','angels','mets','phillies','braves','marlins','nationals','cubs','brewers','cardinals','reds','pirates','dodgers','padres','giants','diamondbacks','rockies'],
    nhl:['nhl','stanley cup'],
    ufc:['ufc'],
    soccer:['soccer','premier league','champions league','la liga','serie a','bundesliga','mls','world cup']
  };
  return (map[league]||[league]).some(k=>t.includes(k));
}
async function fj(url,ms=3000){
  const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),ms);
  try{
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'WhaleSignalSportsLab/2.0'},signal:ac.signal});
    if(!r.ok) throw new Error(String(r.status));
    return await r.json();
  }finally{clearTimeout(tm)}
}
async function buildDashboard(league,period){
  const key=league+'|'+period, now=Date.now(), cached=dashboardCache.get(key);
  if(cached && now-cached.at<15000) return cached.data;
  const tp=period==='all'?'all':period;
  let lbRaw;
  try{lbRaw=await fj('https://data-api.polymarket.com/v2/leaderboard?category=sports&time_period='+encodeURIComponent(tp)+'&sort_by=PNL&limit=30',3500)}
  catch{
    const p=period==='all'?'ALL':String(period).toUpperCase();
    lbRaw=await fj('https://data-api.polymarket.com/v1/leaderboard?category=SPORTS&timePeriod='+p+'&orderBy=PNL&limit=30&offset=0',3500);
  }
  const lba=Array.isArray(lbRaw)?lbRaw:(lbRaw?.data||[]);
  const traders=lba.slice(0,30).map((r,i)=>({
    rank:Number(r.rank)||i+1,
    wallet:r.user_id||r.proxy_wallet||r.address||r.proxyWallet||r.user||'',
    name:r.user_name||r.userName||r.username||r.name||'Trader '+(i+1),
    pnl:Number(r.pnl??r.profit??r.cash_pnl)||0,
    volume:Number(r.volume_usdc??r.volume??r.vol)||0
  })).filter(t=>t.wallet);

  const vals=traders.map(t=>t.pnl), min=Math.min(...vals), max=Math.max(...vals), span=(max-min)||1;
  traders.forEach(t=>{t.weight=.65*Math.max(25,100-(t.rank-1)*2.6)+.35*(25+75*((t.pnl-min)/span))});

  const posLists=await Promise.all(traders.map(async t=>{
    const w=encodeURIComponent(t.wallet);
    let raw;
    try{raw=await fj('https://data-api.polymarket.com/v2/positions?user='+w+'&status=OPEN&limit=250',3000)}
    catch{
      try{raw=await fj('https://data-api.polymarket.com/positions?user='+w+'&sizeThreshold=0.1&limit=250',3000)}
      catch{return []}
    }
    const a=Array.isArray(raw)?raw:(raw?.data||[]);
    return a.map(p=>({
      id:String(p.condition_id||p.conditionId||p.market||'').toLowerCase(),
      token:String(p.token_id||p.asset||''),
      out:p.outcome||p.outcome_label||'',
      size:Number(p.current_size??p.size)||0,
      avg:Number(p.avg_price??p.avgPrice)||0,
      cur:Number(p.current_price??p.curPrice)||0,
      value:Number(p.current_value??p.currentValue)||0,
      cost:Number(p.entry_cost_usdc??p.initialValue??p.total_cost_usdc)||0,
      title:p.title||p.name||''
    })).filter(p=>p.size>0&&p.id&&leagueMatch(p.title,league));
  }));

  const groups=new Map(), marketTraders=new Map();
  traders.forEach((t,i)=>{
    const lp=posLists[i]||[]; t.leaguePositionsCount=lp.length;
    for(const p of lp){
      const mk=p.id, k=mk+'|'+String(p.out||p.token);
      if(!groups.has(k)) groups.set(k,[]);
      groups.get(k).push({t,p});
      if(!marketTraders.has(mk)) marketTraders.set(mk,new Set());
      marketTraders.get(mk).add(t.wallet.toLowerCase());
    }
  });

  const signals=[];
  for(const [k,rows0] of groups){
    const dedup=new Map(rows0.map(r=>[r.t.wallet.toLowerCase(),r]));
    const rows=[...dedup.values()];
    if(rows.length<2) continue;
    const p0=rows[0].p, marketWallets=marketTraders.get(p0.id)||new Set();
    const total=traders.filter(t=>marketWallets.has(t.wallet.toLowerCase())).reduce((a,t)=>a+t.weight,0)||1;
    const agree=rows.reduce((a,r)=>a+r.t.weight,0)/total;
    const ex=rows.reduce((a,r)=>a+Math.max(r.p.cost,r.p.value,r.p.size*r.p.avg),0);
    const den=rows.reduce((a,r)=>a+Math.max(1,r.p.cost,r.p.size*r.p.avg),0);
    const avg=rows.reduce((a,r)=>a+r.p.avg*Math.max(1,r.p.cost,r.p.size*r.p.avg),0)/den;
    const cur=rows.reduce((a,r)=>a+r.p.cur,0)/rows.length;
    signals.push({
      id:k,cid:p0.id,token:p0.token,title:p0.title||p0.id,out:p0.out||'Outcome',
      wallets:rows.length,agree,ex,avg,cur,copy:null,diff:null,
      traders:rows.map(r=>({name:r.t.name,rank:r.t.rank,entry:r.p.avg,size:r.p.size}))
    });
  }
  signals.sort((a,b)=>b.wallets-a.wallets||b.agree-a.agree);

  await Promise.all(signals.slice(0,25).map(async sig=>{
    if(!sig.token) return;
    let px=null;
    try{
      const q=await fj('https://clob.polymarket.com/price?token_id='+encodeURIComponent(sig.token)+'&side=BUY',1800);
      if(Number(q?.price)>0&&Number(q?.price)<1) px=Number(q.price);
    }catch{}
    if(px==null){
      try{
        const b=await fj('https://clob.polymarket.com/book?token_id='+encodeURIComponent(sig.token),1800);
        const asks=(b?.asks||[]).map(x=>Number(x.price)).filter(x=>x>0&&x<1).sort((a,b)=>a-b);
        if(asks.length) px=asks[0];
      }catch{}
    }
    if(px!=null){sig.copy=px;sig.diff=px-sig.avg}
  }));

  const data={
    generatedAt:new Date().toISOString(),
    traders:traders.map(t=>({...t,lp:Array(Math.min(t.leaguePositionsCount,20)).fill(0)})),
    signals,
    trades:[],
    meta:{tracked:traders.length,active:traders.filter(t=>t.leaguePositionsCount>0).length,league,period}
  };
  dashboardCache.set(key,{at:Date.now(),data});
  return data;
}

const server=http.createServer(async(req,res)=>{
  const u=req.url||'/';
  const parsedUrl=new URL(u,'http://localhost');
  const pathname=parsedUrl.pathname;
  if(pathname==='/api/dashboard'){
    const league=(parsedUrl.searchParams.get('league')||'nfl').toLowerCase();
    const period=(parsedUrl.searchParams.get('period')||'week').toLowerCase();
    try{const data=await buildDashboard(league,period);res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(data))}
    catch(e){res.writeHead(502,{'content-type':'application/json'});return res.end(JSON.stringify({error:'dashboard_failed',message:e.message}))}
  }
  for(const [prefix,base] of Object.entries(roots))if(pathname.startsWith(prefix))return proxy(req,res,prefix,base);
  if(pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,time:new Date().toISOString()}))}
  const file=pathname==='/'?'/index.html':pathname;
  const safe=path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp=path.join(__dirname,safe);
  if(!fp.startsWith(__dirname)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(fp,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found')}
    const ext=path.extname(fp),types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json'};
    res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-store':'public,max-age=3600'});
    res.end(data)
  });
});
async function upstreamSelfTest(){
  const tests=[
    ['leaderboard-v2','https://data-api.polymarket.com/v2/leaderboard?category=sports&time_period=week&sort_by=PNL&limit=3'],
    ['leaderboard-v1','https://data-api.polymarket.com/v1/leaderboard?category=SPORTS&timePeriod=WEEK&orderBy=PNL&limit=3&offset=0'],
    ['gamma-sports','https://gamma-api.polymarket.com/sports'],['positions-sample','https://data-api.polymarket.com/v2/positions?user=0xf0318c32136c2db7fec88b84869aee6a1106c80c&status=OPEN&limit=5'],['positions-v1-sample','https://data-api.polymarket.com/positions?user=0xf0318c32136c2db7fec88b84869aee6a1106c80c&sizeThreshold=0.1&limit=5']
  ];
  for(const [name,url] of tests){
    try{
      const r=await fetch(url,{headers:{accept:'application/json','user-agent':'WhaleSignalSportsLab/1.0'}});
      const body=await r.text();
      let detail=body.slice(0,180).replace(/\n/g,' ');
      try{
        const parsed=JSON.parse(body);
        if(name==='gamma-sports'){
          const row=(Array.isArray(parsed)?parsed:parsed.data||[]).find(x=>String(x.sport||x.name||'').toLowerCase()==='nfl');
          detail='NFL_RECORD '+JSON.stringify(row||null);
        }
        if(name==='positions-sample'){
          const row=(Array.isArray(parsed)?parsed:(parsed.data||[]))[0]||{};
          detail='POSITION_FIELDS '+JSON.stringify({condition_id:row.condition_id,token_id:row.token_id,outcome:row.outcome,title:row.title,current_size:row.current_size,avg_price:row.avg_price,current_price:row.current_price,entry_cost_usdc:row.entry_cost_usdc,current_value:row.current_value});
        }
      }catch{}
      console.log('SELFTEST',name,r.status,detail)
    }catch(e){console.log('SELFTEST',name,'ERROR',e.message)}
  }
}
server.listen(PORT,'0.0.0.0',()=>{console.log('WhaleSignal listening on',PORT);upstreamSelfTest()});