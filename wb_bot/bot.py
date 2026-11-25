import json
import os
import re
import sqlite3
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from stats_image import render_stats


MSK = timezone(timedelta(hours=3))
MARKET = "https://marketplace-api.wildberries.ru"
CONTENT = "https://content-api.wildberries.ru"
COMMON = "https://common-api.wildberries.ru"
ADD, STATS, ASSEMBLY, PING = "Добавить магазин", "Статистика", "Список сборки", "Пинг"
MENU = {"keyboard": [[STATS, ASSEMBLY], [ADD, PING]], "resize_keyboard": True}


class ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = build_opener(NoRedirects())


def request(url, service, *, token=None, body=None, photo=None, timeout=15, read_json=True):
    headers = {"Authorization": token} if token else {}
    data = None
    if photo is not None:
        boundary = uuid4().hex
        fields = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            for name, value in body.items()
        )
        data = (
            fields + f'--{boundary}\r\nContent-Disposition: form-data; name="photo"; '
            'filename="orders.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
            + photo + f'\r\n--{boundary}--\r\n'.encode()
        )
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        with OPENER.open(Request(url, data=data, headers=headers), timeout=timeout) as response:
            return json.load(response) if read_json else response.status
    except HTTPError as error:
        raise ApiError(f"{service} — HTTP {error.code}", status=error.code) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise ApiError(f"{service} — ошибка соединения или ответа") from None


def month_counts(token, now):
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    final = int(now.timestamp())
    counts = Counter()
    seen = set()
    for date_from in range(int(start.timestamp()), final + 1, 15 * 86400):
        date_to = min(date_from + 15 * 86400 - 1, final)
        cursor = 0
        cursors = {cursor}
        while True:
            query = urlencode(dict(limit=1000, next=cursor, dateFrom=date_from, dateTo=date_to))
            page = request(f"{MARKET}/api/v3/orders?{query}", "WB заказы", token=token)
            orders = page["orders"]
            if not orders:
                break
            for order in orders:
                created = datetime.fromisoformat(order["createdAt"].replace("Z", "+00:00")).astimezone(MSK)
                if start <= created <= now and order["id"] not in seen:
                    counts[created.day] += 1
                    seen.add(order["id"])
            cursor = page["next"]
            if cursor in cursors:
                raise ApiError("WB повторил страницу заказов")
            cursors.add(cursor)
            time.sleep(0.25)
    return counts, sorted(seen)


def status_counts(token, order_ids):
    sold = delivery = 0
    for start in range(0, len(order_ids), 1000):
        if start:
            time.sleep(0.25)
        batch = order_ids[start:start + 1000]
        result = request(f"{MARKET}/api/v3/orders/status", "WB статусы", token=token, body={"orders": batch})
        statuses = {order["id"]: order for order in result["orders"]}
        if statuses.keys() != set(batch):
            raise ApiError("WB вернул неполный список статусов")
        for order in statuses.values():
            wb = order["wbStatus"]
            supplier = order["supplierStatus"]
            sold += wb == "sold"
            delivery += (
                wb in {"sorted", "postponed_delivery", "accepted_by_carrier",
                       "sent_to_carrier", "delivering_by_carrier"}
                or (supplier == "complete" and wb == "waiting")
            )
    return sold, delivery


def card_titles(token, wanted):
    cursor = {"limit": 100}
    titles = {}
    while wanted - titles.keys():
        body = {"settings": {"cursor": cursor, "filter": {"withPhoto": -1}}}
        page = request(f"{CONTENT}/content/v2/get/cards/list", "WB каталог", token=token, body=body)
        titles.update({
            card["nmID"]: card["title"] for card in page["cards"]
            if card["nmID"] in wanted and card.get("title")
        })
        position = page["cursor"]
        if position["total"] < 100:
            break
        next_cursor = {"limit": 100, "updatedAt": position["updatedAt"], "nmID": position["nmID"]}
        if next_cursor == cursor:
            raise ApiError("WB повторил страницу каталога")
        cursor = next_cursor
        time.sleep(0.65)
    return titles


def clean_title(title):
    title = re.sub(r"\b(?:восстановленный|iphone)\b", "", title, flags=re.IGNORECASE)
    return " ".join(title.split()).strip(" -,–—")


