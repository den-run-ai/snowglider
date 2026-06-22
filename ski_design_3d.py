#!/usr/bin/env python3
"""SnowGlider — ski design proposal: 3D "both skis" panel (issue #189).

This script renders **panel E** of the improved-ski-design mockup — a 3D
perspective view of the *proposed shaped ski as a pair*, from a slight-front
side angle (a "side / front-quarter" view) — and composites it underneath the
existing 4-panel schematic sheet so panels A-D stay byte-identical.

Panels A-D (current box ski, proposed side profile, top-view sidecut, and the
cosmetic flex states) live in the base image `ski-design-proposal-base.png`.
Panel E here deliberately reuses the SAME math as those panels:
  * the camber / shovel-tip-rise / tail-kick vertical profile from panel B, and
  * the wide-shovel -> narrow-waist -> medium-tail sidecut from panel C,
lofted into a smooth shell and rendered twice (a left + right ski).

It is 100% cosmetic — no physics, no game code. Pure matplotlib + numpy + PIL.

Usage:
    python3 ski_design_3d.py                 # base -> ski-design-proposal.png
    python3 ski_design_3d.py --base b.png --out out.png --panel panelE.png

Re-running is idempotent: panel E is always composited onto the 4-panel BASE,
never onto an already-composited sheet.
"""
import argparse
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from PIL import Image

SNOW = "#eef4fb"; INK = "#22303c"; ACCENT = "#1f6feb"
RED = np.array([0.835, 0.247, 0.247])   # top sheet
BASE = np.array([0.42, 0.12, 0.12])     # darker base
EDGE = np.array([0.28, 0.35, 0.43])     # steel edge

N = 120
s = np.linspace(0.0, 10.0, N)           # 0 = tail end, 10 = shovel/tip end


def profile(s):
    """Vertical profile + sidecut half-width + thickness along the ski length."""
    camber = 0.18 * np.exp(-((s - 5) ** 2) / 7.0)                        # gentle arch (panel B)
    tip = np.where(s >= 8.0, 1.25 / (1 + np.exp(-(s - 9.1) * 3.2)), 0.0)  # shovel rise (panel B)
    tail = np.where(s <= 2.2, 0.45 / (1 + np.exp((s - 1.0) * 3.2)), 0.0)  # tail kick (panel B)
    zb = camber + tip + tail
    w = (0.62 - 0.30 * np.exp(-((s - 5) ** 2) / 6.0)                     # sidecut waist (panel C)
         + 0.18 * np.exp(-((s - 9.2) ** 2) / 1.2)                        # shovel widen
         + 0.10 * np.exp(-((s - 0.8) ** 2) / 1.5))                       # tail widen
    end = np.clip(np.minimum((10 - s) / 0.6, s / 0.6), 0, 1)            # round the ends (non-pointed)
    w = w * (0.34 + 0.66 * end)
    t = (0.15 + 0.06 * np.exp(-((s - 5) ** 2) / 9.0)) * (0.45 + 0.55 * end)
    return zb, w, t


ZB, W, T = profile(s)
LIGHT = np.array([-0.42, -0.5, 0.76]); LIGHT = LIGHT / np.linalg.norm(LIGHT)


def shade(base_rgb, n):
    d = max(0.0, float(np.dot(n, LIGHT)))
    return tuple(np.clip(base_rgb * (0.52 + 0.48 * d), 0, 1))


def quad_normal(p):
    n = np.cross(p[1] - p[0], p[2] - p[0]); ln = np.linalg.norm(n)
    return n / ln if ln > 1e-9 else np.array([0, 0, 1.0])


def build_ski(x0):
    """Lofted shell faces (top sheet / base / two steel edges / end caps) for a
    ski centered at x = x0.  X = width, Y = length, Z = height."""
    faces, cols = [], []
    LB = np.c_[x0 - W, s, ZB]; RB = np.c_[x0 + W, s, ZB]
    RT = np.c_[x0 + W, s, ZB + T]; LT = np.c_[x0 - W, s, ZB + T]
    for i in range(N - 1):
        for ep, base in (((LT, RT), RED), ((RB, LB), BASE), ((LB, LT), EDGE), ((RT, RB), EDGE)):
            q = np.array([ep[0][i], ep[1][i], ep[1][i + 1], ep[0][i + 1]])
            faces.append(q); cols.append(shade(base, quad_normal(q)))
    for i, base in ((0, BASE), (N - 1, RED)):
        q = np.array([LB[i], RB[i], RT[i], LT[i]])
        faces.append(q); cols.append(shade(base, quad_normal(q)))
    return faces, cols


