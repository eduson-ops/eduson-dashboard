(() => {
'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const projects = {
 game:{title:'Starship Arcade',file:'06_starship_arcade.html',poster:'demo-game.png',eyebrow:'Пример · браузерная игра',filename:'starship-arcade / preview',description:'Управляй кораблём и сбивай астероиды. Можно играть самому или включить автопилот.',features:['Управление с клавиатуры и экрана','Очки, столкновения и движение','Ручное управление и автопилот'],href:'program.html#module-9',link:'игры с нейросетями ↗',status:'Стрелки или A / D — движение · пробел — выстрел'},
 site:{title:'CinemaX',file:'02_cinema_hub.html',poster:'demo-site.png',eyebrow:'Пример · интерактивный веб-сайт',filename:'cinemax / preview',description:'Найди фильм в каталоге, выбери жанр и открой карточку с подробностями.',features:['Поиск и фильтры по жанрам','Карточки с подробной информацией','Адаптивный интерфейс для разных экранов'],href:'program.html#module-1',link:'первые сайты в браузере ↗',status:'Попробуйте поиск, выбор жанра и карточки'},
 chat:{title:'NeuroStudio',file:'03_ai_chat_studio.html',poster:'demo-chat.png',eyebrow:'Пример · интерфейс AI-помощника',filename:'neurostudio / preview',description:'Интерфейс AI-чата с полем запроса, готовыми темами и историей диалога. Ответы в этом примере подготовлены заранее.',features:['Поле запроса и история диалога','Подсказки для первого сообщения','Ответы с текстом, кодом и иллюстрациями'],href:'program.html#lesson-12',link:'чат с AI, занятие 12 ↗',status:'Демонстрация · заранее подготовленные ответы'}
};
let current='game', frame=null, stageVisible=false, presenting=false, activeSection=0;
const stage=$('#demo-stage'), dialog=$('#demo-dialog'), shell=$('#demo-shell');
let demoOpener=null;
const isExpanded=()=>dialog.matches(':modal');
function pause(value){if(frame?.contentWindow)frame.contentWindow.postMessage({type:'vc:pause',paused:value},'*');}
function syncPause(){pause(document.hidden||(!isExpanded()&&!stageVisible));}
function destroyFrame(){if(frame){pause(true);frame.remove();frame=null;}}
function restorePoster(){stage.replaceChildren();const img=document.createElement('img');img.src='assets/'+projects[current].poster;img.alt=projects[current].title+' — интерактивный пример';img.width=1000;img.height=650;img.loading='lazy';const launch=document.createElement('div');launch.className='demo-launch';const button=document.createElement('button');button.type='button';button.className='btn btn-primary';button.id='launch-demo';button.textContent='Запустить проект ▶';launch.append(button);stage.append(img,launch);}
function selectProject(key){if(!projects[key])return;if(current!==key){destroyFrame();current=key;restorePoster();}const p=projects[key];$$('[data-project]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.project===key)));$('#project-title').textContent=p.title;$('#project-eyebrow').textContent=p.eyebrow;$('#project-description').textContent=p.description;$('#demo-filename').textContent=p.filename;$('#project-features').replaceChildren(...p.features.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));const link=$('#project-program-link');link.href=p.href;link.textContent=p.link;$('#demo-status').textContent=frame?p.status:'Управление появится после запуска';}
function launch(){if(frame)return;frame=document.createElement('iframe');frame.title=projects[current].title+' — интерактивная демонстрация';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.src='demos/'+projects[current].file;stage.replaceChildren(frame);$('#demo-status').textContent=projects[current].status;frame.addEventListener('load',syncPause);}
function openLarge(key){
 if(isExpanded())return;
 if(key)selectProject(key);
 demoOpener=document.activeElement;
 shell.style.minHeight=shell.offsetHeight+'px';
 $('#dialog-title').textContent=projects[current].title;
 // Change only the native dialog mode: moving an iframe would discard game state.
 dialog.close();dialog.classList.add('is-expanded');
 dialog.setAttribute('aria-labelledby','dialog-title');
 dialog.showModal();document.body.style.overflow='hidden';launch();syncPause();
}
dialog.addEventListener('close',()=>{
 // close() before showModal() queues a close event; ignore it while the modal is open.
 if(dialog.open)return;
 document.body.style.overflow='';dialog.classList.remove('is-expanded');
 dialog.removeAttribute('aria-labelledby');
 dialog.show();shell.style.minHeight='';
 demoOpener?.focus({preventScroll:true});demoOpener=null;syncPause();
});
$('#close-demo').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',e=>{if(e.target===dialog&&isExpanded()){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
$('#hero-play').addEventListener('click',()=>openLarge('game'));
$('#expand-demo').addEventListener('click',()=>openLarge());
stage.addEventListener('click',e=>{if(e.target.closest('#launch-demo'))launch();});
$$('[data-project]').forEach(button=>button.addEventListener('click',()=>selectProject(button.dataset.project)));
window.addEventListener('message',e=>{if(!frame||e.source!==frame.contentWindow||!e.data)return;if(e.data.type==='vc:ready')syncPause();if(e.data.type==='vc:escape'&&isExpanded())dialog.close();});
document.addEventListener('visibilitychange',syncPause);
if('IntersectionObserver'in window)new IntersectionObserver(entries=>{stageVisible=entries[0].isIntersecting;syncPause();},{threshold:.1}).observe(stage);else stageVisible=true;
const prices={standard:{name:'Индивидуальный',total:'71 244 ₽',monthly:'5 937 ₽',months:12},pro:{name:'Индивидуальный PRO',total:'124 500 ₽',monthly:'≈ 5 188 ₽',months:24}};
let selected=null,mode='monthly';
function paintPrices(){for(const [key,p]of Object.entries(prices)){const target=$('[data-price="'+key+'"]');target.replaceChildren(document.createTextNode(mode==='monthly'?p.monthly+' ':p.total));if(mode==='monthly'){const small=document.createElement('small');small.textContent='/ мес';target.append(small);}$('[data-price-caption="'+key+'"]').textContent=mode==='monthly'?'При рассрочке на '+p.months+' месяцев':'Стоимость всего предложения';}$$('[data-price-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.priceMode===mode)));}
$$('[data-price-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.priceMode;paintPrices();}));
$$('[data-select-plan]').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.selectPlan;const p=prices[selected];$$('[data-tariff-card]').forEach(card=>card.classList.toggle('selected',card.dataset.tariffCard===selected));$('#selection-title').textContent='Вы выбрали: '+p.name;$('#selection-summary').textContent='Vibe Coding · 12–15 лет · 48 занятий. Полная стоимость — '+p.total+'. Оформление и расписание согласуем с методистом.';$('#selection-panel').hidden=false;$('#copy-status').textContent='';$('#offer-fallback').hidden=true;$('#selection-panel').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest'});}));
$('#copy-offer').addEventListener('click',async()=>{if(!selected)return;const p=prices[selected];const text='Eduson Kids · Vibe Coding\n'+p.name+'\n12–15 лет · 48 индивидуальных занятий по 60 минут · 48 проектов\nПолная стоимость: '+p.total+'\nОриентир при рассрочке: '+p.monthly+' × '+p.months+' месяцев. Точные условия — при оформлении.\nРасписание и оформление согласуем с методистом.';try{if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(text);$('#copy-status').textContent='Условия скопированы';}catch{const area=$('#offer-fallback');area.value=text;area.hidden=false;area.focus();area.select();$('#copy-status').textContent='Скопируйте выделенный текст ниже.';}});
const sections=$$('.sales-section');
function updatePresentation(){const top=window.innerHeight*.36;let nearest=0,min=Infinity;sections.forEach((section,i)=>{const r=section.getBoundingClientRect();const d=Math.abs(r.top-top);if(r.top<=top&&r.bottom>top){nearest=i;min=0;}else if(min!==0&&d<min){min=d;nearest=i;}});activeSection=nearest;$('#section-counter').textContent=(nearest+1)+' / '+sections.length+' · '+sections[nearest].dataset.section;$('#previous-section').disabled=nearest===0;$('#next-section').disabled=nearest===sections.length-1;}
function setPresenting(value){presenting=value;document.body.classList.toggle('is-presenting',value);$('#presentation-toggle').setAttribute('aria-pressed',String(value));$('#presentation-bar').hidden=!value;updatePresentation();}
$('#presentation-toggle').addEventListener('click',()=>setPresenting(!presenting));$('#exit-presentation').addEventListener('click',()=>setPresenting(false));
function navigate(delta){const next=Math.max(0,Math.min(sections.length-1,activeSection+delta));sections[next].scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}
$('#previous-section').addEventListener('click',()=>navigate(-1));$('#next-section').addEventListener('click',()=>navigate(1));
let scrollScheduled=false;window.addEventListener('scroll',()=>{if(presenting&&!scrollScheduled){scrollScheduled=true;requestAnimationFrame(()=>{updatePresentation();scrollScheduled=false;});}},{passive:true});
document.addEventListener('keydown',e=>{if(!presenting||isExpanded()||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)return;if(e.key==='Escape'){setPresenting(false);return;}if(['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();navigate(['ArrowRight','PageDown'].includes(e.key)?1:-1);}});
window.addEventListener('pagehide',()=>pause(true));
})();
