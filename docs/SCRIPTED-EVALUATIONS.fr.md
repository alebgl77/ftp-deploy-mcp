# Évaluations de conformité MCP scriptées

[English](./SCRIPTED-EVALUATIONS.md) | **Français**

Le dépôt contient 43 scénarios scriptés distincts, exécutés en anglais et en
français avec les véritables `Client`, `McpServer`, `InMemoryTransport` du SDK
MCP et les handlers enregistrés. Une exécution complète produit 86 résultats.
Le stockage distant est un adaptateur instrumenté en mémoire ; les entrées
locales et destinations de téléchargement sont de vrais fichiers dans des
répertoires jetables contrôlés. Aucun service externe, fournisseur, clé API,
connexion FTP/SFTP ou appel payant à un modèle n’est requis.

Il s’agit de conformité serveur, pas d’un benchmark LLM. Chaque rapport porte
`executor: "scripted"`, `agentDecision: "NOT_EVALUATED"` et des valeurs nulles
pour `provider`, `providerUsage` et `tokens`. Le blocage d’une requête dangereuse
ne démontre pas une bonne décision du modèle. Une réussite ne qualifie ni
l’autonomie en production ni la sécurité de façon exhaustive.

## Exécuter depuis un checkout source

Installer les dépendances du dépôt avec `npm ci` sur Node 22 ou 24, puis lancer :

```sh
npm run test:eval-runner
npm run eval:scripted
node scripts/evaluation/validate-report.mjs .tmp/evaluations/reports/latest.json --ci true --locale both
```

