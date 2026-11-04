import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {BookingService} from './domain.mjs';

/**
 * PG-only Rubitime intake. Transport authorization and provider discovery belong to the caller.
 * initializeSourceIntakeSchema(db) follows the base schema. No provider calls occur here.
 * createSourceIntake({db,service?,now?,staffMap:{[accountId]:{[providerStaffId]:bookingManagerId}}})
 * returns {accept,observe,runOnce,retryIssue,seedMigrationLinks,listIssues,status}.
 * Observation: {accountId,recordId,revision,event:'upsert'|'cancel'|'delete',observedAt,record?,raw}.
 * Revision is a provider/transport-owned monotonic integer string (up to 40 digits), never arrival time.
 * record: {date,time,durationMinutes:60,studentName,parentName?,phone,crmUrl?,age,hasPc,parentPresent,comment?,staffId?}.
 * Missing parentName stays empty. Omitted comment preserves an existing comment; explicit '' clears it.
 * accept commits raw journal before processing. runOnce retries pending PG-only transactions after a crash.
 * Any protected/manual/Amo facts require explicit operator review; raw orderId is never an Amo ID.
 */
const ACTOR={id:'source:rubitime',role:'admin',name:'Rubitime'},HOUR=3600000;
const ordered=value=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,ordered(value[key])])):value;
const canonical=value=>JSON.stringify(ordered(value));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,name:'SourceIntakeError'});};
const demand=(condition,code)=>{if(!condition)fail(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const date=value=>typeof value==='string'?value.slice(0,10):new Date(value).toISOString().slice(0,10);
const iso=value=>value==null?null:new Date(value).toISOString();
const text=(value,{required=false,max=160}={})=>{demand((value==null&&!required)||typeof value==='string','INVALID_RECORD');const result=(value||'').trim();demand(result.length<=max&&(!required||result.length>0),'INCOMPLETE_RECORD');return result;};
const id=value=>{demand(typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=128&&!/[\u0000-\u001f]/.test(value),'INVALID_IDENTITY');return value;};
const timestamp=value=>{demand(typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(+new Date(value)),'INVALID_OBSERVED_AT');return iso(value);};
const revision=value=>{demand(typeof value==='string'&&/^(0|[1-9]\d{0,39})$/.test(value),'INVALID_REVISION');return value;};
const columns=['date','time','starts_at','ends_at','student_name','parent_name','phone','crm_url','age','has_pc','parent_present','comment','confirmation_due_at','history_only'];
const bookingFingerprint=row=>hash(Object.fromEntries([...columns,'state','confirmation_status','confirmed_at','assigned_to','assignment_kind','cancel_reason','cancel_source','cancelled_at','started_at','completed_at','is_test','capacity_hold'].map(key=>[key,key==='date'?date(row[key]):key.endsWith('_at')?iso(row[key]):row[key]])));
const result=row=>({observationId:row.id,status:row.status,code:row.code||null,bookingId:row.booking_id||null,revision:String(row.revision)});
const crmKey=value=>{if(!value)return '';try{const u=new URL(value);return u.origin.toLowerCase()+u.pathname.replace(/\/$/,'');}catch{return '';}};

function envelope(input){
  demand(object(input),'INVALID_OBSERVATION');id(input.accountId);id(input.recordId);revision(input.revision);
  demand(['upsert','cancel','delete'].includes(input.event),'INVALID_EVENT');timestamp(input.observedAt);demand(object(input.raw),'INVALID_RAW');
  let encoded;try{encoded=canonical({event:input.event,record:input.record,raw:input.raw});}catch{fail('INVALID_RAW');}
  demand(typeof encoded==='string'&&Buffer.byteLength(encoded)<=1024*1024,'OBSERVATION_TOO_LARGE');
  // The exact bytes being hashed also own the detached data persisted after awaiting the queue.
  const snapshot=JSON.parse(encoded);demand(object(snapshot.raw),'INVALID_RAW');
  return{accountId:input.accountId,recordId:input.recordId,revision:input.revision,event:snapshot.event,observedAt:timestamp(input.observedAt),record:snapshot.record,raw:snapshot.raw,inputHash:createHash('sha256').update(encoded).digest('hex')};
}
function facts(record,at,existing=null){
  demand(object(record),'INCOMPLETE_RECORD');demand(record.durationMinutes===60,'UNSUPPORTED_DURATION');
  demand(typeof record.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(record.date)&&Number.isFinite(+new Date(record.date+'T00:00Z'))&&new Date(record.date+'T00:00Z').toISOString().slice(0,10)===record.date,'INVALID_DATE');
  demand(typeof record.time==='string'&&/^(1\d|20|21):00$/.test(record.time),'UNSUPPORTED_SLOT');
  demand(Number.isInteger(record.age)&&record.age>=1&&record.age<=18&&typeof record.hasPc==='boolean'&&typeof record.parentPresent==='boolean','INCOMPLETE_RECORD');
  const phone=text(record.phone,{required:true,max:40});demand(/^\+?[\d ()-]+$/.test(phone)&&phone.replace(/\D/g,'').length>=10&&phone.replace(/\D/g,'').length<=15,'INVALID_PHONE');
  const crm=text(record.crmUrl,{max:2048});if(crm){let u;try{u=new URL(crm);}catch{fail('INVALID_CRM');}demand(u.protocol==='https:'&&u.hostname.endsWith('.amocrm.ru')&&/^\/leads\/detail\/\d+\/?$/.test(u.pathname)&&!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_CRM');}
  demand(record.comment===undefined||typeof record.comment==='string','INVALID_RECORD');
  const start=new Date(`${record.date}T${record.time}:00+03:00`),end=new Date(+start+HOUR);
  return{date:record.date,time:record.time,starts_at:iso(start),ends_at:iso(end),student_name:text(record.studentName,{required:true}),parent_name:text(record.parentName),phone,crm_url:crm,age:record.age,has_pc:record.hasPc,parent_present:record.parentPresent,comment:record.comment===undefined&&existing?existing.comment:text(record.comment,{max:5000}),confirmation_due_at:iso(+start-2*HOUR),history_only:+end<=+at};
}

export async function initializeSourceIntakeSchema(db){
  for(const sql of (await readFile(new URL('./source-intake-schema.sql',import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.query(sql);
}

export function createSourceIntake({db,service,now=()=>new Date(),staffMap={}}={}){
  demand(db&&typeof db.transaction==='function','DATABASE_REQUIRED');
  service||=new BookingService(db,{now});
  const instant=()=>{const at=new Date(now());demand(Number.isFinite(+at),'INVALID_CLOCK');return at;};
  const mutate=fn=>service.mutation(async tx=>{await tx.query('LOCK TABLE eduson_booking.source_intake_records IN SHARE ROW EXCLUSIVE MODE');return fn(tx);});
  const migrationExists=async tx=>(await tx.query("SELECT to_regclass('eduson_booking.migration_v3_sources') relation")).rows[0].relation!==null;
  async function recordSource(tx,row,action,payload={},kind='booking'){
    if(!row.history_only)return service.record(tx,ACTOR,row,action,payload,kind);
    const at=instant().toISOString();
    const cancellation=action==='cancelled'?{timestamp:at,reason:row.cancel_reason,firstCancellation:!row.cancellation_payload,contactMethod:'',comment:row.comment,manager:ACTOR.name,source:row.cancel_source}:{};
    // Unknown historical source facts stay in SQL until an administrator proves their outcome.
    // No booking/report/cancellation sheet job is created here, and older jobs remain untouched.
    await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),row.id,ACTOR.id,ACTOR.role,action,JSON.stringify({...cancellation,...payload,version:row.version}),at]);
  }
  async function markHistoricalUnknown(tx,row,journal,at){
    await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,\'admin\',\'legacy_imported\',$4,$5)',[randomUUID(),row.id,ACTOR.id,JSON.stringify({source:'rubitime',sourceIdentity:{source:'rubitime',accountId:journal.account_id,id:journal.record_id},elapsedUnknown:true,historyOnly:true,sourceObservation:{observationId:journal.id,revision:String(journal.revision),inputHash:journal.input_hash}}),at.toISOString()]);
  }
  async function markLegacyScope(tx,row,journal,at){
    // This records current calendar scope only, never the outcome of the lesson.
    await tx.query("INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,$4,'legacy_scope_changed',$5,$6)",[
      randomUUID(),row.id,ACTOR.id,ACTOR.role,JSON.stringify({version:row.version,historyOnly:row.history_only===true,elapsedUnknown:row.history_only===true,sourceObservation:{accountId:journal.account_id,recordId:journal.record_id,observationId:journal.id,revision:String(journal.revision),inputHash:journal.input_hash}}),at.toISOString()]);
  }
  async function supersedeIssues(tx,accountId,recordId,at){
    // A newer durable source head makes only its older unresolved issues historical.
    // Numeric revisions stay in PostgreSQL; equal-head hash conflicts remain actionable.
    await tx.query(`UPDATE eduson_booking.source_intake_issues AS issue
      SET resolved_at=$1,resolution='superseded'
      FROM eduson_booking.source_intake_observations AS observation
      JOIN eduson_booking.source_intake_records AS head ON head.account_id=observation.account_id AND head.record_id=observation.record_id
      WHERE issue.observation_id=observation.id AND issue.account_id=$2 AND issue.record_id=$3
        AND observation.account_id=$2 AND observation.record_id=$3
        AND observation.revision<head.latest_revision AND issue.resolved_at IS NULL`,[at,accountId,recordId]);
  }
  async function issue(tx,row,code){
    const at=instant().toISOString();await tx.query("UPDATE eduson_booking.source_intake_observations SET status='issue',code=$1,processed_at=$2 WHERE id=$3",[code,at,row.id]);
    await tx.query('INSERT INTO eduson_booking.source_intake_issues(id,observation_id,account_id,record_id,booking_id,code,created_at)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(observation_id)DO NOTHING',[randomUUID(),row.id,row.account_id,row.record_id,row.booking_id||null,code,at]);
    await supersedeIssues(tx,row.account_id,row.record_id,at);
    return{...result({...row,status:'issue',code}),code};
  }
  async function accept(input){
    const value=envelope(input);return mutate(async tx=>{
      const at=instant().toISOString();await tx.query('INSERT INTO eduson_booking.source_intake_records(account_id,record_id,created_at,updated_at)VALUES($1,$2,$3,$3)ON CONFLICT(account_id,record_id)DO NOTHING',[value.accountId,value.recordId,at]);
      const link=(await tx.query('SELECT * FROM eduson_booking.source_intake_records WHERE account_id=$1 AND record_id=$2',[value.accountId,value.recordId])).rows[0];
      const old=(await tx.query('SELECT * FROM eduson_booking.source_intake_observations WHERE account_id=$1 AND record_id=$2 AND revision=$3 AND input_hash=$4',[value.accountId,value.recordId,value.revision,value.inputHash])).rows[0];
      if(old){await tx.query('UPDATE eduson_booking.source_intake_observations SET deliveries=deliveries+1,last_seen_at=$1 WHERE id=$2',[at,old.id]);return{...result(old),duplicate:true};}
      const conflict=(await tx.query('SELECT id FROM eduson_booking.source_intake_observations WHERE account_id=$1 AND record_id=$2 AND revision=$3 LIMIT 1',[value.accountId,value.recordId,value.revision])).rows.length>0;
      const stale=link.latest_revision!==null&&BigInt(value.revision)<BigInt(link.latest_revision);
      const row=(await tx.query(`INSERT INTO eduson_booking.source_intake_observations(id,account_id,record_id,revision,input_hash,event,payload,raw,observed_at,received_at,last_seen_at,status,booking_id,retry_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$10)RETURNING *`,[randomUUID(),value.accountId,value.recordId,value.revision,value.inputHash,value.event,JSON.stringify(value),JSON.stringify(value.raw),value.observedAt,at,stale?'stale':'pending',link.booking_id])).rows[0];
      if(conflict){
        if(String(link.latest_revision)===value.revision)await tx.query('UPDATE eduson_booking.source_intake_records SET revision_conflicted=true,updated_at=$1 WHERE account_id=$2 AND record_id=$3',[at,value.accountId,value.recordId]);
        const pending=(await tx.query("SELECT * FROM eduson_booking.source_intake_observations WHERE account_id=$1 AND record_id=$2 AND revision=$3 AND status='pending'",[value.accountId,value.recordId,value.revision])).rows;
        for(const variant of pending)await issue(tx,variant,'REVISION_HASH_CONFLICT');
        return issue(tx,row,'REVISION_HASH_CONFLICT');
      }
      if(!stale){
        await tx.query('UPDATE eduson_booking.source_intake_records SET latest_revision=$1,latest_hash=$2,revision_conflicted=false,updated_at=$3 WHERE account_id=$4 AND record_id=$5',[value.revision,value.inputHash,at,value.accountId,value.recordId]);
        await supersedeIssues(tx,value.accountId,value.recordId,at);
      }
      return{...result(row),duplicate:false};
    });
  }
  async function protectedCode(tx,link,row){
    if(link.ownership_issue)return link.ownership_issue;
    if(row.is_test||row.state!=='scheduled'||row.confirmation_status!=='pending'||row.assigned_to||row.assignment_kind||row.started_at||row.completed_at||row.confirmed_at)return'BOOKING_PROTECTED';
    if((await tx.query('SELECT booking_id FROM eduson_booking.reports WHERE booking_id=$1 UNION ALL SELECT booking_id FROM eduson_booking.payments WHERE booking_id=$1',[row.id])).rows.length)return'BOOKING_PROTECTED';
    if(await migrationExists(tx))if((await tx.query("SELECT source FROM eduson_booking.migration_v3_sources WHERE booking_id=$1 AND source<>'rubitime'",[row.id])).rows.length)return'AMO_AUTHORITY';
    if(row.version!==link.last_applied_version||bookingFingerprint(row)!==link.last_applied_fingerprint){
      // Only a complete, authenticated system capacity-only chain may advance source ownership.
      // Trying both old flags proves that every other persisted booking fact is unchanged.
      let previousHold=[false,true].find(capacity_hold=>bookingFingerprint({...row,capacity_hold})===link.last_applied_fingerprint);
      if(previousHold===undefined||row.version<=link.last_applied_version)return'BOOKING_MODIFIED';
      const audits=(await tx.query('SELECT actor_id,actor_role,action,payload FROM eduson_booking.audit_events WHERE booking_id=$1',[row.id])).rows.filter(event=>Number.isInteger(event.payload?.version)&&event.payload.version>link.last_applied_version&&event.payload.version<=row.version);
      if(audits.length!==row.version-link.last_applied_version)return'BOOKING_MODIFIED';
      for(let version=link.last_applied_version+1;version<=row.version;version++){
        const event=audits.find(candidate=>candidate.payload.version===version);
        if(!event||event.actor_id!=='system'||event.actor_role!=='admin'||!['capacity_hold_created','capacity_hold_released'].includes(event.action))return'BOOKING_MODIFIED';
        const nextHold=event.action==='capacity_hold_created';if(nextHold===previousHold)return'BOOKING_MODIFIED';previousHold=nextHold;
      }
      if(previousHold!==row.capacity_hold)return'BOOKING_MODIFIED';
    }
    return null;
  }
  async function collision(tx,values,ownId=null){
    const candidates=(await tx.query('SELECT id,crm_url,phone,date,time FROM eduson_booking.bookings WHERE ($1::text IS NULL OR id<>$1)',[ownId])).rows;
    const key=crmKey(values.crm_url),digits=values.phone.replace(/\D/g,'');
    return candidates.some(row=>(key&&crmKey(row.crm_url)===key)||(date(row.date)===values.date&&row.time===values.time&&row.phone.replace(/\D/g,'')===digits));
  }
  async function process(tx,journal){
    const link=(await tx.query('SELECT * FROM eduson_booking.source_intake_records WHERE account_id=$1 AND record_id=$2',[journal.account_id,journal.record_id])).rows[0];
    if(link.revision_conflicted&&String(link.latest_revision)===String(journal.revision))return issue(tx,journal,'REVISION_HASH_CONFLICT');
    if(String(link.latest_revision)!==String(journal.revision)||link.latest_hash!==journal.input_hash){await tx.query("UPDATE eduson_booking.source_intake_observations SET status='stale',processed_at=$1 WHERE id=$2",[instant().toISOString(),journal.id]);return{...result({...journal,status:'stale'}),status:'stale'};}
    let row=link.booking_id?await service.get(tx,link.booking_id):null;const input=journal.payload,at=instant();
    if(!row&&await migrationExists(tx))if((await tx.query("SELECT booking_id FROM eduson_booking.migration_v3_sources WHERE source='rubitime' AND source_id=$1",[journal.record_id])).rows.length)return issue(tx,journal,'MIGRATION_LINK_REQUIRED');
    if(row){const code=await protectedCode(tx,link,row);if(code)return issue(tx,{...journal,booking_id:row.id},code);}
    if(journal.event!=='upsert'){
      if(!row)return issue(tx,journal,'SOURCE_BOOKING_MISSING');
      const reason=journal.event==='cancel'?'Отменён в Rubitime':'Удалён в Rubitime';
      row=await service.change(tx,row,{state:'cancelled',cancel_reason:reason,cancel_source:'rubitime',cancelled_at:at.toISOString(),capacity_hold:false});
      await recordSource(tx,row,'cancelled',{sourceObservation:{accountId:journal.account_id,recordId:journal.record_id,revision:String(journal.revision),event:journal.event,raw:journal.raw}},'cancel');
    }else{
      let values;try{values=facts(input.record,at,row);}catch(error){if(error.name==='SourceIntakeError')return issue(tx,journal,error.code);throw error;}
      if(input.record.staffId!=null){
        try{id(input.record.staffId);}catch{return issue(tx,journal,'UNKNOWN_STAFF_MAPPING');}
        const managerId=Object.hasOwn(staffMap,journal.account_id)&&object(staffMap[journal.account_id])&&Object.hasOwn(staffMap[journal.account_id],input.record.staffId)?staffMap[journal.account_id][input.record.staffId]:null;
        if(typeof managerId!=='string')return issue(tx,journal,'UNKNOWN_STAFF_MAPPING');
        const manager=(await tx.query("SELECT id FROM eduson_booking.users WHERE id=$1 AND role='sales'",[managerId])).rows[0];
        if(!manager)return issue(tx,journal,'UNKNOWN_STAFF_MAPPING');
      }
      if(await collision(tx,values,row?.id))return issue(tx,journal,'SOURCE_IDENTITY_CONFLICT');
      const candidate={...row,...values,id:row?.id||`intake-${hash([journal.account_id,journal.record_id]).slice(0,40)}`,assigned_to:null,assignment_kind:null};
      let held=false;
      if(!values.history_only){const ctx=await service.context(tx,values.date,values.time,row?.id||null);if(!service.match(ctx))return issue(tx,journal,'EXISTING_CAPACITY_CONFLICT');held=!service.match(ctx,[candidate]);}
      if(row){
        const changes={...values,capacity_hold:held};const changed=Object.fromEntries(Object.entries(changes).filter(([key,value])=>key==='date'?date(row[key])!==value:key.endsWith('_at')?iso(row[key])!==value:row[key]!==value));
        if(Object.keys(changed).length){
          const leftLiveCalendar=!row.history_only&&values.history_only;
          const scopeChanged=row.history_only!==values.history_only;
          row=await service.change(tx,row,changed);
          await recordSource(tx,row,'source_intake_updated',{sourceIdentity:{source:'rubitime',accountId:journal.account_id,id:journal.record_id},revision:String(journal.revision),fields:Object.keys(changed),inputHash:journal.input_hash});
          if(leftLiveCalendar){await markHistoricalUnknown(tx,row,journal,at);await service.markSheetsDirty(tx);}
          if(scopeChanged)await markLegacyScope(tx,row,journal,at);
        }
      }else{
        const fields=['id',...columns,'capacity_hold','created_by','idempotency_key','created_at','updated_at'];const params=[candidate.id,...columns.map(key=>values[key]),held,ACTOR.id,hash([journal.account_id,journal.record_id]),at.toISOString(),at.toISOString()];
        await tx.query(`INSERT INTO eduson_booking.bookings(${fields.join(',')})VALUES(${params.map((_,index)=>'$'+(index+1)).join(',')})`,params);row=await service.get(tx,candidate.id);
        await recordSource(tx,row,'source_intake_created',{sourceIdentity:{source:'rubitime',accountId:journal.account_id,id:journal.record_id},revision:String(journal.revision),inputHash:journal.input_hash});
        if(values.history_only)await markHistoricalUnknown(tx,row,journal,at);
      }
    }
    const wasVersion=link.last_applied_version,status=row.version===wasVersion?'unchanged':'applied';
    await tx.query('UPDATE eduson_booking.source_intake_records SET booking_id=$1,last_applied_revision=$2,last_applied_version=$3,last_applied_fingerprint=$4,updated_at=$5 WHERE account_id=$6 AND record_id=$7',[row.id,String(journal.revision),row.version,bookingFingerprint(row),at.toISOString(),journal.account_id,journal.record_id]);
    await tx.query('UPDATE eduson_booking.source_intake_observations SET status=$1,booking_id=$2,processed_at=$3,code=NULL WHERE id=$4',[status,row.id,at.toISOString(),journal.id]);
    await tx.query("UPDATE eduson_booking.source_intake_issues SET resolved_at=$1,resolution='reprocessed' WHERE observation_id=$2 AND resolved_at IS NULL",[at.toISOString(),journal.id]);
    return{...result({...journal,status,booking_id:row.id}),status};
  }
  async function runOnce({limit=20,observationId}={}){
    demand(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_LIMIT');const outcome={applied:0,unchanged:0,issues:0,stale:0,errors:0};
    for(let i=0;i<limit;i++){
      let selected;
      try{
        const value=await mutate(async tx=>{const row=(await tx.query("SELECT * FROM eduson_booking.source_intake_observations WHERE status='pending' AND retry_at<=$1 AND ($2::text IS NULL OR id=$2)ORDER BY received_at,id LIMIT 1",[instant().toISOString(),observationId||null])).rows[0];if(!row)return null;selected=row;return process(tx,row);});
        if(!value)break;outcome[value.status==='issue'?'issues':value.status]++;
      }catch(error){
        if(!selected)throw error;outcome.errors++;
        await mutate(tx=>tx.query("UPDATE eduson_booking.source_intake_observations SET attempts=attempts+1,code='INTAKE_PROCESSING_FAILED',retry_at=$1 WHERE id=$2 AND status='pending'",[iso(+instant()+Math.min(900000,1000*2**Math.min(selected.attempts+1,10))),selected.id]));
      }
      if(observationId)break;
    }
    return outcome;
  }
  async function observe(input){const accepted=await accept(input);if(accepted.status==='pending'&&!accepted.duplicate){await runOnce({limit:1,observationId:accepted.observationId});return{...result((await db.query('SELECT * FROM eduson_booking.source_intake_observations WHERE id=$1',[accepted.observationId])).rows[0]),duplicate:false};}return accepted;}
  async function retryIssue({observationId}={}){
    id(observationId);return mutate(async tx=>{
      const row=(await tx.query('SELECT * FROM eduson_booking.source_intake_observations WHERE id=$1',[observationId])).rows[0];demand(row,'OBSERVATION_NOT_FOUND');
      demand(row.status==='issue'&&['UNKNOWN_STAFF_MAPPING','MIGRATION_LINK_REQUIRED','EXISTING_CAPACITY_CONFLICT'].includes(row.code),'ISSUE_REQUIRES_REVIEW');
      const link=(await tx.query('SELECT latest_revision,latest_hash,revision_conflicted FROM eduson_booking.source_intake_records WHERE account_id=$1 AND record_id=$2',[row.account_id,row.record_id])).rows[0];
      demand(String(link.latest_revision)===String(row.revision)&&link.latest_hash===row.input_hash&&!link.revision_conflicted,'OBSERVATION_SUPERSEDED');
      await tx.query("UPDATE eduson_booking.source_intake_observations SET status='pending',code=NULL,retry_at=$1,processed_at=NULL WHERE id=$2",[instant().toISOString(),row.id]);
      return result({...row,status:'pending',code:null});
    });
  }
  async function seedMigrationLinks({accountId}={}){
    id(accountId);return mutate(async tx=>{
      if(!await migrationExists(tx))return{seeded:0,protected:0};
      const sources=(await tx.query("SELECT * FROM eduson_booking.migration_v3_sources WHERE source='rubitime' ORDER BY source_id")).rows;let seeded=0,protectedCount=0;
      for(const source of sources){
        const existing=(await tx.query('SELECT account_id,record_id,booking_id FROM eduson_booking.source_intake_records WHERE booking_id=$1 OR (account_id=$2 AND record_id=$3)',[source.booking_id,accountId,source.source_id])).rows;
        for(const old of existing)demand(old.account_id===accountId&&old.record_id===source.source_id&&(!old.booking_id||old.booking_id===source.booking_id),'MIGRATION_LINK_CONFLICT');
        if(existing.some(old=>old.booking_id===source.booking_id))continue;
        const row=await service.get(tx,source.booking_id);const audits=(await tx.query('SELECT action FROM eduson_booking.audit_events WHERE booking_id=$1',[row.id])).rows;
        const allowed=new Set(['legacy_imported','capacity_hold_created','capacity_hold_released']);
        let ownershipIssue=audits.some(a=>!allowed.has(a.action))||row.version!==1+audits.filter(a=>a.action.startsWith('capacity_hold_')).length?'BOOKING_MODIFIED':null;
        const csv=source.raw?.csv,api=source.raw?.api;
        const yesNo=value=>value==='Да'?true:value==='Нет'?false:null;
        if(!csv||!api||String(csv.rubitimeId)!==source.source_id||String(api.id)!==source.source_id||row.student_name!==(csv.childName||'')||row.parent_name!==(csv.parentName||'')||row.phone!==(csv.phone||'')||row.crm_url!==''||row.age!==Number(csv.childAge)||date(row.date)!==csv.startLocal.slice(0,10)||row.time!==csv.startLocal.slice(11,16)||row.has_pc!==yesNo(csv.hasComputerRaw)||row.parent_present!==yesNo(csv.parentAttendingRaw)||row.comment!==(csv.comment||csv.clientComment||''))ownershipIssue='BOOKING_MODIFIED';
        const at=instant().toISOString();await tx.query(`INSERT INTO eduson_booking.source_intake_records(account_id,record_id,booking_id,last_applied_version,last_applied_fingerprint,ownership_issue,origin,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,'migration_v3',$7,$7)
          ON CONFLICT(account_id,record_id)DO UPDATE SET booking_id=EXCLUDED.booking_id,last_applied_version=EXCLUDED.last_applied_version,last_applied_fingerprint=EXCLUDED.last_applied_fingerprint,ownership_issue=EXCLUDED.ownership_issue,origin=EXCLUDED.origin,updated_at=EXCLUDED.updated_at`,[accountId,source.source_id,row.id,row.version,bookingFingerprint(row),ownershipIssue,at]);
        await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,\'admin\',\'source_intake_seeded\',$4,$5)',[randomUUID(),row.id,ACTOR.id,JSON.stringify({sourceIdentity:{source:'rubitime',accountId,id:source.source_id},migrationFingerprint:source.fingerprint,bookingVersion:row.version,ownershipIssue}),at]);
        seeded++;if(ownershipIssue)protectedCount++;
      }
      return{seeded,protected:protectedCount};
    });
  }
  async function listIssues({includeResolved=false,limit=100}={}){demand(Number.isInteger(limit)&&limit>0&&limit<=500,'INVALID_LIMIT');return(await db.query('SELECT id,observation_id,account_id,record_id,booking_id,code,created_at,resolved_at,resolution FROM eduson_booking.source_intake_issues WHERE ($1::boolean OR resolved_at IS NULL)ORDER BY created_at,id LIMIT $2',[includeResolved,limit])).rows;}
  async function status(){return(await db.query(`SELECT (SELECT count(*)::int FROM eduson_booking.source_intake_observations WHERE status='pending') pending,(SELECT count(*)::int FROM eduson_booking.source_intake_issues WHERE resolved_at IS NULL) issues,(SELECT count(*)::int FROM eduson_booking.source_intake_records WHERE booking_id IS NOT NULL) linked,(SELECT count(*)::int FROM eduson_booking.source_intake_observations WHERE status='pending' AND code='INTAKE_PROCESSING_FAILED') errors`)).rows[0];}
  return{accept,observe,runOnce,retryIssue,seedMigrationLinks,listIssues,status};
}
