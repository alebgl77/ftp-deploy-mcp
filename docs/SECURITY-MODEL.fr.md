# Modèle de sécurité

[English](./SECURITY-MODEL.md) | **Français**

Ce document décrit ce que protège ftp-deploy-mcp, ses hypothèses et les cas où
les opérateurs doivent fournir des contrôles plus forts. Il s'applique aux
sources v0.2 non publiées ; vérifiez les notes de version de l'artefact exact
que vous exécutez.

## Éléments sensibles et frontières de confiance

Le projet traite quatre domaines sensibles :

1. les identifiants locaux et les chemins des clés privées SSH ;
2. les fichiers locaux accessibles par téléversement, déploiement et téléchargement ;
3. les fichiers distants accessibles via un compte configuré ;
4. les configurations des clients et du serveur MCP écrites par l'assistant.

Le client MCP et le modèle peuvent demander toute opération exposée par les
outils. Traitez-les comme un opérateur disposant des droits des comptes
configurés, soumis à `localRoot`, aux contrôles des chemins distants, à
`readOnly` et aux paramètres destructifs explicites. Un compte utilisateur
local compromis, une dépendance modifiée, un client MCP malveillant ou des
identifiants disposant de droits serveur plus larges dépassent ce que ces
contrôles applicatifs peuvent contenir de façon fiable.

Le service distant est supposé implémenter son protocole honnêtement. SFTP
ajoute des contrôles d'identité et de système de fichiers, mais un serveur
authentifié hostile peut encore modifier l'état des fichiers entre deux
étapes. FTP et FTPS n'exposent pas les primitives portables nécessaires pour
prouver qu'une sous-racine côté client ne permet aucune sortie par lien
symbolique.

## Tableau des contrôles

| Contrôle | Protège contre | Ne protège pas contre |
|---|---|---|
| `localRoot` | Traversées locales et sorties par lien symbolique/jonction lors des téléversements, déploiements et téléchargements. | Compte local compromis ou fichiers légitimement présents dans la racine. |
| SFTP `hostKeySha256` | Connexion à un serveur SFTP présentant une clé d'hôte inattendue. | Serveur compromis possédant la clé attendue, ou empreinte obtenue via le canal attaqué. |
| Contrôles SFTP realpath/lstat | Composants symboliques distants connus et chemins résolus hors de `root`. | Ensemble des courses entre contrôle et usage sur un serveur malveillant ou modifié simultanément. |
| Politique FTP/FTPS `root: "/"` | Présentation d'un sous-dossier côté client comme un confinement de sécurité démontré. | Sortie d'un compte que le serveur FTP lui-même n'a pas isolé. |
| `readOnly` | Écritures demandées via ce serveur MCP. | Autres clients utilisant les mêmes identifiants, ou identifiants serveur conservant le droit d'écriture. |
| Condition `allowInsecure` | Usage accidentel de FTP en clair ou de FTPS sans vérification du certificat. | Interception après acceptation du risque par l'opérateur. |
| `dry_run` | Aperçu de la sélection de déploiement sans transfert de fichiers. | Modifications effectuées par un autre processus après l'aperçu. |
| Masquage des identifiants | Renvoi intentionnel des mots de passe, phrases secrètes ou clés privées configurés dans les sorties d'outils. | Secrets contenus dans un fichier distant lu, dépendance compromise, inspection mémoire ou journaux non sûrs de l'opérateur. |

## Périmètre du système de fichiers local

Tout serveur utilisé avec `ftp_upload`, `ftp_deploy` ou `ftp_download` doit
définir `localRoot`. Cette valeur doit se résoudre en dossier absolu existant ;
`~` est développé avant le contrôle du chemin absolu.

Les chemins relatifs des outils sont résolus sous ce dossier. Les chemins
absolus ne sont acceptés que s'ils y restent. Les sources de téléversement et
de déploiement existantes sont résolues en chemins réels et refusées si un
lien symbolique ou une jonction sort de la racine. Les destinations de
téléchargement sont vérifiées composant par composant pour qu'un lien
symbolique ou une jonction existants ne redirigent pas l'écriture.

Il s'agit d'une limitation des chemins au moindre privilège, pas d'un bac à
sable du système d'exploitation. Utilisez un compte système dédié ou un
conteneur lorsque le client MCP lui-même n'est pas digne de confiance.

## Identité du serveur SFTP et chemins distants

Les connexions SFTP exigent `hostKeySha256` sous forme d'empreinte unique ou
de tableau non vide. Une empreinte est `SHA256:` suivi de l'encodage base64
sans remplissage, sur 43 caractères, du condensat SHA-256 de 32 octets de la
clé d'hôte. Clés d'authentification utilisateur et clés d'hôte répondent à
deux besoins distincts : la clé privée authentifie le client auprès du
serveur ; l'empreinte de clé d'hôte authentifie le serveur auprès du client.

