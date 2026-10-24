# Vérifications — 24 octobre 2026

## Production auditée avant modification
- Images exécutées web/worker : 8a0f994a6c3a2a2e933b448e48fc97ec971e8292, respectivement 1 et 4 répliques prêtes.
- Contrôles DNS publics et clé DKIM RSA 2048 : voir audit-2026-10-24.md. MX Microsoft 365 et p=none inchangés.
- Message de démonstration déjà reçu chez Igor le 24/10 à 08:27 UTC : SPF/DKIM/DMARC pass et TLS 1.3, vrai PDF. Aucun nouvel envoi client ni renvoi historique durant l’audit.
- Boîte DMARC native c7 : rapports Google/Microsoft reçus depuis le 16/10, chiffrés PGP et anciennement marqués traités sans XML extrait. Ce constat est réel, pas une fixture. L’absence d’agrégats en base provenait de cette collecte défaillante.
- Portails Google/Microsoft/Yahoo : non revérifiés, Mac verrouillé lors de deux tentatives Dia ; aucune réinscription créée.

## Tests simulés et contrôles locaux
Tests TypeScript : compatibilité JSON/multipart et PDF exacts, flag MDN strict, en-tête contrôlé sans changement de corps, authentification, scopes et domaines, absence de données null, filtrage des IP partagées, corrélation organisation/message/destinataire, plaintes anonymisées, faux Authentication-Results, doublons, ordre des preuves SMTP, incidents sans notifications répétées, webhooks HMAC et reprises sans soumission, révocation des accès et masquage Bcc.

Tests Python : parseurs XML/gzip/ZIP bornés, interception native avant chiffrement, corps/PDF exclus de SQLite, destinataires non autorisés ignorés, reprise après redémarrage et déduplication. Fixture RSA 2048 : signature vérifiée et falsification du corps rejetée. Ces tests ne prouvent pas la réception d’un ARF ou MDN réel.

PostgreSQL 16 réel dans un pod éphémère sans Service, écoute 127.0.0.1 seulement : contraintes de schéma appliquées, doublon d’événement et de notification neutralisé, corrélation d’un message de l’organisation B vers l’organisation A rejetée par clé étrangère composée, invariant exactement un événement par notification, filtre d’organisation contrôlé. Le pod et ses données ont été supprimés après succès. La CI répète les tests avec les migrations réelles sur PostgreSQL isolé.

Compilation TypeScript, lint/i18n et build Next de production vérifiés pendant l’implémentation. Le décompte final et la version réellement déployée doivent être consignés après les derniers contrôles.

## Réserves opérationnelles à conserver
Aucun rapport Google Postmaster API, SNDS, ARF fournisseur ou MDN réel n’a encore été collecté par les nouveaux connecteurs au stade de l’implémentation. Les inscriptions historiques Google ne sont pas une preuve d’accès actuel. L’historique DMARC PGP nécessite une récupération autorisée. Les prochains rapports seront la preuve réelle du chemin natif avant chiffrement, une fois le relais déployé.
