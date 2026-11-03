import { businessDate, addDays, weekDates, safeUrl, matchesSearch, confirmationTiming, makeDraftStore, isHourOverloaded, filterHourBookings, booleanFact, legacyOutcomeUnknown, canResolveLegacy, canEditDetails, changedDetails, effectiveReserveCapacity, setDayReserveCapacity, schedulePayload } from './core.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
const notices = document.querySelector('#notifications');
const roles = {call_center:'Колл-центр',confirmation:'Подтверждение',sales:'Менеджер мастер-классов',admin:'Администратор'};
const ageGroups = ['5-7','8-9','10-12','13-14'];
const state = {user:null,csrfToken:'',managers:[],config:{},sync:null,bookings:[],hours:[],users:[],view:'',search:'',date:'',completedFrom:'',completedTo:'',adminDate:businessDate(),tag:'',week:businessDate(),managerId:'',scheduleDraft:null,scheduleConflict:false,loading:false,error:'',connected:false,events:null,refreshToken:0};
let drafts;
let refreshTimer;
let lastFocus;
const detailSnapshots=new WeakMap();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fieldValue = value => esc(value ?? '');
const isAdmin = () => state.user?.role === 'admin';
const isSales = () => state.user?.role === 'sales';
const canCreate = () => ['call_center','admin'].includes(state.user?.role);
const canConfirm = () => ['confirmation','admin'].includes(state.user?.role);
const canReport = () => ['sales','admin'].includes(state.user?.role);
const dateText = date => date ? new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}) : '—';
const dateShort = date => dateText(date).slice(0,5);
const timeStamp = value => value ? new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
const selected = (left,right) => String(left) === String(right) ? ' selected' : '';
const checked = value => value ? ' checked' : '';
const formError = error => `<div class="form-error" role="alert">${esc(error || '')}</div>`;

