# Documentation technique — Thiès Distribution

## 1. État de référence

- Application Node.js utilisant les modules natifs `http`, `fs`, `path` et `crypto`.
- Interface boutique HTML/CSS/JavaScript : `index.html`.
- Interface administration : `admin.html`.
- API et serveur de fichiers : `server.js`.
- Intégrations de paiement et vérification des transactions : `payment-providers.js`.
- Catalogue de départ : `products.json`.
- Catalogue et commandes après démarrage : `data/store.json`.
- Visuels hors connexion : `assets/`.
- Tests automatisés : `tests/`.
- Aucune installation de dépendance npm n’est nécessaire au fonctionnement actuel.

## 2. Pré-requis et démarrage local

Prérequis : Node.js **20.12 ou plus récent** (Node.js 24 est compatible).

Dans PowerShell :

```powershell
cd "C:\Users\bmd\Desktop\projet 3"
npm start
```

Le serveur lit automatiquement `.env` si ce fichier existe. L’application est accessible sur [http://localhost:3000](http://localhost:3000), et l’administration sur [http://localhost:3000/admin.html](http://localhost:3000/admin.html). Garder la fenêtre du serveur ouverte ; `Ctrl+C` l’arrête. Si `EADDRINUSE` apparaît, un autre processus utilise déjà le port : vérifier que le site répond avant de lancer une deuxième instance.

Pour repartir d’une configuration vierge, copier `.env.example` en `.env` et définir un mot de passe administrateur fort. Ne jamais copier le `.env` de cette machine, le communiquer dans une conversation ou le versionner. Si le serveur tourne déjà, le redémarrer après toute modification de `.env`.

## 3. Configuration

| Variable | Usage |
|---|---|
| `PORT` | Port HTTP local ; 3000 par défaut. |
| `TRD_ADMIN_PASSWORD` | Mot de passe administrateur, chargé au démarrage. |
| `TRD_PUBLIC_URL` | Origine publique exacte en HTTPS ; obligatoire pour activer les paiements en ligne. |
| `TRD_STORE_NAME` | Nom de boutique envoyé au prestataire. |
| `PAYDUNYA_MODE` | `test` avant activation marchande ; `live` uniquement après validation. |
| `PAYDUNYA_MASTER_KEY`, `PAYDUNYA_PRIVATE_KEY`, `PAYDUNYA_TOKEN` | Clés marchandes PayDunya. |
| `CINETPAY_SITE_ID`, `CINETPAY_API_KEY` | Identifiants CinetPay. |
| `FEDAPAY_MODE`, `FEDAPAY_SECRET_KEY`, `FEDAPAY_WEBHOOK_SECRET` | Mode, clé secrète et secret de signature FedaPay. |

Les clés sont indépendantes : seul un prestataire dont tous les champs requis sont renseignés apparaît dans les moyens de paiement. Ne pas utiliser une URL de test, `localhost` ou HTTP comme URL publique. Ne passer en mode réel qu’après les essais sandbox et la validation du compte marchand.

## 4. API HTTP

Les requêtes et réponses API utilisent JSON.

### Routes publiques

| Méthode | Route | Fonction |
|---|---|---|
| `GET` | `/api/products` | Retourne le catalogue courant. |
| `GET` | `/api/payment-options` | Retourne seulement les passerelles complètes et compatibles HTTPS. |
| `POST` | `/api/orders` | Valide le client, le panier, le stock et le paiement ; crée une commande. |
| `POST` | `/api/orders/track` | Recherche une commande à partir de sa référence et du téléphone du client. |
| `POST` | `/api/payments/notify/{paydunya,cinetpay,fedapay}` | Reçoit une notification de prestataire et vérifie le paiement côté serveur. |

### Routes d’administration

| Méthode | Route | Fonction |
|---|---|---|
| `POST` | `/api/admin/login` | Ouvre une session si le mot de passe correspond. |
| `GET` | `/api/admin/session` | Retourne l’état de la session d’administration. |
| `POST` | `/api/admin/logout` | Ferme la session ; exige le jeton CSRF si la session est authentifiée. |
| `GET` | `/api/admin/orders` | Retourne les commandes ; session requise. |
| `POST` | `/api/admin/products` | Ajoute un produit ; session et CSRF requis. |
| `PUT` | `/api/admin/products/{id}` | Modifie un produit ; session et CSRF requis. |
| `DELETE` | `/api/admin/products/{id}` | Supprime un produit qui n’est référencé par aucune commande. |
| `PATCH` | `/api/admin/orders/{orderNumber}` | Change le statut de livraison selon les transitions autorisées. |
| `PATCH` | `/api/admin/orders/{orderNumber}/payment` | Change le statut de paiement selon les validations métier. |

La cookie de session est HTTPOnly et SameSite=Strict. Les changements d’état de l’administration exigent un jeton CSRF. Les tentatives de connexion sont limitées. Ces mécanismes protègent l’application mais ne remplacent pas TLS : ne pas exposer le serveur de développement directement sur Internet.

## 5. Données et commandes

Le premier démarrage crée `data/store.json` à partir de `products.json`. Les commandes et modifications suivantes sont écrites dans le fichier JSON. Sauvegarder ce fichier après l’arrêt du serveur ; tester toute restauration avant une mise en production.

Le serveur impose des limites de taille de requête et valide côté serveur les produits, quantités, prix du catalogue, stock, client et statuts. La livraison est gratuite à partir de 100 000 FCFA, et coûte 3 000 FCFA sinon. Le paiement à la livraison est limité à 150 000 FCFA. Les produits et prix fournis dans le catalogue doivent être vérifiés par le commerçant : ce sont des données de démonstration.

Les visiteurs peuvent parcourir la boutique et passer commande sans compte client. Les favoris sont conservés dans le navigateur. Les produits signalés `priceOnRequest` ou dont le stock est nul ne peuvent pas être ajoutés au panier ; la carte produit et sa fiche détaillée proposent plutôt un lien `wa.me` avec un message prérempli. Le numéro de support est configuré dans `index.html` (`supportWhatsAppNumber`). Le client doit envoyer le message dans WhatsApp : le lien ne crée ni commande ni réservation.

## 6. Paiements

- Mobile Money et carte bancaire passent par les pages sécurisées de PayDunya, CinetPay ou FedaPay.
- Les moyens disponibles dépendent du compte marchand et des méthodes effectivement activées auprès du prestataire.
- Le serveur compare le paiement vérifié à la référence et au montant XOF de la commande.
- Les notifications ne sont pas acceptées comme preuve sans vérification distante. Les signatures/hachages fournis par les prestataires sont également contrôlés selon le parcours.
- Le virement bancaire est confirmé manuellement. Le paiement à la livraison n’est confirmé qu’après livraison.
- Sans clés marchandes et HTTPS, `/api/payment-options` renvoie une liste vide et aucun encaissement en ligne n’est possible.
- Les secrets ne vont jamais dans le navigateur, les journaux, les captures d’écran, les rapports ou un dépôt Git.

## 7. Commandes de validation

```powershell
npm test
npm run check
```

`npm test` exécute les tests Node.js présents dans `tests/`. `npm run check` vérifie la syntaxe du serveur et du module de paiement. Les scripts intégrés dans les pages HTML sont du JavaScript navigateur et sont vérifiés par les tests de ressources de la boutique.

## 8. Publication et exploitation

Avant une mise en production : vérifier le droit d’utiliser le logo et les photographies MBI/Thiès Distribution, confirmer les coordonnées et liens sociaux, les prix et les stocks ; renseigner les documents de vente et de confidentialité ; obtenir les comptes marchands ; déployer derrière un hébergement TLS ; définir des sauvegardes et tester la restauration. Les commandes contiennent des données personnelles et ne doivent pas être publiées dans un dépôt.

Le serveur `npm start` écoute localement ; `http://localhost:3000` est accessible depuis l’ordinateur qui l’exécute, pas automatiquement depuis Internet. Publier le code sur GitHub ne déploie pas le serveur. Un accès public nécessite un hébergement compatible avec Node.js, une configuration réseau et de domaine, HTTPS, et un stockage persistant adapté. Ne pas exposer directement le serveur de développement.

Le dépôt ignore `.env`, les fichiers d’environnement locaux et `data/store.json`. Ne jamais forcer leur ajout avec `git add -f`.
