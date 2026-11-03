import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {hashPassword} from './auth.mjs';
import {BookingService} from './domain.mjs';

export const MIGRATION_V3_ALIASES=Object.freeze({
  'Виноградова Н.':'Виноградова Нина','Куюмджу Д.':'Куюмджу Дарья',
  'Папашвили Д.':'Папашвили Давид','Перебейносов А.':'Перебейносов Андрей'
});
const DAY=86400000,BASE=Date.UTC(1899,11,30),ACTOR='legacy-import';
const ordered=value=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,ordered(value[k])])):value;
const canonical=value=>JSON.stringify(ordered(value));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fault=code=>Object.assign(new Error(code),{name:'MigrationV3Error',code});
const demand=(condition,code)=>{if(!condition)throw fault(code);};
const blank=value=>value==null||value==='';
const iso=value=>new Date(value).toISOString();
const dateValue=value=>typeof value==='string'?value.slice(0,10):iso(value).slice(0,10);
const cleanName=value=>{demand(typeof value==='string'&&value.trim()&&value.length<=160,'INVALID_MANAGER_NAME');return value.trim().replace(/\s+/g,' ');};
const managerName=value=>{const name=cleanName(value);return MIGRATION_V3_ALIASES[name]||name;};
const hhmm=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
function parseDate(value){
  const result=typeof value==='number'&&Number.isInteger(value)?new Date(BASE+value*DAY).toISOString().slice(0,10):typeof value==='string'&&/^\d{2}\.\d{2}\.\d{4}$/.test(value)?value.split('.').reverse().join('-'):value;
  demand(typeof result==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(result)&&Number.isFinite(+new Date(result+'T00:00Z'))&&iso(result+'T00:00Z').slice(0,10)===result,'INVALID_DATE');return result;
}
function parseTime(value,{end=false}={}){
  if(typeof value==='number'){demand(Number.isFinite(value)&&value>=0&&value<1&&Math.abs(value*1440-Math.round(value*1440))<1e-6,'INVALID_TIME');value=hhmm(Math.round(value*1440));}
  demand(typeof value==='string'&&/^\d{2}:\d{2}$/.test(value),'INVALID_TIME');const [h,m]=value.split(':').map(Number);
  demand((h<24&&m<60)||(end&&h===24&&m===0),'INVALID_TIME');return value;
}
const minute=value=>{parseTime(value,{end:true});const[h,m]=value.split(':').map(Number);return h*60+m;};
function timestamp(value){
  demand(typeof value==='string'&&value.length<80,'INVALID_TIMESTAMP');
  const local=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value);
  const normalized=local?value.replace(' ','T')+(value.length===16?':00':'')+'+03:00':value;
  demand(/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)&&Number.isFinite(+new Date(normalized)),'INVALID_TIMESTAMP');return iso(normalized);
}
function tableRows(part,headers){demand(part&&Array.isArray(part.values)&&part.values.length&&part.values.every(Array.isArray),'INVALID_SHEET_VALUES');demand(headers.every((h,i)=>part.values[0][i]===h),'INVALID_SHEET_HEADERS');return part.values.slice(1);}
function crm(value){if(blank(value))return '';demand(typeof value==='string','INVALID_CRM');let result;try{result=new URL(value);}catch{throw fault('INVALID_CRM');}demand(result.protocol==='https:'&&result.hostname.endsWith('.amocrm.ru')&&/^\/leads\/detail\/\d+\/?$/.test(result.pathname)&&!result.username&&!result.password,'INVALID_CRM');return value;}
const crmKey=value=>{if(!value)return '';try{const u=new URL(value);return u.origin.toLowerCase()+u.pathname.replace(/\/$/,'');}catch{return '';}};
function normalizeRecord(record,at,capturedAt){
  const identity=record?.sourceIdentity;
  demand(identity&&typeof identity.source==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(identity.source)&&['string','number'].includes(typeof identity.id)&&String(identity.id).length>0&&String(identity.id).length<=128,'INVALID_SOURCE_IDENTITY');
  demand(record.state===undefined||record.state==='scheduled','OUTCOME_EVIDENCE_REQUIRED');
  demand(record.confirmationStatus===undefined||record.confirmationStatus==='pending','CONFIRMATION_EVIDENCE_REQUIRED');
  const date=parseDate(record.date),time=parseTime(record.time);demand(time.endsWith(':00')&&time>='10:00'&&time<='21:00','UNSUPPORTED_SLOT_HOUR');
  demand(Number.isInteger(record.age)&&record.age>=1&&record.age<=18,'MISSING_OR_INVALID_AGE');
  for(const value of [record.hasPc,record.parentPresent])demand(value==null||typeof value==='boolean','INVALID_BOOLEAN');
  const startsAt=iso(`${date}T${time}:00+03:00`),endsAt=iso(+new Date(startsAt)+3600000),historyOnly=+new Date(endsAt)<=+at;
  if(record.historyOnly!==undefined)demand(record.historyOnly===historyOnly,'HISTORY_SCOPE_MISMATCH');
  const source=identity.source,sourceId=String(identity.id),raw=record.raw||{};
  demand(raw&&typeof raw==='object'&&!Array.isArray(raw),'INVALID_RAW_SOURCE');
  const normalized={source,sourceId,id:`source-${hash([source,sourceId]).slice(0,40)}`,date,time,startsAt,endsAt,age:record.age,historyOnly,
    studentName:record.studentName||'',parentName:record.parentName||'',phone:record.phone||'',crmUrl:crm(record.crmUrl),hasPc:record.hasPc??null,parentPresent:record.parentPresent??null,
    comment:record.comment||'',managerName:record.managerName?cleanName(record.managerName):'',createdAt:record.createdAt?timestamp(record.createdAt):capturedAt,updatedAt:record.updatedAt?timestamp(record.updatedAt):record.createdAt?timestamp(record.createdAt):capturedAt,raw};
  for(const value of [normalized.studentName,normalized.parentName,normalized.phone,normalized.comment])demand(typeof value==='string'&&value.length<=10000,'INVALID_RECORD_TEXT');
  normalized.fingerprint=hash({...normalized,id:undefined,historyOnly:undefined});return normalized;
}
function sourcePlan(input,{at,newFutureReserveCapacity,existingRecordEvidence}){
  const issues=[],rows=[],records=[],directory=new Map(),calendar=new Map(),pairs=new Map();
  const check=(location,fn)=>{try{return fn();}catch(error){issues.push({code:error.code||'INVALID_SOURCE_VALUE',location});return null;}};
  const snapshot=input?.snapshot;let capturedAt;
  check('snapshot',()=>{demand(snapshot&&snapshot.timezone==='Europe/Moscow','UNSUPPORTED_TIMEZONE');capturedAt=timestamp(snapshot.capturedAt);});
  const schedule=check('schedule',()=>tableRows(snapshot?.sheet?.schedule,['Менеджер','Дата','Время']))||[];
  const staff=check('managers',()=>tableRows(snapshot?.sheet?.managers,['Имя','Активен']))||[];
  for(const[index,row]of staff.entries())if(row.some(v=>!blank(v)))check(`managers:${index+2}`,()=>{
    const name=managerName(row[0]);const value=String(row[1]).trim().toLowerCase();demand(['да','нет','true','false','1','0'].includes(value),'INVALID_DIRECTORY_ACTIVITY');const active=['да','true','1'].includes(value);
    demand(!directory.has(name)||directory.get(name).active===active,'DIRECTORY_ACTIVITY_CONFLICT');directory.set(name,{active,raw:row});
  });
  for(const[index,row]of schedule.entries())if(row.some(v=>!blank(v)))check(`schedule:${index+2}`,()=>{
    const rawName=cleanName(row[0]),name=managerName(rawName),date=parseDate(row[1]),time=parseTime(row[2]);demand(time.endsWith(':00')&&time>='10:00'&&time<='21:00','UNSUPPORTED_SLOT_HOUR');
    const key=canonical([name,date,time]),hour=calendar.get(key)||{manager:name,date,time,sourceNames:[],raw:[]};
    if(!hour.sourceNames.includes(rawName))hour.sourceNames.push(rawName);hour.raw.push({row:index+2,values:row});calendar.set(key,hour);rows.push(hour);
    pairs.set(canonical([rawName,date]),{manager:rawName,date});
  });
  const csv=input?.rubitime?.csv||[],api=input?.rubitime?.api||[];const apiMap=new Map();
  check('rubitime',()=>demand(Array.isArray(csv)&&Array.isArray(api),'INVALID_RUBITIME_SOURCE'));
  for(const[index,row]of (Array.isArray(api)?api:[]).entries())check(`rubitime.api:${index+1}`,()=>{const id=String(row.id);demand(row.id!=null&&!apiMap.has(id),'DUPLICATE_SOURCE_IDENTITY');apiMap.set(id,row);});
  const seenApi=new Set();
  for(const[index,row]of (Array.isArray(csv)?csv:[]).entries())check(`rubitime.csv:${index+1}`,()=>{
    const rawApi=apiMap.get(String(row.rubitimeId));demand(rawApi,'RUBITIME_API_RECORD_MISSING');seenApi.add(String(row.rubitimeId));
    demand(rawApi.status===0&&row.rawStatusTitle==='Записан'&&rawApi.status_title==='Записан','RUBITIME_STATUS_UNSUPPORTED');
    demand(row.timezone==='Europe/Moscow'&&Number(row.durationMinutes)===60&&Number(rawApi.duration)===60,'UNSUPPORTED_DURATION_OR_TIMEZONE');
    demand(timestamp(row.startLocal)===timestamp(rawApi.record),'RUBITIME_DATETIME_MISMATCH');
    const local=row.startLocal.replace(' ','T');
    const boolean=value=>{demand(['Да','Нет','',null,undefined].includes(value),'INVALID_BOOLEAN');return value==='Да'?true:value==='Нет'?false:null;};
    const childAge=typeof row.childAge==='string'&&/^\d{1,2}$/.test(row.childAge.trim())?Number(row.childAge.trim()):row.childAge;
    records.push(normalizeRecord({sourceIdentity:{source:'rubitime',id:row.rubitimeId},date:local.slice(0,10),time:local.slice(11,16),age:childAge,
      studentName:row.childName,parentName:row.parentName,phone:row.phone,hasPc:boolean(row.hasComputerRaw),parentPresent:boolean(row.parentAttendingRaw),comment:row.comment||row.clientComment||'',managerName:row.employeeName,
      createdAt:rawApi.created_at||row.createdLocal,updatedAt:rawApi.updated_at||rawApi.created_at||row.createdLocal,raw:{csv:row,api:rawApi}},at,capturedAt));
  });
  for(const id of apiMap.keys())if(!seenApi.has(id))issues.push({code:'RUBITIME_CSV_RECORD_MISSING',location:'rubitime.api'});
  check('records',()=>demand(input?.records===undefined||Array.isArray(input.records),'INVALID_RECORDS'));
  for(const[index,record]of (Array.isArray(input?.records)?input.records:[]).entries())check(`records:${index+1}`,()=>records.push(normalizeRecord(record,at,capturedAt)));
  const identities=new Set();for(const record of records){const identity=canonical([record.source,record.sourceId]);if(identities.has(identity))issues.push({code:'DUPLICATE_SOURCE_IDENTITY',location:'records'});identities.add(identity);}
  const facts={schedule:snapshot?.sheet?.schedule,managers:snapshot?.sheet?.managers,rubitime:input?.rubitime,records:input?.records||[],newFutureReserveCapacity,...(Array.isArray(existingRecordEvidence)&&existingRecordEvidence.length?{existingRecordEvidence}: {})};
  return{issues,directory,hours:[...calendar.values()],pairs:[...pairs.values()],records,sourceFingerprint:hash(facts),raw:facts,counts:{sourceRows:rows.length,canonicalPrimaryHours:calendar.size,aliasDuplicateHours:rows.length-calendar.size,managerDays:new Set([...calendar.values()].map(h=>canonical([h.manager,h.date]))).size,records:records.length,historyRecords:records.filter(r=>r.historyOnly).length}};
}
async function readState(tx){
  const users=(await tx.query('SELECT id,email,name,role,active,age_groups FROM eduson_booking.users ORDER BY id')).rows;
  const schedules=(await tx.query('SELECT * FROM eduson_booking.schedules ORDER BY manager_id,date')).rows;
  const bookings=(await tx.query('SELECT id,date,time,phone,crm_url,version,state,assigned_to,assignment_kind,history_only FROM eduson_booking.bookings ORDER BY id')).rows;
  const projection=(await tx.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0]||null;
  const present=(await tx.query("SELECT to_regclass('eduson_booking.migration_v3_runs') name")).rows[0].name;
  const runs=present?(await tx.query('SELECT source_fingerprint FROM eduson_booking.migration_v3_runs')).rows:[];
  const sources=present?(await tx.query('SELECT source,source_id,booking_id,fingerprint FROM eduson_booking.migration_v3_sources ORDER BY source,source_id')).rows:[];
  const fingerprint=hash({users,schedules,bookings,projection:projection?{version:projection.version,previous_payload:projection.previous_payload}:null,sources});
  return{users,schedules,bookings,projection,runs,sources,fingerprint};
}
function mergedIntervals(old,hours,reserveAt){
  const map=new Map();
  for(const interval of old?.intervals||[]){const start=minute(interval.start),end=minute(interval.end);demand(start%60===0&&end%60===0&&end>start,'NON_HOURLY_TARGET_SCHEDULE');for(let n=start;n<end;n+=60)map.set(hhmm(n),interval.reserveCapacity??old.reserve_capacity);}
  for(const hour of hours)if(!map.has(hour.time))map.set(hour.time,reserveAt(hour));
  const intervals=[];for(const[time,reserveCapacity]of [...map].sort(([a],[b])=>a.localeCompare(b))){const previous=intervals.at(-1),end=hhmm(minute(time)+60);if(previous?.end===time&&previous.reserveCapacity===reserveCapacity)previous.end=end;else intervals.push({start:time,end,reserveCapacity});}
  return intervals;
}
function databasePlan(plan,state,{at,newFutureReserveCapacity,existingRecordEvidence}){
  const issues=[...plan.issues],staff=[],days=[],recordChanges=[],adoptions=[],staffMap=new Map(),evidenceByIdentity=new Map();
  if(!Array.isArray(existingRecordEvidence))issues.push({code:'INVALID_ADOPTION_EVIDENCE',location:'existingRecordEvidence'});
  for(const [index,item]of (Array.isArray(existingRecordEvidence)?existingRecordEvidence:[]).entries()){
    try{
      const identity=item?.sourceIdentity;demand(identity&&typeof identity.source==='string'&&/^[a-z][a-z0-9_-]{0,39}$/.test(identity.source)&&['string','number'].includes(typeof identity.id)&&String(identity.id).length>0&&String(identity.id).length<=128,'INVALID_SOURCE_IDENTITY');
      const key=canonical([identity.source,String(identity.id)]);demand(!evidenceByIdentity.has(key),'DUPLICATE_ADOPTION_EVIDENCE');
      demand(typeof item.bookingId==='string'&&item.bookingId.length>0&&item.bookingId.length<=128&&Number.isInteger(item.expectedVersion)&&item.expectedVersion>0,'INVALID_ADOPTION_EVIDENCE');
      demand(item.evidence?.kind==='exact_crm_date_time'&&item.evidence.raw&&typeof item.evidence.raw==='object'&&!Array.isArray(item.evidence.raw),'INVALID_ADOPTION_EVIDENCE');
      parseDate(item.evidence.date);parseTime(item.evidence.time);demand(crm(item.evidence.crmUrl),'INVALID_ADOPTION_EVIDENCE');
      demand(plan.records.some(r=>r.source===identity.source&&r.sourceId===String(identity.id)),'ORPHAN_ADOPTION_EVIDENCE');
      evidenceByIdentity.set(key,item);
    }catch(error){issues.push({code:error.code||'INVALID_ADOPTION_EVIDENCE',location:`existingRecordEvidence:${index+1}`});}
  }
  const names=[...new Set(plan.hours.map(h=>h.manager))];
  for(const name of names){
    const matches=state.users.filter(u=>managerName(u.name)===name);
    if(matches.length>1||matches.some(u=>u.role!=='sales')){issues.push({code:'MANAGER_IDENTITY_CONFLICT',location:'users'});continue;}
    const hasFuture=plan.hours.some(h=>h.manager===name&&+new Date(`${h.date}T${h.time}:00+03:00`)+3600000>+at),directory=plan.directory.get(name);
    if(!matches.length&&hasFuture&&!directory){issues.push({code:'MANAGER_ACTIVITY_UNKNOWN',location:'users'});continue;}
    const item={name,id:matches[0]?.id||`migration-v3-sales-${hash(name).slice(0,24)}`,existing:!!matches.length,active:hasFuture&&directory?.active===true,directoryActive:directory?.active??null};
    staff.push(item);staffMap.set(name,item);
  }
  const grouped=new Map();for(const hour of plan.hours){const key=canonical([hour.manager,hour.date]);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(hour);}
  for(const hours of grouped.values()){
    const manager=staffMap.get(hours[0].manager);if(!manager)continue;
    const old=state.schedules.find(s=>s.manager_id===manager.id&&dateValue(s.date)===hours[0].date);
    try{const intervals=mergedIntervals(old,hours,h=>+new Date(`${h.date}T${h.time}:00+03:00`)+3600000>+at?newFutureReserveCapacity:0);const changed=!old||canonical(old.intervals)!==canonical(intervals);days.push({managerId:manager.id,date:hours[0].date,intervals,reserveCapacity:old?.reserve_capacity??1,changed,oldVersion:old?.version||0,hours});}
    catch(error){issues.push({code:error.code||'INVALID_TARGET_SCHEDULE',location:'schedules'});}
  }
  for(const record of plan.records){
    const evidence=evidenceByIdentity.get(canonical([record.source,record.sourceId]));
    const mapped=state.sources.find(s=>s.source===record.source&&s.source_id===record.sourceId);
    if(mapped){if(mapped.fingerprint!==record.fingerprint)issues.push({code:'SOURCE_RECORD_CHANGED',location:'records'});if(evidence&&mapped.booking_id!==evidence.bookingId)issues.push({code:'SOURCE_IDENTITY_ADOPTION_CONFLICT',location:'records'});continue;}
    if(evidence){
      const target=state.bookings.find(b=>b.id===evidence.bookingId);
      if(!target){issues.push({code:'EXISTING_BOOKING_NOT_FOUND',location:'records'});continue;}
      if(target.version!==evidence.expectedVersion){issues.push({code:'EXISTING_BOOKING_VERSION_CONFLICT',location:'records'});continue;}
      const proof=evidence.evidence,recordCrm=crmKey(record.crmUrl);
      if(!recordCrm||crmKey(target.crm_url)!==recordCrm||crmKey(proof.crmUrl)!==recordCrm||dateValue(target.date)!==record.date||proof.date!==record.date||target.time!==record.time||proof.time!==record.time){issues.push({code:'EXISTING_BOOKING_EVIDENCE_MISMATCH',location:'records'});continue;}
      adoptions.push({record,evidence});continue;
    }
    if(state.bookings.some(b=>b.id===record.id)){issues.push({code:'BOOKING_ID_COLLISION',location:'records'});continue;}
    const duplicate=state.bookings.some(b=>dateValue(b.date)===record.date&&b.time===record.time&&((record.crmUrl&&crmKey(b.crm_url)===crmKey(record.crmUrl))||(record.phone&&b.phone&&b.phone.replace(/\D/g,'')===record.phone.replace(/\D/g,''))));
    if(duplicate){issues.push({code:'EXISTING_BOOKING_EVIDENCE_REQUIRED',location:'records'});continue;}
    recordChanges.push(record);
  }
  if(state.projection?.lease_token&&state.projection.lease_until&&+new Date(state.projection.lease_until)>+at)issues.push({code:'PROJECTION_LEASE_ACTIVE',location:'sheet_projections'});
  return{issues,staff,days,records:recordChanges,adoptions,counts:{...plan.counts,createdUsers:staff.filter(s=>!s.existing).length,changedManagerDays:days.filter(d=>d.changed).length,newRecords:recordChanges.length,adoptedRecords:adoptions.length,existingSourceRecords:plan.records.length-recordChanges.length-adoptions.length}};
}

