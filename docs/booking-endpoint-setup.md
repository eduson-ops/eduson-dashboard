# Подключение записи на пробный урок

## 1. Google Sheets

В таблице `1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18` создай вкладку `Записи на пробный`.

Первая строка должна содержать:

```text
ID | Отметка времени | Дата | Время | Сейл | AmoCRM | Возраст | Телефон | Место | Статус | Автор | Изменено | Кто изменил | Idempotency-Key | Резервный журнал
```

Вкладки `Расписание` и `Слоты` не меняй. Две строки с одинаковыми датой, временем и сейлом считаются двумя местами.

## 2. Google Doc

Создай отдельный Google Doc для журнала бронирований и возьми его ID из URL. Скрипт добавляет одну строку при создании заявки и одну строку при смене статуса.

## 3. Apps Script

Создай Apps Script с содержимым [`booking-apps-script.gs`](../../booking-apps-script.gs). В Script Properties добавь:

- `SHEET_ID` = `1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18`
- `BOOKINGS_SHEET_NAME` = `Записи на пробный`
- `SLOTS_SHEET_NAME` = `Слоты`
- `DOC_ID` = ID резервного Google Doc
- `ROLE_MAP_JSON` = JSON с email, ролью и именем сейла

Пример `ROLE_MAP_JSON`:

```json
{
  "kc@example.com": {"role": "call_center", "name": "КЦ"},
  "second-line@example.com": {"role": "confirmation_manager", "name": "Вторая линия"},
  "sale@example.com": {"role": "sales", "name": "Виноградова Н."}
}
```

Разверни Web App с доступом для пользователей домена и включённой авторизацией Google. Скрипт определяет роль по `Session.getActiveUser().getEmail()`. Не используй анонимный deployment: клиентский выбор роли не является защитой.

## 4. Dashboard

Перед публикацией задай URL Web App до загрузки `booking-ui.js`:

```html
<script>window.BOOKING_API_URL='https://script.google.com/macros/s/DEPLOYMENT_ID/exec';</script>
```

При локальном тесте оставь значение по умолчанию и подключи same-origin dev endpoint. В production проверь, что deployment возвращает JSON с разрешённым origin или используй same-origin proxy: GitHub Pages не может сам добавить CORS-заголовки к Apps Script.

Для локального smoke-check запусти `node booking-dev-server.mjs`. Сервер принимает массив слотов через `BOOKING_SLOTS_JSON` и обслуживает `/booking`.

## 5. Проверка

1. КЦ создаёт две заявки на один двухместный слот.
2. Третья заявка получает ошибку нехватки мест.
3. Вторая линия подтверждает одну заявку.
4. Сейл видит подтверждённую заявку.
5. В Sheets и Google Doc появляются одинаковые `bookingId`.
