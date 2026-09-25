(() => {
  'use strict';
  const search = document.getElementById('lesson-search');
  if (!search) return;
  const modules = [...document.querySelectorAll('.program-module')];
  const lessons = [...document.querySelectorAll('.lesson')];
  const links = [...document.querySelectorAll('.module-nav-link')];
  const status = document.getElementById('search-status');
  const clear = document.getElementById('clear-search');
  const reset = document.getElementById('reset-search');
  const empty = document.getElementById('search-empty');
  const select = document.getElementById('module-select');
  const expand = document.getElementById('expand-modules');
  const normalize = value => value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const corpus = new Map(lessons.map(lesson => [lesson, normalize(lesson.textContent)]));
  let beforeSearch = null;
  let beforePrint = null;

  function setCurrent(module) {
    if (!module) return;
    links.forEach(link => {
      if (link.hash === '#' + module.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    select.value = module.id;
  }
  function updateExpandLabel() {
    const visible = modules.filter(module => !module.hidden);
    expand.textContent = visible.length && visible.every(module => module.open)
      ? 'Свернуть все модули' : 'Раскрыть все модули';
    expand.hidden = visible.length === 0;
  }
  function restoreOpenState() {
    if (beforeSearch) {
      beforeSearch.forEach((open, module) => { module.open = open; });
      beforeSearch = null;
    }
  }
  function applySearch() {
    const query = normalize(search.value);
    const words = query.split(' ').filter(Boolean);
    if (query && !beforeSearch) beforeSearch = new Map(modules.map(module => [module, module.open]));
    let count = 0;
    lessons.forEach(lesson => {
      const matches = words.every(word => corpus.get(lesson).includes(word));
      lesson.hidden = !matches;
      if (matches) count += 1;
    });
    modules.forEach(module => {
      const visible = [...module.querySelectorAll('.lesson')].some(lesson => !lesson.hidden);
      module.hidden = !visible;
      if (query && visible) module.open = true;
    });
    if (!query) restoreOpenState();
    clear.hidden = !search.value;
    empty.hidden = count !== 0;
    status.textContent = query
      ? 'Найдено занятий: ' + count + ' из ' + lessons.length
      : lessons.length + ' занятий в ' + modules.length + ' модулях';
    updateExpandLabel();
  }
  function clearSearch(focus = false) {
    search.value = '';
    applySearch();
    if (focus) search.focus();
  }
  function visitHash(focus = false) {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch (_) { return; }
    if (!/^(module|lesson)-\d+$/.test(id)) return;
    const target = document.getElementById(id);
    if (!target || (!target.classList.contains('program-module') && !target.classList.contains('lesson'))) return;
    clearSearch();
    const module = target.classList.contains('program-module') ? target : target.closest('.program-module');
    module.open = true;
    target.open = true;
    setCurrent(module);
    updateExpandLabel();
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      if (focus) target.querySelector('summary').focus({ preventScroll: true });
    });
  }

  search.addEventListener('input', applySearch);
  search.closest('form').addEventListener('submit', event => event.preventDefault());
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape' && search.value) {
      event.preventDefault();
      clearSearch(true);
    }
  });
  clear.addEventListener('click', () => clearSearch(true));
  reset.addEventListener('click', () => clearSearch(true));
  expand.addEventListener('click', () => {
    const visible = modules.filter(module => !module.hidden);
    const open = !visible.every(module => module.open);
    visible.forEach(module => { module.open = open; });
    updateExpandLabel();
  });
  select.addEventListener('change', () => {
    const hash = '#' + select.value;
    if (location.hash === hash) visitHash(true);
    else location.hash = hash;
  });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a[href^="#module-"], a[href^="#lesson-"]');
    if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (location.hash === anchor.hash) {
      event.preventDefault();
      visitHash(true);
    }
  });
  modules.forEach(module => module.addEventListener('toggle', updateExpandLabel));
  window.addEventListener('hashchange', () => visitHash(true));
  window.addEventListener('beforeprint', () => {
    beforePrint = new Map([...modules, ...lessons].map(item => [item, { open: item.open, hidden: item.hidden }]));
    beforePrint.forEach((state, item) => { item.hidden = false; item.open = true; });
  });
  window.addEventListener('afterprint', () => {
    if (!beforePrint) return;
    beforePrint.forEach((state, item) => { item.open = state.open; item.hidden = state.hidden; });
    beforePrint = null;
    updateExpandLabel();
  });
  document.querySelector('.program-toolbar').hidden = false;
  setCurrent(modules[0]);
  applySearch();
  visitHash();
})();