/** Private source data stays in PostgreSQL audit/identity tables; the returned preview contains only counts and codes. */
export async function migrateV3(db,input,{apply=false,expectedDatabaseFingerprint,now=()=>new Date(),newFutureReserveCapacity=1,enqueueFutureBookings=false,existingRecordEvidence=[]}={}){
  const at=new Date(typeof now==='function'?now():now);demand(Number.isFinite(+at),'INVALID_IMPORT_TIME');demand([0,1].includes(newFutureReserveCapacity),'INVALID_RESERVE_POLICY');
  demand(db&&typeof db.transaction==='function','DATABASE_REQUIRED');
  const plan=sourcePlan(input,{at,newFutureReserveCapacity,existingRecordEvidence});
  const schema=apply?await readFile(new URL('./migration-v3-schema.sql',import.meta.url),'utf8'):null;
  return db.transaction(async tx=>{
    if(apply)for(const statement of schema.split(';').map(value=>value.trim()).filter(Boolean))await tx.query(statement);
    await tx.query(`LOCK TABLE eduson_booking.bookings,eduson_booking.schedules,eduson_booking.users,eduson_booking.sheet_projections IN ${apply?'SHARE ROW EXCLUSIVE':'SHARE'} MODE`);
    const state=await readState(tx),preview=databasePlan(plan,state,{at,newFutureReserveCapacity,existingRecordEvidence});
    const summary={ok:preview.issues.length===0,applied:false,sourceFingerprint:plan.sourceFingerprint,databaseFingerprint:state.fingerprint,counts:preview.counts,issues:preview.issues};
    if(state.runs.some(run=>run.source_fingerprint===plan.sourceFingerprint))return{...summary,ok:true,issues:[],applied:apply,idempotent:true};
    if(!apply)return summary;
    demand(summary.ok,'INVALID_MIGRATION_SOURCE');demand(expectedDatabaseFingerprint===state.fingerprint,'DATABASE_SNAPSHOT_CHANGED');
    for(const staff of preview.staff){
      if(!staff.existing)await tx.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups,created_at)VALUES($1,$2,$3,\'sales\',$4,$5,\'[]\',$6)',[staff.id,`migration.${hash(staff.name).slice(0,24)}@eduson.invalid`,staff.name,await hashPassword(randomBytes(32).toString('base64url')),staff.active,at.toISOString()]);
      for(const sourceName of [...new Set(plan.hours.filter(h=>h.manager===staff.name).flatMap(h=>h.sourceNames))])await tx.query('INSERT INTO eduson_booking.migration_v3_staff(source_name,canonical_name,manager_id,directory_active,payload)VALUES($1,$2,$3,$4,$5)ON CONFLICT(source_name)DO NOTHING',[sourceName,staff.name,staff.id,staff.directoryActive,JSON.stringify({alias:MIGRATION_V3_ALIASES[sourceName]?{from:sourceName,to:staff.name,provenance:'schedule-full-audit:explicit-four-aliases'}:null,directory:plan.directory.get(staff.name)?.raw||null})]);
    }
    for(const day of preview.days){
      if(day.changed)await tx.query('INSERT INTO eduson_booking.schedules(manager_id,date,intervals,reserve_capacity,updated_at)VALUES($1,$2,$3,$4,$5)ON CONFLICT(manager_id,date)DO UPDATE SET intervals=EXCLUDED.intervals,version=eduson_booking.schedules.version+1,updated_at=EXCLUDED.updated_at',[day.managerId,day.date,JSON.stringify(day.intervals),day.reserveCapacity,at.toISOString()]);
      for(const hour of day.hours)await tx.query('INSERT INTO eduson_booking.migration_v3_schedule_hours(manager_id,date,time,source_fingerprint,payload)VALUES($1,$2,$3,$4,$5)ON CONFLICT(manager_id,date,time)DO NOTHING',[day.managerId,day.date,hour.time,plan.sourceFingerprint,JSON.stringify({sourceNames:hour.sourceNames,raw:hour.raw,newFutureReserveCapacity,historicalNewReserveCapacity:0,existingDayVersion:day.oldVersion})]);
    }
    for(const {record,evidence}of preview.adoptions){
      await tx.query('INSERT INTO eduson_booking.migration_v3_sources(source,source_id,booking_id,fingerprint,raw,imported_at)VALUES($1,$2,$3,$4,$5,$6)',[record.source,record.sourceId,evidence.bookingId,record.fingerprint,JSON.stringify(record.raw),at.toISOString()]);
      await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,\'admin\',\'migration_v3_source_adopted\',$4,$5)',[randomUUID(),evidence.bookingId,ACTOR,JSON.stringify({sourceIdentity:{source:record.source,id:record.sourceId},fingerprint:record.fingerprint,expectedVersion:evidence.expectedVersion,evidence:evidence.evidence,raw:record.raw}),at.toISOString()]);
    }
    for(const record of preview.records){
      await tx.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,comment,confirmation_due_at,created_by,idempotency_key,created_at,updated_at,history_only,is_test)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,false)`,[record.id,record.date,record.time,record.startsAt,record.endsAt,record.studentName,record.parentName,record.phone,record.crmUrl,record.age,record.hasPc,record.parentPresent,record.comment,iso(+new Date(record.startsAt)-7200000),ACTOR,`${record.source}:${record.sourceId}`,record.createdAt,record.updatedAt,record.historyOnly]);
      await tx.query('INSERT INTO eduson_booking.migration_v3_sources(source,source_id,booking_id,fingerprint,raw,imported_at)VALUES($1,$2,$3,$4,$5,$6)',[record.source,record.sourceId,record.id,record.fingerprint,JSON.stringify(record.raw),at.toISOString()]);
      await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,\'admin\',\'legacy_imported\',$4,$5)',[randomUUID(),record.id,ACTOR,JSON.stringify({source:record.source,sourceIdentity:{source:record.source,id:record.sourceId},managerName:record.managerName,elapsedUnknown:record.historyOnly,capturedAt:input.snapshot.capturedAt,fingerprint:record.fingerprint,historyOnly:record.historyOnly,raw:record.raw}),at.toISOString()]);
      if(!record.historyOnly&&enqueueFutureBookings)await tx.query('INSERT INTO eduson_booking.sync_jobs(id,booking_id,kind,version,status,created_at,updated_at)VALUES($1,$2,\'booking\',1,\'pending\',$3,$3)',[randomUUID(),record.id,at.toISOString()]);
    }
    await new BookingService({},{now:()=>at}).validateCapacity(tx);
    const previous=state.projection?.previous_payload||{},adopted=[...new Map([...(previous.attemptedManagedSchedules||[]),...plan.pairs].map(pair=>[canonical([pair.manager,pair.date]),pair])).values()];
    const payload={...previous,attemptedManagedSchedules:adopted};
    await tx.query(`INSERT INTO eduson_booking.sheet_projections(key,version,status,attempts,last_error,previous_payload,updated_at)VALUES('schedule',1,'pending',0,NULL,$1,$2)
      ON CONFLICT(key)DO UPDATE SET version=eduson_booking.sheet_projections.version+1,status='pending',attempts=0,last_error=NULL,previous_payload=EXCLUDED.previous_payload,updated_at=EXCLUDED.updated_at`,[JSON.stringify(payload),at.toISOString()]);
    await tx.query('INSERT INTO eduson_booking.migration_v3_runs(source_fingerprint,database_fingerprint,captured_at,applied_at,counts,raw)VALUES($1,$2,$3,$4,$5,$6)',[plan.sourceFingerprint,state.fingerprint,timestamp(input.snapshot.capturedAt),at.toISOString(),JSON.stringify(preview.counts),JSON.stringify(plan.raw)]);
    await tx.query('INSERT INTO eduson_booking.audit_events(id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,\'admin\',\'migration_v3_applied\',$3,$4)',[randomUUID(),ACTOR,JSON.stringify({sourceFingerprint:plan.sourceFingerprint,databaseFingerprint:state.fingerprint,counts:preview.counts,newFutureReserveCapacity,historicalNewReserveCapacity:0,aliases:MIGRATION_V3_ALIASES}),at.toISOString()]);
    return{...summary,applied:true,idempotent:false};
  });
}
