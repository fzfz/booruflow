import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { definition, assertCurrentDatabase } from './database.mjs';
import { validationErrors } from '../contracts/json-schema-validation.mjs';
import { openCatalogDatabase } from '../catalog/database.mjs';

const rowSchemas=JSON.parse(readFileSync(new URL('../../schema/data-package/records.schema.json',import.meta.url),'utf8')).$defs;
const schemas=Object.fromEntries(['manifest','batch','definition'].map(name=>[name,JSON.parse(readFileSync(new URL(`../../schema/data-package/${name}.schema.json`,import.meta.url),'utf8'))]));
export function assertPackageSchema(name,value) {
  const errors=validationErrors(value,schemas[name],{});
  if(errors.length) throw new Error(`Invalid ${name}: ${errors.join('; ')}. Export a new package or preserve the recovery journal for diagnosis.`);
}
assertPackageSchema('definition',definition);
export function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || /[\x00-\x1f:]/u.test(relative) || relative.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/u.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu.test(part))) throw new Error(`Invalid package path: ${relative}. Export a new package.`);
  const path=resolve(root,relative);
  if (!path.startsWith(resolve(root)+sep)) throw new Error(`Package path is outside its directory: ${relative}. Export a new package.`);
  let cursor=resolve(root);
  for (const part of relative.split('/')) { cursor=join(cursor,part); if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink()) throw new Error(`Symbolic link is unsupported: ${relative}. Export regular media files into a new package.`); }
  return path;
}
function json(path) { return JSON.parse(readFileSync(path,'utf8')); }
export function writeJson(path,value) { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'}); }
function filesWithin(root, prefix='') {
  return readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
    const path=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory()) return filesWithin(root,path);
    if(!entry.isFile()) throw new Error(`Package contains a non-regular file: ${path}. Export a new package.`);
    return [path];
  });
}
export function insertRecords(database,records) {
  const covers=[];
  for(const [table,columns] of Object.entries(definition.tables)) {
    const statement=database.prepare(`INSERT INTO "${table}" (${columns.map(c=>`"${c}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
    for(const row of records[table]) {
      const rowErrors=validationErrors(row,rowSchemas[table],{});
      if(rowErrors.length) throw new Error(`Invalid ${table} record: ${rowErrors.join('; ')}. Repair the source data and export again.`);
      if(!row||Array.isArray(row)||Object.keys(row).length!==columns.length||columns.some(c=>!Object.hasOwn(row,c))) throw new Error(`Invalid columns in ${table}. Export this application version again.`);
      if(Object.hasOwn(row,'cover_media_path') && row.cover_media_path !== null) {
        safePath('/media',row.cover_media_path);
        covers.push({table,id:row.id,path:row.cover_media_path});
      }
      try {statement.run(...columns.map(c=>c==='cover_media_path'?null:row[c]));}
      catch(error) {throw new Error(`Invalid record in ${table} (ID ${row.id ?? 'relationship'}): ${error.message}. Repair the source data and export again.`);}
    }
  }
  for(const {table,id,path} of covers) database.prepare(`UPDATE "${table}" SET cover_media_path=? WHERE id=?`).run(path,id);
  for(const image of records.item_images) {
    const owner=definition.image_owners[image.owner_kind];
    if(!owner || !database.prepare(`SELECT id FROM "${owner}" WHERE id=?`).get(image.owner_id)) throw new Error(`Image ${image.id} has no ${image.owner_kind} owner ${image.owner_id}. Repair the source and export again.`);
  }
  if(database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Package contains missing record references. Repair the source and export again.');
}
export function readPackage(input) {
  if(!lstatSync(input).isDirectory()||lstatSync(input).isSymbolicLink()) throw new Error('Package input must be an extracted regular directory. Use data-import with a package directory or its supported archive.');
  const manifestPath=safePath(input,'manifest.json');
  if(lstatSync(manifestPath).size>definition.max_file_bytes) throw new Error('Package manifest exceeds the configured size limit. Export a smaller package.');
  const manifest=json(manifestPath);assertPackageSchema('manifest',manifest);
  if(manifest.format_version!==definition.format_version||manifest.application_version!==definition.application_version||manifest.database_version!==definition.database_version) throw new Error('Package version is unsupported. Export and import with the same application version.');
  if(!Array.isArray(manifest.files)||manifest.files.length>definition.max_files||!Array.isArray(manifest.chunks)) throw new Error('Invalid package manifest file list. Export a new package.');
  const names=new Set(),folded=new Set();let total=0;
  for(const file of manifest.files) {
    const path=safePath(input,file.path), key=file.path.toLowerCase();
    if(names.has(file.path)||folded.has(key)||file.path==='manifest.json') throw new Error(`Duplicate package path: ${file.path}. Export a new package.`);
    names.add(file.path);folded.add(key);
    const stat=lstatSync(path);
    if(!stat.isFile()||!Number.isSafeInteger(file.size)||file.size<0||file.size!==stat.size||file.size>definition.max_file_bytes) throw new Error(`Package file size or type is invalid: ${file.path}. Export a new package.`);
    total+=file.size;
  }
  if(total>definition.max_total_bytes) throw new Error('Package exceeds the configured total size limit. Reduce the package size or adjust schema/data-package/definition.json before retrying.');
  const diskFiles=filesWithin(input);
  if(diskFiles.length!==names.size+1||diskFiles.some(path=>path!=='manifest.json'&&!names.has(path))) throw new Error('Package contains unlisted files. Export a new package.');
  const records=Object.fromEntries(Object.keys(definition.tables).map(t=>[t,[]]));const chunkNames=new Set();
  for(const chunk of manifest.chunks) {
    if(!Object.hasOwn(records,chunk.table)||!names.has(chunk.path)||chunkNames.has(chunk.path)||!chunk.path.startsWith('records/')) throw new Error('Invalid record chunk. Export a new package.');
    chunkNames.add(chunk.path);
    const rows=json(safePath(input,chunk.path));
    if(!Array.isArray(rows)||rows.length!==chunk.count||rows.length>definition.rows_per_chunk) throw new Error(`Invalid record count: ${chunk.path}. Export a new package.`);
    records[chunk.table].push(...rows);
  }
  const media=new Set(records.item_images.map(row=>`media/${row.media_path}`));
  for(const path of media) if(!names.has(path)) throw new Error(`Missing image: ${path}. Export the source media again.`);
  if([...names].some(path=>!chunkNames.has(path)&&!media.has(path))) throw new Error('Package contains an unreferenced file. Export a new package.');
  for(const row of records.comfyui_instances) {
    if(row.credential_type!=='none'||row.credential_ciphertext!==null||row.is_enabled!==0||row.is_valid!==0) throw new Error('Imported ComfyUI instances must be disabled and contain no credentials. Export a new package with this application version.');
  }
  const scratch=openCatalogDatabase({includeBuiltinComfyuiCatalog:false});
  try {insertRecords(scratch,records);} finally {scratch.close();}
  return {manifest,records,media:[...media]};
}
export function exportPackage({database,mediaRoot,output,includeInstances=false}) {
  assertCurrentDatabase(database);
  if(existsSync(output)) throw new Error('Export output already exists. Choose a new directory.');
  mkdirSync(output,{recursive:true});
  let reading=false;
  try {
    database.exec('BEGIN');reading=true;
    const manifest={format_version:definition.format_version,application_version:definition.application_version,database_version:definition.database_version,exported_at:new Date().toISOString(),chunks:[],files:[]};
    for(const table of Object.keys(definition.tables)) {
      let rows=database.prepare(`SELECT * FROM "${table}"`).all();
      if(table==='comfyui_instances') rows=includeInstances?rows.map(row=>({...row,credential_type:'none',credential_ciphertext:null,is_enabled:0,is_valid:0})):[];
      for(let offset=0;offset<rows.length;offset+=definition.rows_per_chunk) {
        const chunk=rows.slice(offset,offset+definition.rows_per_chunk),path=`records/${table}-${offset/definition.rows_per_chunk}.json`;
        writeJson(safePath(output,path),chunk);manifest.chunks.push({table,path,count:chunk.length});
      }
      if(table==='item_images') for(const row of rows) {
        const from=safePath(mediaRoot,row.media_path),to=safePath(output,`media/${row.media_path}`);
        if(!lstatSync(from).isFile()) throw new Error(`Source image is not a file: ${row.media_path}`);
        mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to,constants.COPYFILE_EXCL);
      }
    }
    manifest.files=filesWithin(output).sort().map(path=>({path,size:lstatSync(safePath(output,path)).size}));
    writeJson(join(output,'manifest.json'),manifest);readPackage(output);
    database.exec('COMMIT');reading=false;return manifest;
  } catch(error) {if(reading) database.exec('ROLLBACK');rmSync(output,{recursive:true,force:true});throw error;}
}
