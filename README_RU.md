# osu! Daily Tracker — EmptyMiyabi

Трекер использует официальный osu! API v2, сохраняет дневную историю в SQLite, результаты в CSV и графики PP/ранга.

## Однократная настройка
1. Создай приватный репозиторий GitHub и загрузи туда файлы архива.
2. В osu! Account settings → OAuth создай приложение. Используй Client Credentials.
3. В GitHub → Settings → Secrets and variables → Actions добавь `OSU_CLIENT_ID` и `OSU_CLIENT_SECRET`.
4. GitHub → Settings → Actions → General → Workflow permissions: включи **Read and write permissions**.
5. Во вкладке Actions включи workflow и вручную запусти **Daily osu! tracker** для проверки.

Не отправляй никому `OSU_CLIENT_SECRET` или пароль. Трекер их не запрашивает в чате.

## Данные
- Профиль: PP, ранги, accuracy, playcount, playtime, комбо и уровень.
- Лучшие 100 и недавние 100 результатов, уникальные score ID.
- `data/tracker.sqlite` — постоянная история.
- `reports/latest.md`, `snapshots.csv`, `scores.csv`, графики PP и ранга.

Cron запускается примерно вечером по центральноевропейскому времени; GitHub не гарантирует точную минуту. API возвращает только доступные поля и ограниченное число результатов. Источник: https://osu.ppy.sh/docs/
