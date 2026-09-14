import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startTestApp } from './start-test-app.mjs';
import { openExistingCatalogDatabase } from '../app/catalog/database.mjs';
const output=resolve('docs/assets/screenshots');mkdirSync(output,{recursive:true});
const app=await startTestApp({generationResourceFixture:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
 const art=await browser.newPage({viewport:{width:360,height:480}});
 const palettes=[['#d9e4df','#6a8880','#355952'],['#f2dfc3','#bd8259','#684c42'],['#dce0ef','#8d98b6','#4b5876']];
 const imagePaths=[];
 for(let i=0;i<3;i++) {
  const [sky,middle,front]=palettes[i];
  await art.setContent(`<html><body style="margin:0"><svg width="360" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="480" fill="${sky}"/><circle cx="265" cy="115" r="52" fill="#fff8e8"/><path d="M0 350L140 140 330 360 360 300V480H0Z" fill="${middle}"/><path d="M0 440L90 310 180 365 280 250 360 355V480H0Z" fill="${front}"/><path d="M190 480L225 390 240 400 260 480" fill="#fff8e8" opacity=".7"/></svg></body></html>`);
  const path=`docs-demo/landscape-${i}.png`;mkdirSync(resolve(app.paths.media,'docs-demo'),{recursive:true});
  await art.screenshot({path:resolve(app.paths.media,path)});imagePaths.push(path);
 }
 await art.close();
 const database=openExistingCatalogDatabase({databasePath:app.paths.database});
 try {
  database.exec("UPDATE generation_base_models SET name='示例底模 · Illustration' WHERE id=801;UPDATE generation_models SET file_name='illustration-demo.safetensors',description='示例模型：整理文件信息、参考图片和使用说明。',usage='按实际模型填写推荐设置与来源。' WHERE id=802;");
  database.exec("UPDATE works SET name='山间旅记',name_normalized='山间旅记',category_name='示例作品';UPDATE characters SET name='旅人',prompt_text='traveler, mountain landscape';UPDATE styles SET name='柔和色块',style_description='以简洁色块组织山形、天空与远景。';UPDATE comfyui_templates SET title='示例 · 文生图模板';UPDATE generation_loras SET file_name='landscape-demo.safetensors';");
  database.exec("DELETE FROM item_images;UPDATE generation_base_models SET name='示例底模 '||id;");
  const owners=[['work','works'],['character','characters'],['style','styles'],['model','generation_models'],['template','comfyui_templates']];
  for(let i=0;i<owners.length;i++) {
   const [kind,table]=owners[i],row=database.prepare(`SELECT id FROM ${table} LIMIT 1`).get();
   const path=`docs-demo/${kind}.png`;copyFileSync(resolve(app.paths.media,imagePaths[i%3]),resolve(app.paths.media,path));
   database.prepare("INSERT INTO item_images(owner_kind,owner_id,content_hash,media_path,sort_order,created_at,updated_at) VALUES(?,?,'demo',?,?,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')").run(kind,row.id,path,database.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM item_images WHERE owner_kind=? AND owner_id=?').get(kind,row.id).n);
   database.prepare(`UPDATE ${table} SET cover_media_path=? WHERE id=?`).run(path,row.id);
  }
  const term=database.prepare("INSERT INTO prompt_terms(canonical_tag,category,post_count,aliases_json,created_at,updated_at) VALUES(?,0,?,?,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')");
  for(const [i,name] of ['mountain landscape','soft lighting','ink drawing','warm colors'].entries()) term.run(name,100+i*25,JSON.stringify([['山景','远山'],['柔光'],['墨线'],['暖色']][i]));
 } finally {database.close();}
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 const pages=[['home','/'],['catalog','/app/web/manage.html'],['prompt-tags','/manage/prompt-terms'],['models','/manage/models'],['template','/manage/comfyui-templates']];
 for(const [name,path] of pages) {
  await page.goto(`${app.baseUrl}${path}`,{waitUntil:'networkidle'});
  if(name==='template') {
   const edit=page.getByRole('button',{name:'编辑',exact:true}).first();
   if(await edit.count()) {await edit.click();await page.waitForFunction(()=>document.querySelector('#template-form input[name=title]')?.value==='示例 · 文生图模板');}
  }
  await page.screenshot({path:resolve(output,`${name}.png`),...(['catalog','prompt-tags','models'].includes(name)?{clip:{x:0,y:0,width:1440,height:520}}:{fullPage:false})});
 }
 await page.goto(`${app.baseUrl}/app/web/manage.html`,{waitUntil:'networkidle'});
 const detail=page.getByRole('button',{name:'编辑',exact:true}).first();
 if(await detail.count()) {await detail.click();await page.waitForLoadState('networkidle');}
 await page.screenshot({path:resolve(output,'detail.png')});
 console.log(output);
} finally {await browser.close();await app.close();}
