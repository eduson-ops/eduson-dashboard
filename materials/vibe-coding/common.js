(() => {
  'use strict';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if ('IntersectionObserver' in window && !reduced.matches) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('reveal-in'); observer.unobserve(entry.target); }
    }), { threshold: .08 });
    document.querySelectorAll('[data-reveal]').forEach(element => observer.observe(element));
  }
})();
