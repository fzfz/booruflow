import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseProductionEnvironment, resolveProductionRuntimeConfiguration } from '../app/config/production-environment.mjs';
import { initializeDatabase, migrateDatabase, assertCurrentDatabase } from '../app/data-package/database.mjs';
import { openExistingCatalogDatabase } from '../app/catalog/database.mjs';
import { exportPackage, readPackage } from '../app/data-package/package.mjs';
import { importPackage, checkImport, recoverImport } from '../app/data-package/import.mjs';

const [command,...args]=process.argv.slice(2),options={};
try {
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==='--include-instances') {options[key]=true;continue;}
    if(!['--root','--input','--output','--batch'].includes(key)||Object.hasOwn(options,key)||!args[i+1]||args[i+1].startsWith('--')) throw new Error('Invalid arguments. Use --root DIR, --input DIR, --output DIR or --batch ID.');
    options[key]=args[++i];
  }
  const root=resolve(options['--root']??fileURLToPath(new URL('..',import.meta.url))),data=resolve(root,'data'),databasePath=resolve(data,'app.sqlite'),environmentPath=resolve(root,'.env');
  const environment=()=>({...parseProductionEnvironment(readFileSync(environmentPath,'utf8')),...process.env});
  const requireOption=name=>{if(!options[name])throw new Error(`${name} is required.`);return resolve(options[name]);};
  let result;
  if(command==='init') {
    if(!existsSync(environmentPath)) writeFileSync(environmentPath,readFileSync(resolve(root,'.env.example')),{flag:'wx',mode:0o600});
    const env=parseProductionEnvironment(readFileSync(environmentPath,'utf8'));
    if(!env.NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY) {
      const content=readFileSync(environmentPath,'utf8').replace(/^NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=.*\r?\n?/mu,'');
      writeFileSync(environmentPath,`${content.trimEnd()}\nNOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`,{mode:0o600});
    }
    if(!existsSync(databasePath)) initializeDatabase(databasePath);
    mkdirSync(resolve(data,'media'),{recursive:true});
    result={status:'installed',configuration:environmentPath};
  } else if(command==='migrate') {migrateDatabase(databasePath);result={status:'migrated'};}
  else if(command==='data-validate') {const packet=readPackage(requireOption('--input'));result={files:packet.media.length,records:Object.fromEntries(Object.entries(packet.records).map(([t,r])=>[t,r.length]))};}
  else {
    const database=openExistingCatalogDatabase({databasePath,readOnly:['check','data-export','data-check'].includes(command)});
    try {
      assertCurrentDatabase(database);
      const common={database,repositoryRoot:root,mediaRoot:resolve(data,'media'),journalRoot:resolve(data,'import-batches')};
      if(command==='check') {resolveProductionRuntimeConfiguration({environment:environment(),configPath:resolve(root,'config/defaults.json')});result={status:'ready'};}
      else if(command==='data-export') result=exportPackage({...common,output:requireOption('--output'),includeInstances:options['--include-instances']===true});
      else if(command==='data-check') result=checkImport({...common,environment:environment(),input:requireOption('--input')});
      else if(command==='data-import') result=await importPackage({...common,environment:environment(),input:requireOption('--input'),onBatch:batch=>console.log(`Import batch: ${batch}`)});
      else if(command==='data-recover') result=recoverImport({...common,batch:options['--batch']});
      else throw new Error(`Unknown operation: ${command}`);
    } finally {database.close();}
  }
  console.log(JSON.stringify(result,null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}
