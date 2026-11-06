import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';

/**
 * Opt-in booking notifications. No provider access occurs during construction or disabled runs.
 * initializeSlackSchema(db) must run after the base booking schema.
 * createSlackNotifications({db,getStats(date),config,now,fetchImpl}) returns {runOnce,status}.
 * config: {enabled,token,teamId,summaryChannelId?,summaryUserId?,staffMap:{[bookingUserId]:slackUserId},baseUrl,activationAt?}.
 * The first enabled run silently baselines existing audit/completed facts. Persisted activation never rewinds.
 * Prime this run before admitting new production traffic. Mapping is explicit and checked against Slack.
 * Each run plans durable work and processes at most one job. Admin status never exposes credentials/content.
 * Slack contracts checked 2026-11-04:
 * https://docs.slack.dev/reference/methods/chat.postMessage/
 * https://docs.slack.dev/reference/methods/chat.update/
 * https://docs.slack.dev/reference/methods/conversations.open/
 * https://docs.slack.dev/apis/web-api/rate-limits/
 */
const SCHEMA=new URL('./slack-schema.sql',import.meta.url);
const MINUTE=60_000,DAY=86400_000,LEASE=5*MINUTE,MAX_ATTEMPTS=8;
const USER=/^[UW][A-Z0-9]+$/,CHANNEL=/^[CG][A-Z0-9]+$/,DM=/^D[A-Z0-9]+$/,TS=/^\d{10,16}\.\d{1,6}$/;
const SAFE=new Set(['SLACK_CONFIGURATION','SLACK_TEAM_MISMATCH','SLACK_MEMBER_INVALID','SLACK_CHANNEL_INVALID','SLACK_MAPPING_MISSING','SLACK_MAPPING_INVALID','SLACK_RATE_LIMITED','SLACK_REJECTED','SLACK_NETWORK','SLACK_RESPONSE_INVALID','SLACK_DELIVERY_UNCERTAIN','SLACK_RECEIPT_INVALID','SLACK_LEASE_LOST','SLACK_ATTEMPTS_EXHAUSTED','SLACK_STATS_UNAVAILABLE','SLACK_STORAGE_FAILED','SLACK_JOB_NOT_DUE']);
const safe=error=>SAFE.has(error?.code)?error.code:'SLACK_STORAGE_FAILED';
const fail=(code,properties={})=>{throw Object.assign(new Error(code),{code,...properties});};
const iso=value=>new Date(value).toISOString();
const date=value=>typeof value==='string'?value.slice(0,10):iso(value).slice(0,10);
const moscow=value=>new Date(+new Date(value)+3*3600_000).toISOString();
const escape=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\s+/g,' ').trim().slice(0,180);
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assignmentVersion=event=>Number.isInteger(Number(event.payload?.version))?Number(event.payload.version):0;
const meaningfulAssignment=alias=>`${alias}.action IN ('confirmed','assigned') AND NOT (${alias}.action='assigned' AND COALESCE(${alias}.payload->'previous'->>'managerId'=${alias}.payload->>'managerId' AND ${alias}.payload->'previous'->>'kind'=${alias}.payload->>'kind',false))`;

export async function initializeSlackSchema(db){
  for(const statement of (await readFile(SCHEMA,'utf8')).split(';').map(value=>value.trim()).filter(Boolean))await db.query(statement);
}

