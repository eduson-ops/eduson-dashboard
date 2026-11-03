(function (global) {
  'use strict';
  var destination = 'https://booking.82.148.17.109.sslip.io/';
  function render(root) {
    if (!root) return;
    root.innerHTML = '<div class="booking-empty"><h3>Букинг Eduson</h3>'
      + '<p>Записи, подтверждения, уроки и расписание доступны в букинге.</p>'
      + '<p><a class="booking-primary" href="' + destination + '">Открыть букинг →</a></p></div>';
  }
  global.initBookingUI = render;
  global.refreshBookingUI = function () { render(document.getElementById('booking-app')); };
})(window);
