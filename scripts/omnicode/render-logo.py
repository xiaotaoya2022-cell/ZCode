#!/usr/bin/env python3
"""OmniCode logo rasterizer — reusable branding asset pipeline.

Re-renders the official OmniCode logo (black "architectural aperture" on a
white rounded-square tile, transparent outside the tile) from the vector
geometry of `omnicode_concept_01.svg` into every PNG/ICO the desktop build
references, using 4x supersampling + LANCZOS downscale for clean antialiasing.

Geometry (viewBox 0 0 1024 1024):
  - tile:   rounded rect x=77 y=77 w=870 h=870 rx=190, fill #FFFFFF
  - mark:   single closed path, fill #080808, quadratic Béziers sampled >=48 pts

Outputs (into packages/desktop/build by default):
  icon.png / icon_windows.png / icon_installer.png        (1024 RGBA)
  icon.ico / icon_installer.ico                           (16..256 multi-size)
  icons/{16,24,32,48,64,128,256,512,1024}x*.png           (Linux hicolor set)

Usage:
  python render-logo.py [--out DIR] [--ref REF_PNG]
`--ref` adds a mean-abs-diff comparison of the 1024 render against a
reference PNG (data only, no visual judgement).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageStat

# ---------------------------------------------------------------- geometry --

VIEWBOX = 1024.0

TILE = {"x": 77.0, "y": 77.0, "w": 870.0, "h": 870.0, "rx": 190.0}

PAPER = (255, 255, 255, 255)  # tile fill #FFFFFF
INK = (8, 8, 8, 255)  # mark fill #080808

# Path commands: ("L", x, y) | ("Q", cx, cy, x, y). Start point is the "M".
MARK_START = (278.0, 746.0)
MARK_PATH = [
    ("L", 278.0, 466.0),
    ("Q", 278.0, 386.0, 348.0, 352.0),
    ("L", 512.0, 270.0),
    ("L", 676.0, 352.0),
    ("Q", 746.0, 386.0, 746.0, 466.0),
    ("L", 746.0, 746.0),
    ("L", 590.0, 746.0),
    ("L", 590.0, 466.0),
    ("Q", 590.0, 430.0, 554.0, 430.0),
    ("L", 470.0, 430.0),
    ("Q", 434.0, 430.0, 434.0, 466.0),
    ("L", 434.0, 746.0),
]

SS = 4  # supersampling factor
Q_SAMPLES = 64  # points per Bézier segment (spec floor: >=48)
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]


def _quad_points(p0, p1, p2, n):
    """Sample quadratic Bézier p0->p2 with control p1; skip t=0 (joint dup)."""
    for i in range(1, n + 1):
        t = i / n
        u = 1.0 - t
        yield (
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        )


def mark_polygon(scale):
    pts = [(MARK_START[0] * scale, MARK_START[1] * scale)]
    cur = MARK_START
    for cmd in MARK_PATH:
        if cmd[0] == "L":
            nxt = (cmd[1] * scale, cmd[2] * scale)
            pts.append(nxt)
        else:  # Q
            c = (cmd[1] * scale, cmd[2] * scale)
            nxt = (cmd[3] * scale, cmd[4] * scale)
            pts.extend(_quad_points(cur, c, nxt, Q_SAMPLES))
            pts.append(nxt)
        cur = nxt
    return pts


def render(size):
    """Render the logo at `size` px: draw at size*SS, shrink with LANCZOS."""
    ss = size * SS
    scale = ss / VIEWBOX
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    t = TILE
    draw.rounded_rectangle(
        [t["x"] * scale, t["y"] * scale, (t["x"] + t["w"]) * scale, (t["y"] + t["h"]) * scale],
        radius=t["rx"] * scale,
        fill=PAPER,
    )
    draw.polygon(mark_polygon(scale), fill=INK)
    return img.resize((size, size), Image.LANCZOS)


# ------------------------------------------------------------- self checks --

def verify_png(path):
    im = Image.open(path)
    assert im.format == "PNG" and im.mode == "RGBA", f"{path}: {im.format}/{im.mode}"
    a = im.getchannel("A")
    mn, mx = a.getextrema()
    assert mn == 0, f"{path}: no transparent pixels outside tile (alpha min={mn})"
    assert mx == 255 and ImageStat.Stat(a).mean[0] > 32, f"{path}: nearly fully transparent"
    rgb = im.convert("RGB")
    # darkest channel min across RGB catches the black mark
    dark = min(min(c.getextrema()) for c in rgb.split())
    assert dark <= 64, f"{path}: no dark ink pixels (min={dark})"
    return im.size


def verify_ico(path):
    im = Image.open(path)
    assert im.format == "ICO", f"{path}: {im.format}"
    sizes = sorted(im.ico.sizes())
    assert sizes == ICO_SIZES, f"{path}: internal sizes {sizes}"
    for s in sizes:
        frame = im.ico.getimage(s)
        assert frame.mode == "RGBA" and frame.size == s, f"{path}@{s}: {frame.mode}/{frame.size}"
        assert min(frame.getchannel("A").getextrema()) < 255, f"{path}@{s}: alpha all-opaque"
    return sizes


def diff_vs_reference(rendered_path, ref_path):
    """Mean absolute per-channel diff between our 1024 render and a reference."""
    import numpy as np

    a = np.asarray(Image.open(rendered_path).convert("RGBA"), dtype=np.int16)
    b = np.asarray(Image.open(ref_path).convert("RGBA"), dtype=np.int16)
    if a.shape != b.shape:
        return f"shape mismatch {a.shape} vs {b.shape}"
    d = np.abs(a - b)
    ch = {n: round(float(d[..., i].mean()), 3) for i, n in enumerate("RGBA")}
    return f"mean_abs_diff per channel {ch}, overall {round(float(d.mean()), 3)}"


# -------------------------------------------------------------------- main --

def main():
    repo = Path(__file__).resolve().parents[2]
    ap = argparse.ArgumentParser(description="Render OmniCode logo assets")
    ap.add_argument("--out", type=Path, default=repo / "packages" / "desktop" / "build")
    ap.add_argument("--ref", type=Path, default=None, help="reference 1024 PNG for diff report")
    args = ap.parse_args()

    out = args.out
    (out / "icons").mkdir(parents=True, exist_ok=True)

    rendered = {s: render(s) for s in PNG_SIZES}
    for s, img in rendered.items():
        img.save(out / "icons" / f"{s}x{s}.png")
    for name in ("icon.png", "icon_windows.png", "icon_installer.png"):
        rendered[1024].save(out / name)
    for name in ("icon.ico", "icon_installer.ico"):
        rendered[256].save(out / name, format="ICO", sizes=ICO_SIZES)

    print(f"[render] wrote assets to {out}")
    for s in PNG_SIZES:
        size = verify_png(out / "icons" / f"{s}x{s}.png")
        print(f"[verify] icons/{s}x{s}.png OK size={size} mode=RGBA")
    for name in ("icon.png", "icon_windows.png", "icon_installer.png"):
        size = verify_png(out / name)
        print(f"[verify] {name} OK size={size} mode=RGBA")
    for name in ("icon.ico", "icon_installer.ico"):
        sizes = verify_ico(out / name)
        print(f"[verify] {name} OK internal_sizes={sizes}")
    if args.ref:
        print(f"[diff] 1024 vs {args.ref}: {diff_vs_reference(out / 'icon.png', args.ref)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