export function createSlackNotifications({db,getStats,config={},now=()=>new Date(),fetchImpl=fetch}={}){
  const clock=()=>new Date(typeof now==='function'?now():now);
  const staff=config.staffMap||{},ids=Object.keys(staff),slackIds=Object.values(staff);
  let baseUrl;try{const u=new URL(config.baseUrl);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)baseUrl=u.href.replace(/\/$/,'');}catch{}
  const validMap=staff&&typeof staff==='object'&&!Array.isArray(staff)&&ids.every(id=>id&&id.length<=128&&typeof staff[id]==='string'&&USER.test(staff[id]))&&new Set(slackIds).size===slackIds.length;
  const summaryTarget=config.summaryUserId||config.summaryChannelId;
  const configured=Boolean(typeof config.token==='string'&&config.token&&/^T[A-Z0-9]+$/.test(config.teamId||'')&&(USER.test(config.summaryUserId||'')||CHANNEL.test(config.summaryChannelId||''))&&baseUrl&&validMap&&(config.activationAt===undefined||Number.isFinite(+new Date(config.activationAt))));
  let busy=false,identity=null,summaryVerifiedUntil=0;
  const people=new Map();

  async function baseline(){
    const at=clock();return db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.slack_notification_state IN SHARE ROW EXCLUSIVE MODE');
      const old=(await tx.query("SELECT * FROM eduson_booking.slack_notification_state WHERE key='booking'")).rows[0];if(old)return old;
      const activation=config.activationAt===undefined?at:new Date(config.activationAt);
      const row=(await tx.query("INSERT INTO eduson_booking.slack_notification_state(key,activation_at,initialized_at)VALUES('booking',$1,$2)RETURNING *",[activation,at])).rows[0];
      // IDs, rather than a timestamp-only cursor, cover events sharing a clock tick at cutover.
      await tx.query("INSERT INTO eduson_booking.slack_notification_marks(source_key,marked_at)SELECT 'event:'||id,$1 FROM eduson_booking.audit_events WHERE action IN ('confirmed','assigned') ON CONFLICT DO NOTHING",[at]);
      await tx.query("INSERT INTO eduson_booking.slack_notification_marks(source_key,marked_at)SELECT 'report:'||id,$1 FROM eduson_booking.bookings WHERE state='completed' ON CONFLICT DO NOTHING",[at]);
      return row;
    });
  }
  async function insertJob(tx,{key,logicalKey=key,kind,bookingId=null,managerId=null,version=0,payload={},dueAt=clock()}){
    const at=clock();return tx.query(`INSERT INTO eduson_booking.slack_notification_jobs(id,dedup_key,logical_key,kind,booking_id,manager_id,source_version,payload,due_at,retry_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`,[randomUUID(),key,logicalKey,kind,bookingId,managerId,version,JSON.stringify(payload),dueAt,at]);
  }
  async function planFacts(state){
    const at=clock();return db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.slack_notification_marks IN SHARE ROW EXCLUSIVE MODE');
      const events=(await tx.query(`SELECT a.*,b.assigned_to,b.assignment_kind,b.state,b.is_test,b.history_only,b.ends_at,
        (SELECT MAX((newer.payload->>'version')::int) FROM eduson_booking.audit_events newer WHERE newer.booking_id=a.booking_id AND ${meaningfulAssignment('newer')}) latest_assignment
        FROM eduson_booking.audit_events a JOIN eduson_booking.bookings b ON b.id=a.booking_id
        WHERE a.action IN ('confirmed','assigned') AND a.created_at>=$1
          AND NOT EXISTS(SELECT 1 FROM eduson_booking.slack_notification_marks m WHERE m.source_key='event:'||a.id)
        ORDER BY a.created_at,a.id LIMIT 200`,[state.activation_at])).rows;
      for(const event of events){
        await tx.query('INSERT INTO eduson_booking.slack_notification_marks(source_key,marked_at)VALUES($1,$2)ON CONFLICT DO NOTHING',['event:'+event.id,at]);
        const version=assignmentVersion(event);
        if(event.is_test||event.history_only||!['scheduled','in_progress'].includes(event.state)||+new Date(event.ends_at)<=+at)continue;
        const previous=event.payload.previous?.managerId;
        // Transfers can be coalesced, but every previous owner must learn that the lesson left them.
        // Coalesce repeated losses by one recipient within the same currently observed assignment generation.
        if(event.action==='assigned'&&previous&&previous!==event.assigned_to)await insertJob(tx,{key:`released:${event.booking_id}:${previous}:${event.latest_assignment}`,kind:'released',bookingId:event.booking_id,managerId:previous,version});
        if(version===event.latest_assignment&&event.payload.managerId===event.assigned_to)await insertJob(tx,{key:'assignment:'+event.id,kind:'assignment',bookingId:event.booking_id,managerId:event.assigned_to,version,payload:{kind:event.assignment_kind}});
      }
      // A transfer can cancel preflight before any send. A returned owner still needs the reminder.
      await tx.query(`UPDATE eduson_booking.slack_notification_jobs j SET status='pending',last_error=NULL,retry_at=$3,updated_at=$3,
        due_at=GREATEST(b.ends_at,COALESCE(b.completed_at,b.ends_at))+interval '15 minutes'
        FROM eduson_booking.bookings b WHERE j.kind='report' AND j.status='cancelled' AND j.booking_id=b.id
          AND j.manager_id=b.assigned_to AND b.assignment_kind='primary' AND NOT b.is_test AND NOT b.history_only AND b.ends_at>=$2
          AND ((b.state='completed' AND b.completed_at>=$1 AND b.completed_at>=$2)
            OR (b.state IN ('scheduled','in_progress') AND b.confirmation_status='confirmed' AND b.starts_at>=$1))
          AND NOT EXISTS(SELECT 1 FROM eduson_booking.reports r WHERE r.booking_id=b.id)
          AND NOT EXISTS(SELECT 1 FROM eduson_booking.slack_notification_marks m WHERE m.source_key='report:'||b.id)
          AND NOT EXISTS(SELECT 1 FROM eduson_booking.slack_notification_messages receipt WHERE receipt.logical_key=j.logical_key)`,[state.activation_at,new Date(+at-3*DAY),at]);
      const reports=(await tx.query(`SELECT b.* FROM eduson_booking.bookings b WHERE b.assignment_kind='primary' AND b.assigned_to IS NOT NULL
        AND NOT b.is_test AND NOT b.history_only AND b.ends_at>=$2
        AND ((b.state='completed' AND b.completed_at>=$1 AND b.completed_at>=$2)
          OR (b.state IN ('scheduled','in_progress') AND b.confirmation_status='confirmed' AND b.starts_at>=$1 AND b.ends_at<=$3))
        AND NOT EXISTS(SELECT 1 FROM eduson_booking.reports r WHERE r.booking_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM eduson_booking.slack_notification_marks m WHERE m.source_key IN ('report:'||b.id,'report:'||b.id||':'||b.assigned_to))`,[state.activation_at,new Date(+at-3*DAY),new Date(+at-15*MINUTE)])).rows;
      for(const row of reports){
        const key=`report:${row.id}:${row.assigned_to}`;
        await tx.query('INSERT INTO eduson_booking.slack_notification_marks(source_key,marked_at)VALUES($1,$2)ON CONFLICT DO NOTHING',[key,at]);
        await insertJob(tx,{key,kind:'report',bookingId:row.id,managerId:row.assigned_to,version:row.version,payload:{activationAt:iso(state.activation_at)},dueAt:new Date(Math.max(+new Date(row.ends_at),row.completed_at?+new Date(row.completed_at):0)+15*MINUTE)});
      }
      for(const managerId of ids)await tx.query("UPDATE eduson_booking.slack_notification_jobs SET status='pending',last_error=NULL,retry_at=$2 WHERE status='blocked_mapping' AND manager_id=$1",[managerId,at]);
    });
  }
  async function planHours(){
    const at=clock(),day=moscow(at).slice(0,10),windows=[];
    for(let hour=10;hour<=21;hour++){
      const time=String(hour).padStart(2,'0')+':00',start=+new Date(`${day}T${time}:00+03:00`);
      // A final minute of scheduler grace permits the end+15 update at xx:15:SS.
      if(+at>=start-15*MINUTE&&+at<start+76*MINUTE)windows.push({day,time,start});
    }
    if(!windows.length)return;
    let stats;try{stats=await getStats(day);if(!Array.isArray(stats?.hours))throw Error();}catch{fail('SLACK_STATS_UNAVAILABLE');}
    const bookings=(await db.query(`SELECT b.*,r.booking_id has_report FROM eduson_booking.bookings b LEFT JOIN eduson_booking.reports r ON r.booking_id=b.id WHERE b.date=$1 AND NOT b.is_test AND NOT b.history_only`,[day])).rows;
    const bucket=Math.floor(+at/(5*MINUTE));
    for(const window of windows){
      const hour=stats.hours.find(row=>row.time===window.time);if(!hour)continue;
      if(!Number.isSafeInteger(hour.managers)||hour.managers<0||!Number.isSafeInteger(hour.capacity)||hour.capacity<0)fail('SLACK_STATS_UNAVAILABLE');
      const rows=bookings.filter(b=>b.time===window.time),active=rows.filter(b=>b.state!=='cancelled'),reserves=new Set((hour.allocations||[]).filter(a=>a.kind==='reserve').map(a=>a.bookingId));
      const counts={managers:hour.managers,capacity:hour.capacity,total:active.length,confirmed:active.filter(b=>b.confirmation_status==='confirmed').length,pending:active.filter(b=>b.state==='scheduled'&&b.confirmation_status!=='confirmed').length,
        reserve:active.filter(b=>b.assignment_kind==='reserve'||reserves.has(b.id)).length,unassigned:active.filter(b=>!b.assigned_to).length,inProgress:active.filter(b=>b.state==='in_progress').length,
        completed:active.filter(b=>b.state==='completed').length,cancelled:rows.filter(b=>b.state==='cancelled').length,missingReport:active.filter(b=>b.state==='completed'&&!b.has_report).length};
      const logicalKey=`hour:${day}:${window.time}:${summaryTarget}`;
      if((await db.query("SELECT logical_key FROM eduson_booking.slack_notification_messages WHERE logical_key=$1 AND status='uncertain'",[logicalKey])).rows.length)continue;
      await insertJob(db,{key:logicalKey+':'+bucket,logicalKey,kind:'hour',payload:{date:day,time:window.time,bucket,endAt:iso(window.start+76*MINUTE),counts},dueAt:at});
    }
  }
  async function plan(state){
    await planFacts(state);
    const blocked=(await db.query("SELECT * FROM eduson_booking.slack_notification_jobs WHERE status='blocked_mapping' ORDER BY created_at,id LIMIT 200")).rows;
    for(const job of blocked)if(!await render(job))await db.query("UPDATE eduson_booking.slack_notification_jobs SET status='cancelled',last_error=NULL,updated_at=$2 WHERE id=$1 AND status='blocked_mapping'",[job.id,clock()]);
    let error=null;try{await planHours();}catch(caught){error=safe(caught);}
    await db.query("UPDATE eduson_booking.slack_notification_state SET last_error=$1 WHERE key='booking'",[error]);
  }
  async function claim(){
    const at=clock();return db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.slack_notification_jobs IN SHARE ROW EXCLUSIVE MODE');
      const expired=(await tx.query("SELECT * FROM eduson_booking.slack_notification_jobs WHERE status='processing' AND lease_until<=$1",[at])).rows;
      for(const job of expired){
        const uncertain=job.send_started_at&&job.send_operation==='post';
        if(uncertain)await tx.query("UPDATE eduson_booking.slack_notification_messages SET status='uncertain',updated_at=$2 WHERE logical_key=$1 AND status<>'known'",[job.logical_key,at]);
        await tx.query("UPDATE eduson_booking.slack_notification_jobs SET status=$2,last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1",[job.id,uncertain?'uncertain':job.attempts>=MAX_ATTEMPTS?'error':'pending',uncertain?'SLACK_DELIVERY_UNCERTAIN':job.attempts>=MAX_ATTEMPTS?'SLACK_ATTEMPTS_EXHAUSTED':null,at]);
      }
      if((await tx.query("SELECT id FROM eduson_booking.slack_notification_jobs WHERE status='processing' AND lease_until>$1 LIMIT 1",[at])).rows.length)return null;
      const job=(await tx.query(`SELECT * FROM eduson_booking.slack_notification_jobs WHERE status IN ('pending','error') AND attempts<$1 AND due_at<=$2 AND retry_at<=$2
        ORDER BY CASE kind WHEN 'assignment' THEN 0 WHEN 'released' THEN 1 WHEN 'report' THEN 2 ELSE 3 END,due_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[MAX_ATTEMPTS,at])).rows[0];
      if(!job)return null;
      return(await tx.query("UPDATE eduson_booking.slack_notification_jobs SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=$3,send_operation=NULL,send_started_at=NULL,updated_at=$4 WHERE id=$1 RETURNING *",[job.id,randomUUID(),new Date(+at+LEASE),at])).rows[0];
    });
  }
  async function renew(job){
    const at=clock();if(!(await db.query("UPDATE eduson_booking.slack_notification_jobs SET lease_until=$3 WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>$4 RETURNING id",[job.id,job.lease_token,new Date(+at+LEASE),at])).rows.length)fail('SLACK_LEASE_LOST');
  }
  async function finish(job,status,error=null,{retryAt,refund=false}={}){
    const at=clock();return db.query(`UPDATE eduson_booking.slack_notification_jobs SET status=$3,last_error=$4,lease_token=NULL,lease_until=NULL,updated_at=$5,retry_at=$6,attempts=GREATEST(0,attempts-$7)
      WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>$5 RETURNING id`,[job.id,job.lease_token,status,error,at,retryAt||at,refund?1:0]);
  }
  async function methodCooldown(method){
    const row=(await db.query('SELECT next_allowed_at FROM eduson_booking.slack_notification_method_limits WHERE team_id=$1 AND method=$2',[config.teamId,method])).rows[0];
    return row&&+new Date(row.next_allowed_at)>+clock()?new Date(row.next_allowed_at):null;
  }
  async function recordRateLimit(method,milliseconds){
    await db.query(`INSERT INTO eduson_booking.slack_notification_method_limits(team_id,method,next_allowed_at)VALUES($1,$2,$3)
      ON CONFLICT(team_id,method)DO UPDATE SET next_allowed_at=GREATEST(eduson_booking.slack_notification_method_limits.next_allowed_at,EXCLUDED.next_allowed_at)`,[config.teamId,method,new Date(+clock()+milliseconds)]);
    fail('SLACK_RATE_LIMITED',{retryAfter:milliseconds});
  }
  async function api(method,body,{posting=false}={}){
    const limited=await methodCooldown(method);if(limited)fail('SLACK_RATE_LIMITED',{retryAfter:+limited-+clock(),deferred:true});
    const read=['users.info','conversations.info'].includes(method),url='https://slack.com/api/'+method+(read?'?'+new URLSearchParams(body):'');
    let response;try{response=await fetchImpl(url,{method:read?'GET':'POST',headers:{Authorization:'Bearer '+config.token,...(read?{}:{'content-type':'application/json; charset=utf-8'})},...(read?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});}catch{fail(posting?'SLACK_DELIVERY_UNCERTAIN':'SLACK_NETWORK',{uncertain:posting});}
    const retry=Number(response.headers?.get?.('retry-after'));
    if(response.status===429)await recordRateLimit(method,Number.isFinite(retry)&&retry>0?Math.min(retry,86400)*1000:60_000);
    if(response.status>=500)fail(posting?'SLACK_DELIVERY_UNCERTAIN':'SLACK_NETWORK',{uncertain:posting});
    if(!response.ok)fail('SLACK_REJECTED');
    let result;try{result=await response.json();}catch{fail(posting?'SLACK_DELIVERY_UNCERTAIN':'SLACK_RESPONSE_INVALID',{uncertain:posting});}
    if(result?.ok===false){
      if(['ratelimited','rate_limited'].includes(result.error))await recordRateLimit(method,Number.isFinite(retry)&&retry>0?Math.min(retry,86400)*1000:60_000);
      if(['internal_error','fatal_error','request_timeout','service_unavailable'].includes(result.error))fail(posting?'SLACK_DELIVERY_UNCERTAIN':'SLACK_NETWORK',{uncertain:posting});
      fail('SLACK_REJECTED');
    }
    if(result?.ok!==true)fail(posting?'SLACK_DELIVERY_UNCERTAIN':'SLACK_RESPONSE_INVALID',{uncertain:posting});return result;
  }
  async function verifyIdentity(){
    if(identity&&identity.expires>+clock())return;
    const result=await api('auth.test',{});if(result.team_id!==config.teamId||!USER.test(result.user_id||'')||!/^B[A-Z0-9]+$/.test(result.bot_id||''))fail('SLACK_TEAM_MISMATCH');
    identity={expires:+clock()+5*MINUTE};
  }
  async function destination(job){
    await verifyIdentity();
    if(job.kind==='hour'){
      if(summaryVerifiedUntil<=+clock()){
        if(config.summaryUserId){const result=await api('users.info',{user:config.summaryUserId});if(!result.user||result.user.id!==config.summaryUserId||result.user.team_id!==config.teamId||result.user.deleted!==false||result.user.is_bot!==false)fail('SLACK_MEMBER_INVALID');}
        else {const result=await api('conversations.info',{channel:config.summaryChannelId});if(result.channel?.id!==config.summaryChannelId||result.channel.is_archived!==false||result.channel.is_member!==true)fail('SLACK_CHANNEL_INVALID');}
        summaryVerifiedUntil=+clock()+5*MINUTE;
      }
      if(config.summaryUserId){let row=(await db.query('SELECT * FROM eduson_booking.slack_notification_destinations WHERE team_id=$1 AND slack_user_id=$2',[config.teamId,config.summaryUserId])).rows[0];if(!row){await renew(job);const result=await api('conversations.open',{users:config.summaryUserId,return_im:true}),channel=result.channel;if(!DM.test(channel?.id||''))fail('SLACK_CHANNEL_INVALID');await db.query('INSERT INTO eduson_booking.slack_notification_destinations(team_id,slack_user_id,channel_id,verified_at)VALUES($1,$2,$3,$4)ON CONFLICT(team_id,slack_user_id)DO UPDATE SET channel_id=EXCLUDED.channel_id,verified_at=EXCLUDED.verified_at',[config.teamId,config.summaryUserId,channel.id,clock()]);row={channel_id:channel.id};}return row.channel_id;}
      return config.summaryChannelId;
    }
    const recipient=staff[job.manager_id];
    if((people.get(recipient)||0)<=+clock()){
      const result=await api('users.info',{user:recipient}),u=result.user;
      if(!u||u.id!==recipient||u.team_id!==config.teamId||u.deleted!==false||u.is_bot!==false||u.is_app_user===true)fail('SLACK_MEMBER_INVALID');people.set(recipient,+clock()+5*MINUTE);
    }
    let row=(await db.query('SELECT * FROM eduson_booking.slack_notification_destinations WHERE team_id=$1 AND slack_user_id=$2',[config.teamId,recipient])).rows[0];
    if(!row){
      await renew(job);const result=await api('conversations.open',{users:recipient,return_im:true}),channel=result.channel;
      if(!DM.test(channel?.id||'')||channel.user!==undefined&&channel.user!==recipient)fail('SLACK_CHANNEL_INVALID');
      await db.query('INSERT INTO eduson_booking.slack_notification_destinations(team_id,slack_user_id,channel_id,verified_at)VALUES($1,$2,$3,$4)ON CONFLICT(team_id,slack_user_id)DO UPDATE SET channel_id=EXCLUDED.channel_id,verified_at=EXCLUDED.verified_at',[config.teamId,recipient,channel.id,clock()]);row={channel_id:channel.id};
    }
    return row.channel_id;
  }
  async function render(job){
    const at=clock();
    if(job.kind==='hour'){
      const p=job.payload;if(p.bucket!==Math.floor(+at/(5*MINUTE))||+new Date(p.endAt)<=+at)return null;
      const c=p.counts;return `📊 *Статистика слота · ${p.date.split('-').reverse().join('.')} · ${p.time} МСК*\n`+
        `МИМК: *${c.managers}* · мест с резервом: *${c.capacity}*\nЗаписей: *${c.total}* · подтверждено: *${c.confirmed}* · ожидают: *${c.pending}*\n`+
        `Резерв: *${c.reserve}* · без МИМК: *${c.unassigned}*\nВ работе: *${c.inProgress}* · завершено: *${c.completed}* · отменено: *${c.cancelled}*\nБез отчёта: *${c.missingReport}*\nОбновлено: ${moscow(at).slice(11,16)} МСК`;
    }
    const row=(await db.query(`SELECT b.*,r.booking_id has_report,(SELECT MAX((a.payload->>'version')::int) FROM eduson_booking.audit_events a WHERE a.booking_id=b.id AND ${meaningfulAssignment('a')}) latest_assignment
      FROM eduson_booking.bookings b LEFT JOIN eduson_booking.reports r ON r.booking_id=b.id WHERE b.id=$1`,[job.booking_id])).rows[0];
    if(!row||row.is_test||row.history_only||row.state==='cancelled')return null;
    const when=`${date(row.date).split('-').reverse().join('.')} · ${row.time} МСК`,name=escape(row.student_name)||'Ученик';
    if(job.kind==='report'){
      const completed=row.state==='completed';
      const unfinished=['scheduled','in_progress'].includes(row.state)&&row.confirmation_status==='confirmed'&&+new Date(row.starts_at)>=+new Date(job.payload.activationAt);
      if((!completed&&!unfinished)||row.has_report||row.assignment_kind!=='primary'||row.assigned_to!==job.manager_id||+new Date(row.ends_at)<+at-3*DAY||(completed&&+new Date(row.completed_at)<+at-3*DAY))return null;
      const dueAt=Math.max(+new Date(row.ends_at),row.completed_at?+new Date(row.completed_at):0)+15*MINUTE;
      if(+at<dueAt)return{deferUntil:dueAt};
      return completed?`📝 *Нужен отчёт об уроке*\n${name}\n${when}\nУрок завершён, отчёт ещё не сохранён.\n<${baseUrl}/#completed|Заполнить отчёт в букинге>`:
        `📝 *Укажите статус урока*\n${name}\n${when}\nВремя урока прошло. Укажите фактический итог и заполните отчёт, если урок состоялся.\n<${baseUrl}/#active|Открыть урок в букинге>`;
    }
    if(!['scheduled','in_progress'].includes(row.state)||+new Date(row.ends_at)<=+at)return null;
    if(job.kind==='released')return row.assigned_to!==job.manager_id?`↪️ *Урок передан другому МИМК*\n${name}\n${when}\nЭтот урок больше не назначен вам.\n<${baseUrl}/#active|Открыть букинг>`:null;
    if(job.source_version!==row.latest_assignment)return null;
    if(row.assigned_to!==job.manager_id)return null;
    return `${row.assignment_kind==='reserve'?'🟡 *Вам назначен резервный урок*':'✅ *Вам назначен подтверждённый урок*'}\n${name}\n${when}\n<${baseUrl}/#active|Открыть букинг>`;
  }
  async function gate(job,channel){
    const at=clock();return db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.slack_notification_limits IN SHARE ROW EXCLUSIVE MODE');
      const row=(await tx.query('SELECT next_allowed_at FROM eduson_booking.slack_notification_limits WHERE team_id=$1 AND channel_id=$2',[config.teamId,channel])).rows[0];
      if(row&&+new Date(row.next_allowed_at)>+at)return row.next_allowed_at;
      await tx.query('INSERT INTO eduson_booking.slack_notification_limits(team_id,channel_id,next_allowed_at)VALUES($1,$2,$3)ON CONFLICT(team_id,channel_id)DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at',[config.teamId,channel,new Date(+at+1000)]);return null;
    });
  }
  async function deliver(job){
    const deferIfNeeded=value=>{if(value?.deferUntil)fail('SLACK_JOB_NOT_DUE',{deferred:true,retryAfter:Math.max(1,value.deferUntil-+clock())});};
    let text=await render(job);deferIfNeeded(text);if(!text){await finish(job,'cancelled',null,{refund:job.kind==='report'});return{processed:true,status:'cancelled',kind:job.kind};}
    if(job.manager_id&&!staff[job.manager_id]){await finish(job,'blocked_mapping','SLACK_MAPPING_MISSING',{refund:true});return{processed:true,status:'blocked_mapping',kind:job.kind};}
    const receipt=(await db.query('SELECT * FROM eduson_booking.slack_notification_messages WHERE logical_key=$1',[job.logical_key])).rows[0];
    const limited=await methodCooldown(receipt?.status==='known'?'chat.update':'chat.postMessage');
    if(limited){await finish(job,'pending','SLACK_RATE_LIMITED',{retryAt:limited,refund:true});return{processed:false,reason:'workspace_rate_limit'};}
    const channel=await destination(job);await renew(job);
    // Preflight may take several requests. A report/transfer during it must cancel the old notice.
    text=await render(job);deferIfNeeded(text);if(!text){await finish(job,'cancelled',null,{refund:job.kind==='report'});return{processed:true,status:'cancelled',kind:job.kind};}
    if(receipt?.status==='uncertain'){await finish(job,'uncertain','SLACK_DELIVERY_UNCERTAIN');return{processed:true,status:'uncertain',kind:job.kind};}
    if(receipt&&(receipt.team_id!==config.teamId||receipt.channel_id!==channel))fail('SLACK_CHANNEL_INVALID');
    if(receipt?.status==='known'&&job.kind!=='hour'){await finish(job,'sent');return{processed:true,status:'sent',kind:job.kind};}
    const waitUntil=await gate(job,channel);if(waitUntil){await finish(job,'pending',null,{retryAt:waitUntil,refund:true});return{processed:false,reason:'channel_rate_limit'};}
    const operation=receipt?.status==='known'?'update':'post',at=clock();
    if(operation==='post')await db.query("INSERT INTO eduson_booking.slack_notification_messages(logical_key,team_id,channel_id,status,updated_at)VALUES($1,$2,$3,'posting',$4)ON CONFLICT(logical_key)DO NOTHING",[job.logical_key,config.teamId,channel,at]);
    await renew(job);
    if(!(await db.query("UPDATE eduson_booking.slack_notification_jobs SET send_operation=$3,send_started_at=$4 WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>$4 RETURNING id",[job.id,job.lease_token,operation,at])).rows.length)fail('SLACK_LEASE_LOST');
    const result=await api(operation==='post'?'chat.postMessage':'chat.update',{channel,...(operation==='update'?{ts:receipt.ts}:{}),text,mrkdwn:true,unfurl_links:false,unfurl_media:false},{posting:operation==='post'});
    if(result.channel!==channel||!TS.test(result.ts||'')||(operation==='update'&&result.ts!==receipt.ts))fail('SLACK_RECEIPT_INVALID',{uncertain:operation==='post'});
    try{
      await db.transaction(async tx=>{
        const changed=await tx.query("UPDATE eduson_booking.slack_notification_jobs SET status='sent',last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=$3 WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>$3 RETURNING id",[job.id,job.lease_token,clock()]);
        if(!changed.rows.length)fail('SLACK_LEASE_LOST');
        await tx.query("UPDATE eduson_booking.slack_notification_messages SET ts=$2,status='known',payload_hash=$3,updated_at=$4 WHERE logical_key=$1",[job.logical_key,result.ts,fingerprint(text),clock()]);
      });
    }catch(error){
      // Slack accepted the POST. Losing its local receipt must never turn it into a retryable post.
      if(operation==='post')fail('SLACK_DELIVERY_UNCERTAIN',{uncertain:true});
      throw error;
    }
    return{processed:true,status:'sent',kind:job.kind};
  }
  async function runOnce(){
    if(!config.enabled)return{processed:false,reason:'disabled'};if(!configured)return{processed:false,error:validMap?'SLACK_CONFIGURATION':'SLACK_MAPPING_INVALID'};if(busy)return{processed:false,reason:'busy'};
    busy=true;let job;
    try{
      const state=await baseline();await plan(state);job=await claim();if(!job)return{processed:false};
      try{return await deliver(job);}catch(error){
        const code=safe(error);
        if(error.deferred){await finish(job,'pending',code,{retryAt:new Date(+clock()+error.retryAfter),refund:true});return{processed:false,reason:code==='SLACK_JOB_NOT_DUE'?'not_due':'workspace_rate_limit'};}
        if(error.uncertain){
          await db.query("UPDATE eduson_booking.slack_notification_messages SET status='uncertain',updated_at=$2 WHERE logical_key=$1 AND status<>'known'",[job.logical_key,clock()]);
          await finish(job,'uncertain',code);return{processed:true,status:'uncertain',kind:job.kind,error:code};
        }
        const retryAt=new Date(+clock()+(error.retryAfter||Math.min(3600000,5000*2**Math.max(0,job.attempts-1))));
        await finish(job,'error',code,{retryAt});return{processed:true,status:'error',kind:job.kind,error:code};
      }
    }catch(error){return{processed:Boolean(job),error:safe(error)};}finally{busy=false;}
  }
  async function status(){
    const rows=(await db.query('SELECT kind,status,count(*)::int n FROM eduson_booking.slack_notification_jobs GROUP BY kind,status')).rows;
    const counts={pending:0,error:0,uncertain:0,blockedMapping:0,cancelled:0,sent:0},byKind={};
    for(const row of rows){const key=row.status==='processing'?'pending':row.status==='blocked_mapping'?'blockedMapping':row.status;counts[key]=(counts[key]||0)+row.n;byKind[row.kind]||={};byKind[row.kind][key]=(byKind[row.kind][key]||0)+row.n;}
    const state=(await db.query("SELECT * FROM eduson_booking.slack_notification_state WHERE key='booking'")).rows[0];
    const latest=(await db.query("SELECT last_error FROM eduson_booking.slack_notification_jobs WHERE last_error IS NOT NULL AND status IN ('error','uncertain','blocked_mapping') ORDER BY updated_at DESC,id DESC LIMIT 1")).rows[0];
    const freshness=(await db.query("SELECT MAX(updated_at) AS last_attempt_at,MAX(updated_at) FILTER (WHERE status='sent') AS last_sent_at,MIN(due_at) FILTER (WHERE status IN ('pending','processing','error')) AS oldest_pending_due_at FROM eduson_booking.slack_notification_jobs")).rows[0]||{};
    const unmappedManagers=(await db.query("SELECT DISTINCT j.manager_id AS \"managerId\",u.name FROM eduson_booking.slack_notification_jobs j JOIN eduson_booking.users u ON u.id=j.manager_id WHERE j.status='blocked_mapping' ORDER BY j.manager_id")).rows;
    const plannerError=config.enabled&&state?.last_error?safe({code:state.last_error}):null,configurationError=config.enabled&&!configured?(validMap?'SLACK_CONFIGURATION':'SLACK_MAPPING_INVALID'):null;
    return{enabled:Boolean(config.enabled),configured,activationAt:state?iso(state.activation_at):null,...counts,error:counts.error+Number(Boolean(plannerError))+Number(Boolean(configurationError)),byKind,unmappedManagers,plannerError,lastError:!config.enabled?null:configurationError||latest&&safe({code:latest.last_error})||plannerError||null,lastAttemptAt:iso(freshness.last_attempt_at),lastSentAt:iso(freshness.last_sent_at),oldestPendingDueAt:iso(freshness.oldest_pending_due_at)};
  }
  // Establish the quiet cutoff before accepting user actions, without contacting Slack.
  const initialize=async()=>config.enabled&&configured?baseline():null;
  return{runOnce,status,initialize};
}
