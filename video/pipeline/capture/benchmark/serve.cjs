const http=require('http'),fs=require('fs'),path=require('path');
const R='/home/user/bench';
const T={'.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.js':'text/javascript','.css':'text/css'};
http.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);
 let f= u==='/benchmark'?R+'/public/benchmark.html': u.startsWith('/demo/img')?R+u: R+'/public'+(u==='/'?'/index.html':u);
 fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end();return}s.writeHead(200,{'content-type':T[path.extname(f)]||'application/octet-stream'});s.end(d)})}).listen(3300,()=>console.log('up'));
