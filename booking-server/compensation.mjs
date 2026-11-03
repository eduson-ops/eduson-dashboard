import {enqueueOperationalJob} from './operational-reports.mjs';
const RATES={confirmation:100,attendance:200};
const fault=(status,message)=>Object.assign(new Error(message),{status});
const date=value=>{const parsed=new Date(value+'T00:00Z');if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==value)throw fault(400,'Укажите существующую дату периода.');return value;};
const iso=value=>value==null?null:new Date(value).toISOString();
export async function recordConfirmation(tx,{booking,actor,at,source='booking',project=true,evidence={}}){
  if(booking.is_test)return;
  const instant=iso(at||booking.confirmed_at||new Date());
  const inserted=await tx.query(`INSERT INTO eduson_booking.booking_confirmations(booking_id,actor_id,actor_name,actor_role,confirmed_at,source,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(booking_id) DO NOTHING RETURNING booking_id`,[booking.id,actor.id,actor.name||actor.id,actor.role,instant,source,JSON.stringify(evidence)]);
  if(!inserted.rows.length)return;
  if(actor.role==='confirmation')await tx.query(`INSERT INTO eduson_booking.compensation_events(booking_id,manager_id,kind,amount,event_at,source) VALUES($1,$2,'confirmation',$3,$4,$5) ON CONFLICT(booking_id,kind) DO NOTHING`,[booking.id,actor.id,RATES.confirmation,instant,source]);
  if(project)await enqueueOperationalJob(tx,{kind:'confirmation',entityId:booking.id,version:booking.version||1,now:new Date(instant)});
}
export async function recordAttendance(tx,{booking,at,source='booking'}){
  if(booking.is_test)return;
  await tx.query(`INSERT INTO eduson_booking.compensation_events(booking_id,manager_id,kind,amount,event_at,source) SELECT booking_id,actor_id,'attendance',$2,$3,$4 FROM eduson_booking.booking_confirmations WHERE booking_id=$1 AND actor_role='confirmation' ON CONFLICT(booking_id,kind) DO NOTHING`,[booking.id,RATES.attendance,iso(at||booking.completed_at||new Date()),source]);
}
export async function getConfirmation(db,id){
  const r=(await db.query(`SELECT c.*,b.crm_url,b.time,b.version,u.name manager_name FROM eduson_booking.booking_confirmations c JOIN eduson_booking.bookings b ON b.id=c.booking_id LEFT JOIN eduson_booking.users u ON u.id=b.assigned_to WHERE c.booking_id=$1`,[id])).rows[0];
  return r?{bookingId:r.booking_id,confirmedAt:iso(r.confirmed_at),crmUrl:r.crm_url,managerName:r.manager_name||r.payload.managerName||'',time:r.time,actorName:r.actor_name,version:r.version}:null;
}
export class CompensationService{
  constructor(db,{now=()=>new Date()}={}){this.db=db;this.now=now;}
  async get(actor,filters={}){
    if(!actor?.id||!['admin','confirmation'].includes(actor.role)||actor.active===false)throw fault(403,'Начисления доступны подтверждению и администратору.');
    if(actor.role==='confirmation'&&filters.managerId&&filters.managerId!==actor.id)throw fault(403,'Доступны только свои начисления.');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());
    const from=date(filters.from||today.slice(0,7)+'-01');
    const last=new Date(from+'T12:00Z');last.setUTCMonth(last.getUTCMonth()+1,0);
    const to=date(filters.to||last.toISOString().slice(0,10));
    if(to<from||+new Date(to)-+new Date(from)>366*86400000)throw fault(400,'Период начислений должен быть не длиннее года.');
    const managerId=actor.role==='confirmation'?actor.id:filters.managerId||null;
    const values=[from+'T00:00:00+03:00',new Date(+new Date(to+'T00:00:00+03:00')+86400000),managerId];
    const events=(await this.db.query(`SELECT e.*,u.name manager_name,b.date,b.time,b.student_name,b.confirmed_at,b.completed_at FROM eduson_booking.compensation_events e JOIN eduson_booking.users u ON u.id=e.manager_id JOIN eduson_booking.bookings b ON b.id=e.booking_id WHERE e.event_at>=$1 AND e.event_at<$2 AND ($3::text IS NULL OR e.manager_id=$3) AND NOT b.is_test ORDER BY b.date,b.time,b.id,e.kind`,values)).rows;
    const managers=(await this.db.query(`SELECT id,name FROM eduson_booking.users WHERE (role='confirmation' OR id IN (SELECT manager_id FROM eduson_booking.compensation_events)) AND ($1::text IS NULL OR id=$1) ORDER BY name`,[managerId])).rows;
    const rows=new Map(managers.map(m=>[m.id,{managerId:m.id,managerName:m.name,confirmedCount:0,attendedCount:0,confirmationAmount:0,attendanceAmount:0,total:0}]));
    const detail=new Map();
    for(const event of events){
      const row=rows.get(event.manager_id);const key=event.booking_id;const component=event.kind==='confirmation'?'confirmationAmount':'attendanceAmount';const count=event.kind==='confirmation'?'confirmedCount':'attendedCount';const amount=Number(event.amount);
      row[component]+=amount;row[count]++;row.total+=amount;
      if(!detail.has(key))detail.set(key,{bookingId:key,managerId:event.manager_id,managerName:event.manager_name,date:typeof event.date==='string'?event.date.slice(0,10):new Date(event.date).toISOString().slice(0,10),time:event.time,studentName:event.student_name,confirmedAt:iso(event.confirmed_at),completedAt:iso(event.completed_at),confirmationAmount:0,attendanceAmount:0,total:0});
      const item=detail.get(key);item[component]+=amount;item.total+=amount;
    }
    return{rates:RATES,from,to,rows:[...rows.values()],bookings:[...detail.values()],total:[...rows.values()].reduce((sum,row)=>sum+row.total,0)};
  }
}
