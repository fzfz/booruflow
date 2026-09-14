import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,linkSync,lstatSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openCatalogDatabase,openExistingCatalogDatabase} from '../../../app/catalog/database.mjs';
import {exportPackage,readPackage,safePath} from '../../../app/data-package/package.mjs';
import {importPackage,checkImport,recoverImport} from '../../../app/data-package/import.mjs';
import {assertEmptyDatabase,initializeDatabase,migrateDatabase} from '../../../app/data-package/database.mjs';
const root=resolve(import.meta.dirname,'../../..');
const environment={NOOBAI_EMBEDDING_BASE_URL:'http://example.test/v1',NOOBAI_EMBEDDING_API_KEY:'test',NOOBAI_EMBEDDING_MODEL:'test-1024',NOOBAI_RERANKER_BASE_URL:'http://example.test/v1',NOOBAI_RERANKER_API_KEY:'test',NOOBAI_RERANKER_MODEL:'test-rerank'};
function setup(t) {
 const dir=mkdtempSync(join(tmpdir(),'booruflow-test-')),source=openCatalogDatabase({includeBuiltinComfyuiCatalog:false}),database=openCatalogDatabase({includeBuiltinComfyuiCatalog:false});
 t.after(()=>{source.close();database.close();rmSync(dir,{recursive:true,force:true});});
 const mediaRoot=join(dir,'target-media'),srcMedia=join(dir,'source-media'),input=join(dir,'packet');mkdirSync(srcMedia);mkdirSync(mediaRoot);
 source.exec(`INSERT INTO works(id,name,name_normalized,created_at,updated_at) VALUES(1,'Example','example','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z');`);
 const options={database,repositoryRoot:root,environment,input,mediaRoot,journalRoot:join(dir,'batches'),modelClient:{embed:async rows=>rows.map(()=>Array(1024).fill(0.01))}};
 return {source,database,dir,mediaRoot,srcMedia,input,options,export:()=>exportPackage({database:source,mediaRoot:srcMedia,output:input})};
}
test('empty import creates business records, vector and KNN; repeated import errors',async t=>{
 const f=setup(t);f.export();assert.equal(checkImport(f.options).records.works,1);
 const result=await importPackage(f.options);assert.equal(result.vectors,1);
 assert.equal(f.database.prepare('SELECT count(*) n FROM vector_entries').get().n,1);
 assert.equal(f.database.prepare('SELECT count(*) n FROM vector_knn_index').get().n,1);
 assert.throws(()=>assertEmptyDatabase(f.database),/已有数据/u);
 await assert.rejects(importPackage(f.options),/已有数据/u);
});
test('missing each model configuration fails before reading package',async t=>{
 const f=setup(t);
 for(const key of Object.keys(environment)) {const env={...environment};delete env[key]; await assert.rejects(importPackage({...f.options,environment:env}),/configuration.*invalid/u);assertEmptyDatabase(f.database);}
});
test('embedding failure and invalid dimensions leave target empty',async t=>{
 const f=setup(t);f.export();
 for(const embed of [async()=>{throw new Error('timeout');},async()=>[],async()=>[[1,2]],async()=>[Array(1024).fill(0)]]) {
 await assert.rejects(importPackage({...f.options,modelClient:{embed}}),/Vector preparation failed/u);assertEmptyDatabase(f.database);
 }
});
test('vector write failure rolls back business records and vector space changes',async t=>{
 const f=setup(t);f.export();const before=f.database.prepare('SELECT * FROM vector_spaces').all();
 f.database.exec("CREATE TRIGGER fail_vector BEFORE INSERT ON vector_entries BEGIN SELECT RAISE(ABORT,'injected write failure'); END;");
 await assert.rejects(importPackage(f.options),/Vector write failed/u);assertEmptyDatabase(f.database);
 assert.deepEqual(f.database.prepare('SELECT * FROM vector_spaces').all(),before);
});
test('state becoming nonempty while preparing embeddings is preserved',async t=>{
 const f=setup(t);f.export();
 await assert.rejects(importPackage({...f.options,modelClient:{embed:async rows=>{f.database.exec("INSERT INTO generation_base_models(id,name,created_at,updated_at) VALUES(9,'External','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')");return rows.map(()=>Array(1024).fill(1));}}}),/已有数据/u);
 assert.equal(f.database.prepare('SELECT name FROM generation_base_models').get().name,'External');assert.equal(f.database.prepare('SELECT count(*) n FROM works').get().n,0);
});
test('media, cover and order survive export/import',async t=>{
 const f=setup(t);mkdirSync(join(f.srcMedia,'work'));writeFileSync(join(f.srcMedia,'work','one.png'),'fixed-image');
 f.source.exec("INSERT INTO item_images(id,owner_kind,owner_id,content_hash,media_path,sort_order,created_at,updated_at) VALUES(1,'work',1,'existing-source-value','work/one.png',0,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z');UPDATE works SET cover_media_path='work/one.png' WHERE id=1;");
 f.export();await importPackage(f.options);assert.equal(readFileSync(join(f.mediaRoot,'work/one.png'),'utf8'),'fixed-image');assert.equal(f.database.prepare('SELECT cover_media_path FROM works').get().cover_media_path,'work/one.png');
});
test('path validation rejects traversal, windows aliases and links',()=>{
 for(const path of ['../bad','/bad','a\\b','a/./b','con.png','a:b','trailing.','a//b']) assert.throws(()=>safePath('/tmp',path),/path/u);
});
test('truncated packet and output conflict are reported',t=>{
 const f=setup(t);f.export();assert.throws(()=>f.export(),/already exists/u);
 writeFileSync(join(f.input,'records/works-0.json'),'[]');assert.throws(()=>readPackage(f.input),/size/u);assertEmptyDatabase(f.database);
});
test('invalid cover values fail packet checks without normalization',t=>{
 const f=setup(t);f.export();const file=join(f.input,'records/works-0.json'),manifest=join(f.input,'manifest.json');
 for(const value of ['',false,0]) {
  const rows=JSON.parse(readFileSync(file));rows[0].cover_media_path=value;writeFileSync(file,JSON.stringify(rows));
  const m=JSON.parse(readFileSync(manifest));m.files.find(entry=>entry.path==='records/works-0.json').size=Buffer.byteLength(JSON.stringify(rows));writeFileSync(manifest,JSON.stringify(m));
  assert.throws(()=>checkImport(f.options),/Invalid works record/u);assertEmptyDatabase(f.database);
 }
});
test('recovery waits for database writers before deciding whether media is committed',t=>{
 const f=setup(t),databasePath=join(f.dir,'recover.sqlite');initializeDatabase(databasePath);
 const first=openExistingCatalogDatabase({databasePath}),second=openExistingCatalogDatabase({databasePath});
 t.after(()=>{first.close();second.close();});second.exec('PRAGMA busy_timeout=0');
 const batch='12345678-1234-1234-1234-123456789abc',stage=join(f.options.journalRoot,batch);mkdirSync(stage,{recursive:true});
 const staged=join(stage,'one.png'),target=join(f.mediaRoot,'one.png');writeFileSync(staged,'image');linkSync(staged,target);
 const {ino,dev}=lstatSync(staged);writeFileSync(join(f.options.journalRoot,`${batch}.json`),JSON.stringify({id:batch,files:[{path:'one.png',ino,dev}]}));
 first.exec('BEGIN IMMEDIATE');first.prepare('INSERT INTO data_import_batches VALUES (?,?)').run(batch,'2026-09-14T00:00:00Z');
 const options={database:second,mediaRoot:f.mediaRoot,journalRoot:f.options.journalRoot,batch};
 assert.throws(()=>recoverImport(options),/locked/u);assert.equal(existsSync(target),true);
 first.exec('COMMIT');assert.equal(recoverImport(options).status,'committed');assert.equal(existsSync(target),true);
});
test('uncommitted batch recovery removes only its linked media',t=>{
 const f=setup(t),batch='12345678-1234-1234-1234-123456789abc',stage=join(f.options.journalRoot,batch);mkdirSync(stage,{recursive:true});
 const staged=join(stage,'one.png'),target=join(f.mediaRoot,'one.png');writeFileSync(staged,'image');linkSync(staged,target);writeFileSync(join(f.mediaRoot,'other.png'),'other');
 const {ino,dev}=lstatSync(staged);writeFileSync(join(f.options.journalRoot,`${batch}.json`),JSON.stringify({id:batch,files:[{path:'one.png',ino,dev}]}));
 assert.equal(recoverImport({...f.options,batch}).status,'rolled_back');assert.equal(existsSync(target),false);assert.equal(readFileSync(join(f.mediaRoot,'other.png'),'utf8'),'other');assertEmptyDatabase(f.database);
});
test('file publication failure rolls back records and already published media',async t=>{
 const f=setup(t);mkdirSync(join(f.srcMedia,'blocked'));writeFileSync(join(f.srcMedia,'one.png'),'one');writeFileSync(join(f.srcMedia,'blocked/two.png'),'two');
 for(const [id,path] of [[1,'one.png'],[2,'blocked/two.png']]) f.source.prepare("INSERT INTO item_images(id,owner_kind,owner_id,content_hash,media_path,sort_order,created_at,updated_at) VALUES(?,'work',1,'source',?,?,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')").run(id,path,id-1);
 f.export();writeFileSync(join(f.mediaRoot,'blocked'),'external-file');
 await assert.rejects(importPackage(f.options));assertEmptyDatabase(f.database);assert.equal(existsSync(join(f.mediaRoot,'one.png')),false);assert.equal(readFileSync(join(f.mediaRoot,'blocked'),'utf8'),'external-file');
});
test('initialization and v0.87.0 upgrade are explicit and preserve records',t=>{
 const f=setup(t),databasePath=join(f.dir,'upgrade.sqlite');initializeDatabase(databasePath);assert.throws(()=>initializeDatabase(databasePath),/already exists/u);
 const db=openExistingCatalogDatabase({databasePath});db.exec("DROP TABLE data_import_batches;DELETE FROM schema_migrations WHERE version=40;PRAGMA user_version=39;INSERT INTO generation_base_models(id,name,created_at,updated_at) VALUES(1,'preserved','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')");db.close();
 migrateDatabase(databasePath);migrateDatabase(databasePath);const upgraded=openExistingCatalogDatabase({databasePath});
 try {assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version,40);assert.equal(upgraded.prepare('SELECT name FROM generation_base_models').get().name,'preserved');}finally{upgraded.close();}
});
test('all six semantic resource kinds are indexed with original IDs and relationships',async t=>{
 const f=setup(t),at='2026-09-14T00:00:00Z';
 f.source.prepare('INSERT INTO generation_base_models VALUES(1,?,?,?)').run('Base',at,at);
 f.source.prepare("INSERT INTO characters(id,work_id,name,name_normalized,prompt_text,created_at,updated_at) VALUES(2,1,'Character','character','traveler',?,?)").run(at,at);
 f.source.exec("INSERT INTO styles(id,base_model_id,name,prompt_text) VALUES(3,1,'Style','ink');");
 f.source.prepare("INSERT INTO prompt_terms(id,canonical_tag,category,post_count,created_at,updated_at) VALUES(4,'mountain',0,10,?,?)").run(at,at);
 f.source.prepare("INSERT INTO generation_models(id,base_model_id,file_name,file_format,precision_or_quantization,description,usage,created_at,updated_at) VALUES(5,1,'demo.safetensors','safetensors','fp16','description','usage',?,?)").run(at,at);
 f.source.prepare("INSERT INTO generation_loras(id,base_model_id,model_id,file_name,file_format,precision_or_quantization,description,usage,created_at,updated_at) VALUES(6,1,5,'lora.safetensors','safetensors','fp16','description','usage',?,?)").run(at,at);
 f.source.prepare("INSERT INTO artist_prompt_strings(id,title,description,artist_string,created_at,updated_at) VALUES(7,'Artist','description','artist:demo',?,?)").run(at,at);
 f.source.exec('INSERT INTO artist_prompt_string_styles VALUES(7,3)');
 f.export();const result=await importPackage(f.options);assert.equal(result.vectors,6);
 assert.deepEqual(f.database.prepare('SELECT object_id FROM vector_entries ORDER BY object_id').all().map(r=>r.object_id),[1,2,3,4,6,7]);
 assert.equal(f.database.prepare('SELECT count(*) n FROM vector_knn_index').get().n,6);
 assert.equal(f.database.prepare('SELECT style_id FROM artist_prompt_string_styles').get().style_id,3);
});