function icon(name) {
  const paths = {
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4m-9 7h2m3 0h2m-7 4h2"/>',
    chart:'<path d="M4 3v17h17M8 16v-5m5 5V6m5 10V9"/>',
    users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m0-16a3 3 0 0 1 0 6m3 3a6 6 0 0 1 3 5v2"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    document:'<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h7"/>',
    check:'<path d="m5 12 4 4L20 5"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.calendar}</svg>`;
}

function notify(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error?' error':''}`;
  node.textContent = message;
  notices.append(node);
  setTimeout(()=>node.remove(),7000);
}

async function api(path, {method='GET',body,signal} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort',onAbort,{once:true});
  try {
    const response = await fetch(`/api${path}`, {method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'&&state.csrfToken?{'X-CSRF-Token':state.csrfToken}:{})},...(body?{body:JSON.stringify(body)}:{})});
    let result;
    try {result = await response.json();} catch {throw new Error('Сервер вернул ответ в неизвестном формате. Повторите запрос.');}
    if (!response.ok) {
      const error = new Error(result.error || `Ошибка сервера (${response.status})`);
      error.status = response.status;
      error.code = result.code;
      if (response.status === 401 && state.user) loseSession();
      throw error;
    }
    return result;
  } catch (error) {
    if(error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Черновик сохранён. Повторите запрос.');
    if(error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение и повторите запрос.');
    throw error;
  } finally {clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);}
}

function allowedViews() {
  const role = state.user?.role;
  if(role === 'admin') return ['admin','active','completed','schedule','confirmation','users','trash'];
  if(role === 'sales') return ['active','completed','schedule'];
  if(role === 'confirmation') return ['confirmation','active','completed','trash'];
  return ['active','completed','trash'];
}

function defaultView() {return isAdmin()?'admin':state.user?.role === 'confirmation'?'confirmation':'active';}

function loseSession() {
  state.events?.close();state.events=null;state.connected=false;state.user=null;state.csrfToken='';drafts=null;
  if(dialog.open) dialog.close();
  renderLogin('Сессия завершилась. Войдите ещё раз.');
}

function renderLogin(error='') {
  app.innerHTML = `<main class="login-page" id="main"><section class="login-brand-panel"><a class="brand" href="/">eduson<small>KIDS</small></a><div><h2>Мастер-классы<br>по расписанию</h2><p>Запись, подтверждение и проведение занятий в одном рабочем пространстве.</p></div><span class="small">Рабочее пространство Eduson</span></section><section class="login-form-panel"><form class="login-form" id="login-form"><h1>Вход в букинг</h1><p>Используйте рабочую почту и пароль.<br>Доступ определяет администратор.</p>${formError(error)}<label class="field">Рабочая почта<input type="email" name="email" autocomplete="username" required autofocus></label><label class="field">Пароль<input type="password" name="password" autocomplete="current-password" required></label><button class="primary" type="submit">Войти</button><div class="login-footnote">Для доступа или смены пароля обратитесь к администратору. Часовой пояс расписания — Москва.</div></form></section></main>`;
  document.querySelector('#login-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector('button');
    const errorBox=form.querySelector('.form-error');
    button.disabled=true;button.textContent='Входим…';errorBox.textContent='';
    try {
      const result=await api('/session/login',{method:'POST',body:{email:form.elements.email.value.trim(),password:form.elements.password.value}});
      state.user=result.user;state.csrfToken=result.csrfToken;form.elements.password.value='';await bootstrap();
    } catch(error) {errorBox.textContent=error.message;}
    finally {button.disabled=false;button.textContent='Войти';}
  });
}

async function bootstrap() {
  const result=await api('/bootstrap');
  state.user=result.user;state.csrfToken=result.csrfToken;state.managers=result.managers||[];state.config=result.config||{};state.sync=result.sync;
  if(state.config.demoDate){state.adminDate=state.config.demoDate;state.date=state.config.demoDate;state.completedFrom=state.config.demoDate;state.completedTo=state.config.demoDate;state.week=state.config.demoDate;}
  state.bookings=[];state.hours=[];state.users=[];state.error='';state.scheduleDraft=null;
  drafts=makeDraftStore(sessionStorage,state.user.id);
  const requested=location.hash.slice(1);
  state.view=allowedViews().includes(requested)?requested:defaultView();
  state.managerId=isSales()?state.user.id:(state.managers[0]?.id||'');
  renderShell();
  connectEvents();
  await refresh();
}

function renderShell() {
  const initials=state.user.name.split(/\s+/).map(v=>v[0]).slice(0,2).join('');
  app.innerHTML=`<div class="shell"><aside class="sidebar" aria-label="Основная навигация"><a class="brand" href="/">eduson<small>KIDS</small></a><div class="sidebar-clock"><span>Время: <time id="moscow-clock"></time></span><small>Europe/Moscow</small></div><nav class="nav">${navItem(defaultView(),'calendar','Мастер-классы')}${['sales','admin'].includes(state.user.role)?navItem('schedule','clock','Расписание'):''}${isAdmin()?navItem('users','users','Сотрудники'):''}${!isSales()?navItem('trash','trash','Корзина'):''}${isAdmin()?`<a class="nav-link" href="/dashboard/">${icon('chart')}<span>Аналитика</span></a>`:''}</nav><div class="sidebar-bottom"><div class="avatar">${esc(initials)}</div><div class="user-name">${esc(state.user.name)}</div><div class="role-label">${esc(roles[state.user.role])}</div><button class="logout" data-action="logout">Выйти</button></div><div class="connection" id="connection"><span class="connection-dot offline"></span><span>Подключение к обновлениям…</span></div><div class="mobile-user"><span>${esc(state.user.name)}</span><button data-action="logout">Выйти</button></div></aside><div class="workspace"><div class="app-header"><header class="topline"><h1>Мастер-классы</h1><label class="search">${icon('search')}<input id="global-search" type="search" aria-label="Поиск по AMO, ученику или телефону" placeholder="Поиск по amoCRM" value="${esc(state.search)}"></label></header><nav class="tabs" aria-label="Разделы мастер-классов" id="tabs"></nav></div>${state.config.demo?'<div class="demo-banner">Демонстрационная среда · тестовые записи</div>':''}<main id="main" tabindex="-1"></main></div></div>`;
  document.querySelector('#global-search').addEventListener('input',event=>{state.search=event.target.value;renderContent();});
  renderTabs();setConnection(state.connected);updateMoscowClock();
}

function updateMoscowClock() {
  const clock=document.querySelector('#moscow-clock');
  if(clock)clock.textContent=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
}
setInterval(updateMoscowClock,1000);

function navItem(view, name, label) {return `<a class="nav-link${state.view===view?' selected':''}" href="#${view}" data-view="${view}">${icon(name)}<span>${label}</span></a>`;}

function renderTabs() {
  const labels={admin:'Статистика по часам',active:'Текущие и будущие',completed:'Завершённые',schedule:'Расписание',confirmation:'Подтверждение',users:'Сотрудники',trash:'Корзина'};
  let views=allowedViews();
  if(state.view==='users') views=['users'];
  else if(state.view==='trash') views=['trash'];
  else views=views.filter(view=>!['users','trash'].includes(view));
  document.querySelector('#tabs').innerHTML=views.map(view=>`<button class="tab${state.view===view?' active':''}" data-view="${view}" aria-current="${state.view===view?'page':'false'}">${esc(labels[view])}</button>`).join('');
  document.querySelectorAll('.nav-link[data-view]').forEach(node=>node.classList.toggle('selected',node.dataset.view===state.view || (node.dataset.view===defaultView()&&['active','completed','admin','confirmation'].includes(state.view))));
}

async function navigate(view) {
  if(!allowedViews().includes(view)) return;
  state.view=view;state.error='';location.hash=view;renderTabs();await refresh();
}

async function refresh({quiet=false}={}) {
  if(!state.user) return;
  const token=++state.refreshToken;
  if(!quiet){state.loading=true;renderContent();}
  const view=state.view;
  const syncRequest=isAdmin()?api('/sync').catch(error=>({...state.sync,loadError:error.message})):null;
  try {
    if(view==='users') {const result=await api('/users');if(token!==state.refreshToken)return;state.users=result.users||[];}
    else if(view==='schedule') {
      if(!state.managerId) {state.scheduleDraft={days:[],ageGroups:[]};}
      else {
        const dates=weekDates(state.week);
        const result=await api(`/schedule?${new URLSearchParams({managerId:state.managerId,from:dates[0],to:dates[6]})}`);
        if(token!==state.refreshToken)return;
        const key=scheduleDraftKey();
        const local=drafts.read(key);
        state.scheduleConflict=Boolean(local.days?.some(day=>Number(day.version||0)!==Number((result.days||[]).find(remote=>remote.date===day.date)?.version||0)));
        state.scheduleDraft=local.days?local:{days:dates.map(date=>({...((result.days||[]).find(day=>day.date===date)||{}),date,intervals:(result.days||[]).find(day=>day.date===date)?.intervals||[],reserveCapacity:(result.days||[]).find(day=>day.date===date)?.reserveCapacity??1})),ageGroups:result.ageGroups||[]};
      }
    } else {
      const scope=view==='trash'?'trash':view==='completed'?'completed':view==='admin'?'all':'active';
      const params=new URLSearchParams({scope});
      if(view==='completed'){if(state.completedFrom)params.set('from',state.completedFrom);if(state.completedTo)params.set('to',state.completedTo);}
      else if(state.date && view!=='admin')params.set('date',state.date);
      if(view==='admin')params.set('date',state.adminDate);
      const requests=[api(`/bookings?${params}`)];
      if(view==='admin')requests.push(api(`/admin/stats?${new URLSearchParams({date:state.adminDate,...(state.tag?{tag:state.tag}:{})})}`));
      const results=await Promise.all(requests);
      if(token!==state.refreshToken)return;
      state.bookings=results[0].bookings||[];
      if(results[1]){state.hours=results[1].hours||[];state.totals=results[1].totals||{};}
    }
    if(syncRequest){const sync=await syncRequest;if(token===state.refreshToken)state.sync=sync;}
    if(token!==state.refreshToken)return;
    state.error='';
  } catch(error) {if(token===state.refreshToken)state.error=error.message;}
  finally {if(token===state.refreshToken){state.loading=false;renderContent();}}
}

function setConnection(connected) {
  state.connected=connected;
  const node=document.querySelector('#connection');
  if(node)node.innerHTML=`<span class="connection-dot${connected?'':' offline'}"></span><span>${connected?'Обновляется автоматически':'Связь с обновлениями прервана'}</span>`;
}

function connectEvents() {
  state.events?.close();
  if(!window.EventSource)return;
  const source=new EventSource('/api/events');state.events=source;
  source.onopen=()=>setConnection(true);
  source.onerror=()=>setConnection(false);
  const invalidate=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh({quiet:true}),300);};
  source.addEventListener('changed',invalidate);
  source.onmessage=event=>{try {const data=JSON.parse(event.data);if(data.type==='changed'||data.event==='changed')invalidate();} catch {if(event.data==='changed')invalidate();}};
}

function renderContent() {
  const main=document.querySelector('#main');if(!main||!state.user)return;
  const savedFocus=main.contains(document.activeElement)?document.activeElement.id:null;
  let content='';
  if(state.view==='admin')content=renderAdmin();
  else if(state.view==='schedule')content=renderSchedule();
  else if(state.view==='users')content=renderUsers();
  else content=renderBookings();
  main.innerHTML=`${state.error?`<div class="error-banner" role="alert">${esc(state.error)} <button class="subtle compact" data-action="refresh">Повторить</button></div>`:''}${state.loading?'<div class="loading-line" role="status">Загружаем данные…</div>':''}${content}${renderSync()}`;
  if(savedFocus)document.getElementById(savedFocus)?.focus();
}

function renderSync() {
  if(!isAdmin()||!state.sync)return '';
  const sync=state.sync;
  if(sync.loadError)return `<div class="connection-note" role="status">Не удалось проверить синхронизацию: ${esc(sync.loadError)}</div>`;
  if(Number(sync.errors||sync.error)>0)return `<div class="error-banner" role="alert" style="margin-top:18px">Изменения сохранены в базе букинга. Ошибок синхронизации Google Sheets: ${Number(sync.errors||sync.error)}.${sync.lastError?` ${esc(sync.lastError)}`:''}</div>`;
  if(!sync.enabled)return '<div class="connection-note">Google Sheets не подключён. Изменения сохраняются в базе букинга.</div>';
  return `<div class="connection-note">Google Sheets: ${Number(sync.pending)>0?`ожидают синхронизации ${Number(sync.pending)} изменений`:'очередь синхронизации пуста'}.</div>`;
}

function renderBookingToolbar() {
  const today=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long'}).format(new Date());
  if(state.view==='completed')return `<div class="toolbar booking-toolbar"><h2 class="view-date">Сегодня, ${esc(today)}</h2><span class="spacer"></span><label class="toolbar-label" for="completed-from">Дата МК от</label><input type="date" id="completed-from" aria-label="Дата МК от" value="${esc(state.completedFrom)}"><label class="toolbar-label" for="completed-to">до</label><input type="date" id="completed-to" aria-label="Дата МК до" value="${esc(state.completedTo)}"><button class="icon-button" data-action="refresh" aria-label="Обновить список">↻</button></div>`;
  return `<div class="toolbar booking-toolbar"><h2 class="view-date">Сегодня, ${esc(today)}</h2><span class="spacer"></span><label class="toolbar-label" for="booking-date">Дата МК</label><input type="date" id="booking-date" aria-label="Дата мастер-класса" value="${esc(state.date)}">${state.date?'<button class="subtle compact" data-action="all-dates">Все даты</button>':''}<button class="secondary compact" data-action="today">Сегодня</button>${canCreate()&&state.view!=='trash'?`<button class="primary" data-action="create">+ Записать на мастер-класс</button>`:''}<button class="icon-button" data-action="refresh" aria-label="Обновить список">↻</button></div>`;
}

function ageGroup(age) {return ageGroups.find(group=>{const [min,max]=group.split('-').map(Number);return Number(age)>=min&&Number(age)<=max;})||'';}
function ageBadge(age) {const group=ageGroup(age);return age?`<span class="age-tag" data-group="${group}">${esc(group||`${age} лет`)}</span>`:'';}
function studentName(booking) {return String(booking.studentName||'').trim()||'Имя не указано';}
function studentAge(booking) {return booking.age == null || booking.age === '' ? 'Возраст не указан' : `${Number(booking.age)} лет`;}
function legacyBadges(booking) {
  if(!booking.legacy)return '';
  const missing=booking.legacy.missingFields?.length>0;
  return `<div class="legacy-badges"><span class="legacy-badge" title="Запись из прежнего букинга">Перенесено</span>${missing?'<span class="legacy-badge incomplete">Данные неполные</span>':''}</div>`;
}
function detailsButton(booking) {return canEditDetails(state.user,booking)?`<button class="subtle compact" data-action="details" data-id="${esc(booking.id)}">${booking.legacy?'Дополнить данные':'Изменить данные'}</button>`:'';}
function resolveLegacyButton(booking) {return canResolveLegacy(state.user,booking)?`<button class="outline compact" data-action="resolve-legacy" data-id="${esc(booking.id)}">Уточнить итог</button>`:'';}
function bookingEquipment(booking) {
  return `${booleanFact(booking.hasPc,'Компьютер есть','Без компьютера','Компьютер: не указано')} · ${booleanFact(booking.parentPresent,'Родитель будет','Родитель не будет','Участие родителя: не указано')}`;
}
function externalLink(url,label,className='link-line') {const safe=safeUrl(url);return safe?`<a class="${esc(className)}" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:'';}
function statusBadge(booking) {
  if(booking.state==='completed')return '<span class="status completed">Мастер-класс проведён</span>';
  if(booking.state==='cancelled')return '<span class="status cancelled">Мастер-класс отменён</span>';
  if(booking.state==='in_progress')return '<span class="status in_progress">Мастер-класс идёт</span>';
  if(legacyOutcomeUnknown(booking))return '<span class="status pending">Итог не уточнён</span>';
  if(booking.assignmentKind==='reserve')return '<span class="status reserve">Резерв</span>';
  return booking.confirmationStatus==='confirmed'?'<span class="status confirmed">Подтверждён</span>':'<span class="status pending">Ожидает подтверждения</span>';
}