Obtenez l'empreinte depuis un panneau d'hébergement authentifié, une console
serveur de confiance ou un administrateur via un canal séparément
authentifié. Une valeur observée uniquement par `ssh-keyscan` sur le même
réseau est une candidate, pas une vérification hors bande.

Pour une rotation planifiée :

1. vérifiez l'empreinte de la nouvelle clé hors bande ;
2. ajoutez-la avec l'ancienne dans le tableau d'empreintes ;
3. remplacez la clé serveur et testez la connexion ;
4. retirez l'ancienne empreinte une fois le déploiement terminé.

`allowUnknownHostKey: true` désactive la vérification de l'identité serveur
et ne doit pas être combiné à `hostKeySha256`. C'est une acceptation visible
et explicite du risque d'usurpation, pas un mécanisme de mémorisation de la
confiance au premier usage.

Pour les chemins distants, SFTP résout la racine configurée et vérifie les
composants avec realpath/lstat en refusant les liens symboliques. Ces
contrôles renforcent sensiblement le périmètre par rapport à FTP, mais ne
rendent pas atomiques plusieurs échanges réseau. Un serveur malveillant ou
modifié simultanément peut changer un objet entre un contrôle et l'opération
qui suit.

## Racines distantes FTP et FTPS

FTP n'a pas d'équivalent portable aux contrôles SFTP realpath/lstat. Normaliser
`..` et joindre les chemins sous un sous-dossier configuré détecte les
traversées lexicales, mais ne permet pas de déterminer si un composant côté
serveur est un lien symbolique pointant ailleurs.

Par conséquent :

- la frontière fiable est un compte dédié isolé ou chrooté par le serveur FTP ;
- la racine visible de ce compte doit être la racine de déploiement souhaitée ;
- configurez le `root` MCP sur `/` ;
- une racine FTP/FTPS différente de `/` est refusée sauf si
  `allowUnsafeRemoteRoot: true` accepte explicitement le risque résiduel.

FTPS ne protège la confidentialité du transport que si la vérification du
certificat réussit. `insecureTLS: true` exige `allowInsecure: true` et rend la
connexion vulnérable à l'usurpation. FTP en clair exige toujours
`allowInsecure: true` et expose les identifiants et le contenu au réseau.

## Écritures, suppression et déploiement partiel

`readOnly: true` bloque téléversement, déploiement, mkdir, rename et delete
via le serveur MCP. Préférez des identifiants également limités à la lecture
côté service distant. La suppression récursive exige un argument explicite,
et la suppression de la racine configurée est refusée.

Un déploiement n'est pas une transaction. Si un transfert échoue, `ftp_deploy`
renvoie une erreur MCP et un résumé du déploiement partiel. Les fichiers
promus plus tôt dans le même appel restent sur le serveur. Les opérateurs
doivent examiner et réconcilier l'état distant avant de réessayer.

Les envois et déploiements utilisent une promotion vérifiée depuis un
temporaire : hash de la source, envoi borné vers un voisin imprévisible,
relecture du nombre d'octets et du SHA256, puis un renommage vers le chemin
final. Un échec de vérification laisse la cible précédente intacte du fait de
cet outil ; un échec de renommage ne déclenche jamais sa suppression ni un
repli vers un écrasement direct. Les téléchargements vérifient également un
temporaire local exclusif et borné, puis le synchronisent avant promotion.
Par défaut, `overwrite:false` crée un lien physique sans écrasement et refuse
la promotion si cette primitive n'est pas prise en charge. Le nettoyage vise
uniquement le temporaire possédé et peut le laisser sur place ; un changement
connu de racine canonique SFTP interdit de reporter le nettoyage sous la nouvelle.

Le remplacement local et SFTP conserve les bits de droits (0777) d'une cible
régulière existante, selon la sémantique native du système de fichiers. SFTP
vérifie le mode 0600 sur le handle exact du temporaire avant toute écriture
de contenu, puis restaure les droits de la destination ou le mode de création
serveur relevé avant promotion. FTP/FTPS ne conserve pas ces bits de façon
portable : un fichier privé ou exécutable peut prendre les droits de création
par défaut du serveur. Adaptez le compte, l'umask et les ACL. Ces contrôles de
contenu ne conservent pas le propriétaire, les ACL, les horodatages, les bits
spéciaux ni les relations de liens physiques.

