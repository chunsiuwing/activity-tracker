"""Generate PNG app icons for ActionLog from the same design as icon.svg.

Run once:  python icons/make_icons.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

BG_TOP = (11, 17, 32)
BG_BOT = (18, 35, 63)
RING = (34, 211, 238)
LENS_RING = (79, 140, 255)
LENS_CORE = (34, 211, 238)
REC = (248, 113, 113)

WAVE = [
    (78, 300), (148, 300), (188, 176), (244, 420),
    (286, 250), (322, 330), (434, 330),
]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(w, h):
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(BG_TOP, BG_BOT, y / max(1, h - 1)) + (255,))
    return img


def build(size, radius, scale=1.0, inset=0.0, full_bleed=False):
    """radius: corner radius in px. scale/inset: content transform (maskable)."""
    w = h = size
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    bg = gradient(w, h)
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    if full_bleed:
        md.rectangle([0, 0, w - 1, h - 1], fill=255)
    else:
        md.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    canvas.paste(bg, (0, 0), mask)

    # ---- content layer, drawn in the 512 design space then scaled ----
    layer = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # outer ring
    d.rounded_rectangle([8, 8, 504, 504], radius=104, outline=RING + (70,),
                        width=max(3, int(512 * 0.012)))

    # lens
    lw = int(512 * 0.031)
    d.ellipse([368 - 58, 152 - 58, 368 + 58, 152 + 58],
              outline=LENS_RING + (140,), width=lw)
    d.ellipse([368 - 22, 152 - 22, 368 + 22, 152 + 22], fill=LENS_CORE + (220,))

    # rec dot
    d.ellipse([140 - 26, 152 - 26, 140 + 26, 152 + 26], fill=REC + (255,))

    # waveform — segmented gradient strokes
    stroke = int(512 * 0.066)
    for i in range(len(WAVE) - 1):
        t = i / max(1, len(WAVE) - 2)
        col = lerp(LENS_RING, RING, t)
        d.line([WAVE[i], WAVE[i + 1]], fill=col + (255,), width=stroke)
    r = stroke // 2
    for p in WAVE:
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=RING + (255,))

    if scale != 1.0 or inset:
        s = 512 * scale
        layer = layer.resize((int(s), int(s)), Image.LANCZOS)
        off = int(512 * inset)
        tmp = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
        tmp.paste(layer, (off, off))
        layer = tmp

    canvas.alpha_composite(layer)
    return canvas


def main():
    build(192, 42).save(os.path.join(HERE, "icon-192.png"))
    build(512, 112).save(os.path.join(HERE, "icon-512.png"))
    # maskable: full bleed background, artwork inside the 80% safe zone
    build(512, 0, scale=0.78, inset=56, full_bleed=True).save(
        os.path.join(HERE, "icon-maskable-512.png"))
    print("icons written to", HERE)


if __name__ == "__main__":
    main()
