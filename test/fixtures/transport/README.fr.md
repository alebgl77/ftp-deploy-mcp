# Identifiants des tests de transport

[English](./README.md) | **Français**

Ces identifiants sont publics, jetables et RÉSERVÉS AUX TESTS. Ne faites jamais
confiance à ce certificat et n'utilisez jamais cette clé privée en dehors des
tests de transport sur boucle locale.

La clé RSA de 2048 bits et le certificat auto-signé SHA-256 ont été générés
spécifiquement pour ce jeu de test avec Python cryptography 50.0.1, sans aucun
identifiant de production. Le certificat couvre le nom DNS localhost et l'IP
127.0.0.1 ; il sert d'ancre de confiance de test avec l'usage serverAuth et est
valide du 2026-01-01 au 2040-01-01 UTC. Le cas de confiance l'ajoute uniquement
à un processus enfant via NODE_EXTRA_CA_CERTS ; le cas de rejet utilise le
même certificat sans ajouter cette confiance. Les clés du client et de l'hôte
SFTP sont générées à neuf lors de l'exécution des tests.

Exécutez `node --test test/transport-qualification.js`. Le petit serveur FTPS
de test implémente uniquement les commandes utilisées par ces tests
d'adaptateur, avec de vrais canaux de contrôle et de données TLS sur des ports
de boucle locale attribués par le système. Cela qualifie le comportement local
du transport, sans démontrer l'interopérabilité avec tous les serveurs FTPS ni
toutes les politiques de reprise de session TLS.
