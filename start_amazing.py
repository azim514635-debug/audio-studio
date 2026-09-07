#!/usr/bin/env python3
"""
Azim's Space — Amazing Launch View
Pure Python, no dependencies. Run in any 256-color terminal:

    python3 start_amazing.py

Shows a glowing starfield with a rainbow title, a shooting star and a
shimmering footer, then lets you quit (Ctrl+C or then it ends).
"""
import os
import random
import shutil
import sys
import time

# ----------------------------------------------------------------------
# ANSI helpers (256-color safe)
# ----------------------------------------------------------------------
CLEAR = "\x1b[2J\x1b[H"
HIDE = "\x1b[?25l"
SHOW = "\x1b[?25h"
RESET = "\x1b[0m"

# 16 (0..15) + 216 (16..231) full 6x6x6 cube for rainbow gradients
CUBE_BASE = 16
CUBE_STEPS = 6


def cube(r, g, b):
    """Approximate an r,g,b (0..5 each) to the 256-color cube code."""
    return CUBE_BASE + 36 * r + 6 * g + b


def color(code):
    return f"\x1b[38;5;{code}m"


def rgb(r, g, b):
    """True-color (24-bit) — terminal dependent, great in xterm-256color."""
    return f"\x1b[38;2;{r};{g};{b}m"


def bg(code):
    return f"\x1b[48;5;{code}m"


def move(x, y):
    return f"\x1b[{y};{x}H"


def rainbow_index(i, steps=360):
    """Cycle a hue into (r,g,b) 0-255 for smooth rainbow."""
    t = (i * (360 / max(steps, 1))) % 360
    c = t % 60
    x = int(255 * (1 - abs((t / 60) % 2 - 1)))
    if t < 60:
        return 255, x, 0
    if t < 120:
        return x, 255, 0
    if t < 180:
        return 0, 255, x
    if t < 240:
        return 0, x, 255
    if t < 300:
        return x, 0, 255
    return 255, 0, x


def size():
    try:
        return shutil.get_terminal_size(fallback=(80, 24))
    except Exception:
        return type("S", (), {"columns": 80, "lines": 24})()


# ----------------------------------------------------------------------
# Scene
# ----------------------------------------------------------------------
class Star:
    def __init__(self, w, h):
        self.reset(w, h)

    def reset(self, w, h):
        self.x = random.randrange(w)
        self.y = random.randrange(h)
        self.s = random.choice([1, 2, 3])
        self.bright = random.randint(150, 255)

    def step(self, w, h):
        self.y += 1  # fall downward (tunnel effect)
        if self.y >= h:
            self.reset(w, h)
        self.x += random.choice([-1, 0, 1])
        self.x = max(0, min(w - 1, self.x))
        if self.s == 3 and random.random() < 0.2:
            self.bright = random.randint(150, 255)


def draw_star(st, buf):
    x, y = st.x, st.y + 1
    glyph = "+" if st.s == 1 else "*" if st.s == 2 else "✦"
    c = color(min(255, st.bright))
    buf.append(f"{move(x + 1, y)}{c}{glyph}{RESET}")


def draw_title(buf, w, cx, top_y, text):
    # center the title on the terminal width
    start_x = max(1, cx - len(text) // 2)
    for idx, ch in enumerate(text):
        if ch == " ":
            continue
        r, g, b = rainbow_index(idx, len(text))
        buf.append(f"{move(start_x + idx, top_y)}{rgb(r, g, b)}{ch}{RESET}")


def draw_footer(buf, w, y, text, phase):
    # shimmer each char with sine brightness
    start_x = max(1, (w - len(text)) // 2)
    for idx, ch in enumerate(text):
        if ch == " ":
            continue
        wave = int(((phase + idx * 6) % 40) * (255 / 39)) if phase % 40 < 20 else int(((40 - phase % 40) + idx * 6) % 40 * (255 / 39))
        r, g, b = rainbow_index(idx * 11 + phase, 60)
        buf.append(f"{move(start_x + idx, y)}{rgb(r, g, b)}{ch}{RESET}")


def draw_shooting_star(buf, w, h, phase, frame):
    if frame % 90 < 12:  # visible for 12 frames
        t = frame % 90
        tail_x = int((w - 10) - (w - 10) * (t / 12))
        tail_y = int(2 + (h - 6) * (t / 12))
        for k in range(6):
            b = rgb(255, 255, 200 - k * 30)
            buf.append(f"{move(max(1, tail_x - k), tail_y)}{b}·{RESET}")
        buf.append(f"{move(tail_x, tail_y)}{rgb(255, 255, 255)}•{RESET}")


def main():
    random.seed()
    cols, lines = size().columns, size().lines
    title = "AZIM'S SPACE"
    tagline = "☄ amazing view — pure python ☄"

    stars = [Star(cols, lines) for _ in range(min(120, cols * lines // 3))]

    sys.stdout.write(CLEAR + HIDE)
    sys.stdout.flush()
    frame = 0
    try:
        while True:
            # optionally re-read terminal size once
            try:
                cols, lines = size().columns, size().lines
            except Exception:
                pass
            buf = []
            # wipe previous field with a subtle solid background each frame
            # (cheap full refresh is fine for small terminals)
            for s in stars:
                s.step(cols, lines)
                draw_star(s, buf)
            top_y = max(1, lines // 2 - 2)
            draw_title(buf, cols, cols // 2, top_y, title)
            draw_footer(buf, cols, top_y + 3, tagline, frame)
            draw_shooting_star(buf, cols, lines, frame % 90, frame)
            sys.stdout.write(CLEAR)
            sys.stdout.write("".join(buf))
            sys.stdout.flush()
            frame += 1
            time.sleep(0.05)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW + RESET + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
