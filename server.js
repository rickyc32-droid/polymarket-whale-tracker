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
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'WhaleSignalSportsLab/1.0'}});
    const body=await r.text();
    if(r.ok)cache.set(url,{at:now,status:r.status,body});
    res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json','cache-control':'no-store'});
    res.end(body);
  }catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'upstream_unavailable',message:e.message}))}
}
const server=http.createServer(async(req,res)=>{
  const u=req.url||'/';
  for(const [prefix,base] of Object.entries(roots))if(u.startsWith(prefix))return proxy(req,res,prefix,base);
  if(u==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,time:new Date().toISOString()}))}
  const file=u==='/'?'/index.html':u.split('?')[0];
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