function renderBookings() {
  let bookings=state.bookings.filter(booking=>matchesSearch(booking,state.search));
  if(state.view==='confirmation')bookings=bookings.filter(booking=>booking.confirmationStatus!=='confirmed'&&booking.state==='scheduled').sort((a,b)=>String(a.confirmationDueAt).localeCompare(String(b.confirmationDueAt)));
  const toolbar=renderBookingToolbar();
  const confirmationNote=state.view==='confirmation'?'<div class="notice">Подтверждайте запись заранее. Крайний срок — за 2 часа до начала мастер-класса. Просроченная запись остаётся в очереди.</div>':'';
  if(!bookings.length)return `${toolbar}${confirmationNote}<div class="empty"><strong>${state.loading?'Загружаем мастер-классы':'Нет мастер-классов'}</strong>${state.search?'По вашему запросу ничего не найдено.':state.view==='confirmation'?'Все доступные записи обработаны.':state.view==='trash'?'Отменённые записи появятся здесь.':'Измените дату или дождитесь новых записей.'}</div>`;
  return `${toolbar}${confirmationNote}<div class="table-wrap"><table class="booking-table${state.view==='completed'?' completed-table':''}"><thead><tr><th>Ученик</th><th>Дата</th><th>Дополнительно</th><th>Статус</th><th>${state.view==='completed'?'':'Отчёт'}</th></tr></thead><tbody>${bookings.map(bookingRow).join('')}</tbody></table></div><div class="results-count">Записей: ${bookings.length}</div>`;
}

function bookingRow(booking) {
  const cancelled=booking.state==='cancelled';
  const completed=booking.state==='completed';
  const canActSales=isSales()&&booking.assignedTo===state.user.id;
  let actions='';
  if(cancelled){actions=`<div class="status-text cancelled">Отменён</div><div class="cancel-detail">${esc(booking.cancelReason||'')}</div>${!isSales()?`<button class="subtle compact" data-action="restore" data-id="${esc(booking.id)}">Восстановить запись</button>`:''}`;}
  else if(completed){actions='<div class="status-text">Завершён</div>';}
  else if(legacyOutcomeUnknown(booking)){actions=`${statusBadge(booking)}${resolveLegacyButton(booking)}<div class="status-note">В прежнем букинге итог не зафиксирован.${isAdmin()?'':' Его уточняет администратор.'}</div>`;}
  else if(booking.state==='in_progress') {actions=`${statusBadge(booking)}${canActSales?`<button class="primary" data-action="complete" data-id="${esc(booking.id)}">Завершить мастер-класс</button>`:''}`;}
  else if(canActSales&&booking.confirmationStatus==='confirmed'&&booking.assignmentKind==='primary') {actions=`<button class="primary" data-action="start" data-id="${esc(booking.id)}">Начать мастер-класс</button><button class="secondary" data-action="no-show" data-id="${esc(booking.id)}">Ученик не пришёл</button>`;}
  else {actions=statusBadge(booking);if(canConfirm()&&booking.confirmationStatus!=='confirmed')actions+=`<button class="primary compact" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить запись</button>`;if(['confirmation','call_center','admin'].includes(state.user.role))actions+=`<button class="subtle compact" data-action="cancel" data-id="${esc(booking.id)}">Отменить запись</button>`;}
  const timing=confirmationTiming(booking);
  const deadline=booking.confirmationStatus!=='confirmed'&&!cancelled&&!completed&&!legacyOutcomeUnknown(booking)?`<div class="status-note"${timing.overdue?' style="color:#c3656e"':''}>${timing.overdue?'Срок подтверждения истёк':'Подтвердить до'} ${timeStamp(booking.confirmationDueAt)}</div>`:'';
  const phone=String(booking.phone||'').replace(/[^+\d]/g,'');
  return `<tr><td><span class="student-name">${esc(studentName(booking))}</span>${legacyBadges(booking)}<div class="booking-extra">${esc(bookingEquipment(booking))}</div>${booking.age==null?'<div class="status-note">Возраст не указан</div>':ageBadge(booking.age)}${booking.comment?`<div class="booking-note">${esc(booking.comment)}</div>`:''}</td><td><span class="nowrap">${dateText(booking.date)}</span><br>${esc(booking.time)}<div class="status-note">60 минут</div>${booking.assignmentKind?`<div class="status-note">${booking.assignmentKind==='reserve'?'Резерв':'Основная запись'}</div>`:''}</td><td>${externalLink(booking.backofficeUrl||state.config.backofficeUrl,'Перейти в Backoffice')}${externalLink(booking.crmUrl,'Перейти в Amo CRM')}<div>Родитель: ${esc(booking.parentName||'Не указано')}</div>${phone?`<a class="link-line" href="tel:${esc(phone)}">${esc(booking.phone)}</a>`:'<div class="status-note">Телефон не указан</div>'}${booking.assignedName?`<div class="status-note">МИМК: ${esc(booking.assignedName)}</div>`:booking.legacy?.managerName?`<div class="status-note">МИМК в прежнем букинге: ${esc(booking.legacy.managerName)}</div>`:''}${detailsButton(booking)}${isAdmin()&&!cancelled&&!legacyOutcomeUnknown(booking)?`<button class="subtle compact" data-action="assignment" data-id="${esc(booking.id)}">${booking.assignedTo?'Изменить назначение':'Назначить МИМК'}</button>`:''}</td><td><div class="button-stack">${actions}</div>${deadline}</td><td>${canReport()&&completed?`<button class="report-button" data-action="report" data-id="${esc(booking.id)}" aria-label="${booking.report?'Открыть':'Заполнить'} отчёт о занятии ${esc(studentName(booking))}">${icon('document')}</button><div class="status-note">${booking.report?'Заполнен':'Не заполнен'}</div>`:booking.report?'<span class="status-note">Заполнен</span>':'<span class="muted">—</span>'}</td></tr>`;
}

