# Cahier des charges — Thiès Distribution

**Produit :** boutique en ligne de matériel électronique · **Version :** 1.0
**État :** MVP local ; mise en production à préparer

## 1. Objet

Mettre à disposition des particuliers et des entreprises au Sénégal une boutique web responsive permettant de consulter un catalogue informatique et électronique, de composer un panier et de passer une commande. Une interface d’administration protège la gestion du catalogue, des stocks et des commandes.

La maquette de référence décrit l’identité MBI / Thiès Distribution, la navigation et la composition visuelle. Les coordonnées, liens sociaux, éléments graphiques et données commerciales doivent être confirmés par l’exploitant avant publication.

## 2. Utilisateurs et besoins

| Profil | Besoin |
|---|---|
| Visiteur / acheteur | Consulter le catalogue sans compte, examiner un article, commander avec ses coordonnées de livraison ou demander le prix/la disponibilité d’un article concerné. |
| Acheteur professionnel | Demander un devis pour une commande en volume et fournir les informations de son entreprise. |
| Administrateur | Consulter les commandes, modifier le catalogue et ajuster les stocks au moyen d’une session protégée. |

## 3. Périmètre du MVP

### Boutique

- Présentation responsive en français avec la marque Thiès Distribution.
- Navigation vers l’accueil, les catégories, les promotions, les marques, les informations et le contact.
- Images du catalogue et du bandeau hébergées localement dans `assets/`.
- Recherche textuelle dans les noms, marques et catégories.
- Filtres par catégorie, marque, état, disponibilité et prix ; tri par prix ou notes.
- Fiches détaillées des produits, favoris mémorisés dans le navigateur, panier et comparaison de produits.
- Consultation et commande sans création de compte client ; suivi d’une commande par sa référence et le téléphone fourni.
- Pour un article dont le prix est à confirmer ou le stock nul, demande de prix ou de disponibilité via un lien WhatsApp prérempli. Le client envoie lui-même le message ; cela ne crée pas de commande.
- Passage de commande avec coordonnées client, livraison, mode de paiement et suivi de commande.
- Parcours de demande de devis professionnel.

### Commandes et paiements

- Moyens proposés : Mobile Money, carte bancaire, paiement à la livraison et virement bancaire.
- PayDunya, CinetPay et FedaPay servent de passerelles en ligne lorsque leurs clés sont configurées et qu’une URL publique HTTPS est disponible.
- Une commande en ligne reste en attente tant que l’état n’a pas été vérifié auprès du prestataire.
- Paiement à la livraison plafonné à **150 000 FCFA**.
- Frais de livraison actuels : **3 000 FCFA** sous 100 000 FCFA de sous-total ; gratuits à partir de ce seuil.
- Le montant, le stock et les articles sont recalculés côté serveur. Une annulation restaure le stock.
- Suivi d’une commande par numéro de commande et numéro de téléphone.

### Administration

- Authentification par mot de passe configuré côté serveur ; session HTTPOnly et protection CSRF.
- Consultation des commandes et mise à jour des statuts de livraison et de paiement selon les règles métier.
- Ajout, modification et suppression des produits, avec image disponible dans la bibliothèque locale.
- Les données du MVP sont persistées dans `data/store.json`.

## 4. Règles d’acceptation

1. La page d’accueil, les images locales et l’API du catalogue sont servies par `npm start`.
2. À la première initialisation, le catalogue de démonstration est chargé depuis `products.json`.
3. La recherche et les filtres mettent à jour le nombre de produits et les cartes affichées.
4. Les quantités commandées ne dépassent pas le stock ; les valeurs envoyées par le navigateur ne font pas autorité sur les prix.
5. Les coordonnées et le téléphone sont validés avant l’enregistrement d’une commande.
6. Le serveur refuse le paiement à la livraison au-delà de son plafond.
7. Aucun prestataire de paiement en ligne n’est présenté tant que l’URL HTTPS et les clés requises pour ce prestataire sont absentes.
8. Une redirection ou une notification isolée ne suffit pas à confirmer un paiement en ligne : la transaction est vérifiée côté serveur.
9. L’administration n’expose pas les données avant authentification et contrôle les transitions des commandes.
10. Les vérifications automatisées s’exécutent par `npm test` et `npm run check`.
11. Les fiches de démonstration dont le prix est à confirmer restent visibles dans leur catégorie, mais ne peuvent pas être ajoutées au panier ni commandées.
12. Un produit dont le prix est à confirmer ou dont le stock est nul propose une demande WhatsApp depuis sa carte et sa fiche détaillée ; un produit achetable conserve l’ajout au panier.

## 5. Hors périmètre et limites connues

- Les prix, stocks, visuels produits, coordonnées et conditions commerciales doivent être vérifiés par le propriétaire avant une vente réelle.
- Les fiches de démonstration accessoires et informatique utilisent des images illustratives et ne représentent pas une offre commerciale tant que leurs modèles, prix et stocks ne sont pas confirmés.
- Les demandes WhatsApp nécessitent une connexion Internet et l’accès à WhatsApp ; elles ne garantissent pas la disponibilité du produit et ne remplacent pas une commande confirmée.
- La persistance JSON convient à une démo mono-instance ; elle n’offre ni transactions de base de données ni évolutivité de production.
- Pas de compte client, d’historique de commandes autonome, de facturation PDF, de gestion IMEI/SAV, d’import massif ni de moteur de recherche externe.
- Aucun paiement en ligne n’est actif dans la configuration locale actuelle : il manque une URL HTTPS publique et les clés des comptes marchands.
- Les URL des réseaux sociaux de la maquette restent à fournir pour rendre les icônes interactives.
- Le serveur local n’est pas un hébergement public ; la présence du code sur GitHub ne rend pas la boutique accessible sur Internet. Avant la production, prévoir un hébergement Node.js, un domaine, HTTPS, stockage persistant, sauvegardes testées, supervision, documents légaux et validation des comptes marchands.

## 6. Évolutions proposées

Après validation du MVP et des besoins métier : base de données PostgreSQL, déploiement HTTPS, sauvegardes automatisées, gestion de catalogue plus complète, factures conformes, notifications, authentification administrateur renforcée et fonctionnalités de service après-vente.
