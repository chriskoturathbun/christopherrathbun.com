#!/usr/bin/env python3
"""Death, Taxes & Forecast Inaccuracies — circular die-cut sticker.

Quiet Protocol: clinical instrument aesthetic. Supersampled 2x, output 2400px.
"""
import math
from PIL import Image, ImageDraw, ImageFont

S = 4800            # supersample canvas
OUT = 2400          # final size
CX = CY = S // 2

FONTS = "/root/.claude/skills/canvas-design/canvas-fonts"
JURA_L = f"{FONTS}/Jura-Light.ttf"
JURA_M = f"{FONTS}/Jura-Medium.ttf"
MONO = f"{FONTS}/DMMono-Regular.ttf"

PORCELAIN = (246, 244, 238, 255)
INK = (24, 42, 62, 255)
BLUE = (47, 93, 158, 255)
BLUE_FILL = (47, 93, 158, 34)
BLUE_FILL2 = (47, 93, 158, 22)
RED = (179, 69, 44, 255)
HAIR = (24, 42, 62, 90)

R_DIE = 2320        # white die-cut edge radius
R_FACE = 2200       # printed face radius
R_RING = 2120       # outer hairline ring
R_TICKS_OUT = 2060
R_TICKS_IN_MAJ = 1975
R_TICKS_IN_MIN = 2015
R_INNER_RING = 1930


def catmull_rom(pts, samples=24):
    """Smooth polyline through pts."""
    if len(pts) < 3:
        return pts
    p = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for j in range(samples):
            t = j / samples
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t
                       + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
                       + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            out.append((x, y))
    out.append(pts[-1])
    return out


