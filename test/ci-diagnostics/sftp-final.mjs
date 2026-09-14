import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

// Exercise the actual adapter and fixture: no source rewriting or prototype patch.
const repo=fs.realpathSync.native(path.resolve(process.argv[2]||'.'));
const require=createRequire(path.join(repo,'package.json'));
const {bindingAvailable}=require('ssh2/lib/protocol/crypto.js');
const {startSftpServer}=await import(pathToFileURL(path.join(repo,'test/sftp-server.js')));
const {loadConfig}=await import(pathToFileURL(path.join(repo,'src/config.js')));
const {registerTools}=await import(pathToFileURL(path.join(repo,'src/tools.js')));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ftp-ci-sftp-final-'));
const rows=[];
let server;
const watchdog=setTimeout(()=>{console.error('Diagnostic watchdog expired');process.exit(1)},60000);
try {
 fs.mkdirSync(path.join(root,'jail'));
 const local=path.join(root,'hello.txt');fs.writeFileSync(local,'hello-sftp');
 server=await startSftpServer({root,user:'probe',password:'fixture-only'});
 const config=path.join(root,'config.json');
 fs.writeFileSync(config,JSON.stringify({servers:{probe:{protocol:'sftp',host:'127.0.0.1',port:server.port,user:'probe',password:'fixture-only',root:'/jail',localRoot:root,hostKeySha256:server.hostKeySha256}}}));
 const handlers=registerTools(null,loadConfig(config));
 for(const [name,args] of [['ftp_test',{}],['ftp_mkdir',{path:'a/b/c'}],['ftp_list',{path:'a/b'}],['ftp_upload',{local_path:local,remote_path:'a/b/c/hello.txt'}]]){
  const start=performance.now(),cpu=process.cpuUsage();
  const deadline=setTimeout(()=>{console.error('Tool exceeded unchanged 15s watchdog: '+name);process.exit(1)},15000);
  let result;
  try {result=await handlers.call(name,{server:'probe',...args},{});}finally{clearTimeout(deadline);}
  const usage=process.cpuUsage(cpu);
  const row={name,elapsedMs:Math.round(performance.now()-start),cpuMs:Math.round((usage.user+usage.system)/1000),isError:result.isError===true};
  rows.push(row);console.error(JSON.stringify(row));
  assert(!result.isError,'Tool failed: '+name);
 }
 assert.equal(fs.readFileSync(path.join(root,'jail/a/b/c/hello.txt'),'utf8'),'hello-sftp');
 console.log(JSON.stringify({platform:process.platform,node:process.version,bindingAvailable,mode:'unmodified-adapter-and-fixture',rows},null,2));
} finally {
 if(server)await server.close();
 fs.rmSync(root,{recursive:true,force:true});
 clearTimeout(watchdog);
}
