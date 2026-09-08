# Carnet d’architecture interactif

Français | [English](./README.md)

Ce fichier HTML unique documente l’architecture, les flux, les preuves et la feuille de route de `ftp-deploy-mcp` en français et en anglais. Il fonctionne hors ligne et ne déclenche aucun appel de déploiement.

## Reconstruire et ouvrir

Depuis la racine du dépôt, avec Node 22 ou 24 :

```sh
node scripts/build-guide.mjs
node scripts/build-guide.mjs --output ./enterprise-guide.html
```

Les deux commandes reconstruisent `site/index.html` ; la seconde écrit aussi une copie identique au chemin demandé. Ouvrir le HTML directement dans un navigateur (`file://`). Aucun serveur, CDN ou paquet supplémentaire n’est nécessaire. Les liens GitHub nécessitent une connexion lorsqu’ils sont ouverts.

Pour vérifier la documentation sans reconstruire le HTML suivi :

```sh
node scripts/check-docs.mjs
node scripts/build-guide.mjs --check
node --test test/build-guide.mjs
```

`--check` valide les deux langues et compare le HTML attendu octet par octet à `site/index.html`, sans écrire de fichier. Un fichier absent ou périmé fait échouer le contrôle ; le reconstruire et le relire avant de le committer. Les tests utilisent des fixtures temporaires isolées pour couvrir les divergences de traduction, les données d’injection échappées, le HTML modifié et la reconstruction déterministe. Ces commandes s’exécutent aussi en CI et dans les deux workflows de publication manuels, avant la préparation de l’artefact ou la publication au registre. Seuls Node et le checkout sont nécessaires, sans navigateur ni dépendance supplémentaire.

`check-docs.mjs` découvre les paires Markdown directement à la racine du dépôt, dans `docs`, `evaluations`, `site`, `assets/provenance` et `test/fixtures/transport`. Tout nouveau document dans ces répertoires doit avoir ses deux versions et des liens de langue réciproques. Ajouter tout nouveau répertoire documentaire à la liste explicite du script ; la découverte ne parcourt pas les dépendances ni l’état privé. Le texte anglais canonique `LICENSE` et sa traduction française sont vérifiés séparément.

## Langues et interactions

Choisir **Français** ou **English** dans la navigation. Le français est la langue par défaut. `?lang=en` ou `?lang=fr` sélectionne la langue initiale ; sinon, une préférence mémorisée est utilisée lorsque le stockage du navigateur est disponible. Un échec du stockage n’empêche pas l’utilisation.

Le changement de langue conserve la vue d’architecture, le composant sélectionné, le zoom, le scénario, l’étape, la recherche et les filtres. La recherche porte sur la langue active. Les exports SVG, PNG, JSON et CSV suivent cette langue. Les styles d’impression produisent un PDF dans la langue active. Les prompts d’images originaux sont conservés sans traduction, y compris les libellés cités dans leur langue source.

## Sources et mises à jour

- `project-data.json` : contenus correspondants `locales.fr` et `locales.en`, faits, révision des sources, preuves, lots, scénarios, commits et provenance des images. Actualiser les deux langues ensemble et conserver les résultats historiques avec leur révision initiale.
- `i18n.json` : textes d’interface, libellés accessibles et d’exports correspondants. Les clés de `static` identifient le texte français du template partagé ; les valeurs contiennent chaque traduction. Les entrées `dynamic` utilisent des paramètres nommés.
- `guide.template.html` : une structure, des styles et un moteur de rendu partagés. Les données sont insérées avec `textContent`, sans interprétation de HTML non fiable.
- `assets/architecture-cible.png` et `assets/architecture-target.png` : illustrations conceptuelles française et anglaise ChatGPT Image, toutes deux embarquées.
- `assets/architecture-cible.prompt.txt` et `assets/architecture-target.prompt.txt` : prompts originaux exacts, également copiés dans les données pour consulter leur provenance hors ligne.
- `index.html` : fichier généré. Modifier les sources puis reconstruire ; le JSON échappé et les PNG base64 sont embarqués.
- `../scripts/build-guide.mjs` : assemblage déterministe. Traductions absentes, clés/longueurs divergentes, identifiants/statuts/faits numériques différents, paramètres incompatibles, textes statiques non traduits et chemins/signatures d’images invalides font échouer le build. La prose nécessite toujours une revue éditoriale bilingue.

Les liens internes utilisent le commit `head` des données ; l’historique conserve ses propres révisions. Les noms d’API, chemins et identifiants ne sont pas traduits. Aucune configuration d’accès réelle ni aucun secret n’est embarqué. L’export JSON omet les octets base64 des images mais conserve provenance et libellés de statuts localisés.

## Lire les preuves

**Livré** signifie que les critères et preuves du lot sont documentés. **En cours** indique un travail incomplet ; **Prévu** décrit une évolution cible. La progression compte les lots livrés, sans pondération de leur effort ni promesse de date.

Les scénarios sont pédagogiques et ne sont pas des tests exécutés. Les illustrations cibles n’ont pas valeur de preuve fonctionnelle. Une CI réussie ne qualifie pas à elle seule le déploiement autonome en production ou un service multiutilisateur. Les garanties de transfert dépendent du protocole/serveur ; les verrous locaux au processus ne démontrent pas une exclusion multiprocessus.
