from io import BytesIO
from math import ceil

from PIL import Image, ImageDraw, ImageFont


BACKGROUND = "#18181e"
FOREGROUND = "#fafafc"
MUTED = "#b9b8c6"
GRID = "#383844"
COLORS = ("#60a5fa", "#ffaa62", "#71d6a0", "#f58cc3", "#ab91ff")
WIDTH = 1080


def font(size, bold=False):
    for name in (
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/seguisb.ttf" if bold else "C:/Windows/Fonts/SegUIVar.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    raise RuntimeError("Установи пакет fonts-dejavu-core для графика статистики.")


def number(value):
    return "—" if value is None else f"{value:,}".replace(",", " ")


def render_stats(page, reports, now, *, partial=False):
    height = 273 + len(page) * 202
    image = Image.new("RGB", (WIDTH, height), BACKGROUND)
    draw = ImageDraw.Draw(image)
    large, heading, regular, small = font(53, True), font(32, True), font(27), font(22)
    draw.text((48, 35), "Заказы Wildberries", font=large, fill=FOREGROUND)
    draw.text((50, 108), f"01.{now.month:02d}–{now:%d.%m} · FBS · МСК", font=regular, fill=MUTED)
    draw.text((50, 150), "Заказы по дням · отдельная шкала для каждого магазина", font=regular, fill=MUTED)
    left, right = 108, 1019
    ticks = sorted({1, now.day} | {day for day in (5, 10, 15, 20, 25) if day < now.day - 1})

    def day_x(day):
        return left + (day - 1) * (right - left) / max(1, now.day - 1)

    for index, (name, values, sold, delivery) in enumerate(page):
        top = 208 + index * 202
        upper, bottom = top + 59, top + 154
        color = COLORS[index % len(COLORS)]
        line = f"Всего {number(sum(values))}   Выкуплено {number(sold)}   В доставке {number(delivery)}"
        name_width = min(340, 950 - draw.textlength(line, font=small))
        name = " ".join(name.split())
        while len(name) > 1 and draw.textlength(name, font=heading) > name_width:
            name = name[:-2].rstrip("…") + "…"
        draw.text((50, top), name, font=heading, fill=color)
        draw.text((1030, top + 5), line, font=small, fill=FOREGROUND, anchor="ra")

        peak = max(values)
        step = 10 ** max(0, len(str(peak)) - 1)
        ceiling = max(1, ceil(peak / step) * step)
        for value, y in ((ceiling, upper), (0, bottom)):
            draw.line((left, y, right, y), fill=GRID, width=1)
            draw.text((left - 12, y), number(value), font=small, fill=MUTED, anchor="rm")
        for day in ticks:
            x = day_x(day)
            draw.line((x, upper, x, bottom), fill=GRID, width=1)
            if index == len(page) - 1:
                draw.text((x, bottom + 7), str(day), font=small, fill=MUTED, anchor="ma")

        points = [(day_x(day), bottom - value / ceiling * (bottom - upper))
                  for day, value in enumerate(values, 1)]
        if len(points) > 1:
            mask = Image.new("L", (WIDTH, bottom - upper + 1))
            ImageDraw.Draw(mask).polygon(
                [(x, y - upper) for x, y in points] + [(right, bottom - upper), (left, bottom - upper)],
                fill=255,
            )
            opacity = Image.linear_gradient("L").resize((WIDTH, mask.height)).point(
                lambda value: round(95 - value * 0.30)
            )
            alpha = Image.new("L", mask.size)
            alpha.paste(opacity, mask=mask)
            image.paste(color, (0, upper, WIDTH, bottom + 1), alpha)
            draw.line(points, fill=color, width=4, joint="curve")
        else:
            x, y = points[0]
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color)

    totals = sum(sum(row[1]) for row in reports)
    statuses = [None if any(row[column] is None for row in reports) else sum(row[column] for row in reports)
                for column in (2, 3)]
    label = "Итого по доступным" if partial else "Итого"
    draw.text((50, height - 55), label, font=heading, fill=FOREGROUND)
    summary = f"Всего {number(totals)}   Выкуплено {number(statuses[0])}   В доставке {number(statuses[1])}"
    summary_width = 950 - draw.textlength(label, font=heading)
    summary_font = regular if draw.textlength(summary, font=regular) <= summary_width else small
    draw.text((1030, height - 49), summary, font=summary_font, fill=FOREGROUND, anchor="ra")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
