import asyncio
import json
import os
import re
import sqlite3
import time
from collections import Counter
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
from html import escape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4
from xml.etree import ElementTree

from cryptography.fernet import Fernet, InvalidToken
from stats_image import render_stats


MSK = timezone(timedelta(hours=3))
MARKET = "https://marketplace-api.wildberries.ru"
CONTENT = "https://content-api.wildberries.ru"
COMMON = "https://common-api.wildberries.ru"
DEFAULT_MOSCOW_URL = "https://vk.ru/"
SALES = "https://statistics-api.wildberries.ru/api/v1/supplier/sales"
ACCESS_COMMANDS = {"/invite", "/allow", "/revoke"}
ADD, STATS, ASSEMBLY, PING = "Добавить магазин", "Статистика", "Список сборки", "Пинг"
MANAGE_USERS = "Управление пользователями"
INVITE_USER = "Пригласить пользователя"
REMOVE_USER = "Удалить пользователя"
BACK = "Назад"
USER_ACTIONS = {INVITE_USER: "/invite", REMOVE_USER: "/revoke"}
MENU = {"keyboard": [[STATS, ASSEMBLY], [ADD, PING], [MANAGE_USERS]], "resize_keyboard": True}
ACCESS_MENU = {"keyboard": [[INVITE_USER, REMOVE_USER], [BACK]], "resize_keyboard": True}
USER_MENU = {"keyboard": [[STATS, ASSEMBLY], [PING]], "resize_keyboard": True}
STATS_BUTTONS = {"inline_keyboard": [[
    {"text": "Количество", "callback_data": "stats:quantity"},
    {"text": "Сумма", "callback_data": "stats:amount"},
]]}
COMMAND_STARTED = ContextVar("command_started", default=None)
REPLY_CHAT = ContextVar("reply_chat", default=None)
CATALOG_CACHE_SECONDS = 3600


class ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = build_opener(NoRedirects())


def telegram_error(method, status, result):
    description = result.get("description", "") if isinstance(result, dict) else ""
    if not isinstance(description, str):
        description = ""
    description = re.sub(r"\b\d{5,}:[\w-]{10,}\b", "[токен скрыт]", description)
    description = " ".join(description.split())[:240]
    detail = f" · {description}" if description else ""
    return ApiError(f"Telegram ({method}) — HTTP {status}{detail}", status=status)


def blocking_request(url, service, *, token=None, body=None, photo=None, upload_field="photo",
                     timeout=15, read_json=True, raw=False):
    headers = {"Authorization": token} if token else {}
    data = None
    if photo is not None:
        boundary = uuid4().hex
        fields = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
            f'{json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list, bool)) else value}\r\n'.encode()
            for name, value in body.items()
        )
        data = (
            fields + f'--{boundary}\r\nContent-Disposition: form-data; name="{upload_field}"; '
            'filename="orders.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
            + photo + f'\r\n--{boundary}--\r\n'.encode()
        )
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        with OPENER.open(Request(url, data=data, headers=headers), timeout=timeout) as response:
            if raw:
                return response.read()
            return json.load(response) if read_json else response.status
    except HTTPError as error:
        try:
            result = json.loads(error.read(8192))
        except (ValueError, OSError):
            result = None
        finally:
            error.close()
        if service == "Telegram":
            raise telegram_error(url.rsplit("/", 1)[-1], error.code, result) from None
        details = []
        if isinstance(result, dict):
            for key in ("title", "detail", "message", "errorText", "requestId"):
                value = result.get(key)
                if isinstance(value, str):
                    safe = value.replace(token, "[токен скрыт]") if token else value
                    details.append(" ".join(safe.split())[:180])
        suffix = " · " + " · ".join(dict.fromkeys(details)) if details else ""
        raise ApiError(f"{service} — HTTP {error.code}{suffix}", status=error.code) from None
    except (URLError, TimeoutError, OSError, ValueError) as error:
        reason = error.reason if isinstance(error, URLError) else error
        raise ApiError(f"{service} — ошибка соединения или ответа ({type(reason).__name__})") from None


async def request(*args, **kwargs):
    return await asyncio.to_thread(blocking_request, *args, **kwargs)


async def month_counts(token, now):
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
            page = await request(f"{MARKET}/api/v3/orders?{query}", "WB заказы", token=token)
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
            await asyncio.sleep(0.25)
    return counts, sorted(seen)