test('export keeps a single snapshot across concurrent table updates',t=>{
 const f=setup(t),path=join(f.dir,'snapshot.sqlite');initializeDatabase(path);
 const source=openExistingCatalogDatabase({databasePath:path}),writer=openExistingCatalogDatabase({databasePath:path});
 t.after(()=>{source.close();writer.close();});
 source.exec("PRAGMA journal_mode=WAL; INSERT INTO works(id,name,name_normalized,created_at,updated_at) VALUES(1,'Before','before','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z'); INSERT INTO characters(id,work_id,name,name_normalized,prompt_text,created_at,updated_at) VALUES(1,1,'Before','before','before','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z');");
 const wrapped={exec:sql=>source.exec(sql),prepare(sql){const statement=source.prepare(sql);if(sql==='SELECT * FROM "works"')return {all(){const rows=statement.all();writer.exec("BEGIN; UPDATE works SET name='After'; UPDATE characters SET name='After'; COMMIT;");return rows;}};return statement;}};
 exportPackage({database:wrapped,mediaRoot:f.srcMedia,output:f.input});
 const packet=readPackage(f.input);assert.equal(packet.records.works[0].name,'Before');assert.equal(packet.records.characters[0].name,'Before');assert.equal(writer.prepare('SELECT name FROM characters').get().name,'After');
});

