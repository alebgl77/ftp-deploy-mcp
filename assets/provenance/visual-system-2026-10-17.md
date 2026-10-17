# Visual system provenance — 2026-10-17

**English** | [Français](./visual-system-2026-10-17.fr.md)

## Scope

This record covers:

- `assets/architecture-overview.png` — 1600 × 900 static architecture overview.
- `assets/verified-deployment-flow.gif` — 1200 × 675 animated verified-deployment flow.
- `assets/verified-deployment-flow.png` — 1200 × 675 completed-state reduced-motion fallback.

The visual system uses an original, text-free ChatGPT Image foundation with deterministic labels, arrows, state overlays, and animation added locally. No external logos, trademarks, or stock assets were used.

## Generation mode and source files

Mode: built-in `image_gen` tool (not the CLI/API fallback).

Generated source files retained by the built-in tool:

- Architecture foundation: `C:\Users\alexa\.codex\generated_images\01a14ae0-4cd7-7f71-b0e8-1112438fe78c\exec-0c3cf216-642d-4fe7-b815-fc422b4d5f44.png`
- Flow foundation: `C:\Users\alexa\.codex\generated_images\01a14ae0-4cd7-7f71-b0e8-1112438fe78c\exec-ee21bffb-f14f-4ff7-ac6e-59fe0b12db79.png`

Both generated sources were 1680 × 945 PNG images. They were copied into the repository's ignored `.tmp/visual-assets/` workspace for local rendering; generated originals were left in place.

## Final architecture prompt

```text
Use case: infographic-diagram
Asset type: GitHub README architecture overview foundation, 16:9 landscape
Primary request: create an original, polished modern enterprise systems-diagram background for a secure file deployment architecture. This is a TEXT-FREE visual foundation; all labels and arrows will be added later with deterministic typography.
Scene/backdrop: sophisticated deep navy technical workspace with a very subtle perspective grid, understated circuit traces, restrained atmospheric glow, and generous negative space
Subject: a clear left-to-right systems architecture made of blank glass-and-metal modules: one compact source terminal card on the left, one prominent policy shield/gate module just left of center, four coordinated blank process modules arranged through the center, and three destination server/storage modules grouped on the right. Include a discreet safety/rollback loop motif beneath the central process area. Keep every card interior empty enough for later labels.
Style/medium: premium modern Visio-like schematic fused with elegant 3D isometric product illustration; crisp geometry, subtle depth, glass layers, refined edge lighting; professional developer-tool documentation
Composition/framing: strict 16:9 wide canvas; balanced left-to-right flow; large clean margins; modules aligned on a clear horizontal rhythm; central process region visually dominant; no cropping
Lighting/mood: precise, trustworthy, controlled; soft cinematic rim light without drama
Color palette: deep navy and blue-black base, electric cyan source accents, restrained violet process accents, emerald verification/success accents; white highlights used sparingly
Materials/textures: smoked glass, anodized metal, faint translucent panels, subtle luminous conduits
Constraints: absolutely no text, no letters, no numbers, no symbols resembling text, no logos, no trademarks, no watermark; blank panels only; no human figures; avoid tiny decorative clutter; make the generated art itself visibly rich and dimensional while leaving room for overlay labels and arrows
Avoid: stock clip-art, flat placeholder rectangles, busy HUD clutter, neon overload, fantasy sci-fi, illegible pseudo-writing
```

## Final flow prompt

