# Booking → AmoCRM: этапы и дата урока

## Назначение

Booking является источником операционного статуса урока. После подтверждённого действия Booking отправляет в Ops relay запрос на обновление сделки AmoCRM.

## События

| Событие Booking | Этап AmoCRM | Условие |
|---|---|---|
| `booking.created` | `Назначено время занятия` | Запись создана через виджет Booking |
| `booking.confirmed` | `Занятие подтверждено` | Менеджер подтверждения нажал «Подтвердить» |
| `booking.cancelled` | `Занятие отменилось/перенеслось` | Нажата отмена или дедлайн подтверждения истёк |
| `booking.completed` | `Занятие проведено` | Урок проведён и отчёт ИМК сохранён |
| `booking.paid` | `Успешно реализовано` | Отчёт об оплате сохранён |

Другие этапы AmoCRM этим интеграционным контуром не меняются.

## Контракт исходящего события

```json
{
  "event_id": "uuid",
  "event": "booking.confirmed",
  "occurred_at": "2026-11-06T12:00:00.000Z",
  "booking_id": "booking-123",
  "crm_lead_id": "46747995",
  "crm_url": "https://eduson.amocrm.ru/leads/detail/46747995",
  "stage": "Занятие подтверждено",
  "lesson": {
    "date": "2026-11-06",
    "time": "15:00",
    "timezone": "Europe/Moscow",
    "starts_at": "2026-11-06T15:00:00+03:00",
    "duration_minutes": 60,
    "booking_url": "https://booking.82.148.17.109.sslip.io/",
    "recording_url": null
  },
  "reason": null,
  "source": "eduson-booking"
}
```

`crm_lead_id` берётся из связи Booking с AmoCRM. Для Rubitime-миграции исходное значение — `custom_field5`; `record_id` Rubitime хранится отдельно и не заменяет ID сделки.

## Правила даты и времени

- `date` хранит дату урока в московском календаре.
- `time` хранит время начала в формате `HH:mm`.
- `starts_at` содержит ISO-время с offset `+03:00`.
- Перенос урока отправляет новое значение даты и времени в следующем событии.
- Событие отмены также содержит последнюю назначенную дату и время.

## Доставка

Команда подключает один webhook Ops relay:

```text
POST https://ops.82.148.17.109.sslip.io/webhooks/amocrm/booking-stage
Authorization: Bearer <BOOKING_AMOCRM_WEBHOOK_TOKEN>
Content-Type: application/json
Idempotency-Key: <event_id>
```

Relay выполняет смену этапа и обновляет поля даты/времени сделки через AmoCRM API. Booking повторно отправляет событие только по очереди доставки. Повтор с тем же `event_id` должен быть безопасным.

## Приёмка

1. Создание записи в Booking переводит сделку на `Назначено время занятия`.
2. Подтверждение переводит сделку на `Занятие подтверждено`.
3. Отмена или истечение дедлайна переводит сделку на `Занятие отменилось/перенеслось`.
4. Заполненный отчёт ИМК переводит сделку на `Занятие проведено`.
5. Заполненный отчёт об оплате переводит сделку на `Успешно реализовано`.
6. В AmoCRM видны дата, время, часовой пояс и ссылка Booking.
7. Повторная доставка не создаёт дубли и не откатывает этап назад.
8. Ошибка AmoCRM видна администратору и доступна для повторной отправки.

## Что должна сделать команда интеграции

Команда предоставляет Booking полный URL своего webhook-приёмника и Bearer-токен. Внутри своего обработчика команда настраивает AmoCRM OAuth и сопоставляет названия `stage` из payload с числовыми `pipeline_id` и `status_id` AmoCRM. Booking не передаёт и не хранит AmoCRM OAuth команды.

Перед включением production команда прогоняет одну тестовую сделку через все пять событий, проверяет дату, время, ссылку Booking и повторную доставку с тем же `event_id`. Результат подтверждается по каждому событию.

## Совместимость с прежней интеграцией Rubitime

Команда также получает старый входной контракт, чтобы перенос не потерял уже собранные данные.

Источник Rubitime передаёт события `event-create-record`, `event-update-record` и `event-remove-record`. Ops relay преобразует их в нормализованные наблюдения Booking:

```text
event-create-record → upsert
event-update-record → upsert
event-remove-record → cancel
```

Маппинг исходных полей:

| Rubitime | Booking |
|---|---|
| `data.id` | `recordId` |
| `data.record` | `record.date`, `record.time` |
| `data.duration` | `durationMinutes` |
| `data.phone` | `record.phone` |
| `data.custom_field1` | `studentName` |
| `data.custom_field2` | `age` |
| `data.custom_field3` | `hasPc` |
| `data.custom_field4` | `parentPresent` |
| `data.custom_field5` | AmoCRM deal ID |
| `data.custom_field6` | `comment` |
| `data.url` | `raw.rubitimeUrl` |
| `data.cooperator_id` | `raw.sourceStaffId` |
| `data.status_title` | исходный статус источника |
| `data.branch_id` | фильтр `18335` для ИМК |

Для возрастов 7–15 и `branch_id=18335` создаётся рабочая запись Booking. ID сделки строится из `custom_field5`; Rubitime `record_id` хранится отдельно как источник. Повторное событие с той же версией безопасно. Изменение времени обновляет существующую запись. Удаление не стирает историю, а создаёт отмену.

Прежний n8n может получать копию исходного Rubitime webhook параллельно. Booking и PostgreSQL остаются рабочим журналом, поэтому команда может мигрировать обработку постепенно.
