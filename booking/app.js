import { businessDate, addDays, weekDates, safeUrl, matchesSearch, confirmationTiming, makeDraftStore, isHourOverloaded, filterHourBookings, booleanFact, legacyOutcomeUnknown, canResolveLegacy, canConfirmBooking, canAssignBooking, canRestoreBooking, legacyResolutionManagers, canEditDetails, changedDetails, effectiveReserveCapacity, setDayReserveCapacity, schedulePayload, selectableBookingSlots, isBookingSelectionAvailable, bookingDateRail, bookingIntervalEnd, bookingStatusPresentation, filterHourMetricBookings, rollingScheduleDates, scheduleHourEntries, setScheduleHour, unionScheduleWeek } from './core.mjs?v=operations-20261104-10';

const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
const notices = document.querySelector('#notifications');
const roles = {call_center:'Колл-центр',confirmation:'Подтверждение',sales:'МИМК',admin:'Администратор'};
const ageGroups = ['5-7','8-9','10-12','13-14'];
const ageFilterGroups = ['7','8','9','10','11','12','13','14','15','15+'];
const ageFilterTag = label => label === '15+' ? '15-18' : `${label}-${label}`;
const salesPackageOptions = ['1 месяц','3 месяца','6 месяцев','12 месяцев','1+1 (124к)'];
const STAFF_AVATARS = {
  'Виноградова Нина': '/booking/avatars/nina.jpg',
  'Нина Виноградова': '/booking/avatars/nina.jpg',
  'Куюмджу Дарья': '/booking/avatars/daria.jpg',
  'Дарья Куюмджу': '/booking/avatars/daria.jpg',
  'Папашвили Давид': '/booking/avatars/david.jpg',
  'Давид Папашвили': '/booking/avatars/david.jpg',
  'Перебейносов Андрей': '/booking/avatars/andrey.jpg',
  'Андрей Перебейносов': '/booking/avatars/andrey.jpg',
  'Федяинов Евгений': '/booking/avatars/evgeny.jpg',
  'Евгений Федяинов': '/booking/avatars/evgeny.jpg',
  'Багдасарян Анна': '/booking/avatars/anna.png',
  'Анна Багдасарян': '/booking/avatars/anna.png',
  'Цуканов Кирилл': '/booking/avatars/kirill.png',
  'Кирилл Цуканов': '/booking/avatars/kirill.png',
  'Администратор': '/booking/avatars/kirill.png',
  'admin': '/booking/avatars/kirill.png'
};

function renderStaffAvatar(name, className='new-manager-avatar') {
  const clean = String(name || '').trim();
  const url = STAFF_AVATARS[clean];
  const initials = clean.split(/\s+/).map(v => v[0]).slice(0, 2).join('').toUpperCase();
  if (url) {
    return `<span class="${className}"><img src="${url}" alt="${esc(clean)}" class="new-manager-avatar-img"></span>`;
  }
  return `<span class="${className}">${esc(initials || '?')}</span>`;
}

const state = {user:null,csrfToken:'',managers:[],config:{},sync:null,amoCrm:null,sourceIntake:null,sourceIntakeIssues:[],sourceIntakeRequest:0,bookings:[],retroBookings:[],hours:[],retroHours:[],funnel:null,recordedFunnel:null,users:[],view:'',search:'',date:'',completedFrom:'',completedTo:'',completedCreatedFrom:'',completedCreatedTo:'',adminDate:businessDate(),tag:'',week:businessDate(),managerId:'',scheduleDraft:null,scheduleConflict:false,schedulePublished:null,scheduleSelectedDay:'',scheduleTab:0,drawerHour:'',compensation:null,compensationFrom:`${businessDate().slice(0,7)}-01`,compensationTo:businessDate(),compensationManager:'',activeSalesManagerId:'',wizard:null,theme:'dark',uiMode:'new',loading:false,error:'',lastLoadError:'',lastLoadedAt:0,dataStale:false,connected:false,events:null,refreshToken:0};
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
const sourceRetryCodes = new Set(['UNKNOWN_STAFF_MAPPING','MIGRATION_LINK_REQUIRED','EXISTING_CAPACITY_CONFLICT','SOURCE_IDENTITY_CONFLICT']);
const themeLabels = {classic:'Classic',modern:'Modern',dark:'Dark'};
const uiModeLabels = {new:'NEW'};

function applyTheme(theme) {
  const value = 'dark';
  state.theme = 'dark';
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.dataset.uiMode = 'new';
  if(state.user) localStorage.setItem(`booking.theme.${state.user.id}`, 'dark');
}

function initTheme() {
  applyTheme('dark');
}

function applyUiMode() {
  const value = 'new';
  state.uiMode = value;
  document.documentElement.dataset.uiMode = value;
  document.querySelectorAll('[data-ui-mode-choice]').forEach(node => {
    const selectedMode = node.dataset.uiModeChoice === value;
    node.classList.toggle('selected',selectedMode);
    node.setAttribute('aria-pressed',String(selectedMode));
  });
  if(state.user) localStorage.setItem(`booking.uiMode.v2.${state.user.id}`,value);
}

function initUiMode() {
  applyUiMode();
}

function renderThemeSwitcher() {
  return `<section class="theme-switcher" aria-label="Тема интерфейса"><span class="theme-switcher-label">Тема интерфейса</span><div class="theme-switcher-options">${Object.entries(themeLabels).map(([key,label]) => `<button type="button" class="theme-choice${state.theme===key?' selected':''}" data-action="theme" data-theme-choice="${key}" aria-pressed="${state.theme===key}">${label}</button>`).join('')}</div></section>`;
}

function icon(name) {
  const paths = {
    grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    play:'<path d="m9 6 9 6-9 6z"/>',
    layers:'<rect x="4" y="5" width="16" height="6" rx="2"/><rect x="4" y="13" width="16" height="6" rx="2"/>',
    file:'<path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6m-6 4h6"/>',
    phone:'<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M10 6h4m-2 11h.01"/>',
    monitor:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4m-9 7h2m3 0h2m-7 4h2"/>',
    chart:'<path d="M4 3v17h17M8 16v-5m5 5V6m5 10V9"/>',
    users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m0-16a3 3 0 0 1 0 6m3 3a6 6 0 0 1 3 5v2"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    document:'<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h7"/>',
    check:'<path d="m5 12 4 4L20 5"/>',
    minus:'<path d="M6 12h12"/>',
    refresh:'<path d="M20 11a8 8 0 1 0-2.4 6M20 4v7h-7"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    sun:'<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>'
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
  if(role === 'admin') return ['overview','booking','admin','active','completed','schedule','confirmation','compensation','payments','users','trash','report','drawer'];
  if(role === 'sales') return ['active','completed','schedule','payments','report'];
  if(role === 'confirmation') return ['booking','confirmation','active','completed','compensation','trash'];
  return ['booking','active','completed','trash'];
}

function defaultView() {return isAdmin()?'admin':state.user?.role === 'confirmation'?'confirmation':state.user?.role==='call_center'?'booking':'active';}

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
  state.user=result.user;state.csrfToken=result.csrfToken;state.managers=result.managers||[];state.config=result.config||{};state.sync=result.sync;state.amoCrm=result.amoCrm||null;state.notifications=result.notifications||null;state.sourceIntake=result.sourceIntake||null;state.sourceIntakeIssues=[];
  if(state.config.demoDate){state.adminDate=state.config.demoDate;state.date=state.config.demoDate;state.completedFrom=state.config.demoDate;state.completedTo=state.config.demoDate;state.week=state.config.demoDate;}
  state.bookings=[];state.hours=[];state.users=[];state.error='';state.lastLoadError='';state.lastLoadedAt=0;state.dataStale=false;state.scheduleDraft=null;
  drafts=makeDraftStore(sessionStorage,state.user.id);
  initTheme();
  initUiMode();
  resetBookingWizard();
  const requested=location.hash.slice(1);
  state.view=allowedViews().includes(requested)?requested:defaultView();
  state.managerId=isSales()?state.user.id:(state.managers[0]?.id||'');
  renderShell();
  connectEvents();
  await refresh();
}

function renderShell() {
  return renderPrototypeShell();
}

function renderPrototypeShell() {
  const nav=(view,name,label)=>prototypeNavItem(view,name,label);
  const primary=[];
  if(isAdmin())primary.push(nav('admin','chart','Админка'),nav('booking','plus','Запись КЦ'),nav('confirmation','clock','Подтверждение'),nav('active','play','Мой день МИМК'),nav('schedule','calendar','Расписание'),nav('report','file','Отчёт и оплата'));
  else if(state.user.role==='call_center')primary.push(nav('booking','plus','Запись КЦ'),nav('active','play','Текущие и будущие'),nav('completed','file','Завершённые'));
  else if(state.user.role==='confirmation')primary.push(nav('booking','plus','Запись КЦ'),nav('confirmation','clock','Подтверждение'),nav('active','play','Текущие и будущие'),nav('completed','file','Завершённые'),nav('compensation','chart','Начисления'));
  else primary.push(nav('active','play','Мой день МИМК'),nav('schedule','calendar','Расписание'),nav('completed','file','Завершённые'),nav('report','file','Отчёт и оплата'));
  const formats='';
  const system=isAdmin()?`<div class="nav-label">Управление</div>${nav('users','users','Сотрудники')}${nav('trash','trash','Отмены')}`:'';
  app.innerHTML=`<div class="app"><aside class="sidebar" aria-label="Основная навигация"><a class="brand brand-booking" href="#${esc(defaultView())}"><span class="brand-title">BOOKING</span><small class="brand-sub">EDUSON OPERATIONS</small></a><nav class="nav" aria-label="Разделы">${primary.join('')}${formats}${system}</nav><div class="sidebar-nav-extra">
  <a class="nav-link nav-dashboard-link" href="/dashboard" target="_blank" rel="noopener" title="Перейти в дашборд аналитики">
    <span class="nav-emoji" aria-hidden="true">📊</span>
    <span>Аналитика</span>
    <span class="ext-badge">↗</span>
  </a>
  <button type="button" class="theme-toggle-btn" data-action="toggle-theme" title="Сменить тему оформления">
    <span class="theme-icon" aria-hidden="true">${state.theme==='light'?'🌙':'☀️'}</span>
    <span>${state.theme==='light'?'Тёмная тема':'Светлая тема'}</span>
  </button>
</div>
<div class="sidebar-bottom">${renderStaffAvatar(state.user.name,'avatar')}<div class="profile-text"><strong>${esc(state.user.name)}</strong><span>${esc(roles[state.user.role])}</span></div><button class="icon-btn logout-btn" data-action="logout" title="Выйти">${icon('trash')}</button></div></aside><main class="main"><header class="topbar"><div class="topbar-left"><span class="eyebrow">Eduson Operations</span><span class="page-title">${esc(newPageTitle())}</span></div><div class="topbar-actions"><span class="live" title="Время в Москве"><span id="moscow-clock"></span></span><button class="icon-btn" data-action="prototype-reset" aria-label="Сбросить экран">${icon('refresh')}</button></div></header>${state.config.demo?'<div class="demo-banner">Демонстрационная среда · боевые записи</div>':''}<div id="main" tabindex="-1"></div></main></div>`;
  renderTabs();setConnection(state.connected);updateMoscowClock();
}

function updateMoscowClock() {
  const clock=document.querySelector('#moscow-clock');
  if(clock)clock.textContent=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
}
setInterval(updateMoscowClock,1000);

function navItem(view, name, label) {
  const emoji = VIEW_EMOJIS[view] || '';
  return `<a class="nav-link${state.view===view?' selected':''}" href="#${view}" data-view="${view}">${emoji ? `<span class="nav-emoji" aria-hidden="true">${emoji}</span>` : icon(name)}<span>${label}</span></a>`;
}
const VIEW_EMOJIS = {admin:'⚡',booking:'➕',confirmation:'⏰',active:'▶️',schedule:'📅',report:'📊',users:'👥',trash:'🗑️',compensation:'💳',completed:'📁',payments:'💳',overview:'⚡'};
function prototypeNavItem(view,name,label) {
  const emoji = VIEW_EMOJIS[view] || '';
  return `<a class="prototype-nav-item${state.view===view?' active':''}" href="#${view}" data-view="${view}">${emoji ? `<span class="nav-emoji" aria-hidden="true">${emoji}</span>` : icon(name)}<span>${label}</span></a>`;
}

function renderTabs() {
  const tabs=document.querySelector('#tabs');
  const labels={overview:'Обзор системы',booking:'Запись',admin:'Статистика по часам',active:isSales()?'Мой день':'Текущие и будущие',completed:'Завершённые',schedule:'Расписание',confirmation:'Подтверждение',compensation:'Начисления',payments:'Оплаты',users:'Сотрудники',trash:'Отмены',report:'Отчёт и оплата',mobile:'Mobile first'};
  let views=['admin','active','completed','schedule','confirmation','compensation','payments'].filter(view=>allowedViews().includes(view));
  if(canCreate()&&!isAdmin()&&!views.includes('booking'))views.unshift('booking');
  if(state.view==='overview')views=['overview',...views];
  if(state.view==='users')views=['users'];
  else if(state.view==='trash') views=['trash'];
  if(tabs)tabs.innerHTML=views.map(view=>`<button class="tab${state.view===view?' active':''}" data-view="${view}" aria-current="${state.view===view?'page':'false'}">${esc(labels[view])}</button>`).join('');
  document.querySelectorAll('.nav-link[data-view]').forEach(node=>node.classList.toggle('selected',node.dataset.view===state.view || (node.dataset.view===defaultView()&&['active','completed','admin','confirmation'].includes(state.view))));
  document.querySelectorAll('.prototype-nav-item[data-view]').forEach(node=>node.classList.toggle('active',node.dataset.view===state.view));
}

async function navigate(view) {
  if(!allowedViews().includes(view)) return;
  state.view=view;state.error='';location.hash=view;renderTabs();await refresh();
}

async function refresh({quiet=false}={}) {
  if(!state.user) return;
  if(state.view==='booking'){await refreshBookingWizard({quiet});return;}
  const token=++state.refreshToken;
  if(!quiet){state.loading=true;renderContent();}
  const view=state.view;
  const syncRequest=isAdmin()?api('/sync').catch(error=>({...state.sync,loadError:error.message})):null;
  const notificationRequest=isAdmin()?api('/notifications/status').catch(()=>({...state.notifications,loadError:true})):null;
  const amoCrmRequest=isAdmin()?api('/integrations/amocrm/status').catch(()=>({...state.amoCrm,loadError:true})):null;
  const sourceIntakeRequest=isAdmin()&&state.sourceIntake?.enabled?api('/integrations/rubitime/status').catch(error=>error.status===404?null:state.sourceIntake):null;
  try {
    if(view==='users') {const result=await api('/users');if(token!==state.refreshToken)return;state.users=result.users||[];}
    else if(view==='compensation') {
      const result=await api(`/compensation?${new URLSearchParams({from:state.compensationFrom,to:state.compensationTo})}`);
      if(token!==state.refreshToken)return;state.compensation=result;
    }
    else if(view==='payments') {const result=await api('/payments');if(token!==state.refreshToken)return;state.payments=result.payments||[];}
    else if(view==='schedule') {
      if(!state.managerId) {state.scheduleDraft={days:[],ageGroups:[]};}
      else {
        const dates=rollingScheduleDates(state.week);
        const result=await api(`/schedule?${new URLSearchParams({managerId:state.managerId,from:dates[0],to:dates.at(-1)})}`);
        if(token!==state.refreshToken)return;
        const key=scheduleDraftKey();
        let local=drafts.read(key),migratedDraft=false;
        if(!local.days){const previous=drafts.read(`schedule.${state.managerId}.${weekDates(state.week)[0]}`);if(previous.days?.some(day=>dates.includes(day.date))){local={...previous,days:previous.days.filter(day=>dates.includes(day.date))};migratedDraft=true;}}
        const remoteDays=dates.map(date=>({...((result.days||[]).find(day=>day.date===date)||{}),date,intervals:(result.days||[]).find(day=>day.date===date)?.intervals||[],reserveCapacity:(result.days||[]).find(day=>day.date===date)?.reserveCapacity??1}));
        state.schedulePublished={days:structuredClone(remoteDays),ageGroups:[...(result.ageGroups||[])]};
        state.scheduleConflict=Boolean(local.days?.some(day=>dates.includes(day.date)&&Number(day.version||0)!==Number(remoteDays.find(remote=>remote.date===day.date)?.version||0)));
        state.scheduleDraft=local.days?{...local,days:remoteDays.map(remote=>local.days.find(day=>day.date===remote.date)||remote)}:{days:remoteDays,ageGroups:result.ageGroups||[]};
        if(migratedDraft)drafts.save(key,state.scheduleDraft);
        if(!dates.includes(state.scheduleSelectedDay))state.scheduleSelectedDay=dates[state.scheduleTab*7];
        if(isAdmin()&&state.scheduleOverview){const overview=await api(`/schedule?${new URLSearchParams({from:dates[0],to:dates.at(-1)})}`);if(token!==state.refreshToken)return;state.scheduleOverview=overview.days||[];}
      }
    } else {
      const scope=view==='trash'?'trash':['completed','report'].includes(view)?'completed':['admin','overview','drawer'].includes(view)?'all':'active';
      const params=new URLSearchParams({scope});
      if(['completed','report'].includes(view)){if(state.completedFrom)params.set('from',state.completedFrom);if(state.completedTo)params.set('to',state.completedTo);if(state.completedCreatedFrom)params.set('createdFrom',state.completedCreatedFrom);if(state.completedCreatedTo)params.set('createdTo',state.completedCreatedTo);}
      else if(state.date && !['admin','overview','drawer'].includes(view))params.set('date',state.date);
      if(['admin','overview','drawer'].includes(view))params.set('date',state.adminDate);
      const requests=[api(`/bookings?${params}`)];
      if(['admin','overview','drawer'].includes(view)){
        requests.push(api(`/admin/stats?${new URLSearchParams({date:state.adminDate,...(state.tag?{tag:state.tag}:{})})}`));
        requests.push(api(`/bookings?${new URLSearchParams({scope:'all',createdFrom:state.adminDate,createdTo:state.adminDate})}`));
      }
      const results=await Promise.all(requests);
      if(token!==state.refreshToken)return;
      state.bookings=results[0].bookings||[];
      if(results[1]){state.hours=results[1].hours||[];state.totals=results[1].totals||{};state.retroHours=results[1].recordedHours||[];state.funnel=results[1].funnel||null;state.recordedFunnel=results[1].recordedFunnel||null;}
      state.retroBookings=results[2]?.bookings||[];
    }
    if(syncRequest){const sync=await syncRequest;if(token===state.refreshToken)state.sync=sync;}
    if(notificationRequest){const status=await notificationRequest;if(token===state.refreshToken)state.notifications=status;}
    if(amoCrmRequest){const status=await amoCrmRequest;if(token===state.refreshToken)state.amoCrm=status;}
    if(sourceIntakeRequest){const status=await sourceIntakeRequest;if(token===state.refreshToken)state.sourceIntake=status;}
    if(token!==state.refreshToken)return;
    state.error='';state.lastLoadError='';state.lastLoadedAt=Date.now();state.dataStale=false;
  } catch(error) {if(token===state.refreshToken){state.error=error.message;state.lastLoadError=error.message;state.dataStale=Boolean(state.lastLoadedAt);}}
  finally {if(token===state.refreshToken){state.loading=false;renderContent();}}
}

function setConnection(connected) {
  state.connected=connected;
  const node=document.querySelector('#connection');
  if(node){node.hidden=connected||!state.events;node.innerHTML=connected?'':`<span class="connection-dot offline"></span><span>Связь с обновлениями прервана</span>`;}
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
  if(state.uiMode==='new')content=renderNewView();
  else if(state.view==='booking')content=renderBookingWizard();
  else if(state.view==='admin')content=renderAdmin();
  else if(state.view==='schedule')content=renderSchedule();
  else if(state.view==='users')content=renderUsers();
  else if(state.view==='compensation')content=renderCompensation();
  else if(state.view==='payments')content=renderPayments();
  else content=renderBookings();
  const banners=state.uiMode==='new'?'':`${renderAmoCrmStatus()}${renderSourceIntakeStatus()}${renderSync()}${renderNotificationStatus()}`;
  main.innerHTML=`${state.error?`<div class="error-banner" role="alert">${esc(state.error)} <button class="subtle compact" data-action="refresh">Повторить</button></div>`:''}${state.loading?'<div class="loading-line" role="status">Загружаем данные…</div>':''}${renderFreshness()}${state.uiMode==='new'?'':renderRoleGuide()}${banners}${content}`;
  if(savedFocus)document.getElementById(savedFocus)?.focus();
}

function newPageTitle() {
  const labels={overview:'Состояние уроков',booking:'Запись ученика',admin:'Админка',active:isSales()?'Мой день':'Текущие и будущие',completed:'Завершённые',confirmation:'Очередь подтверждения',schedule:'Расписание',compensation:'Начисления',payments:'Оплаты',users:'Сотрудники',trash:'Отмены',report:'Отчёт и оплата',drawer:'Детализация часа',mobile:'Mobile first'};
  return labels[state.view]||'Booking';
}

