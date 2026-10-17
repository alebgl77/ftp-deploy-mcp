"""Render the ftp-deploy-mcp minimal brand system.

The source of truth is deterministic geometry plus exact bilingual copy. Pillow
is a build-time rendering tool only; it is not a project runtime dependency.
"""

from __future__ import annotations

import argparse
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat, PngImagePlugin


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets"
SITE_ASSETS = ROOT / "site" / "assets"

GRAPHITE = (8, 17, 31)
SURFACE = (16, 28, 44)
OFF_WHITE = (244, 247, 251)
CYAN = (34, 199, 217)
GREEN = (52, 211, 153)

SCALE = 2
RADIUS = 16
PILL_RADIUS = 12
STROKE = 2

COPY = {
    "en": {
        "banner_tagline": "Controlled deployment for AI agents",
        "banner_protocols": "FTP  /  FTPS  /  SFTP  ·  MCP server",
        "architecture_title": "Verified deployment architecture",
        "architecture_subtitle": "Local policy first. Remote mutation follows an explicit plan.",
        "architecture_steps": ("MCP CLIENT", "LOCAL CONTROL", "PLAN", "APPLY", "VERIFY", "ROLLBACK"),
        "recovery": "SAFE RECOVERY",
        "flow_title": "Verified deployment flow",
        "flow_subtitle": "Six deliberate gates. One verified final state.",
        "flow_steps": ("SCAN", "PLAN", "APPROVE", "TRANSFER", "VERIFY", "PROMOTE"),
        "states": ("READY", "ACTIVE", "DONE"),
        "deployed": "DEPLOYED",
        "rollback": "ROLLBACK AVAILABLE",
        "site_title": "Target architecture",
        "site_nodes": ("AI agent", "Local control engine", "Policies", "Plan & journal", "Local configuration", "Remote server"),
    },
    "fr": {
        "banner_tagline": "Déploiement contrôlé pour agents IA",
        "banner_protocols": "FTP  /  FTPS  /  SFTP  ·  Serveur MCP",
        "architecture_title": "Architecture de déploiement vérifié",
        "architecture_subtitle": "Politique locale d’abord. Toute mutation distante suit un plan explicite.",
        "architecture_steps": ("CLIENT MCP", "CONTRÔLE LOCAL", "PLANIFIER", "APPLIQUER", "VÉRIFIER", "RESTAURER"),
        "recovery": "REPRISE SÛRE",
        "flow_title": "Flux de déploiement vérifié",
        "flow_subtitle": "Six contrôles explicites. Un état final vérifié.",
        "flow_steps": ("ANALYSER", "PLANIFIER", "APPROUVER", "TRANSFÉRER", "VÉRIFIER", "PROMOUVOIR"),
        "states": ("PRÊT", "ACTIF", "TERMINÉ"),
        "deployed": "DÉPLOYÉ",
        "rollback": "RESTAURATION DISPONIBLE",
        "site_title": "Architecture cible",
        "site_nodes": ("Agent IA", "Moteur de contrôle local", "Politiques", "Plan & journal", "Configuration locale", "Serveur distant"),
    },
}


