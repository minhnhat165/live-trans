#!/usr/bin/env python3
"""Generate the live-trans app icon: white headphones on a teal squircle.

Matches the in-app logo (accent gradient #14b8a6 -> #0e8f80, headphones glyph).
Rendered at 4x supersample then downscaled for smooth antialiasing.
"""
from PIL import Image, ImageDraw

OUT = "build/icon-1024.png"
SIZE = 1024
SS = 4                      # supersample factor
S = SIZE * SS

TOP = (0x14, 0xb8, 0xa6)    # --color-accent
BOT = (0x0e, 0x8f, 0x80)    # gradient end
WHITE = (255, 255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diagonal_gradient(size, c0, c1):
    """Top-left -> bottom-right linear gradient (matches `bg-linear-to-br`)."""
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(c0, c1, t)
    return grad


def main():
    # --- squircle background ---
    bg = diagonal_gradient(S, TOP, BOT).convert("RGBA")
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    radius = round(0.2237 * S)   # Apple-style continuous corner radius
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    # --- headphones glyph (white), centered ---
    d = ImageDraw.Draw(icon)
    cx, cy = S / 2, S / 2
    R = S * 0.27                 # band radius
    T = R * 0.20                 # band stroke thickness
    # Band: upper semicircle from left (180) over the top to right (360).
    d.arc([cx - R, cy - R, cx + R, cy + R], 180, 360, fill=WHITE, width=round(T))

    # Ear cups: vertical capsules hugging the inside of each band end.
    cup_w = R * 0.42
    cup_h = R * 0.78
    top_y = cy - T * 0.5
    for sign in (-1, 1):
        end_x = cx + sign * R
        outer = end_x + sign * (T * 0.5)
        inner = outer - sign * cup_w
        x0, x1 = sorted((inner, outer))
        d.rounded_rectangle(
            [x0, top_y, x1, top_y + cup_h],
            radius=cup_w / 2,
            fill=WHITE,
        )

    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)
    icon.save(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
