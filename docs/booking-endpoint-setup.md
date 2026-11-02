# Подключение записи на пробный урок

## 1. Google Sheets

В таблице `1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18` создай вкладку `Записи на пробный`.

Рабочая таблица уже подготовлена и содержит три booking-вкладки:

- `Записи на пробный` — native table `TrialBookings`, 15 полей заявки, фильтры и dropdown статусов.
- `Booking_Справочники` — роли, статусы, типы слотов и правила процесса.
- `Booking_Контроль` — формулы по заявкам и контроль ёмкости слотов из вкладки `Слоты`.

`Booking_Контроль` показывает `pending_confirmation`, `confirmed`, `rejected`, ёмкость, использованные места и остаток. Формулы используют разделитель `;`, потому что таблица работает с локалью `ru_RU`.

Первая строка должна содержать:

```text
ID | Отметка времени | Дата | Время | Сейл | AmoCRM | Возраст | Телефон | Место | Статус | Автор | Изменено | Кто изменил | Idempotency-Key | Резервный журнал
```

Вкладки `Расписание` и `Слоты` не меняй. Две строки с одинаковыми датой, временем и сейлом считаются двумя местами.

## 2. Google Doc

Создан резервный Google Doc: [Eduson — резервный журнал записи на пробный урок](https://docs.google.com/document/d/1so8xBJI7RIONjprVwcfGw1HXNfhcTMJwzwMgxJAUCNQ/edit). Его ID: `1so8xBJI7RIONjprVwcfGw1HXNfhcTMJwzwMgxJAUCNQ`. Скрипт добавляет одну строку при создании заявки и одну строку при смене статуса.

## 3. Apps Script

Создай Apps Script с содержимым [`booking-apps-script.gs`](../../booking-apps-script.gs). В Script Properties добавь:

- `SHEET_ID` = `1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18`
- `BOOKINGS_SHEET_NAME` = `Записи на пробный`
- `SLOTS_SHEET_NAME` = `Слоты`
- `DOC_ID` = `1so8xBJI7RIONjprVwcfGw1HXNfhcTMJwzwMgxJAUCNQ`
- `ROLE_MAP_JSON` = JSON с email, ролью и именем сейла

Пример `ROLE_MAP_JSON`:

```json
{
  "kc@example.com": {"role": "call_center", "name": "КЦ"},
  "second-line@example.com": {"role": "confirmation_manager", "name": "Вторая линия"},
  "sale@example.com": {"role": "sales", "name": "Виноградова Н."}
}
```

Рабочий Web App уже развернут:

`https://script.google.com/macros/s/AKfycbxkOxVAZKD4J5xqWayF1F7_Uglu-ZSeIeHjfVRtTs0tE9LlkbNNWl2t6kAm2cTk7KZFSw/exec`

Endpoint открыт для чтения слотов без входа, чтобы GitHub Pages мог загрузить форму. Скрипт определяет роль по `Session.getActiveUser().getEmail()`, поэтому создание и смена статусов разрешены только пользователям с рабочим Google-аккаунтом из `ROLE_MAP_JSON`. В текущем deployment карта содержит `d3eathwish@gmail.com` как `call_center`; добавь рабочие email второй линии и сейлов в `ROLE_MAP_JSON` перед боевым использованием.

В манифесте Apps Script включены scopes `spreadsheets`, `documents`, `calendar.readonly`, `script.external_request` и `script.scriptapp`. Клиентский выбор роли не является защитой: backend всегда сверяет email с `ROLE_MAP_JSON`.

## 4. Dashboard

Перед публикацией задай URL Web App до загрузки `booking-ui.js`:

```html
<script>window.BOOKING_API_URL='https://script.google.com/macros/s/AKfycbxkOxVAZKD4J5xqWayF1F7_Uglu-ZSeIeHjfVRtTs0tE9LlkbNNWl2t6kAm2cTk7KZFSw/exec';</script>
```

При локальном тесте оставь значение по умолчанию и подключи same-origin dev endpoint. В production клиент использует JSONP для чтения и скрытую HTML-форму для POST, потому что GitHub Pages не может сам добавить CORS-заголовки к Apps Script.

Для локального smoke-check запусти `node booking-dev-server.mjs`. Сервер принимает массив слотов через `BOOKING_SLOTS_JSON` и обслуживает `/booking`.

## 5. Проверка

1. КЦ создаёт две заявки на один двухместный слот.
2. Третья заявка получает ошибку нехватки мест.
3. Вторая линия подтверждает одну заявку.
4. Сейл видит подтверждённую заявку.
5. В Sheets и Google Doc появляются одинаковые `bookingId`.
