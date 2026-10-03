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
    ['gamma-nfl','https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=nfl&limit=3']
  ];
  for(const [name,url] of tests){
    try{const r=await fetch(url,{headers:{accept:'application/json','user-agent':'WhaleSignalSportsLab/1.0'}});const body=await r.text();console.log('SELFTEST',name,r.status,body.slice(0,180).replace(/\n/g,' '))}
    catch(e){console.log('SELFTEST',name,'ERROR',e.message)}
  }
}
server.listen(PORT,'0.0.0.0',()=>{console.log('WhaleSignal listening on',PORT);upstreamSelfTest()});