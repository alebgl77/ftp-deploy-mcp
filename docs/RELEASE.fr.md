# Guide de publication

[English](./RELEASE.md) | **Français**

Voici la liste de contrôle des mainteneurs pour la release de sources GitHub
v0.2.1 et, séparément, une future première publication sur npm et le registre
MCP officiel. Une release GitHub ne rend disponibles ni l'identifiant npm, ni
la commande `npx`, ni l'entrée du registre. Le tag et la release GitHub v0.2.0
publiés restent immuables.

Consultez les fichiers sources disponibles sur
[GitHub Releases](https://github.com/alebgl77/ftp-deploy-mcp/releases/latest). Les workflows npm et MCP sont manuels
(`workflow_dispatch`) ; ne les déclenchez pas pour une release GitHub de sources.

Le runtime MCP prend en charge Node.js >=22. L'outillage de publication exige **Node.js 24.20.0 exactement** : création et inspection des archives, inventaires source, contrôles du graphe installé, vérification du registre et `npm run test:release` refusent les autres versions avant ces opérations. Utilisez la distribution Node qualifiée, avec son npm fourni, et consignez les versions Node/libuv/npm/tar avec `node scripts/release-toolchain.mjs`. La qualification du consommateur peut toujours exécuter le serveur MCP avec Node 22 et appeler séparément les outils externes de publication avec Node 24.20.0.

La CI conserve les six jobs runtime (Node 22/24 sur Linux, macOS et Windows). La suite complète de publication s'exécute séparément sur les trois systèmes avec Node 24.20.0. macOS comporte trois passes complètes prédéfinies ; tout échec fait échouer le job. Ces passes de qualification sont fixes, sans relance après échec, cas ignoré ni augmentation des limites d'archive. Les workflows supply-chain et de publication npm/MCP utilisent la même version Node exacte.

## Prérequis manuels

Effectuez ces étapes hors du dépôt avant de déclencher une publication npm ou MCP :

- Confirmez la maîtrise du nom de paquet npm prévu et l'accès du mainteneur au
  compte ou à l'organisation npm.
- Imposez l'authentification à deux facteurs npm et utilisez un compte de
  mainteneur dédié avec les droits minimaux.
- Pour un paquet existant, configurez npm Trusted Publishing pour
  `alebgl77/ftp-deploy-mcp` et le fichier de workflow `release.yml`. Ces
  workflows ne configurent aucun environnement GitHub nommé.
- Pour la **première** publication, npm exige que le paquet existe avant de
  configurer une relation de confiance. Un mainteneur doit créer un jeton
  granulaire de courte durée avec le périmètre de publication minimal
  disponible et l'autorisation non interactive/2FA requise, puis le stocker
  uniquement comme `NPM_TOKEN` dans les secrets GitHub Actions. Après la
  première publication réussie, configurez Trusted Publishing, supprimez ce
  secret et révoquez immédiatement le jeton. Ne le commitez jamais, ne le
  collez pas dans une issue ou une conversation et ne l'affichez pas. Ne
  contournez pas cette procédure avec un jeton permanent. Voir les
  [prérequis de confiance npm](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
  et [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
- Confirmez que le workflow demande la provenance npm et n'a que les
  autorisations nécessaires. L'automatisation du dépôt ne peut ni créer la
  propriété npm ni approuver un nouveau nom de paquet.
- Établissez l'identité de publication et l'espace de noms exigés par le
  registre MCP officiel, puis confirmez l'accès à son outil de publication
  actuel. Un manifeste préparé ou une fiche dans un index tiers ne constitue
  pas une publication sur le registre.
- Confirmez la mise en place des environnements GitHub, des réviseurs requis,
  de la protection des branches et des autorisations de publication.

Consignez qui a satisfait chaque prérequis manuel et à quelle date. Ne lancez
aucune publication npm ou MCP tant qu'une étape de propriété ou d'identifiants
reste non résolue. Ces prérequis de registre ne déterminent pas si une release
de sources GitHub est prête.

## Contrôle des versions et du journal des modifications

Pour la release GitHub v0.2.1 :

1. Réglez `version` dans [package.json](../package.json), les métadonnées racine
   et du paquet racine de `package-lock.json`, ainsi que `server.json`, sur
   `0.2.1`. Le verrouillage source est l'unique fichier de verrouillage de référence ;
   ne conservez pas de `npm-shrinkwrap.json` parallèle.
2. Réglez la version annoncée par le serveur MCP sur la même valeur. Recherchez
   les versions obsolètes dans les sources et les métadonnées générées ;
   les références historiques attendues du journal sont exclues.
3. Utilisez le titre apparié `## [0.2.1] - 2026-09-14` dans
   [CHANGELOG.md](../CHANGELOG.md) et [CHANGELOG.fr.md](../CHANGELOG.fr.md).
   Confirmez la validité calendaire de la date effective, modifiez-la uniquement
   si le jour réel de publication change et conservez tout l'historique 0.2.0.
4. Confirmez que chaque changement du correctif visible par l'utilisateur est documenté
   dans [README.md](../README.md) et [README.fr.md](../README.fr.md).
5. Vérifiez que la version inclut le remplacement atomique des nouvelles
   configurations sensibles et teste son chemin d'échec. C'est une condition
   de publication, pas une simple affirmation documentaire.
6. Confirmez que `node src/index.js --version`, les métadonnées du paquet, le
   verrouillage source et le tag concordent. Vérifiez séparément les versions npm et du
   registre MCP officiel uniquement après leurs publications respectives.

Utilisez un commit dédié à la publication. Ne déplacez et ne réutilisez jamais
le tag v0.2.0 publié.

## Revoir les graphes source et installé

La seule référence source est `package-lock.json`, avec six dépendances directes
épinglées exactement et 112 entrées non racine : 110 de production et deux de
développement. Les installations source/Docker/utilisateur utilisent
`npm ci --omit=dev --ignore-scripts` ; les contributeurs utilisent
`npm ci --ignore-scripts`. Aucun shrinkwrap n'est conservé. npm 12 ne lit et
n'écrit plus ces fichiers, y compris dans les dépendances ; voir la
[documentation officielle npm](https://docs.npmjs.com/cli/v12/configuring-npm/package-lock-json/).

Pour une mise à jour approuvée, changez uniquement les versions exactes prévues
et régénérez le verrouillage source avec les scripts désactivés. Consignez les
versions Node/npm et examinez chaque changement du graphe, URL de registre,
intégrité et contrainte facultative/de plateforme. Gardez l'inventaire source
revu d'origine comme référence ; ne le réécrivez jamais depuis le graphe installé.

Le vérificateur de graphe, limité aux modules intégrés, lit les vrais manifestes
et enregistrements installés, y compris le verrouillage caché s'il existe. Il
résout les dépendances transitives et les peers depuis leurs emplacements réels,
y compris les paquets remontés ou imbriqués. Il refuse les dérives de version,
résolution et intégrité, les paquets supplémentaires, les dépendances obligatoires
absentes et les déclarations modifiées. Les omissions facultatives déclarées et
les paquets de développement prouvés par la source sont rapportés séparément ;
une dépendance facultative présente mais différente n'est pas une omission.
Ce vérificateur n'importe aucun code de dépendance.

## Qualifier l'archive d'installation source

Deux distributions sont définies. `ftp-deploy-mcp-0.2.1-source.tar.gz` contient
82 fichiers ordinaires sous `package/`, dont le verrouillage source. C'est une
archive d'installation, pas le dépôt complet : tests, scripts de maintenance et
guide HTML restent dans le dépôt. Le ZIP/tar automatique de GitHub contient le
dépôt complet. L'archive npm distincte `ftp-deploy-mcp-0.2.1.tgz` contient
81 fichiers, sans fichier de verrouillage.

Capturez les 82 fichiers sources revus avant installation, tests ou création
d'archive. Conservez l'inventaire portable hors du checkout et gardez son SHA256
d'origine indépendamment de toute preuve générée. Le mode source seul qualifie
un candidat avant tag ; la publication exige le vrai checkout propre et suivi
par Git du tag et de l'événement. Avant tag, lancez depuis la copie prévue (Bash) :

```bash
source_root="$(pwd -P)"
release_tmp="$(mktemp -d)"
inventory="$release_tmp/source-inventory.json"
node scripts/release-artifact.mjs snapshot "$inventory" --source-root "$source_root" --source-only
```

Consignez la sortie originale du snapshot dans `inventory_sha256` avant de
continuer. Ne la remplacez jamais par une valeur relue dans une preuve réécrite.

```bash
npm ci --ignore-scripts
npm test
npm run test:release
node scripts/release-gate.mjs --source-only --runtime
node scripts/release-artifact.mjs build-source "$release_tmp/source-pack.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --source-only
node scripts/release-artifact.mjs preflight "$release_tmp/source-pack.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --distribution source
```

Le builder écrit seulement les octets capturés dans un dossier privé et utilise
le vrai tar avec une sortie bornée. Il valide chaque octet avant l'écriture
exclusive de l'archive et des métadonnées. Conservez le chemin canonique
`tarball` et l'intégrité SHA512 `integrity` d'origine du précontrôle dans ces
variables, puis installez dans un dossier neuf :

```bash
mkdir "$release_tmp/consumer"
tar --ignore-zeros -xzf "$tarball" -C "$release_tmp/consumer"
(cd "$release_tmp/consumer/package" && npm ci --omit=dev --ignore-scripts)
node scripts/release-graph.mjs --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --product-root "$release_tmp/consumer/package" --install-root "$release_tmp/consumer/package" --output "$release_tmp/source-graph.json" --source-only
npm audit --prefix "$release_tmp/consumer/package" --omit=dev --audit-level=moderate
node scripts/release-artifact.mjs check "$release_tmp/source-pack.json.verified.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --expected-integrity "$integrity" --expected-tarball "$tarball" --distribution source --source-only
```

Exécutez les cas indépendants du consommateur et des transports, les audits et
les contrôles SBOM de production contre cette installation extraite avant de
l'approuver. Le produit installé n'a pas besoin de `.git` ; sa provenance Git
vient du checkout externe et de l'inventaire original. N'installez jamais le
tar.gz source comme paquet npm. L'utilisateur extrait `package/`, y lance
`npm ci --omit=dev --ignore-scripts`, puis explicitement
`node src/index.js setup`. Les commandes de contribution s'exécutent depuis le
dépôt complet, pas depuis cette archive d'installation.

La preuve lie explicitement la distribution `source` ou `npm`, le nom exact,
le préfixe `package/`, le périmètre, le commit, le SHA256 d'inventaire,
l'intégrité d'origine et le chemin canonique de l'archive. Le contrôleur fournit
le type attendu ; `inspect`/`check` utilisent npm par défaut et refusent une
preuve source. Modifier une preuve ou renommer l'archive ne change pas son type.

## Garder la qualification npm distincte

npm reste non qualifié : un vrai consommateur npm 10.9.8 a changé dix dépendances
de production. Le candidat refusé et ses rapports sont conservés, sans devenir
preuves de la release source ni fichiers joints qualifiés. Un éventuel graphe npm
conforme ne vaudrait que pour l'environnement et la date testés, sans garantir
les futures installations npm. Pour inspecter un candidat npm distinct avec
l'inventaire source original de 82 fichiers :

```bash
npm pack --ignore-scripts --json --pack-destination "$release_tmp" > "$release_tmp/npm-pack.json"
node scripts/release-artifact.mjs preflight "$release_tmp/npm-pack.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --distribution npm
```

L'inspection compare les 81 fichiers npm aux sources ; le verrouillage source
reste une référence externe. Installez ce candidat npm exact dans un préfixe
isolé avec les scripts désactivés, puis lancez `release-graph.mjs` avec
`--product-root` vers `<prefix>/node_modules/ftp-deploy-mcp` et `--install-root`
vers le préfixe. Toute divergence doit bloquer avant les smoke tests, le transfert
d'artefact ou la publication npm/MCP. Un succès limité aux sources n'autorise
jamais une publication dans un registre.

## Limites de validation et de provenance

Les listes fixes excluent configuration locale, identifiants, tests, fichiers
temporaires et état des mainteneurs. Les métadonnées complètes et le verrouillage
source sont validés structurellement ; chaque octet livré doit correspondre à
l'inventaire original. Les commandes de publication reçoivent les vrais
`GITHUB_REF` et `GITHUB_SHA` de GitHub ; HEAD et la cible du tag exact doivent
correspondre à cet événement. N'inventez jamais ce contexte. Utilisez `snapshot`
sans `--source-only`, `inspect` au lieu de `preflight` et `check` sans
`--source-only` uniquement dans ce vrai contexte de publication.

Les octets compressés sont lus une fois sous une borne de 8 MiB et fournissent
le SHA512 d'origine. La décompression gzip stricte intégrée borne la sortie
cumulée à 32 MiB, en-têtes et remplissage TAR compris. `engine.bytesWritten`
doit être un entier dans la longueur d'entrée ; tout octet non consommé doit
être NUL. Le remplissage NUL terminal est admis, toute queue cachée non nulle
est refusée. Chaque appel tar d'inspection reçoit le même TAR brut décodé, sans
`-z`, avec `--ignore-zeros`. L'inspection n'extrait jamais de chemins non fiables
sur disque.

| Limite d'inspection | Maximum |
|---|---|
| Archive compressée | 8 MiB |
| TAR décodé complet, en-têtes et remplissage compris | 32 MiB |
| Chaque fichier attendu ou extrait | 1 MiB |
| Inspection complète | 90 secondes |
| Chaque invocation tar | 15 secondes, ou le budget restant plus court |

Ces limites portent sur les entrées, sorties et durées, pas sur la mémoire exacte.
Le délai est contrôlé avant et après gzip synchrone et ne peut pas l'interrompre.
Un échec de validation ne produit ni nouvelle preuve ni sortie de publication.
Revérifiez l'inventaire original, les octets sources, l'intégrité et le chemin
juste avant publication. Ces contrôles supposent un workflow et un runner de
confiance, pas un runner totalement compromis.

Identité du commit Git, inventaire des octets du checkout et empreinte de l'archive
sont distincts. La conversion CRLF/LF peut produire des inventaires valides
mais différents selon les systèmes. La qualification lie le fichier construit
sous Windows aux octets de son checkout ; les six jobs CI OS/Node qualifient leurs
propres checkouts, pas cette archive Windows sur chaque OS. Après le commit final,
établissez un inventaire portant ce commit et réinspectez les mêmes octets gelés
avant publication. Conservez les preuves avant commit comme historique, sans les
présenter comme le lien au commit final. Sous Windows, utilisez les chemins,
affectations d'environnement et sorties PowerShell au lieu de la syntaxe Bash.

## Séparer qualification et publication

Le job de qualification npm dispose de `contents: read`, sans permission OIDC
ni secret. Il capture l'inventaire des sources avant l'installation, les tests
et la création du paquet, puis installe, teste, audite et qualifie l'archive
exacte et son consommateur. Le job de publication démarre sur un runner frais
après qualification réussie. Les deux copies sont épinglées au `github.sha` de
l'événement ; HEAD et la cible réelle du tag doivent correspondre à ce commit.
Les sorties du build ne peuvent pas choisir le code privilégié.

Seuls le `.tgz`, le JSON de npm pack et l'inventaire des sources passent d'un
job à l'autre, par l'identifiant exact de l'artefact déposé, téléchargé hors de
la copie fraîche. Aucun script, `node_modules`, cache, fichier d'environnement
ou preuve du premier runner n'est transféré. L'inventaire est portable : commit,
identité de release, chemins relatifs, tailles et empreintes des octets. Chaque
commande valide sa propre racine source canonique explicite ; un changement
de racine ne réécrit jamais les octets ni le SHA256 de l'inventaire d'origine.

Les sorties du job de qualification conservent le SHA256 d'origine de
l'inventaire et le SHA512 de l'archive. L'`inspect` privilégié frais doit imposer
cette intégrité attendue face au JSON de npm pack et aux octets compressés avant
de créer une preuve locale ou des sorties. Il lie l'inventaire portable aux
sources fraîches et au nouveau chemin canonique de l'archive téléchargée.
Le `check` final utilise l'empreinte d'origine de l'inventaire et les sorties
intégrité/chemin de l'inspection privilégiée ; npm ne publie que ce chemin vérifié
avec `--provenance` et les scripts de cycle de vie désactivés. La vérification
du registre conserve les mêmes liens d'origine.

L'inspection privilégiée reçoit `SOURCE_INVENTORY_SHA256` et `BUILD_INTEGRITY`
depuis les sorties d'origine du job de qualification :

```bash
node scripts/release-artifact.mjs inspect "$RUNNER_TEMP/release-input/release-pack.json" --source-root "$GITHUB_WORKSPACE" --inventory "$RUNNER_TEMP/release-input/source-inventory.json" --inventory-sha256 "$SOURCE_INVENTORY_SHA256" --expected-integrity "$BUILD_INTEGRITY"
```

La première inspection de qualification émet l'empreinte d'origine de
l'archive ; cette inspection privilégiée fraîche doit l'exiger et ne peut
pas choisir une nouvelle valeur attendue.

Les jobs privilégiés n'exécutent que les validateurs approuvés utilisant les
modules intégrés de Node, la CLI npm ou le publisher MCP épinglé. Ils ne lancent
ni `npm ci`/`npm install`, ni tests du projet, smoke checks du consommateur ou
`--runtime`. `NPM_TOKEN`, si l'amorçage l'exige, n'existe que dans l'étape finale
npm publish. Le workflow MCP suit la même séparation. Son job non privilégié
capture d'abord l'inventaire, puis `fetch-npm` vérifie l'identité et l'intégrité
SHA512 du registre, exige l'URL HTTPS officielle fixe, télécharge sous bornes de
8 MiB et de temps et inspecte les 81 fichiers. Il installe le vrai téléchargement
sans scripts, vérifie le graphe et exécute les contrôles du consommateur. La sortie
du job conserve l'intégrité originale de cette archive qualifiée. Le job privilégié
reçoit cette valeur et la redemande au registre avant toute authentification :

```bash
node scripts/release-artifact.mjs verify-npm --source-root "$GITHUB_WORKSPACE" --expected-integrity "$QUALIFIED_INTEGRITY" --distribution npm
```

La forme autonome de `verify-npm` impose donc aussi l'intégrité attendue. Aucun
fichier de dépendance ni code du premier runner n'est transféré ; seule la copie
fraîche épinglée à l'événement fournit le `server.json` publié.

## Release GitHub et fichiers joints

Après qualification indépendante et revue, utilisez le commit final vérifié,
attendez la CI publique complète sur ce commit, puis créez v0.2.1. Conservez les
octets exacts de `ftp-deploy-mcp-0.2.1-source.tar.gz` validés. Préparez
`SHA256SUMS` pour cette archive, le guide HTML bilingue autonome et les preuves
finales/SBOM ; déposez seulement ces fichiers vérifiés. Publiez des notes EN/FR
fidèles au périmètre source, puis retéléchargez et vérifiez les empreintes.
Consignez commit, tag, date réelle, noms et digests.

Aucun `.tgz` npm ayant dérivé n'est joint. Le ZIP/tar automatique de GitHub
reste le dépôt complet distinct. Les dépôts de fichiers restent en attente avant
vérification ; npm et MCP restent non qualifiés/en attente. Une release source
ne rend disponibles ni npm, ni `npx`, ni le registre MCP officiel.

## Publier sur npm

1. Examinez le workflow préparé et confirmez que son déclencheur correspond
   à la politique de tags prévue.
2. Créez un tag annoté dont le nom correspond exactement à la version :
   `git tag -a v0.2.1 -m "v0.2.1"`. Si la release de sources GitHub a déjà créé
   ce tag, vérifiez et réutilisez sa cible inchangée ; ne le recréez pas.
3. Après approbation du mainteneur et préparation des identifiants, poussez le
   commit et le tag. Vérifiez que le workflow figure dans la branche par
   défaut, puis déclenchez-le explicitement sur le tag :

   ```bash
   gh workflow run release.yml --ref v0.2.1
   ```
4. Exigez la réussite des tests, des contrôles de cohérence des versions, de
   l'inspection de l'archive et de la génération de provenance avant l'étape
   de publication.
5. Attendez la réussite de cette exécution. Sa dernière étape compare le nom
   public npm, la version exacte, `mcpName` et l'intégrité SHA512 à l'archive
   validée. Seules les réponses 404 de propagation sont réessayées (six
   tentatives, délai de cinq secondes, expiration de requête à 15 secondes) ;
   les erreurs d'authentification ou HTTP, les métadonnées invalides et les
   écarts d'intégrité entraînent un refus. Un contrôle en échec après
   publication ne prouve **pas** que la publication npm a échoué : examinez
   d'abord la version exacte et ne republiez pas aveuglément.
6. Pour l'amorçage de la première publication, configurez Trusted Publishing,
   révoquez et supprimez le jeton immédiatement après le succès. Pour les
   versions suivantes, laissez `NPM_TOKEN` absent afin que npm s'authentifie
   via GitHub OIDC. Vérifiez la configuration de confiance avant la prochaine
   publication ; ne republiez pas la même version pour la tester.
7. Vérifiez indépendamment l'artefact public :

```bash
npm view ftp-deploy-mcp@0.2.1 name version mcpName dist.integrity
npm view ftp-deploy-mcp@0.2.1 dist.tarball
npx -y ftp-deploy-mcp@0.2.1 --version
```

Comparez l'intégrité et la version du registre avec l'archive validée et le
tag. Ce n'est qu'après réussite de ces contrôles que le README doit présenter
`npx` comme une méthode d'installation actuellement disponible.

Créez la release GitHub depuis le même tag immuable et copiez l'entrée
correspondante du journal. Ne déplacez ni ne réutilisez un tag publié.

## Publier sur le registre MCP

Cette étape reste en attente. Ne publiez qu'après qualification distincte de npm, y compris le graphe installé. Le workflow MCP retélécharge et requalifie l'archive npm réellement publiée ; une identité seule ne suffit pas :

1. Vérifiez `server.json` par rapport au schéma `2025-12-11` ; il doit
   correspondre au tag, aux versions racine/paquet racine du verrouillage source, à la
   version d'exécution, à l'identifiant npm et à `mcpName`.
2. Déclenchez le workflow distinct sur exactement le même tag :

   ```bash
   gh workflow run publish-mcp.yml --ref v0.2.1
   ```

3. Le job non privilégié qualifie l'archive npm réellement téléchargée et son
   graphe installé. Le job privilégié frais vérifie les métadonnées structurelles,
   la version npm, `mcpName` et l'intégrité qualifiée **avant** l'authentification
   MCP, sans installation de dépendances, tests ni `--runtime`.
4. Il vérifie l'archive épinglée de l'outil officiel de publication, puis
   exécute `mcp-publisher login github-oidc` et `mcp-publisher publish`. GitHub
   OIDC prouve l'espace de noms `io.github.alebgl77/` ; aucun secret MCP dédié
   n'est utilisé. L'outil valide le manifeste pendant la publication. Le
   workflow se déconnecte ensuite. Voir le
   [guide officiel GitHub Actions](https://modelcontextprotocol.io/registry/github-actions)
   et le [démarrage rapide du registre](https://modelcontextprotocol.io/registry/quickstart).
5. Depuis un environnement propre, trouvez l'entrée officielle du registre,
   installez-la selon la méthode documentée, démarrez le serveur et confirmez
   `--version` ainsi qu'un appel MCP `ftp_list_servers`.
6. Vérifiez que les fiches de découverte Glama et MCP Index pointent vers le
   dépôt canonique et la version publiée, mais ne traitez pas ces pages
   tierces comme une vérification du registre.

Le workflow épingle `mcp-publisher` **v1.8.1**, Linux amd64, SHA256 :

```text
a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc
```

Le 2026-09-03, l'archive téléchargée correspondait à l'empreinte renvoyée par
l'[API officielle des releases GitHub](https://api.github.com/repos/modelcontextprotocol/registry/releases/tags/v1.8.1)
pour la [version v1.8.1](https://github.com/modelcontextprotocol/registry/releases/tag/v1.8.1).
Le workflow vérifie ce SHA256 avant d'extraire ou d'exécuter le binaire ; il
ne résout jamais d'URL `latest` mutable. Il s'agit de la vérification d'une
empreinte épinglée, sans affirmation de vérification indépendante d'une
signature Sigstore. Une mise à jour de l'outil exige d'examiner et de
revérifier à la fois la version et l'empreinte.

Si npm a réussi mais que la publication MCP a échoué, corrigez le problème
propre à MCP et relancez uniquement `publish-mcp.yml` sur le tag inchangé.
N'essayez pas de recréer une version npm existante. Le registre MCP est un
service en préversion ; vérifiez son entrée en ligne après publication avant
d'affirmer sa disponibilité.

## Rétablissement et réponse aux incidents

Avant publication, arrêtez le workflow et corrigez le commit de publication.
Si un tag non publié a été poussé, ne le supprimez qu'après confirmation
qu'aucun artefact n'a été créé, puis créez un tag corrigé.

Après publication npm, considérez la version comme immuable :

- arrêtez la publication sur le registre MCP si elle n'a pas encore eu lieu ;
- marquez la version npm défectueuse comme obsolète avec un avertissement précis ;
- corrigez avec une nouvelle version patch et un nouveau tag ;
- n'utilisez npm unpublish que pour une urgence admissible selon la politique
  npm, pas comme mécanisme habituel de retour arrière ;
- n'écrasez, ne déplacez et ne réutilisez jamais un tag ou une version publiés ;
- retirez ou dépréciez la version du registre MCP si le registre le permet,
  puis publiez la version corrective ;
- révoquez tout jeton d'amorçage, renouvelez les identifiants exposés et
  conservez les journaux et valeurs d'intégrité pour l'analyse de l'incident ;
- retirez les annonces de disponibilité du README si les utilisateurs ne
  peuvent plus installer une version sûre.

En cas de problème de sécurité présumé, suspendez la publication et suivez
[SECURITY.fr.md](../SECURITY.fr.md).

## Contrôles après publication

Pour la release source, vérifiez archive, empreintes, graphe source, runtime et
inventaire externe du commit. Exécutez les contrôles de registre suivants seulement
après réussite réelle des publications npm/MCP distinctes.

- Confirmez que la provenance npm est visible et renvoie au dépôt, au
  workflow, au commit et au tag attendus.
- Confirmez que les sources, l'archive, la release GitHub, npm, le `--version`
  du serveur et le registre MCP annoncent tous la même version.
- Testez l'installation depuis les sources, par `npx` à version exacte et
  depuis le registre dans des environnements propres.
- Mettez à jour les avis de disponibilité des deux README et ajoutez la
  méthode `npx` vérifiée.
- N'annoncez que les méthodes d'installation effectivement testées.
- Surveillez les signalements privés de sécurité et les échecs de publication,
  et préparez un correctif plutôt que de modifier l'artefact publié.