def sort_key(title):
    return [int(part) if part.isdigit() else part for part in re.split(r"([0-9]+)", title.casefold())]


class Bot:
    def __init__(self, token, owner, cipher, db):
        self.url = f"https://api.telegram.org/bot{token}"
        self.owner = owner
        self.cipher = cipher
        self.db = db
        self.add_until = 0
        self.pending_shop = None
        db.execute("CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT, token BLOB)")

    def telegram(self, method, *, photo=None, **body):
        result = request(f"{self.url}/{method}", "Telegram", body=body, photo=photo, timeout=40)
        if not result.get("ok"):
            raise ApiError("Telegram отклонил запрос")
        return result["result"]

    def send(self, text):
        chunk = ""
        for line in text.splitlines():
            line = line[:1700]
            if len(chunk) + len(line) + 1 > 1800:
                self.telegram("sendMessage", chat_id=self.owner, text=chunk, reply_markup=MENU)
                chunk = ""
            chunk += line + "\n"
        if chunk:
            self.telegram("sendMessage", chat_id=self.owner, text=chunk, reply_markup=MENU)

    def add_shop(self, token):
        manual_id = "manual:" + sha256(token.encode()).hexdigest()
        shop_id = manual_id
        try:
            seller = request(f"{COMMON}/api/v1/seller-info", "WB продавец", token=token)
            shop_id = str(seller["sid"])
            name = seller.get("tradeMark") or seller["name"]
            request(f"{MARKET}/api/v3/orders/new", "WB Маркетплейс", token=token)
        except ApiError as error:
            if error.status != 429:
                raise
            self.pending_shop = (shop_id, manual_id, self.cipher.encrypt(token.encode()))
            self.add_until = time.monotonic() + 300
            return "WB ограничил запросы (429). Введи название магазина вручную. Проверка доступа отложена. /cancel — отмена."

        self.save_shop(shop_id, manual_id, name, self.cipher.encrypt(token.encode()))
        self.add_until = 0
        return f"Магазин сохранён · {name}"

    def save_shop(self, shop_id, manual_id, name, encrypted):
        with self.db:
            self.db.execute(
                "INSERT INTO shops VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE "
                "SET name=excluded.name, token=excluded.token",
                (shop_id, name, encrypted),
            )
            if shop_id != manual_id:
                self.db.execute("DELETE FROM shops WHERE id = ?", (manual_id,))

    def report(self, action):
        shops = self.db.execute("SELECT name, token FROM shops ORDER BY name").fetchall()
        if not shops:
            return "Сначала нажми «Добавить магазин»."
        now = datetime.now(MSK)
        reports = []
        errors = []
        items = Counter()
        for name, encrypted in shops:
            try:
                token = self.cipher.decrypt(encrypted).decode()
                if action == STATS:
                    days, order_ids = month_counts(token, now)
                    try:
                        sold, delivery = status_counts(token, order_ids)
                    except (ApiError, KeyError, TypeError, ValueError) as error:
                        sold = delivery = None
                        detail = str(error) if isinstance(error, ApiError) else "ответ WB изменился"
                        errors.append(f"{name} · статусы недоступны ({detail})")
                    reports.append((name, [days[day] for day in range(1, now.day + 1)], sold, delivery))
                else:
                    orders = request(f"{MARKET}/api/v3/orders/new", "WB заказы", token=token)["orders"]
                    try:
                        titles = card_titles(token, {order["nmId"] for order in orders})
                    except (ApiError, KeyError, TypeError, ValueError) as error:
                        titles = {}
                        detail = str(error) if isinstance(error, ApiError) else "ответ WB изменился"
                        errors.append(f"{name} · названия недоступны ({detail}), показаны артикулы")
                    for order in orders:
                        article = order.get("article") or str(order["nmId"])
                        title = clean_title(titles.get(order["nmId"], article)) or article
                        items[title] += 1
            except InvalidToken:
                errors.append(f"{name} · не удалось расшифровать токен")
            except ApiError as error:
                errors.append(f"{name} · {error}")
            except (KeyError, TypeError, ValueError):
                errors.append(f"{name} · неожиданный ответ WB")
        if action == STATS:
            if reports:
                for start in range(0, len(reports), 8):
                    page = reports[start:start + 8]
                    photo = render_stats(page, reports, now, partial=len(reports) != len(shops))
                    caption = f"Заказы FBS · 01.{now.month:02d}–{now:%d.%m} · МСК"
                    self.telegram("sendPhoto", chat_id=self.owner, photo=photo, caption=caption)
            if not errors:
                return ""
            lines = []
        else:
            lines = [f"Новые заказы на сборку · {sum(items.values())} по доступным магазинам"]
            lines.extend(f"{title} × {items[title]}" for title in sorted(items, key=sort_key))
        return "\n".join(lines + (["", "Ошибки и ограничения"] + errors if errors else []))

    def ping(self):
        row = self.db.execute("SELECT token FROM shops ORDER BY id LIMIT 1").fetchone()
        wb_token = None
        if row:
            try:
                wb_token = self.cipher.decrypt(row[0]).decode()
            except InvalidToken:
                pass
        urls = [
            ("WB", f"{MARKET}/ping", wb_token),
            ("Москва", os.environ.get("MOSCOW_PING_URL"), None),
        ]
        lines = []
        for name, url, token in urls:
            if not url:
                lines.append("Москва · задай MOSCOW_PING_URL с адресом московского сервера")
                continue
            started = time.perf_counter()
            try:
                status = f"HTTP {request(url, name, token=token, read_json=False, timeout=5)}"
            except ApiError as error:
                status = str(error).removeprefix(f"{name} — ")
            elapsed = (time.perf_counter() - started) * 1000
            lines.append(f"{name} · {elapsed:.0f} мс · {status}")
        return "\n".join(lines)

    def handle(self, message):
        if message["chat"]["type"] != "private" or message.get("from", {}).get("id") != self.owner:
            return
        text = message.get("text", "").strip()
        if time.monotonic() >= self.add_until:
            self.pending_shop = None
        command = text.split("@", 1)[0]
        if command in {"/start", "/cancel"}:
            self.add_until = 0
            self.pending_shop = None
            self.send("Выбери действие в меню.")
        elif text == ADD:
            self.pending_shop = None
            self.add_until = time.monotonic() + 300
            self.send("Пришли токен WB в течение 5 минут. Бот удалит сообщение перед проверкой. /cancel — отмена.")
        elif text in {STATS, ASSEMBLY, PING}:
            self.add_until = 0
            self.pending_shop = None
            self.send(self.ping() if text == PING else self.report(text))
        elif text and self.pending_shop:
            if len(text) > 100 or "\n" in text:
                self.send("Введи название одной строкой, до 100 символов.")
                return
            shop_id, manual_id, encrypted = self.pending_shop
            self.save_shop(shop_id, manual_id, text, encrypted)
            self.pending_shop = None
            self.add_until = 0
            self.send(f"Магазин сохранён · {text}. Доступ проверится при запросе заказов.")
        elif text and time.monotonic() < self.add_until:
            try:
                self.telegram("deleteMessage", chat_id=self.owner, message_id=message["message_id"])
            except ApiError:
                self.send("Telegram не удалил сообщение. Удали его вручную и повтори ввод.")
                return
            self.send(self.add_shop(text))
        elif text:
            self.send("Выбери действие в меню.")

    def run(self):
        offset = 0
        while True:
            try:
                updates = self.telegram("getUpdates", offset=offset, timeout=25, allowed_updates=["message"])
                for update in updates:
                    offset = update["update_id"] + 1
                    try:
                        self.handle(update["message"])
                    except ApiError as error:
                        self.send(str(error))
                    except (KeyError, TypeError, ValueError, sqlite3.Error):
                        self.send("Не удалось обработать запрос. Проверь настройки и повтори.")
            except ApiError as error:
                print(error, flush=True)
                time.sleep(3)


def main():
    try:
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        owner = int(os.environ["TELEGRAM_OWNER_ID"])
        cipher = Fernet(os.environ["WB_BOT_KEY"].encode())
    except (KeyError, ValueError):
        raise SystemExit("Проверь TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID и WB_BOT_KEY.") from None
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token) or owner <= 0:
        raise SystemExit("Проверь формат TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_ID.")
    db_path = Path(__file__).with_name("wb_bot.sqlite3")
    with sqlite3.connect(db_path) as db:
        Bot(token, owner, cipher, db).run()


if __name__ == "__main__":
    main()
