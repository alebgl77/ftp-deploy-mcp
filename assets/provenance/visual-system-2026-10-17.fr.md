# Provenance du système visuel — 2026-10-17

[English](./visual-system-2026-10-17.md) | **Français**

## Périmètre

Ce relevé couvre :

- `assets/architecture-overview.png` — vue d’ensemble statique de l’architecture de 1600 × 900.
- `assets/verified-deployment-flow.gif` — flux animé de déploiement vérifié de 1200 × 675.
- `assets/verified-deployment-flow.png` — image de repli en état terminé et à mouvement réduit de 1200 × 675.

Le système visuel utilise une base originale et sans texte créée avec ChatGPT Image, à laquelle des libellés, des flèches, des superpositions d’état et une animation déterministes ont été ajoutés localement. Aucun logo externe, aucune marque commerciale et aucune ressource de stock n’ont été utilisés.

## Mode de génération et fichiers sources

Mode : outil `image_gen` intégré (et non la solution de repli CLI/API).

Fichiers sources générés et conservés par l’outil intégré :

- Base de l’architecture : `C:\Users\alexa\.codex\generated_images\01a14ae0-4cd7-7f71-b0e8-1112438fe78c\exec-0c3cf216-642d-4fe7-b815-fc422b4d5f44.png`
- Base du flux : `C:\Users\alexa\.codex\generated_images\01a14ae0-4cd7-7f71-b0e8-1112438fe78c\exec-ee21bffb-f14f-4ff7-ac6e-59fe0b12db79.png`

Les deux sources générées étaient des images PNG de 1680 × 945. Elles ont été copiées dans l’espace de travail ignoré `.tmp/visual-assets/` du dépôt pour le rendu local ; les originaux générés sont restés à leur emplacement.

## Prompt final de l’architecture

Pour garantir la traçabilité, le prompt anglais est consigné ci-dessous verbatim, exactement tel qu’il a été utilisé.

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

## Prompt final du flux

Pour garantir la traçabilité, le prompt anglais est consigné ci-dessous verbatim, exactement tel qu’il a été utilisé.

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

## Méthode de superposition déterministe

Le rendu a utilisé Python 3.13 avec Pillow 12.2.0. Les bases générées ont été recadrées au centre uniquement si nécessaire, puis redimensionnées avec `Image.Resampling.LANCZOS`.

Polices :

- Titres, en-têtes de section et noms des étapes : Segoe UI Bold, `C:\Windows\Fonts\segoeuib.ttf`.
- Texte d’accompagnement : Segoe UI, `C:\Windows\Fonts\segoeui.ttf`.
- Libellés d’état et légendes techniques : Cascadia Mono, `C:\Windows\Fonts\CascadiaMono.ttf`.

Les couleurs d’accentuation de la palette étaient le cyan électrique `(41, 211, 255)`, le violet `(155, 107, 255)` et l’émeraude `(35, 233, 174)` sur des panneaux bleu marine translucides. Le texte a été tracé avec un contour sombre de deux pixels pour assurer le contraste. Les lignes lumineuses utilisaient une ligne source de 8–13 px avec un flou gaussien de 9–15 px, ainsi qu’une ligne centrale nette de 4–5 px.

Paramètres de superposition de l’architecture :

- Canevas : 1600 × 900.
- Boîtes des étapes centrales `(x1, y1, x2, y2)` : `PLAN (529,342,707,494)`, `APPLY (723,342,899,494)`, `VERIFY (916,342,1094,494)`, `ROLLBACK (1115,342,1293,494)`.
- Ligne de base du flux principal : `y=421` ; les extrémités des flèches suivent les conduits générés.
- Libellés exacts des protocoles : `FTP`, `FTPS`, `SFTP`.
- Export PNG : RGB → PNG indexé, `colors=256`, `Image.Quantize.MEDIANCUT`, `Image.Dither.FLOYDSTEINBERG`, `optimize=True`, `compress_level=9`.

Paramètres de superposition et de temporisation du flux :

- Canevas : 1200 × 675.
- Centres des étapes : `[139, 313, 484, 642, 809, 974]` ; plage y des panneaux d’étape `218..309`.
- Séquence exacte des étapes : `SCAN`, `PLAN`, `APPROVE`, `TRANSFER`, `VERIFY`, `PROMOTE`.
- États clés : état initial, puis une image active par étape, puis l’image terminée : `[-1, 0, 1, 2, 3, 4, 5, 6]`.
- Durées demandées des états clés : `[0.8, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 2.2]` secondes. La fin de la concaténation ajoute deux échantillons de l’état terminé de 0.1 s, pour une boucle mesurée à 6.8 s et un maintien de l’état terminé supérieur à 2.2 s.
- Image de repli statique : la même composition déterministe `progress=6` utilisée pour l’état final de l’animation, exportée avec les mêmes réglages PNG à 256 couleurs.

Commande de rendu local :

```powershell
python .tmp\visual-assets\render_visuals.py
```

Commande d’encodage du GIF (FFmpeg 9.0.2) :

```powershell
ffmpeg -y -f concat -safe 0 -i frames.concat.txt -filter_complex "[0:v]fps=10,split[v0][v1];[v0]palettegen=max_colors=128:reserve_transparent=0:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 "..\..\assets\verified-deployment-flow.gif"
```

Cette commande produit un GIF à 10 fps, en 128 couleurs et en boucle infinie. Le mouvement est progressif et de basse fréquence : une étape change toutes les 0.6 s, sans effet stroboscopique ni inversion rapide de luminance.

## Note d’interprétation

Ces illustrations expliquent l’architecture et le flux de déploiement prévus. Elles constituent des aides documentaires, et non une certification de sécurité indépendante, une preuve de test d’intrusion ou une garantie du comportement d’une cible de déploiement particulière.
