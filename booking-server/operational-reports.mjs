import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createGoogleSheetsClient,SheetSyncError,safeSheetSyncError,normalizeSheetHeader} from './google-sheets-client.mjs';

const SCHEMA=new URL('./operational-schema.sql',import.meta.url);
const KINDS=new Set(['confirmation','payment','enrollment']);
const MAX_ATTEMPTS=8,LEASE_MS=5*60_000;
const ENROLLMENT_ID='12YC54i8r4tdo8PqH764RfUpGzdJF0xYyj3GJ-7NBrNw';
const ENROLLMENT_TAB='Реестр учеников Eduson - вводный урок';
const PAYMENT_HEADERS=['Отметка времени','Кто провёл урок','Ссылка на CRM','Дата оплаты','Практика','Пакет','Способ оплаты','Сумма оплаты','Ссылка на запись урока'];
const CONFIRMATION_HEADERS=['Отметка времени','Вставь АМО','Кто МИМК?','Во сколько слот?'];
const ENROLLMENT_HEADERS=['','Ссылка на амо','Добавление в ВК','Дата УР','Сумма платежа','Оплачено занятий','Дополнительно занятий','Проведено занятий','Проведено дополнительных занятий','Формат','Продукт','Возраст','Кол-во мес','Часовой','Имя родителя','Телефон родителя','ТГ родителя','ФИО ребенка','ТГ ребенка','Телефон ребенка','Почта ребенка','Дата и время от родителя','Дата вводного урока','Время вводного урока','Назначить преподавателя вводного урока','Написали родителю','Провести вводный урок','Response ID Тайпформ','Слоты из анкеты в понедельник','Слоты из анкеты во вторник','Слоты из анкеты в среду','Слоты из анкеты в четверг','Слоты из анкеты в пятницу','Слоты из анкеты в субботу','Слоты из анкеты в воскресенье','Назначена группа','Группа','Время занятий','','','Дата первого урока курса','Основной преподаватель','Комментарий по спец. условиям'];
const TARGETS={
  confirmation:{sheetId:1338934770,tab:'Подтверждения',headers:CONFIRMATION_HEADERS,last:'F',idColumn:'E',extras:['Booking ID','Кто подтвердил']},
  payment:{sheetId:1367593612,tab:'Оплаты',headers:PAYMENT_HEADERS,last:'K',idColumn:'J',extras:['Payment ID','Booking ID'],immutable:true},
  enrollment:{sheetId:0,tab:ENROLLMENT_TAB,headers:ENROLLMENT_HEADERS,last:'AS',idColumn:'AR',extras:['Payment ID','Booking ID'],immutable:true},
};

