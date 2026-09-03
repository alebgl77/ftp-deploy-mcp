<div align="center">

<img src="assets/logo.svg" width="96" alt="logo ftp-deploy-mcp">

# ftp-deploy-mcp

**Le bouton déployer pour les agents de codage IA.**

Donnez à Claude Code, Claude Desktop, Cursor, Windsurf, Trae, Antigravity ou
tout client MCP un moyen ciblé de lister, lire, téléverser, télécharger et
déployer des fichiers sur vos propres serveurs FTP, FTPS et SFTP.

*English version → [README.md](./README.md)*

[![CI](https://github.com/alebgl77/ftp-deploy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alebgl77/ftp-deploy-mcp/actions/workflows/ci.yml)
[![Licence : MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![Compatible MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)

<img src="assets/banner.svg" width="100%" alt="bannière ftp-deploy-mcp">

</div>

Des contrôles conçus pour le déploiement gardent les identifiants hors des
réponses d'outils, proposent lecture seule et dry-run, et limitent l'accès aux
fichiers locaux avec `localRoot`. Le dépôt est couvert par une suite e2e
étendue utilisant des serveurs FTP et SFTP locaux. Aucune télémétrie.

> **Disponibilité :** l'installation depuis les sources fonctionne aujourd'hui.
> Le paquet npm et l'entrée du registre MCP ne sont **pas encore publiés** :
> `npx -y ftp-deploy-mcp` et l'installation depuis un registre échoueront
> jusqu'à l'annonce de la première release. Les pages Glama et MCP Index
> existantes sont des fiches de découverte, pas la preuve d'un paquet
> installable. Les métadonnées du paquet et du serveur sont alignées sur la
> release candidate 0.2.0, en attente de publication.

## Première installation depuis les sources

1. Installez Node.js 18 ou plus récent.
2. Lancez `git clone https://github.com/alebgl77/ftp-deploy-mcp.git`, puis
   `cd ftp-deploy-mcp`.
3. Lancez `npm install`.
4. Lancez `npm run setup`, puis modifiez la configuration générée : renseignez
   un `localRoot` absolu, remplacez les identifiants et configurez le pin de clé
   d'hôte SFTP ou les acceptations de risque FTP/FTPS décrites plus bas.
5. Redémarrez le client MCP et essayez un dry-run :

```text
Appelez ftp_deploy avec :
{"server":"prod","local_dir":"dist","remote_dir":"/","dry_run":true}
```

Sous Windows, `install.cmd`, et sous macOS/Linux, `./install.sh`, peuvent
remplacer les étapes 3–4. Relisez chaque serveur généré avant la première
connexion.

## Matrice protocoles et sécurité

| Protocole | Identité du transport | Comportement de la racine distante | Usage recommandé |
|---|---|---|---|
| **SFTP** | Chiffré. `hostKeySha256` est obligatoire sauf si `allowUnknownHostKey: true` accepte explicitement le risque d'usurpation. | Les contrôles `realpath`/`lstat` refusent les composants symboliques et maintiennent les opérations sous `root`. Un serveur malveillant ou changeant peut encore créer une course entre contrôle et usage. | À privilégier, avec empreinte vérifiée hors bande. |
| **FTPS** | Chiffré si le certificat est vérifié. `insecureTLS: true` exige aussi `allowInsecure: true` et supprime la protection MITM. | Une sous-racine côté client n'est pas un jail anti-symlink fiable. Un `root` autre que `/` est refusé sauf `allowUnsafeRemoteRoot: true`. | Utiliser un compte dédié, chrooté côté serveur, dont la racine visible est `/`. |
| **FTP** | En clair. Refusé sauf si `allowInsecure: true` accepte interception et exposition des identifiants. | Même limite que FTPS : la vraie frontière est le compte/chroot serveur, pas le contrôle lexical du client. | Héritage uniquement, réseau de confiance et compte dédié chrooté. |

Les trois protocoles appliquent aussi `localRoot` à `ftp_upload`,
`ftp_deploy` et `ftp_download` afin de limiter les fichiers locaux accessibles
au serveur MCP.

## Ce que vous obtenez

- Dix outils MCP ciblés : découverte et test des serveurs, liste, lecture,
  téléversement, déploiement récursif, téléchargement, création de dossier,
  renommage et suppression.
- Plusieurs serveurs nommés dans une configuration locale.
- Exclusions façon gitignore, dry-run et mode `readOnly` par serveur.
- Import FileZilla, assistant de configuration et commande `doctor` en lecture
  seule.
- Identifiants chargés localement depuis la configuration, l'environnement ou
  des clés SSH, et jamais renvoyés intentionnellement au modèle.

## Configuration des serveurs

La première configuration trouvée est utilisée :

1. `--config <chemin>`
2. `FTP_MCP_CONFIG`
3. `./ftp-servers.json`
4. `~/.ftp-mcp/servers.json`

L'exemple pédagogique ci-dessous contient des commentaires. Un vrai fichier de
configuration doit être du JSON strict ; partez de
[ftp-servers.example.json](./ftp-servers.example.json).

```jsonc
{
  "defaultServer": "prod",
  "servers": {
    "prod": {
      "protocol": "sftp",
      "host": "ssh.example.com",
      "port": 22,
      "user": "deploy",
      "password": "${ENV:PROD_PASSWORD}",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "passphrase": "${ENV:PROD_KEY_PASSPHRASE}",
      "localRoot": "/home/alice/projects/site",
      "root": "/var/www/site",
      "hostKeySha256": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "readOnly": false
    }
  }
}
```

Remplacez l'empreinte composée de `A`, volontairement inutilisable pour un vrai
hôte. Pendant une rotation contrôlée, `hostKeySha256` accepte un tableau :

```json
"hostKeySha256": [
  "SHA256:old_verified_43_character_base64_value_here",
  "SHA256:new_verified_43_character_base64_value_here"
]
```

Ces libellés montrent seulement la forme et ne sont pas des pins valides.
Chaque valeur réelle contient exactement `SHA256:` suivi de 43 caractères
base64 sans remplissage.

### Référence des champs

| Champ | Protocoles | Signification |
|---|---|---|
| `protocol` | tous | Requis : `ftp`, `ftps` ou `sftp`. |
| `host` / `port` / `user` | tous | Hôte, port et compte. Ports par défaut : 21, 990 pour FTPS implicite et 22 pour SFTP. |
| `password` | tous | Mot de passe ou placeholder `${ENV:NOM}`. |
| `privateKeyPath` / `passphrase` | SFTP | Chemin de clé SSH et passphrase optionnelle. `~` est étendu. Ces champs authentifient l'utilisateur, pas le serveur. |
| `localRoot` | tous | Requis pour upload, deploy et download. Doit se résoudre en dossier local absolu existant ; `~` est accepté. Les chemins relatifs et les sorties par lien/jonction sont refusés. Un chemin d'outil absolu doit lui aussi rester à l'intérieur. |
| `root` | tous | Racine distante, `/` par défaut. SFTP utilise realpath/lstat. FTP/FTPS exigent un chroot serveur pour une frontière fiable. |
| `hostKeySha256` | SFTP | Empreinte obligatoire, chaîne ou tableau non vide. Format : `SHA256:<43 caractères base64 sans remplissage>`. Incompatible avec `allowUnknownHostKey`. |
| `allowUnknownHostKey` | SFTP | Dérogation de compatibilité urgente. `true` accepte une identité serveur non vérifiée et affiche un avertissement. |
| `readOnly` | tous | Bloque upload, deploy, mkdir, rename et delete. Le dry-run de deploy reste possible. |
| `implicitTLS` | FTPS | Active TLS implicite, normalement sur le port 990. |
| `insecureTLS` | FTPS | Désactive la vérification du certificat. Exige `allowInsecure: true`. |
| `allowInsecure` | FTP/FTPS | Accepte explicitement FTP en clair ou FTPS non vérifié. Ne sécurise pas la connexion. |
| `allowUnsafeRemoteRoot` | FTP/FTPS | Autorise un `root` autre que `/` malgré le risque de sortie par symlink. À utiliser seulement si la frontière du compte serveur est comprise. |

Toute chaîne peut contenir `${ENV:NOM_DE_VARIABLE}`. Une variable absente
produit une erreur de configuration qui la nomme.

### Vérifier une empreinte SFTP hors bande

Ne faites pas confiance à une empreinte obtenue uniquement via la connexion que
vous cherchez justement à vérifier.

1. Obtenez l'empreinte SHA-256 depuis le panneau authentifié ou le support de
   l'hébergeur, ou auprès d'un administrateur via un canal séparé et
   authentifié.
2. Si vous administrez l'hôte, utilisez sa console de confiance pour lancer par
   exemple
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`.
3. Comparez toute la valeur `SHA256:...` avant de la placer dans
   `hostKeySha256`. `ssh-keyscan` peut collecter une clé candidate, mais ne
   l'authentifie pas à lui seul.

Pour une rotation, vérifiez la nouvelle empreinte hors bande, configurez
temporairement les deux pins, changez la clé serveur, confirmez la connexion,
puis retirez l'ancien pin. N'utilisez pas `allowUnknownHostKey` comme raccourci.

## Référence des outils

Tous les chemins distants sont relatifs au `root` distant. `server` est
optionnel lorsqu'un `defaultServer` est défini ou qu'un seul serveur existe.

| Outil | Paramètres principaux | Rôle |
|---|---|---|
| `ftp_list_servers` | aucun | Affiche les métadonnées et avertissements, jamais les mots de passe. |
| `ftp_test` | `server?` | Se connecte et liste la racine visible. |
| `ftp_list` | `server?`, `path?`, `limit?`, `offset?` | Liste un dossier distant. `limit` vaut 50 par défaut (1–200) ; `offset` vaut 0 par défaut. |
| `ftp_read` | `server?`, `path`, `max_bytes?` | Lit un fichier texte borné ; refuse les binaires. |
| `ftp_upload` | `server?`, `local_path`, `remote_path?` | Envoie un fichier depuis `localRoot`. |
| `ftp_deploy` | `server?`, `local_dir`, `remote_dir?`, `include?`, `exclude?`, `dry_run?` | Déploie récursivement un dossier de `localRoot`. |
| `ftp_download` | `server?`, `remote_path`, `local_path`, `overwrite?` | Télécharge dans `localRoot`. |
| `ftp_mkdir` | `server?`, `path` | Crée un dossier distant récursivement. |
| `ftp_rename` | `server?`, `from_path`, `to_path` | Renomme ou déplace. |
| `ftp_delete` | `server?`, `path`, `recursive?` | Supprime un fichier ou, avec récursion explicite, un dossier. |

### Compatibilité des réponses, pagination et annotations

`ftp_list` renvoie une page plutôt qu'une liste de dossier non bornée. Une
réponse réussie contient les champs de pagination `total`, `count`, `offset`,
`limit`, `has_more` et `next_offset`. Par exemple, la requête
`{"server":"prod","path":"/assets","limit":2,"offset":2}` peut produire
l'extrait volontairement non exhaustif ci-dessous. Il omet les champs requis
`server`, `path` et `security_warning` au premier niveau, ainsi que les champs
requis `size_bytes` et `modified_at` de chaque entrée :

```json
{
  "structuredContent": {
    "entries": [
      { "name": "app.css", "type": "file" },
      { "name": "app.js", "type": "file" }
    ],
    "total": 6,
    "count": 2,
    "offset": 2,
    "limit": 2,
    "has_more": true,
    "next_offset": 4
  }
}
```

Le texte historique, lisible par un humain dans `content`, est conservé pour
compatibilité. En cas de succès, tous les outils sauf `ftp_read` annoncent
aussi un `outputSchema` MCP et renvoient un `structuredContent` correspondant ;
`ftp_read` reste un outil texte borné. Les erreurs d'outil restent des réponses
`isError` avec contenu texte, sans `structuredContent`.

Tous les outils publient des annotations MCP sur leur caractère lecture seule,
destructif, idempotent et ouvert sur l'extérieur. Ces annotations guident les
clients mais ne constituent pas une frontière de sécurité : imposez les accès
avec les identifiants serveur, `readOnly`, `localRoot` et les contrôles de
protocole décrits plus haut. Le résultat structuré de `ftp_deploy` contient un
résumé et des échantillons bornés, pas des listes exhaustives de fichiers.

`ftp_deploy` n'est pas une transaction. Si un ou plusieurs transferts échouent,
l'outil renvoie une erreur MCP avec un résumé du déploiement partiel ; les
fichiers déjà transférés ne sont pas annulés.

Les exclusions par défaut couvrent notamment `node_modules`, `.git`, les
fichiers d'environnement, journaux, métadonnées système, `ftp-servers.json` et
`.ftp-mcp` à toute profondeur.

## Configuration du client

`npm run setup` détecte les clients pris en charge, crée des sauvegardes
horodatées avant de modifier une configuration existante et affiche un bloc
pour les clients configurés par interface. Pour un branchement manuel,
remplacez le chemin par celui, absolu, de ce checkout :

```json
{
  "mcpServers": {
    "ftp": {
      "command": "node",
      "args": ["/chemin/absolu/vers/ftp-deploy-mcp/src/index.js"]
    }
  }
}
```

Les emplacements courants sont `.mcp.json` pour Claude Code,
`~/.cursor/mcp.json` pour Cursor et
`~/.codeium/windsurf/mcp_config.json` pour Windsurf. Claude Desktop et les
autres clients acceptent la même commande et les mêmes arguments dans leurs
réglages MCP.

Après vérification de la première publication npm, cette commande source pourra
être remplacée par `npx -y ftp-deploy-mcp`. Ce n'est volontairement pas présenté
comme une installation fonctionnelle aujourd'hui.

## Import FileZilla et diagnostic

```bash
node src/index.js import-filezilla --file /chemin/sitemanager.xml --out ./ftp-servers.json
npm run doctor
```

L'import peut décoder des mots de passe en clair. Gardez la sortie hors du
contrôle de version, restreignez ses droits, ajoutez `localRoot` et examinez
chaque avertissement de transport ou de racine FTP/FTPS avant la connexion.
`doctor` reste en lecture seule et ne montre pas les mots de passe.

## Migration de v0.1 vers la v0.2 non publiée

Le checkout source contient des travaux v0.2, mais aucun paquet ni registre
v0.2 n'est encore publié.

1. Ajoutez un `localRoot` absolu à tout serveur utilisé pour upload, deploy ou
   download.
2. Pour chaque serveur SFTP, ajoutez un `hostKeySha256` vérifié hors bande.
   `allowUnknownHostKey: true` doit rester une acceptation de risque temporaire
   et explicite ; ne configurez pas les deux champs.
3. Pour FTP/FTPS, préférez un chroot serveur dédié dont la racine visible est
   `/` et posez `root` à `/`. Une sous-racine exige désormais
   `allowUnsafeRemoteRoot: true` et reste vulnérable aux symlinks serveur.
4. Traitez l'échec de `ftp_deploy` comme un déploiement partiel : examinez le
   résumé et réconciliez l'arbre distant avant de relancer.
5. Relancez `npm run setup` ou mettez à jour la commande MCP vers ce checkout,
   puis lancez `npm run doctor` et un dry-run.

Le remplacement atomique des nouvelles configurations sensibles est une
condition de release v0.2, pas une garantie des métadonnées 0.2.0 de cette
release candidate. Consultez [docs/RELEASE.md](./docs/RELEASE.md) avant de créer la
release.

## Sécurité et limites

- La frontière FTP/FTPS la plus forte est l'isolation ou le chroot du compte
  côté serveur. La normalisation client refuse les traversées évidentes, mais
  FTP n'a pas de primitives `REALPATH`/`LSTAT` portables permettant de prouver
  qu'un symlink serveur reste dans une sous-racine.
- SFTP vérifie le pin d'hôte et refuse les composants symboliques via
  `realpath`/`lstat`. Un serveur contrôlé par un attaquant peut encore changer
  son état entre vérification et opération.
- `readOnly` limite les écritures accidentelles via ce serveur MCP ; des droits
  distants réellement en lecture seule restent plus forts.
- FTP, `insecureTLS`, `allowUnknownHostKey` et `allowUnsafeRemoteRoot` sont des
  acceptations explicites de risque, pas des fonctions de sécurité.

Lisez le [modèle de sécurité complet](./docs/SECURITY-MODEL.md) et la
[politique de signalement privé](./SECURITY.md).

## Développement

```bash
npm test
node src/index.js --version
node src/index.js --help
```

La suite de tests utilise des serveurs FTP et SFTP locaux, sans réseau externe.
Les contributions sont bienvenues ; voir
[CONTRIBUTING.md](./CONTRIBUTING.md). Les mainteneurs doivent suivre le
[guide de release](./docs/RELEASE.md). Une évaluation agent reproductible, en
lecture seule et hébergée à l'extérieur, est décrite dans
[evaluations/README.md](./evaluations/README.md).

## Licence

MIT — voir [LICENSE](./LICENSE).
