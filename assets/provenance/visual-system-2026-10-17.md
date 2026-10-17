# Minimal visual system provenance — 2026-10-17

**English** | [Français](./visual-system-2026-10-17.fr.md)

## Scope

This record covers the logo, both wordmarks, both 2103 × 748 banners, both
1600 × 900 architecture diagrams, both 1200 × 675 flow fallbacks and GIFs,
and the paired 1942 × 809 site architecture images.

## Brand invariants

- Concept: verified transfer under local control.
- Mark: an abstract open gate crossed by a forward path that resolves into a
  verification tick; it is intentionally neither a padlock nor a shield.
- Palette only: graphite `#08111F`, surface `#101C2C`, off-white `#F4F7FB`,
  cyan `#22C7D9`, and validation green `#34D399`.
- System sans-serif typography; monospace is reserved for protocol names.
- Flat 2D geometry, 12–16 px radii, 2 px outlines, and generous whitespace.
- No gradients, purple, 3D, glass, glow, neon, cinematic scenes, serif type,
  fake UI, or tiny decorative detail.

## ChatGPT Image direction foundation

Mode: built-in `image_gen` tool, not the CLI/API fallback.

Generated with the built-in ChatGPT Image tool; native output kept outside the
repository and intentionally not committed.

Exact prompt:

```text
Use case: logo-brand
Asset type: text-free visual direction board for a developer-tool identity system
Primary request: create one original, minimal flat 2D direction board exploring a coherent “verified transfer / local control” identity. The hero motif is an abstract gate crossed by a forward-moving path that resolves into a compact verification tick, without resembling a padlock or shield.
Scene/backdrop: clean off-white design-board canvas with generous negative space; a few large isolated geometric compositions only
Subject: variations of the same gate + forward path + validation motif, plus simple supporting flow-line and rounded-panel shapes suitable for documentation banners and architecture diagrams
Style/medium: precise flat vector-like geometric graphic design, Swiss-modern developer tooling, sans-serif-era minimalism, strong silhouette, 2 px-equivalent strokes, 12–16 px-equivalent corner radii
Composition/framing: wide landscape direction board; large motifs, clear spacing, no mockup devices, no small UI components
Color palette: use only graphite #08111F, surface navy #101C2C, off-white #F4F7FB, cyan #22C7D9, validation green #34D399
Text: none
Constraints: absolutely no words, letters, numbers, logos, trademarks, watermarks, gradients, purple, 3D, glass, glow, neon, shadows, cinematic lighting, serif typography, padlocks, shields, fake UI, or tiny decorative detail. Flat solid fills only; every form must feel reproducible as deterministic SVG.
Avoid: generic cybersecurity symbolism, badges, mascots, stock icon style, pseudo-writing, texture, perspective, depth.
```

The board informed the open-gate/forward-path motif only. Final deliverables do
not reuse its pixels; they were redrawn with exact geometry and copy.

## Deterministic production

Run:

```powershell
python scripts\visuals\render_brand_assets.py
python scripts\visuals\render_brand_assets.py --verify
```

The renderer uses Segoe UI, Segoe UI Bold, and Cascadia Mono through Pillow at
2× resolution before LANCZOS downsampling. Logo and wordmarks remain editable
SVG. Each GIF contains 70 frames at 100 ms per frame: 7.0 seconds at 10 fps,
infinite loop. English and French share geometry, frame count, timing, and loop
behavior. Only progress and active/completed state styling changes. The final
frame is also the static reduced-motion PNG fallback.

These images are documentation aids, not security certification or proof of
behavior for a particular deployment target.