const fault=(status,message,code='VALIDATION')=>Object.assign(new Error(message),{status,code});
const demand=(condition,status,message,code)=>{if(!condition)throw fault(status,message,code);};
const authorized=actor=>demand(actor?.id&&['admin','sales'].includes(actor.role)&&actor.active!==false,403,'Оплаты доступны администратору и менеджеру продаж.','FORBIDDEN');
function text(value,label,{required=false,max=2000}={}){
  demand(value==null||typeof value==='string',400,`${label}: требуется текст.`);
  const result=(value||'').trim();demand(!required||result,400,`Заполните поле «${label}».`);demand(result.length<=max,400,`${label}: слишком длинное значение.`);return result;
}
function integer(value,label,{min=0,max=10000,optional=false,fallback}={}){
  if(value===undefined||value===null||value===''){if(optional)return null;if(fallback!==undefined)return fallback;}
  demand(Number.isSafeInteger(value)&&value>=min&&value<=max,400,`${label}: укажите целое число от ${min} до ${max}.`);return value;
}
function date(value,label,{required=true}={}){
  const result=text(value,label,{required,max:10});if(!result)return '';
  const parsed=new Date(result+'T00:00:00Z');demand(/^\d{4}-\d{2}-\d{2}$/.test(result)&&Number.isFinite(+parsed)&&parsed.toISOString().slice(0,10)===result,400,`${label}: укажите существующую дату.`);return result;
}
function phone(value,label,{required=true}={}){const result=text(value,label,{required,max:40});if(result)demand(result.replace(/\D/g,'').length>=10&&result.replace(/\D/g,'').length<=15,400,`${label}: требуется от 10 до 15 цифр.`);return result;}
function url(value,label,{required=false,crm=false}={}){
  const result=text(value,label,{required,max:2048});if(!result)return '';
  let parsed;try{parsed=new URL(result);}catch{throw fault(400,`${label}: укажите корректную ссылку.`);}
  demand(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password,400,`${label}: укажите ссылку HTTP или HTTPS.`);
  if(crm)demand(parsed.protocol==='https:'&&parsed.hostname.endsWith('.amocrm.ru')&&parsed.hostname.length>'.amocrm.ru'.length&&parsed.pathname.length>1&&/^https:\/\/[^\s/]+\.amocrm\.ru\/\S+$/i.test(result)&&!result.includes('\\'),400,'Укажите ссылку HTTPS на сделку AmoCRM.');
  return result;
}
function normalizedInput(input){
  demand(input&&typeof input==='object'&&!Array.isArray(input),400,'Ожидаются данные оплаты.');
  const result={idempotencyKey:text(input.idempotencyKey,'Ключ повторного сохранения',{required:true,max:200}),bookingId:text(input.bookingId,'Запись',{max:128})||null,managerId:text(input.managerId,'Менеджер',{max:128})||null,
    paidAt:date(input.paidAt,'Дата оплаты'),amountNet:integer(input.amountNet,'Сумма оплаты',{min:1,max:1_000_000_000}),crmUrl:url(input.crmUrl,'CRM',{required:true,crm:true}),
    practice:text(input.practice,'Практика',{required:true,max:200}),package:text(input.package,'Пакет',{required:true,max:200}),paymentMethod:text(input.paymentMethod,'Способ оплаты',{required:true,max:200}),recordingUrl:url(input.recordingUrl,'Запись урока'),
    studentName:text(input.studentName,'Имя ученика',{required:true,max:200}),parentName:text(input.parentName,'Имя родителя',{required:true,max:200}),phone:phone(input.phone,'Телефон родителя'),age:integer(input.age,'Возраст',{min:1,max:18}),paidLessons:integer(input.paidLessons,'Оплачено занятий',{min:1}),bonusLessons:integer(input.bonusLessons,'Дополнительные занятия',{fallback:0}),
    format:text(input.format,'Формат',{required:true,max:100}),product:text(input.product,'Продукт',{max:200})||text(input.practice,'Практика',{required:true,max:200}),months:integer(input.months,'Количество месяцев',{min:1,max:60,optional:true}),timezone:text(input.timezone,'Часовой пояс',{max:100})||'Europe/Moscow',
    registryDate:date(input.registryDate,'Дата УР',{required:false}),parentTelegram:text(input.parentTelegram,'ТГ родителя',{max:200}),studentTelegram:text(input.studentTelegram,'ТГ ученика',{max:200}),studentPhone:phone(input.studentPhone,'Телефон ученика',{required:false}),studentEmail:text(input.studentEmail,'Почта ученика',{max:254}),parentAvailability:text(input.parentAvailability,'Дата и время от родителя',{max:2000}),
    introDate:date(input.introDate,'Дата вводного урока',{required:false}),introTime:text(input.introTime,'Время вводного урока',{max:5}),introTeacher:text(input.introTeacher,'Преподаватель вводного урока',{max:200}),courseStartDate:date(input.courseStartDate,'Дата первого урока курса',{required:false}),mainTeacher:text(input.mainTeacher,'Основной преподаватель',{max:200}),specialConditions:text(input.specialConditions,'Специальные условия',{max:4000}),weekAvailability:{}};
  if(result.studentEmail)demand(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.studentEmail),400,'Укажите корректную почту ученика.');
  if(result.introTime)demand(/^([01]\d|2[0-3]):[0-5]\d$/.test(result.introTime),400,'Время вводного урока: укажите ЧЧ:ММ.');
  demand(input.weekAvailability===undefined||input.weekAvailability&&typeof input.weekAvailability==='object'&&!Array.isArray(input.weekAvailability),400,'Укажите доступное время по дням недели.');
  for(const day of ['mon','tue','wed','thu','fri','sat','sun'])result.weekAvailability[day]=text(input.weekAvailability?.[day],`Время ${day}`,{max:800});
  return result;
}
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const publicPayment=row=>row?{...row.payload,id:row.id,bookingId:row.booking_id,managerId:row.manager_id,createdBy:row.created_by,version:row.version,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()}:null;

export async function initializeOperationalSchema(db){
  // Both adapters accept single statements. The owned schema contains plain DDL only.
  for(const statement of (await readFile(SCHEMA,'utf8')).split(';').map(item=>item.trim()).filter(Boolean))await db.query(statement);
}

