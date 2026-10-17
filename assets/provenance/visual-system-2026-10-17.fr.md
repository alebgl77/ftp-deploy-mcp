# Provenance du système visuel minimal — 2026-10-17

[English](./visual-system-2026-10-17.md) | **Français**

## Périmètre

Ce relevé couvre le logo, les deux signatures, les deux bannières de
2103 × 748, les deux schémas d’architecture de 1600 × 900, les deux images de
repli et GIF de flux de 1200 × 675, ainsi que les deux architectures du site de
1942 × 809.

## Invariants de marque

- Concept : transfert vérifié sous contrôle local.
- Symbole : un passage ouvert abstrait traversé par une trajectoire vers
  l’avant qui se résout en validation ; ce n’est ni un cadenas ni un bouclier.
- Palette unique : graphite `#08111F`, surface `#101C2C`, blanc cassé
  `#F4F7FB`, cyan `#22C7D9` et vert de validation `#34D399`.
- Typographie sans-serif système ; monospace réservé aux protocoles.
- Géométrie 2D à plat, rayons de 12–16 px, contours de 2 px et grands espaces.
- Aucun dégradé, violet, effet 3D, verre, halo, néon, scène cinématique, serif,
  fausse interface ou micro-détail décoratif.

## Fondation de direction ChatGPT Image

Mode : outil `image_gen` intégré, et non la solution de repli CLI/API.

Généré avec l’outil ChatGPT Image intégré ; la sortie native est conservée hors
du dépôt et volontairement non versionnée.

Prompt exact, conservé sans traduction :

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

La planche a uniquement guidé le motif passage ouvert/trajectoire. Les pixels ne
sont pas repris dans les livrables finaux, redessinés avec géométrie et textes
exacts.

## Production déterministe

Exécuter :

```powershell
python scripts\visuals\render_brand_assets.py
python scripts\visuals\render_brand_assets.py --verify
```

Le moteur utilise Segoe UI, Segoe UI Bold et Cascadia Mono via Pillow, avec un
rendu en résolution 2× puis un rééchantillonnage LANCZOS. Le logo et les
signatures restent des SVG éditables. Chaque GIF contient 70 images de 100 ms :
7,0 secondes à 10 fps, en boucle infinie. Les versions anglaise et française
partagent géométrie, nombre d’images, durée et boucle. Seuls la progression et
l’état actif/terminé évoluent. La dernière image sert aussi de PNG de repli pour
le mouvement réduit.

Ces images sont des aides documentaires, et non une certification de sécurité
ou une preuve du comportement d’une cible de déploiement particulière.
