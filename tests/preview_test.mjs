import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage(); await p.setViewport({width:1700,height:1000});
const logs=[]; p.on('console',m=>logs.push(m.text())); p.on('pageerror',e=>logs.push('PAGEERR '+e.message));
await p.goto('file:///home/claude/ComfyUI-TexturePainterAI/preview.html');
await new Promise(r=>setTimeout(r,2500));
const r = await p.evaluate(async()=>{
  const ed=window.preview.ed; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const p3=ed.ui.pane3d; ed.state.brush.size=140;
  ed.beginStroke(false);
  for(let i=0;i<14;i++){ed.strokeMove(p3.offsetWidth*0.35+i*14,p3.offsetHeight*0.45+Math.sin(i/2)*30,0);}
  ed.endStroke(); await sleep(300);
  window.scrollTo(0,0);
  return {mask:!ed.maskIsEmpty(), tris: ed.info&&ed.info.triangles};
});
await p.screenshot({path:'/tmp/prev1.png'});
await p.click('#gen'); await new Promise(r=>setTimeout(r,3500));
await p.screenshot({path:'/tmp/prev2.png'});
const r2 = await p.evaluate(()=>{const ed=window.preview.ed; const had=!!ed.pending; ed.applyResult(); return {had, after:!ed.pending, layers:ed.layers.layers.length, name:ed.layers.layers[ed.layers.active].name, maskEmpty:ed.maskIsEmpty()};});
await new Promise(r=>setTimeout(r,500));
await p.screenshot({path:'/tmp/prev3.png'});
console.log(JSON.stringify({r,r2}),'\n',logs.filter(l=>!/GPU stall/.test(l)).join('\n'));
await b.close();
