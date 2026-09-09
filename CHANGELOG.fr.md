# Journal des modifications

[English](./CHANGELOG.md) | **Français**

Toutes les modifications notables de ce projet sont consignées dans ce fichier.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet suit le [versionnement sémantique](https://semver.org/lang/fr/spec/v2.0.0.html).

## [0.2.0] - 2026-09-09

Le tag et la release GitHub sont créés depuis ce commit. La publication sur npm
et sur le registre MCP reste en attente : `npx -y ftp-deploy-mcp` et
l’installation depuis un registre ne fonctionnent donc pas encore ; installez
depuis les sources. Les métadonnées du paquet et du serveur sont alignées sur
0.2.0. Toutes les modifications ci-dessous sont relatives à 0.1.0, la seule
version jamais publiée.

### Ajouts

- Ligne de commande bilingue. `--lang en` et `--lang fr` (ainsi que
  `--lang=fr`) choisissent la langue des aides générale et par sous-commande,
  des questions et choix de `setup`, des libellés des tests de connexion, des
  diagnostics `doctor`, des avertissements d’`import-filezilla` et des messages
  de démarrage du serveur. La nouvelle variable d’environnement `FTP_MCP_LANG`
  fixe le même défaut, et l’option prime sur elle, y compris sur une valeur
  d’environnement invalide. L’option est lue avant l’analyse de la
  sous-commande et peut figurer avant ou après celle-ci. Seules les valeurs `en`
  et `fr` sont acceptées ; une option invalide ou incomplète provoque une sortie
  en échec avant que `setup` ou `import-filezilla` n’écrive quoi que ce soit.
  Les variables régionales du système, comme `LANG`, ne sont jamais consultées.
  Voir les [langues](./docs/LANGUAGES.fr.md).
- Contrats MCP localisés. Les titres des outils, leurs descriptions, les
  descriptions des champs d’entrée, les textes de succès métier et les messages
  d’erreur suivent la langue choisie. Les dix noms d’outils, les noms des champs
  des résultats structurés et les codes d’erreur publics sont stables et ne sont
  pas traduits, et aucun argument d’outil ne choisit de langue.
- `setup` inscrit `FTP_MCP_LANG` dans les entrées de clients MCP qu’il génère,
  y compris `en`, afin qu’un serveur configuré conserve après redémarrage la
  langue choisie lors de son `setup`. Le bloc Trae prêt à coller porte le même
  réglage.
- Enveloppe d’erreur structurée sur chaque erreur d’outil. À côté du texte
  `isError`, les résultats portent désormais `structuredContent.error` avec
  `schema_version`, `code`, `message`, `retryable`, un UUID `request_id` propre
  à l’appel, `next_action` et `effects`. Les erreurs d’envoi, de téléchargement
  et de déploiement peuvent ajouter un bloc `partial` strict
  (`completed_files`, `completed_bytes`, `failed_files`, `total_files`
  facultatif et `final`). `request_id` n’est pas un identifiant d’opération
  durable ; il n’existe ni journal, ni retour arrière, ni commande de
  récupération. Cette version renvoie `retryable: false` pour toute erreur et ne
  réessaie jamais une mutation incertaine. Voir le
  [contrat d’erreur](./docs/ERROR-CONTRACT.fr.md).
- Six clés de configuration par serveur, chacune avec un défaut et un maximum
  imposés. Les arguments des outils ne peuvent pas les remplacer, et les valeurs
  doivent être des entiers positifs représentables exactement :
  `operationTimeoutMs` (défaut 120000 ms, plage acceptée 100–3600000),
  `maxTransferBytes` (défaut 268435456, maximum 1099511627776),
  `maxDeployFiles` (défaut 10000, maximum 100000),
  `maxDeployBytes` (défaut 1073741824, maximum 1099511627776),
  `maxScanEntries` (défaut 100000, maximum 1000000) et
  `maxScanDepth` (défaut 64, maximum 256). Ces valeurs par défaut s’appliquent
  aux serveurs qui ne les définissent pas : un déploiement qui réussissait en
  0.1.0 peut désormais être refusé par `TRANSFER_LIMIT` ou `SCAN_LIMIT` avant
  même l’ouverture d’une connexion.
  **RUPTURE — `operationTimeoutMs` introduit aussi une échéance que 0.1.0
  n’avait pas :** tout appel d’outil s’interrompt désormais avec `TIMEOUT` après
  120000 ms par défaut et, contrairement aux autres limites, elle se déclenche
  en cours d’exécution au lieu de refuser d’emblée ; un `ftp_deploy` volumineux
  ou lent qui allait au bout en 0.1.0 peut donc s’arrêter en cours de route,
  avec des fichiers déjà promus et aucun retour arrière. Augmentez
  `operationTimeoutMs` (jusqu’à 3600000) pour les liaisons lentes. Voir les
  [transferts vérifiés](./docs/TRANSFERS.fr.md) et les
  [limites de ressources](./docs/RESOURCE-BOUNDS.fr.md).
- Contrôle d’admission à l’échelle du processus. Un isolate Node admet au plus
  64 appels d’outil simultanés ; le 65e renvoie le nouveau `CAPACITY_LIMIT`
  avec `effects:none`, `retryable:false` et `next_action:retry`. C’est un
  plafond de simultanéité, pas un quota de durée de vie : une place est libérée
  quand son worker et son nettoyage se terminent réellement, y compris après une
  annulation ou un dépassement de délai, et il n’existe ni file d’attente ni
  reprise automatique. L’admission suit la validation du schéma et précède la
  préparation.
- Annulation MCP et échéances par appel. Une notification
  `notifications/cancelled` d’un pair interrompt l’opération et le SDK supprime
  sa réponse : les clients ne doivent donc pas attendre la livraison d’une
  enveloppe `CANCELLED` ; l’échéance interne, distincte, renvoie `TIMEOUT`.
  L’annulation et l’expiration arrêtent les étapes suivantes et ferment le
  transport, mais n’annulent pas les effets déjà acceptés par le serveur. Un
  décorateur du transport public corrige la lacune d’annulation du SDK installé
  pour l’identifiant de corrélation numérique `0` et la chaîne vide `""` ; les
  autres identifiants, dont la chaîne `"0"`, conservent le comportement natif du
  SDK.
- Mutations sérialisées. Les outils d’écriture prennent un verrou FIFO sur le
  point d’accès distant (protocole, hôte, port, utilisateur) et `ftp_download`
  en prend un sur la destination locale canonique : deux appels ne peuvent donc
  pas entrelacer leurs écritures sur la même cible. Les verrous sont conservés
  jusqu’à la fin effective du worker sous-jacent, et non jusqu’à l’envoi de la
  réponse, et ils ne coordonnent qu’au sein d’un même processus Node.js.
- Périmètre `localRoot` par serveur pour `ftp_upload`, `ftp_deploy` et
  `ftp_download`. La racine doit être absolue (`~` est étendu) ; les traversées
  et les sorties locales par symlink ou jonction sont refusées.
- Épinglage de clé d’hôte SFTP via `hostKeySha256`, qui accepte une empreinte
  SHA-256 ou un tableau non vide pour les rotations de clé contrôlées.
- Dérogation explicite `allowUnknownHostKey` pour les opérateurs qui acceptent
  temporairement une identité de serveur SFTP non vérifiée.
- Dérogation explicite `allowUnsafeRemoteRoot` pour les opérateurs FTP/FTPS qui
  acceptent le risque de symlink non résolu d’une sous-racine côté client.
- Schémas de sortie MCP et réponses structurées en cas de succès pour tous les
  outils sauf `ftp_read`, volontairement textuel, ainsi que des annotations pour
  les dix outils.
- Ensemble documentaire bilingue, chaque page en anglais et en français :
  [modèle de sécurité](./docs/SECURITY-MODEL.fr.md),
  [processus de publication](./docs/RELEASE.fr.md),
  [contrat d’erreur](./docs/ERROR-CONTRACT.fr.md),
  [langues](./docs/LANGUAGES.fr.md),
  [transferts vérifiés](./docs/TRANSFERS.fr.md),
  [limites de ressources](./docs/RESOURCE-BOUNDS.fr.md),
  [stockage d’état](./docs/STATE-STORAGE.fr.md),
  [modèle de workflow](./docs/WORKFLOW-MODEL.fr.md) et
  [conformité MCP scriptée](./docs/SCRIPTED-EVALUATIONS.fr.md). `CONTRIBUTING`,
  `SECURITY`, `LICENSE` et ce journal reçoivent une contrepartie française, aux
  côtés de la paire `README` déjà livrée en 0.1.0 ; les deux langues du `README`
  ont été réécrites pour cette version.
- Guide HTML interactif bilingue sous `site/`, généré depuis
  `site/project-data.json` et `site/i18n.json` et vérifié en CI par
  `scripts/build-guide.mjs --check`. Il n’existe que dans le dépôt et il est
  exclu du paquet npm.
- Jeu de données externe reproductible pour l’évaluation d’agents en lecture
  seule et jeu d’évaluation MCP de 10 questions, désormais en anglais
  (`evaluations/read-only.xml`) et en français (`evaluations/read-only.fr.xml`),
  ainsi qu’un exécuteur distinct de conformité scriptée couvrant 43 scénarios,
  exécutés dans les deux langues contre le vrai client du SDK MCP et un
  transport en mémoire (`npm run eval:scripted`). Cet exécuteur est un outillage
  du dépôt, n’est pas un benchmark de LLM et est exclu du paquet npm. Voir la
  [conformité MCP scriptée](./docs/SCRIPTED-EVALUATIONS.fr.md).
- Bibliothèques internes inertes `src/state/` et `src/workflow/`. Elles sont
  livrées dans le paquet parce qu’il publie `src`, mais elles n’exposent aucun
  outil MCP, ne lisent aucune configuration, ne créent aucun répertoire d’état
  et ne sont pas importées par le serveur en fonctionnement. Elles ne livrent
  dans cette version ni workflow de déploiement, ni retour arrière, ni
  récupération ; le [stockage d’état](./docs/STATE-STORAGE.fr.md) comme le
  [modèle de workflow](./docs/WORKFLOW-MODEL.fr.md) l’indiquent explicitement.
- Scripts npm destinés aux contributeurs : `test:transports`, `test:contract`,
  `test:bounds`, `test:state`, `test:workflow`, `test:eval-runner` et
  `eval:scripted`. La CI exécute en plus `scripts/check-docs.mjs` pour la
  documentation bilingue et `test/release-gates.js`.
- Métadonnées de registre MCP `server.json`, qui déclarent les variables
  d’environnement `FTP_MCP_CONFIG` et `FTP_MCP_LANG` ainsi qu’un transport
  stdio.
- `Dockerfile` et `.dockerignore` dans le dépôt, construisant une image
  `node:24-alpine` dont le point d’entrée est le serveur stdio ; montez un
  fichier de configuration et faites-y pointer `FTP_MCP_CONFIG`. Aucune image
  n’est publiée, et aucun de ces deux fichiers n’est inclus dans le paquet npm.

### Changements

- **RUPTURE — Node.js 18, 19, 20 et 21 ne sont plus pris en charge.**
  `engines.node` passe de `>=18` à `>=22`. La CI qualifie Node 22 et 24 sur
  Linux, Windows et macOS.
- **RUPTURE — un sélecteur de configuration explicite échoue désormais de façon
  fermée.** Lorsque `--config <chemin>` ou `FTP_MCP_CONFIG` est présent, ce
  chemin unique fait autorité : il doit exister, être un fichier ordinaire et se
  charger correctement, et aucun autre candidat n’est essayé. `--config` prime
  sur `FTP_MCP_CONFIG`, et une valeur explicite vide est rejetée. Ce n’est qu’en
  l’absence des deux que la découverte essaie encore `./ftp-servers.json` puis
  `~/.ftp-mcp/servers.json`. En 0.1.0, ces deux sélecteurs n’étaient que les
  premières entrées d’une liste de repli : un chemin explicite absent ou
  illisible retombait silencieusement sur un autre fichier. Le serveur démarre
  toujours ; chaque outil qui a besoin du fichier de configuration échoue
  désormais avec `CONFIG_INVALID` au lieu de travailler sur une configuration
  non voulue, et `ftp_list_servers` renvoie `status: "invalid"` accompagné du
  diagnostic du chargeur.
- Une entrée de serveur rejetée ne désactive plus tout le fichier de
  configuration. Les entrées sont validées individuellement : les serveurs
  valides restent utilisables, et chaque entrée invalide est signalée par son
  nom et son motif via `ftp_list_servers` (`status`, `valid_count`,
  `invalid_count` et une liste `errors` bornée). Nommer une entrée rejetée
  renvoie le `CONFIG_INVALID` de cette entrée, un nom inconnu renvoie
  `SERVER_UNKNOWN`, et omettre `server` avec plusieurs candidats valides et sans
  `defaultServer` renvoie `SERVER_REQUIRED`. En 0.1.0, la première entrée
  invalide rendait tout le fichier inutilisable et chaque appel d’outil
  échouait. Les problèmes d’enveloppe — objet `servers` absent ou vide,
  `defaultServer` inconnu, `${ENV:VAR}` non défini — rejettent toujours tout le
  fichier, tout comme un fichier dont chaque entrée est invalide.
- **RUPTURE — `localRoot` est désormais obligatoire** pour `ftp_upload`,
  `ftp_deploy` et `ftp_download`, **et les chemins d’outil relatifs se résolvent
  désormais par rapport à lui, et non par rapport au répertoire de travail du
  processus serveur.** Une entrée de serveur sans `localRoot` absolu refuse ces
  trois outils avec `CONFIG_INVALID`. En 0.1.0, `local_path` et `local_dir` se
  résolvaient par rapport à `process.cwd()` : un appel inchangé comme
  `ftp_deploy {"local_dir":"dist"}` lit désormais `<localRoot>/dist` au lieu de
  `<cwd>/dist` — il peut silencieusement sélectionner un autre dossier, ou
  échouer avec `NOT_FOUND` ou `PATH_REJECTED` lorsque l’ancienne cible se trouve
  hors de la racine. Les chemins absolus conservent leur sens et doivent
  toujours se résoudre à l’intérieur de `localRoot`. `ftp_list_servers` indique
  l’état du `localRoot` de chaque serveur.
- Les erreurs d’outil ne sont plus seulement textuelles. Chaque résultat
  d’erreur porte désormais l’enveloppe `{error}` structurée décrite plus haut,
  et les neuf outils dotés d’un schéma de sortie publient un `oneOf` JSON Schema
  draft-07 entre leur objet de succès et cette enveloppe. `ftp_read` conserve un
  succès textuel sans schéma de sortie ; ses erreurs utilisent la même enveloppe
  validée en interne. Les réponses textuelles existantes restent disponibles à
  côté des réponses structurées en cas de succès, et `ftp_deploy` fournit
  toujours des échantillons bornés plutôt que des listes exhaustives de
  fichiers.
- `ftp_upload`, `ftp_deploy` et `ftp_download` vérifient désormais chaque
  fichier avant de le promouvoir. Les envois calculent le SHA256 de la source
  locale, écrivent dans un fichier voisin imprévisible nommé
  `.ftp-mcp-<aléatoire>.tmp`, relisent ce temporaire, comparent le nombre
  d’octets et l’empreinte, puis promeuvent par un unique renommage. En cas
  d’échec, le serveur ne supprime jamais la destination finale pour faire
  réussir la promotion et ne revient jamais à un écrasement direct ; il ne
  supprime que son propre temporaire, et un échec du nettoyage ajoute un
  avertissement borné indiquant qu’un temporaire peut subsister. Les
  téléchargements lisent d’abord une attente SHA256 distante bornée, puis
  promeuvent par lien physique dans le même dossier avec `overwrite:false`
  (valeur par défaut) ou par renommage avec `overwrite:true`. Le motif de nom
  `.ftp-mcp-*.tmp` est réservé et toujours exclu de `ftp_deploy`, même lorsqu’un
  motif `include` explicite le sélectionne. Cela ajoute du trafic réseau et de
  la latence, ne rend pas atomique un déploiement de plusieurs fichiers et ne
  promet pas un remplacement atomique universel : le comportement du renommage
  FTP et SFTP dépend du serveur et de son système de fichiers. En SFTP, le
  serveur enregistre le mode attribué au temporaire, le restreint à 0600 pendant
  l’écriture puis, avant la promotion, restaure les bits de permission de la
  destination existante (masque 0777) ou ce mode de création enregistré pour un
  fichier neuf ; un échec d’un `stat` ou d’un `chmod` requis empêche la
  promotion. FTP/FTPS ne dispose ici d’aucun mécanisme portable de préservation
  des permissions : remplacer un fichier distant existant peut donc
  réinitialiser ses permissions aux valeurs de création du serveur. Localement,
  `ftp_download` copie les bits 0777 d’une destination existante sur son
  temporaire, mais un **nouveau** fichier local est désormais créé avec le mode
  0600 au lieu du défaut issu de l’umask du processus en 0.1.0, et la promotion
  avec `overwrite:false` par défaut exige la prise en charge des liens physiques
  dans le dossier de destination et échoue de façon fermée sans elle. Voir les
  [transferts vérifiés](./docs/TRANSFERS.fr.md).
- La sélection d’un déploiement est désormais bornée et asynchrone.
  `maxScanEntries` et `maxScanDepth` plafonnent les entrées visitées et la
  profondeur des dossiers ; dépasser l’une ou l’autre refuse toute la sélection
  avec `SCAN_LIMIT` (`effects:none`, `retryable:false`, `next_action:fix_input`)
  avant toute connexion distante, en simulation comme en déploiement réel. Voir
  les [limites de ressources](./docs/RESOURCE-BOUNDS.fr.md).
- **La sélection d’un déploiement peut désormais inclure des fichiers qu’elle
  omettait auparavant.** Seuls les noms de dossiers intégrés `node_modules`,
  `.git` et `.ftp-mcp` élaguent le parcours. Les motifs `exclude` personnalisés
  et les motifs `include` n’élaguent plus les dossiers ; ils conservent leurs
  règles de correspondance existantes, fichier par fichier. Cela supprime un
  ancien faux positif de test par sentinelle de dossier où, par exemple,
  `exclude: ["**/__ftp_deploy_probe__"]` masquait aussi `docs/wanted.txt`.
  Examinez une simulation après la mise à niveau si vous dépendez de motifs
  d’exclusion.
- **RUPTURE — le FTP en clair, et le FTPS avec `insecureTLS: true`, sont
  désormais refusés.** 0.1.0 n’avait aucun garde-fou de transport non sécurisé
  et se connectait aux deux sans objection. 0.2.0 lève `TRANSPORT_POLICY` avant
  toute entrée-sortie réseau, sauf si l’entrée de serveur définit
  `allowInsecure: true` : chaque entrée `"protocol": "ftp"` de 0.1.0 — le
  protocole par défaut, celui qui donne son nom à ce paquet — cesse donc de se
  connecter tant que ce drapeau n’est pas ajouté.
- **RUPTURE — les connexions SFTP sans `hostKeySha256` sont refusées** avant
  l’authentification, avec `HOST_KEY_REJECTED`, sauf configuration explicite de
  `allowUnknownHostKey: true`. 0.1.0 n’effectuait aucune vérification de clé
  d’hôte et ne possédait pas ce champ : chaque entrée de serveur SFTP existante
  cesse donc de se connecter tant que l’une des deux clés n’est pas ajoutée.
- **RUPTURE — les connexions FTP/FTPS dont `root` n’est pas `/` sont refusées**
  sauf configuration explicite de `allowUnsafeRemoteRoot: true` ;
  `REMOTE_ROOT_REJECTED` est levé avant toute entrée-sortie réseau. 0.1.0
  acceptait n’importe quel `root` et son propre README recommandait exactement
  ce motif (`"root": "/var/www/site"`) : ces entrées cessent donc de se
  connecter tant que le drapeau n’est pas ajouté. Le périmètre recommandé repose
  désormais sur un compte dédié, chrooté côté serveur, avec `root: "/"`.
- `ftp_deploy` renvoie une erreur MCP dès qu’un transfert échoue et inclut un
  résumé du déploiement partiel, désormais aussi sous forme de compteurs
  `partial` structurés. Les transferts déjà réussis ne sont pas annulés.
- `ftp_list` ne renvoie plus toutes les entrées d’un dossier par défaut. Il
  renvoie les 50 premières avec les métadonnées de pagination ; l’appelant peut
  choisir un décalage et une taille de page comprise entre 1 et 200.
- Les résultats d’outil sont bornés à 25000 octets de `JSON.stringify` UTF-8,
  couvrant le texte comme les données structurées après masquage. Un résultat
  trop volumineux réduit d’abord ses échantillons bornés et reconstruit la
  pagination, puis tronque le plus grand corps de texte avec un marqueur
  `… [output truncated]`, et ne se rabat sur `OUTPUT_LIMIT` que si plus rien ne
  peut être réduit — tout en préservant l’UUID de requête, les effets et les
  compteurs partiels observés. Ce plafond est inférieur à la fenêtre `max_bytes`
  inchangée de `ftp_read` (262144 par défaut, maximum absolu 1048576) : une
  lecture qui renvoyait 256 Kio de contenu en 0.1.0 en renvoie désormais environ
  25 Kio, marqués comme tronqués, dans un résultat réussi.
- Les indicateurs booléens de sécurité et les formats d’empreinte SFTP sont
  validés pour chaque serveur.
- `setup` affiche les acceptations actives de transport non sécurisé ; `doctor`
  affiche les acceptations actives de transport non sécurisé, de clé d’hôte
  inconnue et de racine distante non sûre.
- La documentation distingue désormais l’installation fonctionnelle depuis les
  sources des futures installations via `npx` et le registre MCP.
- Le paquet publié livre désormais aussi `docs/`, `evaluations/`, `server.json`,
  `CONTRIBUTING.md`, `CONTRIBUTING.fr.md`, `SECURITY.md`, `SECURITY.fr.md`,
  `CHANGELOG.fr.md` et `LICENSE.fr.md`. Les descriptions du paquet et de
  `server.json` sont désormais bilingues et décrivent le confinement local et la
  promotion vérifiée.
- Nouvelle dépendance d’exécution `zod-to-json-schema`, utilisée pour publier
  les schémas JSON d’entrée et de sortie des outils.
- Le serveur FTP de test local utilise désormais la dépendance de développement
  `@electerm/ftp-srv`.

### Retraits

- `assets/banner.svg`, `assets/banner.png`, `assets/demo.svg` et
  `assets/diagram.svg`. Les bannières du README sont désormais
  `assets/banner-en.png` et `assets/banner-fr.png`, avec leurs prompts de
  génération et leur provenance consignés sous `assets/provenance/`.
- La dépendance de développement `ftp-srv`, remplacée comme indiqué ci-dessus.

### Corrections

- La saisie manuelle interactive d’un serveur dans `setup` n’écrit plus le
  résultat de l’assistant via une propriété absente.
- Les variantes de casse des noms de protocole ne permettent plus de contourner
  les contrôles de transport non sécurisé sur les chemins de `setup` et de
  diagnostic.
- Les erreurs d’outil conservent les avertissements de sécurité applicables,
  notamment lorsqu’une connexion non sécurisée a pu exposer les identifiants
  avant l’échec.

### Sécurité

- Les transports non sécurisés sont refusés par défaut ; voir l’entrée
  **RUPTURE** de la section *Changements* pour le nouveau garde-fou
  `allowInsecure` et son impact à la mise à niveau. Des avertissements
  accompagnent la découverte, les diagnostics, les succès et les échecs
  impliquant un transport non sécurisé accepté.
- SFTP résout la racine distante configurée et utilise les contrôles
  `realpath`/`lstat` pour refuser les composants symboliques et les chemins
  résolus hors de cette racine. Un serveur malveillant peut encore créer une
  course entre le contrôle et l’usage de cet état. Une connexion SFTP épingle
  aussi sa racine canonique initiale ; un changement de racine constaté renvoie
  `TARGET_CHANGED` et refuse de rebaser un temporaire lui appartenant.
- FTP/FTPS ne présentent plus la normalisation lexicale des chemins comme un
  jail anti-symlink fiable ; l’isolation du compte côté serveur constitue la
  véritable frontière.
- Les sources locales et les destinations de téléchargement sont confinées sous
  `localRoot`.
- Un `setup` non interactif échoue de façon fermée : il signale les transports
  non sécurisés mais n’accorde jamais automatiquement de dérogation
  `allowInsecure`.
- La confidentialité des erreurs est imposée à la frontière des résultats. Les
  objets d’erreur, leurs causes, les piles d’appels, les identifiants et les
  arguments bruts ne sont jamais sérialisés ; les secrets sont masqués dans le
  texte libre ; les identifiants de configuration sont collectés avant
  validation, y compris les valeurs des entrées rejetées et les substitutions
  `${ENV:VAR}` résolues, afin que les diagnostics du chargeur utilisent le même
  masque. Un JSON de configuration mal formé produit un diagnostic de syntaxe
  générique, sans extrait de l’analyseur, et les blocs FileZilla rejetés sont
  identifiés par leur indice numérique, sans reprendre des noms ou des champs de
  protocole non fiables. Des chaînes distantes comme `Page:` et
  `SECURITY WARNING` ne peuvent pas usurper le rendu des avis de confiance.
- Le fichier de verrouillage versionné résout la dépendance transitive `hono` du
  SDK MCP vers la version corrigée 4.13.5.

## [0.1.0] - 2026-07-20

### Ajouts

- Dix outils MCP : `ftp_list_servers`, `ftp_test`, `ftp_list`, `ftp_read`,
  `ftp_upload`, `ftp_deploy`, `ftp_download`, `ftp_mkdir`, `ftp_rename` et
  `ftp_delete`.
- Configuration de plusieurs serveurs FTP, FTPS et SFTP.
- Déploiement récursif de dossiers avec exclusions de type gitignore et simulation.
- Normalisation de la racine distante `root` et mode `readOnly` par serveur.
- Variables `${ENV:VAR}` pour les secrets de configuration.
- Import FileZilla, y compris les sites FTPS implicites.
- Assistant de configuration avec sauvegardes des configurations des clients MCP.
- Diagnostic `doctor` en lecture seule et scripts d'installation depuis les sources.
- Documentation en anglais et en français.
- Tests de bout en bout contre des serveurs FTP et SFTP locaux.