def arc_text(base, text, radius, angle_center, font, color,
             tracking=0.0, bottom=False):
    """Draw text along a circular arc centered on angle_center (degrees).

    Top arcs read clockwise; bottom=True reads counterclockwise so the
    text sits right-side-up at the bottom of the circle.
    """
    widths = []
    for ch in text:
        bbox = font.getbbox(ch)
        w = bbox[2] - bbox[0] if ch != " " else font.getbbox("i")[2] * 1.4
        widths.append(w + tracking)
    total_arc = sum(widths) / radius  # radians
    ascent, descent = font.getmetrics()
    gh = ascent + descent

    theta = math.radians(angle_center) - total_arc / 2 * (1 if not bottom else -1)
    for ch, w in zip(text, widths):
        step = (w / radius) * (1 if not bottom else -1)
        mid = theta + step / 2
        deg = math.degrees(mid)
        x = CX + radius * math.cos(mid)
        y = CY + radius * math.sin(mid)
        if ch != " ":
            tile = Image.new("RGBA", (int(gh * 2.4), int(gh * 2.4)), (0, 0, 0, 0))
            td = ImageDraw.Draw(tile)
            td.text((tile.width / 2, tile.height / 2), ch, font=font,
                    fill=color, anchor="mm")
            rot = -(deg + 90) if not bottom else -(deg - 90)
            tile = tile.rotate(rot, resample=Image.BICUBIC, expand=False)
            base.alpha_composite(tile, (int(x - tile.width / 2),
                                        int(y - tile.height / 2)))
        theta += step


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # --- die-cut white edge + printed face -------------------------------
    d.ellipse([CX - R_DIE, CY - R_DIE, CX + R_DIE, CY + R_DIE],
              fill=(255, 255, 255, 255))
    d.ellipse([CX - R_FACE, CY - R_FACE, CX + R_FACE, CY + R_FACE],
              fill=PORCELAIN)

    # --- outer hairline ring ---------------------------------------------
    for r, w in [(R_RING, 6), (R_INNER_RING, 4)]:
        d.ellipse([CX - r, CY - r, CX + r, CY + r], outline=INK, width=w)

    # --- calibration ticks (72 minor, major every 6th) -------------------
    for i in range(72):
        a = math.radians(i * 5)
        major = i % 6 == 0
        r_in = R_TICKS_IN_MAJ if major else R_TICKS_IN_MIN
        w = 6 if major else 4
        x1, y1 = CX + r_in * math.cos(a), CY + r_in * math.sin(a)
        x2, y2 = CX + R_TICKS_OUT * math.cos(a), CY + R_TICKS_OUT * math.sin(a)
        d.line([x1, y1, x2, y2], fill=INK if major else HAIR, width=w)

    # --- perimeter typography --------------------------------------------
    jura = ImageFont.truetype(JURA_M, 148)
    jura_small = ImageFont.truetype(JURA_L, 92)
    mono_s = ImageFont.truetype(MONO, 64)

    arc_text(img, "DEATH, TAXES & FORECAST INACCURACIES",
             radius=1735, angle_center=-90, font=jura, color=INK, tracking=34)
    arc_text(img, "THE THREE CERTAINTIES",
             radius=1745, angle_center=90, font=jura_small, color=INK,
             tracking=40, bottom=True)

    # --- central chart ----------------------------------------------------
    # chart frame (invisible), coordinates; DY drops the block for balance
    DY = 80
    x0, x1 = CX - 1150, CX + 1150
    t0x = CX - 230                      # forecast origin
    ybase = CY + 420 + DY               # baseline axis y
    ytop = CY - 620 + DY

    mono_lab = ImageFont.truetype(MONO, 66)

    # baseline axis with end ticks
    d.line([x0, ybase, x1, ybase], fill=INK, width=6)
    for tx in range(int(x0), int(x1) + 1, 115):
        d.line([tx, ybase, tx, ybase + 26], fill=HAIR, width=4)

    # t0 vertical dashed reference
    ty = ytop + 40
    while ty < ybase - 10:
        d.line([t0x, ty, t0x, min(ty + 34, ybase - 10)], fill=HAIR, width=4)
        ty += 62
    d.text((t0x, ybase + 44), "t0", font=mono_lab, fill=INK, anchor="ma")

    # forecast cone (two nested wedges)
    cone_end = x1 - 40
    med_y = CY - 60 + DY
    spread_outer = 470
    spread_inner = 250
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    apex = (t0x, CY + 40 + DY)
    od.polygon([apex,
                (cone_end, med_y - spread_outer),
                (cone_end, med_y + spread_outer)], fill=BLUE_FILL2)
    od.polygon([apex,
                (cone_end, med_y - spread_inner),
                (cone_end, med_y + spread_inner)], fill=BLUE_FILL)
    img.alpha_composite(overlay)
    # cone edges, closed on the right
    d.line([apex, (cone_end, med_y - spread_outer)], fill=BLUE, width=5)
    d.line([apex, (cone_end, med_y + spread_outer)], fill=BLUE, width=5)
    d.line([cone_end, med_y - spread_outer, cone_end, med_y + spread_outer],
           fill=BLUE, width=3)

    # forecast median, dashed blue
    steps = 40
    for i in range(0, steps, 2):
        fx1 = apex[0] + (cone_end - apex[0]) * i / steps
        fx2 = apex[0] + (cone_end - apex[0]) * (i + 1) / steps
        fy1 = apex[1] + (med_y - apex[1]) * i / steps
        fy2 = apex[1] + (med_y - apex[1]) * (i + 1) / steps
        d.line([fx1, fy1, fx2, fy2], fill=BLUE, width=7)

    # observed line: calm history that ends at apex
    hist = [(x0, CY + 180 + DY), (x0 + 300, CY + 120 + DY),
            (x0 + 560, CY + 205 + DY), (x0 + 780, CY + 90 + DY),
            (apex[0], apex[1])]
    d.line(catmull_rom(hist), fill=INK, width=11, joint="curve")

    # actual line: leaves the cone, red
    act = [(apex[0], apex[1]), (apex[0] + 240, CY + 130 + DY),
           (apex[0] + 480, CY - 40 + DY), (apex[0] + 700, CY + 250 + DY),
           (apex[0] + 950, CY - 300 + DY),
           (cone_end + 10, med_y - spread_outer - 210)]
    pts = catmull_rom(act)
    d.line(pts, fill=RED, width=11, joint="curve")
    # terminal marker
    ex, ey = pts[-1]
    d.ellipse([ex - 26, ey - 26, ex + 26, ey + 26], fill=RED)
    d.ellipse([ex - 44, ey - 44, ex + 44, ey + 44], outline=RED, width=5)

    # labels
    d.text((x0 + 380, CY + 265 + DY), "OBSERVED", font=mono_lab, fill=INK, anchor="mm")
    d.text((cone_end - 350, med_y + 235), "PROJECTED",
           font=mono_lab, fill=BLUE, anchor="mm")
    d.text((ex - 90, ey - 8), "ACTUAL", font=mono_lab, fill=RED, anchor="rm")

    # figure annotations, horizontal, under the axis corners
    d.text((x0, ybase + 120), "FIG. 1", font=mono_lab, fill=BLUE, anchor="la")
    d.text((x1, ybase + 120), "N = 3", font=mono_lab, fill=BLUE, anchor="ra")

    # delta bracket: the measured gap between forecast and reality
    bx = cone_end + 95
    d.line([bx, med_y, bx, ey], fill=INK, width=5)
    d.line([bx - 28, med_y, bx + 28, med_y], fill=INK, width=5)
    d.line([bx - 28, ey, bx + 28, ey], fill=INK, width=5)
    delta_f = ImageFont.truetype(JURA_M, 84)
    d.text((bx + 58, (med_y + ey) / 2), "Δ", font=delta_f, fill=INK,
           anchor="lm")

    # --- maker's mark: ring of seven (cyclodextrin torus) ----------------
    mkx, mky, mr, sr = CX, CY + 1000, 112, 31
    for i in range(7):
        a = math.radians(-90 + i * 360 / 7)
        px, py = mkx + mr * math.cos(a), mky + mr * math.sin(a)
        d.ellipse([px - sr, py - sr, px + sr, py + sr], outline=INK, width=5)

    # --- downsample & save ------------------------------------------------
    img = img.resize((OUT, OUT), Image.LANCZOS)
    img.save("/tmp/claude-0/-home-user-christopherrathbun-com/79e38de6-2f76-575f-b216-3e4fcb986e7d/scratchpad/sticker.png")
    print("saved")


if __name__ == "__main__":
    main()