test('instance export is opt-in and removes credentials and enabled state',t=>{
 const f=setup(t);f.source.exec("INSERT INTO comfyui_instances(id,title,url,credential_type,credential_ciphertext,is_enabled,is_valid,created_at,updated_at) VALUES(1,'Local','http://127.0.0.1:8188','bearer','sample-cipher',1,1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')");
 f.export();assert.equal(readPackage(f.input).records.comfyui_instances.length,0);
 const output=join(f.dir,'with-instances');exportPackage({database:f.source,mediaRoot:f.srcMedia,output,includeInstances:true});
 const row=readPackage(output).records.comfyui_instances[0];assert.deepEqual([row.credential_type,row.credential_ciphertext,row.is_enabled,row.is_valid],['none',null,0,0]);
 const path=join(output,'records/comfyui_instances-0.json');row.is_enabled=1;row.is_valid=1;writeFileSync(path,JSON.stringify([row]));const manifest=JSON.parse(readFileSync(join(output,'manifest.json')));manifest.files.find(f=>f.path==='records/comfyui_instances-0.json').size=lstatSync(path).size;writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest));assert.throws(()=>readPackage(output),/must be disabled/u);
});
test('unavailable works and characters remain stored without searchable vectors',async t=>{
 const f=setup(t);f.source.exec("UPDATE works SET is_available=0; INSERT INTO characters(id,work_id,name,name_normalized,prompt_text,is_available,created_at,updated_at) VALUES(1,1,'Available child','available','child',1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z'),(2,1,'Unavailable child','unavailable','child',0,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')");f.export();const result=await importPackage({...f.options,modelClient:{embed:async()=>{throw Error('must not embed');}}});assert.equal(result.vectors,0);assert.equal(f.database.prepare('SELECT count(*) n FROM characters').get().n,2);
});
test('journal callback failure is rolled back and malformed recovery preserves files',async t=>{
 const f=setup(t);f.export();await assert.rejects(importPackage({...f.options,onBatch:()=>{throw Error('callback failed');}}),/callback failed/u);assertEmptyDatabase(f.database);
 assert.throws(()=>recoverImport({...f.options,batch:'bad'}),/Invalid import batch/u);
 const batch='12345678-1234-1234-1234-123456789abc',path=join(f.options.journalRoot,`${batch}.json`),target=join(f.mediaRoot,'foreign.png');writeFileSync(target,'foreign');
 writeFileSync(path,JSON.stringify({id:batch,files:[{path:'foreign.png',ino:0,dev:0}]}));assert.throws(()=>recoverImport({...f.options,batch}),/another file/u);assert.equal(readFileSync(target,'utf8'),'foreign');
 writeFileSync(path,JSON.stringify({id:'22345678-1234-1234-1234-123456789abc',files:[]}));assert.throws(()=>recoverImport({...f.options,batch}),error=>{assert.match(error.message,/Invalid import journal/u);assert.ok(error.message.includes(path));assert.ok(error.message.includes(batch));return true;});
 writeFileSync(path,'{}');assert.throws(()=>recoverImport({...f.options,batch}),/Invalid batch/u);
});
test('unknown database versions and malformed package inventories fail before import',t=>{
 const f=setup(t);f.database.exec('PRAGMA user_version=999');assert.throws(()=>assertEmptyDatabase(f.database),/requires migration/u);
 const databasePath=join(f.dir,'unknown.sqlite');initializeDatabase(databasePath);const db=openExistingCatalogDatabase({databasePath});db.exec('PRAGMA user_version=999');db.close();assert.throws(()=>migrateDatabase(databasePath),/unsupported/u);
 f.export();const path=join(f.input,'manifest.json'),original=JSON.parse(readFileSync(path));
 for(const edit of [m=>m.application_version='0.1.0',m=>m.files.push({...m.files[0]}),m=>m.chunks[0].count=99,m=>m.chunks[0].path='missing.json',m=>m.chunks=[]]){
  const manifest=structuredClone(original);edit(manifest);writeFileSync(path,JSON.stringify(manifest));assert.throws(()=>readPackage(f.input));
 }
 writeFileSync(path,JSON.stringify(original));writeFileSync(join(f.input,'unlisted.txt'),'extra');assert.throws(()=>readPackage(f.input),/unlisted/u);assert.throws(()=>readPackage(path),/regular directory/u);
});