```text
Use case: productivity-visual
Asset type: GitHub README animated verified-deployment workflow foundation, 16:9 landscape
Primary request: create an original, polished TEXT-FREE visual foundation for a six-stage secure deployment pipeline that will be animated later. All labels, arrows, status lights, and progress effects will be added deterministically.
Scene/backdrop: sophisticated deep navy technical canvas with a faint perspective grid, subtle circuit traces, restrained depth haze, and elegant glass layers
Subject: six equally spaced blank premium process modules across one horizontal line, connected by a clean dormant conduit; each module has a large empty face for a later short label and a small empty lower status area. Beneath them, include one clearly separated low-profile rollback safety rail that curves back toward the start, plus a small blank safety checkpoint module. The completed path should visually terminate in a calm emerald destination glow on the right.
Style/medium: modern enterprise workflow schematic, premium Visio-like clarity with refined isometric 3D product-illustration depth; crisp geometry; documentation-grade polish
Composition/framing: strict 16:9 landscape; six modules centered with generous outer margins and even spacing; no cropped modules; strong left-to-right rhythm; ample clear space above and below for deterministic overlay text
Lighting/mood: trustworthy, controlled, precise, calm
Color palette: deep navy and blue-black, restrained electric cyan, violet, and emerald accents; dormant modules mostly cool slate with subtle violet edges
Materials/textures: smoked glass, anodized metal, translucent conduits, fine luminous edge details
Constraints: absolutely no text, no letters, no numbers, no logos, no trademarks, no watermark; no arrows with embedded text; blank panels only; no human figures; no tiny decorative clutter; preserve large readable module faces; visually rich generated art, not flat placeholder boxes
Avoid: pseudo-writing, busy HUD clutter, neon overload, fantasy sci-fi, high-frequency bright patterns, flashing implications, stock clip-art
```

## Deterministic overlay method

Rendering used Python 3.13 with Pillow 12.2.0. The generated foundations were center-cropped only if needed, then resized with `Image.Resampling.LANCZOS`.

Fonts:

- Titles, section headings, stage names: Segoe UI Bold, `C:\Windows\Fonts\segoeuib.ttf`.
- Supporting copy: Segoe UI, `C:\Windows\Fonts\segoeui.ttf`.
- Status labels and technical captions: Cascadia Mono, `C:\Windows\Fonts\CascadiaMono.ttf`.

Palette accents were electric cyan `(41, 211, 255)`, violet `(155, 107, 255)`, and emerald `(35, 233, 174)` on translucent navy panels. Text was drawn with a two-pixel dark stroke for contrast. Glow lines used an 8–13 px source line with a 9–15 px Gaussian blur plus a crisp 4–5 px center line.

Architecture overlay parameters:

- Canvas: 1600 × 900.
- Central stage boxes `(x1, y1, x2, y2)`: `PLAN (529,342,707,494)`, `APPLY (723,342,899,494)`, `VERIFY (916,342,1094,494)`, `ROLLBACK (1115,342,1293,494)`.
- Primary flow baseline: `y=421`; arrow endpoints follow the generated conduits.
- Exact protocol labels: `FTP`, `FTPS`, `SFTP`.
- PNG export: RGB → indexed PNG, `colors=256`, `Image.Quantize.MEDIANCUT`, `Image.Dither.FLOYDSTEINBERG`, `optimize=True`, `compress_level=9`.

Flow overlay and timing parameters:

- Canvas: 1200 × 675.
- Stage centers: `[139, 313, 484, 642, 809, 974]`; stage panel y-range `218..309`.
- Exact stage sequence: `SCAN`, `PLAN`, `APPROVE`, `TRANSFER`, `VERIFY`, `PROMOTE`.
- Key states: baseline plus one active frame per stage plus completed frame: `[-1, 0, 1, 2, 3, 4, 5, 6]`.
- Requested key-state durations: `[0.8, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 2.2]` seconds. The concat tail adds two 0.1 s completed-state samples for a measured 6.8 s loop and a completed-state hold longer than 2.2 s.
- Static fallback: the same deterministic `progress=6` composition used for the final animation state, exported with the same 256-color PNG settings.

Local render command:

```powershell
python .tmp\visual-assets\render_visuals.py
```

GIF encoding command (FFmpeg 9.0.2):

```powershell
ffmpeg -y -f concat -safe 0 -i frames.concat.txt -filter_complex "[0:v]fps=10,split[v0][v1];[v0]palettegen=max_colors=128:reserve_transparent=0:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 "..\..\assets\verified-deployment-flow.gif"
```

This produces a 10 fps, 128-color, infinitely looping GIF. Motion is progressive and low frequency: one stage changes every 0.6 s, with no strobing or rapid luminance inversion.

## Interpretation note

These illustrations explain the intended architecture and deployment flow. They are documentation aids, not independent security certification, penetration-test evidence, or a guarantee of the behavior of any particular deployment target.
