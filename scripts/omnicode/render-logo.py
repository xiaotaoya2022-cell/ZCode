#!/usr/bin/env python3
"""OmniCode logo rasterizer — reusable branding asset pipeline.

Re-renders the official OmniCode logo (black "architectural aperture" on a
white rounded-square tile, transparent outside the tile) from the vector
geometry of `omnicode_concept_01.svg` into every PNG/ICO/ICNS the desktop
build references, using 4x supersampling + LANCZOS downscale for clean
antialiasing.

SINGLE SOURCE OF TRUTH: `scripts/omnicode/assets/omnicode_concept_01.svg`
is the canonical vector original (752 bytes, handoff copy). The geometry
constants below are a value-for-value transcription of that SVG; any change
to the SVG must be mirrored here (tile rect, path commands, fills) or the
rendered assets will silently diverge from the source design.

Geometry (viewBox 0 0 1024 1024, transcribed from the SVG):
  - tile:   rounded rect x=77 y=77 w=870 h=870 rx=190, fill #FFFFFF
  - mark:   single closed path, fill #080808, quadratic Béziers sampled >=48 pts

Renders are post-processed so that fully transparent (alpha=0) pixels always
carry RGB=0 — some legacy GDI resample/read paths render nonzero RGB under
alpha=0 as a dark fringe on the icon edge.

Outputs (into packages/desktop/build by default):
  icon.png / icon_windows.png / icon_installer.png        (1024 RGBA)
  icon.ico / icon_installer.ico                           (16..256 multi-size)
  icon.icns / icon_installer.icns                         (mac, ic07..ic14 PNG entries)
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

from PIL import Image, ImageChops, ImageDraw, ImageStat

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

# ICNS (Apple Icon Image format). Pillow's ICNS writer maps these entries:
#   ic07=128x128   ic08=256x256   ic09=512x512   ic10=1024x1024 (512pt@2x)
#   ic11=32x32     ic12=64x64     ic13=256x256@2x ic14=512x512@2x
# Every entry embeds plain PNG data; @2x entries reuse the same pixel size as
# their 1x counterpart (ic13==ic08 data, ic14==ic09 data), per Apple's spec.
ICNS_PNG_SIZES = [32, 64, 128, 256, 512]  # + the 1024 base image
ICNS_ENTRY_PIXEL = {
    b"ic07": 128,
    b"ic08": 256,
    b"ic09": 512,
    b"ic10": 1024,
    b"ic11": 32,
    b"ic12": 64,
    b"ic13": 256,
    b"ic14": 512,
}
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


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


def zero_transparent_rgb(img):
    """Force RGB to 0 wherever alpha is 0.

    The render starts from a (0,0,0,0) canvas so this should already hold,
    but the LANCZOS resize (and Pillow's internal ICO downscales) can in
    principle leave nonzero RGB under fully transparent pixels; a few legacy
    GDI read paths render that as a dark fringe. Cheap to guarantee.
    """
    r, g, b, a = img.split()
    mask = a.point(lambda v: 255 if v else 0)  # 0 stays 0, any alpha -> 255
    return Image.merge(
        "RGBA",
        (
            ImageChops.multiply(r, mask),
            ImageChops.multiply(g, mask),
            ImageChops.multiply(b, mask),
            a,
        ),
    )


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
    return zero_transparent_rgb(img.resize((size, size), Image.LANCZOS))


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
    assert_transparent_rgb_zero(im, str(path))
    return im.size


def assert_transparent_rgb_zero(img, label):
    """Guard: every fully transparent (alpha=0) pixel must carry RGB=0."""
    transparent = img.getchannel("A").point(lambda v: 0 if v else 255)
    for i, ch in enumerate(img.convert("RGB").split()):
        nonzero = ch.point(lambda v: 255 if v else 0)
        overlap = ImageChops.multiply(transparent, nonzero)
        assert overlap.getextrema() == (0, 0), (
            f"{label}: alpha=0 pixels with nonzero RGB channel {'RGB'[i]}"
        )


def verify_ico(path):
    im = Image.open(path)
    assert im.format == "ICO", f"{path}: {im.format}"
    sizes = sorted(im.ico.sizes())
    assert sizes == ICO_SIZES, f"{path}: internal sizes {sizes}"
    for s in sizes:
        frame = im.ico.getimage(s)
        assert frame.mode == "RGBA" and frame.size == s, f"{path}@{s}: {frame.mode}/{frame.size}"
        assert min(frame.getchannel("A").getextrema()) < 255, f"{path}@{s}: alpha all-opaque"
        assert_transparent_rgb_zero(frame, f"{path}@{s}")  # dark-fringe guard
    return sizes


def verify_icns(path):
    """Validate an .icns: header magic/length, entry table, PNG payloads,
    then read it back with Pillow and require the full multi-size set."""
    data = Path(path).read_bytes()
    assert data[:4] == b"icns", f"{path}: bad magic {data[:4]!r}"
    total = int.from_bytes(data[4:8], "big")
    assert total == len(data), f"{path}: header length {total} != file size {len(data)}"
    off, entries = 8, []
    # Optional TOC block (b'TOC ' + len + (type,len) pairs) may precede the data
    if data[off : off + 4] == b"TOC ":
        toc_len = int.from_bytes(data[off + 4 : off + 8], "big")
        assert 8 <= toc_len and off + toc_len <= len(data), f"{path}: bad TOC length {toc_len}"
        off += toc_len
    while off < len(data):
        etype = data[off : off + 4]
        length = int.from_bytes(data[off + 4 : off + 8], "big")
        assert length >= 8 and off + length <= len(data), f"{path}: bad entry {etype!r} len={length} at {off}"
        assert etype in ICNS_ENTRY_PIXEL, f"{path}: unexpected entry type {etype!r}"
        assert data[off + 8 : off + 16] == PNG_MAGIC, f"{path}: entry {etype!r} payload is not PNG"
        entries.append(etype.decode())
        off += length
    assert off == len(data), f"{path}: trailing bytes after last entry"
    for required in ("ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13"):
        assert required in entries, f"{path}: missing entry {required}"
    # Pillow read-back: format + full multi-size info. Pillow reports logical
    # (w, h, scale) triples — e.g. ic10 (1024px) reads back as (512, 512, 2).
    im = Image.open(path)
    assert im.format == "ICNS", f"{path}: pillow read format {im.format}"
    got = sorted(tuple(s) for s in (im.info.get("sizes") or []))
    want = sorted(
        {
            (128, 128, 1),  # ic07
            (256, 256, 1),  # ic08
            (512, 512, 1),  # ic09
            (512, 512, 2),  # ic10 (1024px @2x)
            (16, 16, 2),  # ic11 (32px @2x)
            (32, 32, 2),  # ic12 (64px @2x)
            (128, 128, 2),  # ic13 (256px @2x)
            (256, 256, 2),  # ic14 (512px @2x)
        }
    )
    assert got == want, f"{path}: pillow sizes {got} != {want}"
    assert im.size == (1024, 1024), f"{path}: pillow default size {im.size}"
    return entries


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
    for name in ("icon.icns", "icon_installer.icns"):
        rendered[1024].save(
            out / name,
            format="ICNS",
            append_images=[rendered[s] for s in ICNS_PNG_SIZES],
        )

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
    for name in ("icon.icns", "icon_installer.icns"):
        entries = verify_icns(out / name)
        print(f"[verify] {name} OK entries={entries}")
    if args.ref:
        print(f"[diff] 1024 vs {args.ref}: {diff_vs_reference(out / 'icon.png', args.ref)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
