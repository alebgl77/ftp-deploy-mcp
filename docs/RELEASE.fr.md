# Guide de publication

[English](./RELEASE.md) | **Français**

Voici la liste de contrôle des mainteneurs pour la première publication sur
npm et le registre MCP. Elle distingue l'automatisation du dépôt des opérations
manuelles de compte, de propriété et de registre.

Ce guide prépare la v0.2.0 ; il ne prouve pas sa publication. Les deux workflows
sont manuels (`workflow_dispatch`). Pousser un tag seul ne publie rien.

## Prérequis manuels

Effectuez ces étapes hors du dépôt avant de créer un tag de publication :

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

Consignez qui a satisfait chaque prérequis manuel et à quelle date. Ne créez
pas le tag tant qu'une étape de propriété ou d'identifiants reste non résolue.

## Contrôle des versions et du journal des modifications

Pour une publication v0.2.0 :

1. Réglez `version` dans [package.json](../package.json) et son fichier de
   verrouillage sur `0.2.0`.
2. Réglez la version annoncée par le serveur MCP sur la même valeur. Recherchez
   les chaînes `0.1.0` obsolètes dans les sources et les métadonnées générées ;
   les références historiques attendues du journal sont exclues.
3. À l'approbation finale, remplacez le statut `Release candidate` de la v0.2.0
   dans [CHANGELOG.md](../CHANGELOG.md) et son équivalent `Version candidate`
   dans [CHANGELOG.fr.md](../CHANGELOG.fr.md) par la date effective de
   publication. Tant que la publication reste en attente, conservez ce statut.
4. Confirmez que chaque changement v0.2 visible par l'utilisateur est documenté
   dans [README.md](../README.md) et [README.fr.md](../README.fr.md).
5. Vérifiez que la version inclut le remplacement atomique des nouvelles
   configurations sensibles et teste son chemin d'échec. C'est une condition
   de publication, pas une simple affirmation documentaire.
6. Confirmez que `node src/index.js --version`, les métadonnées du paquet, le
   fichier de verrouillage, le tag, la version npm et la version du registre
   MCP concordent.

Utilisez un commit dédié à la publication. N'étiquetez pas un commit dont le
paquet ou le serveur annonce encore 0.1.0.

## Valider l'archive exacte

Exécutez ces commandes depuis une copie de travail propre du commit à publier (Bash) :

```bash
npm ci --ignore-scripts
npm test
node --test test/release-gates.js
export GITHUB_REF=refs/tags/v0.2.0
node scripts/release-gate.mjs --runtime
release_tmp="$(mktemp -d)"
npm pack --ignore-scripts --json --pack-destination "$release_tmp" > "$release_tmp/release-pack.json"
node scripts/release-artifact.mjs inspect "$release_tmp/release-pack.json"
npm install --prefix "$release_tmp/smoke" --ignore-scripts --omit=dev --no-audit --no-fund "$release_tmp/ftp-deploy-mcp-0.2.0.tgz"
node scripts/release-smoke.mjs "$release_tmp/smoke"
node scripts/release-artifact.mjs check "$release_tmp/release-pack.json.verified.json"
```

Le `GITHUB_REF` local ci-dessus simule le contrôle des métadonnées ; il ne crée
pas de tag et n'autorise aucune publication. Le workflow reçoit sa vraie
référence de GitHub. Le contrôle de l'archive exige la liste exacte de fichiers
autorisés dans `scripts/release-artifact.mjs`, notamment :

- `src/`, la licence, le README et les métadonnées d'exécution requises ;
- l'absence de `ftp-servers.json`, de secrets locaux, d'identifiants de test,
  de fichiers temporaires et d'état réservé aux mainteneurs ;
- une entrée exécutable/bin correcte et aucune dépendance envers des fichiers
  de l'espace de travail non distribués ;
- le nom et la version attendus du paquet.

Le script de vérification utilise uniquement l'installation isolée pour le
serveur et les dépendances du client MCP. Il vérifie `--version`, `--help`,
l'initialisation/version MCP, `ftp_list_servers` et `ftp_deploy` avec
`dry_run: true` sur une configuration réservée aux tests. Il ne se connecte à
aucun serveur FTP/SFTP. Sous Windows, les scripts fonctionnent aussi avec des
dossiers temporaires créés par PowerShell ; utilisez ses syntaxes natives
pour l'environnement et les sorties à la place de la syntaxe Bash ci-dessus.

Le workflow npm crée l'archive une seule fois, valide ses entrées et son
SHA512, teste cette archive, revérifie ses octets et publie le même `.tgz`
avec `--provenance` et les scripts de cycle de vie désactivés. Aucun jeton npm
n'est transmis à l'installation, aux tests, à la création de l'archive ou aux
vérifications. Examinez explicitement les modifications de la liste autorisée
lors de l'ajout de fichiers distribués.

## Publier sur npm

1. Examinez le workflow préparé et confirmez que son déclencheur correspond
   à la politique de tags prévue.
2. Créez un tag annoté dont le nom correspond exactement à la version :
   `git tag -a v0.2.0 -m "v0.2.0"`.
3. Après approbation du mainteneur et préparation des identifiants, poussez le
   commit et le tag. Vérifiez que le workflow figure dans la branche par
   défaut, puis déclenchez-le explicitement sur le tag :

   ```bash
   gh workflow run release.yml --ref v0.2.0
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
npm view ftp-deploy-mcp@0.2.0 name version mcpName dist.integrity
npm view ftp-deploy-mcp@0.2.0 dist.tarball
npx -y ftp-deploy-mcp@0.2.0 --version
```

Comparez l'intégrité et la version du registre avec l'archive validée et le
tag. Ce n'est qu'après réussite de ces contrôles que le README doit présenter
`npx` comme une méthode d'installation actuellement disponible.

Créez la release GitHub depuis le même tag immuable et copiez l'entrée
correspondante du journal. Ne déplacez ni ne réutilisez un tag publié.

## Publier sur le registre MCP

Ne publiez qu'après la réussite du workflow npm et des contrôles de son artefact :

1. Vérifiez `server.json` par rapport au schéma `2025-12-11` ; il doit
   correspondre au tag, aux deux versions du fichier de verrouillage, à la
   version d'exécution, à l'identifiant npm et à `mcpName`.
2. Déclenchez le workflow distinct sur exactement le même tag :

   ```bash
   gh workflow run publish-mcp.yml --ref v0.2.0
   ```

3. Ce workflow relance les contrôles de métadonnées et d'exécution, puis
   vérifie la version npm exacte et `mcpName` dans le registre public **avant**
   l'authentification MCP.
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
