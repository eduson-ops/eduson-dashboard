import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, unlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.mjs';
import { openDatabase } from './db.mjs';

const ACTOR = 'legacy-import';
const SERIAL_BASE = Date.UTC(1899, 11, 30);
const DAY = 86400000;
const LEGACY_HEADERS = ['ID','Отметка времени','Дата','Время','Сейл','AmoCRM','Возраст','Телефон','Место','Статус','Автор','Изменено','Кто изменил','Idempotency-Key','Резервный журнал'];
const CONFIRMATION_HEADERS = ['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? '];
function canonical(value) {
  const ordered = item => item && typeof item==='object'
    ? Array.isArray(item) ? item.map(ordered) : Object.fromEntries(Object.keys(item).sort().filter(k=>item[k]!==undefined).map(k=>[k,ordered(item[k])]))
    : item;
  return JSON.stringify(ordered(value));
}
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const blank = value => value == null || value === '';
const hhmm = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const key = (date,time,manager) => JSON.stringify([date,time,manager]);
const staffWords = value => value.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').trim().split(/\s+/).sort().join(' ');
function eligible(groups,age) {
  return !groups.length || groups.some(group=>{
    if(Number.isInteger(group))return group===age;
    if(group && typeof group==='object')return Number.isInteger(group.min) && Number.isInteger(group.max) && group.min<=age && age<=group.max;
    if(typeof group!=='string')return false;
    const match=group.trim().match(/^(\d{1,2})\s*(?:[-–—]\s*(\d{1,2}))?(?:\s*(?:лет|года?|years?))?$/i);
    return !!match && Number(match[1])<=age && age<=Number(match[2]||match[1]);
  });
}

