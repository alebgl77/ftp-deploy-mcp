# Carnet d’architecture interactif

Le dossier documente les responsabilités, les flux, les preuves et la feuille de route de `ftp-deploy-mcp`. Il fonctionne hors ligne et ne déclenche aucun appel de déploiement.

## Reconstruction

Depuis la racine du dépôt, avec Node 22 ou 24 :

```sh
node scripts/build-guide.mjs
```

Ouvrir ensuite `site/index.html` directement dans un navigateur (`file://`). Aucun serveur, CDN ou paquet supplémentaire n’est nécessaire. Les liens de sources GitHub nécessitent une connexion lorsqu’ils sont ouverts.

Pour produire aussi une copie autonome à un autre emplacement :

```sh
node scripts/build-guide.mjs --output ./enterprise-guide.html
```

Cette commande reconstruit toujours `site/index.html`, puis écrit la même version à l’emplacement demandé. L’option reçoit un chemin relatif au répertoire courant ou un chemin absolu.

## Fichiers et mise à jour

- `project-data.json` : faits, révision des sources, preuves, lots, scénarios, commits et provenance de l’image. Mettre à jour les compteurs seulement avec les résultats correspondants. Conserver les résultats historiques avec leur périmètre.
- `guide.template.html` : structure éditoriale, styles, diagramme SVG et interactions. Les données affichées sont insérées par `textContent`.
- `assets/architecture-cible.png` : illustration conceptuelle générée avec ChatGPT Image.
- `assets/architecture-cible.prompt.txt` : prompt exact conservé comme provenance. Son contenu est également présent dans les données pour consultation hors ligne.
- `index.html` : fichier généré ; modifier les sources puis reconstruire. Les images PNG et les données JSON y sont embarquées, avec échappement des caractères sensibles du JSON.
- `../scripts/build-guide.mjs` : assemblage déterministe, validation du format des images et de leur emplacement dans `site/assets`.

Les sources internes pointent vers le commit `head` des données. Les entrées d’historique peuvent conserver leur propre commit. Le dossier n’embarque ni configuration d’accès réelle ni secret.

## Utilisation et exports

La navigation, la recherche documentation/roadmap, les filtres de priorité et de statut, le choix actuel/cible, les panneaux de responsabilités, le zoom SVG et les quatre scénarios fonctionnent au clavier et à la souris. Les scénarios sont des séquences pédagogiques, sans réseau ni test exécuté dans la page.

Le dossier exporte le schéma affiché en SVG autonome, l’image en PNG, les données documentaires en JSON et la feuille de route en CSV. L’export JSON conserve la provenance mais omet les octets base64 de l’image. La commande d’impression permet de produire un PDF avec les styles dédiés. Les tables et schémas larges disposent d’un défilement interne sur petit écran.

## Lecture des statuts

`Livré` signifie que les critères du lot et ses preuves sont documentés. `En cours` indique un lot incomplet ; `Prévu` décrit une évolution cible. La barre de progression compte les lots livrés, sans pondération de leur effort et sans promesse de délai.

Le schéma interactif distingue les composants existants des évolutions cibles. L’illustration ChatGPT et les scénarios décrivent l’intention architecturale et ne prouvent aucune fonctionnalité. Une CI réussie ne qualifie pas à elle seule le déploiement autonome en production ou un service multiutilisateur. Les garanties de transfert doivent rester liées aux capacités du protocole et du serveur.
