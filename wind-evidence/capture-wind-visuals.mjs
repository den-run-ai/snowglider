import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '/workspace/scratch/a21195a756ba/snowglider/node_modules/playwright/index.mjs';
import { prepareRenderScenario, enterRenderPhase, captureRenderCanvas } from '/workspace/scratch/a21195a756ba/snowglider/tests/e2e/render-scenarios.ts';
const root='/workspace/scratch/a21195a756ba';
const output=`${root}/wind-evidence`;
const revisions=[{name:'before',cwd:'/workspace/scratch/b943da49f5fb/snowglider',port:8097},{name:'after',cwd:`${root}/snowglider`,port:8098}];
const servers=[];
const metadata={capturedAt:new Date().toISOString(),seed:0x531060d5,description:'Production bundles, explicit low quality (512px shadow maps), default shared wind. Real EZ-Tree player scene; scripted render clock with actual physics/rendering. No music/audio. Identical prescribed wind/camera inputs on BASE and HEAD.',revisions:[],captures:[]};
let browser;
try {
  await mkdir(`${output}/frames`,{recursive:true});
  for(const revision of revisions){
    metadata.revisions.push({...revision,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:revision.cwd,encoding:'utf8'}).trim(),workingChanges:execFileSync('git',['status','--porcelain'],{cwd:revision.cwd,encoding:'utf8'})});
  }
  browser=await chromium.launch({executablePath:'/home/agent/.cache/puppeteer/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--num-raster-threads=2','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  for(const revision of revisions){
    const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(revision.port),'--strictPort'],{cwd:revision.cwd,stdio:['ignore','pipe','pipe']});servers.push(server);
    await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes(`127.0.0.1:${revision.port}`))resolve();});server.stderr.on('data',d=>process.stderr.write(d));server.on('exit',c=>reject(Error('Vite exited '+c)));});
    for(const device of ['desktop','phone']){
      const viewport=device==='desktop'?{width:960,height:540}:{width:390,height:844};
      const ctx=await browser.newContext({baseURL:`http://127.0.0.1:${revision.port}`,viewport,deviceScaleFactor:1,isMobile:device==='phone',hasTouch:device==='phone'});
      const page=await ctx.newPage();page.setDefaultTimeout(90000);
      console.log(`Preparing ${revision.name} ${device}`);
      page.on('console',m=>{if(['error','warn'].includes(m.type()))console.log('PAGE',m.type(),m.text());});page.on('pageerror',e=>console.log('PAGE ERROR',e.message));page.on('requestfailed',r=>console.log('REQUEST FAILED',r.url(),r.failure()?.errorText));
      const originalGoto=page.goto.bind(page); page.goto=(url,options)=>originalGoto(url.replace('quality=high','quality=low'),options);
      const errors=await prepareRenderScenario(page).catch(async e=>{console.log('BOOT FAILED',String(e));if(!page.isClosed())console.log('Boot snapshot',await page.evaluate(()=>({scene:!!window.scene,init:typeof window.initializeGameWithAudio,main:document.body.innerText.slice(-1000)}))).catch(()=>{});throw e;});
      console.log('Player scene ready');
      await enterRenderPhase(page,'downhill'); console.log('Downhill phase ready');
      await page.evaluate(()=>{window.cameraManager.setMode('follow');window.cameraManager.initialize(window.snowman.position,window.snowman.rotation,window.velocity);for(let i=0;i<2;i++)window.__renderClock.step();});
      console.log('Camera settled');
      const evidence=await page.evaluate(()=>({ezBranches:window.scene.children.filter(o=>o.userData.forestPart==='ezBranches').reduce((s,o)=>s+o.count,0),mode:window.cameraManager.mode,position:{...window.pos},calls:window.renderer.info.render.calls,programs:window.renderer.info.programs.length,geometries:window.renderer.info.memory.geometries,textures:window.renderer.info.memory.textures}));
      console.log('Evidence',JSON.stringify(evidence));
      if(!evidence.ezBranches)throw Error('No real player EZ forest');
      const file=`${revision.name}-${device}-follow.png`;
      await writeFile(`${output}/${file}`,await captureRenderCanvas(page));console.log('Canvas saved',file);
      await page.screenshot({path:`${output}/${revision.name}-${device}-player-ui.png`,timeout:10000});
      metadata.captures.push({revision:revision.name,device,file,...evidence,errors});
      console.log(JSON.stringify(metadata.captures.at(-1)));
      if(device==='desktop'){
        await page.evaluate(()=>{window.cameraManager.setMode('orbit');window.cameraManager.setOrbitYaw(0.65);window.cameraManager.adjustZoom(0.6);window.cameraManager.initialize(window.snowman.position,window.snowman.rotation,window.velocity);for(let i=0;i<2;i++)window.__renderClock.step();});
        const detail=`${revision.name}-desktop-crosswind-detail.png`;
        await writeFile(`${output}/${detail}`,await captureRenderCanvas(page));
        metadata.captures.push({revision:revision.name,device,file:detail,view:'player orbit closeup',errors:[...errors]});
        console.log(`Captured ${detail}`);
        if(revision.name==='after'){
          await page.setViewportSize({width:960,height:540});
          for(let i=0;i<36;i++){
            await page.evaluate(()=>{for(let j=0;j<5;j++)window.__renderClock.step();});
            await writeFile(`${output}/frames/wind-${String(i).padStart(3,'0')}.png`,await captureRenderCanvas(page));
          }
          metadata.animation={frames:36,frameRate:12,simulationStepsPerFrame:5,simulationRate:60,description:'Three seconds of actual fixed-step game physics and wind; played at the matching 12fps capture rate.'};
          console.log('Captured 36 genuine animation frames');
        }
      }
      if(errors.length)throw Error(JSON.stringify(errors));
      await ctx.close();
      await writeFile(`${output}/visual-metadata.json`,JSON.stringify(metadata,null,2));
    }
    server.kill('SIGTERM');
  }
} finally {
  await writeFile(`${output}/visual-metadata.json`,JSON.stringify(metadata,null,2));
  await browser?.close();for(const s of servers)s.kill('SIGTERM');
}