function newPageSubtitle() {
  const labels={overview:'Запись, подтверждение и контроль в одном рабочем контуре.',booking:'Свободные часы и контакты сделки в одном потоке.',admin:'Часовая статистика, резервы и назначения команды.',active:isSales()?'Назначенные уроки и следующий шаг.':'Активные записи и текущие статусы.',completed:'История уроков и отчётов.',confirmation:'Подтверждение уроков до наступления дедлайна.',schedule:'Открытые часы МИМК на 14 дней.',compensation:'Начисления менеджера подтверждения.',payments:'Оформленные оплаты и обучение.',report:'Отчёт сохраняется в Google Sheets и PostgreSQL.',users:'Сотрудники и доступы команды.',trash:'Отменённые уроки, причины и возможность быстрой перезаписи.',drawer:'Список уроков и назначение МИМК на выбранный час.'};
  return labels[state.view]||'Рабочее пространство Booking';
}

function newSalesActions(booking) {
  if(!booking)return '';
  if(booking.state==='in_progress')return `<button class="new-action primary" data-action="complete" data-id="${esc(booking.id)}">Завершить урок ${icon('arrow')}</button>`;
  if(isSales()&&booking.confirmationStatus==='confirmed'&&booking.assignmentKind==='primary')return `<button class="new-action primary" data-action="start" data-id="${esc(booking.id)}">Взять в работу ${icon('arrow')}</button><button class="new-action secondary" data-action="no-show" data-id="${esc(booking.id)}">Ученик не пришёл</button>`;
  return statusBadge(booking);
}

