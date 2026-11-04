import {recordConfirmation} from './compensation.mjs';
import {createGoogleSheetsClient} from './google-sheets-client.mjs';
import {randomUUID} from 'node:crypto';

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
const managerWords=value=>text(value).toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu,' ' ).trim();

/**
 * Matches Google Form confirmation rows without guessing a lesson date.
 * A row is causal only when CRM, hour, creation time and lesson start agree.
 */
export function matchConfirmationRows(values=[],bookings=[]){
  const rows=Array.isArray(values)?values:[];const matches=[];const usedBookingIds=new Set();let unmatched=0,ambiguous=0,skipped=0;
  for(let index=1;index<rows.length;index++){
    const row=rows[index]||[];if(row.every(value=>text(value)===''))continue;
    const confirmedAt=parseConfirmationTimestamp(row[0]);const crm=normalizeCrmUrl(row[1]);const time=normalizeTime(row[3]);
    if(!confirmedAt||!crm||!time){skipped++;continue;}
    const candidates=bookings.filter(booking=>normalizeCrmUrl(booking.crmUrl||booking.crm_url)===crm&&normalizeTime(booking.time)===time&&new Date(booking.createdAt||booking.created_at)<=new Date(confirmedAt)&&new Date(confirmedAt)<new Date(booking.startsAt||booking.starts_at));
    const manager=managerWords(row[2]);
    const managerCandidates=candidates.filter(booking=>{const known=managerWords(booking.sourceManager||booking.managerName||booking.assignedName||booking.manager_name);return !known||known===manager;});
    if(managerCandidates.length!==1){if(managerCandidates.length>1)ambiguous++;else unmatched++;continue;}
    const booking=managerCandidates[0];if(usedBookingIds.has(String(booking.id))){ambiguous++;continue;}usedBookingIds.add(String(booking.id));matches.push({rowNumber:index+1,bookingId:String(booking.id),confirmedAt,managerName:text(row[2])});
  }
  return{matches,unmatched,ambiguous,skipped};
}

function actorWords(value){return managerWords(value);}

/** Reads the legacy confirmation form and upgrades only causally matched bookings. */
export function createConfirmationHistorySynchronizer({db,service,client,serviceAccountPath,spreadsheetId,enabled=false,fetchImpl=fetch,now=()=>new Date()}={}){
  let running=false;
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
  async function runOnce(){
    if(!enabled)return{processed:0,matched:0,ambiguous:0,unmatched:0,skipped:0,reason:'disabled'};
    if(running)return{processed:0,matched:0,ambiguous:0,unmatched:0,skipped:0,reason:'busy'};
    running=true;
    try{
      const values=(await read()).values||[];const bookings=await service.listBookings(SYSTEM,{scope:'all'});const result=matchConfirmationRows(values,bookings);let applied=0;
      for(const match of result.matches)try{if(await apply(match,bookings))applied++;}catch{result.unmatched++;}
      return{processed:applied,matched:applied,ambiguous:result.ambiguous,unmatched:result.unmatched,skipped:result.skipped};
    }finally{running=false;}
  }
  return{runOnce};
}