async def order_statuses(token, order_ids):
    for start in range(0, len(order_ids), 1000):
        if start:
            await asyncio.sleep(0.25)
        batch = order_ids[start:start + 1000]
        result = await request(f"{MARKET}/api/v3/orders/status", "WB статусы", token=token, body={"orders": batch})
        statuses = {order["id"]: order for order in result["orders"]}
        if statuses.keys() != set(batch):
            raise ApiError("WB вернул неполный список статусов")
        for order in statuses.values():
            yield order


async def status_counts(token, order_ids):
    sold = delivery = 0
    async for order in order_statuses(token, order_ids):
        wb = order["wbStatus"]
        supplier = order["supplierStatus"]
        sold += wb == "sold"
        delivery += (
            wb in {"sorted", "postponed_delivery", "accepted_by_carrier",
                   "sent_to_carrier", "delivering_by_carrier"}
            or (supplier == "complete" and wb == "waiting")
        )
    return sold, delivery


async def assembly_count(token, new_ids):
    cursor = 0
    cursors = {cursor}
    assembly_ids = set()
    while True:
        page = await request(f"{MARKET}/api/v3/supplies?limit=1000&next={cursor}", "WB поставки", token=token)
        if not page["supplies"]:
            break
        for supply in page["supplies"]:
            if not supply["done"]:
                supply_id = quote(supply["id"], safe="")
                await asyncio.sleep(0.22)
                result = await request(f"{MARKET}/api/marketplace/v3/supplies/{supply_id}/order-ids",
                                 "WB заказы поставки", token=token)
                assembly_ids.update(result["orderIds"])
        cursor = page["next"]
        if cursor in cursors:
            raise ApiError("WB повторил страницу поставок")
        cursors.add(cursor)
        await asyncio.sleep(0.22)
    count = 0
    async for order in order_statuses(token, sorted(assembly_ids - new_ids)):
        count += order["supplierStatus"] == "confirm"
    return count


async def cny_rate(today):
    query = urlencode({"date_req": today.strftime("%d/%m/%Y")})
    xml = await request(f"https://www.cbr.ru/scripts/XML_daily.asp?{query}", "ЦБ РФ", raw=True)
    try:
        node = ElementTree.fromstring(xml).find("./Valute[CharCode='CNY']")
        if node is not None:
            value = Decimal(node.findtext("Value", "").replace(",", "."))
            nominal = Decimal(node.findtext("Nominal", ""))
            if value.is_finite() and nominal.is_finite() and value > 0 and nominal > 0:
                return value / nominal
    except (ElementTree.ParseError, ArithmeticError):
        pass
    raise ApiError("ЦБ РФ не вернул курс юаня")


def purchase_amounts(sales, now, rate):
    if not isinstance(sales, list) or len(sales) >= 80000:
        raise ApiError("WB не вернул полный отчёт продаж")
    month = [Decimal(0) for _ in range(now.day)]
    seen = set()
    for row in sales:
        sale_id = row["saleID"]
        if not sale_id.startswith("S") or sale_id in seen:
            continue
        sale_date = datetime.fromisoformat(row["date"])
        sale_date = sale_date.astimezone(MSK) if sale_date.tzinfo else sale_date.replace(tzinfo=MSK)
        if sale_date.date().replace(day=1) != now.date().replace(day=1) or sale_date > now:
            continue
        value = Decimal(str(row["finishedPrice"]))
        if not value.is_finite() or value < 0:
            raise ValueError("Некорректная сумма продажи")
        month[sale_date.day - 1] += value
        seen.add(sale_id)
    return [int((value * 100 / rate).quantize(Decimal(1), rounding=ROUND_HALF_UP)) for value in month]


