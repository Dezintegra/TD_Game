# Воспроизведение визуальной проверки

Проверен код `68da550fc18e2ef1995c666e97f2aca7d8a0f887`, 06.09.2026.

Chromium 151.0.7922.34, Playwright 1.62.1, Windows, headless WebGL, DPR 1; плотность запекания 4, дешёвые текстуры выключены. Это проверка изображения, не замер кадров. Сервер матча, сеть и React HUD здесь не проверяются.

Страница вызывает настоящие `createRendererHost`, `createScene` и `attachControls` из назначенного дерева. Мир создан с seed 41 и оставлен на тике 0; для воспроизводимого расположения отражений карта заменена плоским полем с грядой x=8..11, y=8..9. Базы и генералы взяты из начального мира, добавлен штурмовик id=100 в центре клетки (13,10), owner=0, facing=3, kills=0. Время кадра фиксируется на 10000 или 15000 мс. Рисуются двенадцать одинаковых кадров, чтобы миникарта успела обновиться.

В своём дереве установить зависимости и собрать только библиотеки, необходимые странице:

```powershell
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter "@td/client^..." build
```

Сохранить четыре блока ниже под указанными именами в `.matchlog/`. Порт 5241 должен быть свободен. Браузер берётся из уже установленного кеша Playwright; профиль и временные файлы остаются в `.matchlog/`. Запуск:

```powershell
node .matchlog/capture-field.mjs
node .matchlog/analyze-field.mjs
```

PNG сохраняются без изменения размера в `.matchlog/field-shots/`; `conditions.json` содержит параметры каждого кадра, `analysis.json` — числовую проверку. Для проверки перекрытия мглы контрольные PNG с суффиксом `hidden` сняты с выключенным только контейнером облаков. Основные PNG показывают обычную сцену.

## .matchlog/field.html

```html
<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}#scene{position:fixed;inset:0}</style></head><body><script type="module" src="/.matchlog/field.ts"></script></body></html>
```

## .matchlog/field.ts

```typescript
import '../packages/ui/src/tokens.css';
import { createRendererHost, createScene } from '../apps/client/src/game/scene.ts';
import { attachControls } from '../apps/client/src/game/controls.ts';
import { worldToScreen } from '../apps/client/src/game/iso.ts';
import { createWorld, cellIndex, cellCentre } from '../packages/sim/src/index.ts';
import { Terrain, UnitType } from '../packages/shared/src/index.ts';

const host = await createRendererHost();
const scene = createScene(host);
host.app.ticker.stop();
const world = createWorld(41);
world.map.cells.fill(Terrain.Ground);
for (let x = 8; x <= 11; x++) for (let y = 8; y <= 9; y++) world.map.cells[cellIndex(x,y)] = Terrain.Rock;
world.units = [{id:100, owner:0, unitType:UnitType.Assault, position:cellCentre(cellIndex(13,10)), health:100, facing:3, readyAtTick:0, kills:0}];
scene.setMap(world.map,0);
while(scene.bakeTerrain(8)) await new Promise(requestAnimationFrame);
const noop = () => {};
const controls = attachControls(host.element, {
  setDirection:noop, build:noop, train:noop, setTarget:noop, setStance:noop, nuke:noop,
  pan:scene.panBy, zoom:scene.zoomBy, jumpTo:scene.centreOnCell, recentre:noop,
  toggleSound:noop, select:noop, menuChanged:noop, toggleStats:noop,
  closeUpgradePanel:()=>false, cellAtScreen:scene.cellAtScreen, minimapCellAtScreen:scene.minimapCellAtScreen,
});
let time=10000;
Object.defineProperty(performance,'now',{value:()=>time, configurable:true});
const render = () => {
  for(let frame=0;frame<12;frame++) scene.render(world,0,{...controls.state,hoverAllowed:false,nukeRadiusCells:0});
  host.app.render();
};
const position = (x,y) => {
  const point=worldToScreen(x,y);
  const container=host.app.stage.children[0].children[1];
  return {x:point.x*container.scale.x+container.x,y:point.y*container.scale.y+container.y};
};
window.field={scene,host,world,controls,render,position,
  capture(zoom,x,y,t=10000){time=t;scene.resize();scene.zoomBy(zoom/scene.zoom,innerWidth/2,innerHeight/2);scene.centreOnCell(cellIndex(x,y));render();return {zoom:scene.zoom,scale:scene.scale,viewport:scene.viewportSize,density:host.density,renderer:host.app.renderer.name,unit:position(13.5,10.5),rock:position(10,9),corners:[[0,0],[38,0],[38,38],[0,38]].map(p=>position(...p))};},
  cloudVisibility(visible){host.app.stage.children[0].children[0].visible=visible;render();},
  pixels(){render();return host.app.canvas.toDataURL('image/png');}
};
window.field.capture(1,0,0);
```

## .matchlog/capture-field.mjs

