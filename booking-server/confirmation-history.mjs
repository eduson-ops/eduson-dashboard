import {recordConfirmation} from './compensation.mjs';
import {createGoogleSheetsClient} from './google-sheets-client.mjs';
import {randomUUID,createHash} from 'node:crypto';

const MOSCOW_OFFSET='+03:00';
const SYSTEM={id:'system',name:'Система',role:'admin'};

const text=value=>String(value??'').trim();
export function normalizeCrmUrl(value){
  const raw=text(value);if(!raw)return '';
  try{const url=new URL(raw);return `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/,'')}`;}catch{return '';}
}
export function parseConfirmationTimestamp(value){
  const raw=text(value);
  const match=/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if(!match)return null;
  const iso=`${match[3]}-${match[2]}-${match[1]}T${match[4].padStart(2,'0')}:${match[5]}:${match[6]||'00'}${MOSCOW_OFFSET}`;
  const instant=new Date(iso);return Number.isFinite(+instant)?instant.toISOString():null;
}
const normalizeTime=value=>{const raw=text(value);const match=/^(\d{1,2}):(\d{2})/.exec(raw);return match?`${match[1].padStart(2,'0')}:${match[2]}`:'';};
const managerWords=value=>text(value).normalize('NFC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * Matches Google Form confirmation rows without guessing a lesson date.
 * A row is causal only when CRM, hour, creation time and lesson start agree.
 */
export function matchConfirmationRows(values=[],bookings=[]){
  const rows=Array.isArray(values)?values:[];const matches=[];const issues=[];const usedBookingIds=new Set();let unmatched=0,ambiguous=0,skipped=0;
  for(let index=1;index<rows.length;index++){
    const row=rows[index]||[];if(row.every(value=>text(value)===''))continue;
    const rowNumber=index+1;const confirmedAt=parseConfirmationTimestamp(row[0]);const crm=normalizeCrmUrl(row[1]);const time=normalizeTime(row[3]);const managerName=text(row[2]);
    const issue=(code,extra={})=>issues.push({rowNumber,code,crmUrl:crm,slotTime:time,confirmedAt,managerName,payload:{source:'google-form',rowNumber,...extra}});
    if(!confirmedAt||!crm||!time){skipped++;issue('INVALID_ROW');continue;}
    const candidates=bookings.filter(booking=>normalizeCrmUrl(booking.crmUrl||booking.crm_url)===crm&&normalizeTime(booking.time)===time&&new Date(booking.createdAt||booking.created_at)<=new Date(confirmedAt)&&new Date(confirmedAt)<new Date(booking.startsAt||booking.starts_at));
    const manager=managerWords(managerName);
    const managerCandidates=candidates.filter(booking=>{const known=managerWords(booking.sourceManager||booking.managerName||booking.assignedName||booking.manager_name);return !known||known===manager;});
    if(managerCandidates.length!==1){if(managerCandidates.length>1){ambiguous++;issue('AMBIGUOUS_BOOKING_MATCH',{candidateCount:managerCandidates.length});}else{unmatched++;issue('NO_BOOKING_MATCH');}continue;}
    const booking=managerCandidates[0];if(usedBookingIds.has(String(booking.id))){ambiguous++;issue('DUPLICATE_BOOKING_MATCH',{bookingId:String(booking.id)});continue;}usedBookingIds.add(String(booking.id));matches.push({rowNumber,bookingId:String(booking.id),confirmedAt,managerName});
  }
  return{matches,issues,unmatched,ambiguous,skipped};
}

function actorWords(value){return managerWords(value);}

/** Reads the legacy confirmation form and upgrades only causally matched bookings. */
export function createConfirmationHistorySynchronizer({db,service,client,serviceAccountPath,spreadsheetId,enabled=false,fetchImpl=fetch,now=()=>new Date()}={}){
  let running=false,lastRun={unmatched:0,ambiguous:0,skipped:0};
  const reader=client||(serviceAccountPath&&spreadsheetId?createGoogleSheetsClient({serviceAccountPath,spreadsheetId,fetchImpl,now}):null);
  async function read(){return reader?reader.request("'Подтверждения'!A1:F"):({values:[]});}
  const instant=()=>new Date(typeof now==='function'?now():now);
  async function selectActor(tx){
    const rows=(await tx.query("SELECT id,name,role FROM eduson_booking.users WHERE role='confirmation' AND active=true ORDER BY name,id")).rows;
    return rows.length===1?rows[0]:rows.find(row=>actorWords(row.name)==='анна багдасарян')||rows[0]||null;
  }
  async function apply(match,bookings){
    return db.transaction(async tx=>{
      const current=await service.get(tx,match.bookingId);if(!current||current.is_test)return false;
      const actor=await selectActor(tx);if(!actor)return false;
      const existingConfirmation=(await tx.query('SELECT booking_id FROM eduson_booking.booking_confirmations WHERE booking_id=$1',[match.bookingId])).rows.length>0;
      if(current.confirmation_status==='confirmed'&&existingConfirmation)return false;
      const at=instant();const changes={confirmation_status:'confirmed',confirmed_at:match.confirmedAt};
      if(current.confirmation_status!=='confirmed'&&current.state==='scheduled'&&!current.history_only&&new Date(current.starts_at)>at){
        const assigned=await service.assignment(tx,current);changes.assigned_to=assigned.managerId;changes.assignment_kind=assigned.kind;changes.capacity_hold=false;
      }
      const next=current.confirmation_status==='confirmed'?current:await service.change(tx,current,changes);
      await recordConfirmation(tx,{booking:next,actor,at:match.confirmedAt,source:'google-form',project:false,evidence:{sheetRow:match.rowNumber,managerName:match.managerName}});
      if(current.confirmation_status!=='confirmed')await service.record(tx,actor,next,'confirmed',{source:'google-form',sheetRow:match.rowNumber,managerName:match.managerName});
      else await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),next.id,actor.id,actor.role,'confirmation_history_linked',JSON.stringify({source:'google-form',sheetRow:match.rowNumber,managerName:match.managerName,confirmedAt:match.confirmedAt}),at.toISOString()]);
      return true;
    });
  }
  const fingerprint=issue=>createHash('sha256').update(JSON.stringify([issue.rowNumber,issue.code,issue.crmUrl,issue.slotTime,issue.confirmedAt,issue.managerName,issue.payload])).digest('hex');
  async function persistIssues(issues,{resolved=[]}={}){
    const at=instant().toISOString();
    await db.transaction(async tx=>{
      for(const issue of issues){
        const id=randomUUID(),hash=fingerprint(issue);
        await tx.query(`INSERT INTO eduson_booking.confirmation_history_issues(id,sheet_row,fingerprint,code,crm_url,slot_time,confirmed_at,manager_name,payload,attempts,status,last_error,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'open',NULL,$10,$10)
          ON CONFLICT(sheet_row,fingerprint) DO UPDATE SET code=EXCLUDED.code,crm_url=EXCLUDED.crm_url,slot_time=EXCLUDED.slot_time,confirmed_at=EXCLUDED.confirmed_at,manager_name=EXCLUDED.manager_name,payload=EXCLUDED.payload,attempts=confirmation_history_issues.attempts+1,status='open',last_error=NULL,updated_at=EXCLUDED.updated_at,resolved_at=NULL`,[id,issue.rowNumber,hash,issue.code,issue.crmUrl,issue.slotTime,issue.confirmedAt,issue.managerName,JSON.stringify(issue.payload),at]);
      }
      for(const match of resolved)await tx.query("UPDATE eduson_booking.confirmation_history_issues SET status='resolved',booking_id=$2,resolved_at=$3,updated_at=$3 WHERE sheet_row=$1 AND status='open'",[match.rowNumber,match.bookingId,at]);
    });
  }
  async function runOnce(){
    if(!enabled)return{processed:0,matched:0,ambiguous:0,unmatched:0,skipped:0,reason:'disabled'};
    if(running)return{processed:0,matched:0,ambiguous:0,unmatched:0,skipped:0,reason:'busy'};
    running=true;
    try{
      const values=(await read()).values||[];const bookings=await service.listBookings(SYSTEM,{scope:'all'});const result=matchConfirmationRows(values,bookings);let applied=0;const resolved=[];
      for(const match of result.matches)try{if(await apply(match,bookings)){applied++;resolved.push(match);}}catch(error){result.unmatched++;result.issues.push({...match,code:'APPLY_ERROR',crmUrl:normalizeCrmUrl(bookings.find(row=>row.id===match.bookingId)?.crmUrl),slotTime:normalizeTime(bookings.find(row=>row.id===match.bookingId)?.time),payload:{source:'google-form',rowNumber:match.rowNumber,bookingId:match.bookingId},lastError:/^[A-Z0-9_]{2,40}$/.test(error?.code||'')?error.code:'APPLY_ERROR'});}
      await persistIssues(result.issues,{resolved});lastRun={unmatched:result.unmatched,ambiguous:result.ambiguous,skipped:result.skipped};
      return{processed:applied,matched:applied,ambiguous:result.ambiguous,unmatched:result.unmatched,skipped:result.skipped};
    }finally{running=false;}
  }
  async function status(){const rows=(await db.query("SELECT status,count(*)::int AS n FROM eduson_booking.confirmation_history_issues GROUP BY status")).rows;const counts=Object.fromEntries(rows.map(row=>[row.status,Number(row.n)]));return{open:counts.open||0,resolved:counts.resolved||0,lastRun};}
  return{runOnce,status};
}