async def card_titles(token, wanted, db, cache_key):
    if not wanted:
        return {}
    now = time.time()
    with db:
        db.execute("DELETE FROM catalog_cache WHERE updated_at <= ?", (now - CATALOG_CACHE_SECONDS,))
    cached = db.execute(
        "SELECT updated_at, cursor, titles FROM catalog_cache WHERE cache_key = ?", (cache_key,)
    ).fetchone()
    if cached:
        started, raw_cursor, raw_titles = cached
        cursor = json.loads(raw_cursor)
        titles = json.loads(raw_titles)
    else:
        started, cursor, titles = now, {"limit": 100}, {}
    wanted = {str(card_id) for card_id in wanted}
    while cursor is not None and wanted - titles.keys():
        body = {"settings": {"cursor": cursor, "filter": {"withPhoto": -1}}}
        page = await request(f"{CONTENT}/content/v2/get/cards/list", "WB каталог", token=token, body=body)
        titles.update({
            str(card["nmID"]): card["title"] for card in page["cards"] if card.get("title")
        })
        position = page["cursor"]
        next_cursor = None
        if position["total"] >= 100:
            next_cursor = {"limit": 100, "updatedAt": position["updatedAt"], "nmID": position["nmID"]}
        if next_cursor == cursor:
            raise ApiError("WB повторил страницу каталога")
        cursor = next_cursor
        with db:
            db.execute(
                "INSERT INTO catalog_cache VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET "
                "updated_at=excluded.updated_at, cursor=excluded.cursor, titles=excluded.titles",
                (cache_key, started, json.dumps(cursor), json.dumps(titles, ensure_ascii=False)),
            )
        if cursor is not None and wanted - titles.keys():
            await asyncio.sleep(0.65)
    return {card_id: titles[card_id] for card_id in wanted & titles.keys()}


def clean_title(title):
    title = re.sub(r"\b(?:восстановленный|iphone)\b", "", title, flags=re.IGNORECASE)
    return " ".join(title.split()).strip(" -,–—")


def sort_key(title):
    return [int(part) if part.isdigit() else part for part in re.split(r"([0-9]+)", title.casefold())]


def processing_time():
    started = COMMAND_STARTED.get()
    if started is None:
        return ""
    elapsed = time.perf_counter() - started
    duration = f"{elapsed * 1000:.0f} мс" if elapsed < 1 else f"{elapsed:.2f} с"
    return f"Обработка · {duration}"


