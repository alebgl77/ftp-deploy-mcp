# Promotion vérifiée depuis un fichier temporaire

[English](./TRANSFERS.md)

`ftp_upload`, `ftp_deploy` et `ftp_download` vérifient chaque fichier avant
de le promouvoir vers sa destination demandée. Les noms des outils et les champs
des réponses réussies restent identiques.

## Envoi et déploiement

Sous le verrou de mutation du serveur distant, partagé dans le processus, le
serveur calcule le SHA256 de la source locale, l'envoie vers un fichier voisin
imprévisible nommé `.ftp-mcp-<aléatoire>.tmp`, puis relit ce temporaire.
Son nombre réel d'octets et son SHA256 doivent correspondre à la source avant
qu'un unique renommage le promeuve vers le chemin final. Le processus est
identique pour un fichier vide.

Si l'envoi, la vérification ou le renommage échoue, le serveur ne supprime jamais
la destination finale pour permettre la promotion et ne revient jamais à un
écrasement direct. Il tente uniquement de supprimer son propre temporaire.
Un échec du nettoyage conserve le diagnostic initial et ajoute un avertissement
borné indiquant qu'un temporaire peut subsister. Les erreurs ordinaires d'un
déploiement conservent le comportement existant de résultat partiel ;
l'annulation ou l'expiration arrête les étapes et fichiers suivants.

Le comportement du renommage FTP et SFTP standard dépend du serveur et de son
système de fichiers. Le remplacement d'une destination existante peut être
refusé. Cette fonction n'exige pas l'extension de renommage POSIX de SFTP,
ne promet pas un remplacement atomique universel et ne rend pas un déploiement
de plusieurs fichiers atomique.

## Téléchargement

Le serveur verrouille la destination locale canonique, y compris entre serveurs
distants et alias de chemins configurés. Il lit d'abord le fichier distant dans
la limite autorisée pour obtenir son SHA256 attendu, puis télécharge vers un
temporaire voisin exclusif et imprévisible. Le nombre réel d'octets téléchargés
est borné et leur SHA256 doit correspondre. Le temporaire est synchronisé sur
disque et fermé avant la promotion.

Le confinement, l'identité de la destination et la règle d'écrasement sont
revérifiés avant la promotion. Avec `overwrite:false` (valeur par défaut),
un lien physique dans le même dossier crée la destination uniquement si elle
est toujours absente, puis le temporaire est supprimé. Si un autre fichier
apparaît, il est préservé. Les systèmes de fichiers sans liens physiques
échouent de façon fermée ; aucun repli vers une vérification suivie d'un
renommage n'est effectué. Avec `overwrite:true`, un renommage dans le même
dossier promeut le temporaire complet. Un échec avant la promotion préserve la
destination existante. Un échec de suppression du temporaire après la création
réussie du lien physique renvoie un succès accompagné d'un avertissement de
nettoyage, car le fichier complet demandé existe déjà.

Le motif de nom `.ftp-mcp-*.tmp` est réservé et toujours exclu de
`ftp_deploy`, à la racine de la source comme dans ses sous-dossiers, même
si un motif `include` explicite le sélectionne. La sélection du déploiement
de cet outil ne peut donc pas envoyer le temporaire partiel d'un téléchargement
simultané.

## Limites configurées

Ces champs facultatifs appartiennent à chaque serveur du fichier de
configuration. Les arguments des outils ne peuvent pas les modifier.

| Champ | Valeur par défaut | Maximum |
| --- | ---: | ---: |
| `maxTransferBytes` | 268435456 (256 Mio par fichier) | 1099511627776 (1 Tio) |
| `maxDeployFiles` | 10000 fichiers sélectionnés | 100000 |
| `maxDeployBytes` | 1073741824 (1 Gio par déploiement) | 1099511627776 (1 Tio) |

Les valeurs doivent être des entiers positifs représentables exactement.
Les fichiers vides sont acceptés dans une limite positive. Les envois trop
volumineux et les déploiements dépassant le nombre de fichiers sélectionnés,
la taille individuelle ou le total d'octets connus sont rejetés avant connexion.
Les contrôles en flux comptent les octets réels, y compris pendant les relectures
de vérification et les téléchargements ; une taille déclarée seule ne permet
pas de contourner une limite. Les contrôles du déploiement appliquent également
le budget cumulé d'octets sources pendant le traitement des fichiers.
Chaque envoi et sa relecture sont également limités à la taille de la source
hashée, y compris zéro. Les tentatives échouées conservent leur réservation
dans le budget du déploiement : une source qui grossit ne peut donc pas
transmettre d'octets supplémentaires non budgétés.

