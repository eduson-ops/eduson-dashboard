import {randomUUID} from 'node:crypto';

const stages={created:'Назначено время занятия',confirmed:'Занятие подтверждено',cancelled:'Занятие отменилось/перенеслось',completed:'Занятие проведено',paid:'Успешно реализовано'};
const eventFor={created:'booking.created',confirmed:'booking.confirmed',cancelled:'booking.cancelled',completed:'booking.completed',paid:'booking.paid'};
export function createAmoCrmStageSync({db,endpoint,token,fetchImpl=fetch,now=()=>new Date(),enabled=Boolean(endpoint&&token)}={}){
  async function enqueue(tx,{booking,event,action,reason=null}){
    if(!enabled||!booking?.crm_url)return null;
    const eventId=`${booking.id}:${booking.version}:${action}`;
    const payload={event_id:eventId,event:eventFor[action],occurred_at:new Date(now()).toISOString(),booking_id:booking.id,crm_lead_id:String((booking.crm_url.match(/\/leads\/detail\/(\d+)/)||[])[1]||''),crm_url:booking.crm_url,stage:stages[action],lesson:{date:String(booking.date).slice(0,10),time:booking.time,timezone:'Europe/Moscow',starts_at:new Date(booking.starts_at).toISOString(),duration_minutes:60,booking_url:process.env.BOOKING_PUBLIC_URL||'',recording_url:booking.report_payload?.recordingUrl||null},reason,source:'eduson-booking'};
    await tx.query(`INSERT INTO eduson_booking.amocrm_stage_jobs(id,event_id,booking_id,event,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(event_id) DO NOTHING`,[randomUUID(),eventId,booking.id,eventFor[action],JSON.stringify(payload),new Date(now()).toISOString()]);
    return eventId;
  }
  async function runOnce(){
    if(!enabled)return {processed:0,disabled:true};
    const at=new Date(now()), stale=new Date(+at-120000), backoff="(LEAST(3600000,5000*POWER(2,GREATEST(0,attempts-1)))*interval '1 millisecond')";
    const rows=(await db.query(`UPDATE eduson_booking.amocrm_stage_jobs SET status='processing',attempts=attempts+1,lease_until=$2,updated_at=$1 WHERE id=(SELECT id FROM eduson_booking.amocrm_stage_jobs WHERE attempts<8 AND (status='pending' OR (status='processing' AND lease_until<=$1) OR (status='error' AND updated_at<=$1-${backoff})) ORDER BY created_at,id LIMIT 1) RETURNING *`,[at.toISOString(),new Date(+at+120000).toISOString()])).rows;
    if(!rows.length)return {processed:0}; const job=rows[0];
    try{const response=await fetchImpl(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':job.event_id},body:JSON.stringify(job.payload)});if(!response.ok)throw Error(`HTTP_${response.status}`);await db.query("UPDATE eduson_booking.amocrm_stage_jobs SET status='done',last_error=NULL,updated_at=$2 WHERE id=$1",[job.id,new Date(now()).toISOString()]);return{processed:1,done:1};}
    catch(error){await db.query("UPDATE eduson_booking.amocrm_stage_jobs SET status='error',last_error=$2,lease_until=NULL,updated_at=$3 WHERE id=$1",[job.id,String(error.message||'AMOCRM_DELIVERY_FAILED').slice(0,200),new Date(now()).toISOString()]);return{processed:1,error:1};}
  }
  return {enqueue,runOnce,status:async()=> (await db.query("SELECT count(*) FILTER(WHERE status IN ('pending','processing'))::int pending,count(*) FILTER(WHERE status='error')::int error FROM eduson_booking.amocrm_stage_jobs")).rows[0]};
}
