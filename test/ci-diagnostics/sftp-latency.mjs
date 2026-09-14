import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const repo=fs.realpathSync(path.resolve(process.argv[2] || '.'));
const require=createRequire(path.join(repo,'package.json'));
const {bindingAvailable}=require('ssh2/lib/protocol/crypto.js');
const {Client}=require('ssh2');
const originalConnect=Client.prototype.connect;
let probeClientNoDelay=false;
Client.prototype.connect=function(...args){
 if(probeClientNoDelay)this.once('ready',()=>this.setNoDelay(true));
 return originalConnect.apply(this,args);
};
let fixture=fs.readFileSync(path.join(repo,'test/sftp-server.js'),'utf8');
for(const marker of ['import ssh2 from "ssh2";','onWrite, realPath })','clients.add(client);'])assert(fixture.includes(marker),marker);
fixture=fixture.replace('import ssh2 from "ssh2";',`const {default:ssh2}=await import(${JSON.stringify(pathToFileURL(require.resolve('ssh2')).href)});`)
 .replace('onWrite, realPath })','onWrite, realPath, probeNoDelay })')
 .replace('clients.add(client);',`clients.add(client); if (probeNoDelay) client.setNoDelay(true); client.on('handshake', info => { stats.negotiated = info; });`);
const {startSftpServer}=await import('data:text/javascript;base64,'+Buffer.from(fixture).toString('base64'));
const {loadConfig}=await import(pathToFileURL(path.join(repo,'src/config.js')));
const {registerTools}=await import(pathToFileURL(path.join(repo,'src/tools.js')));
const rows=[];const watchdog=setTimeout(()=>{console.error('Diagnostic watchdog expired');process.exit(1)},150000);
try {
 for(const [serverNoDelay,clientNoDelay] of [[false,false],[true,false],[false,true],[true,true]]){
  probeClientNoDelay=clientNoDelay;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ftp-ci-sftp-probe-'));let server;
  try{
   fs.mkdirSync(path.join(root,'jail'));const local=path.join(root,'hello.txt');fs.writeFileSync(local,'hello-sftp');
   server=await startSftpServer({root,user:'probe',password:'fixture-only',probeNoDelay:serverNoDelay});
   const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({servers:{probe:{protocol:'sftp',host:'127.0.0.1',port:server.port,user:'probe',password:'fixture-only',root:'/jail',localRoot:root,hostKeySha256:server.hostKeySha256}}}));
   const handlers=registerTools(null,loadConfig(config));
   for(const [name,args] of [['ftp_test',{}],['ftp_mkdir',{path:'a/b/c'}],['ftp_list',{path:'a/b'}],['ftp_upload',{local_path:local,remote_path:'a/b/c/hello.txt'}]]){
    const start=performance.now(),cpu=process.cpuUsage();const result=await handlers.call(name,{server:'probe',...args},{});const usage=process.cpuUsage(cpu);
    const row={serverNoDelay,clientNoDelay,name,elapsedMs:Math.round(performance.now()-start),cpuMs:Math.round((usage.user+usage.system)/1000),isError:result.isError===true};rows.push(row);console.error(JSON.stringify(row));
    assert(!result.isError,'Tool failed: '+name);
   }
   assert.equal(fs.readFileSync(path.join(root,'jail/a/b/c/hello.txt'),'utf8'),'hello-sftp');
   rows.push({serverNoDelay,clientNoDelay,negotiated:server.getStats().negotiated});
  }finally{if(server)await server.close();fs.rmSync(root,{recursive:true,force:true});}
 }
 console.log(JSON.stringify({platform:process.platform,node:process.version,bindingAvailable,rows},null,2));
}finally{clearTimeout(watchdog);Client.prototype.connect=originalConnect;}