/** Inserts into the caller's existing transaction, so a business fact and its projection commit together. */
export async function enqueueOperationalJob(tx,{kind,entityId,version,payload={},now=new Date()}={}){
  demand(KINDS.has(kind)&&typeof entityId==='string'&&entityId.length>0&&entityId.length<=128&&Number.isInteger(version)&&version>0,400,'Некорректное задание отчётности.','OPERATION_INVALID');
  const result=await tx.query(`INSERT INTO eduson_booking.operation_jobs(id,kind,entity_id,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(kind,entity_id,version) DO NOTHING RETURNING id`,[randomUUID(),kind,entityId,version,JSON.stringify(payload),now]);
  return result.rows[0]?.id||null;
}

export class OperationalPaymentService{
  constructor(db,{now=()=>new Date()}={}){this.db=db;this.now=now;}
  async createPayment(actor,input){
    authorized(actor);const normalized=normalizedInput(input);
    if(actor.role==='sales')demand(!normalized.managerId||normalized.managerId===actor.id,403,'Нельзя оформить оплату на другого менеджера.','FORBIDDEN');
    const fingerprint=createHash('sha256').update(canonical(normalized)).digest('hex');
    return this.db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.bookings,eduson_booking.schedules,eduson_booking.users IN SHARE ROW EXCLUSIVE MODE');
      await tx.query('LOCK TABLE eduson_booking.payments IN SHARE ROW EXCLUSIVE MODE');
      const actualActor=(await tx.query('SELECT id,role,active FROM eduson_booking.users WHERE id=$1',[actor.id])).rows[0];
      demand(actualActor?.active&&actualActor.role===actor.role,403,'Доступ сотрудника изменился. Войдите ещё раз.','FORBIDDEN');
      const existing=(await tx.query('SELECT * FROM eduson_booking.payments WHERE created_by=$1 AND idempotency_key=$2',[actor.id,normalized.idempotencyKey])).rows[0];
      if(existing){demand(existing.input_fingerprint===fingerprint,409,'Этот ключ уже использован для другой оплаты.','IDEMPOTENCY_CONFLICT');return publicPayment(existing);}
      let booking=null;
      if(normalized.bookingId){booking=(await tx.query('SELECT * FROM eduson_booking.bookings WHERE id=$1',[normalized.bookingId])).rows[0];demand(booking,404,'Запись не найдена.','BOOKING_NOT_FOUND');demand(!booking.is_test,409,'Тестовый урок не создаёт реальную оплату или зачисление.','TEST_PAYMENT_FORBIDDEN');if(actor.role==='sales')demand(booking.assigned_to===actor.id,403,'Оплата доступна только ответственному менеджеру.','FORBIDDEN');}
      const managerId=actor.role==='sales'?actor.id:normalized.managerId||booking?.assigned_to;
      demand(managerId,400,'Выберите менеджера продажи.');
      const manager=(await tx.query('SELECT id,name,role,active FROM eduson_booking.users WHERE id=$1',[managerId])).rows[0];
      demand(manager?.role==='sales'&&manager.active,400,'Выберите действующего менеджера продаж.');
      const {idempotencyKey,managerId:ignored,...facts}=normalized;
      const payload={...facts,managerName:manager.name,currency:'RUB'};const id=randomUUID(),at=new Date(this.now());
      const inserted=await tx.query('INSERT INTO eduson_booking.payments(id,booking_id,manager_id,created_by,idempotency_key,input_fingerprint,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',[id,normalized.bookingId,managerId,actor.id,idempotencyKey,fingerprint,JSON.stringify(payload),at]);
      for(const kind of ['payment','enrollment'])await enqueueOperationalJob(tx,{kind,entityId:id,version:1,now:at});
      await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),normalized.bookingId,actor.id,actor.role,'payment_recorded',JSON.stringify({paymentId:id,amountNet:normalized.amountNet,managerId,currency:'RUB'}),at]);
      return publicPayment(inserted.rows[0]);
    });
  }
  async listPayments(actor,filters={}){
    authorized(actor);const clauses=[],values=[];
    const add=(sql,value)=>{values.push(value);clauses.push(sql.replace('?',`$${values.length}`));};
    if(actor.role==='sales')add('manager_id=?',actor.id);else if(filters.managerId)add('manager_id=?',text(filters.managerId,'Менеджер',{required:true,max:128}));
    if(filters.from)add("payload->>'paidAt'>=?",date(filters.from,'Дата от'));
    if(filters.to)add("payload->>'paidAt'<=?",date(filters.to,'Дата до'));
    if(filters.bookingId)add('booking_id=?',text(filters.bookingId,'Запись',{required:true,max:128}));
    return(await this.db.query(`SELECT * FROM eduson_booking.payments${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY payload->>'paidAt' DESC,created_at DESC,id LIMIT 1000`,values)).rows.map(publicPayment);
  }
  async getPayment(id){return publicPayment((await this.db.query('SELECT * FROM eduson_booking.payments WHERE id=$1',[id])).rows[0]);}
}