class Bot:
    def __init__(self, token, owner, cipher, db):
        self.url = f"https://api.telegram.org/bot{token}"
        self.owner = owner
        self.cipher = cipher
        self.db = db
        self.add_until = 0
        self.pending_shop = None
        self.access_action = None
        self.sales_cache = {}
        self.report_task = None
        self.ping_task = None
        db.execute("CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT, token BLOB)")
        db.execute(
            "CREATE TABLE IF NOT EXISTS catalog_cache ("
            "cache_key TEXT PRIMARY KEY, updated_at REAL NOT NULL, cursor TEXT NOT NULL, titles TEXT NOT NULL)"
        )
        db.execute("CREATE TABLE IF NOT EXISTS telegram_users (id INTEGER PRIMARY KEY, username TEXT)")
        db.execute("CREATE TABLE IF NOT EXISTS telegram_access (id INTEGER PRIMARY KEY)")
        db.execute("CREATE TABLE IF NOT EXISTS telegram_invites (id INTEGER PRIMARY KEY)")

    @property
    def reply_chat(self):
        return REPLY_CHAT.get() or self.owner

    def has_access(self, user_id):
        return user_id == self.owner or self.db.execute(
            "SELECT 1 FROM telegram_access WHERE id = ?", (user_id,)
        ).fetchone() is not None

    async def show_access_menu(self):
        rows = self.db.execute(
            "SELECT member.id, telegram_users.username, member.status FROM ("
            "SELECT id, 'доступ открыт' AS status FROM telegram_access "
            "UNION ALL SELECT id, 'ожидает /start' FROM telegram_invites"
            ") AS member LEFT JOIN telegram_users ON telegram_users.id = member.id "
            "ORDER BY member.id"
        )
        lines = ["Управление пользователями"]
        for user_id, username, status in rows:
            tag = f" · @{username}" if username else ""
            lines.append(f"{user_id}{tag} · {status}")
        if len(lines) == 1:
            lines.append("Список пока пуст.")
        await self.send("\n".join(lines), reply_markup=ACCESS_MENU)

    async def change_access(self, command, target):
        if re.fullmatch(r"[1-9][0-9]{0,15}", target):
            user_id = int(target)
        elif re.fullmatch(r"@[A-Za-z0-9_]{1,32}", target):
            username = target[1:].lower()
            row = self.db.execute("SELECT id FROM telegram_users WHERE username = ?", (username,)).fetchone()
            if not row:
                return "Попроси пользователя отправить боту /start, затем повтори команду."
            user_id = row[0]
            chat = await self.telegram("getChat", chat_id=user_id)
            if (chat.get("username") or "").lower() != username:
                return "Тег пользователя изменился. Укажи актуальный @username или числовой ID."
        else:
            return f"Укажи пользователя так: {command} @username или {command} 123456789."
        if user_id == self.owner:
            return "Доступ владельца задаётся через TELEGRAM_OWNER_ID."
        with self.db:
            if command != "/revoke":
                if self.has_access(user_id):
                    return f"Доступ уже открыт · Telegram ID {user_id}"
                self.db.execute("INSERT OR IGNORE INTO telegram_invites VALUES (?)", (user_id,))
                return f"Приглашение создано · Telegram ID {user_id}. Попроси пользователя отправить боту /start."
            self.db.execute("DELETE FROM telegram_invites WHERE id = ?", (user_id,))
            self.db.execute("DELETE FROM telegram_access WHERE id = ?", (user_id,))
            return f"Доступ и приглашение отозваны · Telegram ID {user_id}"

    async def telegram(self, method, *, photo=None, **body):
        timing_field = {"sendMessage": "text", "sendPhoto": "caption", "sendDocument": "caption"}.get(method)
        timing = processing_time()
        if timing_field and timing:
            text = body.get(timing_field, "").rstrip()
            body[timing_field] = f"{text}\n\n{timing}".lstrip()
        upload_field = {"sendDocument": "document", "sendRichMessage": "chart"}.get(method, "photo")
        result = await request(f"{self.url}/{method}", "Telegram", body=body, photo=photo,
                               upload_field=upload_field, timeout=40)
        if not result.get("ok"):
            raise telegram_error(method, result.get("error_code", 200), result)
        return result["result"]

    async def send(self, text, *, code_lines=(), reply_markup=None):
        formatting = {"parse_mode": "HTML"} if code_lines else {}
        menu = MENU if self.reply_chat == self.owner else USER_MENU
        chunk = ""
        for line in text.splitlines():
            is_code = line in code_lines
            line = line[:1700]
            if len(chunk) + len(line) + 1 > 1800:
                await self.telegram("sendMessage", chat_id=self.reply_chat, text=chunk,
                                    reply_markup=reply_markup or menu, **formatting)
                chunk = ""
            if code_lines:
                line = escape(line, quote=False)
                if is_code:
                    line = f"<code>{line}</code>"
            chunk += line + "\n"
        if chunk:
            await self.telegram("sendMessage", chat_id=self.reply_chat, text=chunk,
                                reply_markup=reply_markup or menu, **formatting)

    async def send_chart(self, photo, caption):
        heading = "".join(f"<p>{escape(line)}</p>" for line in caption.splitlines())
        rich_message = {
            "html": f'{heading}<img src="tg://photo?id=chart"/><p>{escape(processing_time())}</p>',
            "media": [{"id": "chart", "media": {"type": "photo", "media": "attach://chart"}}],
        }
        try:
            await self.telegram("sendRichMessage", chat_id=self.reply_chat, photo=photo, rich_message=rich_message)
            return
        except ApiError as error:
            if error.status not in {400, 404}:
                raise
            print(error, flush=True)
        try:
            await self.telegram("sendPhoto", chat_id=self.reply_chat, photo=photo, caption=caption)
        except ApiError as error:
            if error.status != 400:
                raise
            print(error, flush=True)
            await self.telegram("sendDocument", chat_id=self.reply_chat, photo=photo, caption=caption)

    async def add_shop(self, token):
        manual_id = "manual:" + sha256(token.encode()).hexdigest()
        shop_id = manual_id
        try:
            seller = await request(f"{COMMON}/api/v1/seller-info", "WB продавец", token=token)
            shop_id = str(seller["sid"])
            name = seller.get("tradeMark") or seller["name"]
            await request(f"{MARKET}/api/v3/orders/new", "WB Маркетплейс", token=token)
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

    async def report(self, action):
        shops = self.db.execute("SELECT name, token FROM shops ORDER BY name").fetchall()
        if not shops:
            if self.reply_chat == self.owner:
                return "Сначала нажми «Добавить магазин»."
            return "Владелец пока не подключил магазины."
        now = datetime.now(MSK)
        reports = []
        errors = []
        items = Counter()
        currency = os.environ.get("WB_SALES_CURRENCY", "RUB").strip().upper()
        if action == "stats:amount" and currency not in {"RUB", "CNY"}:
            raise ApiError("WB_SALES_CURRENCY должен быть RUB или CNY.")
        rate = (await cny_rate(now) if currency == "RUB" else Decimal(1)) if action == "stats:amount" else None
        async def load_shop(name, encrypted):
            try:
                token = self.cipher.decrypt(encrypted).decode()
                if action == STATS:
                    orders = (await request(f"{MARKET}/api/v3/orders/new", "WB новые заказы", token=token))["orders"]
                    new_ids = {order["id"] for order in orders}
                    try:
                        assembly = await assembly_count(token, new_ids)
                    except (ApiError, KeyError, TypeError, ValueError) as error:
                        assembly = None
                        detail = str(error) if isinstance(error, ApiError) else "ответ WB изменился"
                        errors.append(f"{name} · сборка недоступна ({detail})")
                    reports.append((name, len(new_ids), assembly))
                elif action == "stats:quantity":
                    days, order_ids = await month_counts(token, now)
                    try:
                        sold, delivery = await status_counts(token, order_ids)
                    except (ApiError, KeyError, TypeError, ValueError) as error:
                        sold = delivery = None
                        detail = str(error) if isinstance(error, ApiError) else "ответ WB изменился"
                        errors.append(f"{name} · статусы недоступны ({detail})")
                    reports.append((name, [days[day] for day in range(1, now.day + 1)], sold, delivery))
                elif action == "stats:amount":
                    key = (encrypted, now.date())
                    cached = self.sales_cache.get(key)
                    if cached and time.monotonic() - cached[0] < 120:
                        sales = cached[1]
                    else:
                        query = urlencode({"dateFrom": now.date().replace(day=1).isoformat()})
                        sales = await request(f"{SALES}?{query}", "WB продажи", token=token)
                        self.sales_cache = {k: v for k, v in self.sales_cache.items()
                                            if time.monotonic() - v[0] < 120 and k[1] == now.date()}
                        self.sales_cache[key] = (time.monotonic(), sales)
                    reports.append((name, purchase_amounts(sales, now, rate), None, None))
                else:
                    orders = (await request(f"{MARKET}/api/v3/orders/new", "WB заказы", token=token))["orders"]
                    try:
                        titles = await card_titles(
                            token, {order["nmId"] for order in orders}, self.db, sha256(encrypted).hexdigest()
                        )
                    except (ApiError, KeyError, TypeError, ValueError) as error:
                        titles = {}
                        detail = str(error) if isinstance(error, ApiError) else "ответ WB изменился"
                        errors.append(f"{name} · названия недоступны ({detail}), показаны артикулы")
                    for order in orders:
                        article = order.get("article") or str(order["nmId"])
                        title = clean_title(titles.get(str(order["nmId"]), article)) or article
                        items[title] += 1
            except InvalidToken:
                errors.append(f"{name} · не удалось расшифровать токен")
            except ApiError as error:
                errors.append(f"{name} · {error}")
            except (KeyError, TypeError, ValueError, ArithmeticError):
                errors.append(f"{name} · неожиданный ответ WB")
        limit = asyncio.Semaphore(5)

        async def load_with_limit(name, encrypted):
            async with limit:
                await load_shop(name, encrypted)

        await asyncio.gather(*(load_with_limit(name, encrypted) for name, encrypted in shops))
        if not self.has_access(self.reply_chat):
            return ""
        reports.sort(key=lambda row: row[0])
        errors.sort()
        code_lines = ()
        if action == STATS:
            new_total = sum(row[1] for row in reports)
            assembly_total = sum(row[2] for row in reports if row[2] is not None)
            new_text = (str(new_total) if len(reports) == len(shops)
                        else f"{new_total} по доступным" if reports else "—")
            assembly_text = (str(assembly_total) if len(reports) == len(shops) and
                             all(row[2] is not None for row in reports) else
                             f"{assembly_total} по доступным" if any(row[2] is not None for row in reports) else "—")
            lines = [f"Новые · {new_text}", f"На сборке · {assembly_text}", ""]
            lines.extend(f"{name} · новые {new} / сборка {assembly if assembly is not None else '—'}"
                         for name, new, assembly in reports)
        elif action.startswith("stats:"):
            if reports:
                for start in range(0, len(reports), 8):
                    page = reports[start:start + 8]
                    amount = action == "stats:amount"
                    photo = await asyncio.to_thread(render_stats, page, reports, now, partial=len(reports) != len(shops), amount=amount)
                    period = f"01.{now.month:02d}–{now:%d.%m} · МСК"
                    caption = f"Заказы FBS · {period}"
                    if amount:
                        caption = f"Выкупы · {period} · предварительно по отчёту WB"
                        if currency == "RUB":
                            caption += f"\nОценка по курсу ЦБ РФ на {now:%d.%m} · 1 CNY = {rate} ₽"
                    if not self.has_access(self.reply_chat):
                        return ""
                    await self.send_chart(photo, caption)
            if not errors:
                return ""
            lines = []
        else:
            lines = [f"Новые заказы на сборку · {sum(items.values())} по доступным магазинам"]
            code_lines = {f"{title} × {items[title]}" for title in items}
            lines.extend(f"{title} × {items[title]}" for title in sorted(items, key=sort_key))
        await self.send("\n".join(lines + (["", "Ошибки и ограничения"] + errors if errors else [])),
                  code_lines=code_lines, reply_markup=STATS_BUTTONS if action == STATS else None)
        return ""

    async def ping(self):
        row = self.db.execute("SELECT token FROM shops ORDER BY id LIMIT 1").fetchone()
        wb_token = None
        if row:
            try:
                wb_token = self.cipher.decrypt(row[0]).decode()
            except InvalidToken:
                pass
        moscow_url = os.environ.get("MOSCOW_PING_URL") or DEFAULT_MOSCOW_URL
        moscow_name = "Москва (vk.ru)" if moscow_url == DEFAULT_MOSCOW_URL else "Москва"

        async def measure(name, url, token=None):
            started = time.perf_counter()
            try:
                code = await request(url, name, token=token, read_json=False, timeout=5)
                status = f"HTTP {code}"
            except ApiError as error:
                status = str(error).removeprefix(f"{name} — ")
            elapsed = (time.perf_counter() - started) * 1000
            return f"{name} · {elapsed:.0f} мс · {status}"

        lines = await asyncio.gather(
            measure("WB", f"{MARKET}/ping", wb_token),
            measure(moscow_name, moscow_url),
        )
        return "\n".join(lines)

    async def run_job(self, action):
        try:
            result = await self.ping() if action == PING else await self.report(action)
            if self.has_access(self.reply_chat):
                await self.send(result)
        except (ApiError, KeyError, TypeError, ValueError, sqlite3.Error, RuntimeError) as error:
            if not self.has_access(self.reply_chat):
                return
            try:
                await self.send(str(error) if isinstance(error, ApiError)
                                else "Не удалось обработать запрос. Проверь настройки и повтори.")
            except ApiError as send_error:
                print(send_error, flush=True)

    async def start_report(self, action):
        if self.report_task and not self.report_task.done():
            await self.send("Предыдущий отчёт ещё формируется.")
            return
        self.report_task = asyncio.create_task(self.run_job(action))

    async def handle(self, message):
        sender = message.get("from", {})
        user_id = sender.get("id")
        if message["chat"]["type"] != "private" or not user_id:
            return
        text = message.get("text", "").strip()
        parts = text.split(maxsplit=1)
        command = parts[0].split("@", 1)[0] if parts else ""
        is_owner = user_id == self.owner
        if command == "/start":
            username = (sender.get("username") or "").lower() or None
            with self.db:
                if username:
                    self.db.execute("UPDATE telegram_users SET username = NULL WHERE username = ? AND id != ?",
                                    (username, user_id))
                self.db.execute("INSERT INTO telegram_users VALUES (?, ?) ON CONFLICT(id) DO UPDATE "
                                "SET username=excluded.username", (user_id, username))
                accepted = self.db.execute("DELETE FROM telegram_invites WHERE id = ?", (user_id,)).rowcount
                if accepted:
                    self.db.execute("INSERT OR IGNORE INTO telegram_access VALUES (?)", (user_id,))
            if accepted:
                await self.send("Приглашение принято. Теперь доступны общие магазины.")
                return
        if not self.has_access(user_id):
            if command == "/start":
                await self.send(f"Доступ по приглашению. Передай владельцу бота свой Telegram ID: {user_id}.",
                                reply_markup={"remove_keyboard": True})
            return
        if not is_owner:
            if command in ACCESS_COMMANDS or text in {ADD, MANAGE_USERS, *USER_ACTIONS}:
                await self.send("Управлять доступом и магазинами может владелец.")
                return
            if text in {STATS, ASSEMBLY, PING}:
                await self.run_menu_action(text)
            elif text:
                await self.send("Выбери действие в меню.")
            return
        if command in ACCESS_COMMANDS:
            await self.send(await self.change_access(command, parts[1] if len(parts) > 1 else ""))
            return
        if text == MANAGE_USERS or text in USER_ACTIONS:
            self.add_until = 0
            self.pending_shop = None
            self.access_action = USER_ACTIONS.get(text)
            if self.access_action:
                await self.send("Пришли числовой Telegram ID или @username. «Назад» — выход.",
                                reply_markup=ACCESS_MENU)
            else:
                await self.show_access_menu()
            return
        if command in {"/start", "/cancel"} or text in {BACK, ADD, STATS, ASSEMBLY, PING}:
            self.access_action = None
        if self.access_action and text:
            await self.send(await self.change_access(self.access_action, text), reply_markup=ACCESS_MENU)
            return
        if time.monotonic() >= self.add_until:
            self.pending_shop = None
        if command in {"/start", "/cancel"} or text == BACK:
            self.add_until = 0
            self.pending_shop = None
            await self.send("Выбери действие в меню.")
        elif text == ADD:
            self.pending_shop = None
            self.add_until = time.monotonic() + 300
            await self.send("Пришли токен WB в течение 5 минут. Бот удалит сообщение перед проверкой. /cancel — отмена.")
        elif text in {STATS, ASSEMBLY, PING}:
            self.add_until = 0
            self.pending_shop = None
            await self.run_menu_action(text)
        elif text and self.pending_shop:
            if len(text) > 100 or "\n" in text:
                await self.send("Введи название одной строкой, до 100 символов.")
                return
            shop_id, manual_id, encrypted = self.pending_shop
            self.save_shop(shop_id, manual_id, text, encrypted)
            self.pending_shop = None
            self.add_until = 0
            await self.send(f"Магазин сохранён · {text}. Доступ проверится при запросе заказов.")
        elif text and time.monotonic() < self.add_until:
            try:
                await self.telegram("deleteMessage", chat_id=self.owner, message_id=message["message_id"])
            except ApiError:
                await self.send("Telegram не удалил сообщение. Удали его вручную и повтори ввод.")
                return
            await self.send(await self.add_shop(text))
        elif text:
            await self.send("Выбери действие в меню.")

    async def run_menu_action(self, action):
        if action == PING:
            await self.send("Понг")
            if self.ping_task and not self.ping_task.done():
                await self.send("Замер уже идёт.")
            else:
                self.ping_task = asyncio.create_task(self.run_job(PING))
        else:
            await self.start_report(action)

    async def run(self):
        offset = 0
        while True:
            try:
                updates = await self.telegram("getUpdates", offset=offset, timeout=25,
                                        allowed_updates=["message", "callback_query"])
                for update in updates:
                    offset = update["update_id"] + 1
                    message = update.get("message") or update.get("callback_query", {}).get("message") or {}
                    chat = message.get("chat", {})
                    if chat.get("type") != "private":
                        continue
                    recipient = REPLY_CHAT.set(chat["id"])
                    timing = COMMAND_STARTED.set(time.perf_counter())
                    try:
                        if "callback_query" in update:
                            callback = update["callback_query"]
                            user_id = callback.get("from", {}).get("id")
                            if user_id == chat["id"] and self.has_access(user_id):
                                try:
                                    await self.telegram("answerCallbackQuery", callback_query_id=callback["id"])
                                except ApiError as error:
                                    if error.status != 400 or "query is too old" not in str(error).lower():
                                        raise
                                    print(error, flush=True)
                                if callback.get("data") in {"stats:quantity", "stats:amount"}:
                                    await self.start_report(callback["data"])
                        elif "message" in update:
                            if message.get("from", {}).get("id") == chat["id"]:
                                await self.handle(message)
                    except ApiError as error:
                        await self.send(str(error))
                    except (KeyError, TypeError, ValueError, sqlite3.Error):
                        await self.send("Не удалось обработать запрос. Проверь настройки и повтори.")
                    finally:
                        COMMAND_STARTED.reset(timing)
                        REPLY_CHAT.reset(recipient)
            except ApiError as error:
                print(error, flush=True)
                await asyncio.sleep(3)


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
        asyncio.run(Bot(token, owner, cipher, db).run())


if __name__ == "__main__":
    main()
