# Orange/Wanadoo et fournisseurs français

## Constat du 24 octobre 2026

L’audit des 161 envois suivis de compta@mail.d2-group.fr sur 90 jours ne contient aucun destinataire direct Orange/Wanadoo, SFR, Free ou La Poste. Il ne permet pas d’affirmer que ces boîtes classent les factures hors spam. Les essais réels antérieurs concernent uniquement Igor chez Google ; aucun nouvel envoi vers un client n’est autorisé. Une boîte Orange/Wanadoo de test contrôlée et un accord spécifique sont demandés pour une démonstration avec PDF.

Les MX publics d’orange.fr et wanadoo.fr pointent vers smtp-in.orange.fr et smtp-in2.orange.fr. SFR, Free et La Poste utilisent respectivement smtp-in.sfr.fr, mx1/mx2.free.fr et smtpz4.laposte.net lors de cette vérification.

## Contrat de surveillance

`GET /api/v1/mail/domains/{domain}/reputation` distingue désormais, dans `smtp.providers`, `orange_wanadoo`, `sfr`, `free` et `laposte`. Les domaines destinataires exacts et les suffixes de serveurs distants sont reconnus, sans accepter de faux suffixes. L’absence d’observations conserve `availability: unknown`, des compteurs SMTP et un taux à null. Le volume demandé peut être zéro si la consultation complète établit qu’aucun destinataire de ce fournisseur n’est observé ; cela ne signifie pas zéro plainte ou bonne réputation.

`diagnostics` regroupe les suffixes OFR explicitement présents dans les observations SMTP Orange, avec code, catégorie, nombre d’observations et action. Les DSN déclaratifs ne sont pas transformés en preuves de filtrage Orange. Aucune adresse Bcc ni réponse brute n’est ajoutée à l’agrégat. `lastSmtpObservationAt` indique la date de la dernière preuve disponible. `inboxPlacement` reste null, y compris après acceptation SMTP. Les alertes existantes de rejets et de files lentes bénéficient de cette distinction par fournisseur ; un faible volume ne produit pas un pourcentage trompeur.

La période filtre les messages selon leur date de soumission ; chaque destinataire est compté une fois selon son dernier état conservé. Ce n’est pas un total de toutes les tentatives SMTP. Consulter le suivi du message et ses événements pour l’historique des reports puis des acceptations. Un code OFR dans un texte d’acceptation 2xx n’est pas interprété comme un rejet.

Les pages officielles consultées documentent les incidents ; cette intégration ne prétend pas disposer d’un score Orange, d’une API de classement en boîte principale ou d’une boucle de plaintes Orange non vérifiée. Sources : [Orange](https://postmaster.orange.fr/index.html), [Free](https://postmaster.free.fr/), [La Poste](https://postmaster.laposte.net/kb/fr/delivrabilite-et-erreurs-547184). Le portail SFR était inaccessible lors de la consultation : ses règles propres restent à vérifier.

## Régulation des envois ordinaires

La production utilise un seul serveur Stalwart 0.16.8. Son pool distant général avait 50 threads et aucune règle sortante dédiée à Orange. `ensure-orange-delivery.py` propose une file `kod-orng` de deux threads pour les nouveaux envois ordinaires Orange/Wanadoo. Il copie la politique distante de délais, notification et expiration ; les routes SMTP, TLS, DSN, rapports et livraisons locales sont préservés. Les anciens éléments de file ne sont ni déplacés ni rejoués. Cette configuration réduit les rafales ; elle ne constitue pas une preuve du classement chez Orange. Les messages DSN/rapports conservent leur pool : ne pas présenter la limite comme un plafond global de toutes les connexions de l’IP.

Exécution sur la VM : `python3 /opt/framm/deploy/scripts/ensure-orange-delivery.py --dry-run`, puis sans cette option. Le script partage le verrou du réconciliateur de routage, sauvegarde la règle précédente en privé, refuse les noms ou règles personnalisées inconnus et relit la configuration après rechargement. Aucune reconstruction ou relance de Stalwart n’est requise par le script. Son résultat distingue configuration relue et livraison réellement observée. Vérifier la santé, les journaux et la sélection de file lors du prochain essai autorisé ; un succès JMAP seul ne prouve pas le fonctionnement du nouveau pool.

Retour arrière : `--disable` retire seulement la règle gérée et garde les objets de file pour leur drainage. Une répétition est idempotente. Le verrou coordonne les automatismes locaux ; les changements manuels du planning sont à réaliser hors de cette opération. Si d’autres nœuds MTA sont ajoutés, réévaluer le plafond par nœud avant activation.

Orange indique aussi une limite de taille de message de 45 Mo. La limite KOD de pièces jointes ne remplace pas celle du destinataire ; l’encodage MIME augmente la taille transmise. Le multipart ne supprime pas cette contrainte. Aucune modification du contenu, aucun fractionnement automatique de facture, aucun pixel ou lien ajouté.