const cell=value=>value==null?'':value;
const displayDate=value=>value?value.split('-').reverse().join('.'):'';
export function mapOperationalPaymentRow(payment){return[payment.createdAt,payment.managerName,payment.crmUrl,displayDate(payment.paidAt),payment.practice,payment.package,payment.paymentMethod,payment.amountNet,payment.recordingUrl,payment.id,payment.bookingId].map(cell);}
export function mapEnrollmentRow(payment){
  const row=Array(45).fill('');
  const fields={1:payment.crmUrl,3:displayDate(payment.registryDate),4:payment.amountNet,5:payment.paidLessons,6:payment.bonusLessons,9:payment.format,10:payment.product,11:payment.age,12:payment.months,13:payment.timezone,14:payment.parentName,15:payment.phone,16:payment.parentTelegram,17:payment.studentName,18:payment.studentTelegram,19:payment.studentPhone,20:payment.studentEmail,21:payment.parentAvailability,22:displayDate(payment.introDate),23:payment.introTime,24:payment.introTeacher,40:displayDate(payment.courseStartDate),41:payment.mainTeacher,42:payment.specialConditions,43:payment.id,44:payment.bookingId};
  ['mon','tue','wed','thu','fri','sat','sun'].forEach((day,i)=>{fields[28+i]=payment.weekAvailability?.[day];});
  for(const [index,value]of Object.entries(fields))row[Number(index)]=cell(value);return row;
}
function syncFailure(error){return['PAYMENT_NOT_FOUND','CONFIRMATION_NOT_FOUND','OPERATION_INVALID'].includes(error?.code)?error.code:safeSheetSyncError(error);}
const syncFail=code=>{throw new SheetSyncError(code);};

