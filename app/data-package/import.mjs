import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertEmptyDatabase } from './database.mjs';
import { assertPackageSchema, insertRecords, readPackage, safePath, writeJson } from './package.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { loadVectorModelConfiguration, createConfiguredVectorModelClient } from '../vector/model-client.mjs';
import { OBJECT_KINDS, VECTOR_SOURCE_TABLES } from '../vector/vector-source-definitions.mjs';
import { embedProjection, upsertVectorEntry, writeVectorSpaceConfiguration, VECTOR_DIMENSION } from '../vector/vector-store.mjs';
import { workTextProjection } from '../vector/work-semantic.mjs';
import { characterTextProjection } from '../vector/character-semantic.mjs';
import { styleTextProjection } from '../vector/style-semantic.mjs';
import { promptTermTextProjection } from '../vector/prompt-term-semantic.mjs';
import { generationLoraTextProjection } from '../vector/generation-lora-semantic.mjs';
import { artistPromptStringTextProjection } from '../vector/artist-prompt-string-semantic.mjs';
const projections={work:workTextProjection,character:characterTextProjection,style:styleTextProjection,prompt_term:promptTermTextProjection,generation_lora:generationLoraTextProjection,artist_prompt_string:artistPromptStringTextProjection};
function models(repositoryRoot,environment) {
  try {return loadVectorModelConfiguration(repositoryRoot,{environment});}
  catch(error) {throw new Error(`Model configuration is incomplete or invalid: ${error.message}. Edit ${join(repositoryRoot,'.env')} and config/vector/models.json, then retry.`);}
}
export function checkImport({database,repositoryRoot,environment,input}) {
  assertEmptyDatabase(database);models(repositoryRoot,environment);
  const packet=readPackage(input);
  return {records:Object.fromEntries(Object.entries(packet.records).map(([table,rows])=>[table,rows.length])),files:packet.media.length};
}
function journalPath(journalRoot,batch) {
  if(typeof batch!=='string'||! /^[a-f0-9-]{36}$/u.test(batch)) throw new Error('Invalid import batch ID. Use the ID printed by data-import.');
  return join(journalRoot,`${batch}.json`);
}
function saveJournal(path,journal) {
  const temporary=`${path}.new`;writeJson(temporary,journal);renameSync(temporary,path);
}
export function recoverImport({database,mediaRoot,journalRoot,batch}) {
  return inTransaction(database,()=>{
  const path=journalPath(journalRoot,batch), journal=JSON.parse(readFileSync(path,'utf8'));
  assertPackageSchema('batch',journal);
  if(journal.id!==batch||!Array.isArray(journal.files)) throw new Error(`Invalid import journal at ${path} for batch ${batch}. Preserve this file and report its path and batch ID.`);
  const committed=Boolean(database.prepare('SELECT 1 FROM data_import_batches WHERE id=?').get(batch));
  if(!committed) for(const file of journal.files) {
    const target=safePath(mediaRoot,file.path);
    if(existsSync(target)) {
      const stat=lstatSync(target);
      if(stat.ino!==file.ino||stat.dev!==file.dev||!stat.isFile()) throw new Error(`Import recovery found another file at ${file.path}. Preserve the file and resolve this path before retrying batch ${batch}.`);
      rmSync(target);
    }
  }
  rmSync(join(journalRoot,batch),{recursive:true,force:true});rmSync(path);
  return {batch,status:committed?'committed':'rolled_back'};
  });
}
export async function importPackage({database,repositoryRoot,environment,input,mediaRoot,journalRoot,modelClient=null,onBatch=()=>{}}) {
  assertEmptyDatabase(database);
  const configuration=models(repositoryRoot,environment);
  const packet=readPackage(input);
  const client=modelClient??createConfiguredVectorModelClient({repositoryRoot,configuration});
  const vectors=[];
  for(const kind of OBJECT_KINDS) for(const row of packet.records[VECTOR_SOURCE_TABLES[kind]]) {
    if((kind==='work'||kind==='character')&&!row.is_available) continue;
    let source=row;
    if(kind==='character') {
      const work=packet.records.works.find(work=>work.id===row.work_id);
      if(!work.is_available) continue;
      source={...row,work_name:work.name};
    }
    try {vectors.push({kind,id:row.id,vector:await embedProjection(client,projections[kind](source))});}
    catch(error) {throw new Error(`Vector preparation failed for ${kind} ${row.id}: ${error.message}. Check the configured embedding service and retry the complete import.`);}
  }
  const batch=randomUUID(),path=journalPath(journalRoot,batch),stage=join(journalRoot,batch),journal={id:batch,files:[]};
  try {
    inTransaction(database,()=>{
    assertEmptyDatabase(database);
    mkdirSync(stage,{recursive:true});writeJson(path,journal);onBatch(batch);
    for(const media of packet.media) {
      const relative=media.slice('media/'.length),target=safePath(mediaRoot,relative),staged=safePath(stage,relative);
      if(existsSync(target)) throw new Error(`Target media already exists: ${relative}. Choose a clean installation for import.`);
      mkdirSync(dirname(staged),{recursive:true});copyFileSync(safePath(input,media),staged,constants.COPYFILE_EXCL);
      const {ino,dev}=lstatSync(staged);journal.files.push({path:relative,ino,dev});
    }
    saveJournal(path,journal);
    insertRecords(database,packet.records);
      for(const kind of OBJECT_KINDS) writeVectorSpaceConfiguration(database,kind,{embeddingModel:configuration.embedding_model,dimension:VECTOR_DIMENSION});
      for(const {kind,id,vector} of vectors) {
        try {upsertVectorEntry(database,kind,id,vector,{expectedModel:configuration.embedding_model});}
        catch(error) {throw new Error(`Vector write failed for ${kind} ${id}: ${error.message}. Resolve the database error and retry the complete import.`);}
      }
      for(const file of journal.files) {
        const target=safePath(mediaRoot,file.path);mkdirSync(dirname(target),{recursive:true});linkSync(safePath(stage,file.path),target);
      }
      database.prepare('INSERT INTO data_import_batches(id,committed_at) VALUES (?,?)').run(batch,new Date().toISOString());
    });
  } catch(error) {
    try {if(existsSync(path)) recoverImport({database,mediaRoot,journalRoot,batch});}
    catch(recoveryError) {throw new Error(`${error.message} Recovery requires data-import --recover --batch ${batch}: ${recoveryError.message}`);}
    throw error;
  }
  try {recoverImport({database,mediaRoot,journalRoot,batch});}
  catch(error) {throw new Error(`Import batch ${batch} committed, but temporary-file cleanup failed: ${error.message}. Preserve the imported data and run data-import --recover --batch ${batch}.`);}
  return {batch,status:'committed',vectors:vectors.length};
}