def font_path(bold: bool = False, mono: bool = False) -> Path:
    if mono:
        candidates = [Path("C:/Windows/Fonts/CascadiaMono.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")]
    elif bold:
        candidates = [Path("C:/Windows/Fonts/segoeuib.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")]
    else:
        candidates = [Path("C:/Windows/Fonts/segoeui.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"No suitable system font found: {candidates}")


def font(size: int, *, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(font_path(bold=bold, mono=mono)), size * SCALE)


def box(values):
    return tuple(round(value * SCALE) for value in values)


def point(values):
    return tuple(round(value * SCALE) for value in values)


def rounded(draw, bounds, *, fill=None, outline=None, radius=RADIUS, width=STROKE):
    draw.rounded_rectangle(box(bounds), radius=radius * SCALE, fill=fill, outline=outline, width=width * SCALE)


def rule(draw, coordinates, *, fill, width=STROKE, joint="curve"):
    draw.line(tuple(value * SCALE for value in coordinates), fill=fill, width=width * SCALE, joint=joint)


def label(
    draw,
    xy,
    value,
    size,
    *,
    fill,
    bold=False,
    mono=False,
    anchor="la",
    max_width=None,
    fit_bounds=None,
    padding=0,
):
    chosen = size
    while max_width and chosen > 12:
        candidate = font(chosen, bold=bold, mono=mono)
        if draw.textbbox((0, 0), value, font=candidate)[2] <= max_width * SCALE:
            break
        chosen -= 1
    chosen_font = font(chosen, bold=bold, mono=mono)
    location = point(xy)
    text_bounds = draw.textbbox(location, value, font=chosen_font, anchor=anchor)
    if fit_bounds:
        allowed = box((fit_bounds[0] + padding, fit_bounds[1] + padding, fit_bounds[2] - padding, fit_bounds[3] - padding))
        assert text_bounds[0] >= allowed[0], (value, text_bounds, allowed)
        assert text_bounds[1] >= allowed[1], (value, text_bounds, allowed)
        assert text_bounds[2] <= allowed[2], (value, text_bounds, allowed)
        assert text_bounds[3] <= allowed[3], (value, text_bounds, allowed)
    draw.text(location, value, font=chosen_font, fill=fill, anchor=anchor)
    return text_bounds


def arrow(draw, start, end, *, fill=CYAN, width=STROKE):
    x1, y1 = start
    x2, y2 = end
    rule(draw, (x1, y1, x2, y2), fill=fill, width=width)
    angle = math.atan2(y2 - y1, x2 - x1)
    length = 12
    spread = 6
    tip = point((x2, y2))
    left = point((x2 - length * math.cos(angle) + spread * math.sin(angle), y2 - length * math.sin(angle) - spread * math.cos(angle)))
    right = point((x2 - length * math.cos(angle) - spread * math.sin(angle), y2 - length * math.sin(angle) + spread * math.cos(angle)))
    draw.polygon((tip, left, right), fill=fill)


def new_canvas(width, height, color):
    return Image.new("RGB", (width * SCALE, height * SCALE), color)


def finish(image, size):
    return image.resize(size, Image.Resampling.LANCZOS)


def png_info(kind, locale, copy_values):
    info = PngImagePlugin.PngInfo()
    info.add_text("Brand system", "ftp-deploy-mcp minimal verified-transfer system")
    info.add_text("Asset", kind)
    info.add_text("Locale", locale)
    info.add_text("Exact copy", json.dumps(copy_values, ensure_ascii=False))
    return info


def save_png(image, path, kind, locale, copy_values):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True, compress_level=9, pnginfo=png_info(kind, locale, copy_values))


def mark(draw, bounds, *, border=False):
    x1, y1, x2, y2 = bounds
    width = x2 - x1
    height = y2 - y1
    rounded(draw, bounds, fill=SURFACE, outline=OFF_WHITE if border else None, radius=16, width=2)

    def p(px, py):
        return point((x1 + px * width / 256, y1 + py * height / 256))

    left = [p(56, 60), p(112, 34), p(112, 102), p(90, 124), p(112, 146), p(112, 222), p(56, 196)]
    right = [p(200, 60), p(144, 34), p(144, 102), p(166, 124), p(144, 146), p(144, 222), p(200, 196)]
    draw.polygon(left, fill=OFF_WHITE)
    draw.polygon(right, fill=OFF_WHITE)
    path_width = max(4, round(width * 16 / 256))
    draw.line((p(24, 156), p(90, 156), p(116, 122), p(178, 122)), fill=CYAN, width=path_width * SCALE, joint="curve")
    draw.line((p(166, 146), p(187, 167), p(232, 112)), fill=GREEN, width=path_width * SCALE, joint="curve")


def document_icon(draw, bounds, color):
    x1, y1, x2, y2 = bounds
    rounded(draw, bounds, fill=None, outline=color, radius=12, width=2)
    fold = 36
    rule(draw, (x2 - fold, y1, x2 - fold, y1 + fold, x2, y1 + fold), fill=color)
    for offset in (65, 88, 111):
        rule(draw, (x1 + 24, y1 + offset, x2 - 24, y1 + offset), fill=color)


def server_icon(draw, bounds, color):
    x1, y1, x2, y2 = bounds
    row_height = (y2 - y1 - 24) / 3
    for index in range(3):
        top = y1 + index * (row_height + 12)
        rounded(draw, (x1, top, x2, top + row_height), fill=None, outline=color, radius=12, width=2)
        draw.ellipse(box((x2 - 28, top + row_height / 2 - 4, x2 - 20, top + row_height / 2 + 4)), fill=color)


def render_banner(locale):
    text = COPY[locale]
    image = new_canvas(2103, 748, OFF_WHITE)
    draw = ImageDraw.Draw(image)
    mark(draw, (96, 82, 176, 162))
    label(draw, (212, 122), "ftp-deploy-mcp", 82, fill=GRAPHITE, bold=True, anchor="lm", max_width=880)
    label(draw, (96, 292), text["banner_tagline"], 48, fill=GRAPHITE, anchor="lm", max_width=980)
    rule(draw, (96, 360, 176, 360), fill=CYAN, width=6)
    label(draw, (96, 424), text["banner_protocols"], 28, fill=GRAPHITE, mono=True, anchor="lm", max_width=960)

    document_icon(draw, (1230, 260, 1390, 460), GRAPHITE)
    arrow(draw, (1408, 360), (1490, 360), fill=CYAN, width=4)
    mark(draw, (1510, 230, 1770, 490))
    arrow(draw, (1790, 360), (1870, 360), fill=GREEN, width=4)
    server_icon(draw, (1890, 252, 2020, 468), GRAPHITE)

    rule(draw, (96, 628, 2007, 628), fill=GRAPHITE, width=2)
    draw.ellipse(box((93, 620, 109, 636)), fill=CYAN)
    draw.ellipse(box((1999, 620, 2015, 636)), fill=GREEN)
    return finish(image, (2103, 748))


def architecture_card(draw, bounds, value, *, outline=OFF_WHITE, icon=None, mono=False, font_size=22):
    rounded(draw, bounds, fill=SURFACE, outline=outline, radius=16, width=2)
    x1, y1, x2, y2 = bounds
    if icon == "gate":
        mark(draw, (x1 + 68, y1 + 18, x1 + 132, y1 + 82))
        text_y = y2 - 24
        fit_bounds = (x1, y2 - 58, x2, y2)
    else:
        text_y = (y1 + y2) / 2
        fit_bounds = bounds
    label(
        draw,
        ((x1 + x2) / 2, text_y),
        value,
        font_size,
        fill=OFF_WHITE,
        bold=True,
        mono=mono,
        anchor="mm",
        max_width=(x2 - x1) - 36,
        fit_bounds=fit_bounds,
        padding=10,
    )


def render_architecture(locale):
    text = COPY[locale]
    steps = text["architecture_steps"]
    image = new_canvas(1600, 900, GRAPHITE)
    draw = ImageDraw.Draw(image)
    label(draw, (64, 78), text["architecture_title"], 52, fill=OFF_WHITE, bold=True, anchor="la", max_width=1450)
    label(draw, (64, 150), text["architecture_subtitle"], 26, fill=OFF_WHITE, anchor="la", max_width=1450)
    rule(draw, (64, 205, 1536, 205), fill=CYAN, width=2)

    y1, y2, mid = 342, 498, 420
    client = (54, y1, 214, y2)
    control = (244, y1, 454, y2)
    stage_boxes = [(494, y1, 644, y2), (684, y1, 834, y2), (874, y1, 1024, y2), (1064, y1, 1214, y2)]
    target = (1254, 300, 1546, 540)
    arrow(draw, (214, mid), (244, mid), fill=CYAN)
    arrow(draw, (454, mid), (494, mid), fill=CYAN)
    for left, right in zip(stage_boxes, stage_boxes[1:]):
        arrow(draw, (left[2], mid), (right[0], mid), fill=CYAN)
    arrow(draw, (1214, mid), (1254, mid), fill=GREEN)

    architecture_font = 18 if locale == "fr" else 22
    architecture_card(draw, client, steps[0], outline=CYAN, font_size=architecture_font)
    architecture_card(draw, control, steps[1], outline=CYAN, icon="gate", font_size=architecture_font)
    for index, bounds in enumerate(stage_boxes):
        architecture_card(draw, bounds, steps[index + 2], outline=GREEN if index >= 2 else OFF_WHITE, font_size=architecture_font)

    rounded(draw, target, fill=SURFACE, outline=GREEN, radius=16, width=2)
    for index, protocol in enumerate(("FTP", "FTPS", "SFTP")):
        row = (1276, 322 + index * 72, 1524, 378 + index * 72)
        rounded(draw, row, fill=GRAPHITE, outline=CYAN if index < 2 else GREEN, radius=12, width=2)
        label(draw, ((row[0] + row[2]) / 2, (row[1] + row[3]) / 2), protocol, 22, fill=OFF_WHITE, bold=True, mono=True, anchor="mm", fit_bounds=row, padding=12)

    recovery = (684, 636, 1014, 716)
    rounded(draw, recovery, fill=SURFACE, outline=GREEN, radius=16, width=2)
    label(draw, (849, 676), text["recovery"], 22, fill=OFF_WHITE, bold=True, anchor="mm", max_width=290)
    arrow(draw, (1139, 498), (1014, 676), fill=GREEN)
    arrow(draw, (684, 676), (569, 498), fill=GREEN)

    rounded(draw, (64, 810, 1536, 842), fill=SURFACE, outline=OFF_WHITE, radius=12, width=2)
    rule(draw, (96, 826, 420, 826), fill=CYAN, width=4)
    rule(draw, (1180, 826, 1504, 826), fill=GREEN, width=4)
    return finish(image, (1600, 900))


def flow_card(draw, bounds, step, state, mode, *, locale):
    outline = OFF_WHITE
    if mode == "active":
        outline = CYAN
    elif mode == "done":
        outline = GREEN
    rounded(draw, bounds, fill=SURFACE, outline=outline, radius=16, width=2)
    x1, y1, x2, y2 = bounds
    step_size = 18 if locale == "fr" else 22
    label(
        draw,
        ((x1 + x2) / 2, y1 + 58),
        step,
        step_size,
        fill=OFF_WHITE,
        bold=True,
        anchor="mm",
        max_width=(x2 - x1) - 34,
        fit_bounds=(x1, y1 + 18, x2, y1 + 98),
        padding=16,
    )
    pill = (x1 + 24, y2 - 50, x2 - 24, y2 - 18)
    pill_fill = GRAPHITE
    pill_outline = OFF_WHITE
    pill_text = OFF_WHITE
    if mode == "active":
        pill_fill = CYAN
        pill_outline = CYAN
        pill_text = GRAPHITE
    elif mode == "done":
        pill_fill = GREEN
        pill_outline = GREEN
        pill_text = GRAPHITE
    rounded(draw, pill, fill=pill_fill, outline=pill_outline, radius=12, width=2)
    label(
        draw,
        ((pill[0] + pill[2]) / 2, (pill[1] + pill[3]) / 2),
        state,
        11 if locale == "fr" else 13,
        fill=pill_text,
        bold=True,
        anchor="mm",
        max_width=(pill[2] - pill[0]) - 14,
        fit_bounds=pill,
        padding=6,
    )


def render_flow(locale, frame=69):
    text = COPY[locale]
    image = new_canvas(1200, 675, GRAPHITE)
    draw = ImageDraw.Draw(image)
    label(draw, (48, 66), text["flow_title"], 46, fill=OFF_WHITE, bold=True, anchor="la", max_width=1100)
    label(
        draw,
        (64, 126),
        text["flow_subtitle"],
        23,
        fill=OFF_WHITE,
        anchor="la",
        max_width=1080,
        fit_bounds=(48, 108, 1152, 174),
        padding=10,
    )
    rule(draw, (48, 176, 1152, 176), fill=CYAN, width=2)

    centers = (120, 312, 504, 696, 888, 1080)
    bounds = [(center - 72, 252, center + 72, 416) for center in centers]
    active = frame // 10
    states = text["states"]
    progress = frame / 69
    rule(draw, (centers[0], 226, centers[-1], 226), fill=SURFACE, width=8)
    progress_x = centers[0] + (centers[-1] - centers[0]) * progress
    rule(draw, (centers[0], 226, progress_x, 226), fill=GREEN if active >= 6 else CYAN, width=8)
    draw.ellipse(box((progress_x - 7, 219, progress_x + 7, 233)), fill=GREEN if active >= 6 else CYAN)
    for index, stage_bounds in enumerate(bounds):
        if active >= 6 or index < active:
            mode, state = "done", states[2]
        elif index == active:
            mode, state = "active", states[1]
        else:
            mode, state = "ready", states[0]
        flow_card(draw, stage_bounds, text["flow_steps"][index], state, mode, locale=locale)

    rollback = (50, 512, 442, 568)
    deployed = (838, 494, 1150, 574)
    rounded(draw, rollback, fill=SURFACE, outline=OFF_WHITE, radius=16, width=2)
    label(draw, (246, 540), text["rollback"], 18, fill=OFF_WHITE, bold=True, anchor="mm", max_width=350, fit_bounds=rollback, padding=14)
    rounded(draw, deployed, fill=SURFACE, outline=GREEN if active >= 6 else OFF_WHITE, radius=16, width=2)
    label(draw, (994, 534), text["deployed"], 24, fill=GREEN if active >= 6 else OFF_WHITE, bold=True, anchor="mm", max_width=270, fit_bounds=deployed, padding=16)
    arrow(draw, (838, 534), (470, 534), fill=GREEN if active >= 6 else OFF_WHITE)
    return finish(image, (1200, 675))


def render_flow_assets(locale):
    frames = [render_flow(locale, frame=index) for index in range(70)]
    png_path = ASSETS / ("verified-deployment-flow.png" if locale == "en" else "verified-deployment-flow-fr.png")
    gif_path = ASSETS / ("verified-deployment-flow.gif" if locale == "en" else "verified-deployment-flow-fr.gif")
    save_png(frames[-1], png_path, "verified-deployment-flow", locale, COPY[locale])
    shared_palette = frames[-1].quantize(colors=32, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    paletted = [frame.quantize(palette=shared_palette, dither=Image.Dither.NONE) for frame in frames]
    paletted[0].save(
        gif_path,
        save_all=True,
        append_images=paletted[1:],
        duration=100,
        loop=0,
        optimize=True,
        disposal=1,
        comment=f"ftp-deploy-mcp {locale} verified deployment flow".encode("utf-8"),
    )


def render_site_architecture(locale):
    text = COPY[locale]
    nodes = text["site_nodes"]
    image = new_canvas(1942, 809, OFF_WHITE)
    draw = ImageDraw.Draw(image)
    label(draw, (72, 72), text["site_title"], 52, fill=GRAPHITE, bold=True, anchor="la", max_width=1100)
    label(draw, (72, 136), "ftp-deploy-mcp", 26, fill=GRAPHITE, bold=True, anchor="la")
    rule(draw, (72, 186, 1870, 186), fill=CYAN, width=2)

    agent = (72, 312, 300, 504)
    local = (494, 246, 1260, 586)
    transport = (1370, 312, 1578, 504)
    remote = (1680, 312, 1870, 504)
    arrow(draw, (300, 408), (494, 408), fill=CYAN, width=4)
    label(draw, (397, 382), "MCP stdio", 18, fill=GRAPHITE, mono=True, anchor="mm")
    arrow(draw, (1260, 408), (1370, 408), fill=GREEN, width=4)
    arrow(draw, (1578, 408), (1680, 408), fill=GREEN, width=4)

    rounded(draw, agent, fill=SURFACE, outline=CYAN, radius=16, width=2)
    mark(draw, (142, 338, 230, 426))
    label(draw, (186, 468), nodes[0], 24, fill=OFF_WHITE, bold=True, anchor="mm", max_width=190, fit_bounds=(agent[0], 438, agent[2], agent[3]), padding=12)

    rounded(draw, local, fill=SURFACE, outline=CYAN, radius=16, width=2)
    label(draw, (877, 292), nodes[1], 28 if locale == "fr" else 30, fill=OFF_WHITE, bold=True, anchor="mm", max_width=700, fit_bounds=(local[0], 260, local[2], 324), padding=12)
    left = (542, 340, 850, 472)
    right = (880, 340, 1212, 472)
    config = (690, 502, 1064, 558)
    rounded(draw, left, fill=GRAPHITE, outline=CYAN, radius=16, width=2)
    rounded(draw, right, fill=GRAPHITE, outline=GREEN, radius=16, width=2)
    rounded(draw, config, fill=GRAPHITE, outline=OFF_WHITE, radius=16, width=2)
    label(draw, (696, 406), nodes[2], 22 if locale == "fr" else 24, fill=OFF_WHITE, bold=True, anchor="mm", max_width=270, fit_bounds=left, padding=18)
    label(draw, (1046, 406), nodes[3], 22 if locale == "fr" else 24, fill=OFF_WHITE, bold=True, anchor="mm", max_width=290, fit_bounds=right, padding=18)
    label(draw, (877, 530), nodes[4], 18 if locale == "fr" else 20, fill=OFF_WHITE, bold=True, anchor="mm", max_width=340, fit_bounds=config, padding=10)

    rounded(draw, transport, fill=SURFACE, outline=GREEN, radius=16, width=2)
    label(draw, (1474, 408), "FTP / FTPS / SFTP", 20, fill=OFF_WHITE, bold=True, mono=True, anchor="mm", max_width=170, fit_bounds=transport, padding=16)
    rounded(draw, remote, fill=SURFACE, outline=GREEN, radius=16, width=2)
    server_icon(draw, (1730, 338, 1820, 438), OFF_WHITE)
    label(draw, (1775, 470), nodes[5], 20 if locale == "fr" else 22, fill=OFF_WHITE, bold=True, anchor="mm", max_width=150, fit_bounds=(remote[0], 442, remote[2], remote[3]), padding=12)
    return finish(image, (1942, 809))


def render_all():
    for locale in ("en", "fr"):
        banner = render_banner(locale)
        save_png(banner, ASSETS / f"banner-{locale}.png", "banner", locale, COPY[locale])
        architecture = render_architecture(locale)
        architecture_name = "architecture-overview.png" if locale == "en" else "architecture-overview-fr.png"
        save_png(architecture, ASSETS / architecture_name, "architecture-overview", locale, COPY[locale])
        render_flow_assets(locale)
        site = render_site_architecture(locale)
        site_name = "architecture-target.png" if locale == "en" else "architecture-cible.png"
        save_png(site, SITE_ASSETS / site_name, "site-architecture", locale, COPY[locale])


def verify():
    # Re-render all localized layouts in memory. Every constrained label passes
    # through label(..., fit_bounds=...), which asserts its measured glyph box
    # remains inside the intended card/pill with deterministic padding.
    for locale in ("en", "fr"):
        render_banner(locale)
        render_architecture(locale)
        render_site_architecture(locale)
        for frame in (0, 35, 69):
            render_flow(locale, frame=frame)

    direction_copy = ASSETS / "provenance" / "visual-direction-foundation.png"
    assert not direction_copy.exists()
    for provenance_name in ("README.md", "README.fr.md", "visual-system-2026-10-17.md", "visual-system-2026-10-17.fr.md"):
        provenance = (ASSETS / "provenance" / provenance_name).read_text(encoding="utf-8")
        assert "visual-direction-foundation.png" not in provenance

    expected = {
        ASSETS / "banner-en.png": (2103, 748),
        ASSETS / "banner-fr.png": (2103, 748),
        ASSETS / "architecture-overview.png": (1600, 900),
        ASSETS / "architecture-overview-fr.png": (1600, 900),
        ASSETS / "verified-deployment-flow.png": (1200, 675),
        ASSETS / "verified-deployment-flow-fr.png": (1200, 675),
        SITE_ASSETS / "architecture-target.png": (1942, 809),
        SITE_ASSETS / "architecture-cible.png": (1942, 809),
    }
    for path, dimensions in expected.items():
        with Image.open(path) as image:
            assert image.size == dimensions, (path, image.size)
            assert image.info.get("Brand system") == "ftp-deploy-mcp minimal verified-transfer system"
            locale = image.info.get("Locale")
            assert locale in COPY
            assert json.loads(image.info["Exact copy"]) == {key: list(value) if isinstance(value, tuple) else value for key, value in COPY[locale].items()}
            sample = image.convert("RGB").resize((160, 90))
            for red, green, blue in sample.get_flattened_data():
                purple_like = red > 60 and blue > 80 and red > green * 1.2 and blue > green * 1.2
                assert not purple_like, (path, (red, green, blue))
    gif_metrics = {}
    for locale, name in (("en", "verified-deployment-flow.gif"), ("fr", "verified-deployment-flow-fr.gif")):
        path = ASSETS / name
        with Image.open(path) as image:
            first = image.convert("RGB")
            durations = []
            for index in range(image.n_frames):
                image.seek(index)
                durations.append(image.info["duration"])
            last = image.convert("RGB")
            gif_metrics[locale] = (image.n_frames, sum(durations), image.info.get("loop"), path.stat().st_size)
            assert image.size == (1200, 675)
            assert image.n_frames == 70
            assert sum(durations) == 7000
            assert image.info.get("loop") == 0
            assert path.stat().st_size < 900 * 1024
            assert ImageChops.difference(first.crop((0, 0, 1200, 200)), last.crop((0, 0, 1200, 200))).getbbox() is None
            fallback_name = "verified-deployment-flow.png" if locale == "en" else "verified-deployment-flow-fr.png"
            with Image.open(ASSETS / fallback_name) as fallback:
                difference = ImageChops.difference(last, fallback.convert("RGB"))
                assert max(ImageStat.Stat(difference).mean) < 1.5
    assert gif_metrics["en"][:3] == gif_metrics["fr"][:3]

    allowed = {"#08111F", "#101C2C", "#F4F7FB", "#22C7D9", "#34D399"}
    for name in ("logo.svg", "wordmark-light.svg", "wordmark-dark.svg"):
        path = ASSETS / name
        root = ET.parse(path).getroot()
        assert root.get("viewBox")
        for element in root.iter():
            for attribute in ("fill", "stroke"):
                value = element.get(attribute)
                if value and value != "none":
                    assert value in allowed, (path, attribute, value)
            assert not element.tag.endswith("linearGradient")
    print(json.dumps({"png": {str(path.relative_to(ROOT)): size for path, size in expected.items()}, "gif": gif_metrics}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        verify()
    else:
        render_all()
        verify()


if __name__ == "__main__":
    main()