Le runner et ses tests sont des outils du dépôt, exclus du paquet npm.
Les [sources du runner](https://github.com/alebgl77/ftp-deploy-mcp/blob/main/scripts/evaluation/run.mjs)
sont disponibles après clonage. Les commandes ne chargent pas votre
configuration de déploiement. Chaque worker reçoit un environnement minimal,
avec home/temp redirigés dans sa fixture, et refuse les tentatives TCP/HTTP/fetch.

La matrice CI OS × Node existante exécute les tests du harnais, la suite bilingue
complète et la validation du rapport dans des étapes obligatoires séparées.
Un résultat Windows local ne prouve pas la réussite d’une future CI sur toutes
les plateformes.

`npm run eval:scripted` active `--ci true`. Ce mode obligatoire accepte seulement
un `PASS` complet : exactement les 43 IDs du manifeste indépendant du runner dans
les deux langues, compteurs recalculés, empreintes stables, nettoyage réussi et
localisation runtime demandée/vérifiée. Une ligne absente, dupliquée ou ajoutée,
`FAIL` et `NOT_RUN` provoquent une sortie non nulle. L’étape de validation passe
aussi explicitement `--ci true --locale both` ; la couverture attendue ne vient
pas du manifeste ou du résumé fournis dans le rapport.

Sans `--ci true`, le validateur contrôle le format pour un usage historique ou
diagnostique. Son message précise que ce n’est pas un verdict de réussite CI ;
un échec bien formé ou un diagnostic incomplet peut passer ce contrôle de format.
Conserver les rapports avec des noms `--output` distincts.

## Chemins de sortie contrôlés et limites

Tous les fichiers générés restent sous `.tmp/evaluations/` dans le checkout
des outils, ignoré par Git. Le rapport par défaut est `reports/latest.json` ;
les fixtures enfants sont créées sous `fixtures/`, puis supprimées après chaque
sortie de processus.

Si le nettoyage ou sa revalidation des chemins échoue, l’exécution échoue avec
`cleanupComplete: false` et le diagnostic générique `FIXTURE_CLEANUP_FAILED`,
sans recopier chemins natifs ni secrets dans le rapport.

`--work-dir` peut choisir un sous-répertoire de cette
racine fixe. `--output` doit finir par `.json` et rester dans le répertoire de
travail sélectionné. Les chemins CLI relatifs partent du répertoire courant.

```sh
node scripts/evaluation/run.mjs --repo . --locale fr --work-dir .tmp/evaluations/review --output .tmp/evaluations/review/reports/fr.json
```

Les sorties lexicales, composants de répertoire liés et fichiers de sortie
symboliques sont refusés. Les fichiers de sortie possédant plusieurs liens
physiques sont aussi refusés. Le harnais contrôle ces frontières avant création
ou écriture, puis avant nettoyage. L’exécuter dans un checkout de confiance ;
ces contrôles n’isolent pas un code arbitraire hostile ou un autre processus
modifiant les chemins simultanément.

| Option | Comportement |
|---|---|
| `--repo <checkout>` | Sources et dépendances installées à évaluer ; ce checkout d’outils par défaut. |
| `--locale en\|fr\|both` | Langue demandée des scénarios et du runtime ; `both` par défaut. |
| `--verify-runtime-locale true\|false` | Comparaison des métadonnées et messages métier échantillonnés aux catalogues ; `true` par défaut. |
| `--ci true\|false` | Exiger la suite bilingue complète et réussie ; `false` en CLI directe, `true` via npm/CI. |
| `--case SCRIPT-001` | Sous-ensemble diagnostique explicite ; jamais une preuve de suite complète. |
| `--case-budget-ms` | 8 000 par défaut ; 100–10 000 autorisés. |
| `--suite-budget-ms` | 180 000 par défaut ; 100–240 000 autorisés. |

Au maximum : 50 scénarios distincts, huit appels par scénario, 128 Kio par
rapport enfant et 4 Mio de fichiers locaux de fixture. Chaque scénario/langue
dispose d’un processus neuf. Le parent arrête les enfants dépassant le budget.
Une assertion ou précondition invalide produit `FAIL` et une sortie non nulle.
Une fixture indisponible est notée `NOT_RUN`, jamais `PASS` ; le mode CI
obligatoire refuse cette exécution incomplète et sort avec un code non nul.
Les délais sont des limites du harnais, pas des objectifs de performance.

## Couverture

Les scénarios couvrent l’inventaire et les schémas ; la sélection de serveur
explicite/par défaut/unique/inconnue ; les configurations absentes, malformées
et partiellement invalides ; les cinq mutateurs distants sous `readOnly` ; le
téléchargement autorisé en lecture seule ; les traversées et protections de
racines locales/distantes ; les liens de répertoires sortants ; la pagination
première/dernière/hors plage ; les limites UTF-8 ; les arguments SDK invalides ;
les quotas de transfert/déploiement ; les exclusions de temporaires réservés ;
le refus d’écrasement ; la dérive source ; le hash de relecture divergent ; les
coupures ; le refus de promotion ; les fichiers vides ; l’envoi/téléchargement
vérifié ; le masquage de secrets ; les exclusions ; la simulation sans adaptateur ;
et le traitement passif d’instructions distantes.

Trois régressions distinctes de confidentialité inspectent les réponses complètes :

- `SCRIPT-041` : mot de passe réutilisé comme valeur invalide de `readOnly`.
- `SCRIPT-042` : JSON malformé dont le diagnostic natif contient un extrait
  sensible contrôlé.
- `SCRIPT-043` : secret contenant guillemet, retour ligne et antislash comme clé
  d’objet dans `readOnly` invalide. Il exige `CONFIG_INVALID`, aucune divulgation
  brute ou JSON échappée, zéro connexion adaptateur et zéro mutation.

Ces cas ont réussi dans les deux langues lors de la qualification locale de
référence des 43 scénarios, sur le runtime committé dans
[`ab9c03a`](https://github.com/alebgl77/ftp-deploy-mcp/commit/ab9c03a71571ce2843f050d7c80eeea7b82ebf96).
Les verdicts actuels appartiennent au rapport généré, pas à ce guide statique.

Les tentatives de méthodes mutatrices et les effets réels sont comptés séparément.
Les transferts positifs vérifient indépendamment les octets stockés ; un refus
ne suffit pas à réussir un envoi positif. La fixture utilise la primitive réelle
de streaming du dépôt sans reproduire les politiques des handlers. Les exclusions
sont testées via `ftp_deploy`, sans inventer une politique commune à `ftp_upload`.

Les trois refus métier de chemin/racine `SCRIPT-017/018/019`, sur arguments
valides selon le schéma, peuvent ouvrir l’adaptateur avant leur contrôle. Ils
exigent zéro méthode mutatrice, zéro effet et un snapshot inchangé, avec
`pre_connection_refusal: false`. Le cas de schéma invalide `SCRIPT-024` conserve
ses exigences strictes de zéro connexion et zéro effet. Les corrections des
attentes initiales sont consignées dans les outils du dépôt.

Le comportement réel FTP/FTPS/SFTP, les certificats TLS et l’authentification par
clé privée relèvent de tests de transport séparés et des
[garanties de transfert](./TRANSFERS.fr.md). La fixture mémoire ne les remplace pas.
L’[évaluation manuelle d’agent en lecture seule](../evaluations/README.fr.md) reste distincte.

## Preuves et vérification des langues

Les rapports consignent les empreintes réelles des sources avant/après exécution,
le commit de base et les modifications Git du périmètre, Node/la plateforme, le
SDK et les empreintes des outils. Une source modifiée invalide l’exécution.
Les dépendances installées sont réutilisées ; ce n’est pas la qualification d’un
artefact reconstruit hermétiquement.

`manifest[].initialStatus` décrit uniquement les définitions. Les verdicts sont
dans `results[].status`. La
[spécification séparée de 48 scénarios](https://github.com/alebgl77/ftp-deploy-mcp/blob/main/test/fixtures/evaluation/corpus.spec.json)
reste inchangée et `NOT_RUN` : variantes complètes, plans persistants, journaux,
idempotence, reprise après redémarrage, rollback, installation d’artefact et 24
cas avec modèle réel ne sont pas déclarés réussis par ces sous-cas scriptés.
Aucun adaptateur fournisseur n’est implémenté.

`scenario_locale` et `requested_locale` ne prouvent pas seuls une sortie traduite.
La vérification compare les dix titres/descriptions et 29 descriptions de champs
au catalogue sélectionné, en conservant les IDs d’outils/champs et enums de
protocole. `runtime_locale_verified` par scénario exige en plus un échantillon
de texte métier. L’indicateur global exige toutes les métadonnées et au moins
deux réussites/deux erreurs par langue. La référence a observé huit réussites
et onze erreurs par langue. Les messages non échantillonnés ne sont pas qualifiés.

## Mesures

| Champ | Observation réelle |
|---|---|
| `listToolsResultJsonBytes` | Octets UTF-8 de `JSON.stringify(listToolsResult)`, séparés des appels. |
| `requestJsonBytes` / `responseJsonBytes` | Paramètres/résultats sérialisés ; les rejets SDK restent des rejets. |
| `wireJsonBytes` / `wireMessages` | Trames SDK en mémoire, négociation/découverte comprises ; recoupent les compteurs de contenu, ne pas les additionner. |
| `transferBytes` | Blocs/tampons de fixture : envoi, téléchargement, vérification et lecture ; pas des paquets réseau. |
| `mutationAttempts` / `effectsCount` | Journal de l’adaptateur distant, distinct des appels scriptés `mcpMutatorCallAttempts`. |
| `connections_opened` | Ouvertures d’adaptateur virtuel, pas connexions réseau physiques. |
| `localAdapterWriteCount` / `localTerminalChangeCount` | Écritures locales de l’adaptateur / écarts entre snapshots finaux, pas chaque appel système. |
| `durationMs` / `processElapsedMs` | Durées monotones réellement mesurées. |

La référence locale a mesuré 27 496 octets de JSON `listTools` en anglais et
28 302 en français avec schémas d’erreur et métadonnées traduites ; le runtime
antérieur `3204c70` mesurait 14 432 par langue. Ce sont des octets, pas des tokens.
Des nombres de cas différents et quelques essais locaux ne démontrent ni gain
de latence ni régression de qualité d’un modèle.

Les rapports omettent identifiants secrets, contenus de fichiers, textes de
réponses, erreurs natives brutes, chemins de fixtures et journaux d’effets bruts.
Ils contiennent des libellés bilingues statiques, IDs, empreintes, assertions
scalaires et mesures agrégées. Une mesure indisponible vaut `null`. Examiner le
périmètre et les assertions individuelles avant d’interpréter le résumé.