test('import exposes recovery batch when its journal cannot be recovered',async t=>{
 const f=setup(t);f.export();let id;
 await assert.rejects(importPackage({...f.options,onBatch:batch=>{id=batch;writeFileSync(join(f.options.journalRoot,`${batch}.json`),'{}');throw Error('interrupted callback');}}),/Recovery requires data-import --recover --batch/u);assertEmptyDatabase(f.database);assert.ok(existsSync(join(f.options.journalRoot,`${id}.json`)));
});
test('existing target media is preserved and absent staged files can be recovered',async t=>{
 const f=setup(t);writeFileSync(join(f.srcMedia,'one.png'),'source');writeFileSync(join(f.mediaRoot,'one.png'),'existing');f.source.exec("INSERT INTO item_images(id,owner_kind,owner_id,content_hash,media_path,sort_order,created_at,updated_at) VALUES(1,'work',1,'source','one.png',0,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')");f.export();await assert.rejects(importPackage(f.options),/Target media already exists/u);assertEmptyDatabase(f.database);assert.equal(readFileSync(join(f.mediaRoot,'one.png'),'utf8'),'existing');
 const batch='12345678-1234-1234-1234-123456789abc';writeFileSync(join(f.options.journalRoot,`${batch}.json`),JSON.stringify({id:batch,files:[{path:'absent.png',ino:0,dev:0}]}));assert.equal(recoverImport({...f.options,batch}).status,'rolled_back');
});
test('configured client imports through the embedding HTTP protocol',async t=>{
 const {createServer}=await import('node:http');const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body);assert.equal(req.url,'/v1/embeddings');assert.equal(req.headers.authorization,'Bearer test');res.setHeader('content-type','application/json');res.end(JSON.stringify({data:request.input.map((_,index)=>({index,embedding:Array(1024).fill(0.1)}))}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const f=setup(t);f.export();const env={...environment,NOOBAI_EMBEDDING_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`};assert.equal((await importPackage({...f.options,environment:env,modelClient:null})).vectors,1);
});

test('cleanup failure after commit reports committed state and recovery preserves imported records',async t=>{
 const f=setup(t);f.export();let batch;
 const wrapped=new Proxy(f.database,{get(target,key){if(key==='prepare')return sql=>{if(sql==='SELECT 1 FROM data_import_batches WHERE id=?')throw Error('cleanup read failed');return target.prepare(sql);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(importPackage({...f.options,database:wrapped,onBatch:id=>{batch=id;}}),/committed, but temporary-file cleanup failed/u);
 assert.equal(f.database.prepare('SELECT count(*) n FROM works').get().n,1);assert.equal(f.database.prepare('SELECT count(*) n FROM vector_knn_index').get().n,1);assert.equal(recoverImport({...f.options,batch}).status,'committed');assert.equal(f.database.prepare('SELECT count(*) n FROM works').get().n,1);
});
