const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:720},deviceScaleFactor:2});
await p.goto('file://'+__dirname+'/term.html',{waitUntil:'networkidle'});await p.waitForTimeout(500);
const r=await p.evaluate(()=>{const o={};const w=document.querySelector('.win').getBoundingClientRect();o.win=[w.x,w.y,w.width,w.height];
const pre=document.querySelector('pre');const rg=document.createRange();o.lines=[];const t=pre.textContent.split('\n');
o.font=getComputedStyle(pre).fontFamily;return o});
console.log(JSON.stringify(r));await p.screenshot({path:'D.jpg',type:'jpeg',quality:92});await b.close()})();
