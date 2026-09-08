# Journal des modifications

[English](./CHANGELOG.md) | **Français**

Toutes les modifications notables de ce projet sont consignées dans ce fichier.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet suit le [versionnement sémantique](https://semver.org/lang/fr/spec/v2.0.0.html).

## [0.2.0] - Version candidate (2026-09-03)

Cette version est préparée et attend sa publication sur npm et le registre MCP.
Les métadonnées du paquet et du serveur sont alignées sur 0.2.0.

### Ajouts

- Périmètre `localRoot` par serveur pour `ftp_upload`, `ftp_deploy` et
  `ftp_download`. La racine doit être absolue (`~` est développé) ; les
  traversées et les sorties par lien symbolique ou jonction locale sont refusées.
- Épinglage de clé d'hôte SFTP via `hostKeySha256`, qui accepte une empreinte
  SHA-256 ou un tableau non vide pour les rotations de clé contrôlées.
- Dérogation explicite `allowUnknownHostKey` pour les opérateurs qui acceptent
  temporairement une identité de serveur SFTP non vérifiée.
- Dérogation explicite `allowUnsafeRemoteRoot` pour les opérateurs FTP/FTPS qui
  acceptent le risque résiduel de lien symbolique dans une sous-racine côté client.
- [Modèle de sécurité](./docs/SECURITY-MODEL.fr.md) et
  [liste de contrôle de première publication](./docs/RELEASE.fr.md) dédiés.
- Schémas de sortie MCP et réponses structurées en cas de succès pour tous les
  outils sauf `ftp_read`, volontairement textuel, et annotations pour tous les outils.
- Jeu de données externe reproductible pour l'évaluation d'agents en lecture
  seule et jeu d'évaluation MCP de 10 questions.

### Changements

- Les connexions SFTP sans `hostKeySha256` sont refusées avant
  l'authentification, sauf configuration explicite de `allowUnknownHostKey: true`.
- Les connexions FTP/FTPS dont `root` n'est pas `/` sont refusées sauf
  configuration explicite de `allowUnsafeRemoteRoot: true`. Le périmètre
  recommandé repose désormais sur un compte dédié, chrooté côté serveur,
  avec `root: "/"`.
- `ftp_deploy` renvoie une erreur MCP dès qu'un transfert échoue et inclut un
  résumé du déploiement partiel. Les transferts déjà réussis ne sont pas annulés.
- `ftp_list` ne renvoie plus toutes les entrées d'un dossier par défaut. Il
  renvoie les 50 premières avec les métadonnées de pagination ; l'appelant peut
  choisir un décalage et une taille de page comprise entre 1 et 200.
- Les réponses textuelles existantes restent disponibles avec les réponses
  structurées en cas de succès. Les erreurs d'outil restent des résultats
  `isError` textuels, et `ftp_deploy` fournit des échantillons bornés plutôt
  que des listes exhaustives de fichiers.
- Les indicateurs booléens de sécurité et les formats d'empreinte SFTP sont
  validés pour chaque serveur.
- La configuration et le diagnostic affichent les acceptations actives de
  transport non sécurisé, de clé d'hôte inconnue et de racine distante non sûre.
- La documentation distingue désormais l'installation fonctionnelle depuis
  les sources des futures installations via `npx` et le registre MCP.

### Sécurité

- FTP en clair et FTPS avec `insecureTLS: true` restent refusés sauf si le
  serveur définit explicitement `allowInsecure: true`. Des avertissements
  accompagnent la découverte, les diagnostics, les succès et les échecs
  impliquant un transport non sécurisé accepté.
- SFTP résout la racine distante configurée et utilise `realpath`/`lstat` pour
  refuser les composants symboliques et les chemins résolus hors de cette
  racine. Un serveur malveillant peut encore modifier son état entre la
  validation et l'opération.
- FTP/FTPS ne présentent plus la normalisation lexicale des chemins comme un
  confinement fiable contre les liens symboliques ; l'isolation du compte
  côté serveur constitue la véritable frontière.
- Les sources locales et les destinations de téléchargement sont limitées à
  `localRoot`.
- La configuration non interactive continue de refuser les situations non
  sûres plutôt que d'accorder automatiquement des exceptions de transport.

### Corrections

- La saisie manuelle interactive d'un serveur dans `setup` n'écrit plus le
  résultat de l'assistant via une propriété absente.
- Les variantes de casse des noms de protocole ne permettent plus de
  contourner les contrôles de transport non sécurisé pendant la configuration
  et le diagnostic.
- Les erreurs d'outil conservent les avertissements de sécurité applicables,
  notamment lorsqu'une connexion non sécurisée a pu exposer les identifiants
  avant l'échec.

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