function renderNewSalesDay() {
  let targetUserId = state.user.id;
  let managerPicker = '';
  if (isAdmin()) {
    targetUserId = state.activeSalesManagerId || (state.managers.find(m => m.active !== false) || state.managers[0] || state.user).id;
    const chips = state.managers.filter(m => m.active !== false).map(m => {
      const isSel = m.id === targetUserId;
      return `<button type="button" class="manager-chip${isSel ? ' selected' : ''}" data-action="select-sales-manager" data-id="${esc(m.id)}">${renderStaffAvatar(m.name, 'chip-avatar')}<span>${esc(m.name)}</span></button>`;
    }).join('');
    managerPicker = `<div class="sales-manager-picker" aria-label="Выбор менеджера МИМК">${chips}</div>`;
  }
  const assigned = state.bookings.filter(b => b.assignedTo === targetUserId && b.state !== 'cancelled' && b.state !== 'completed').sort((a,b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const current = assigned.find(b => b.state === 'in_progress') || assigned[0];
  const next = assigned.filter(b => b.id !== current?.id);
  const inProgressCount = assigned.filter(b => b.state === 'in_progress').length;
  const confirmedCount = assigned.filter(b => b.confirmationStatus === 'confirmed').length;
  const uncompletedReportsCount = state.bookings.filter(b => b.assignedTo === targetUserId && b.state === 'completed' && !b.report).length;
  const currentLabel = current?.state === 'in_progress' ? 'Урок в работе' : 'Ближайший урок';
  const hero = current ? `<article class="new-hero"><div class="new-hero-kicker">${currentLabel}</div><div class="new-hero-time">${esc(wizardTimeLabel(current.time))}</div><h2>${esc(studentName(current))}, ${esc(studentAge(current))}</h2><p>${dateText(current.date)} · 60 минут · Индивидуальный мастер-класс</p><div class="new-hero-facts" aria-label="Факты урока"><span class="new-fact-icon" title="${current.hasPc===true?'Компьютер есть':'Компьютер не указан'}">${icon('monitor')}</span><span class="new-fact-icon" title="${current.parentPresent===true?'Родитель будет':'Родитель не указан'}">${icon('users')}</span>${current.crmUrl ? `<span style="margin-left:8px">${externalLink(current.crmUrl, 'Amo CRM', 'new-inline-link')}</span>` : ''}</div><div class="new-hero-actions">${newSalesActions(current)}</div></article>` : '<article class="new-hero new-empty"><div class="new-hero-kicker">Сегодня</div><h2>Свободных уроков нет</h2><p>Новые назначения появятся здесь автоматически при подтверждении записей.</p></article>';
  const rows = next.map(booking => `<article class="new-lesson-row"><strong>${esc(booking.time)}</strong><div><b>${esc(studentName(booking))} · ${esc(studentAge(booking))}</b><span>${esc(dateText(booking.date))} · ${booking.assignmentKind==='reserve'?'Резерв':'Основной'}</span></div><span class="status ${booking.assignmentKind==='reserve'?'reserve':'confirmed'}">${booking.assignmentKind==='reserve'?'Резерв':'Подтверждён'}</span></article>`).join('');
  return `<section class="new-page"><header class="new-page-heading"><div><span class="new-eyebrow">${esc(roles[state.user.role])}</span><h1>${esc(newPageTitle())}</h1><p>${esc(newPageSubtitle())}</p></div></header>${managerPicker}<div class="new-board-summary"><article><span>Всего уроков</span><strong>${assigned.length}</strong></article><article><span>Подтверждено</span><strong>${confirmedCount}</strong></article><article><span>В работе</span><strong>${inProgressCount}</strong></article><article><span>Ждут отчёта</span><strong>${uncompletedReportsCount}</strong></article></div><div class="new-sales-grid"><div>${hero}<div class="new-section-heading"><h2>Следующие слоты</h2><span>${next.length}</span></div><div class="new-lesson-list">${rows || '<div class="new-empty-row">Следующих уроков пока нет.</div>'}</div></div><aside class="new-side-card"><h2>Действия МИМК</h2><p>Проведение занятий и отправка отчётов сразу после завершения.</p><div class="new-kpi-list"><div><span>В работе</span><strong>${inProgressCount}</strong></div><div><span>Назначено</span><strong>${assigned.length}</strong></div><div><span>Без отчёта</span><strong>${uncompletedReportsCount}</strong></div></div><button class="new-action secondary" data-view="completed">Открыть историю уроков</button></aside></div></section>`;
}

function renderNewOverview() {
  // Legacy overview: Обзор системы
  location.hash = '#' + defaultView();
  return renderNewAdminExact();
}

// Shared by the admin tower and the confirmation queue; keep it module-level.
function metric(label,value,note,tone='') {return `<article class="new-metric-card ${tone}"><div><span>${esc(label)}</span><strong>${value}</strong></div><small>${esc(note)}</small></article>`;}

function bentoKpi({label, value, note, badge, badgeTone='', fillPct=0, fillTone='', subnote=''}) {
  return `<article class="new-metric-card bento-kpi ${badgeTone}">
    <div class="bento-kpi-head">
      <span class="bento-kpi-label">${esc(label)}</span>
      ${badge ? `<span class="bento-kpi-badge ${badgeTone}">${esc(badge)}</span>` : ''}
    </div>
    <div class="bento-kpi-body">
      <strong class="bento-kpi-num">${value}</strong>
      <span class="bento-kpi-note">${esc(note)}</span>
    </div>
    <div class="bento-kpi-footer">
      <div class="bento-kpi-bar"><div class="bento-kpi-bar-fill ${fillTone}" style="width:${Math.min(100, Math.max(0, fillPct))}%"></div></div>
      <span class="bento-kpi-subnote">${esc(subnote)}</span>
    </div>
  </article>`;
}

function renderNewAdminExact() {
  const hours=state.hours.length?state.hours:Array.from({length:12},(_,index)=>({time:`${String(index+10).padStart(2,'0')}:00`}));
  const funnel=state.funnel||{};
  const sum=field=>hours.reduce((total,hour)=>total+Number(hour[field]||0),0);
  const booked=Number(funnel.booked??sum('total'));
  const confirmed=Number(funnel.confirmed??sum('confirmed'));
  const assigned=Number(funnel.assigned??sum('assigned'));
  const capacityHeld=sum('capacityHeld');
  const reserve=sum('reserve');
  const totalSlots=hours.reduce((acc,h)=>acc+Math.max(Number(h.managers||0),Number(h.capacity||0)),0);
  const pending=Math.max(0,booked-confirmed);
  const currentMskHour=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit'}).format(new Date())+':00';
  const isToday=state.adminDate===businessDate();

  const loadRows=hours.map(hour=>{
    const overloaded=isHourOverloaded(hour);
    const attention=Number(hour.capacityHeld||0)>0||overloaded;
    const isCurrent=isToday&&hour.time===currentMskHour;
    const total=Number(hour.total||0);
    const conf=Number(hour.confirmed||0);
    const res=Number(hour.reserve||0);
    const held=Number(hour.capacityHeld||0);
    const capSlots=Math.max(Number(hour.managers||0),Number(hour.capacity||0),1);
    const isEmpty = total === 0;
    const meterPct=overloaded?100:total>0?Math.min(100,Math.round(total/capSlots*100)):0;
    const meterTone=overloaded?'danger':total>=capSlots?'full':total>0?'active':'empty';

    // Facepile for on-duty managers
    const onDuty=(hour.managerList&&hour.managerList.length)?hour.managerList:[];
    let managersHtml='';
    if(onDuty.length>0){
      const avatars=onDuty.slice(0,3).map(m=>`<span class="tower-facepile-avatar" title="${esc(m.name)}">${renderStaffAvatar(m.name,'tower-avatar-circle')}</span>`).join('');
      const more=onDuty.length>3?`<span class="tower-facepile-more">+${onDuty.length-3}</span>`:'';
      const names=onDuty.slice(0,2).map(m=>m.name.split(' ')[0]).join(', ');
      managersHtml=`<div class="tower-facepile">${avatars}${more}<span class="tower-facepile-names">${esc(names)}${onDuty.length>2?'...':''}</span></div>`;
    }else if(Number(hour.managers||0)>0){
      managersHtml=`<span class="tower-manager-badge active">${Number(hour.managers)} МИМК на смене</span>`;
    }else{
      managersHtml=`<span class="tower-manager-badge none">Нет МИМК</span>`;
    }

    let statusText=isEmpty?'нет записей':'Свободен';
    let statusTone='neutral';
    if(isEmpty){statusText='нет записей';statusTone='empty';}
    else if(held>0){statusText='Нужен МИМК';statusTone='danger';}
    else if(overloaded){statusText='Перегруз';statusTone='danger';}
    else if(isCurrent){statusText='● В эфире';statusTone='live';}
    else if(total>0&&conf>=total){statusText='Готов';statusTone='success';}
    else if(total>0){statusText=`Ждёт (${total-conf})`;statusTone='warning';}

    const currentBadge=isCurrent?'<span class="tower-radar-badge"><span class="radar-dot"></span>Сейчас</span>':'';

    return `<div class="new-load-row${isEmpty?' is-empty-hour':''}${attention?' attention':''}${isCurrent?' is-current-hour':''}" data-action="hour" data-time="${esc(hour.time)}">
      <div class="col-time"><button class="new-hour-label" data-action="hour" data-time="${esc(hour.time)}" aria-label="Открыть час ${esc(hour.time)}">${esc(hour.time)}</button>${currentBadge}</div>
      <div class="col-meter">
        ${isEmpty ? '<div class="tower-meter empty-meter"><span class="tower-meter-label muted-text">нет записей</span></div>' : `<div class="tower-meter">
          <div class="tower-meter-track"><div class="tower-meter-fill ${meterTone}" style="width:${meterPct}%"></div></div>
          <span class="tower-meter-label ${overloaded?'danger':''}">${total} / ${capSlots} слотов</span>
        </div>`}
      </div>
      <div class="col-num">${total>0?`<button class="new-load-value pill-total" data-action="hour-metric" data-time="${esc(hour.time)}" data-metric="total" aria-label="Записано: ${total}">● ${total}</button>`:'<span class="matrix-empty">—</span>'}</div>
      <div class="col-num">${conf>0?`<button class="new-load-value pill-confirmed" data-action="hour-metric" data-time="${esc(hour.time)}" data-metric="confirmed" aria-label="Подтверждено: ${conf}">✓ ${conf}</button>`:'<span class="matrix-empty">—</span>'}</div>
      <div class="col-managers">${isEmpty ? '<span class="tower-manager-badge none">—</span>' : managersHtml}</div>
      <div class="col-num">${res>0?`<button class="new-load-value pill-reserve has-val" data-action="hour-metric" data-time="${esc(hour.time)}" data-metric="reserve">⚠ ${res}</button>`:'<span class="matrix-empty">—</span>'}</div>
      <div class="col-status"><span class="status-chip ${statusTone}">${esc(statusText)}</span></div>
      <div class="col-action"><button class="tower-row-btn${isEmpty?' secondary':''}" data-action="hour" data-time="${esc(hour.time)}">Детализация →</button></div>
    </div>`;
  }).join('');

  const exceptions=[];
  const heldHour=hours.find(hour=>Number(hour.capacityHeld||0)>0);
  if(heldHour)exceptions.push(`<button class="new-exception-row" data-action="hour-metric" data-time="${esc(heldHour.time)}" data-metric="capacityHeld"><span class="new-exception-icon">!</span><span><strong>${esc(heldHour.time)} · нужен МИМК</strong><small>Откройте час и проверьте распределение</small></span></button>`);
  if(pending>0)exceptions.push(`<button class="new-exception-row" data-action="hour-metric" data-time="${esc((hours.find(hour=>Number(hour.confirmed||0)<Number(hour.total||0))||hours[0]).time)}" data-metric="confirmed"><span class="new-exception-icon">◷</span><span><strong>${pending} записей ждут подтверждения</strong><small>Проверьте очередь до дедлайна</small></span></button>`);
  if(Number(state.sourceIntake?.issues||0)>0)exceptions.push(`<button class="new-exception-row" data-action="source-intake-issues"><span class="new-exception-icon">↻</span><span><strong>${Number(state.sourceIntake.issues)} записей Rubitime</strong><small>Нужна проверка источника</small></span></button>`);
  if(!exceptions.length)exceptions.push('<div class="new-exception-empty">Все часы в норме. Нажмите на любой час для детализации.</div>');

  return `<section class="new-page new-admin-page">
    <header class="new-page-heading">
      <div>
        <span class="new-eyebrow">Администратор</span>
        <h1>Админка</h1>
        <p>Сводная матрица загрузки команды по часам дня. Нажмите на строку для детализации часа.</p>
      </div>
      <div class="new-heading-actions">
        <button class="new-admin-button" data-action="prototype-hour">Детализация часа</button>
        
      </div>
    </header>
    <div class="new-admin-toolbar">
      <label><span>Дата</span><input type="date" id="admin-date" aria-label="Дата статистики" value="${esc(state.adminDate)}"></label>
      <input type="hidden" id="admin-tag" value="">
      <span class="new-admin-toolbar-spacer"></span>
      <button class="new-admin-button" data-action="create">+ Записать на мастер-класс</button>
      <button class="new-admin-refresh" data-action="refresh" aria-label="Обновить статистику">${icon('refresh')}</button>
    </div>
    <div class="new-metric-grid">
      ${bentoKpi({
        label: '● Записано',
        value: booked,
        note: 'на выбранный день',
        badge: isToday ? 'Сегодня' : state.adminDate,
        badgeTone: 'info',
        fillPct: totalSlots ? Math.round(booked / totalSlots * 100) : 0,
        fillTone: 'amber',
        subnote: totalSlots ? `${Math.round(booked / totalSlots * 100)}% от емкости (${totalSlots} мест)` : 'Нет открытых мест'
      })}
      ${bentoKpi({
        label: '✓ Подтверждено',
        value: confirmed,
        note: 'SLA за 2 часа',
        badge: booked ? `${Math.round(confirmed / booked * 100)}%` : '0%',
        badgeTone: 'success',
        fillPct: booked ? Math.round(confirmed / booked * 100) : 0,
        fillTone: 'emerald',
        subnote: pending > 0 ? `${pending} ждут подтверждения` : 'Все записи подтверждены'
      })}
      ${bentoKpi({
        label: '👥 МИМК на смене',
        value: assigned || hours.reduce((s, h) => s + (h.managerList?.length || Number(h.managers || 0)), 0),
        note: capacityHeld > 0 ? `${capacityHeld} без МИМК` : 'слоты закрыты',
        badge: capacityHeld > 0 ? 'Дефицит' : 'В норме',
        badgeTone: capacityHeld > 0 ? 'danger' : 'success',
        fillPct: capacityHeld > 0 ? 30 : 100,
        fillTone: capacityHeld > 0 ? 'danger' : 'emerald',
        subnote: capacityHeld > 0 ? 'Требуется ручное назначение' : 'Все слоты обеспечены МИМК'
      })}
      ${bentoKpi({
        label: '⚡ Резерв и риски',
        value: reserve,
        note: reserve > 0 ? `${reserve} в резерве` : 'перегрузов нет',
        badge: reserve > 0 ? 'Внимание' : 'Ок',
        badgeTone: reserve > 0 ? 'danger' : 'neutral',
        fillPct: reserve > 0 ? 100 : 0,
        fillTone: reserve > 0 ? 'danger' : 'neutral',
        subnote: reserve > 0 ? 'Проверьте слоты с резервом' : 'Слоты в пределах capacity'
      })}
    </div>
    <div class="new-admin-grid">
      <section class="new-panel new-load-panel full-width">
        <div class="new-panel-heading">
          <div>
            <h2>Нагрузка команды по часам</h2>
            <p>Сводная матрица слотов, открытых МИМК и текущего статуса дня по Москве.</p>
          </div>
          
        </div>
        <div class="new-load-head">
          <span class="col-time">Время</span>
          <span class="col-meter">Загрузка слота</span>
          <span class="col-num">Записано</span>
          <span class="col-num">Подтв.</span>
          <span class="col-managers">МИМК на смене</span>
          <span class="col-num">Резерв</span>
          <span class="col-status">Статус</span>
          <span class="col-action">Действие</span>
        </div>
        <div class="new-load-body">${loadRows}</div>
        <p class="new-panel-hint">Нажмите на любой час, чтобы перейти в Детализацию часа и назначить МИМК.</p>
      </section>
      <aside class="new-panel new-exceptions-panel compact" style="display:none;">
        <div class="new-panel-heading"><div><h2>Внимание</h2><p>Исключения</p></div><span class="new-exception-count">${exceptions.length}</span></div>
        <div class="new-exception-list">${exceptions.join('')}</div>
      </aside>
    </div>
    <div class="new-admin-footer"><span>Назначено: <strong>${assigned}</strong></span><span>Подтверждено: <strong>${confirmed}</strong></span></div>
  </section>`;
}

function exportHourCsv(hourTime) {
  const hour=(state.hours||[]).find(item=>item.time===hourTime)||{};
  const bookings=filterHourMetricBookings(state.bookings,{date:state.adminDate,time:hourTime,tag:state.tag,metric:'all',allocations:hour.allocations||[]});
  const headers=['ID','Ученик','Возраст','Телефон','Статус','Тип','МИМК','AmoCRM'];
  const rows=bookings.map(b=>[b.id,`"${(studentName(b)||'').replace(/"/g,'""')}"`,studentAge(b)||'',b.phone||'',b.state,b.assignmentKind,`"${(b.assignedName||'').replace(/"/g,'""')}"`,b.crmUrl||'']);
  const csvContent='\uFEFF'+[headers.join(';'),...rows.map(r=>r.join(';'))].join('\r\n');
  const blob=new Blob([csvContent],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`booking-${state.adminDate}-${hourTime}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  notify(`Экспортировано ${bookings.length} записей на ${hourTime}`);
}

function renderNewDrawerExact() {
  const hours=state.hours.length?state.hours:[];
  const hour=hours.find(item=>item.time===state.drawerHour)||hours.find(item=>Number(item.total||0)>0)||hours[0]||{time:'16:00'};
  const time=hour.time||'16:00';
  const bookings=filterHourMetricBookings(state.bookings,{date:state.adminDate,time,tag:state.tag,metric:'all',allocations:hour.allocations||[]});
  const managers=(hour.managerList||state.managers||[]).slice(0,5);

  const hourRibbon = hours.map(h => {
    const isSel = h.time === time;
    const cnt = Number(h.total || 0);
    return `<button class="drawer-ribbon-btn${isSel ? ' active' : ''}" data-action="hour" data-time="${esc(h.time)}">${esc(h.time)}${cnt > 0 ? `<span class="ribbon-count">${cnt}</span>` : ''}</button>`;
  }).join('');

  const list=bookings.map(booking=>{
    const isReserve=booking.assignmentKind==='reserve';
    const isConfirmed=booking.confirmationStatus==='confirmed';
    return `<article class="new-drawer-row${isReserve?' is-reserve-slot':''}"><span class="new-manager-avatar${isReserve?' reserve':''}">${esc(String(studentName(booking)).split(/\s+/).map(part=>part[0]).join('').slice(0,2).toUpperCase())}</span><div><div class="drawer-student-heading"><strong>${esc(studentName(booking))} · ${esc(studentAge(booking))}</strong>${isReserve?'<span class="status-chip danger">Резерв</span>':isConfirmed?'<span class="status-chip success">Подтверждён</span>':'<span class="status-chip warning">Ожидает</span>'}</div><span>${isReserve?'Резервная запись на слот':'Основная запись'} · ${esc(booking.assignedName||'МИМК не назначен')}</span>${booking.crmUrl?` · ${externalLink(booking.crmUrl,'Amo CRM','new-inline-link')}`:''}</div><div class="new-drawer-item-actions">${statusBadge(booking)}${canAssignBooking(state.user,booking)?`<button class="new-inline-link" data-action="assignment" data-id="${esc(booking.id)}">${booking.assignedTo?'Сменить МИМК':'Назначить'}</button>`:''}</div></article>`;
  }).join('');
  const managerRows=managers.map(manager=>{
    const isPrimary=manager.id===hour.allocations?.find(item=>item.kind==='primary')?.managerId;
    return `<article class="new-drawer-manager">${renderStaffAvatar(manager.name,'new-manager-avatar')}<div><strong>${esc(manager.name)}</strong><span>Открыто ${esc(time)}</span></div><span class="status-chip ${isPrimary?'success':'neutral'}">${isPrimary?'Основной':'Свободен'}</span></article>`;
  }).join('');
  return `<section class="new-page new-drawer-page"><header class="new-page-heading"><div><span class="new-eyebrow">Администратор</span><h1>Детализация часа · ${esc(time)}</h1><p>Список записанных учеников, capacity и оперативное назначение МИМК.</p></div><div class="new-heading-actions"><a class="new-action secondary" href="#admin">← В Админку</a><span class="new-status-pill">${esc(time)} · ${Number(hour.capacityHeld||0)>0?'внимание':'в норме'}</span></div></header>${hourRibbon?`<div class="drawer-ribbon">${hourRibbon}</div>`:''}<div class="new-drawer-layout"><section class="new-panel new-drawer-main"><div class="new-panel-heading"><div><h2>${esc(time)} · ${dateText(state.adminDate)}</h2><p>Ученики, распределённые на этот час.</p></div><button class="new-action secondary" data-action="export-hour" data-time="${esc(time)}">Экспорт CSV</button></div><div class="new-drawer-stats"><div><span>Записи</span><strong>${Number(hour.total||bookings.length)}</strong></div><div><span>Подтверждено</span><strong>${Number(hour.confirmed||bookings.filter(item=>item.confirmationStatus==='confirmed').length)}</strong></div><div><span>МИМК открыто</span><strong>${Number(hour.managers||0)}</strong></div><div><span>Резерв</span><strong>${Number(hour.reserve||0)}</strong></div></div><div class="new-drawer-list">${list||'<div class="new-empty-board"><strong>Записей на этот час нет</strong></div>'}</div></section><aside class="new-panel new-drawer-side"><h2>Назначение МИМК</h2><p>Администратор закрепляет ответственного менеджера.</p><span class="new-drawer-label">Открытые МИМК</span>${managerRows||'<div class="new-empty-board"><strong>Открытых МИМК нет</strong></div>'}<div class="new-drawer-actions"><button class="new-admin-button" data-action="reassign-drawer" data-time="${esc(time)}">Переназначить</button><button class="new-capacity-button" data-action="reserve-drawer" data-time="${esc(time)}">Оставить резерв</button></div></aside></div></section>`;
}

function renderNewConfirmation() {
  let bookings=state.bookings.filter(booking=>booking.confirmationStatus!=='confirmed'&&booking.state==='scheduled'&&!legacyOutcomeUnknown(booking)).sort((a,b)=>String(a.confirmationDueAt).localeCompare(String(b.confirmationDueAt)));
  if(state.search)bookings=bookings.filter(booking=>matchesSearch(booking,state.search));
  const pending=bookings.length;
  const confirmedToday=Number(state.funnel?.confirmed||state.bookings.filter(booking=>booking.confirmationStatus==='confirmed').length||0);
  const reserve=state.bookings.filter(booking=>booking.assignmentKind==='reserve'&&booking.state==='scheduled').length;
  const queue=bookings.map(booking=>{
    const timing=confirmationTiming(booking);
    const phone=String(booking.phone||'').replace(/[^+\d]/g,'');
    const pcChip=booking.hasPc===true?`<span class="fact-chip is-positive">${icon('monitor')} ПК</span>`:`<span class="fact-chip">${icon('monitor')} Без ПК</span>`;
    const parentChip=booking.parentPresent===true?`<span class="fact-chip is-positive">${icon('users')} С родителем</span>`:`<span class="fact-chip">${icon('users')} Без родителя</span>`;
    const ageChip=`<span class="fact-chip">${esc(studentAge(booking))}</span>`;
    const actions=`<button class="new-action primary" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить</button><button class="new-action secondary" data-action="cancel" data-id="${esc(booking.id)}">${timing.overdue?'Отменить':'Перенести'}</button>${externalLink(booking.crmUrl,'Открыть CRM','new-inline-link')}`;
    return `<article class="new-queue-row ${timing.overdue?'is-overdue':'is-pending'}"><div class="new-queue-time"><strong>${esc(booking.time)}</strong><span>${dateText(booking.date)} · 60 мин</span><span class="new-queue-deadline${timing.overdue?' overdue':''}">${timing.overdue?'Дедлайн прошёл':'Подтвердить до'} ${timeStamp(booking.confirmationDueAt)}</span></div><div class="new-queue-person"><strong>${esc(studentName(booking))} · ${esc(studentAge(booking))}</strong><span>${esc(booking.parentName||'Родитель не указан')}${phone?` · ${esc(booking.phone)}`:''}</span><div class="new-queue-facts">${ageChip}${pcChip}${parentChip}</div></div><div class="new-queue-actions">${actions}</div></article>`;
  }).join('');
  const managers=(state.managers||[]).filter(manager=>manager.active!==false).slice(0,5).map(manager=>`<div class="new-manager-row">${renderStaffAvatar(manager.name,'new-manager-avatar')}<div><strong>${esc(manager.name)}</strong><small>Открытое расписание</small></div><span class="new-manager-tag">МИМК</span></div>`).join('');
  return `<section class="new-page new-confirmation-page"><header class="new-page-heading"><div><span class="new-eyebrow">Менеджер подтверждения</span><h1>Очередь подтверждения</h1><p>Подтверждение мастер-классов до дедлайна (за 2 часа до начала).</p></div><button class="new-filter-button" data-action="refresh">${icon('refresh')} Обновить</button></header><div class="new-admin-toolbar new-confirmation-toolbar"><label><span>Дата</span><input type="date" id="booking-date" aria-label="Дата мастер-класса" value="${esc(state.date)}"></label><span class="new-admin-toolbar-spacer"></span><span class="new-sla-note">Подтверждать можно заранее · дедлайн за 2 часа</span></div><div class="new-metric-grid new-confirmation-metrics">${metric('К подтверждению',pending,pending?'Ближайший дедлайн в очереди':'Очередь пуста',pending?'warning':'success')}${metric('Подтверждено',confirmedToday,'за выбранный день','success')}${metric('В резерве',reserve,reserve?'Нужна проверка capacity':'резервов нет',reserve?'warning':'')}${metric('Правило SLA','2 ч','до начала урока','success')}</div><div class="new-confirmation-grid"><section class="new-panel new-queue-panel"><div class="new-panel-heading"><div><h2>Уроки в очереди</h2><p>Подтвердите запись или перенесите её до дедлайна.</p></div></div><div class="new-queue-list">${queue||'<div class="new-exception-empty">Все доступные записи обработаны.</div>'}</div></section><aside class="new-panel new-rule-panel"><div class="new-panel-heading"><div><h2>Правило подтверждения</h2><p>Автоматическое закрепление за МИМК.</p></div><span class="new-manager-tag">Авто</span></div><div class="new-manager-list">${managers||'<div class="new-exception-empty">Открытых МИМК пока нет.</div>'}</div><button class="new-capacity-button" data-view="admin">Открыть capacity</button></aside></div></section>`;
}

function newBookingActions(booking) {
  const canActSales=isSales()&&booking.assignedTo===state.user.id;
  if(booking.state==='cancelled')return `${statusBadge(booking)}${canRestoreBooking(state.user,booking)?`<button class="new-action secondary" data-action="restore" data-id="${esc(booking.id)}">Восстановить</button>`:''}`;
  if(booking.state==='completed')return `${statusBadge(booking)}${canReport()&&!booking.isTest?`<button class="new-action secondary" data-action="report" data-id="${esc(booking.id)}">${booking.report?'Открыть':'Заполнить'} отчёт</button>`:''}`;
  if(booking.state==='in_progress')return `${statusBadge(booking)}${canActSales?`<button class="new-action primary" data-action="complete" data-id="${esc(booking.id)}">Завершить урок ${icon('arrow')}</button>`:''}`;
  if(canActSales&&booking.confirmationStatus==='confirmed'&&booking.assignmentKind==='primary')return `<button class="new-action primary" data-action="start" data-id="${esc(booking.id)}">Взять в работу ${icon('arrow')}</button><button class="new-action secondary" data-action="no-show" data-id="${esc(booking.id)}">Ученик не пришёл</button>`;
  let actions=statusBadge(booking);
  if(canConfirmBooking(state.user,booking))actions+=`<button class="new-action primary" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить</button>`;
  if(['confirmation','call_center','admin'].includes(state.user.role))actions+=`<button class="new-action secondary" data-action="cancel" data-id="${esc(booking.id)}">Отменить</button>`;
  return actions;
}

function renderNewBookingBoard(view) {
  let bookings=state.bookings.filter(booking=>matchesSearch(booking,state.search));
  if(view==='trash')bookings=bookings.filter(booking=>booking.state==='cancelled');
  const counts={all:bookings.length,confirmed:bookings.filter(booking=>booking.confirmationStatus==='confirmed').length,inProgress:bookings.filter(booking=>booking.state==='in_progress').length,completed:bookings.filter(booking=>booking.state==='completed').length,reported:bookings.filter(booking=>booking.report).length};
  const isTrash=view==='trash';
  const toolbar=view==='completed'?`<div class="new-board-toolbar"><label><span>Уроки с</span><input type="date" id="completed-from" aria-label="Дата МК от" value="${esc(state.completedFrom)}"></label><label><span>по</span><input type="date" id="completed-to" aria-label="Дата МК до" value="${esc(state.completedTo)}"></label><label><span>Записано с</span><input type="date" id="completed-created-from" aria-label="Записано с" value="${esc(state.completedCreatedFrom)}"></label><label><span>по</span><input type="date" id="completed-created-to" aria-label="Записано по" value="${esc(state.completedCreatedTo)}"></label><button class="new-admin-refresh" data-action="refresh" aria-label="Обновить список">${icon('refresh')}</button></div>`:`<div class="new-board-toolbar"><label><span>Дата урока</span><input type="date" id="booking-date" aria-label="Дата мастер-класса" value="${esc(state.date)}"></label><span class="new-admin-toolbar-spacer"></span>${canCreate()&&!isTrash?`<button class="new-admin-button" data-action="create">+ Записать на мастер-класс</button>`:''}<button class="new-admin-refresh" data-action="refresh" aria-label="Обновить список">${icon('refresh')}</button></div>`;
  const cards=bookings.map(booking=>{
    if(isTrash){
      return `<article class="new-booking-card is-cancelled"><div class="new-booking-time"><strong class="booking-hour">${esc(booking.time)}</strong><span class="booking-day">${dateText(booking.date)}</span><span class="status cancelled">Отменён</span></div><div class="new-booking-main"><div class="new-booking-title"><strong>${esc(studentName(booking))}</strong>${ageBadge(booking.age)}</div><div class="cancellation-contact"><span>Родитель: <strong>${esc(booking.parentName||'Не указан')}</strong></span>${booking.phone?` · <a href="tel:${esc(booking.phone)}" class="new-inline-link">${icon('phone')} ${esc(booking.phone)}</a>`:''}</div><div class="cancellation-note"><span>Причина отмены:</span> <strong>${esc(booking.cancelReason||'Причина не указана')}</strong></div><div class="new-booking-links">${externalLink(booking.crmUrl,'Открыть сделку в Amo CRM','new-inline-link')}</div></div><div class="new-booking-actions cancellation-actions-box"><button class="new-action primary" data-action="rebook" data-id="${esc(booking.id)}"><span>Записать на новый слот</span><small class="action-hint">Перейти в запись с контактами</small></button><button class="new-action secondary" data-action="restore" data-id="${esc(booking.id)}"><span>Вернуть в очередь</span><small class="action-hint">Восстановить в подтверждение</small></button></div></article>`;
    }
    return `<article class="new-booking-card${booking.state==='cancelled'?' is-cancelled':''}${booking.state==='completed'?' is-completed':''}"><div class="new-booking-time"><strong class="booking-hour">${esc(booking.time)}</strong><span class="booking-day">${dateText(booking.date)}</span><small class="booking-duration">60 минут</small></div><div class="new-booking-main"><div class="new-booking-title"><strong>${esc(studentName(booking))}</strong>${ageBadge(booking.age)}${booking.assignmentKind==='reserve'?'<span class="new-booking-reserve">Резерв</span>':''}</div><span class="new-booking-parent">${esc(booking.parentName||'Родитель не указан')} · ${esc(studentAge(booking))}</span><div class="new-booking-facts"><span>${booking.hasPc===true?'Компьютер есть':'Компьютер не указан'}</span><span>${booking.parentPresent===true?'Родитель будет':'Родитель не указан'}</span>${booking.assignedName?`<span>МИМК · ${esc(booking.assignedName)}</span>`:''}</div><div class="new-booking-links">${externalLink(booking.crmUrl,'Открыть AmoCRM','new-inline-link')}${externalLink(booking.backofficeUrl||state.config.backofficeUrl,'Открыть Backoffice','new-inline-link')}${detailsButton(booking)}${canAssignBooking(state.user,booking)?`<button class="new-inline-link" data-action="assignment" data-id="${esc(booking.id)}">${booking.assignedTo?'Сменить МИМК':'Назначить МИМК'}</button>`:''}</div></div><div class="new-booking-actions">${newBookingActions(booking)}</div></article>`;
  }).join('');
  const summaryBlock = isTrash
    ? `<div class="new-board-summary"><article><span>Всего отмен</span><strong style="color:#f87171">${counts.all}</strong></article><article><span>Клиентский отказ</span><strong>${bookings.filter(b=>/клиент|отказ|не приш|no-show/i.test(b.cancelReason||'')).length}</strong></article><article><span>Перезаписано</span><strong style="color:#34d399">${bookings.filter(b=>b.cancelReason?.includes('Перезапись')).length}</strong></article><article><span>Другие причины</span><strong>${bookings.filter(b=>!/клиент|отказ|не приш|no-show|перезапись/i.test(b.cancelReason||'')).length}</strong></article></div>`
    : `<div class="new-board-summary"><article><span>Записей</span><strong>${counts.all}</strong></article><article><span>Подтверждено</span><strong>${counts.confirmed}</strong></article><article><span>${view==='completed'?'Проведено':'В работе'}</span><strong>${view==='completed'?counts.completed:counts.inProgress}</strong></article><article><span>Отчётов</span><strong>${counts.reported}</strong></article></div>`;
  return `<section class="new-page new-board-page"><header class="new-page-heading"><div><span class="new-eyebrow">${esc(roles[state.user.role])}</span><h1>${esc(newPageTitle())}</h1><p>${esc(newPageSubtitle())}</p></div></header>${toolbar}${summaryBlock}<section class="new-booking-list">${cards||`<div class="new-empty-board"><strong>${isTrash?'Отменённых записей нет':'Записей пока нет'}</strong><span>${isTrash?'Здесь отображаются отменённые уроки с кнопкой быстрой перезаписи.':'Измените дату или дождитесь новых событий.'}</span></div>`}</section></section>`;
}

function renderNewUsersExact() {
  const cleanUsers=state.users.filter(u=>u.active!==false&&!u.email.includes('invalid')&&!u.id.startsWith('migration-')&&!u.id.startsWith('rubitime-')).filter(user=>matchesSearch({studentName:user.name,parentName:user.email},state.search));
  const roleOrder=['admin','call_center','confirmation','sales'];
  const roleTitles={admin:'Руководство и администрирование',call_center:'Колл-центр',confirmation:'Менеджеры подтверждения',sales:'Менеджеры МИМК (Продажи)'};
  const sections=roleOrder.map(roleKey=>{
    const groupUsers=cleanUsers.filter(u=>u.role===roleKey);
    if(!groupUsers.length)return '';
    const cards=groupUsers.map(user=>`<article class="new-staff-card">${renderStaffAvatar(user.name,'new-manager-avatar')}<div><strong>${esc(user.name)}</strong><span>${esc(user.email)}</span><small>${esc(roles[user.role]||user.role)}</small></div><span class="new-staff-status ${user.active?'active':'disabled'}">${user.active?'Активен':'Отключён'}</span><button class="new-action secondary" data-action="edit-user" data-id="${esc(user.id)}">Изменить</button></article>`).join('');
    return `<div class="staff-role-group"><h3 class="staff-role-heading">${esc(roleTitles[roleKey]||roleKey)} <span class="staff-count">(${groupUsers.length})</span></h3><div class="new-staff-list">${cards}</div></div>`;
  }).join('');
  return `<section class="new-page new-management-page"><header class="new-page-heading"><div><span class="new-eyebrow">Администратор</span><h1>Сотрудники</h1><p>Доступы, роли и возрастные группы команды.</p></div><button class="new-admin-button" data-action="create-user">+ Добавить сотрудника</button></header><section class="new-management-panel"><div class="new-panel-heading"><div><h2>Команда Booking</h2><p>${cleanUsers.length} активных сотрудников</p></div></div>${sections||'<div class="new-empty-board"><strong>Сотрудники не найдены</strong></div>'}</section></section>`;
}

function renderNewCompensationExact() {
  const data=state.compensation||{},rows=(data.rows||[]).filter(row=>!state.compensationManager||row.managerId===state.compensationManager),money=value=>`${Number(value||0).toLocaleString('ru-RU')} ₽`,sum=field=>rows.reduce((total,row)=>total+Number(row[field]||0),0);
  const cards=(data.bookings||[]).filter(row=>!state.compensationManager||row.managerId===state.compensationManager).map(row=>`<article class="new-money-row"><div><strong>${esc(row.studentName||'Имя не указано')}</strong><span>${dateText(row.date)} · ${esc(row.time)}</span></div><div><small>Подтверждение</small><strong>${money(row.confirmationAmount)}</strong></div><div><small>Посещение</small><strong>${money(row.attendanceAmount)}</strong></div><div><small>Всего</small><strong>${money(row.total)}</strong></div></article>`).join('');
  return `<section class="new-page new-management-page"><header class="new-page-heading"><div><span class="new-eyebrow">Менеджер подтверждения</span><h1>Начисления</h1><p>100 ₽ за подтверждение и 200 ₽ за посещённый урок.</p></div></header><div class="new-board-toolbar"><label><span>Период с</span><input type="date" id="compensation-from" aria-label="Начисления с" value="${esc(state.compensationFrom)}"></label><label><span>по</span><input type="date" id="compensation-to" aria-label="Начисления по" value="${esc(state.compensationTo)}"></label>${isAdmin()?`<label><span>Менеджер</span><select id="compensation-manager" aria-label="Менеджер подтверждения"><option value="">Все менеджеры</option>${(data.rows||[]).map(row=>`<option value="${esc(row.managerId)}"${selected(state.compensationManager,row.managerId)}>${esc(row.managerName)}</option>`).join('')}</select></label>`:''}<button class="new-admin-refresh" data-action="refresh" aria-label="Обновить начисления">${icon('refresh')}</button></div><div class="new-money-grid"><article><span>За подтверждение</span><strong>${money(sum('confirmationAmount'))}</strong><small>${sum('confirmedCount')} записей</small></article><article><span>За посещение</span><strong>${money(sum('attendanceAmount'))}</strong><small>${sum('attendedCount')} уроков</small></article><article><span>Всего за период</span><strong>${money(sum('total'))}</strong><small>${dateText(state.compensationFrom)} – ${dateText(state.compensationTo)}</small></article></div><section class="new-management-panel"><div class="new-panel-heading"><div><h2>По записям</h2><p>Начисление закрепляется за фактическим подтверждением.</p></div></div><div class="new-money-list">${cards||'<div class="new-empty-board"><strong>Начислений нет</strong><span>Измените период или дождитесь новых подтверждений.</span></div>'}</div></section></section>`;
}

function renderNewPaymentsExact() {
  const payments=(state.payments||[]).filter(payment=>matchesSearch({...payment,assignedName:payment.managerName},state.search));
  const cards=payments.map(payment=>`<article class="new-payment-card"><div><strong>${esc(payment.studentName||'Имя не указано')}</strong><span>${esc(payment.parentName||'Родитель не указан')} · ${dateText(payment.paidAt)}</span></div><div><small>Сумма</small><strong>${Number(payment.amountNet||0).toLocaleString('ru-RU')} ₽</strong></div><div><small>Обучение</small><span>${esc(payment.practice||'—')} · ${esc(payment.package||'—')}</span></div><div><small>Менеджер</small><span>${esc(payment.managerName||'—')}</span></div><div>${externalLink(payment.crmUrl,'Открыть сделку','new-inline-link')}</div></article>`).join('');
  return `<section class="new-page new-management-page"><header class="new-page-heading"><div><span class="new-eyebrow">Администратор</span><h1>Оплаты</h1><p>Оплата, пакет обучения и связь со сделкой AmoCRM.</p></div><button class="new-admin-button" data-action="payment">+ Оформить оплату</button></header><section class="new-management-panel"><div class="new-panel-heading"><div><h2>Реестр оплат</h2><p>${payments.length} записей в текущем списке</p></div><button class="new-admin-refresh" data-action="refresh" aria-label="Обновить оплаты">${icon('refresh')}</button></div><div class="new-payment-list">${cards||'<div class="new-empty-board"><strong>Оплат пока нет</strong><span>Оформленные оплаты появятся здесь.</span></div>'}</div></section></section>`;
}

function renderNewReportExact() {
  const completedBookings=state.bookings.filter(item=>item.state==='completed'&&!item.isTest);
  let booking=state.reportBookingId?completedBookings.find(b=>b.id===state.reportBookingId):null;
  if(!booking)booking=completedBookings[0]||state.bookings[0];
  const report=booking?.report||null;
  if(!booking)return `<section class="new-page new-report-page"><header class="new-page-heading"><div><span class="new-eyebrow">Отчёт и оплата</span><h1>Отчёт и оплата</h1><p>Выберите завершённый урок для заполнения отчёта.</p></div></header><div class="new-empty-board"><strong>Завершённых уроков пока нет</strong></div></section>`;
  const reportButton=canReport()?`<button class="new-admin-button" data-action="report" data-id="${esc(booking.id)}">${report?'Открыть отчёт':'Заполнить отчёт'} ${icon('arrow')}</button>`:'';
  const lessonList=completedBookings.length>1?`<aside class="new-panel new-report-selector" aria-label="Завершённые уроки"><div class="new-panel-heading"><div><h2>Уроки смены</h2><p>${completedBookings.length} завершённых</p></div></div><div class="new-report-lessons-list">${completedBookings.map(b=>{
    const isSel=b.id===booking.id;
    const hasRep=Boolean(b.report);
    return `<button type="button" class="report-lesson-picker${isSel?' active':''}" data-action="select-report-lesson" data-id="${esc(b.id)}"><div class="report-picker-top"><strong>${esc(b.time)}</strong><span class="report-picker-badge ${hasRep?'done':'needed'}">${hasRep?'Отчёт сдан':'Нужен отчёт'}</span></div><div class="report-picker-body"><span class="report-picker-name">${esc(studentName(b))} · ${esc(studentAge(b))}</span><small class="report-picker-manager">${esc(b.assignedName||'МИМК')}</small></div></button>`;
  }).join('')}</div></aside>`:'';
  return `<section class="new-page new-report-page"><header class="new-page-heading"><div><span class="new-eyebrow">${esc(roles[state.user.role])}</span><h1>Отчёт и оплата</h1><p>Отчёт сохраняется в Google Sheets и PostgreSQL, затем доступна оплата.</p></div><span class="new-status-pill">Урок проведён</span></header><div class="new-report-grid${completedBookings.length>1?' with-selector':''}">${lessonList}<article class="new-report-card"><div class="new-panel-heading"><div><h2>Отчёт по уроку</h2><p>${esc(studentName(booking))} · ${dateText(booking.date)} · ${esc(booking.time)} · ${esc(booking.assignedName||'МИМК')}</p></div></div><div class="new-report-facts"><div><span>Практика</span><strong>${esc(report?.practice||'Не заполнено')}</strong></div><div><span>Пакет</span><strong>${esc(report?.package||'Не заполнено')}</strong></div><div><span>Канал</span><strong>${esc(report?.channel||'Не заполнено')}</strong></div><div><span>Сумма нетто</span><strong>${report?.amountNet==null?'—':`${Number(report.amountNet).toLocaleString('ru-RU')} ₽`}</strong></div><div class="full"><span>Договорённость</span><strong>${esc(report?.agreement||'Не заполнено')}</strong></div></div><div class="new-report-footer"><span class="new-sync-mark">${report?'Отчёт сохранён':'Нужно заполнить отчёт'}</span>${reportButton}</div></article><aside class="new-panel new-report-summary"><h2>Статус урока</h2><div class="new-progress-line done"><i></i><span>Запись создана</span></div><div class="new-progress-line done"><i></i><span>Урок подтверждён</span></div><div class="new-progress-line done"><i></i><span>Урок проведён</span></div><div class="new-progress-line${report?' done':''}"><i></i><span>Отчёт заполнен</span></div><button class="new-capacity-button" data-action="payment" data-id="${esc(booking.id)}">Оформить оплату</button></aside></div></section>`;
}

function renderNewMobileExact() {
  const booking=state.bookings.find(item=>item.state==='scheduled'&&item.confirmationStatus!=='confirmed')||state.bookings[0];
  return `<section class="new-page new-mobile-page"><header class="new-page-heading"><div><span class="new-eyebrow">Mobile first</span><h1>Mobile first</h1><p>Подтверждение и работа МИМК помещаются в один экран телефона.</p></div><span class="new-status-pill">390 px</span></header><div class="new-mobile-layout"><div class="new-mobile-shell"><div class="new-mobile-top"><strong>Подтверждение</strong><span class="new-manager-tag">${booking?'1 ждёт':'Пусто'}</span></div><div class="new-mobile-content">${booking?`<article class="new-mobile-lesson"><div class="new-mobile-time">${esc(booking.time)} <span>сегодня</span></div><strong>${esc(studentName(booking))} · ${esc(studentAge(booking))}</strong><div class="new-mobile-tags"><span>60 минут</span><span>МИМК найден</span></div><small>Подтвердить до ${timeStamp(booking.confirmationDueAt)}</small><button class="new-admin-button" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить урок</button><button class="new-capacity-button" data-action="cancel" data-id="${esc(booking.id)}">Перенести</button></article>`:'<div class="new-empty-board"><strong>Нет уроков</strong></div>'}</div></div><aside class="new-panel new-mobile-notes"><h2>Что проверяем на мобильном</h2><div class="new-mobile-check">Дата и время видны сразу</div><div class="new-mobile-check">Главное действие одно</div><div class="new-mobile-check">Ошибки не скрыты цветом</div></aside></div></section>`;
}

function renderNewScheduleExact() {
  return `<section class="new-page new-schedule-page"><header class="new-page-heading"><div><span class="new-eyebrow">Администратор</span><h1>Расписание МИМК</h1><p>Открытые часы команды на 14 дней с быстрым редактированием слотов.</p></div></header><div class="new-schedule-frame">${renderSchedule()}</div></section>`;
}

function renderNewBookingExact() {
  return `<section class="new-page new-booking-page"><header class="new-page-heading"><div><span class="new-eyebrow">${esc(roles[state.user.role])}</span><h1>Новая запись</h1><p>Дата, свободный час и контакты сделки в одном потоке.</p></div></header><div class="new-booking-frame">${renderBookingWizard()}</div></section>`;
}

function renderNewView() {
  if(state.view==='overview')return renderNewOverview();
  if(state.view==='active')return renderNewSalesDay();
  if(state.view==='admin')return renderNewAdminExact();
  if(state.view==='drawer')return renderNewDrawerExact();
  if(state.view==='confirmation')return renderNewConfirmation();
  if(state.view==='report')return renderNewReportExact();
  if(state.view==='mobile')return renderNewMobileExact();
  if(state.view==='booking')return renderNewBookingExact();
  if(state.view==='schedule')return renderNewScheduleExact();
  if(['active','completed','trash'].includes(state.view))return renderNewBookingBoard(state.view);
  if(state.view==='users')return renderNewUsersExact();
  if(state.view==='compensation')return renderNewCompensationExact();
  if(state.view==='payments')return renderNewPaymentsExact();
  const content=renderBookings();
  return `<section class="new-page"><header class="new-page-heading"><div><span class="new-eyebrow">${esc(roles[state.user.role])}</span><h1>${esc(newPageTitle())}</h1><p>${esc(newPageSubtitle())}</p></div></header><div class="new-table-card">${content}</div></section>`;
}

function renderFreshness() {
  if(!state.dataStale||!state.lastLoadedAt)return '';
  const loaded=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date(state.lastLoadedAt));
  return `<div class="stale-banner" role="status"><strong>Показаны последние сохранённые данные</strong><span>Обновление не удалось · загружено в ${loaded} по Москве</span><button class="outline compact" data-action="refresh">Повторить</button></div>`;
}

function renderRoleGuide(){
  const guides={call_center:{title:'КЦ · запись',text:'Выберите свободный час, проверьте CRM и контакты, затем сохраните запись.',action:'После сохранения урок попадёт менеджеру подтверждения.'},confirmation:{title:'Подтверждение · контроль SLA',text:'Подтвердите урок до указанного дедлайна. После подтверждения Booking распределит его на открытое место.',action:'Если урок не подтверждён до дедлайна, он автоматически попадёт в отменённые.'},sales:{title:'Сейл · следующий шаг',text:'Примите назначенный основной урок, начните его вовремя и после завершения заполните отчёт ИМК.',action:'После отчёта об оплате сделка переходит в успешную реализацию.'},admin:{title:'Администратор · контроль',text:'Следите за часовой статистикой, резервами, SLA подтверждения и ошибками интеграций.',action:'Открывайте drilldown по часу, чтобы увидеть конкретные записи и назначения.'}};
  const guide=guides[state.user?.role];if(!guide)return '';
  return `<aside class="role-guide" aria-label="Подсказка по роли"><div class="role-guide-heading"><strong>${esc(guide.title)}</strong><span>Как работать в Booking</span></div><div class="role-guide-body"><span>${esc(guide.text)}</span><span class="role-guide-action">${esc(guide.action)}</span></div></aside>`;
}

function renderSync() {
  if(!isAdmin()||!state.sync)return '';
  const sync=state.sync;
  if(sync.loadError)return `<div class="connection-note" role="status">Не удалось проверить синхронизацию: ${esc(sync.loadError)}</div>`;
  const historyOpen=Number(sync.confirmationHistory?.open||0);
  if(historyOpen>0)return `<div class="error-banner" role="alert" style="margin-top:18px">Не связались подтверждения из Google Form: ${historyOpen}. Причина сохранена для повторной сверки. <button class="outline compact" data-action="confirmation-history-issues">Показать причины</button><button class="outline compact" data-action="retry-confirmation-history">Повторить сверку</button></div>`;
  if(Number(sync.errors||sync.error)>0)return `<div class="error-banner" role="alert" style="margin-top:18px">Изменения сохранены в базе букинга. Ошибок синхронизации Google Sheets: ${Number(sync.errors||sync.error)}.${sync.lastError?` ${esc(sync.lastError)}`:''}</div>`;
  if(!sync.enabled)return '';
  return '';
}

function renderAmoCrmStatus(){
  if(!isAdmin()||!state.amoCrm)return '';
  if(Number(state.amoCrm.error)>0)return `<div class="error-banner" role="alert" style="margin-top:18px">Ошибок доставки AmoCRM: ${Number(state.amoCrm.error)}. <button class="outline compact" data-action="amocrm-issues">Показать очередь</button></div>`;
  if(!state.amoCrm.enabled)return '';
  return '';
}

function renderNotificationStatus() {
  const status=state.notifications;
  if(!isAdmin()||!status?.enabled)return '';
  if(status.loadError)return '<div class="connection-note" role="status">Не удалось проверить уведомления Slack.</div>';
  const problems=[];
  if(!status.configured)problems.push('Slack ожидает настройки подключения.');
  if(status.uncertain)problems.push(`Нужно проверить доставку уведомлений в Slack: ${Number(status.uncertain)}. Повторная отправка остановлена, чтобы избежать дублей.`);
  if(status.blockedMapping){const names=(status.unmappedManagers||[]).map(person=>person.name).filter(Boolean);problems.push(`Не указан получатель Slack${names.length?`: ${names.join(', ')}`:''}.`);}
  if(status.configured&&(Number(status.error)>0||status.plannerError))problems.push('Часть уведомлений Slack задерживается. Записи и отчёты сохранены в букинге.');
  const pendingDue=Date.parse(status.oldestPendingDueAt||''),lastAttempt=Date.parse(status.lastAttemptAt||'');
  if(status.configured&&Number(status.pending||0)>0&&Number.isFinite(pendingDue)&&pendingDue<=Date.now()&&(!Number.isFinite(lastAttempt)||Date.now()-lastAttempt>120000))problems.push('Очередь Slack давно не обрабатывалась. Проверьте worker и подключение.');
  return problems.length?`<div class="error-banner" role="alert" style="margin-top:18px">${problems.map(esc).join(' ')}</div>`:'';
}

function renderSourceIntakeStatus() {
  const status=state.sourceIntake;
  if(!isAdmin()||!status?.enabled)return '';
  if(!(Number(status.issues)>0||Number(status.errors)>0)&&status.lastReceivedAt){const received=new Date(status.lastReceivedAt);const label=Number.isFinite(+received)?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(received):'время неизвестно';return `<div class="connection-note source-freshness" role="status">Rubitime подключён · последняя принятая запись: ${esc(label)} по Москве</div>`;}
  if(!(Number(status.issues)>0||Number(status.errors)>0))return '';
  const count=Number(status.issues);
  const message=count>0?`Нужна проверка записей из Rubitime: ${count}.`:'Часть записей из Rubitime пока не обработана. Данные сохранены.';
  return `<div class="error-banner" role="alert">${esc(message)} <button class="subtle compact" data-action="source-intake-issues">Проверить записи</button></div>`;
}

function sourceIssueExplanation(code) {
  const reasons={UNKNOWN_STAFF_MAPPING:'Не найден методист из Rubitime.',MIGRATION_LINK_REQUIRED:'Не удалось связать запись с перенесённым занятием.',EXISTING_CAPACITY_CONFLICT:'На выбранный час не хватает подходящих открытых мест.',REVISION_HASH_CONFLICT:'Получены разные данные одной версии записи.',SOURCE_IDENTITY_CONFLICT:'Найдена другая запись с теми же контактами или ссылкой AmoCRM.',CRM_ID_MISSING:'В записи Rubitime отсутствует ID сделки AmoCRM.',AMO_AUTHORITY:'В записи есть данные из AmoCRM.',BOOKING_MODIFIED:'Запись уже изменили в букинге.',BOOKING_PROTECTED:'По записи уже начали работу в букинге.',SOURCE_BOOKING_MISSING:'Запись не найдена в букинге.',INCOMPLETE_RECORD:'В записи не хватает обязательных данных.',INVALID_DATE:'Указана некорректная дата.',INVALID_PHONE:'Нужно проверить телефон.',INVALID_CRM:'Нужно проверить ссылку AmoCRM.',UNSUPPORTED_DURATION:'Продолжительность занятия отличается от 60 минут.',UNSUPPORTED_SLOT:'Время занятия не входит в рабочие часы.',INVALID_RECORD:'Нужно проверить данные записи.'};
  const advice=code==='UNKNOWN_STAFF_MAPPING'?'Проверьте соответствие методиста, затем повторите обработку.':code==='MIGRATION_LINK_REQUIRED'?'Нужна сверка перенесённых записей.':code==='EXISTING_CAPACITY_CONFLICT'?'Проверьте открытые часы в расписании, затем повторите обработку.':code==='CRM_ID_MISSING'?'Добавьте custom_field5 в исходную запись и отправьте событие повторно.':['SOURCE_IDENTITY_CONFLICT','AMO_AUTHORITY','BOOKING_MODIFIED','BOOKING_PROTECTED','SOURCE_BOOKING_MISSING'].includes(code)?'Нужна сверка с AmoCRM.':'Исправьте данные в Rubitime.';
  return {reason:reasons[code]||'Данные записи требуют проверки.',advice};
}

async function openSourceIntakeIssues() {
  if(!isAdmin()||!state.sourceIntake?.enabled)return;
  const request=++state.sourceIntakeRequest;
  showDialog('Проверка записей', '<div class="dialog-body"><div class="loading-line" role="status">Загружаем записи…</div></div>', {name:'source-intake-issues'});
  try {
    const result=await api('/integrations/rubitime/issues');
    if(!isAdmin()||request!==state.sourceIntakeRequest||!dialog.open||dialog.dataset.name!=='source-intake-issues')return;
    state.sourceIntakeIssues=Array.isArray(result.issues)?result.issues:[];
    const rows=state.sourceIntakeIssues.map(issue=>{
      const summary=issue.summary||{},explanation=sourceIssueExplanation(issue.code);
      const sourceDate=typeof summary.date==='string'?summary.date:'',parsedDate=new Date(`${sourceDate}T12:00:00Z`);
      const validDate=/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)&&Number.isFinite(+parsedDate)&&parsedDate.toISOString().slice(0,10)===sourceDate;
      const when=validDate?dateText(sourceDate):sourceDate?`${sourceDate} · проверьте дату`:'Дата не указана';
      const retry=sourceRetryCodes.has(issue.code)&&typeof issue.observation_id==='string'&&issue.observation_id.length>0&&issue.observation_id.length<=128;
      return `<article class="drawer-booking"><div class="drawer-booking-top"><div><strong class="student-name">${esc(summary.studentName||'Имя ученика не указано')}</strong><div class="small">${esc(when)} · ${esc(summary.time||'Время не указано')}</div>${summary.parentName?`<div>Родитель: ${esc(summary.parentName)}</div>`:''}${summary.phone?`<div class="small">${esc(summary.phone)}</div>`:''}${externalLink(summary.crmUrl,'Открыть AmoCRM')}${issue.record_id?`<div class="small">№ в Rubitime: ${esc(issue.record_id)}</div>`:''}</div></div><p>${esc(explanation.reason)}</p><p class="field-hint">${esc(explanation.advice)}</p>${retry?`<div class="drawer-actions"><button class="outline compact" data-action="source-intake-retry" data-id="${esc(issue.observation_id)}">Повторить обработку</button></div>`:''}</article>`;
    }).join('');
    showDialog('Проверка записей',`<div class="dialog-body">${rows||'<div class="empty">Записей для проверки нет. Если запись ещё не появилась, обновите список позже.</div>'}</div>`,{name:'source-intake-issues',footer:'<button class="secondary" data-action="close-dialog">Закрыть</button><button class="primary" data-action="source-intake-issues">Обновить список</button>'});
  } catch(error) {
    if(request!==state.sourceIntakeRequest||!isAdmin()||!dialog.open||dialog.dataset.name!=='source-intake-issues')return;
    if(error.status===404){state.sourceIntake=null;dialog.close();renderContent();notify('Проверка записей пока недоступна.');return;}
    showDialog('Проверка записей','<div class="dialog-body"><p role="alert">Не удалось загрузить записи. Повторите проверку.</p></div>',{name:'source-intake-issues',footer:'<button class="secondary" data-action="close-dialog">Закрыть</button><button class="primary" data-action="source-intake-issues">Повторить</button>'});
  }
}

function wizardDraft() {
  const value=drafts.read('create');
  const query=new URLSearchParams(location.search),prefillKey=location.search;
  if(prefillKey&&value.prefillKey!==prefillKey){
    const text=(name,max)=>{const raw=query.get(name);return raw&&raw.length<=max?raw:'';};
    const crmUrl=text('crmUrl',2048)||text('crm',2048),age=text('age',3),ageNumber=Number(age),hasPc=text('hasPc',8),parentPresent=text('parentPresent',8);
    Object.assign(value,{...(text('studentName',160)||text('student',160)?{studentName:text('studentName',160)||text('student',160)}:{}),...(text('parentName',160)||text('parent',160)?{parentName:text('parentName',160)||text('parent',160)}:{}),...(text('phone',40)?{phone:text('phone',40)}:{}),...(Number.isInteger(ageNumber)&&ageNumber>=1&&ageNumber<=18?{age:ageNumber}:{}),...(crmUrl?{crmUrl}:{}),...(hasPc?{hasPc:['1','true','да','yes'].includes(hasPc.toLowerCase())}:{}),...(parentPresent?{parentPresent:['1','true','да','yes'].includes(parentPresent.toLowerCase())}:{}),...(text('comment',5000)?{comment:text('comment',5000)}:{}),prefillKey});
    drafts.save('create',value);
  }
  if(!value.idempotencyKey){value.idempotencyKey=crypto.randomUUID();drafts.save('create',value);}
  return value;
}

function resetBookingWizard({fresh=false}={}) {
  if(fresh)drafts.remove('create');
  const draft=wizardDraft();
  const today=businessDate();
  const date=String(draft.date||state.config.demoDate||today)<today?today:String(draft.date||state.config.demoDate||today);
  state.wizard={step:draft.time&&draft.date===date?2:1,date,time:draft.date===date?draft.time||'':'',slots:[],loading:false,error:'',notice:'',request:0,success:null,findNearest:!draft.date};
}

function persistWizardSelection() {
  const wizard=state.wizard;
  drafts.save('create',{...wizardDraft(),date:wizard.date,time:wizard.time});
}

async function refreshBookingWizard({quiet=false}={}) {
  if(!state.wizard)resetBookingWizard();
  const wizard=state.wizard;
  if(wizard.success){renderContent();return;}
  const form=document.querySelector('#booking-wizard-form');
  if(form)persistForm(form);
  const date=wizard.date,age=wizardDraft().age;
  const validAge=Number.isInteger(Number(age))&&Number(age)>=1&&Number(age)<=18;
  const request=++wizard.request;
  wizard.loading=true;
  if(!quiet)renderContent();
  try {
    const result=await api(`/slots?${new URLSearchParams({from:date,to:addDays(date,13),...(validAge?{age}:{})})}`);
    if(state.wizard!==wizard||request!==wizard.request||state.view!=='booking')return;
    wizard.slots=result.slots||[];wizard.error='';
    if(wizard.findNearest&&wizard.step===1){
      const nearest=wizard.slots.filter(slot=>selectableBookingSlots([slot],slot.date).length).sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];
      if(nearest)wizard.date=nearest.date;
      wizard.findNearest=false;
    }
  } catch(error) {
    if(state.wizard===wizard&&request===wizard.request){wizard.slots=[];wizard.error=error.message;}
  } finally {
    if(state.wizard===wizard&&request===wizard.request){
      wizard.loading=false;
      // Background capacity updates must not replace a form while the manager types.
      if(!quiet||wizard.step!==3||!document.querySelector('#booking-wizard-form'))renderContent();
      else updateWizardSelectionHint();
    }
  }
}

function updateWizardSelectionHint() {
  const hint=document.querySelector('#wizard-selection-hint');
  if(!hint||!state.wizard)return;
  const wizard=state.wizard;
  const available=isBookingSelectionAvailable(wizard.slots,wizard.date,wizard.time);
  hint.classList.toggle('is-unavailable',!available||Boolean(wizard.error));
  hint.textContent=wizard.error||(!available?'Это время больше недоступно. Выберите другое время.':'Место проверяется ещё раз при записи.');
}

function wizardMonth(date) {return new Intl.DateTimeFormat('ru-RU',{month:'long'}).format(new Date(`${date}T12:00:00Z`));}
function wizardLongDate(date) {return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',weekday:'short'}).format(new Date(`${date}T12:00:00Z`));}
function wizardTimeLabel(time) {const end=bookingIntervalEnd(time);return end?`${time} – ${end.time}`:time;}

function wizardSlotButtons({preview=false}={}) {
  const wizard=state.wizard;
  const slots=selectableBookingSlots(wizard.slots,wizard.date);
  if(wizard.loading)return '<div class="wizard-slots-loading" role="status">Проверяем свободные места…</div>';
  if(wizard.error)return `<div class="wizard-inline-error" role="alert">${esc(wizard.error)} <button class="subtle" data-action="wizard-refresh">Повторить</button></div>`;
  if(!slots.length)return '<div class="wizard-no-slots">На эту дату свободных мест нет. Выберите другой день.</div>';
  return `<div class="wizard-slots${preview?' preview-slots':''}">${(preview?slots.slice(0,4):slots).map(slot=>`<button class="wizard-slot${wizard.time===slot.time?' selected':''}" data-action="wizard-slot" data-time="${esc(slot.time)}" aria-label="${esc(wizardLongDate(wizard.date))}, ${esc(wizardTimeLabel(slot.time))}, свободно мест ${Number(slot.remaining)}"><strong>${esc(preview?slot.time:wizardTimeLabel(slot.time))}</strong><span>Мест: ${Number(slot.remaining)}</span></button>`).join('')}</div>`;
}

function renderBookingWizard() {
  const wizard=state.wizard;
  if(!wizard)return '<div class="loading-line">Открываем запись…</div>';
  const steps=['Дата и время','Контакты ученика'];
  const available=isBookingSelectionAvailable(wizard.slots,wizard.date,wizard.time);
  const progress=`<nav class="wizard-progress" aria-label="Шаги записи">${steps.map((label,index)=>{const step=index+1;return `<button class="wizard-step${wizard.step===step?' active':wizard.step>step?' done':''}" data-action="wizard-step" data-step="${step}"${step>wizard.step&&!available?' disabled':''} aria-current="${wizard.step===step?'step':'false'}"><span class="wizard-step-number">${wizard.step>step?icon('check'):step}</span><span>${label}</span></button>`;}).join('')}</nav>`;
  if(wizard.success){
    const booking=wizard.success;
    return `<section class="booking-wizard"><div class="wizard-success"><span class="wizard-success-icon">${icon('check')}</span><h2>Ученик записан</h2><p>${esc(booking.studentName||'Ученик')} · ${dateText(booking.date)} · ${esc(booking.time)}</p>${statusBadge(booking)}<p class="wizard-success-note">Запись передана в очередь подтверждения. МИМК назначается автоматически по открытому расписанию.</p><div class="wizard-success-actions"><button class="primary" data-action="wizard-new">Записать ещё ученика</button><button class="outline" data-view="active">Все записи</button></div></div></section>`;
  }
  const draft=wizardDraft();
  let content='';
  if(wizard.step===1){
    const dates=bookingDateRail(wizard.date);
    content=`<div class="wizard-format-badge"><span>Формат:</span> <strong>Индивидуальный мастер-класс · 60 минут</strong></div><h2 class="wizard-page-heading">Выберите дату и свободное время</h2><section class="wizard-calendar"><div class="wizard-calendar-heading"><h3>${esc(wizardMonth(wizard.date))}</h3><label class="wizard-calendar-picker">${icon('calendar')}<span>Выбрать дату</span><input type="date" id="wizard-calendar-date" aria-label="Выбрать дату мастер-класса в календаре" value="${esc(wizard.date)}" min="${businessDate()}"></label></div><div class="wizard-date-rail"><button class="wizard-day-arrow" data-action="wizard-day-prev" aria-label="Предыдущий день"${wizard.date<=businessDate()?' disabled':''}>‹</button>${dates.map(date=>`<button class="wizard-day${date===wizard.date?' selected':''}" data-action="wizard-date" data-date="${date}" aria-pressed="${date===wizard.date}"><strong>${Number(date.slice(8))}</strong><span>${esc(new Intl.DateTimeFormat('ru-RU',{weekday:'short'}).format(new Date(`${date}T12:00:00Z`)))}</span></button>`).join('')}<button class="wizard-day-arrow" data-action="wizard-day-next" aria-label="Следующий день">›</button></div><div class="wizard-time-heading"><span>Московское время</span><span>Выберите доступный час</span></div>${wizardSlotButtons()}</section>`;
  } else {
    const ageOptions=['7','8','9','10','11','12','13','14','15','15+'];
    const currentAge=String(draft.age||'10');
    const ageChips=`<div class="age-chips-wrap" role="group" aria-label="Возраст ученика">${ageOptions.map(a=>`<button type="button" class="age-chip${(a==='15+'&&Number(currentAge)>=15)||currentAge===a?' selected':''}" data-action="wizard-age" data-age="${a==='15+'?'16':a}">${a}</button>`).join('')}</div><input type="hidden" name="age" value="${esc(currentAge)}" required>`;
    content=`<div class="wizard-contact-layout"><aside class="wizard-booking-summary"><span class="wizard-eyebrow">Индивидуальный мастер-класс</span><strong>${esc(wizardLongDate(wizard.date))}</strong><span class="wizard-summary-time">${esc(wizardTimeLabel(wizard.time))}</span><span class="wizard-summary-zone">60 минут · Индивидуально</span><button class="subtle" data-action="wizard-step" data-step="1">Изменить дату или время</button></aside><form id="booking-wizard-form" data-draft="create" class="wizard-contacts"><h2 class="wizard-page-heading">Контакты ученика</h2>${formError(wizard.error)}<div class="form-grid">${formField('studentName','Имя ученика',draft.studentName,{required:true})}<div class="field"><label class="field-label">Возраст ученика</label>${ageChips}</div>${formField('parentName','Имя родителя',draft.parentName,{required:true})}${formField('phone','Телефон родителя',draft.phone,{type:'tel',required:true,placeholder:'+7 999 123-45-67'})}${formField('crmUrl','Ссылка на сделку Amo CRM',draft.crmUrl,{type:'url',required:true,full:true,placeholder:'https://…amocrm.ru/leads/detail/…'})}<div class="wizard-checks field full"><label class="fact-toggle"><input type="checkbox" name="hasPc"${checked(draft.hasPc)}><span class="fact-chip">${icon('monitor')} Есть компьютер</span></label><label class="fact-toggle"><input type="checkbox" name="parentPresent"${checked(draft.parentPresent)}><span class="fact-chip">${icon('users')} Родитель будет на занятии</span></label></div>${formField('comment','Комментарий к записи',draft.comment,{type:'textarea',full:true})}</div><input type="hidden" name="date" value="${esc(wizard.date)}"><input type="hidden" name="time" value="${esc(wizard.time)}"><input type="hidden" name="idempotencyKey" value="${esc(draft.idempotencyKey)}"><div class="wizard-selection-hint${!available||wizard.error?' is-unavailable':''}" id="wizard-selection-hint">${esc(wizard.error||(!available?'Это время больше недоступно. Выберите другое время.':'Место бронируется и проверяется при записи.'))}</div><div class="wizard-contact-actions"><button type="button" class="secondary" data-action="wizard-step" data-step="1">Назад к датам</button><button class="primary" type="submit">Записать ученика ${icon('arrow')}</button></div></form></div>`;
  }
  return `<section class="booking-wizard" aria-label="Запись ученика на мастер-класс">${progress}${wizard.notice?`<div class="wizard-inline-error" role="alert">${esc(wizard.notice)}</div>`:''}${content}</section>`;
}

async function submitWizardBooking(event) {
  const form=event.target;
  if(form.id!=='booking-wizard-form')return;
  event.preventDefault();
  const wizard=state.wizard;
  const button=event.submitter||form.querySelector('[type=submit]');
  if(button.disabled)return;
  persistForm(form);
  const values=serializeForm(form);
  const errorBox=form.querySelector('.form-error');
  errorBox.textContent='';button.disabled=true;button.textContent='Проверяем место…';
  try {
    const result=await api(`/slots?${new URLSearchParams({date:values.date,age:values.age})}`);
    wizard.slots=result.slots||[];
    if(!isBookingSelectionAvailable(wizard.slots,values.date,values.time)){
      wizard.notice='Выбранное время больше недоступно. Выберите другое: контакты сохранены.';
      wizard.step=2;renderContent();return;
    }
    button.textContent='Записываем…';
    const saved=await api('/bookings',{method:'POST',body:{...values,age:Number(values.age)}});
    drafts.remove('create');wizard.success=saved.booking;wizard.error='';renderContent();
    notify('Ученик записан на мастер-класс');
  } catch(error) {
    // Keep the same key on retry if the previous response was lost.
    errorBox.textContent=error.message;
    if(error.status===409){wizard.notice=error.message;wizard.step=2;await refreshBookingWizard();}
  } finally {if(button.isConnected){button.disabled=false;button.innerHTML=`Записать ученика ${icon('arrow')}`;}}
}

function renderBookingToolbar() {
  const today=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long'}).format(new Date());
  if(state.view==='completed')return `<div class="toolbar booking-toolbar"><h2 class="view-date">Сегодня, ${esc(today)}</h2><span class="spacer"></span><label class="toolbar-label" for="completed-from">Дата МК от</label><input type="date" id="completed-from" aria-label="Дата МК от" value="${esc(state.completedFrom)}"><label class="toolbar-label" for="completed-to">до</label><input type="date" id="completed-to" aria-label="Дата МК до" value="${esc(state.completedTo)}"><label class="toolbar-label" for="completed-created-from">Записано с</label><input type="date" id="completed-created-from" aria-label="Записано с" value="${esc(state.completedCreatedFrom)}"><label class="toolbar-label" for="completed-created-to">по</label><input type="date" id="completed-created-to" aria-label="Записано по" value="${esc(state.completedCreatedTo)}"><button class="icon-button" data-action="refresh" aria-label="Обновить список">${icon('refresh')}</button></div>`;
  return `<div class="toolbar booking-toolbar"><h2 class="view-date">Сегодня, ${esc(today)}</h2><span class="spacer"></span><label class="toolbar-label" for="booking-date">Дата МК</label><input type="date" id="booking-date" aria-label="Дата мастер-класса" value="${esc(state.date)}">${state.date?'<button class="subtle compact" data-action="all-dates">Все даты</button>':''}<button class="secondary compact" data-action="today">Сегодня</button>${canCreate()&&state.view!=='trash'?`<button class="primary" data-action="create">+ Записать на мастер-класс</button>`:''}<button class="icon-button" data-action="refresh" aria-label="Обновить список">${icon('refresh')}</button></div>`;
}

function ageGroup(age) {return ageGroups.find(group=>{const [min,max]=group.split('-').map(Number);return Number(age)>=min&&Number(age)<=max;})||'';}
function ageBadge(age) {const group=ageGroup(age);return age?`<span class="age-tag" data-group="${group}">${esc(group||`${age} лет`)}</span>`:'';}
function studentName(booking) {return String(booking.studentName||'').trim()||'Имя не указано';}
function studentAge(booking) {return booking.age == null || booking.age === '' ? 'Возраст не указан' : `${Number(booking.age)} лет`;}
function legacyBadges(booking) {
  const testBadge=booking.isTest?'<span class="test-booking-badge">Тестовая запись</span>':'';
  const holdBadge=booking.capacityHold&&booking.state==='scheduled'?'<span class="capacity-hold-badge">Ожидает свободного МИМК</span>':'';
  if(!booking.legacy)return testBadge+holdBadge;
  const missing=booking.legacy.missingFields?.length>0;
  return `${testBadge}${holdBadge}<div class="legacy-badges"><span class="legacy-badge" title="Запись из прежнего букинга">Перенесено</span>${missing?'<span class="legacy-badge incomplete">Данные неполные</span>':''}</div>`;
}
function detailsButton(booking) {return canEditDetails(state.user,booking)?`<button class="subtle compact" data-action="details" data-id="${esc(booking.id)}">${booking.legacy?'Дополнить данные':'Изменить данные'}</button>`:'';}
function resolveLegacyButton(booking) {return canResolveLegacy(state.user,booking)?`<button class="subtle compact lesson-status-action" data-action="resolve-legacy" data-id="${esc(booking.id)}">Статус урока</button>`:'';}
function bookingEquipment(booking) {
  return `${booleanFact(booking.hasPc,'Компьютер есть','Без компьютера','Компьютер: не указано')} · ${booleanFact(booking.parentPresent,'Родитель будет','Родитель не будет','Участие родителя: не указано')}`;
}
function externalLink(url,label,className='link-line') {const safe=safeUrl(url);return safe?`<a class="${esc(className)}" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:'';}
function statusBadge(booking) {
  const presentation=bookingStatusPresentation(booking);
  const unknown=presentation.outcomeUnknown?' title="В прежнем букинге факт проведения не зафиксирован"':'';
  return `<span class="status ${presentation.tone}"${unknown}>${presentation.label}</span>${booking.assignmentKind==='reserve'&&booking.state==='scheduled'?'<span class="status reserve">Резерв</span>':''}`;
}

function renderBookings() {
  let bookings=state.bookings.filter(booking=>matchesSearch(booking,state.search));
  if(state.view==='confirmation')bookings=bookings.filter(booking=>booking.confirmationStatus!=='confirmed'&&booking.state==='scheduled').sort((a,b)=>String(a.confirmationDueAt).localeCompare(String(b.confirmationDueAt)));
  const toolbar=renderBookingToolbar();
  const confirmationNote=state.view==='confirmation'?'<div class="notice">Подтверждайте запись заранее. Крайний срок — за 2 часа до начала мастер-класса. Просроченная запись остаётся в очереди.</div>':'';
  if(!bookings.length)return `${toolbar}${confirmationNote}<div class="empty"><strong>${state.loading?'Загружаем мастер-классы':'Нет мастер-классов'}</strong>${state.search?'По вашему запросу ничего не найдено.':state.view==='confirmation'?'Все доступные записи обработаны.':state.view==='trash'?'Отменённые записи появятся здесь.':'Измените дату или дождитесь новых записей.'}</div>`;
  return `${toolbar}${confirmationNote}<div class="table-wrap"><table class="booking-table${state.view==='completed'?' completed-table':''}${state.view==='confirmation'?' confirmation-table':''}"><thead><tr><th>Ученик</th><th>Дата и время</th><th>Дополнительно</th><th>Статус урока</th><th>${state.view==='completed'?'':'Отчёт'}</th></tr></thead><tbody>${bookings.map(bookingRow).join('')}</tbody></table></div><div class="results-count">Записей: ${bookings.length}</div>`;
}

function bookingRow(booking) {
  const cancelled=booking.state==='cancelled';
  const completed=booking.state==='completed';
  const canActSales=isSales()&&booking.assignedTo===state.user.id;
  let actions='';
  if(cancelled){actions=`<div class="status-text cancelled"><span class="status-mark" aria-hidden="true">${icon('minus')}</span>Отменён</div><div class="cancel-detail">${esc(booking.cancelReason||'')}</div>${canRestoreBooking(state.user,booking)?`<button class="subtle compact" data-action="restore" data-id="${esc(booking.id)}">Восстановить запись</button>`:''}`;}
  else if(completed){actions=`<div class="status-text"><span class="status-mark" aria-hidden="true">${icon('check')}</span>Завершён</div>${canReport()&&!booking.isTest?`<button class="outline compact" data-action="payment" data-id="${esc(booking.id)}">Оформить оплату</button>`:''}`;}
  else if(booking.historyOnly||legacyOutcomeUnknown(booking)){actions=`${statusBadge(booking)}${resolveLegacyButton(booking)}`;}
  else if(booking.state==='in_progress') {actions=`${statusBadge(booking)}${canActSales?`<button class="primary" data-action="complete" data-id="${esc(booking.id)}">Завершить мастер-класс</button>`:''}`;}
  else if(canActSales&&booking.confirmationStatus==='confirmed'&&booking.assignmentKind==='primary') {actions=`<button class="primary" data-action="start" data-id="${esc(booking.id)}">Начать мастер-класс</button><button class="secondary" data-action="no-show" data-id="${esc(booking.id)}">Ученик не пришёл</button>`;}
  else {actions=statusBadge(booking);if(canConfirmBooking(state.user,booking))actions+=`<button class="primary compact" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить</button>`;if(['confirmation','call_center','admin'].includes(state.user.role))actions+=`<button class="subtle compact" data-action="cancel" data-id="${esc(booking.id)}">Отменить</button>`;}
  const timing=confirmationTiming(booking);
  const deadline=booking.confirmationStatus!=='confirmed'&&!cancelled&&!completed&&!legacyOutcomeUnknown(booking)?`<div class="status-note"${timing.overdue?' style="color:#c3656e"':''}>${timing.overdue?'Срок подтверждения истёк':'Подтвердить до'} ${timeStamp(booking.confirmationDueAt)}</div>`:'';
  const phone=String(booking.phone||'').replace(/[^+\d]/g,'');
  return `<tr><td data-label="Ученик"><span class="student-name">${esc(studentName(booking))}</span>${legacyBadges(booking)}<div class="booking-extra">${esc(bookingEquipment(booking))}</div>${booking.age==null?'<div class="status-note">Возраст не указан</div>':ageBadge(booking.age)}${booking.comment?`<div class="booking-note">${esc(booking.comment)}</div>`:''}</td><td data-label="Дата и время" class="lesson-date-cell"><div class="lesson-datetime"><span class="lesson-date">${dateText(booking.date)}</span><strong class="lesson-time">${esc(booking.time)}</strong></div><div class="status-note">60 минут</div><div class="status-note">Записано в ${timeStamp(booking.createdAt)}</div>${booking.assignmentKind==='reserve'?'<div class="status-note reserve-caption">Резерв</div>':''}</td><td data-label="Дополнительно">${externalLink(booking.backofficeUrl||state.config.backofficeUrl,'Перейти в Backoffice')}${externalLink(booking.crmUrl,'Перейти в Amo CRM')}<div>Родитель: ${esc(booking.parentName||'Не указано')}</div>${phone?`<a class="link-line" href="tel:${esc(phone)}">${esc(booking.phone)}</a>`:'<div class="status-note">Телефон не указан</div>'}${booking.assignedName?`<div class="status-note">МИМК: ${esc(booking.assignedName)}</div>`:booking.legacy?.managerName?`<div class="status-note">МИМК в прежнем букинге: ${esc(booking.legacy.managerName)}</div>`:''}${detailsButton(booking)}${canAssignBooking(state.user,booking)?`<button class="subtle compact" data-action="assignment" data-id="${esc(booking.id)}">${booking.assignedTo?'Сменить МИМК':'Назначить'}</button>`:''}</td><td data-label="Статус"><div class="button-stack">${actions}</div>${deadline}</td><td data-label="Отчёт">${canReport()&&completed?`<button class="report-button" data-action="report" data-id="${esc(booking.id)}" aria-label="${booking.report?'Открыть':'Заполнить'} отчёт о занятии ${esc(studentName(booking))}">${icon('document')}</button><div class="status-note">${booking.report?'Заполнен':'Не заполнен'}</div>`:booking.report?'<span class="status-note">Заполнен</span>':'<span class="muted">—</span>'}</td></tr>`;
}

function renderAdmin() {
  const headers=['Время слота','Количество МИМК','Количество слотов с Overbooking','Записано всего лидов на слот',"Записано лидов по правилу Overbooking’a",'МК Подтверждённые за час','МК отменённые М1','МК отменённые МИМК','Успешные МК'];
  const hours=state.hours.length?state.hours:Array.from({length:12},(_,i)=>({time:`${String(i+10).padStart(2,'0')}:00`}));
  const retroHours=state.retroHours.length?state.retroHours:Array.from({length:12},(_,i)=>({time:`${String(i+10).padStart(2,'0')}:00`}));
  const cell=(hour,metric,label,className='')=>`<td class="${className}"><button class="stats-cell-button" data-action="hour-metric" data-time="${esc(hour.time)}" data-metric="${metric}" aria-label="${esc(label)} на ${esc(hour.time)}: ${Number(hour[metric]||0)}">${Number(hour[metric]||0)}</button>${metric==='total'&&Number(hour.capacityHeld)>0?`<button class="capacity-hold-link" data-action="hour-metric" data-time="${esc(hour.time)}" data-metric="capacityHeld">Нужен МИМК: ${Number(hour.capacityHeld)}</button>`:''}</td>`;
  const retroCell=(hour,field,label)=>`<td><button class="stats-cell-button" data-action="retro-hour" data-time="${esc(hour.time)}" aria-label="${esc(label)} в ${esc(hour.time)}: ${Number(hour[field]||0)}">${Number(hour[field]||0)}</button></td>`;
  const funnel=state.funnel||{},recordedFunnel=state.recordedFunnel||{};const funnelItems=[['booked','Записано'],['confirmed','Подтверждено'],['assigned','Назначено'],['started','Начато'],['completed','Проведено'],['reported','Отчёт'],['paid','Оплата']];
  const funnelPanel=(title,note,data)=>`<section class="funnel-panel"><div class="retro-stats-heading"><div><h2>${title}</h2><p>${note}</p></div><strong>${Number(data.booked||0)} записей</strong></div><div class="funnel-grid">${funnelItems.map(([key,label])=>`<div class="funnel-step"><span>${label}</span><strong>${Number(data[key]||0)}</strong></div>`).join('')}</div></section>`;
  return `<div class="toolbar"><input type="date" id="admin-date" aria-label="Дата статистики" value="${esc(state.adminDate)}"><label class="age-filter-control"><span>Возраст</span><select id="admin-tag" class="sr-only" aria-label="Фильтр по возрастному тегу"><option value="">Все возраста</option>${ageFilterGroups.map(group=>`<option value="${ageFilterTag(group)}"${selected(state.tag,ageFilterTag(group))}>${group}</option>`).join('')}</select><div class="age-filter-bar" role="group" aria-label="Возраст ученика"><button type="button" class="age-filter-chip${!state.tag?' selected':''}" data-action="admin-age-filter" data-tag="" aria-pressed="${!state.tag}">Все</button>${ageFilterGroups.map(group=>`<button type="button" class="age-filter-chip${state.tag===ageFilterTag(group)?' selected':''}" data-action="admin-age-filter" data-tag="${esc(group)}" aria-pressed="${state.tag===ageFilterTag(group)}">${group}</button>`).join('')}</div></label><span class="spacer"></span><button class="primary" data-action="create">+ Записать на мастер-класс</button><button class="icon-button" data-action="refresh" aria-label="Обновить статистику">${icon('refresh')}</button></div>${funnelPanel('Воронка дня',`Путь записей по дате урока ${dateText(state.adminDate)}.`,funnel)}<div class="table-wrap"><table class="stats-table"><thead><tr>${headers.map(header=>`<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${hours.map(hour=>`<tr><td><button class="hour-button" data-action="hour" data-time="${esc(hour.time)}" aria-label="Все записи на ${esc(hour.time)}">${esc(hour.time)}</button></td>${cell(hour,'managers','Открытые МИМК')}${cell(hour,'capacity','Все открытые места')}${cell(hour,'total','Записанные ученики',Number((hour.activeTotal??hour.total)||0)>Number(hour.capacity||0)?'over':Number(hour.total||0)>0?'within':'')}${cell(hour,'reserve','Резервные записи')}${cell(hour,'confirmed','Подтверждённые уроки',isHourOverloaded(hour)?'over':'')}${cell(hour,'cancelledConfirmation','Отмены КЦ и подтверждения')}${cell(hour,'cancelledSales','Отмены МИМК')}${cell(hour,'completed','Проведённые уроки')}</tr>`).join('')}</tbody></table></div><div class="stats-footer"><span>Нажмите на число, чтобы увидеть состав показателя.</span><span>Записано: <strong>${hours.reduce((sum,hour)=>sum+Number(hour.total||0),0)}</strong></span><span>Подтверждено: <strong>${hours.reduce((sum,hour)=>sum+Number(hour.confirmed||0),0)}</strong></span></div><section class="retro-stats"><div class="retro-stats-heading"><div><h2>Ретро: записи, созданные в этот день</h2><p>Показывает, на какие часы уроков записали учеников ${dateText(state.adminDate)}. Нажмите на число для списка.</p></div><strong>${retroHours.reduce((sum,hour)=>sum+Number(hour.total||0),0)} записей</strong></div><div class="table-wrap"><table class="stats-table retro-stats-table"><thead><tr><th>Время урока</th><th>Записано</th><th>Подтверждено</th><th>Отменено</th><th>Проведено</th></tr></thead><tbody>${retroHours.map(hour=>`<tr><td>${esc(hour.time)}</td>${retroCell(hour,'total','Записано в этот день')}${retroCell(hour,'confirmed','Подтверждено')}${retroCell(hour,'cancelledConfirmation','Отменено КЦ')}${retroCell(hour,'completed','Проведено')}</tr>`).join('')}</tbody></table></div></section>${funnelPanel('Воронка записей дня',`Записи, созданные ${dateText(state.adminDate)}, включая будущие часы уроков.`,recordedFunnel)}`;
}

function openRetroHour(time) {
  const bookings=state.retroBookings.filter(booking=>booking.time===time);
  const rows=bookings.map(booking=>`<article class="drawer-booking"><div class="drawer-booking-top"><div><span class="student-name">${esc(studentName(booking))}</span><div class="small">Урок: ${dateText(booking.date)} · ${esc(booking.time)} · записано: ${timeStamp(booking.createdAt)}</div><div class="booking-extra">${esc(booking.parentName||'Родитель не указан')} · ${esc(booking.phone||'Телефон не указан')}</div>${externalLink(booking.crmUrl,'Перейти в Amo CRM')}${externalLink(booking.backofficeUrl||state.config.backofficeUrl,'Перейти в Backoffice')}</div><div>${statusBadge(booking)}<div class="status-note">${esc(booking.assignedName||'МИМК не назначен')}</div></div></div></article>`).join('');
  showDialog(`Записано в этот день · ${time}`,`<div class="dialog-body"><div class="hour-detail-summary"><strong>${dateText(state.adminDate)}</strong><span>Уроков на ${esc(time)}: ${bookings.length}</span></div>${rows||'<div class="empty">В этот день на данный час записей не было.</div>'}</div>`,{name:'retro-hour'});
}

function renderCompensation() {
  const data=state.compensation;
  const rows=(data?.rows||[]).filter(row=>!state.compensationManager||row.managerId===state.compensationManager);
  const bookings=(data?.bookings||[]).filter(row=>!state.compensationManager||row.managerId===state.compensationManager);
  const money=value=>`${Number(value||0).toLocaleString('ru-RU')} ₽`;
  const sum=field=>rows.reduce((total,row)=>total+Number(row[field]||0),0);
  const managers=data?.rows||[];
  return `<div class="toolbar compensation-toolbar"><label class="toolbar-label" for="compensation-from">Период с</label><input type="date" id="compensation-from" value="${esc(state.compensationFrom)}" aria-label="Начисления с"><label class="toolbar-label" for="compensation-to">по</label><input type="date" id="compensation-to" value="${esc(state.compensationTo)}" aria-label="Начисления по">${isAdmin()?`<select id="compensation-manager" aria-label="Менеджер подтверждения"><option value="">Все менеджеры подтверждения</option>${managers.map(row=>`<option value="${esc(row.managerId)}"${selected(state.compensationManager,row.managerId)}>${esc(row.managerName)}</option>`).join('')}</select>`:''}<span class="spacer"></span><button class="icon-button" data-action="refresh" aria-label="Обновить начисления">${icon('refresh')}</button></div><div class="compensation-summary"><article><span>За подтверждение</span><strong>${money(sum('confirmationAmount'))}</strong><small>Записей: ${sum('confirmedCount')} × ${money(data?.rates?.confirmation??100)}</small></article><article><span>За посещение</span><strong>${money(sum('attendanceAmount'))}</strong><small>Уроков: ${sum('attendedCount')} × ${money(data?.rates?.attendance??200)}</small></article><article class="compensation-total"><span>Начислено за период</span><strong>${money(sum('total'))}</strong><small>${dateText(state.compensationFrom)} – ${dateText(state.compensationTo)}</small></article></div><p class="compensation-note">За первое подтверждение — ${money(data?.rates?.confirmation??100)}. За проведённый урок — ещё ${money(data?.rates?.attendance??200)}. Повторное подтверждение не создаёт новое начисление.</p>${isAdmin()?`<div class="table-wrap compensation-table-wrap"><table class="users-table compensation-table"><thead><tr><th>Менеджер подтверждения</th><th>Подтверждений</th><th>Посещённых уроков</th><th>Начислено</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.managerName)}</td><td>${Number(row.confirmedCount||0)}</td><td>${Number(row.attendedCount||0)}</td><td><strong>${money(row.total)}</strong></td></tr>`).join('')||'<tr><td colspan="4">За этот период начислений нет.</td></tr>'}</tbody></table></div>`:''}<h2 class="section-heading compensation-heading">По записям</h2>${bookings.length?`<div class="table-wrap"><table class="users-table compensation-table"><thead><tr><th>Ученик</th><th>Дата и время урока</th>${isAdmin()?'<th>Менеджер</th>':''}<th>Подтверждение</th><th>Посещение</th><th>Всего</th></tr></thead><tbody>${bookings.map(row=>`<tr><td>${esc(row.studentName||'Имя не указано')}</td><td><strong>${dateText(row.date)}</strong><div class="small">${esc(row.time)}</div></td>${isAdmin()?`<td>${esc(row.managerName||'—')}</td>`:''}<td>${money(row.confirmationAmount)}<div class="small">${row.confirmedAt?timeStamp(row.confirmedAt):'—'}</div></td><td>${money(row.attendanceAmount)}<div class="small">${row.completedAt?timeStamp(row.completedAt):'Урок ещё не проведён'}</div></td><td><strong>${money(row.total)}</strong></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><strong>Начислений за этот период нет</strong>Подтверждённые записи и проведённые уроки появятся здесь.</div>'}`;
}

function renderPayments() {
  const payments=(state.payments||[]).filter(payment=>matchesSearch({...payment,assignedName:payment.managerName},state.search));
  return `<div class="toolbar"><h2 class="view-date">Оплаты</h2><span class="spacer"></span><button class="primary" data-action="payment">Оформить оплату</button><button class="icon-button" data-action="refresh" aria-label="Обновить оплаты">${icon('refresh')}</button></div>${payments.length?`<div class="table-wrap"><table class="users-table payments-table"><thead><tr><th>Ученик</th><th>Дата оплаты</th><th>Сумма</th><th>Обучение</th><th>Менеджер</th><th>Amo CRM</th></tr></thead><tbody>${payments.map(payment=>`<tr><td><strong>${esc(payment.studentName)}</strong><div class="small">Родитель: ${esc(payment.parentName)}</div></td><td>${dateText(payment.paidAt)}</td><td><strong>${Number(payment.amountNet||0).toLocaleString('ru-RU')} ₽</strong></td><td>${esc(payment.practice)}<div class="small">${esc(payment.package)} · ${Number(payment.paidLessons)} занятий${Number(payment.bonusLessons)>0?` + ${Number(payment.bonusLessons)} бонусных`:''}</div></td><td>${esc(payment.managerName||'—')}</td><td>${externalLink(payment.crmUrl,'Открыть сделку')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><strong>Оплат пока нет</strong>Оформите оплату после получения денег от клиента.</div>'}`;
}

function openPayment(booking) {
  if(!canReport())return;
  if(booking?.isTest){notify('Тестовая запись не используется для оформления оплаты',true);return;}
  const key=`payment.${booking?.id||'new'}`;
  const draft=drafts.read(key);
  if(!draft.idempotencyKey){draft.idempotencyKey=crypto.randomUUID();drafts.save(key,draft);}
  const practiceOptions=['Python','Vibe-coding','Scratch'];
  const packageOptions=salesPackageOptions;
  const paymentMethodOptions=['Кэш','Рассрочка','Сплит','Другое'];
  const formatOptions=['Индивидуальный','Групповой'];
  const values={studentName:booking?.studentName,parentName:booking?.parentName,phone:booking?.phone,age:booking?.age,crmUrl:booking?.crmUrl,practice:booking?.report?.practice||practiceOptions[0],package:booking?.report?.package||packageOptions[0],paymentMethod:booking?.report?.paymentMethod||paymentMethodOptions[0],format:formatOptions[0],managerId:booking?.assignedTo,recordingUrl:booking?.report?.recordingUrl,...draft};
  const paymentFields=formField('paidAt','Дата оплаты',values.paidAt||businessDate(),{type:'date',required:true})+formField('amountNet','Получено, ₽',values.amountNet??'',{type:'number',min:1,max:1000000000,step:1,required:true})+formField('practice','Направление',values.practice,{required:true,options:practiceOptions})+formField('package','Пакет',values.package,{required:true,options:packageOptions})+formField('paymentMethod','Способ оплаты',values.paymentMethod,{required:true,options:paymentMethodOptions})+formField('format','Формат обучения',values.format,{required:true,options:formatOptions})+formField('paidLessons','Оплачено занятий',values.paidLessons??'',{type:'number',min:1,max:10000,step:1,required:true})+formField('bonusLessons','Бонусных занятий',values.bonusLessons??0,{type:'number',min:0,max:10000,step:1});
  const contactFields=formField('studentName','Имя ученика',values.studentName,{required:true})+formField('age','Возраст ученика',values.age??'',{type:'number',required:true,min:1,max:18,step:1})+formField('parentName','Имя родителя',values.parentName,{required:true})+formField('phone','Телефон родителя',values.phone,{type:'tel',required:true})+formField('crmUrl','Ссылка на сделку Amo CRM',values.crmUrl,{type:'url',required:true,full:true});
  const extraFields=formField('product','Продукт',values.product,{placeholder:'Если отличается от направления'})+formField('months','Срок обучения, месяцев',values.months??'',{type:'number',min:1,max:60,step:1})+formField('registryDate','Дата УР',values.registryDate,{type:'date'})+formField('timezone','Часовой пояс',values.timezone||'Europe/Moscow')+formField('parentTelegram','Telegram родителя',values.parentTelegram)+formField('studentTelegram','Telegram ученика',values.studentTelegram)+formField('studentPhone','Телефон ученика',values.studentPhone,{type:'tel'})+formField('studentEmail','Почта ученика',values.studentEmail,{type:'email'})+formField('parentAvailability','Когда родителю удобно связаться',values.parentAvailability,{full:true})+formField('introDate','Дата вводного занятия',values.introDate,{type:'date'})+formField('introTime','Время вводного занятия',values.introTime,{type:'time'})+formField('introTeacher','Преподаватель вводного занятия',values.introTeacher)+formField('courseStartDate','Дата начала обучения',values.courseStartDate,{type:'date'})+formField('mainTeacher','Основной преподаватель',values.mainTeacher)+formField('recordingUrl','Ссылка на запись мастер-класса',values.recordingUrl,{type:'url',full:true});
  const weekdays=[['mon','Понедельник'],['tue','Вторник'],['wed','Среда'],['thu','Четверг'],['fri','Пятница'],['sat','Суббота'],['sun','Воскресенье']];
  showDialog('Оформление оплаты',`<form id="payment-form" data-draft="${esc(key)}"><div class="dialog-body">${formError()}<p class="report-header-note">Заполните фактическую оплату и параметры обучения. Сумму и способ оплаты укажите отдельно от отчёта об уроке.</p>${isAdmin()?`<label class="field payment-manager-field">Менеджер<select name="managerId" required><option value="">Выберите менеджера</option>${state.managers.map(manager=>`<option value="${esc(manager.id)}"${selected(values.managerId,manager.id)}>${esc(manager.name)}</option>`).join('')}</select></label>`:''}<h3 class="payment-form-heading">Оплата и обучение</h3><div class="form-grid">${paymentFields}</div><h3 class="payment-form-heading">Ученик и родитель</h3><div class="form-grid">${contactFields}</div><details class="payment-extra"><summary>Дополнительные данные для обучения</summary><div class="form-grid">${extraFields}</div><h3 class="payment-form-heading">Удобное время занятий</h3><div class="form-grid">${weekdays.map(([day,label])=>formField(`availability_${day}`,label,values[`availability_${day}`]||values.weekAvailability?.[day]||'',{placeholder:'Например, 17:00–20:00'})).join('')}${formField('specialConditions','Особые условия',values.specialConditions,{type:'textarea',full:true})}</div></details><input name="idempotencyKey" type="hidden" value="${esc(values.idempotencyKey)}">${booking?`<input name="bookingId" type="hidden" value="${esc(booking.id)}">`:''}</div><div class="dialog-footer"><span class="small">Черновик сохраняется автоматически</span><button class="secondary" type="button" data-action="close-dialog">Назад</button><button class="primary" type="submit">Оформить оплату</button></div></form>`,{name:'payment',bookingId:booking?.id||''});
}

function scheduleDraftKey() {return `schedule.grid14.${state.managerId}.${state.week}`;}
function persistSchedule() {drafts.save(scheduleDraftKey(),state.scheduleDraft);}

function scheduleInterval(interval,index,day) {
  const common=`data-schedule-date="${day.date}" data-index="${index}"`;
  const capacity=effectiveReserveCapacity(interval,day);
  return `<div class="interval interval-with-reserve"><div class="interval-time"><input type="time" step="3600" value="${esc(interval.start)}" aria-label="Начало рабочего интервала ${dateText(day.date)}" ${common} data-field="start"><span>–</span><input type="time" step="3600" value="${esc(interval.end)}" aria-label="Конец рабочего интервала ${dateText(day.date)}" ${common} data-field="end"><button class="remove-interval" data-action="remove-interval" data-date="${day.date}" data-index="${index}" aria-label="Удалить интервал">×</button></div><label class="interval-reserve">Резервных мест<select ${common} data-field="intervalReserveCapacity" aria-label="Резерв в интервале ${esc(interval.start)}–${esc(interval.end)} ${dateText(day.date)}"><option value="0"${selected(capacity,0)}>0</option><option value="1"${selected(capacity,1)}>1</option></select></label></div>`;
}

function renderScheduleOverview(dates) {
  if(!isAdmin()||!state.scheduleOverview)return '';
  const days=state.scheduleOverview;
  const hoursList=Array.from({length:12},(_,i)=>i+10);
  const hourColors={10:'red',11:'red',12:'red',13:'red',14:'amber',15:'amber',16:'amber',17:'green',18:'green',19:'green',20:'green',21:'green'};
  const dn=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

  // Total slots calculation
  const grandTotal=state.managers.reduce((sum,manager)=>{
    return sum+dates.reduce((dSum,date)=>dSum+scheduleHourEntries(days.find(day=>day.managerId===manager.id&&day.date===date)).size,0);
  },0);
  const potentialRub=Math.round(grandTotal*0.45*35000);

  // Summary manager cards
  const summaryCards=state.managers.map(manager=>{
    const total=dates.reduce((dSum,date)=>dSum+scheduleHourEntries(days.find(day=>day.managerId===manager.id&&day.date===date)).size,0);
    const warnStyle=total===0?'background:var(--r-bg);border-color:var(--r-bd)':'';
    const valColor=total===0?'color:var(--r)':'';
    return `<div class="hms-card" style="${warnStyle}"><div class="hms-name">💼 ${esc(manager.name)}</div><div class="hms-val" style="${valColor}">${total}</div><div class="hms-sub">${total===0?'⚠ не заполнил':'слотов на 14 дней'}</div></div>`;
  }).join('');

  // 1:1 Pre-October Grid Header (Row 1: Days with colspan=12, Row 2: Hours 10..21)
  let tableHeader='<thead><tr><th class="mgr-h" rowspan="2">💼 Менеджер</th>';
  dates.forEach(dStr=>{
    const d=new Date(dStr+'T12:00:00Z');
    const isWknd=d.getDay()===0||d.getDay()===6;
    const label=(isWknd?'🟡 ':'')+dn[d.getDay()]+' '+d.getDate()+'.'+String(d.getMonth()+1).padStart(2,'0');
    tableHeader+=`<th colspan="${hoursList.length}" class="day-hdr${isWknd?' weekend-hdr':''}">${label}</th>`;
  });
  tableHeader+='<th rowspan="2" class="total-hdr">Всего</th></tr><tr>';
  dates.forEach(()=>{
    hoursList.forEach(hr=>{
      tableHeader+=`<th class="hr-hdr">${hr}</th>`;
    });
  });
  tableHeader+='</tr></thead>';

  // Table Body: Each manager has 12 hourly cells per day with briefcase 💼
  let tableBody='<tbody>';
  state.managers.forEach(manager=>{
    let mgrTotal=0;
    tableBody+=`<tr class="hm-row"><td class="mgr-td">💼 ${esc(manager.name)}</td>`;
    dates.forEach(dStr=>{
      const dayEntry=days.find(day=>day.managerId===manager.id&&day.date===dStr);
      const entries=scheduleHourEntries(dayEntry);
      mgrTotal+=entries.size;
      hoursList.forEach(hr=>{
        const hasSlot=entries.has(hr);
        const colClass=hasSlot?`slot-${hourColors[hr]}`:'slot-0';
        tableBody+=`<td class="${colClass}" title="${esc(manager.name)} · ${dStr} · ${hr}:00">${hasSlot?'<span class="slot-num">💼</span>':''}</td>`;
      });
    });
    tableBody+=`<td class="mgr-total-cell"><strong>${mgrTotal}</strong></td></tr>`;
  });
  tableBody+='</tbody>';

  return `<section class="schedule-overview">
    <div id="hm-total-banner" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:16px;background:linear-gradient(135deg,rgba(245,200,66,0.1),rgba(62,207,142,0.06));border:1px solid var(--y-bd);border-radius:var(--r10);padding:14px 18px">
        <div style="flex:1">
          <div style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Итого слотов на 14 дней — все менеджеры</div>
          <div style="display:flex;align-items:baseline;gap:8px">
            <span style="font-size:32px;font-weight:700;font-family:var(--mono);color:var(--y)">${grandTotal}</span>
            <span style="font-size:13px;color:var(--sub);font-weight:500">ч открытых МК</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">${state.managers.length} менеджеров · потенциал ≈ <span style="color:var(--g);font-weight:600">${new Intl.NumberFormat('ru-RU').format(potentialRub)} ₽</span></div>
        </div>
        <div style="font-size:42px;opacity:.2">🕐</div>
      </div>
    </div>
    <div class="hm-summary">${summaryCards}</div>
    <div class="hm-legend" style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
      <div class="hm-leg-item" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)"><div class="hm-leg-dot" style="width:12px;height:12px;border-radius:3px;background:rgba(240,82,82,0.4)"></div>10:00–13:00 (низкий спрос)</div>
      <div class="hm-leg-item" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)"><div class="hm-leg-dot" style="width:12px;height:12px;border-radius:3px;background:rgba(245,150,0,0.4)"></div>14:00–16:00 (средний спрос)</div>
      <div class="hm-leg-item" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)"><div class="hm-leg-dot" style="width:12px;height:12px;border-radius:3px;background:rgba(40,200,120,0.4)"></div>17:00–21:00 (прайм тайм)</div>
    </div>
    <div class="hm-wrap"><table class="hm">${tableHeader}${tableBody}</table></div>
  </section>`;
}
function renderSchedule() {
  if(!state.managerId)return '<div class="empty"><strong>Нет менеджеров мастер-классов</strong>Добавьте сотрудника с ролью менеджера, чтобы настроить расписание.</div>';
  const dates=rollingScheduleDates(state.week),hours=Array.from({length:12},(_,index)=>index+10);
  const manager=state.managers.find(manager=>manager.id===state.managerId)||state.user;
  const schedule=state.scheduleDraft;
  if(!schedule)return '<div class="loading-line">Загружаем расписание…</div>';
  const pickedDay=schedule.days.find(day=>day.date===state.scheduleSelectedDay)||schedule.days[0];
  const pickedHours=scheduleHourEntries(pickedDay);
  const selectedCount=schedule.days.reduce((sum,day)=>sum+scheduleHourEntries(day).size,0);
  const dayLabel=date=>new Intl.DateTimeFormat('ru-RU',{weekday:'short'}).format(new Date(`${date}T12:00:00Z`));
  const dayButton=(date,className='')=>`<button class="schedule-day-picker ${className}${date===pickedDay.date?' selected':''}" data-action="schedule-pick-day" data-date="${date}" aria-pressed="${date===pickedDay.date}"><strong>${dateShort(date)}</strong><span>${dayLabel(date)}</span></button>`;
  return `${isAdmin()?`<div class="toolbar"><label class="toolbar-label" for="schedule-manager">МИМК</label><select id="schedule-manager">${state.managers.map(manager=>`<option value="${esc(manager.id)}"${selected(state.managerId,manager.id)}>${esc(manager.name)}</option>`).join('')}</select><span class="spacer"></span><button class="outline compact" data-action="schedule-overview">${state.scheduleOverview?'Скрыть команду':'Расписание команды'}</button></div>`:''}${state.scheduleConflict?'<div class="error-banner" role="alert">Расписание изменилось на сервере. Черновик сохранён. <button class="subtle compact" data-action="reset-schedule">Сбросить черновик и загрузить актуальное</button></div>':''}${renderScheduleOverview(dates)}<section class="schedule-panel schedule-grid-panel"><div class="schedule-title-row"><h2 class="schedule-heading">${esc(manager.name)}</h2><button class="subtle compact" data-action="copy-published-schedule">Скопировать расписание</button></div><div class="tag-toolbar"><h3>Теги:</h3>${schedule.ageGroups.map(group=>`<span class="age-tag" data-group="${esc(group)}">${esc(group)}<button type="button" data-action="remove-tag" data-tag="${esc(group)}" aria-label="Убрать возраст ${esc(group)}">×</button></span>`).join('')}<div class="tag-choice"><select id="age-tag-choice" aria-label="Добавить возрастной тег"><option value="">Добавить тег</option>${ageGroups.filter(group=>!schedule.ageGroups.includes(group)).map(group=>`<option>${group}</option>`).join('')}</select><button class="tag-add" data-action="add-tag" aria-label="Добавить выбранный тег">+</button></div></div><div class="schedule-range"><button class="icon-button" data-action="previous-week" aria-label="Предыдущие 14 дней"${state.week<=businessDate()?' disabled':''}>‹</button><div><strong>${dateShort(dates[0])} – ${dateText(dates.at(-1))}</strong><span>14 дней · московское время</span></div><button class="icon-button" data-action="next-week" aria-label="Следующие 14 дней">›</button><button class="subtle compact" data-action="schedule-today">От сегодня</button></div><div class="schedule-week-controls"><div class="schedule-week-switch" aria-label="Неделя расписания"><button data-action="schedule-week-tab" data-week="0" class="${state.scheduleTab===0?'selected':''}">Неделя 1</button><button data-action="schedule-week-tab" data-week="1" class="${state.scheduleTab===1?'selected':''}">Неделя 2</button></div><div class="schedule-copy-controls"><button class="subtle compact" data-action="copy-schedule-week" data-source="0">1 → 2</button><button class="subtle compact" data-action="copy-schedule-week" data-source="1">2 → 1</button><span>Добавить часы недели</span></div></div><div class="schedule-grid-wrap"><table class="schedule-grid"><thead><tr><th>Часы</th>${dates.map((date,index)=>`<th class="${index===7?'week-boundary':''}">${dayButton(date)}</th>`).join('')}</tr></thead><tbody>${hours.map(hour=>`<tr><th>${String(hour).padStart(2,'0')}:00</th>${dates.map((date,index)=>{
    const entries=scheduleHourEntries(schedule.days.find(day=>day.date===date));
    const active=entries.has(hour);
    const timeTone=hour<14?'time-morning':hour<17?'time-day':'time-prime';
    return `<td class="${index===7?'week-boundary':''}"><button class="schedule-hour-cell ${timeTone}${active?' selected':''}${date===pickedDay.date?' selected-day':''}" data-action="schedule-hour" data-date="${date}" data-hour="${hour}" aria-pressed="${active}" aria-label="${dateText(date)}, ${String(hour).padStart(2,'0')}:00, ${active?'открыто':'закрыто'}">${active?'💼':''}${active&&entries.get(hour)>0?'<i title="Есть резервное место"></i>':''}</button></td>`;
  }).join('')}</tr>`).join('')}</tbody><tfoot><tr><th>Всего</th>${dates.map(date=>`<td>${scheduleHourEntries(schedule.days.find(day=>day.date===date)).size||'—'}</td>`).join('')}</tr></tfoot></table></div><div class="schedule-mobile-editor"><div class="schedule-day-pills">${dates.slice(state.scheduleTab*7,state.scheduleTab*7+7).map(date=>dayButton(date)).join('')}</div><div class="schedule-mobile-hours">${hours.map(hour=>{const timeTone=hour<14?'time-morning':hour<17?'time-day':'time-prime';return `<button class="schedule-mobile-hour ${timeTone}${pickedHours.has(hour)?' selected':''}" data-action="schedule-hour" data-date="${pickedDay.date}" data-hour="${hour}" aria-pressed="${pickedHours.has(hour)}">${String(hour).padStart(2,'0')}:00${pickedHours.has(hour)?'💼':''}</button>`;}).join('')}</div></div><div class="schedule-day-tools"><strong>${dateText(pickedDay.date)}</strong><button class="outline compact" data-action="schedule-quick" data-date="${pickedDay.date}" data-start="17">Прайм 17–21</button><button class="outline compact" data-action="schedule-quick" data-date="${pickedDay.date}" data-start="14">День 14–21</button><button class="subtle compact" data-action="schedule-clear-day" data-date="${pickedDay.date}">Снять день</button><span class="spacer"></span><button class="subtle compact" data-action="schedule-clear-range">Очистить 14 дней</button></div><details class="schedule-interval-details"><summary>Интервалы и резерв · ${dateText(pickedDay.date)}</summary><div class="intervals">${pickedDay.intervals.map((interval,index)=>scheduleInterval(interval,index,pickedDay)).join('')}<button class="add-hours" data-action="add-interval" data-date="${pickedDay.date}">Добавить часы</button></div>${pickedDay.intervals.length?`<label class="reserve-field">Резерв во всех интервалах дня<select data-schedule-date="${pickedDay.date}" data-field="reserveCapacity" aria-label="Установить резерв во всех интервалах ${dateText(pickedDay.date)}"><option value="0"${selected(pickedDay.reserveCapacity??1,0)}>0</option><option value="1"${selected(pickedDay.reserveCapacity??1,1)}>1</option></select></label>`:''}</details><div class="schedule-description">Нажмите на час, чтобы открыть или закрыть его. Последний урок — 21:00–22:00. Точка в ячейке означает резервное место.</div><div class="schedule-save"><div><strong>${selectedCount} ч.</strong><span class="dirty-note" id="schedule-dirty">${drafts.read(scheduleDraftKey()).days?'Есть сохранённый черновик':'Опубликованное расписание'}</span></div><button class="primary" data-action="save-schedule"${state.scheduleConflict?' disabled':''}>Сохранить расписание</button></div></section>`;
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
    const slots=selectableBookingSlots(result.slots||[],date);
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

async function openResolveLegacy(booking) {
  if(!canResolveLegacy(state.user,booking))return;
  const users=booking.historyOnly?(await api('/users')).users||[]:[];
  if(!canResolveLegacy(state.user,booking))return;
  const managers=legacyResolutionManagers(state.user,booking,state.managers,users);
  const name=`resolve-legacy.${booking.id}`;
  const values=drafts.read(name);
  showDialog('Статус урока',`<form id="resolve-legacy-form" data-draft="${esc(name)}"><div class="dialog-body">${formError()}<p class="report-header-note">${esc(studentName(booking))} · ${dateText(booking.date)} · ${esc(booking.time)}</p><div class="notice">В прежнем букинге итог этого занятия не зафиксирован. Укажите фактический итог и основание. Прошедшая дата сама по себе не означает отмену.</div><div class="form-grid">${formField('outcome','Фактический итог',values.outcome||'',{required:true,full:true,options:[{value:'',label:'Выберите итог'},{value:'completed',label:'Фактически проведён'},{value:'cancelled',label:'Не состоялся'}]})}${formField('managerId','МИМК, который фактически провёл занятие',values.managerId||'',{full:true,options:[{value:'',label:'Выберите МИМК'},...managers.map(manager=>({value:manager.id,label:manager.name+(manager.active===false?' · архив':'')}))]})}${formField('reason','На основании чего уточнили итог',values.reason||'',{type:'textarea',required:true,full:true})}</div><p class="field-hint">${booking.historyOnly?'Архивное занятие не меняет открытые часы. Выберите фактического МИМК, включая сотрудников без активного доступа.':'Для проведённого занятия сервер проверит расписание МИМК, возраст и пересечения.'} После сохранения можно заполнить отчёт.</p></div><div class="dialog-footer"><span class="small">Итог сохранится в истории изменений</span><button type="button" class="secondary" data-action="close-dialog">Назад</button><button type="submit" class="primary">Сохранить итог</button></div></form>`,{name:'resolve-legacy',bookingId:booking.id,version:booking.version});
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
  const practiceOptions=['Python','Vibe-coding','Scratch'];
  const packageOptions=['1 месяц','3 месяца','6 месяцев','12 месяцев','1+1 (124к)'];
  const paymentMethodOptions=['Кэш','Рассрочка','Сплит','Другое'];
  const agreementOptions=['Оплачено','Оплата сегодня','Оплата завтра','Думает / перезвонить','Отказ'];
  const channelSuggestions=['RIS','Influence','Floctory','Mail','Яндекс Директ','VK','Партнёры','Другое'];
  const channelField=`<label class="field"><span>Канал привлечения</span><input type="text" list="channel-list" name="channel" value="${esc(values.channel||'')}" placeholder="Выберите или введите канал (RIS, VK, Floctory...)" required><datalist id="channel-list">${channelSuggestions.map(ch=>`<option value="${esc(ch)}">`).join('')}</datalist></label>`;
  const fields=formField('practice','Практика / направление',values.practice||practiceOptions[0],{required:true,options:practiceOptions})+formField('package','Пакет',values.package||packageOptions[0],{required:true,options:packageOptions})+formField('paymentMethod','Способ оплаты',values.paymentMethod||paymentMethodOptions[0],{required:true,options:paymentMethodOptions})+formField('agreement','Договорённость',values.agreement||agreementOptions[0],{required:true,options:agreementOptions})+formField('objection','Возражение',values.objection)+channelField+formField('amountNet','Сумма нетто (после вычета комиссий), ₽',values.amountNet??'',{type:'number',min:0,step:'0.01',required:true})+formField('recordingUrl','Ссылка на запись',values.recordingUrl,{type:'url'});
  showDialog('Отчёт о мастер-классе',`<form id="report-form" data-draft="${esc(name)}"><div class="dialog-body">${formError()}${facts}<div class="report-header-note">Отчёт сохраняется в базу и Google Sheets (gid 1367593612). Повторное сохранение обновляет отчёт.</div><div class="form-grid">${fields}</div><p class="field-hint" style="margin-top:18px">Сумма в отчёте фиксирует итог занятия. Оплата создаёт проводку в реестре.</p></div><div class="dialog-footer"><span class="small">Черновик сохраняется автоматически</span><button type="button" class="secondary" data-action="close-dialog">Закрыть</button><button type="submit" class="primary">Сохранить отчёт</button></div></form>`,{name:'report',bookingId:booking.id,version:booking.version});
}

function assignmentForm(booking) {
  return `<form class="assign-form assignment-editor" data-booking-id="${esc(booking.id)}" data-version="${Number(booking.version)}">${formError()}<label class="assignment-field"><span>МИМК</span><select name="managerId" aria-label="Менеджер мастер-класса" required><option value="">Выберите МИМК</option>${state.managers.map(manager=>`<option value="${esc(manager.id)}"${selected(booking.assignedTo,manager.id)}>${esc(manager.name)}</option>`).join('')}</select></label><label class="assignment-field assignment-kind"><span>Место</span><select name="kind" aria-label="Тип назначения"><option value="primary"${selected(booking.assignmentKind,'primary')}>Урок</option><option value="reserve"${selected(booking.assignmentKind,'reserve')}>Резерв</option></select></label><button class="primary" type="submit">${icon('check')}${booking.assignedTo?'Сохранить':'Назначить'}</button></form>`;
}

function openHour(time,oneBooking,metric='all') {
  const hour=state.hours.find(item=>item.time===time)||{};
  const names={all:'Все записи',managers:'Открытые МИМК',capacity:'Открытые места',capacityHeld:'Ожидают свободного МИМК',total:'Записанные ученики',reserve:'Резервные записи',confirmed:'Подтверждённые уроки',cancelledConfirmation:'Отмены КЦ и подтверждения',cancelledSales:'Отмены МИМК',completed:'Проведённые уроки'};
  const bookings=oneBooking?[oneBooking]:filterHourMetricBookings(state.bookings,{date:state.adminDate,time,tag:state.tag,metric,allocations:hour.allocations||[]});
  if(!oneBooking&&['managers','capacity'].includes(metric)){
    const managerRows=(hour.managerList||[]).map(manager=>{
      const allocations=(hour.allocations||[]).filter(item=>item.managerId===manager.id);
      const assigned=filterHourMetricBookings(state.bookings,{date:state.adminDate,time,tag:state.tag}).filter(booking=>booking.assignedTo===manager.id&&booking.state!=='cancelled');
      const allocated=allocations.length?allocations.length:assigned.length;
      const inProgress=assigned.filter(booking=>booking.state==='in_progress').length;
      const reserve=allocations.length?allocations.filter(item=>item.kind==='reserve').length:assigned.filter(booking=>booking.assignmentKind==='reserve').length;
      return `<article class="hour-manager"><div><strong>${esc(manager.name)}</strong><div class="hour-manager-tags">${(manager.ageGroups?.length?manager.ageGroups:ageGroups).map(group=>`<span class="age-tag" data-group="${esc(group)}">${esc(group)}</span>`).join('')}</div></div><div class="hour-manager-state"><span class="status ${inProgress?'in_progress':allocated?'confirmed':'available'}">${inProgress?'Урок в работе':allocated?'Есть записи':'Открыто'}</span><small>${metric==='capacity'?`1 место${Number(manager.reserveCapacity)>0?` + ${Number(manager.reserveCapacity)} резерв`:''}`:`Записей: ${allocated}`}${reserve?` · в резерве: ${reserve}`:''}</small></div></article>`;
    }).join('');
    showDialog(`${names[metric]} · ${time}`,`<div class="dialog-body"><div class="hour-detail-summary"><strong>${dateText(state.adminDate)}</strong><span>${metric==='capacity'?`Всего мест: ${Number(hour.capacity||0)}`:`Открыто МИМК: ${Number(hour.managers||0)}`}${state.tag?` · возраст ${esc(state.tag)}`:''}</span></div>${managerRows||'<div class="empty">На этот час нет открытых МИМК.</div>'}</div>`,{name:'hour'});
    dialog.dataset.hour=time;dialog.dataset.metric=metric;return;
  }
  const rows=bookings.map(booking=>{
    const ordinaryScheduled=booking.state==='scheduled'&&!booking.historyOnly&&!legacyOutcomeUnknown(booking);
    const phone=String(booking.phone||'').replace(/[^+\d]/g,'');
    const contacts=`<div style="margin-top:8px">Родитель: ${esc(booking.parentName||'Не указано')}</div>${phone?`<a class="link-line" href="tel:${esc(phone)}">${esc(booking.phone)}</a>`:'<div class="status-note">Телефон не указан</div>'}<div class="booking-extra">${esc(bookingEquipment(booking))}</div>`;
    const actions=`${detailsButton(booking)}${resolveLegacyButton(booking)}${canConfirmBooking(state.user,booking)?`<button class="outline compact" data-action="confirm" data-id="${esc(booking.id)}">Подтвердить</button>`:''}${ordinaryScheduled?`<button class="subtle compact" data-action="cancel" data-id="${esc(booking.id)}">Отменить запись</button>`:''}${booking.state==='completed'?`<button class="subtle compact" data-action="report" data-id="${esc(booking.id)}">${booking.report?'Открыть':'Заполнить'} отчёт</button>`:''}<button class="subtle compact" data-action="audit" data-id="${esc(booking.id)}">История изменений</button>`;
    return `<article class="drawer-booking" data-id="${esc(booking.id)}"><div class="drawer-booking-top"><div><span class="student-name">${esc(studentName(booking))}</span>${legacyBadges(booking)}<div class="small">${dateText(booking.date)} · ${esc(booking.time)} · ${esc(studentAge(booking))}</div>${contacts}${externalLink(booking.crmUrl,'Перейти в Amo CRM')}${externalLink(booking.backofficeUrl||state.config.backofficeUrl,'Перейти в Backoffice')}${booking.legacy?.managerName?`<div class="status-note">МИМК в прежнем букинге: ${esc(booking.legacy.managerName)}</div>`:''}</div><div>${statusBadge(booking)}<div class="status-note">${esc(booking.assignedName||'МИМК не назначен')}</div></div></div>${legacyOutcomeUnknown(booking)?'<p class="status-note">В прежнем букинге итог не зафиксирован. Требуется проверка администратора.</p>':''}${canAssignBooking(state.user,booking)?assignmentForm(booking):''}<div class="drawer-actions">${actions}</div></article>`;
  }).join('');
  showDialog(oneBooking?'Назначение МИМК':`${names[metric]||names.all} · ${time}`,`<div class="dialog-body">${oneBooking?'':`<div class="hour-detail-summary"><strong>${dateText(state.adminDate)}</strong><span>Записей: ${bookings.length}${state.tag?` · возраст ${esc(state.tag)}`:''}</span></div>`}${rows||'<div class="empty">Записей по этому показателю нет.</div>'}</div>`,{name:oneBooking?'assignment':'hour',bookingId:oneBooking?.id||''});
  dialog.dataset.hour=time||oneBooking?.time||'';
  dialog.dataset.metric=metric;
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
  if(action==='resolve-legacy'){await openResolveLegacy(booking);return;}
  if(action==='cancel'||action==='no-show'){openCancel(booking,action==='no-show');return;}
  if(action==='assignment'){openHour(booking.time,booking);return;}
  const result=await mutateBooking(id,action);
  const messages={confirm:'Запись подтверждена',start:'Мастер-класс начат',complete:'Мастер-класс завершён. Заполните отчёт.',restore:'Запись восстановлена'};
  notify(messages[action]||'Запись обновлена');
  if(action==='complete')openReport(result);
  else if(dialog.open&&['hour','assignment'].includes(dialog.dataset.name))openHour(dialog.dataset.hour,dialog.dataset.name==='assignment'?result:null,dialog.dataset.metric||'all');
  await refresh({quiet:true});
}

async function saveSchedule(button,{allowEmpty=false}={}) {
  if(!state.scheduleDraft)return;
  const schedule=structuredClone(state.scheduleDraft);
  const managerId=state.managerId;
  const draftKey=scheduleDraftKey();
  for(const day of schedule.days)for(const interval of day.intervals){if(!interval.start||!interval.end||interval.start>=interval.end)throw new Error(`Проверьте интервал ${dateText(day.date)}: конец должен быть позже начала.`);}
  if(!allowEmpty&&!schedule.days.some(day=>day.intervals.length)){
    showDialog('Закрыть все часы в этом периоде?',`<div class="dialog-body"><p>Будут закрыты часы ${esc(state.managers.find(manager=>manager.id===managerId)?.name||state.user.name)} с ${dateText(state.week)} по ${dateText(addDays(state.week,13))}.</p><p class="field-hint">Остальные даты сохранятся. Сервер проверит уже записанные уроки.</p></div>`,{name:'empty-schedule',footer:'<button class="secondary" data-action="close-dialog">Назад</button><button class="danger" data-action="save-empty-schedule">Закрыть часы и сохранить</button>'});return;
  }
  const savedSnapshot=JSON.stringify(schedule);
  button.disabled=true;button.textContent='Сохраняем…';
  try {
    const days=schedule.days.map(day=>{const {managerId:ignoredManager,ageGroups:ignoredGroups,...value}=schedulePayload(day,{managerId,ageGroups:schedule.ageGroups});return value;});
    const result=await api('/schedule/range',{method:'PUT',body:{managerId,from:state.week,to:addDays(state.week,13),days,ageGroups:schedule.ageGroups}});
    const local=drafts.read(draftKey);
    if(JSON.stringify(local)===savedSnapshot||!local.days)drafts.remove(draftKey);
    else {
      for(const day of local.days){const saved=result.days?.find(item=>item.date===day.date);if(saved)day.version=saved.version;}
      drafts.save(draftKey,local);
    }
    if(dialog.open&&dialog.dataset.name==='empty-schedule')dialog.close();
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
    if(action==='theme'){applyTheme(target.dataset.themeChoice);return;}
    if(action==='theme-cycle'){const values=Object.keys(themeLabels);applyTheme(values[(values.indexOf(state.theme)+1)%values.length]);return;}
    if(action==='prototype-reset'){state.view=defaultView();state.drawerHour='';state.error='';location.hash=state.view;await refresh();return;}
    if(action==='ui-mode'){applyUiMode();renderTabs();renderContent();return;}
    if(action==='refresh'){await refresh();return;}
    if(action==='admin-age-filter'){
      state.tag=target.dataset.tag?ageFilterTag(target.dataset.tag):'';
      const select=document.querySelector('#admin-tag');
      if(select)select.value=state.tag;
      await refresh();
      return;
    }
    if(action==='amocrm-issues'){const result=await api('/integrations/amocrm/issues');const rows=(result.issues||[]).map(issue=>`<article class="drawer-booking"><div class="drawer-booking-top"><div><strong>${esc(issue.event)}</strong><div class="small">${esc(issue.booking_id||'')} · попыток: ${Number(issue.attempts||0)}</div><div class="small">${esc(issue.last_error||issue.status)}</div></div><span class="status ${issue.status==='error'?'cancelled':'pending'}">${esc(issue.status)}</span></div>${issue.status==='error'?`<div class="drawer-actions"><button class="outline compact" data-action="amocrm-retry" data-id="${esc(issue.id)}">Повторить отправку</button></div>`:''}</article>`).join('');showDialog('Очередь AmoCRM',`<div class="dialog-body">${rows||'<div class="empty">Очередь пуста.</div>'}</div>`,{name:'amocrm-issues'});return;}
    if(action==='amocrm-retry'){target.disabled=true;try{await api(`/integrations/amocrm/issues/${encodeURIComponent(target.dataset.id)}/retry`,{method:'POST',body:{}});notify('AmoCRM job отправлен на повтор');await refresh({quiet:true});if(dialog.open&&dialog.dataset.name==='amocrm-issues')dialog.close();}finally{target.disabled=false;}return;}
    if(action==='source-intake-issues'){await openSourceIntakeIssues();return;}
    if(action==='source-intake-retry'){
      const issue=state.sourceIntakeIssues.find(item=>item.observation_id===id);
      if(!isAdmin()||!state.sourceIntake?.enabled||!issue||!sourceRetryCodes.has(issue.code))return;
      const oldText=target.textContent;target.disabled=true;target.textContent='Проверяем…';
      try{await api(`/integrations/rubitime/issues/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}});notify('Запись отправлена на повторную проверку');await refresh({quiet:true});if(dialog.open&&dialog.dataset.name==='source-intake-issues')await openSourceIntakeIssues();}
      finally{target.disabled=false;target.textContent=oldText;}
      return;
    }
    if(action==='create'){if(state.user.role==='call_center')await navigate('booking');else openCreate();return;}
    if(action?.startsWith('wizard-')){
      const form=document.querySelector('#booking-wizard-form');if(form)persistForm(form);
      const wizard=state.wizard;
      if(action==='wizard-new'){resetBookingWizard({fresh:true});await refreshBookingWizard();return;}
      if(action==='wizard-refresh'){await refreshBookingWizard();return;}
      if(action==='wizard-format'){wizard.step=2;renderContent();await refreshBookingWizard({quiet:true});return;}
      if(action==='wizard-step'){
        const step=Number(target.dataset.step);
        if(![1,2,3].includes(step))return;
        if(step===3&&!isBookingSelectionAvailable(wizard.slots,wizard.date,wizard.time)){wizard.step=2;await refreshBookingWizard();return;}
        wizard.step=step;renderContent();return;
      }
      if(['wizard-date','wizard-day-prev','wizard-day-next'].includes(action)){
        const selectedDate=action==='wizard-date'?date:addDays(wizard.date,action==='wizard-day-prev'?-1:1);
        if(selectedDate<businessDate())return;
        wizard.date=selectedDate;wizard.time='';persistWizardSelection();await refreshBookingWizard();return;
      }
      if(action==='wizard-slot'){
        const time=target.dataset.time;
        if(!isBookingSelectionAvailable(wizard.slots,wizard.date,time)){await refreshBookingWizard();return;}
        wizard.time=time;wizard.step=2;wizard.error='';wizard.notice='';persistWizardSelection();renderContent();
        document.querySelector('#booking-wizard-form [name=studentName]')?.focus();return;
      }
      if(action==='wizard-age'){
        const age=target.dataset.age;
        const input=document.querySelector('#booking-wizard-form [name=age]');
        if(input){input.value=age;input.dispatchEvent(new Event('input',{bubbles:true}));}
        document.querySelectorAll('.age-chip').forEach(btn=>btn.classList.toggle('selected',btn.dataset.age===age));
        return;
      }
      return;
    }
    if(action==='rebook'){
      const booking=state.bookings.find(item=>item.id===id);
      if(booking){
        drafts.save('create',{
          studentName:booking.studentName||'',
          parentName:booking.parentName||'',
          phone:booking.phone||'',
          age:booking.age||'',
          crmUrl:booking.crmUrl||'',
          hasPc:Boolean(booking.hasPc),
          parentPresent:Boolean(booking.parentPresent),
          comment:booking.cancelReason?`Перезапись: ${booking.cancelReason}`:'Перезапись из отменённого урока'
        });
        resetBookingWizard({fresh:false});
        await navigate('booking');
        notify('Данные подставлены для новой записи');
      }
      return;
    }
    if(action==='select-sales-manager'){
      state.activeSalesManagerId=id;
      renderContent();
      return;
    }
    if(action==='all-dates'){state.date='';await refresh();return;}
    if(action==='today'){state.date=businessDate();await refresh();return;}
    if(action==='prototype-hour'){
      const hour=state.hours.find(item=>Number(item.total||0)>0)||state.hours[0];
      if(hour){state.drawerHour=hour.time;await navigate('drawer');}
      else notify('Для выбранной даты нет часов для детализации',true);
      return;
    }
    if(action==='export-hour'){exportHourCsv(target.dataset.time||state.drawerHour||'16:00');return;}
    if(action==='reassign-drawer'){openHour(target.dataset.time||state.drawerHour||'16:00');return;}
    if(action==='reserve-drawer'){openHour(target.dataset.time||state.drawerHour||'16:00',null,'capacity');return;}
    if(action==='hour'){
      const hourTime=target.dataset.time||target.closest('[data-time]')?.dataset.time;
      if(hourTime&&state.view==='admin'){state.drawerHour=hourTime;await navigate('drawer');return;}
      if(hourTime&&state.view==='drawer'){state.drawerHour=hourTime;render();return;}
      openHour(hourTime);return;
    }
    if(action==='hour-metric'){openHour(target.dataset.time,null,target.dataset.metric);return;}
    if(action==='retro-hour'){openRetroHour(target.dataset.time);return;}
    if(action==='confirmation-history-issues'){const result=await api('/confirmation-history/issues');const rows=(result.issues||[]).map(issue=>`<article class="drawer-booking"><div class="drawer-booking-top"><div><strong>Строка ${Number(issue.sheet_row)}</strong><div class="small">${esc(issue.code)} · ${esc(issue.slot_time||'Время не распознано')} · ${issue.confirmed_at?timeStamp(issue.confirmed_at):'Дата не распознана'}</div>${issue.crm_url?externalLink(issue.crm_url,'Открыть Amo CRM'):''}<div class="booking-extra">Подтверждал: ${esc(issue.manager_name||'Не указан')} · Попыток: ${Number(issue.attempts||0)}</div></div><span class="status pending">Требует сверки</span></div></article>`).join('');showDialog('Подтверждения требуют сверки',`<div class="dialog-body">${rows||'<div class="empty">Открытых строк нет.</div>'}</div>`,{name:'confirmation-history-issues'});return;}
    if(action==='retry-confirmation-history'){target.disabled=true;try{const result=await api('/confirmation-history/retry',{method:'POST'});notify(result.unmatched||result.ambiguous?'Есть строки для сверки':'Сверка завершена');await refresh({quiet:true});}finally{target.disabled=false;}return;}
    if(action==='payment'){openPayment(id?getBooking(id):null);return;}
    if(action==='select-report-lesson'){state.reportBookingId=id;renderContent();return;}
    if(action==='create-user'){openUser();return;}
    if(action==='edit-user'){openUser(state.users.find(user=>user.id===id));return;}
    if(action==='audit'){await openAudit(id);return;}
    if(action==='previous-week'||action==='next-week'){persistSchedule();const next=addDays(state.week,action==='next-week'?14:-14);state.week=next<businessDate()?businessDate():next;state.scheduleDraft=null;state.scheduleTab=0;await refresh();return;}
    if(action==='schedule-today'){persistSchedule();state.week=businessDate();state.scheduleDraft=null;state.scheduleTab=0;await refresh();return;}
    if(action==='schedule-overview'){
      if(state.scheduleOverview){state.scheduleOverview=null;renderContent();return;}
      target.disabled=true;const dates=rollingScheduleDates(state.week);const result=await api(`/schedule?${new URLSearchParams({from:dates[0],to:dates.at(-1)})}`);state.scheduleOverview=result.days||[];renderContent();return;
    }
    if(action==='schedule-manager-day'){persistSchedule();state.managerId=target.dataset.managerId;state.scheduleSelectedDay=date;state.scheduleDraft=null;await refresh();return;}
    if(action==='schedule-pick-day'){state.scheduleSelectedDay=date;state.scheduleTab=rollingScheduleDates(state.week).indexOf(date)>=7?1:0;renderContent();return;}
    if(action==='schedule-week-tab'){state.scheduleTab=Number(target.dataset.week);state.scheduleSelectedDay=addDays(state.week,state.scheduleTab*7);renderContent();return;}
    if(action==='schedule-hour'){
      const index=state.scheduleDraft.days.findIndex(day=>day.date===date);if(index<0)return;
      state.scheduleDraft.days[index]=setScheduleHour(state.scheduleDraft.days[index],Number(target.dataset.hour));state.scheduleSelectedDay=date;persistSchedule();renderContent();return;
    }
    if(action==='schedule-quick'){
      const index=state.scheduleDraft.days.findIndex(day=>day.date===date);if(index<0)return;
      for(let hour=Number(target.dataset.start);hour<=21;hour++)state.scheduleDraft.days[index]=setScheduleHour(state.scheduleDraft.days[index],hour,{enabled:true});
      persistSchedule();renderContent();return;
    }
    if(action==='schedule-clear-day'||action==='schedule-clear-range'){
      state.scheduleDraft.days=state.scheduleDraft.days.map(day=>action==='schedule-clear-range'||day.date===date?{...day,intervals:[]}:day);persistSchedule();renderContent();return;
    }
    if(action==='copy-schedule-week'){
      const dates=rollingScheduleDates(state.week),source=Number(target.dataset.source),other=source?0:1;
      state.scheduleDraft.days=unionScheduleWeek(state.scheduleDraft.days,dates.slice(source*7,source*7+7),dates.slice(other*7,other*7+7));persistSchedule();renderContent();notify(`Часы недели ${source+1} добавлены в неделю ${other+1}`);return;
    }
    if(action==='copy-published-schedule'){
      const text=(state.schedulePublished?.days||[]).map(day=>{const hours=[...scheduleHourEntries(day).keys()].map(hour=>`${String(hour).padStart(2,'0')}:00`).join(' ');return hours?`${dateText(day.date)} ${hours}`:'';}).filter(Boolean).join('\n');
      if(!text){notify('В опубликованном расписании нет открытых часов');return;}
      await navigator.clipboard.writeText(text);notify('Опубликованное расписание скопировано');return;
    }
    if(action==='save-schedule'){await saveSchedule(target);return;}
    if(action==='save-empty-schedule'){await saveSchedule(target,{allowEmpty:true});return;}
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
  } catch(error) {if(error.status===409){dialog.close();notify('Запись изменилась. Данные обновлены, повторите действие.',true);await refresh({quiet:true});return;}notify(error.message,true);}
}

async function openAudit(id) {
  const result=await api(`/audit?bookingId=${encodeURIComponent(id)}`);
  const entries=result.audit||result.entries||result.events||[];
  showDialog('История изменений',`<div class="dialog-body"><ul class="audit-list">${entries.length?entries.map(entry=>`<li><div class="small">${timeStamp(entry.createdAt||entry.created_at)} · ${esc(entry.actorName||entry.actorId||entry.actor_id||'Система')}</div><strong>${esc(entry.action||entry.event||'Изменение')}</strong>${entry.reason?`<div>${esc(entry.reason)}</div>`:''}</li>`).join(''):'<li>История пока пуста.</li>'}</ul></div>`,{name:'audit',bookingId:id});
}

app.addEventListener('click',handleAction);
app.addEventListener('submit',submitWizardBooking);
app.addEventListener('change',async event=>{
  const input=event.target;
  try {
    if(input.id==='booking-date'){state.date=input.value;await refresh();}
    if(input.id==='completed-from'){state.completedFrom=input.value;await refresh();}
    if(input.id==='completed-to'){state.completedTo=input.value;await refresh();}
    if(input.id==='completed-created-from'){state.completedCreatedFrom=input.value;await refresh();}
    if(input.id==='completed-created-to'){state.completedCreatedTo=input.value;await refresh();}
    if(input.id==='admin-date'){state.adminDate=input.value||businessDate();await refresh();}
    if(input.id==='admin-tag'){state.tag=input.value;await refresh();}
    if(input.id==='compensation-from'){state.compensationFrom=input.value||`${businessDate().slice(0,7)}-01`;await refresh();}
    if(input.id==='compensation-to'){state.compensationTo=input.value||businessDate();await refresh();}
    if(input.id==='compensation-manager'){state.compensationManager=input.value;renderContent();}
    if(input.id==='schedule-manager'){if(state.scheduleDraft)persistSchedule();state.managerId=input.value;state.scheduleDraft=null;await refresh();}
    if(input.id==='wizard-calendar-date'&&input.value>=businessDate()){
      state.wizard.date=input.value;state.wizard.time='';persistWizardSelection();await refreshBookingWizard();
    }
    if(input.closest('#booking-wizard-form')){
      persistForm(input.closest('form'));
      if(input.name==='age')await refreshBookingWizard({quiet:true});
    }
  } catch(error){notify(error.message,true);}
});

app.addEventListener('input',event=>{
  const input=event.target;
  const form=input.closest('#booking-wizard-form');if(form){persistForm(form);return;}
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
    if(form.id==='payment-form') {
      persistForm(form);
      const body={...values};
      for(const field of ['age','amountNet','paidLessons','bonusLessons','months']){
        if(body[field]==='')delete body[field];else if(body[field]!==undefined)body[field]=Number(body[field]);
      }
      const weekAvailability={};
      for(const day of ['mon','tue','wed','thu','fri','sat','sun']){const value=String(body[`availability_${day}`]||'').trim();if(value)weekAvailability[day]=value;delete body[`availability_${day}`];}
      if(Object.keys(weekAvailability).length)body.weekAvailability=weekAvailability;
      for(const field of Object.keys(body))if(body[field]==='')delete body[field];
      await api('/payments',{method:'POST',body});
      drafts.remove(form.dataset.draft);dialog.close();notify('Оплата оформлена');await navigate('payments');
    }
    else if(form.id==='create-form') {
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
      const metric=dialog.dataset.metric||'all';await refresh({quiet:true});openHour(updated.time,single?updated:null,metric);
    } else if(form.id==='user-form') {
      const id=dialog.dataset.userId;
      const body={name:values.name,role:values.role,ageGroups:ageGroups.filter(group=>values[`age_${group}`]),...(id?{active:Boolean(values.active)}:{email:values.email}),...(values.password?{password:values.password}:{})};
      await api(id?`/users/${encodeURIComponent(id)}`:'/users',{method:id?'PATCH':'POST',body});
      form.elements.password.value='';dialog.close();notify(id?'Доступ сотрудника обновлён':'Сотрудник добавлен');
      const result=await api('/bootstrap');state.managers=result.managers||[];await refresh({quiet:true});
    }
  } catch(error) {
    if(errorBox)errorBox.textContent=error.status===409&&form.id!=='payment-form'?`${error.message} Закройте окно и откройте запись снова. Черновик сохранён.`:error.message;
    else notify(error.message,true);
    if(error.status===409)await refresh({quiet:true});
  } finally {if(button){button.disabled=false;button.textContent=oldText;}}
});

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.user)refresh({quiet:true});});
window.addEventListener('online',()=>{if(state.user)refresh({quiet:true});});
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(state.user&&view!==state.view&&allowedViews().includes(view))navigate(view);});

try {await bootstrap();} catch(error) {if(error.status===401)renderLogin();else app.innerHTML=`<main class="error-page" id="main"><h1>Не удалось открыть букинг</h1><p>${esc(error.message)}</p><button class="primary" id="retry-bootstrap">Повторить</button></main>`;document.querySelector('#retry-bootstrap')?.addEventListener('click',()=>location.reload());}