class ImportError extends Error {
  constructor(code) { super(code); this.name='LegacyImportError'; this.code=code; }
}
const demand = (condition, code) => { if (!condition) throw new ImportError(code); };
function string(value, code, {required=true,max=10000}={}) {
  demand(typeof value === 'string' && value.length<=max && (!required || value.length>0),code);
  return value;
}
function name(value) { const result=string(value,'INVALID_MANAGER_NAME',{max:120}); demand(result===result.trim(),'INVALID_MANAGER_NAME'); return result; }
function id(value) { return string(value,'INVALID_BOOKING_ID',{max:128}); }
function iso(value) {
  demand(typeof value==='string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(+new Date(value)),'INVALID_TIMESTAMP');
  return new Date(value).toISOString();
}
function serialTimestamp(value) {
  demand(typeof value==='number' && Number.isFinite(value) && value>0 && value<1000000,'INVALID_SERIAL_TIMESTAMP');
  return new Date(SERIAL_BASE+Math.round(value*DAY)-10800000).toISOString();
}
function date(value) {
  let result;
  if (typeof value==='number') { demand(Number.isInteger(value) && value>0 && value<1000000,'INVALID_DATE_SERIAL'); result=new Date(SERIAL_BASE+value*DAY).toISOString().slice(0,10); }
  else {
    demand(typeof value==='string','INVALID_DATE');
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) result=value.split('.').reverse().join('-');
    else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) result=value;
    else throw new ImportError('INVALID_DATE');
  }
  demand(Number.isFinite(+new Date(`${result}T00:00:00Z`)) && new Date(`${result}T00:00:00Z`).toISOString().slice(0,10)===result,'INVALID_DATE');
  return result;
}
function time(value) {
  if (typeof value==='number') {
    demand(Number.isFinite(value) && value>=0 && value<1 && Math.abs(value*1440-Math.round(value*1440))<1e-6,'INVALID_TIME_SERIAL');
    value=hhmm(Math.round(value*1440));
  }
  demand(typeof value==='string' && /^\d{2}:\d{2}$/.test(value),'INVALID_TIME');
  const [hours,minutes]=value.split(':').map(Number);
  demand(hours<=23 && minutes<=59 && hours*60+minutes+60<=1440,'INVALID_TIME');
  return value;
}
function age(value) { demand(Number.isInteger(value) && value>=1 && value<=18,'INVALID_AGE'); return value; }
function bool(value) { demand(['Да','Нет'].includes(value),'INVALID_BOOLEAN'); return value==='Да'; }
function crm(value) {
  const result=string(value,'INVALID_CRM',{required:false,max:2048});
  if (result) { let url; try { url=new URL(result); } catch { throw new ImportError('INVALID_CRM'); } demand(['https:','http:'].includes(url.protocol) && !url.username && !url.password,'INVALID_CRM'); }
  return result;
}
function crmKey(value) { if (!value) return ''; const url=new URL(value); return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/,'')}`; }
function values(part,headers) {
  demand(part && Array.isArray(part.values) && part.values.length>0 && part.values.every(Array.isArray),'INVALID_SHEET_VALUES');
  demand(headers.every((v,i)=>part.values[0][i]===v),'INVALID_SHEET_HEADERS');
  return part.values;
}

/** Build a private plan. Public inspection exposes only counts and value-free issue codes. */
function planSnapshot(snapshot) {
  const counts={bookings:0,active:0,cancelled:0,slotRows:0,slotTriples:0,managers:0,ignoredLegacyRows:0,sqliteAuditEvents:0,identicalDuplicates:0,matchedConfirmations:0,unmatchedConfirmations:0,skippedConfirmations:0};
  const issues=[];
  const issue=(error,location) => issues.push({code:error instanceof ImportError?error.code:'INVALID_SOURCE_VALUE',location});
  const checked=(location,fn) => { try { return fn(); } catch(error) { issue(error,location); return null; } };
  let capturedAt,slots,legacy,managerRows,confirmations;
  checked('snapshot',()=>{
    demand(snapshot?.version===1,'UNSUPPORTED_SNAPSHOT_VERSION');
    demand(snapshot.timezone==='Europe/Moscow','UNSUPPORTED_TIMEZONE');
    capturedAt=iso(snapshot.capturedAt);
    demand(Array.isArray(snapshot.sqlite?.bookings) && Array.isArray(snapshot.sqlite?.audit),'INVALID_SQLITE_SNAPSHOT');
    slots=values(snapshot.sheet?.slots,['Дата','Время','Менеджер','Статус']);
    legacy=values(snapshot.sheet?.legacyBookings,LEGACY_HEADERS);
    managerRows=values(snapshot.sheet?.managers,['Имя','Активен']);
    if(snapshot.sheet?.confirmations!==undefined) {
      confirmations=values(snapshot.sheet.confirmations,CONFIRMATION_HEADERS);
      demand(confirmations[0].length===CONFIRMATION_HEADERS.length,'INVALID_SHEET_HEADERS');
    }
  });
  if (issues.length) return {counts,issues,records:[],schedules:[],names:[]};
  const triples=new Map(), names=new Set(), records=new Map(), auditByBooking=new Map(), auditIds=new Set();
  for (const [i,row] of slots.entries()) {
    if (!i || row.every(blank)) continue;
    checked(`sheet.slots:${i+1}`,()=>{
      const d=date(row[0]), t=time(row[1]), manager=name(row[2]);
      demand(t.endsWith(':00') && t>='10:00' && t<='21:00','UNSUPPORTED_SLOT_HOUR');
      demand(['wait','booked'].includes(row[3]),'INVALID_SLOT_STATUS');
      const k=key(d,t,manager); const triple=triples.get(k)||{date:d,time:t,manager,capacity:0,raw:[]};
      triple.capacity++; triple.raw.push({row:i+1,values:row});
      demand(triple.capacity<=2,'UNSUPPORTED_SLOT_CAPACITY');
      triples.set(k,triple); names.add(manager); counts.slotRows++;
    });
  }
  for (const [i,event] of snapshot.sqlite.audit.entries()) checked(`sqlite.audit:${i+1}`,()=>{
    demand(event && Number.isInteger(event.id) && !auditIds.has(event.id),'INVALID_AUDIT_ID'); auditIds.add(event.id);
    const booking=id(event.booking); string(event.action,'INVALID_AUDIT_ACTION',{max:100}); iso(event.at);
    if (!auditByBooking.has(booking)) auditByBooking.set(booking,[]);
    auditByBooking.get(booking).push(event); counts.sqliteAuditEvents++;
  });
  function add(record, original) {
    const fp=fingerprint({source:record.source,original,audit:record.raw.audit||[]});
    const previous=records.get(record.id);
    if (previous) {
      demand(previous.source===record.source,'CROSS_SOURCE_ID_COLLISION');
      demand(previous.fingerprint===fp,'DIFFERING_DUPLICATE'); counts.identicalDuplicates++; return;
    }
    record.fingerprint=fp;
    records.set(record.id,record); names.add(record.manager);
  }
  for (const [i,row] of snapshot.sqlite.bookings.entries()) checked(`sqlite.bookings:${i+1}`,()=>{
    demand(row && row.payload && typeof row.payload==='object' && !Array.isArray(row.payload),'INVALID_SQLITE_PAYLOAD');
    const p=row.payload, bookingId=id(row.id); demand(p.id===bookingId,'PAYLOAD_ID_MISMATCH');
    demand(['active','deleted'].includes(row.status),'UNSUPPORTED_SQLITE_STATUS');
    demand(Number.isInteger(row.slot_row),'INVALID_SLOT_ROW');
    const createdAt=iso(row.created),updatedAt=iso(row.updated); iso(p.created);
    const record={id:bookingId,source:'vds_sqlite',date:date(p.date),time:time(p.time),manager:name(p.manager),crmUrl:crm(p.crmUrl),age:age(p.age),hasPc:bool(p.pc),parentPresent:bool(p.parent),phone:'',comment:string(p.comment,'INVALID_COMMENT',{required:false}),confirmationStatus:'pending',cancelled:row.status==='deleted',createdAt,updatedAt,idempotencyKey:string(row.idem,'INVALID_IDEMPOTENCY_KEY',{max:256}),raw:{booking:row,audit:auditByBooking.get(bookingId)||[],durationInferred:true,missingFields:['studentName','parentName','phone'],confirmationDueInferred:true}};
    add(record,row);
  });
  for (const [i,row] of legacy.entries()) {
    if (!i) continue;
    if (blank(row[0])) { counts.ignoredLegacyRows++; continue; }
    checked(`sheet.legacyBookings:${i+1}`,()=>{
      demand(['pending_confirmation','confirmed','rejected'].includes(row[9]),'UNSUPPORTED_LEGACY_STATUS');
      const createdAt=serialTimestamp(row[1]),updatedAt=blank(row[11])?createdAt:serialTimestamp(row[11]);
      const record={id:id(row[0]),source:'apps_script',date:date(row[2]),time:time(row[3]),manager:name(row[4]),crmUrl:crm(row[5]),age:age(row[6]),phone:blank(row[7])?'':String(row[7]),hasPc:null,parentPresent:null,comment:'',confirmationStatus:row[9]==='confirmed'?'confirmed':'pending',cancelled:row[9]==='rejected',createdAt,updatedAt,idempotencyKey:string(row[13],'INVALID_IDEMPOTENCY_KEY',{max:256}),raw:{row:i+1,values:row,headers:legacy[0],durationInferred:true,missingFields:['studentName','parentName','hasPc','parentPresent'],confirmedAtInferred:row[9]==='confirmed',confirmationDueInferred:true,updatedAtInferred:blank(row[11])}};
      add(record,row);
    });
  }
  for (const bookingId of auditByBooking.keys()) if (!records.has(bookingId)) issues.push({code:'ORPHAN_AUDIT_EVENT',location:'sqlite.audit'});
  const used=new Map(), crmIds=new Map(), idemIds=new Map();
  for (const record of records.values()) checked(`booking:${[...records.keys()].indexOf(record.id)+1}`,()=>{
    const triple=triples.get(key(record.date,record.time,record.manager));
    record.startsAt=new Date(`${record.date}T${record.time}:00+03:00`).toISOString();
    record.endsAt=new Date(+new Date(record.startsAt)+3600000).toISOString();
    record.elapsedUnknown=!record.cancelled && +new Date(record.endsAt)<=+new Date(capturedAt);
    record.raw.slots=triple?.raw||[];
    const normalizedCrm=crmKey(record.crmUrl);
    demand(!normalizedCrm || !crmIds.has(normalizedCrm),'DUPLICATE_CRM'); if (normalizedCrm) crmIds.set(normalizedCrm,record.id);
    demand(!idemIds.has(record.idempotencyKey),'DUPLICATE_IDEMPOTENCY_KEY'); idemIds.set(record.idempotencyKey,record.id);
    if (!record.cancelled) {
      demand(triple,'ACTIVE_BOOKING_WITHOUT_SLOT');
      const k=key(record.date,record.time,record.manager), n=(used.get(k)||0)+1;
      demand(n<=triple.capacity,'SOURCE_CAPACITY_EXCEEDED'); used.set(k,n);
    }
  });
  // This sheet also contains unrelated historical lessons. Only causal CRM+hour candidates enter this import.
  const confirmationsByBooking=new Map();
  for(const [i,row] of (confirmations||[]).entries()) {
    if(!i || row.every(blank))continue;
    let normalizedCrm,confirmedAt,confirmedTime;
    try { normalizedCrm=crmKey(crm(row[1])); } catch { counts.skippedConfirmations++;continue; }
    const sameCrm=[...records.values()].filter(r=>crmKey(r.crmUrl)===normalizedCrm && normalizedCrm);
    if(!sameCrm.length) { counts.unmatchedConfirmations++;continue; }
    try { confirmedAt=typeof row[0]==='number'?serialTimestamp(row[0]):iso(row[0]); confirmedTime=time(row[3]); }
    catch { counts.skippedConfirmations++;continue; }
    const candidates=sameCrm.filter(r=>r.time===confirmedTime && +new Date(r.createdAt)<=+new Date(confirmedAt) && +new Date(confirmedAt)<+new Date(r.startsAt));
    if(!candidates.length) { counts.skippedConfirmations++;continue; }
    checked(`sheet.confirmations:${i+1}`,()=>{
      demand(candidates.length===1,'AMBIGUOUS_CONFIRMATION_EVIDENCE');
      const record=candidates[0];
      const manager=name(row[2]);
      demand(staffWords(record.manager)===staffWords(manager),'CONFIRMATION_MANAGER_MISMATCH');
      demand(!confirmationsByBooking.has(record.id),'AMBIGUOUS_CONFIRMATION_EVIDENCE');
      const evidence={row:i+1,values:row,headers:confirmations[0],confirmedAt};
      confirmationsByBooking.set(record.id,evidence);
      record.raw.confirmation=evidence;
      record.confirmationStatus='confirmed';record.confirmedAt=confirmedAt;
      record.raw.confirmedAtInferred=false;
      counts.matchedConfirmations++;
    });
  }
  for(const record of records.values())record.fingerprint=fingerprint({source:record.source,raw:record.raw});
  for (const [i,row] of managerRows.entries()) {
    if (!i || row.every(blank)) continue;
    checked(`sheet.managers:${i+1}`,()=>{
      // The directory contains display-name padding; preserve the raw sheet in the manifest.
      const manager=name(string(row[0],'INVALID_MANAGER_NAME',{max:120}).trim().replace(/\s+/g,' '));
      if (names.has(manager) && [false,0,'FALSE','false','Нет','нет'].includes(row[1])) throw new ImportError('SOURCE_MANAGER_INACTIVE');
    });
  }
  const schedulesByKey=new Map();
  for (const triple of triples.values()) {
    const k=JSON.stringify([triple.date,triple.manager]);
    if (!schedulesByKey.has(k)) schedulesByKey.set(k,{date:triple.date,manager:triple.manager,intervals:[]});
    const start=Number(triple.time.slice(0,2))*60+Number(triple.time.slice(3));
    schedulesByKey.get(k).intervals.push({start:triple.time,end:hhmm(start+60),reserveCapacity:triple.capacity-1});
  }
  for (const schedule of schedulesByKey.values()) checked('schedules',()=>{
    const merged=[];
    for (const interval of schedule.intervals.sort((a,b)=>a.start.localeCompare(b.start))) {
      const previous=merged.at(-1); demand(!previous || previous.end<=interval.start,'OVERLAPPING_SOURCE_SLOTS');
      if (previous && previous.end===interval.start && previous.reserveCapacity===interval.reserveCapacity) previous.end=interval.end;
      else merged.push({...interval});
    }
    schedule.intervals=merged;
  });
  counts.bookings=records.size; counts.active=[...records.values()].filter(r=>!r.cancelled).length; counts.cancelled=counts.bookings-counts.active;
  counts.slotTriples=triples.size; counts.managers=names.size;
  const manifest={version:snapshot.version,capturedAt:snapshot.capturedAt,timezone:snapshot.timezone,slots:snapshot.sheet.slots,managers:snapshot.sheet.managers,legacyHeaders:legacy[0],...(confirmations?{confirmations:{headers:confirmations[0],matched:[...confirmationsByBooking.values()]}}:{})};
  const {capturedAt:ignored,...manifestFacts}=manifest;
  return {counts,issues,capturedAt,records:[...records.values()],schedules:[...schedulesByKey.values()],names:[...names].sort(),manifest,manifestFingerprint:fingerprint(manifestFacts)};
}

export function inspectLegacySnapshot(snapshot) {
  const plan=planSnapshot(snapshot);
  return {ok:plan.issues.length===0,counts:plan.counts,issues:plan.issues};
}

/** Dry-run never uses db or writes files. Apply is one locked PostgreSQL transaction. */
export async function importLegacySnapshot(db,snapshot,{apply=false,now=()=>new Date(),credentialOutputPath}={}) {
  const plan=planSnapshot(snapshot), summary={ok:plan.issues.length===0,applied:false,counts:plan.counts,issues:plan.issues};
  if (!apply) return summary;
  demand(summary.ok,'INVALID_LEGACY_SNAPSHOT');
  demand(db && typeof db.transaction==='function','DATABASE_REQUIRED');
  const at=new Date(typeof now==='function'?now():now); demand(Number.isFinite(+at),'INVALID_IMPORT_TIME');
  let credentialFile;
  try {
    if (credentialOutputPath) { credentialFile=await open(credentialOutputPath,'wx',0o600); await credentialFile.chmod(0o600); }
    const result=await db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.bookings,eduson_booking.schedules,eduson_booking.users,eduson_booking.audit_events IN SHARE ROW EXCLUSIVE MODE');
      const existing=(await tx.query('SELECT id FROM eduson_booking.bookings')).rows;
      if (existing.length) {
        const imported=(await tx.query("SELECT booking_id,payload FROM eduson_booking.audit_events WHERE action='legacy_imported'")).rows;
        const manifest=(await tx.query("SELECT payload FROM eduson_booking.audit_events WHERE action='legacy_snapshot_imported'")).rows;
        demand(existing.length===plan.records.length && imported.length===plan.records.length && manifest.length===1 && manifest[0].payload.fingerprint===plan.manifestFingerprint && plan.records.every(r=>existing.some(e=>e.id===r.id) && imported.some(e=>e.booking_id===r.id && e.payload.fingerprint===r.fingerprint)),'TARGET_BOOKINGS_CONFLICT');
        if (credentialFile) await credentialFile.writeFile('[]\n','utf8');
        return {...summary,applied:true,idempotent:true,createdUsers:0};
      }
      const users=(await tx.query('SELECT * FROM eduson_booking.users')).rows, managers=new Map(), credentials=[];
      const emails=new Set(users.map(u=>u.email.toLowerCase())); let emailIndex=1;
      for (const manager of plan.names) {
        const matches=users.filter(u=>u.name===manager);
        demand(matches.length<=1 && (!matches.length || matches[0].role==='sales' && matches[0].active),'MANAGER_IDENTITY_CONFLICT');
        if (matches.length) { managers.set(manager,matches[0].id); continue; }
        let email; do { email=`manager.${String(emailIndex++).padStart(2,'0')}@eduson.local`; } while(emails.has(email)); emails.add(email);
        const managerId=`legacy-sales-${fingerprint(manager).slice(0,24)}`, password=randomBytes(24).toString('base64url');
        await tx.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups,created_at) VALUES($1,$2,$3,$4,$5,true,$6,$7)',[managerId,email,manager,'sales',await hashPassword(password),'[]',at.toISOString()]);
        managers.set(manager,managerId); credentials.push({name:manager,email,password});
      }
      const priorSchedules=(await tx.query('SELECT manager_id,date FROM eduson_booking.schedules')).rows;
      demand(priorSchedules.every(old=>plan.schedules.some(s=>managers.get(s.manager)===old.manager_id && s.date===(typeof old.date==='string'?old.date.slice(0,10):new Date(old.date).toISOString().slice(0,10)))),'TARGET_SCHEDULE_CONFLICT');
      for (const schedule of plan.schedules) {
        const managerId=managers.get(schedule.manager);
        const old=(await tx.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2',[managerId,schedule.date])).rows[0];
        demand(!old || canonical(old.intervals)===canonical(schedule.intervals),'TARGET_SCHEDULE_CONFLICT');
        if (!old) await tx.query('INSERT INTO eduson_booking.schedules(manager_id,date,intervals,reserve_capacity,updated_at) VALUES($1,$2,$3,1,$4)',[managerId,schedule.date,JSON.stringify(schedule.intervals),at.toISOString()]);
      }
      const confirmedPlaces=new Map();
      for (const record of plan.records) {
        let assignedTo=null, assignmentKind=null;
        if (record.confirmationStatus==='confirmed' && !record.cancelled) {
          const originalUser=users.find(u=>u.id===managers.get(record.manager));
          demand(!originalUser || eligible(originalUser.age_groups||[],record.age),'MANAGER_AGE_INELIGIBLE');
          const k=key(record.date,record.time,record.manager), occupied=confirmedPlaces.get(k)||0;
          demand(occupied<2,'SOURCE_CAPACITY_EXCEEDED'); confirmedPlaces.set(k,occupied+1);
          assignedTo=managers.get(record.manager); assignmentKind=occupied?'reserve':'primary';
        }
        await tx.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,comment,confirmation_status,confirmation_due_at,confirmed_at,assigned_to,assignment_kind,state,cancel_reason,cancel_source,cancelled_at,created_by,idempotency_key,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,'','',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19,$20,$21,$22,$23)`,[
          record.id,record.date,record.time,record.startsAt,record.endsAt,record.phone,record.crmUrl,record.age,record.hasPc,record.parentPresent,record.comment,record.confirmationStatus,new Date(+new Date(record.startsAt)-7200000).toISOString(),record.confirmationStatus==='confirmed'?(record.confirmedAt||record.updatedAt):null,assignedTo,assignmentKind,record.cancelled?'cancelled':'scheduled',record.cancelled?'legacy_unknown':null,record.cancelled?record.updatedAt:null,ACTOR,record.idempotencyKey,record.createdAt,record.updatedAt]);
        const payload={source:record.source,managerName:record.manager,capturedAt:plan.capturedAt,elapsedUnknown:record.elapsedUnknown,raw:record.raw,fingerprint:record.fingerprint};
        await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),record.id,ACTOR,'admin','legacy_imported',JSON.stringify(payload),at.toISOString()]);
        if(record.raw.confirmation)await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),record.id,ACTOR,'admin','legacy_confirmation_evidence',JSON.stringify({source:'confirmations_sheet',confirmedAt:record.confirmedAt,authorUnknown:true,raw:record.raw.confirmation}),record.confirmedAt]);
        if(record.cancelled)await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),record.id,ACTOR,'admin','legacy_cancelled',JSON.stringify({timestamp:record.updatedAt,reason:'legacy_unknown',source:'legacy_unknown',authorUnknown:true,manager:'Неизвестен',contactMethod:'',comment:record.comment,firstCancellation:true,version:1,raw:{source:record.source,booking:record.raw.booking||{row:record.raw.row,values:record.raw.values},audit:record.raw.audit||[]}}),record.updatedAt]);
        for (const event of record.raw.audit||[]) await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),record.id,ACTOR,'admin','legacy_event',JSON.stringify({source:'vds_sqlite',raw:event}),iso(event.at)]);
      }
      await tx.query('INSERT INTO eduson_booking.audit_events(id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ACTOR,'admin','legacy_snapshot_imported',JSON.stringify({fingerprint:plan.manifestFingerprint,raw:plan.manifest}),at.toISOString()]);
      // Coalesce schedule projection while retaining an in-flight worker's lease and rollback payload.
      await tx.query(`INSERT INTO eduson_booking.sheet_projections(key,version,status,attempts,last_error,updated_at) VALUES('schedule',1,'pending',0,NULL,$1)
        ON CONFLICT(key) DO UPDATE SET version=eduson_booking.sheet_projections.version+1,status='pending',attempts=0,last_error=NULL,updated_at=EXCLUDED.updated_at`,[at.toISOString()]);
      if (credentialFile) await credentialFile.writeFile(`${JSON.stringify(credentials,null,2)}\n`,'utf8');
      return {...summary,applied:true,idempotent:false,createdUsers:credentials.length};
    });
    if (credentialFile) await credentialFile.close();
    return result;
  } catch(error) {
    if (credentialFile) { await credentialFile.close().catch(()=>{}); await unlink(credentialOutputPath).catch(()=>{}); }
    if (error instanceof ImportError) throw error;
    throw new ImportError(error.code==='EEXIST'?'CREDENTIAL_FILE_EXISTS':error.code==='ENOENT'?'CREDENTIAL_DIRECTORY_MISSING':'LEGACY_IMPORT_FAILED');
  }
}