/** Two independent destinations use durable jobs; construction and disabled mode never touch Google. */
export function createOperationalSynchronizer({db,getPayment,getConfirmation,serviceAccountPath,spreadsheetId,enrollmentSpreadsheetId=ENROLLMENT_ID,enabled=false,fetchImpl=fetch,now=()=>new Date()}={}){
  let running=false;const clock=()=>new Date(typeof now==='function'?now():now);
  const clients={main:createGoogleSheetsClient({serviceAccountPath,spreadsheetId,fetchImpl,now}),enrollment:createGoogleSheetsClient({serviceAccountPath,spreadsheetId:enrollmentSpreadsheetId,fetchImpl,now})};
  const paymentReader=getPayment||(id=>new OperationalPaymentService(db).getPayment(id));
  const range=(target,cells)=>`'${target.tab}'!${cells}`;
  async function renew(job){const at=clock();const changed=await db.query('UPDATE eduson_booking.operation_jobs SET lease_until=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>$4 RETURNING id',[job.id,job.lease_token,new Date(+at+LEASE_MS),at]);if(!changed.rows.length)syncFail('SYNC_LEASE_LOST');}
  async function write(client,job,range_,options){await renew(job);return client.request(range_,options);}
  async function headers(client,target,job){
    const response=await client.request(range(target,`A1:${target.last}1`));const actual=response.values?.[0]||[];
    for(const [i,wanted]of target.headers.entries()){const found=normalizeSheetHeader(actual[i]),expected=normalizeSheetHeader(wanted);if(!(target===TARGETS.payment&&i===8?found.startsWith(expected):found===expected))syncFail('SHEET_HEADER_MISMATCH');}
    let missing=false;for(const [i,wanted]of target.extras.entries()){const found=normalizeSheetHeader(actual[target.headers.length+i]);if(found&&found!==normalizeSheetHeader(wanted))syncFail('SHEET_HEADER_MISMATCH');if(!found)missing=true;}
    if(missing){const values=(await client.request(range(target,`${target.idColumn}2:${target.last}`))).values||[];for(const[i]of target.extras.entries())if(!normalizeSheetHeader(actual[target.headers.length+i])&&values.some(row=>cell(row[i])!==''))syncFail('SHEET_HEADER_MISMATCH');await write(client,job,range(target,`${target.idColumn}1:${target.last}1`),{method:'PUT',values:[target.extras]});}
  }
  async function project(job){
    const target=TARGETS[job.kind];if(!target)syncFail('SYNC_JOB_KIND_INVALID');
    const client=job.kind==='enrollment'?clients.enrollment:clients.main;let values,id;
    if(job.kind==='confirmation'){
      const fact=getConfirmation?await getConfirmation(job.entity_id):job.payload;
      if(!fact||String(fact.bookingId)!==job.entity_id||!fact.confirmedAt)syncFail('CONFIRMATION_NOT_FOUND');
      id=fact.bookingId;values=[fact.confirmedAt,fact.crmUrl,fact.managerName,fact.time,id,fact.actorName].map(cell);
    }else{
      const payment=await paymentReader(job.entity_id);if(!payment||String(payment.id)!==job.entity_id)syncFail('PAYMENT_NOT_FOUND');
      id=payment.id;values=job.kind==='payment'?mapOperationalPaymentRow(payment):mapEnrollmentRow(payment);
    }
    await headers(client,target,job);
    const rows=(await client.request(range(target,`${target.idColumn}2:${target.idColumn}`))).values||[];
    const matches=rows.flatMap((row,i)=>String(row[0]??'')===String(id)?[i+2]:[]);if(matches.length>1)syncFail('SHEET_DUPLICATE_ID');
    // Payments are immutable facts. An accepted append must not erase later registry workflow work on retry.
    if(matches.length&&target.immutable)return;
    if(matches.length)await write(client,job,range(target,`A${matches[0]}:${target.last}${matches[0]}`),{method:'PUT',values:[values]});
    else{await renew(job);await client.appendCells(target.sheetId,[values]);}
  }
  async function claim(){
    const at=clock();return db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.operation_jobs IN SHARE ROW EXCLUSIVE MODE');
      await tx.query("UPDATE eduson_booking.operation_jobs SET status='error',last_error='SYNC_ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE attempts>=$2 AND (status='pending' OR(status='processing' AND lease_until<=$1))",[at,MAX_ATTEMPTS]);
      if((await tx.query("SELECT id FROM eduson_booking.operation_jobs WHERE status='processing' AND lease_until>$1 LIMIT 1",[at])).rows.length)return null;
      const candidate=(await tx.query(`SELECT * FROM eduson_booking.operation_jobs WHERE attempts<$1 AND (status='pending' OR(status='processing' AND lease_until<=$2) OR(status='error' AND updated_at<=$2::timestamptz-(LEAST(3600000,5000*POWER(2,GREATEST(0,attempts-1)))*interval '1 millisecond'))) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[MAX_ATTEMPTS,at])).rows[0];if(!candidate)return null;
      return(await tx.query("UPDATE eduson_booking.operation_jobs SET status='processing',attempts=attempts+1,last_error=NULL,lease_token=$2,lease_until=$3,updated_at=$4 WHERE id=$1 RETURNING *",[candidate.id,randomUUID(),new Date(+at+LEASE_MS),at])).rows[0];
    });
  }
  async function runOnce(){
    if(!enabled)return{processed:false,reason:'disabled'};if(running)return{processed:false,reason:'busy'};
    if(!serviceAccountPath||!spreadsheetId||!enrollmentSpreadsheetId)return{processed:false,error:'SYNC_CONFIGURATION'};
    running=true;try{
      const job=await claim();if(!job)return{processed:false};
      try{await project(job);const changed=await db.query("UPDATE eduson_booking.operation_jobs SET status='done',last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>$3 RETURNING id",[job.id,job.lease_token,clock()]);if(!changed.rows.length)syncFail('SYNC_LEASE_LOST');return{processed:true,status:'done',kind:job.kind};}
      catch(error){const code=syncFailure(error);await db.query("UPDATE eduson_booking.operation_jobs SET status='error',last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token,code,clock()]);return{processed:true,status:'error',kind:job.kind,error:code};}
    }finally{running=false;}
  }
  async function status(){
    const counts=(await db.query('SELECT kind,status,count(*)::int n FROM eduson_booking.operation_jobs GROUP BY kind,status')).rows;
    const byKind={};let pending=0,error=0;for(const row of counts){byKind[row.kind]||={pending:0,error:0,done:0};if(['pending','processing'].includes(row.status)){pending+=row.n;byKind[row.kind].pending+=row.n;}if(row.status==='error'){error+=row.n;byKind[row.kind].error+=row.n;}if(row.status==='done')byKind[row.kind].done+=row.n;}
    const latest=(await db.query("SELECT last_error FROM eduson_booking.operation_jobs WHERE status='error' ORDER BY updated_at DESC,id DESC LIMIT 1")).rows[0];
    return{enabled:Boolean(enabled),pending,error,lastError:latest?syncFailure({code:latest.last_error}):null,byKind};
  }
  return{runOnce,status};
}