## Portée de la garantie

En SFTP, le serveur crée d'abord un temporaire vide exclusif avec ses droits
effectifs normaux, relève ces bits, puis impose et vérifie le mode 0600 avant
d'écrire le contenu source. Avant la promotion, il restaure les bits de droits
(0777) de la destination régulière existante, ou le mode serveur relevé pour
une nouvelle destination. Un échec de stat ou de chmod nécessaire empêche la
promotion. Un téléchargement copie également les bits 0777 d'une destination
existante vers le temporaire local avant synchronisation ; un nouveau fichier
local conserve son mode de création 0600. Sous Windows, la sémantique native
des permissions du système de fichiers s'applique.

FTP/FTPS ne dispose ici d'aucun mécanisme portable de conservation des droits.
Remplacer un fichier distant existant peut lui attribuer les droits de création
par défaut du serveur, y compris pour un exécutable ou un fichier privé.
Configurez le compte distant, l'umask et les ACL de façon adaptée avant
d'utiliser ce remplacement FTP. La vérification du contenu ne conserve pas le
propriétaire, les ACL, les attributs étendus, les horodatages, les liens physiques
ni les bits de permissions spéciaux.

Les relectures de vérification augmentent le trafic réseau et la latence.
Un transfert réussi vérifie le contenu d'un fichier complet ; il ne constitue
ni une optimisation de performances ni une transaction du site. Il n'existe
pas de journal durable des transferts, de retour arrière automatique ou de
nouvelle tentative automatique d'une mutation au résultat incertain.

L'annulation et les délais arrêtent les étapes suivantes et ferment le
transport. Ils n'annulent pas une promotion déjà acceptée par le serveur ;
un renommage interrompu peut avoir un résultat incertain. Des temporaires
peuvent subsister après interruption : examinez la destination et les
temporaires avant une nouvelle tentative. Une opération non coopérative
conserve son verrou dans le processus jusqu'à sa terminaison effective.
Une connexion SFTP fixe sa racine canonique initiale. Un changement connu
provoque `TARGET_CHANGED` : vérification, promotion et nettoyage refusent
de reporter le chemin d'un temporaire possédé sous la nouvelle racine.
L'identité de création conserve en interne la racine et le chemin canoniques
initiaux. Le nettoyage peut donc laisser ce temporaire sous l'ancienne racine
pour inspection manuelle, afin de préserver un fichier tiers sous la nouvelle.

Les verrous protègent un seul processus Node.js. Ils ne coordonnent pas les
processus distincts, les écritures distantes ou les autres programmes partageant
un hôte. La validation ne prétend pas protéger contre les courses malveillantes
sur les chemins ou les sources par le même utilisateur du système d'exploitation.
Les quotas ne bornent pas encore l'énumération complète des dossiers locaux et
le motif réservé n'empêche pas un autre outil système de lire un temporaire.
La sélection parcourt les dossiers de façon récursive et synchrone, sans point
de contrôle d'annulation par dossier ni limite d'entrées visitées. Les
sous-arbres exclus sont élagués lorsque les motifs existants le permettent,
mais de nombreux dossiers vides ou entrées non sélectionnées peuvent encore
exiger un travail de scan non borné par le quota de fichiers sélectionnés.
Une demande déjà annulée est refusée avant le scan. Pendant celui-ci, le
blocage de la boucle événementielle peut retarder le minuteur et les
notifications d'annulation ; le délai écoulé est vérifié au prochain point
de contrôle, avant connexion ou retour d'un résultat de simulation. Le délai
configuré ne constitue donc pas une borne temporelle stricte de la découverte.

En interne, SFTP conserve un handle exclusif pendant le FSTAT initial, le
FCHMOD restrictif, son FSTAT de confirmation et les WRITE séquentiels bornés ;
le CLOSE reste attendu en cas d'échec ou d'annulation. La promotion lit les
droits existants dans le résultat privé de `safePath` de l'adaptateur.
Le mode initial du temporaire circule uniquement entre l'adaptateur et le
module de transfert. Ces détails internes pourront servir à de futurs travaux ;
cette version ne les persiste pas dans un journal de retour arrière.