function renderAdmin() {
  const headers=['Время слота','Количество МИМК','Количество слотов с Overbooking','Записано всего лидов на слот',"Записано лидов по правилу Overbooking’a",'МК Подтверждённые за час','МК отменённые М1','МК отменённые МИМК','Успешные МК'];
  const hours=state.hours.length?state.hours:Array.from({length:12},(_,i)=>({time:`${String(i+10).padStart(2,'0')}:00`}));
  return `<div class="toolbar"><input type="date" id="admin-date" aria-label="Дата статистики" value="${esc(state.adminDate)}"><select id="admin-tag" aria-label="Фильтр по возрастному тегу"><option value="">Теги</option>${ageGroups.map(group=>`<option${selected(state.tag,group)}>${group}</option>`).join('')}</select><span class="spacer"></span><button class="primary" data-action="create">+ Записать на мастер-класс</button><button class="icon-button" data-action="refresh" aria-label="Обновить статистику">↻</button></div><div class="table-wrap"><table class="stats-table"><thead><tr>${headers.map(header=>`<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${hours.map(hour=>`<tr data-action="hour" data-time="${esc(hour.time)}"><td><button class="hour-button" data-action="hour" data-time="${esc(hour.time)}" aria-label="Записи на ${esc(hour.time)}">${esc(hour.time)}</button></td><td>${Number(hour.managers||0)}</td><td>${Number(hour.capacity||0)}</td><td class="${Number(hour.total||0)>Number(hour.capacity||0)?'over':Number(hour.total||0)>0?'within':''}">${Number(hour.total||0)}</td><td>${Number(hour.reserve||0)}</td><td class="${isHourOverloaded(hour)?'over':''}">${Number(hour.confirmed||0)}</td><td>${Number(hour.cancelledConfirmation||0)}</td><td>${Number(hour.cancelledSales||0)}</td><td>${Number(hour.completed||0)}</td></tr>`).join('')}</tbody></table></div><div class="stats-footer"><span>Нажмите на час, чтобы открыть записи и назначения.</span><span>Записано: <strong>${hours.reduce((sum,hour)=>sum+Number(hour.total||0),0)}</strong></span><span>Подтверждено: <strong>${hours.reduce((sum,hour)=>sum+Number(hour.confirmed||0),0)}</strong></span></div>`;
}

function scheduleDraftKey() {return `schedule.${state.managerId}.${weekDates(state.week)[0]}`;}
function persistSchedule() {drafts.save(scheduleDraftKey(),state.scheduleDraft);}

function scheduleInterval(interval,index,day) {
  const common=`data-schedule-date="${day.date}" data-index="${index}"`;
  const capacity=effectiveReserveCapacity(interval,day);
  return `<div class="interval interval-with-reserve"><div class="interval-time"><input type="time" step="3600" value="${esc(interval.start)}" aria-label="Начало рабочего интервала ${dateText(day.date)}" ${common} data-field="start"><span>–</span><input type="time" step="3600" value="${esc(interval.end)}" aria-label="Конец рабочего интервала ${dateText(day.date)}" ${common} data-field="end"><button class="remove-interval" data-action="remove-interval" data-date="${day.date}" data-index="${index}" aria-label="Удалить интервал">×</button></div><label class="interval-reserve">Резервных мест<select ${common} data-field="intervalReserveCapacity" aria-label="Резерв в интервале ${esc(interval.start)}–${esc(interval.end)} ${dateText(day.date)}"><option value="0"${selected(capacity,0)}>0</option><option value="1"${selected(capacity,1)}>1</option></select></label></div>`;
}

function renderSchedule() {
  if(!state.managerId)return '<div class="empty"><strong>Нет менеджеров мастер-классов</strong>Добавьте сотрудника с ролью менеджера, чтобы настроить расписание.</div>';
  const dates=weekDates(state.week);
  const manager=state.managers.find(manager=>manager.id===state.managerId)||state.user;
  const schedule=state.scheduleDraft;
  if(!schedule)return '<div class="loading-line">Загружаем расписание…</div>';
  return `${isAdmin()?`<div class="toolbar"><label class="toolbar-label" for="schedule-manager">МИМК</label><select id="schedule-manager">${state.managers.map(manager=>`<option value="${esc(manager.id)}"${selected(state.managerId,manager.id)}>${esc(manager.name)}</option>`).join('')}</select></div>`:''}${state.scheduleConflict?'<div class="error-banner" role="alert">Расписание изменилось на сервере. Черновик сохранён. <button class="subtle compact" data-action="reset-schedule">Сбросить черновик и загрузить актуальное</button></div>':''}<div class="schedule-wrap"><section class="schedule-panel"><h2 class="schedule-heading">${esc(manager.name)}</h2><div class="tag-toolbar"><h3>Теги:</h3>${schedule.ageGroups.map(group=>`<span class="age-tag" data-group="${esc(group)}">${esc(group)}<button type="button" data-action="remove-tag" data-tag="${esc(group)}" aria-label="Убрать возраст ${esc(group)}">×</button></span>`).join('')}<div class="tag-choice"><select id="age-tag-choice" aria-label="Добавить возрастной тег"><option value="">Добавить тег</option>${ageGroups.filter(group=>!schedule.ageGroups.includes(group)).map(group=>`<option>${group}</option>`).join('')}</select><button class="tag-add" data-action="add-tag" aria-label="Добавить выбранный тег">+</button></div></div><div class="week-nav"><button class="subtle" data-action="previous-week">Предыдущая</button><strong>Текущая неделя: ${dateShort(dates[0])} – ${dateText(dates[6])}</strong><button class="subtle" data-action="next-week">Следующая</button></div>${dates.map((date,index)=>{
    const day=schedule.days.find(day=>day.date===date)||{date,intervals:[]};
    const enabled=day.intervals.length>0;
    return `<div class="schedule-day${enabled?'':' off'}"><div class="day-name">${['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'][index]}<small>${dateText(date)}</small></div><button type="button" class="switch" role="switch" aria-checked="${enabled}" aria-label="Рабочий день ${dateText(date)}" data-action="toggle-day" data-date="${date}"></button><div><div class="intervals">${day.intervals.map((interval,intervalIndex)=>scheduleInterval(interval,intervalIndex,day)).join('')}<button class="add-hours" data-action="add-interval" data-date="${date}">Добавить<br>часы работы</button></div>${enabled?`<label class="reserve-field">Резерв по умолчанию<select data-schedule-date="${date}" data-field="reserveCapacity" aria-label="Установить резерв во всех интервалах ${dateText(date)}"><option value="0"${selected(day.reserveCapacity??1,0)}>0</option><option value="1"${selected(day.reserveCapacity??1,1)}>1</option></select><span class="field-hint">Изменение заменит резерв в каждом интервале дня.</span></label>`:''}</div></div>`;
  }).join('')}<div class="schedule-description">Рабочий интервал включает начало и исключает конец. Интервал 20:00–21:00 позволяет провести занятие в 20:00. Без тегов доступны все возрасты.</div><div class="schedule-save"><span class="dirty-note" id="schedule-dirty">${drafts.read(scheduleDraftKey()).days?'Есть сохранённый черновик':''}</span><button class="primary" data-action="save-schedule"${state.scheduleConflict?' disabled':''}>Сохранить расписание</button></div></section></div>`;
}

function renderUsers() {
  const users=state.users.filter(user=>matchesSearch({studentName:user.name,parentName:user.email},state.search));
  return `<div class="toolbar"><span class="toolbar-label">Доступ сотрудников к букингу</span><span class="spacer"></span><button class="primary" data-action="create-user">+ Добавить сотрудника</button></div>${users.length?`<div class="table-wrap"><table class="users-table"><thead><tr><th>Сотрудник</th><th>Почта</th><th>Роль</th><th>Статус</th><th></th></tr></thead><tbody>${users.map(user=>`<tr><td>${esc(user.name)}</td><td>${esc(user.email)}</td><td>${esc(roles[user.role]||user.role)}</td><td><span class="status${user.active?' confirmed':' cancelled'}">${user.active?'Активен':'Отключён'}</span></td><td><button class="subtle compact" data-action="edit-user" data-id="${esc(user.id)}">Изменить</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Сотрудники не найдены.</div>'}`;
}

function showDialog(title,body,{footer='',name='',bookingId='',version=''}={}) {
  lastFocus=document.activeElement;
  dialog.innerHTML=`<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2><button class="close-dialog" data-action="close-dialog" aria-label="Закрыть">×</button></div>${body}${footer?`<div class="dialog-footer">${footer}</div>`:''}`;
  dialog.dataset.name=name;dialog.dataset.bookingId=bookingId;dialog.dataset.version=version;
  if(!dialog.open)dialog.showModal();
  const error=dialog.querySelector('.form-error');if(error)error.textContent='';
}

function formField(name,label,value='',{type='text',required=false,full=false,options=null,min,max,step,placeholder,readOnly=false}={}) {
  const attrs=`name="${esc(name)}"${required?' required':''}${min!==undefined?` min="${esc(min)}"`:''}${max!==undefined?` max="${esc(max)}"`:''}${step!==undefined?` step="${esc(step)}"`:''}${placeholder?` placeholder="${esc(placeholder)}"`:''}${readOnly?' readonly':''}`;
  const input=options?`<select ${attrs}>${options.map(option=>{const item=typeof option==='string'?{value:option,label:option}:option;return `<option value="${esc(item.value)}"${selected(value,item.value)}>${esc(item.label)}</option>`;}).join('')}</select>`:type==='textarea'?`<textarea ${attrs}>${esc(value)}</textarea>`:`<input type="${esc(type)}" ${attrs} value="${fieldValue(value)}">`;
  return `<label class="field${full?' full':''}">${esc(label)}${input}</label>`;
}

function serializeForm(form) {
  const values=Object.fromEntries(new FormData(form));
  form.querySelectorAll('input[type=checkbox][name]').forEach(input=>{values[input.name]=input.checked;});
  return values;
}

function persistForm(form) {
  if(!drafts||!form?.dataset.draft)return;
  const values=serializeForm(form);delete values.password;
  drafts.save(form.dataset.draft,form.id==='details-form'?{changes:changedDetails(detailSnapshots.get(form)||{},values)}:values);
}

function openCreate() {
  const draft=drafts.read('create');
  if(!draft.idempotencyKey){draft.idempotencyKey=crypto.randomUUID();drafts.save('create',draft);}
  const date=draft.date||state.date||state.adminDate||businessDate();
  showDialog('Запись на мастер-класс',`<form id="create-form" data-draft="create"><div class="dialog-body">${formError()}<div class="form-grid">${formField('date','Дата',date,{type:'date',required:true,min:businessDate()})}${formField('age','Возраст ученика',draft.age||'',{type:'number',required:true,min:1,max:18})}<label class="field full">Время мастер-класса<select name="time" id="create-time" required><option value="">Загружаем свободное время…</option></select><span class="field-hint" id="slots-hint">Доступность зависит от возраста и расписания МИМК.</span></label>${formField('studentName','Имя ученика',draft.studentName,{required:true})}${formField('parentName','Имя родителя',draft.parentName,{required:true})}${formField('phone','Телефон родителя',draft.phone,{type:'tel',required:true,placeholder:'+7 999 123-45-67'})}${formField('crmUrl','Ссылка на сделку Amo CRM',draft.crmUrl,{type:'url',required:true,placeholder:'https://…'})}<label class="check-field"><input type="checkbox" name="hasPc"${checked(draft.hasPc)}>У ученика есть компьютер</label><label class="check-field"><input type="checkbox" name="parentPresent"${checked(draft.parentPresent)}>Родитель будет на занятии</label>${formField('comment','Комментарий',draft.comment,{type:'textarea',full:true})}<input name="idempotencyKey" type="hidden" value="${esc(draft.idempotencyKey)}"></div></div><div class="dialog-footer"><span class="small">Черновик сохраняется автоматически</span><button type="button" class="secondary" data-action="close-dialog">Отмена</button><button class="primary" type="submit">Записать</button></div></form>`,{name:'create'});
  loadSlots(draft.time);
}

let slotRequest=0;
async function loadSlots(preferredTime) {
  const form=dialog.querySelector('#create-form');if(!form)return;
  const select=form.elements.time;
  const hint=form.querySelector('#slots-hint');
  const desired=preferredTime||select.value||drafts.read('create').time;
  const request=++slotRequest;
  const date=form.elements.date.value;
  const age=form.elements.age.value;
  select.disabled=true;select.innerHTML='<option value="">Загружаем свободное время…</option>';
  try {
    if(!date){select.innerHTML='<option value="">Сначала выберите дату</option>';return;}
    const result=await api(`/slots?${new URLSearchParams({date,...(age?{age}:{})})}`);
    if(request!==slotRequest||!dialog.querySelector('#create-form'))return;
    const slots=(result.slots||[]).filter(slot=>Number(slot.remaining)>0);
    select.innerHTML=`<option value="">${slots.length?'Выберите время':'Нет свободного времени'}</option>${slots.map(slot=>`<option value="${esc(slot.time)}"${selected(desired,slot.time)}>${esc(slot.time)} · свободно ${Number(slot.remaining)}</option>`).join('')}`;
    hint.textContent=slots.length?'Занятие длится 60 минут. Вместимость проверяется при записи.':'На эту дату нет свободных мест. Выберите другую дату.';
  } catch(error) {if(request===slotRequest){select.innerHTML='<option value="">Не удалось загрузить время</option>';hint.textContent=error.message;}}
  finally {if(request===slotRequest)select.disabled=false;}
}

function getBooking(id) {return state.bookings.find(booking=>booking.id===id);}

function openDetails(booking) {
  if(!booking||!canEditDetails(state.user,booking))return;
  const name=`details.${booking.id}`;
  const initial=structuredClone(booking);
  const values={...initial,...(drafts.read(name).changes||{})};
  const triValue=value=>value===true?'true':value===false?'false':'';
  const triOptions=field=>[...(initial[field]==null?[{value:'',label:'Не указано'}]:[]),{value:'true',label:'Да'},{value:'false',label:'Нет'}];
  showDialog(booking.legacy?'Дополнить данные':'Данные ученика и родителя',`<form id="details-form" data-draft="${esc(name)}"><div class="dialog-body">${formError()}<div class="readonly-facts"><span>Занятие: <strong>${dateText(booking.date)} · ${esc(booking.time)}</strong></span><span>МИМК: <strong>${esc(booking.assignedName||'Не указан')}</strong></span></div>${booking.legacy?'<div class="notice">В прежнем букинге сохранились не все сведения. Заполните известные данные. Неизвестные поля можно оставить без изменений.</div>':'<p class="report-header-note">Здесь можно исправить контакты и сведения об ученике. Дата, время и назначение МИМК сохраняются.</p>'}<div class="form-grid">${formField('studentName','Имя ученика',values.studentName,{required:Boolean(initial.studentName),placeholder:'Не указано'})}${formField('parentName','Имя родителя',values.parentName,{required:Boolean(initial.parentName),placeholder:'Не указано'})}${formField('phone','Телефон родителя',values.phone,{type:'tel',required:Boolean(initial.phone),placeholder:'Не указано'})}${formField('crmUrl','Ссылка на сделку Amo CRM',values.crmUrl,{type:'url',required:Boolean(initial.crmUrl),placeholder:'Не указано'})}${formField('age','Возраст ученика',values.age,{type:'number',required:initial.age!=null,min:1,max:18})}${formField('hasPc','У ученика есть компьютер',triValue(values.hasPc),{options:triOptions('hasPc')})}${formField('parentPresent','Родитель будет на занятии',triValue(values.parentPresent),{options:triOptions('parentPresent')})}${formField('comment','Комментарий',values.comment,{type:'textarea',full:true})}</div></div><div class="dialog-footer"><span class="small">Черновик сохраняется автоматически</span><button type="button" class="secondary" data-action="close-dialog">Закрыть</button><button type="submit" class="primary">Сохранить данные</button></div></form>`,{name:'details',bookingId:booking.id,version:booking.version});
  detailSnapshots.set(dialog.querySelector('#details-form'),initial);
}

function updateLegacyOutcomeFields() {
  const form=dialog.querySelector('#resolve-legacy-form');if(!form)return;
  const completed=form.elements.outcome.value==='completed';
  const manager=form.elements.managerId;
  manager.required=completed;manager.disabled=!completed;
  manager.closest('.field').hidden=!completed;
}

function openResolveLegacy(booking) {
  if(!canResolveLegacy(state.user,booking))return;
  const name=`resolve-legacy.${booking.id}`;
  const values=drafts.read(name);
  showDialog('Уточнить итог мастер-класса',`<form id="resolve-legacy-form" data-draft="${esc(name)}"><div class="dialog-body">${formError()}<p class="report-header-note">${esc(studentName(booking))} · ${dateText(booking.date)} · ${esc(booking.time)}</p><div class="notice">В прежнем букинге итог этого занятия не зафиксирован. Укажите фактический итог и основание. Прошедшая дата сама по себе не означает отмену.</div><div class="form-grid">${formField('outcome','Фактический итог',values.outcome||'',{required:true,full:true,options:[{value:'',label:'Выберите итог'},{value:'completed',label:'Фактически проведён'},{value:'cancelled',label:'Не состоялся'}]})}${formField('managerId','МИМК, который фактически провёл занятие',values.managerId||'',{full:true,options:[{value:'',label:'Выберите МИМК'},...state.managers.map(manager=>({value:manager.id,label:manager.name}))]})}${formField('reason','На основании чего уточнили итог',values.reason||'',{type:'textarea',required:true,full:true})}</div><p class="field-hint">Для проведённого занятия сервер проверит расписание МИМК, возраст и пересечения. После сохранения можно заполнить отчёт.</p></div><div class="dialog-footer"><span class="small">Итог сохранится в истории изменений</span><button type="button" class="secondary" data-action="close-dialog">Назад</button><button type="submit" class="primary">Сохранить итог</button></div></form>`,{name:'resolve-legacy',bookingId:booking.id,version:booking.version});
  updateLegacyOutcomeFields();
}

function openCancel(booking,noShow=false) {
  if(!booking)return;
  showDialog(noShow?'Ученик не пришёл':'Отмена мастер-класса',`<form id="cancel-form"><div class="dialog-body">${formError()}<p class="report-header-note">${esc(studentName(booking))} · ${dateText(booking.date)} · ${esc(booking.time)}</p>${formField('reason','Причина отмены',noShow?'Ученик не пришёл':'',{type:'textarea',required:true,full:true,readOnly:noShow})}<p class="field-hint">Запись останется в истории. Администратор сможет восстановить её при наличии места.</p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close-dialog">Назад</button><button type="submit" class="danger">Отменить мастер-класс</button></div></form>`,{name:'cancel',bookingId:booking.id,version:booking.version});
}

function openReport(booking) {
  if(!booking)return;
  const name=`report.${booking.id}`;
  const values={...(booking.report||{}),...drafts.read(name)};
  const facts=`<div class="readonly-facts"><span>Ученик: <strong>${esc(studentName(booking))}</strong></span><span>Дата: <strong>${dateText(booking.date)} ${esc(booking.time)}</strong></span><span>МИМК: <strong>${esc(booking.assignedName||'Не указан')}</strong></span><span>Возраст: <strong>${esc(studentAge(booking))}</strong></span></div>`;
  const fields=formField('practice','Практика / направление',values.practice,{required:true})+formField('package','Пакет',values.package,{required:true})+formField('paymentMethod','Способ оплаты',values.paymentMethod,{required:true})+formField('agreement','Договорённость',values.agreement,{required:true})+formField('objection','Возражение',values.objection)+formField('channel','Канал',values.channel,{required:true})+formField('amountNet','Сумма нетто, ₽',values.amountNet??'',{type:'number',min:0,step:'0.01',required:true})+formField('recordingUrl','Ссылка на запись',values.recordingUrl,{type:'url'});
  showDialog('Отчёт о мастер-классе',`<form id="report-form" data-draft="${esc(name)}"><div class="dialog-body">${formError()}${facts}<div class="report-header-note">Дата, время, МИМК и ссылка Amo CRM подставляются из записи. Повторное сохранение обновляет этот же отчёт.</div><div class="form-grid">${fields}</div><p class="field-hint" style="margin-top:18px">Сумма в отчёте фиксирует итог занятия. Финансовые платежи учитываются отдельно.</p></div><div class="dialog-footer"><span class="small">Черновик сохраняется автоматически</span><button type="button" class="secondary" data-action="close-dialog">Закрыть</button><button type="submit" class="primary">Сохранить отчёт</button></div></form>`,{name:'report',bookingId:booking.id,version:booking.version});
}

function assignmentForm(booking) {
  return `<form class="assign-form" data-booking-id="${esc(booking.id)}" data-version="${Number(booking.version)}">${formError()}<select name="managerId" aria-label="Менеджер мастер-класса" required><option value="">Выберите МИМК</option>${state.managers.map(manager=>`<option value="${esc(manager.id)}"${selected(booking.assignedTo,manager.id)}>${esc(manager.name)}</option>`).join('')}</select><select name="kind" aria-label="Тип назначения"><option value="primary"${selected(booking.assignmentKind,'primary')}>Основной</option><option value="reserve"${selected(booking.assignmentKind,'reserve')}>Резерв</option></select><button class="primary" type="submit">${booking.assignedTo?'Переназначить':'Назначить'}</button></form>`;
}

function openHour(time,oneBooking) {
  const bookings=oneBooking?[oneBooking]:filterHourBookings(state.bookings,{time,tag:state.tag,search:state.search});
  const rows=bookings.map(booking=>{
    const ordinaryScheduled=booking.state==='scheduled'&&!legacyOutcomeUnknown(booking);
    const phone=String(booking.phone||'').replace(/[^+\d]/g,'');
    const contacts=`<div style="margin-top:8px">Родитель: ${esc(booking.parentName||'Не указано')}</div>${phone?`<a class="link-line" href="tel:${esc(phone)}">${esc(booking.phone)}</a>`:'<div class="status-note">Телефон не указан</div>'}<div class="booking-extra">${esc(bookingEquipment(booking))}</div>`;
    const actions=`${detailsButton(booking)}${resolveLegacyButton(booking)}${ordinaryScheduled&&booking.confirmationStatus!=='confirmed'?`<button class="outline compact" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить</button>`:''}${ordinaryScheduled?`<button class="subtle compact" data-action="cancel" data-id="${esc(booking.id)}">Отменить запись</button>`:''}${booking.state==='completed'?`<button class="subtle compact" data-action="report" data-id="${esc(booking.id)}">${booking.report?'Открыть':'Заполнить'} отчёт</button>`:''}<button class="subtle compact" data-action="audit" data-id="${esc(booking.id)}">История изменений</button>`;
    return `<article class="drawer-booking" data-id="${esc(booking.id)}"><div class="drawer-booking-top"><div><span class="student-name">${esc(studentName(booking))}</span>${legacyBadges(booking)}<div class="small">${dateText(booking.date)} · ${esc(booking.time)} · ${esc(studentAge(booking))}</div>${contacts}${externalLink(booking.crmUrl,'Перейти в Amo CRM')}${externalLink(booking.backofficeUrl||state.config.backofficeUrl,'Перейти в Backoffice')}${booking.legacy?.managerName?`<div class="status-note">МИМК в прежнем букинге: ${esc(booking.legacy.managerName)}</div>`:''}</div><div>${statusBadge(booking)}<div class="status-note">${esc(booking.assignedName||'МИМК не назначен')}</div></div></div>${legacyOutcomeUnknown(booking)?'<p class="status-note">В прежнем букинге итог не зафиксирован. Требуется проверка администратора.</p>':''}${ordinaryScheduled?assignmentForm(booking):''}<div class="drawer-actions">${actions}</div></article>`;
  }).join('');
  showDialog(oneBooking?'Назначение МИМК':`Мастер-классы · ${dateText(state.adminDate)} · ${time}`,`<div class="dialog-body">${rows||'<div class="empty">На этот час нет записей.</div>'}</div>`,{name:oneBooking?'assignment':'hour',bookingId:oneBooking?.id||''});
  dialog.dataset.hour=time||oneBooking?.time||'';
}

function openUser(user) {
  const existing=Boolean(user);
  user=user||{name:'',email:'',role:'sales',active:true,ageGroups:[]};
  showDialog(existing?'Редактирование сотрудника':'Новый сотрудник',`<form id="user-form"><div class="dialog-body">${formError()}<div class="form-grid">${formField('name','Имя и фамилия',user.name,{required:true})}${formField('email','Рабочая почта',user.email,{type:'email',required:true,readOnly:existing})}${formField('role','Роль',user.role,{options:Object.entries(roles).map(([value,label])=>({value,label}))})}${formField('password',existing?'Новый пароль · необязательно':'Пароль', '',{type:'password',required:!existing,min:undefined})}<div class="field full">Возрастные группы МИМК<div class="tag-choice">${ageGroups.map(group=>`<label class="check-field"><input type="checkbox" name="age_${group}"${checked(user.ageGroups?.includes(group))}>${group}</label>`).join('')}</div></div>${existing?`<label class="check-field"><input type="checkbox" name="active"${checked(user.active)}>Активный доступ</label>`:''}</div><p class="field-hint" style="margin-top:20px">Пустой список возрастов открывает все возрастные группы. Пароль хранится только на сервере.</p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close-dialog">Отмена</button><button type="submit" class="primary">${existing?'Сохранить':'Добавить сотрудника'}</button></div></form>`,{name:'user'});
  dialog.dataset.userId=existing?user.id:'';
  const password=dialog.querySelector('[name=password]');password.autocomplete='new-password';password.minLength=10;
}

async function mutateBooking(id,action,body={},version) {
  const booking=getBooking(id);
  if(!booking&&version===undefined)throw new Error('Запись больше не доступна. Обновите список.');
  const result=await api(`/bookings/${encodeURIComponent(id)}/${action}`,{method:['report','details'].includes(action)?'PUT':'POST',body:{...body,version:version??booking.version}});
  const index=state.bookings.findIndex(item=>item.id===id);
  if(index>=0)state.bookings[index]=result.booking;
  return result.booking;
}

async function performBookingAction(id,action) {
  const booking=getBooking(id);if(!booking)return;
  if(action==='report'){openReport(booking);return;}
  if(action==='details'){openDetails(booking);return;}
  if(action==='resolve-legacy'){openResolveLegacy(booking);return;}
  if(action==='cancel'||action==='no-show'){openCancel(booking,action==='no-show');return;}
  if(action==='assignment'){openHour(booking.time,booking);return;}
  const result=await mutateBooking(id,action);
  const messages={confirm:'Запись подтверждена',start:'Мастер-класс начат',complete:'Мастер-класс завершён. Заполните отчёт.',restore:'Запись восстановлена'};
  notify(messages[action]||'Запись обновлена');
  if(action==='complete')openReport(result);
  else if(dialog.open&&['hour','assignment'].includes(dialog.dataset.name))openHour(dialog.dataset.hour,dialog.dataset.name==='assignment'?result:null);
  await refresh({quiet:true});
}

async function saveSchedule(button) {
  if(!state.scheduleDraft)return;
  const schedule=structuredClone(state.scheduleDraft);
  const managerId=state.managerId;
  const draftKey=scheduleDraftKey();
  for(const day of schedule.days)for(const interval of day.intervals){if(!interval.start||!interval.end||interval.start>=interval.end)throw new Error(`Проверьте интервал ${dateText(day.date)}: конец должен быть позже начала.`);}
  button.disabled=true;button.textContent='Сохраняем…';
  try {
    for(const day of schedule.days){
      const result=await api('/schedule',{method:'PUT',body:schedulePayload(day,{managerId,ageGroups:schedule.ageGroups})});
      day.version=result.day.version;
      const local=drafts.read(draftKey);
      const storedDay=local.days?.find(stored=>stored.date===day.date);
      if(storedDay){storedDay.version=result.day.version;drafts.save(draftKey,local);}
      if(state.managerId===managerId){const current=state.scheduleDraft?.days.find(current=>current.date===day.date);if(current)current.version=result.day.version;}
    }
    if(JSON.stringify(drafts.read(draftKey))===JSON.stringify(schedule))drafts.remove(draftKey);
    notify('Расписание сохранено');await refresh({quiet:true});
  } finally {button.disabled=false;button.textContent='Сохранить расписание';}
}

async function handleAction(event) {
  const target=event.target.closest('[data-action],[data-view]');if(!target||target.disabled)return;
  if(target.dataset.view){event.preventDefault();await navigate(target.dataset.view);return;}
  const action=target.dataset.action;
  const id=target.dataset.id;
  const date=target.dataset.date;
  try {
    if(action==='close-dialog'){dialog.close();return;}
    if(action==='logout'){await api('/session/logout',{method:'POST',body:{}});state.events?.close();state.user=null;state.csrfToken='';renderLogin();return;}
    if(action==='refresh'){await refresh();return;}
    if(action==='create'){openCreate();return;}
    if(action==='all-dates'){state.date='';await refresh();return;}
    if(action==='today'){state.date=businessDate();await refresh();return;}
    if(action==='hour'){openHour(target.dataset.time);return;}
    if(action==='create-user'){openUser();return;}
    if(action==='edit-user'){openUser(state.users.find(user=>user.id===id));return;}
    if(action==='audit'){await openAudit(id);return;}
    if(action==='previous-week'||action==='next-week'){persistSchedule();state.week=addDays(state.week,action==='next-week'?7:-7);state.scheduleDraft=null;await refresh();return;}
    if(action==='save-schedule'){await saveSchedule(target);return;}
    if(action==='reset-schedule'){drafts.remove(scheduleDraftKey());state.scheduleDraft=null;state.scheduleConflict=false;await refresh();return;}
    if(action==='add-tag') {const tag=document.querySelector('#age-tag-choice').value;if(tag&&!state.scheduleDraft.ageGroups.includes(tag))state.scheduleDraft.ageGroups.push(tag);persistSchedule();renderContent();return;}
    if(action==='remove-tag') {state.scheduleDraft.ageGroups=state.scheduleDraft.ageGroups.filter(group=>group!==target.dataset.tag);persistSchedule();renderContent();return;}
    if(['toggle-day','add-interval','remove-interval'].includes(action)) {
      const day=state.scheduleDraft.days.find(day=>day.date===date);if(!day)return;
      if(action==='toggle-day'){if(day.intervals.length){day.disabledIntervals=day.intervals;day.intervals=[];}else day.intervals=day.disabledIntervals?.length?day.disabledIntervals:[{start:'10:00',end:'11:00'}];}
      if(action==='add-interval')day.intervals.push({start:'10:00',end:'11:00'});
      if(action==='remove-interval')day.intervals.splice(Number(target.dataset.index),1);
      persistSchedule();renderContent();return;
    }
    if(['confirm','start','complete','restore','cancel','no-show','report','assignment','details','resolve-legacy'].includes(action)) {target.disabled=true;try {await performBookingAction(id,action);}finally {target.disabled=false;}}
  } catch(error) {notify(error.message,true);if(error.status===409)await refresh({quiet:true});}
}

async function openAudit(id) {
  const result=await api(`/audit?bookingId=${encodeURIComponent(id)}`);
  const entries=result.audit||result.entries||result.events||[];
  showDialog('История изменений',`<div class="dialog-body"><ul class="audit-list">${entries.length?entries.map(entry=>`<li><div class="small">${timeStamp(entry.createdAt||entry.created_at)} · ${esc(entry.actorName||entry.actorId||entry.actor_id||'Система')}</div><strong>${esc(entry.action||entry.event||'Изменение')}</strong>${entry.reason?`<div>${esc(entry.reason)}</div>`:''}</li>`).join(''):'<li>История пока пуста.</li>'}</ul></div>`,{name:'audit',bookingId:id});
}

app.addEventListener('click',handleAction);
app.addEventListener('change',async event=>{
  const input=event.target;
  try {
    if(input.id==='booking-date'){state.date=input.value;await refresh();}
    if(input.id==='completed-from'){state.completedFrom=input.value;await refresh();}
    if(input.id==='completed-to'){state.completedTo=input.value;await refresh();}
    if(input.id==='admin-date'){state.adminDate=input.value||businessDate();await refresh();}
    if(input.id==='admin-tag'){state.tag=input.value;await refresh();}
    if(input.id==='schedule-manager'){if(state.scheduleDraft)persistSchedule();state.managerId=input.value;state.scheduleDraft=null;await refresh();}
  } catch(error){notify(error.message,true);}
});

app.addEventListener('input',event=>{
  const input=event.target;
  if(!input.dataset.scheduleDate||!state.scheduleDraft)return;
  const day=state.scheduleDraft.days.find(day=>day.date===input.dataset.scheduleDate);if(!day)return;
  if(input.dataset.field==='reserveCapacity')Object.assign(day,setDayReserveCapacity(day,input.value));
  else if(input.dataset.field==='intervalReserveCapacity'&&day.intervals[Number(input.dataset.index)])day.intervals[Number(input.dataset.index)].reserveCapacity=Number(input.value);
  else if(day.intervals[Number(input.dataset.index)])day.intervals[Number(input.dataset.index)][input.dataset.field]=input.value;
  persistSchedule();const note=document.querySelector('#schedule-dirty');if(note)note.textContent='Есть сохранённый черновик';
  if(input.dataset.field==='reserveCapacity')renderContent();
});

dialog.addEventListener('click',handleAction);
dialog.addEventListener('close',()=>{lastFocus?.isConnected&&lastFocus.focus();});
dialog.addEventListener('input',event=>{persistForm(event.target.closest('form'));});
dialog.addEventListener('change',event=>{
  const form=event.target.closest('form');persistForm(form);
  if(form?.id==='create-form'&&['date','age'].includes(event.target.name))loadSlots();
  if(form?.id==='resolve-legacy-form'&&event.target.name==='outcome')updateLegacyOutcomeFields();
});

dialog.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target;
  const errorBox=form.querySelector('.form-error');
  const button=event.submitter||form.querySelector('[type=submit]');
  if(button?.disabled)return;
  const oldText=button?.textContent;
  if(button){button.disabled=true;button.textContent='Сохраняем…';}
  if(errorBox)errorBox.textContent='';
  try {
    const values=serializeForm(form);
    if(form.id==='create-form') {
      persistForm(form);
      if(!values.time)throw new Error('Выберите свободное время мастер-класса.');
      await api('/bookings',{method:'POST',body:{...values,age:Number(values.age)}});
      drafts.remove('create');dialog.close();notify('Ученик записан на мастер-класс');await refresh({quiet:true});
    } else if(form.id==='cancel-form') {
      await mutateBooking(dialog.dataset.bookingId,'cancel',{reason:values.reason},Number(dialog.dataset.version));
      dialog.close();notify('Мастер-класс отменён');await refresh({quiet:true});
    } else if(form.id==='details-form') {
      const bookingId=dialog.dataset.bookingId;
      const version=Number(dialog.dataset.version);
      persistForm(form);
      const changes=changedDetails(detailSnapshots.get(form)||{},values);
      if(!Object.keys(changes).length)throw new Error('Нет изменений для сохранения. Неизвестные данные можно оставить незаполненными.');
      await mutateBooking(bookingId,'details',changes,version);
      drafts.remove(form.dataset.draft);dialog.close();notify('Данные записи обновлены');await refresh({quiet:true});
    } else if(form.id==='resolve-legacy-form') {
      const bookingId=dialog.dataset.bookingId;
      const version=Number(dialog.dataset.version);
      persistForm(form);
      if(!['completed','cancelled'].includes(values.outcome))throw new Error('Выберите фактический итог занятия.');
      if(!String(values.reason||'').trim())throw new Error('Укажите, на основании чего уточнили итог.');
      if(values.outcome==='completed'&&!values.managerId)throw new Error('Выберите МИМК, который фактически провёл занятие.');
      const updated=await mutateBooking(bookingId,'resolve-legacy',{outcome:values.outcome,reason:values.reason,...(values.outcome==='completed'?{managerId:values.managerId}:{})},version);
      drafts.remove(form.dataset.draft);dialog.close();notify('Фактический итог сохранён');await refresh({quiet:true});
      if(updated.state==='completed')openReport(updated);
    } else if(form.id==='report-form') {
      persistForm(form);
      await mutateBooking(dialog.dataset.bookingId,'report',{...values,amountNet:Number(values.amountNet)},Number(dialog.dataset.version));
      drafts.remove(form.dataset.draft);dialog.close();notify('Отчёт сохранён');await refresh({quiet:true});
    } else if(form.classList.contains('assign-form')) {
      const updated=await mutateBooking(form.dataset.bookingId,'assign',values,Number(form.dataset.version));
      notify('Назначение сохранено');
      const single=dialog.dataset.name==='assignment';
      await refresh({quiet:true});openHour(updated.time,single?updated:null);
    } else if(form.id==='user-form') {
      const id=dialog.dataset.userId;
      const body={name:values.name,role:values.role,ageGroups:ageGroups.filter(group=>values[`age_${group}`]),...(id?{active:Boolean(values.active)}:{email:values.email}),...(values.password?{password:values.password}:{})};
      await api(id?`/users/${encodeURIComponent(id)}`:'/users',{method:id?'PATCH':'POST',body});
      form.elements.password.value='';dialog.close();notify(id?'Доступ сотрудника обновлён':'Сотрудник добавлен');
      const result=await api('/bootstrap');state.managers=result.managers||[];await refresh({quiet:true});
    }
  } catch(error) {
    if(errorBox)errorBox.textContent=error.status===409?`${error.message} Закройте окно и откройте запись снова. Черновик сохранён.`:error.message;
    else notify(error.message,true);
    if(error.status===409)await refresh({quiet:true});
  } finally {if(button){button.disabled=false;button.textContent=oldText;}}
});

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.user)refresh({quiet:true});});
window.addEventListener('online',()=>{if(state.user)refresh({quiet:true});});
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(state.user&&view!==state.view&&allowedViews().includes(view))navigate(view);});

try {await bootstrap();} catch(error) {if(error.status===401)renderLogin();else app.innerHTML=`<main class="error-page" id="main"><h1>Не удалось открыть букинг</h1><p>${esc(error.message)}</p><button class="primary" id="retry-bootstrap">Повторить</button></main>`;document.querySelector('#retry-bootstrap')?.addEventListener('click',()=>location.reload());}