async function cli() {
  const args=process.argv.slice(2); let snapshotPath,credentialOutputPath,apply=false;
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--snapshot') { demand(!snapshotPath && args[i+1] && !args[i+1].startsWith('--'),'INVALID_ARGUMENTS'); snapshotPath=args[++i]; }
    else if (args[i]==='--credentials-out') { demand(!credentialOutputPath && args[i+1] && !args[i+1].startsWith('--'),'INVALID_ARGUMENTS'); credentialOutputPath=args[++i]; }
    else if (args[i]==='--apply') { demand(!apply,'INVALID_ARGUMENTS'); apply=true; }
    else throw new ImportError('INVALID_ARGUMENTS');
  }
  demand(snapshotPath,'SNAPSHOT_REQUIRED');
  let snapshot; try { snapshot=JSON.parse(await readFile(snapshotPath,'utf8')); } catch { throw new ImportError('SNAPSHOT_READ_FAILED'); }
  let db;
  try {
    if (apply) { demand(process.env.DATABASE_URL,'DATABASE_URL_REQUIRED'); demand(inspectLegacySnapshot(snapshot).ok,'INVALID_LEGACY_SNAPSHOT'); db=await openDatabase({databaseUrl:process.env.DATABASE_URL}); }
    const result=await importLegacySnapshot(db,snapshot,{apply,credentialOutputPath});
    process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok) process.exitCode=1;
  } finally { if (db) await db.close(); }
}

const isMain=process.argv[1] && await Promise.all([realpath(resolve(process.argv[1])),realpath(fileURLToPath(import.meta.url))]).then(([entry,module])=>entry===module).catch(()=>false);
if (isMain) cli().catch(error=>{
  process.stderr.write(`${JSON.stringify({ok:false,error:error instanceof ImportError?error.code:'LEGACY_IMPORT_FAILED'})}\n`);
  process.exitCode=1;
});
