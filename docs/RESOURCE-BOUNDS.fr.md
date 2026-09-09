# Limites du parcours local et de l’admission des appels

[English](./RESOURCE-BOUNDS.md)

## Sélection d’un déploiement

Chaque serveur configuré possède deux politiques facultatives, qui doivent être
des entiers positifs représentables sans perte. Les arguments des outils ne
peuvent modifier aucune de ces politiques.

| Champ | Défaut | Maximum |
| --- | ---: | ---: |
| `maxScanEntries` | 100000 entrées visitées | 1000000 |
| `maxScanDepth` | 64 niveaux de dossiers sous la racine | 256 |

La racine compte pour une entrée visitée, à la profondeur zéro. Chaque entrée
découverte compte une fois : dossiers, fichiers exclus et liens symboliques
compris. La descente ne compte pas le dossier une seconde fois. Atteindre
exactement une limite est accepté ; l’entrée suivante refuse toute la sélection
avec `SCAN_LIMIT`. La profondeur est inclusive : les fichiers d’un dossier au
niveau configuré restent éligibles, mais un sous-dossier non élagué est refusé
avant son ouverture. Un sous-arbre élagué ne nécessite aucune descente et ses
descendants non découverts ne sont pas comptés.

`maxDeployFiles` borne séparément les fichiers sélectionnés dès leur accumulation.
Les contrôles existants d’octets par fichier et par déploiement restent actifs.
Un échec de sélection précède toute connexion ou mutation distante, en simulation
comme en déploiement réel. `SCAN_LIMIT` renvoie `effects:none`, `retryable:false`
et `next_action:fix_input`.

Le parcours lit les dossiers séquentiellement avec `opendir` asynchrone, un tampon
de 32 entrées par handle et au plus `maxScanDepth + 1` handles ouverts. Il vérifie
l’annulation et le délai autour des lectures, puis rend la main à la boucle
événementielle toutes les 256 entrées découvertes. Toutes les fermetures sont
attendues, même après échec ou annulation. Un appel au système de fichiers ou une
fermeture lente peut encore dépasser le délai réel ; une réponse anticipée de
dépassement de délai ne signifie pas que le nettoyage est terminé.

Seules les exclusions intégrées prouvées des sous-arbres `node_modules`, `.git`
et `.ftp-mcp` permettent l’élagage. Les exclusions personnalisées et les motifs
d’inclusion ne l’autorisent jamais ; leurs règles existantes restent appliquées
à chaque fichier. Cela corrige un ancien test par sentinelle qui produisait des
faux positifs : `exclude:["**/__ftp_deploy_probe__"]` ne masque plus
`docs/wanted.txt`. Certains fichiers omis à tort peuvent désormais apparaître
dans la sélection. Examinez une simulation après avoir changé les exclusions.

Les liens symboliques rencontrés sont ignorés. Les contrôles lexicaux et
canoniques de `localRoot` et la nouvelle validation des sources à l’envoi restent
actifs. Ils ne suppriment pas les courses malveillantes sur les chemins causées
par un autre programme exécuté sous le même compte système.

## Admission des appels d’outil

Un isolate Node admet au plus 64 appels d’outil pour tous les registres partageant
le module d’admission. Il n’existe ni file d’admission supplémentaire ni reprise
automatique. Un outil inconnu conserve l’erreur de protocole `-32602` ; des
arguments invalides conservent `INVALID_ARGUMENT`. Une requête déjà annulée ne
lance aucune préparation ni aucun handler. L’admission suit la validation du
schéma et précède la préparation.

Le 65e appel renvoie `CAPACITY_LIMIT`, `effects:none`, `retryable:false` et
`next_action:retry`. Réessayez explicitement après la fin effective d’un appel
actif. Chaque appel conserve sa place pendant la préparation, l’exécution et le
nettoyage, y compris lorsqu’une entrée-sortie non coopérative se termine après
une annulation ou un dépassement de délai. Les verrous FIFO existants par cible
sont inchangés ; leurs appels en attente occupent aussi une place d’admission.
Les identifiants de corrélation, dont `0` numérique, `""`, `1` numérique et `"0"`
texte, conservent leur comportement de transport.

Ces limites ne coordonnent pas les processus, isolates ou hôtes distincts. Elles
ne bornent ni les tampons d’entrée du transport ni l’analyse des requêtes refusées.
Les limites du parcours local ne bornent pas le tampon distant sous-jacent de
`list()` ; la sortie MCP paginée conserve l’implémentation de liste existante.