Les limites par serveur valent par défaut 256 Mio par fichier, 10000 fichiers
sélectionnés et 1 Gio cumulé d'octets sources par déploiement. Les octets réels
des flux sont contrôlés ; les tentatives échouées conservent leur réservation.
Des quotas distincts de parcours asynchrone valent par défaut 100000 entrées
visitées et une profondeur de dossiers de 64. Au plus 64 appels admis conservent
leur place pendant le nettoyage. Ces politiques ne bornent ni le temps réel
strict d’un appel au système de fichiers ni le tampon distant sous-jacent de
`list()` ; voir les [limites de ressources](./RESOURCE-BOUNDS.fr.md). Le nom réservé `.ftp-mcp-*.tmp` est exclu du déploiement,
y compris lorsqu'un motif `include` explicite le sélectionne. Voir
[TRANSFERS.fr.md](./TRANSFERS.fr.md) pour les bornes de configuration, le
nettoyage et les garanties par transport. Les relectures augmentent le trafic.
Le renommage dépend du serveur et ne fournit ni remplacement atomique universel
ni atomicité de plusieurs fichiers ; aucun journal durable ni retour arrière
n'est implémenté.

Dans un même processus Node, les mutations distantes partagent un verrou FIFO
par protocole, nom d'hôte, port et utilisateur normalisés, quels que soient
l'alias du serveur ou sa racine. Les téléchargements verrouillent leur
destination locale canonique et revérifient l'autorisation d'écrasement sous ce
verrou. Les appels distants en lecture seule n'acquièrent pas les verrous de
mutation de la cible. Les autres processus, alias DNS, comptes différents,
fichiers locaux liés physiquement et écritures externes ne sont pas couverts
par cette coordination.

Le délai `operationTimeoutMs` par serveur vaut 120000 ms par défaut et accepte
les entiers de 100 à 3600000, attente dans la file et connexion comprises.
L'annulation d'une requête MCP et les contrôles de délai ferment les
transports et empêchent les opérations suivantes du même appel. L'annulation
est coopérative : une mutation sous-jacente peut encore se terminer après la
réponse d'erreur, et son verrou reste détenu jusqu'au règlement de sa promesse
et au nettoyage. Un adaptateur bloqué indéfiniment peut donc maintenir la
cible occupée jusqu'à l'arrêt du processus. Le serveur ne réessaie jamais
automatiquement une mutation incertaine. L'annulation ne défait pas les
écritures terminées, ne prouve pas l'état distant final et ne rend pas les
transferts atomiques.

L'assistant conserve des sauvegardes horodatées lorsqu'il modifie une
configuration client MCP existante. Le remplacement atomique des nouvelles
configurations sensibles est une condition de publication de la v0.2 ; n'en
déduisez pas que chaque chemin d'écriture historique ou non publié est
atomique. Conservez des sauvegardes indépendantes et validez l'artefact
empaqueté avant publication.

## Erreurs structurées et annulation

Les erreurs d’outils connus utilisent une enveloppe stricte avec un code stable,
un nouvel UUID, des effets observés prudemment et aucune autorisation de reprise
automatique. Les neuf outils structurés publient des possibilités strictes de
succès ou d’erreur. Le résultat complet est limité à 25 000 octets JSON UTF-8
après masquage ; les avertissements et la pagination reposent sur des métadonnées
internes fiables. Le [contrat d’erreur](./ERROR-CONTRACT.fr.md) décrit les champs
et codes exacts.

Une annulation du client supprime normalement la réponse MCP, tandis qu’une
échéance interne peut renvoyer `TIMEOUT`. Un décorateur du transport public
corrige les annulations ignorées par le SDK installé pour le nombre `0` et la
chaîne vide, avec deux emplacements indépendants. Les emplacements et verrous
restent détenus jusqu’au règlement réel du traitement. Un doublon actif dans
l’un de ces emplacements ferme la connexion ; une réponse dont l’envoi a déjà
commencé ne peut pas être rappelée. Ces mécanismes ne permettent ni retour
arrière ni preuve d’absence d’effets d’une écriture incertaine.

## Secrets et consignes d'exploitation

- Gardez `ftp-servers.json` hors du contrôle de version et restreignez ses droits.
- Préférez les variables `${ENV:NAME}` ou une clé privée SSH protégée aux
  secrets en clair dans le JSON.
- Donnez à chaque environnement un compte serveur distinct aux droits minimaux.
- Pour les cibles d'audit seul, associez `readOnly` à des droits de lecture
  seule côté serveur.
- Examinez les avertissements de `ftp_list_servers` et `doctor` avant le
  premier déploiement réel.
- Commencez par `dry_run`, puis déployez sur une cible hors production si possible.
- Renouvelez tout identifiant apparaissant dans une réponse d'outil ou un
  journal partagé.

Le projet n'envoie aucune télémétrie. Il se connecte aux serveurs configurés ;
l'installation du paquet peut, indépendamment, contacter npm selon son
fonctionnement normal.

## Divulgation de vulnérabilités

Les contournements potentiels de ces contrôles doivent être signalés en
privé. Suivez [SECURITY.fr.md](../SECURITY.fr.md), utilisez des identifiants
jetables et n'incluez pas de secrets actifs dans le rapport.
