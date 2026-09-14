# Politique de sécurité

[English](./SECURITY.md) | **Français**

## Versions prises en charge

Le projet n'a pas encore achevé sa première publication sur npm ou le registre
MCP. Les correctifs de sécurité visent la branche source actuelle et la dernière
version 0.x étiquetée. Pour les anciens tags 0.x, une mise à niveau peut être
demandée plutôt qu'un rétroportage.

| Version | Prise en charge |
|---|---|
| Sources actuelles / dernier tag 0.x | Prise en charge |
| Anciens tags 0.x | Selon les possibilités |

## Signaler une vulnérabilité en privé

**N'ouvrez pas d'issue, de discussion ou de pull request GitHub publique pour
une vulnérabilité présumée.**

Utilisez le signalement privé de vulnérabilités de GitHub : ouvrez la
[page Security du dépôt](https://github.com/alebgl77/ftp-deploy-mcp/security),
choisissez **Report a vulnerability**, puis indiquez :

- le commit ou la version et le protocole concernés ;
- les étapes minimales de reproduction et la configuration serveur requise ;
- les accès ou divulgations attendus et observés ;
- l'impact, notamment les fichiers locaux ou distants et les identifiants exposés ;
- toute correction suggérée ou échéance de divulgation.

N'incluez pas d'identifiants actifs ni de clés privées. Utilisez des comptes de
test jetables et masquez les informations sensibles dans les journaux. Si le
signalement privé est indisponible, ouvrez une issue publique sans aucun détail
sur la vulnérabilité et demandez au mainteneur d'établir un canal privé.

L'objectif est d'accuser réception d'un rapport complet sous 72 heures, puis
de confirmer son périmètre, coordonner un correctif et ses tests, et convenir
d'une date de divulgation. Il s'agit d'un objectif de réponse, sans promesse
de prime ni de délai de résolution.

## Périmètre

- Accès hors de `localRoot` par traversée, lien symbolique, jonction ou
  traitement de la destination d'un téléchargement.
- Accès SFTP hors de `root`, contournement de la vérification de clé d'hôte ou
  traitement non sûr d'une rotation de clé d'hôte vérifiée.
- Connexion FTP/FTPS à un confinement côté client dont la racine n'est pas `/`
  sans acceptation explicite via `allowUnsafeRemoteRoot`.
- FTP en clair ou FTPS non vérifié sans acceptation explicite via `allowInsecure`.
- Identifiants ou clés exposés dans les résultats d'outils, diagnostics,
  journaux ou erreurs.
- Contournement de `readOnly` ou des protections d'opérations destructives,
  ou succès annoncé à tort après un déploiement partiel.
- Corruption ou remplacement non sûr d'une configuration serveur ou client MCP.
- Archive de publication acceptée malgré une modification des sources livrées,
  du manifeste de dépendances ou du verrouillage source, ou malgré un modificateur de
  dépendances ou un hook d'installation non autorisé.

Les problèmes qui reposent sur un serveur FTP malveillant utilisant des liens
symboliques hors d'une sous-racine configurée côté client sont importants,
mais **leur prévention n'est pas garantie** : FTP/FTPS exigent une frontière
de compte/chroot côté serveur. De même, les contrôles SFTP `realpath`/`lstat`
réduisent les sorties par lien symbolique sans pouvoir supprimer toutes les
courses sur un serveur malveillant. Ces limites sont décrites dans le
[modèle de sécurité](./docs/SECURITY-MODEL.fr.md).

## Intégrité des dépendances et de la publication

Les six dépendances directes de production utilisent des versions exactes.
`package-lock.json` est l'unique référence du graphe source, livrée dans
l'archive d'installation source de 82 fichiers. Utilisez
`npm ci --omit=dev --ignore-scripts` après extraction et conservez ce fichier.
Toute modification exige une revue du graphe complet, de ses URL et intégrités,
puis les contrôles du [guide de publication](./docs/RELEASE.fr.md).

Le paquet npm de 81 fichiers ne contient aucun verrouillage et reste non qualifié.
Une installation réelle a changé dix dépendances de production. Les workflows
refusent toute dérive du graphe installé avant publication npm ou MCP ; une preuve
de type source ne peut pas autoriser npm. Un éventuel graphe npm conforme ne vaut
que pour l'environnement et la date testés, sans garantir les installations futures.

Un audit de dépendances réussi vaut pour ce graphe à cette date ; il ne garantit
pas l'absence d'avis futurs et ne certifie pas un usage en production. Signalez
en privé les contournements du validateur d'archive selon la procédure ci-dessus.
Une release GitHub ne prouve pas la disponibilité sur npm ou le registre MCP
officiel.

## Consignes de recherche

- Testez uniquement les systèmes et comptes qui vous appartiennent ou que
  vous êtes autorisé à évaluer.
- N'accédez pas aux données d'autres utilisateurs, ne dégradez pas le service,
  ne maintenez pas d'accès persistant et n'utilisez pas d'ingénierie sociale.
- Arrêtez-vous une fois le problème démontré et transmettez les détails en privé.
- Laissez au projet un délai raisonnable pour corriger le problème avant sa divulgation.

Les recherches de bonne foi respectant ces consignes sont bienvenues, mais ce
document n'autorise pas les tests contre des services FTP/SFTP tiers.
