import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

async function releaseLink(t){
  const dir=await mkdtemp(join(tmpdir(),'booking-entrypoint-'));
  const link=join(dir,'current');
  await symlink(fileURLToPath(new URL('../../',import.meta.url)),link,process.platform==='win32'?'junction':'dir');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {dir,link};
}

test('server starts through the current release directory link',async t=>{
  const {dir,link}=await releaseLink(t);
  const child=spawn(process.execPath,[join(link,'booking-server/server.mjs')],{env:{...process.env,DATABASE_URL:'',BOOKING_EMBEDDED:'1',BOOKING_DATA_DIR:join(dir,'data'),HOST:'127.0.0.1',PORT:'0',BOOKING_ADMIN_EMAIL:'',BOOKING_ADMIN_PASSWORD:'',BOOKING_SHEETS_SYNC:'0'},stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed;});
  const base=await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(Error('Linked server did not start')),15000);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/Eduson booking: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('close',code=>{clearTimeout(timer);reject(Error('Linked server exited before listening: '+code));});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  assert.equal((await fetch(base+'/health')).status,200);
  assert.equal((await fetch(base+'/api/bookings')).status,401);
});

test('legacy import CLI validates its arguments through the current release directory link',async t=>{
  const {dir,link}=await releaseLink(t);
  const result=spawnSync(process.execPath,[join(link,'booking-server/legacy-import.mjs'),'--snapshot',join(dir,'missing.json')],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(result.stderr),{ok:false,error:'SNAPSHOT_READ_FAILED'});
});
