import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {performance} from 'node:perf_hooks';
const original=cp.execFileSync;
const totals=new Map();
cp.execFileSync=function(command,args,options){
 if(command!=='tar')return original.apply(this,arguments);
 const start=performance.now();
 const operation=args.find(arg=>arg==='-xO'||arg==='-t'||arg==='-tv'||arg==='-czf')||'other';
 const total=totals.get(operation)||{operation,calls:0,failures:0,maxMs:0,totalMs:0};totals.set(operation,total);total.calls++;
 try{return original.apply(this,arguments)}
 catch(error){
  total.failures++;
  process.stderr.write('TAR_DIAGNOSTIC '+JSON.stringify({pid:process.pid,node:process.version,uv:process.versions.uv,platform:process.platform,args,inputBytes:options?.input?.length,timeout:options?.timeout,elapsedMs:Math.round(performance.now()-start),errorCode:error.code,status:error.status,signal:error.signal,stdoutBytes:error.stdout?.length,stderrBytes:error.stderr?.length})+'\n');
  throw error;
 }
 finally{const elapsed=Math.round(performance.now()-start);total.totalMs+=elapsed;total.maxMs=Math.max(total.maxMs,elapsed);}
};
syncBuiltinESMExports();
process.on('exit',()=>{if(totals.size)process.stderr.write('TAR_TOTALS '+JSON.stringify({pid:process.pid,node:process.version,totals:[...totals.values()]})+'\n');});
