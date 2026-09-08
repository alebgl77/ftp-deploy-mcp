# Évaluation d'agents en lecture seule

[English](./README.md) | **Français**

Ce dossier contient une évaluation MCP reproductible de 10 questions portant
sur les quatre outils en lecture seule : `ftp_list_servers`, `ftp_test`,
`ftp_list` et `ftp_read`. Il ne contient pas de moteur d'exécution, n'installe
aucune dépendance et n'effectue lui-même aucune configuration.

## Préparer des serveurs jetables

1. Créez un compte FTP vide et jetable ainsi qu'un compte SFTP vide et
   jetable. Chaque compte doit exposer sa racine configurée comme `/`.
2. Copiez manuellement le contenu de [`fixture/`](./fixture/) dans la racine
   visible vide de chaque compte. Copiez le contenu, pas le dossier `fixture`
   lui-même : les deux racines doivent contenir directement `README.txt`,
   `catalog/` et `reports/`.
3. Gardez ces deux copies inchangées pendant l'évaluation. Les questions ne
   dépendent pas de l'ordre des dossiers ; les assertions de liste utilisent
   des ensembles d'entrées, des nombres ou des métadonnées de pagination.

Réservez FTP à un service de test jetable accessible uniquement sur la boucle
locale, avec un chroot dédié côté serveur. Sa racine visible et le `root`
configuré doivent tous deux être `/`. `allowInsecure: true` n'est acceptable
ici que parce que le service est jetable et limité à la boucle locale ; ne
réutilisez pas cette exception pour un hôte distant.

Pour SFTP, obtenez l'empreinte SHA-256 de clé d'hôte depuis la console de
confiance du serveur jetable ou un autre canal authentifié. Vérifiez-la hors
bande, puis fournissez-la via `EVAL_SFTP_HOST_KEY_SHA256`. N'inventez pas
d'empreinte et ne l'obtenez pas uniquement par la connexion évaluée.

## Configurer le serveur MCP

Créez une configuration JSON stricte en dehors de ce jeu de données et faites
pointer `FTP_MCP_CONFIG` vers elle. Fournissez les valeurs de connexion par
variables d'environnement ; ne placez pas de véritables identifiants dans ce
dépôt. Remplacez l'exemple de `localRoot` par un dossier absolu existant sur
la machine exécutant le serveur MCP. L'évaluation est en lecture seule, mais
un `localRoot` absolu garde la configuration conforme au modèle de sécurité
habituel.

```json
{
  "servers": {
    "eval-ftp": {
      "protocol": "ftp",
      "host": "${ENV:EVAL_FTP_HOST}",
      "user": "${ENV:EVAL_FTP_USER}",
      "password": "${ENV:EVAL_FTP_PASSWORD}",
      "localRoot": "/absolute/path/to/empty-eval-local-root",
      "root": "/",
      "allowInsecure": true,
      "readOnly": true
    },
    "eval-sftp": {
      "protocol": "sftp",
      "host": "${ENV:EVAL_SFTP_HOST}",
      "user": "${ENV:EVAL_SFTP_USER}",
      "password": "${ENV:EVAL_SFTP_PASSWORD}",
      "localRoot": "/absolute/path/to/empty-eval-local-root",
      "root": "/",
      "hostKeySha256": "${ENV:EVAL_SFTP_HOST_KEY_SHA256}",
      "readOnly": true
    }
  }
}
```

Définissez `EVAL_FTP_HOST` sur l'adresse de boucle locale du service FTP
jetable. L'extrait utilise les ports FTP et SFTP par défaut ; ajoutez des
valeurs numériques `port` si les services jetables utilisent d'autres ports.
Les noms des deux serveurs doivent rester exactement `eval-ftp` et
`eval-sftp`, et les deux doivent contenir des octets de fixture identiques.

## Exécuter l'évaluation

Démarrez un client MCP ou un banc d'évaluation sur stdio avec
`node src/index.js`, la configuration externe sélectionnée par `FTP_MCP_CONFIG`
et [`read-only.fr.xml`](./read-only.fr.xml) comme entrée d'évaluation. La
[version anglaise](./read-only.xml) contient les mêmes questions et réponses
attendues. Le banc d'évaluation doit autoriser uniquement les quatre outils
nommés ci-dessus. Comparez ses réponses finales avec chaque élément `answer` ;
ne comparez pas l'ordre des listes serveur, la latence de connexion ou les
horodatages.

Ces évaluations par LLM ne sont pas exécutées en CI. Elles exigent des
services FTP et SFTP gérés à l'extérieur ainsi qu'un client ou banc MCP
capable d'utiliser un modèle. Aucun score n'est revendiqué dans ce dépôt.