```javascript
import { createServer } from '../apps/client/node_modules/vite/dist/node/index.js';
import { chromium } from '@playwright/test';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const output=resolve('.matchlog/field-shots');
await mkdir(output,{recursive:true});
await mkdir('.matchlog/browser-temp',{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:5241,strictPort:true},resolve:{alias:{'@td/shared':resolve('packages/shared/src/index.ts'),'@td/sim':resolve('packages/sim/src/index.ts')}}});
await server.listen();
let browser;
try {
  browser=await chromium.launchPersistentContext(resolve('.matchlog/browser-profile'),{headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1,env:{...process.env,TEMP:resolve('.matchlog/browser-temp'),TMP:resolve('.matchlog/browser-temp')},args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage();
  page.on('pageerror',error=>console.error(error.message));
  await page.goto('http://127.0.0.1:5241/.matchlog/field.html');
  await page.waitForFunction(()=>Boolean(window.field),{},{timeout:120000});
  const records=[];
  for(const [name,zoom,x,y,time,width,height] of [
    ['grid-off',1,0,0,10000,1280,720],
    ['grid-on',1,0,0,10000,1280,720],
    ['grid-off-again',1,0,0,10000,1280,720],
    ['cloud-far-a',1,0,0,10000,1280,720],
    ['cloud-far-b',1,0,0,15000,1280,720],
    ['cloud-near-a',4,0,0,10000,1280,720],
    ['cloud-near-b',4,0,0,15000,1280,720],
    ['cloud-narrow-far-a',1,0,0,10000,420,800],
    ['cloud-narrow-far-b',1,0,0,15000,420,800],
    ['cloud-narrow-near-a',4,0,0,10000,420,800],
    ['cloud-narrow-near-b',4,0,0,15000,420,800],
    ['reflections',2,11,10,10000,1280,720],
  ]) {
    await page.setViewportSize({width,height});
    if(name==='grid-on'||name==='grid-off-again') await page.keyboard.press('KeyQ');
    const info=await page.evaluate(([z,x,y,t])=>window.field.capture(z,x,y,t),[zoom,x,y,time]);
    await page.screenshot({path:resolve(output,`${name}.png`)});
    records.push({name,time,width,height,...info,building:await page.evaluate(()=>window.field.controls.state.building)});
    if(name.startsWith('cloud-')&&name.endsWith('-a')){
      await page.evaluate(()=>window.field.cloudVisibility(false));
      await page.screenshot({path:resolve(output,`${name}-hidden.png`)});
      await page.evaluate(()=>window.field.cloudVisibility(true));
    }
    console.log(name,JSON.stringify(info));
  }
  await writeFile(resolve(output,'conditions.json'),JSON.stringify({browser:browser.browser()?.version(),records},null,2));
}finally{await browser?.close();await server.close();}
```

## .matchlog/analyze-field.mjs

```javascript
import bundle from '../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/lib/utilsBundle.js';
import {readFile,writeFile} from 'node:fs/promises';
const {PNG}=bundle;
const dir='.matchlog/field-shots';
const load=async name=>PNG.sync.read(await readFile(`${dir}/${name}.png`));
const conditions=JSON.parse(await readFile(`${dir}/conditions.json`,'utf8'));
const rgb=(png,x,y)=>Array.from(png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+3));
const differs=(a,b,x,y)=>rgb(a,x,y).some((value,c)=>value!==rgb(b,x,y)[c]);
const edgeDistance=(corners,x,y)=>Math.min(...corners.map((a,i)=>{const b=corners[(i+1)%corners.length];return ((b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x))/Math.hypot(b.x-a.x,b.y-a.y);}));
const clouds=[];
for(const condition of conditions.records.filter(record=>record.name.startsWith('cloud-')&&record.name.endsWith('-a'))){
 const a=await load(condition.name),b=await load(condition.name.replace(/-a$/,'-b')),hidden=await load(`${condition.name}-hidden`);
 let inside=0,insideChanges=0,outside=0,outsideCloud=0,outsideMovement=0;
 for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
  const distance=edgeDistance(condition.corners,x+.5,y+.5);
  if(distance>3){inside++;if(differs(a,hidden,x,y))insideChanges++;}
  if(distance< -3){outside++;if(differs(a,hidden,x,y))outsideCloud++;if(differs(a,b,x,y))outsideMovement++;}
 }
 clouds.push({name:condition.name,inside,insideChanges,outside,outsideCloud,outsideMovement});
}
const off=await load('grid-off'),on=await load('grid-on'),again=await load('grid-off-again');
let returnedDifferences=0,appeared=0;
const gridPoints=[];
for(let y=300;y<700;y++)for(let x=20;x<500;x++){
 if(differs(off,again,x,y))returnedDifferences++;
 if(rgb(off,x,y).every(v=>v===0)&&rgb(on,x,y).some(v=>v>10)){
 appeared++;if(gridPoints.length<3)gridPoints.push({x,y,off:rgb(off,x,y),on:rgb(on,x,y),again:rgb(again,x,y)});
 }
}
const reflection=await load('reflections');
const points=[['machine',831,466],['rock',655,337],['field-machine',900,480],['field-rock',610,425]].map(([name,x,y])=>{const values=rgb(reflection,x,y);return {name,x,y,RGB:values,Y:values.reduce((a,b)=>a+b,0)/3};});
const result={conditions,clouds,grid:{appeared,returnedDifferences,gridPoints,border:[off,on,again].map(png=>rgb(png,400,161))},reflections:points};
await writeFile(`${dir}/analysis.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({clouds,grid:result.grid,reflections:points},null,2));
```
