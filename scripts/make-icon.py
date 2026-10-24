#!/usr/bin/env python3
"""Генерирует src/assets/icon.png (256x256): синий круг с белым колесом из 8 секторов.
Только стандартная библиотека. Запуск: python3 scripts/make-icon.py
"""
import math
import os
import struct
import zlib

SIZE = 256
SECTORS = 8
GAP_DEG = 7.0
R_OUT, R_IN = 112.0, 56.0
SS = 3  # суперсэмплинг для сглаживания


def inside(x, y):
    dx, dy = x - SIZE / 2, y - SIZE / 2
    r = math.hypot(dx, dy)
    if R_IN <= r <= R_OUT:
        a = math.degrees(math.atan2(dx, -dy)) % 360
        w = 360 / SECTORS
        off = (a + w / 2) % w
        return GAP_DEG / 2 <= off <= w - GAP_DEG / 2
    return False


def pixel(px, py):
    # цвет считаем усреднением по SSxSS подточкам
    acc = [0.0, 0.0, 0.0, 0.0]
    for sy in range(SS):
        for sx in range(SS):
            x = px + (sx + 0.5) / SS
            y = py + (sy + 0.5) / SS
            dx, dy = x - SIZE / 2, y - SIZE / 2
            r = math.hypot(dx, dy)
            if r > SIZE / 2 - 2:
                c = (0, 0, 0, 0)
            elif inside(x, y):
                c = (255, 255, 255, 255)
            else:
                t = (y / SIZE)
                c = (int(47 + 40 * (1 - t)), int(128 + 60 * (1 - t)), 255, 255)
            for i in range(4):
                acc[i] += c[i]
    n = SS * SS
    return tuple(int(v / n) for v in acc)


def png(rows):
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + bytes(v for p in row for v in p) for row in rows)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


if __name__ == '__main__':
    rows = [[pixel(x, y) for x in range(SIZE)] for y in range(SIZE)]
    out = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'icon.png')
    with open(out, 'wb') as f:
        f.write(png(rows))
    print('written', os.path.normpath(out))