def render_panel(path, dpi=140):
    """Render panel E to its own PNG at 1820 px wide (matches the base sheet)."""
    fig = plt.figure(figsize=(13.0, 5.15), dpi=dpi)
    fig.patch.set_facecolor("white")

    bg = fig.add_axes([0.012, 0.03, 0.976, 0.93]); bg.set_facecolor(SNOW)
    bg.set_xticks([]); bg.set_yticks([])
    for sp in bg.spines.values():
        sp.set_visible(False)
    bg.text(0.018, 0.93, "E.  Proposed  —  3D view (both skis, side / front-quarter)",
            transform=bg.transAxes, fontsize=12.5, fontweight="bold", color=INK, ha="left", va="top")
    bg.text(0.5, 0.07,
            "the real shaped shell shown as a pair — smooth shovel, sidecut waist, tail kick & camber; "
            "no flat boxes.   cosmetic only; physics untouched.",
            transform=bg.transAxes, fontsize=9.3, color=INK, ha="center", va="bottom")
    for k, (rgb, lab) in enumerate([("#d23b3b", "top sheet"), ("#6b1f1f", "darker base"),
                                    ("#46586a", "steel edge")]):
        y = 0.86 - k * 0.085
        bg.add_patch(Rectangle((0.845, y - 0.028), 0.028, 0.05, transform=bg.transAxes,
                               facecolor=rgb, edgecolor="#33414e", lw=0.6))
        bg.text(0.882, y, lab, transform=bg.transAxes, fontsize=8.7, color=INK, va="center")

    # left-biased + slightly oversized so the diagonal pair centers as a hero panel
    ax = fig.add_axes([-0.05, 0.02, 0.90, 0.95], projection="3d")
    ax.patch.set_alpha(0.0)
    for x0 in (-1.0, 1.0):
        f, c = build_ski(x0)
        ax.add_collection3d(Poly3DCollection(f, facecolors=c, edgecolors="none"))

    def tag(xyz, txt, ha="center"):
        ax.text(xyz[0], xyz[1], xyz[2], txt, color=ACCENT, fontsize=9.3, ha=ha, va="center",
                fontweight="bold")
    tag((0.0, 10.2, 2.0), "shovel / tip rise")
    tag((1.7, 4.6, 0.18), "sidecut waist", ha="left")
    tag((-0.3, -0.4, 1.05), "tail kick", ha="right")

    ax.set_box_aspect((3.6, 10.0, 2.35))
    ax.set_xlim(-1.75, 1.75); ax.set_ylim(0.2, 9.8); ax.set_zlim(0, 1.72)
    ax.view_init(elev=16, azim=-60)
    ax.set_axis_off()

    fig.savefig(path, dpi=dpi, facecolor="white")
    plt.close(fig)


def composite(base_path, panel_path, out_path):
    """Stack the 4-panel base sheet on top of panel E."""
    top = Image.open(base_path).convert("RGB")
    bot = Image.open(panel_path).convert("RGB")
    if bot.width != top.width:
        bot = bot.resize((top.width, round(bot.height * top.width / bot.width)), Image.LANCZOS)
    out = Image.new("RGB", (top.width, top.height + bot.height), "white")
    out.paste(top, (0, 0)); out.paste(bot, (0, top.height))
    out.save(out_path)
    return out.size


def main():
    ap = argparse.ArgumentParser(description="Render proposal panel E (3D both skis) and composite it.")
    ap.add_argument("--base", default="ski-design-proposal-base.png", help="4-panel A-D base sheet")
    ap.add_argument("--panel", default="ski-design-proposal-panelE.png", help="standalone panel E output")
    ap.add_argument("--out", default="ski-design-proposal.png", help="final composited 5-panel sheet")
    args = ap.parse_args()
    render_panel(args.panel)
    size = composite(args.base, args.panel, args.out)
    print(f"wrote {args.panel} and {args.out} {size}")


if __name__ == "__main__":
    main()
