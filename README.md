# Thiès Distribution

Boutique web responsive de matériel électronique pour le Sénégal. Le MVP comprend un catalogue consultable sans compte client, une recherche et des filtres, des fiches produit, un panier, les commandes et leur suivi, ainsi qu’une interface d’administration.

## Documentation

- [Cahier des charges](docs/CAHIER-DES-CHARGES.md) — périmètre, règles métier, critères de validation et limites du MVP.
- [Documentation technique](docs/DOCUMENTATION-TECHNIQUE.md) — architecture, configuration, routes API, paiements et exploitation.

## Prérequis

- Node.js 20.12 ou plus récent.
- Aucune dépendance npm externe n’est requise pour le fonctionnement actuel.

## Premier démarrage

Depuis PowerShell :

```powershell
cd "C:\Users\bmd\Desktop\projet 3"
Copy-Item .env.example .env
notepad .env
```

Dans `.env`, définissez `TRD_ADMIN_PASSWORD` avec un mot de passe fort, puis enregistrez et fermez le Bloc-notes. `.env` contient des paramètres privés, est ignoré par Git et ne doit jamais être partagé. Ensuite, dans le terminal, exécutez :

```powershell
npm start
```

Laissez le terminal ouvert. La boutique est à [http://localhost:3000](http://localhost:3000) et l’administration à [http://localhost:3000/admin.html](http://localhost:3000/admin.html). Si `EADDRINUSE` indique que le port est déjà utilisé, vérifiez l’adresse dans votre navigateur au lieu de démarrer une seconde copie. `Ctrl+C` arrête le serveur.

Le serveur initialise `data/store.json` à partir de `products.json` au premier démarrage. Les commandes et les modifications ultérieures du catalogue sont enregistrées dans `data/store.json`, exclu de Git. Faites des sauvegardes et vérifiez les données de démonstration avant toute vente réelle.

## Accès à la boutique et demandes de produits

La boutique et l’administration démarrent sur cet ordinateur ; `localhost` n’est pas une adresse publique. Le dépôt GitHub conserve le code et la documentation, mais ne publie ni n’héberge automatiquement le site. Pour le rendre accessible sur Internet, il faudra choisir un hébergement compatible avec Node.js, configurer un domaine et HTTPS, puis protéger et sauvegarder les données.

Les visiteurs peuvent consulter le catalogue et passer commande sans créer de compte. Pour un produit dont le prix reste à confirmer ou qui est indisponible, la boutique propose une demande préremplie par WhatsApp au lieu d’autoriser l’ajout au panier. Le client doit ouvrir WhatsApp et envoyer le message lui-même ; cette demande n’est pas une commande. Ce parcours nécessite une connexion Internet.

## Ressources et fonctionnement hors ligne

Les images de la boutique se trouvent dans `assets/` et sont servies par le serveur local. L’affichage du site et les visuels restent disponibles sans connexion Internet une fois le projet installé ; WhatsApp, les commandes hébergées, les prestataires de paiement et tout futur déploiement public exigent une connexion.

## Paiements

Les quatre modes métier prévus sont Mobile Money, carte, paiement à la livraison et virement bancaire. Les paiements en ligne sont proposés uniquement lorsque les clés marchandes du prestataire sont présentes et que `TRD_PUBLIC_URL` contient une origine publique HTTPS. Aucune passerelle n’est activée dans la configuration locale actuelle. Consultez la [documentation technique](docs/DOCUMENTATION-TECHNIQUE.md#6-paiements) et `.env.example` pour les variables nécessaires.

Ne placez jamais de clés marchandes dans les fichiers HTML, les journaux, les captures d’écran ou Git. Les identifiants `live` ne s’utilisent qu’après validation des comptes, tests sandbox et configuration HTTPS.

## Vérification

```powershell
npm test
npm run check
```

## État avant publication

Le produit est un MVP et non une plateforme prête pour la vente en production. Vérifiez le droit d’utiliser le logo et les images de référence, confirmez les coordonnées et liens sociaux, contrôlez les prix et les stocks, préparez les conditions de vente et la politique de confidentialité, puis configurez un hébergement HTTPS, les sauvegardes et les comptes marchands. Les limites et critères sont précisés dans le [cahier des charges](docs/CAHIER-DES-CHARGES.md).
