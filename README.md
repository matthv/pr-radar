# PR Radar

Dashboard local de tes PRs GitHub, en deux colonnes :

- **Mes PRs** — celles que tu as ouvertes, avec ce qui te reste à faire dessus
  (remarques non traitées, changes requested, CI rouge, conflits).
- **PRs que je review** — celles où tu es relecteur, en distinguant *à toi de jouer*
  de *tu attends un fix de l'auteur*.

Chaque colonne est groupée par état :

| Groupe | Mes PRs | Mes reviews |
| --- | --- | --- |
| `À fixer / À faire de mon côté` | remarques non traitées, changes requested, CI rouge, conflits | review demandée non faite, réponses à tes remarques, nouveaux commits depuis tes retours |
| `En attente` | tu as répondu, la balle est chez les relecteurs | tes threads ouverts / ton changes requested attendent un fix |
| `Rien à signaler` | le reste | le reste |

## Lancer

```bash
cd ~/Sites/pr-radar
yarn start          # ou: node server.js
open http://localhost:4321
```

Aucune dépendance à installer. L'authentification réutilise ta session `gh`
(`gh auth status` doit être vert). Un `GITHUB_TOKEN` dans l'environnement prend
le pas sur `gh` si tu préfères.

## Config

Tout se règle dans le fichier **`.env`** à la racine (`.env.example` en donne une copie
commentée). Une variable déjà exportée dans ton shell garde la priorité sur le fichier.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `4321` | Port du serveur |
| `PR_RADAR_ORG` | `ForestAdmin` | Org scannée |
| `PR_RADAR_MAX_AGE_DAYS` | `60` | Au-delà, la PR est ignorée |
| `PR_RADAR_REFRESH_SECONDS` | `300` | Intervalle du rafraîchissement automatique |
| `GITHUB_TOKEN` | — | Court-circuite `gh` |

Le serveur cache sa réponse pendant **la moitié** de `PR_RADAR_REFRESH_SECONDS` : sinon
un poll tomberait sur un cache tout juste valide et servirait des données presque deux
fois plus vieilles que l'intervalle annoncé. Le bouton **Rafraîchir** contourne le cache.

## PRs ignorées

Une PR sans activité depuis plus de `PR_RADAR_MAX_AGE_DAYS` jours est écartée.

Le critère n'est **ni** la date de création **ni** `updated_at`, mais la dernière
activité réelle : dernier commit, dernier commentaire humain, dernière review. En
clair, `max(createdAt, dernier commit, derniers commentaires/reviews hors bots)`.

`updated_at` de GitHub ne convient pas : il bouge pour un label posé, un `mergeable`
recalculé ou une CI relancée. `agent-ruby#259` n'avait aucun commit ni commentaire
depuis 204 jours mais s'y déclarait « modifiée il y a 2 jours ». Les commentaires de
bots sont exclus pour la même raison : un qlty qui repasse ne réveille pas une PR.

Ce même horodatage sert à afficher l'âge de la carte et à ordonner les colonnes.

Le pré-tri sur `updated_at` est conservé mais volontairement large : il ne sert qu'à
éviter de charger les détails des PRs mortes à coup sûr. Le nombre d'écartées reste
affiché en tête pour que le filtre ne soit jamais silencieux.

```bash
PR_RADAR_MAX_AGE_DAYS=180 node server.js   # remonter la fenêtre à 6 mois
```

## Notifications

- Le titre de l'onglet affiche le nombre d'actions requises : `(4) PR Radar`.
- Un bip sonne quand ce nombre augmente (case **son**, mémorisée).
- Rafraîchissement automatique piloté par `PR_RADAR_REFRESH_SECONDS` ; l'heure du
  dernier fetch est dans le header, l'intervalle exact au survol.

## Filtres et affichage

- **à traiter** — ne garde que les cartes qui demandent quelque chose.
- **sans les bots** — ignore les threads de qlty / macroscope / dependabot & co.
  Le décompte, le classement et le groupe des cartes sont recalculés en conséquence :
  une PR signalée uniquement par un bot repasse dans « rien à signaler ».
- **sans les drafts**.
- `☾` / `☀` bascule clair / sombre (clair par défaut, choix mémorisé).
- `FR` / `EN` bascule la langue de l'interface (français par défaut, choix mémorisé).
  Les libellés d'état sont rendus côté navigateur : le serveur n'émet que des `kind`,
  jamais de phrase, pour qu'aucun texte n'échappe à la traduction.

Clique sur `▸ N threads ouverts` pour lire les remarques sans quitter la page.

Chaque carte porte deux âges, libellés pour ne pas être confondus : **« ouverte il y a
X »** en haut à droite (date exacte au survol) et **« active il y a Y »** dans la ligne
d'état, qui est la dernière activité réelle et sert aussi de clé de tri.

## Lecture des couleurs

La couleur encode la priorité, pas la gravité :

- **indigo → violet** — à toi de jouer (remarques à traiter, review demandée, réponses
  pour toi). Rail de carte, fond dégradé, en-tête de groupe et compteur.
- **ambre** — tu attends quelqu'un (tes threads ouverts, ton changes requested).
- **émeraude** — approuvé, CI verte.
- **brique** — réellement cassé, et seulement ça : CI en échec, conflits de merge.
- **cyan** — repère de la colonne review et emplacement d'un thread (`fichier.rb:42`,
  `conversation`). Jamais un état : c'est un accent de navigation.

Les deux colonnes portent leur propre teinte de titre (indigo à gauche, cyan à droite)
pour se repérer d'un coup d'œil quand elles défilent.

Les pills portent l'état ; une ligne de raison n'apparaît que pour ce qu'aucun pill ne
dit déjà (le nom du relecteur qui a demandé des changements, les nouveaux commits à
re-vérifier).

## Où sont cherchés tes retours

Un retour de review ne vit pas forcément dans un thread inline. Trois canaux sont
couverts, et tous alimentent le même classement :

1. les **threads inline** (commentaires sur une ligne de code) ;
2. les **reviews soumises** (`approve` / `request changes`, corps de review inclus) ;
3. la **conversation principale** de la PR, repliée en un thread synthétique.

La découverte utilise quatre recherches : `author:@me`, `reviewed-by:@me`,
`review-requested:@me` et `commenter:@me`. Cette dernière est indispensable :
`reviewed-by:` ne matche qu'une review **formellement soumise**, donc une PR où tu as
seulement écrit dans la conversation n'y apparaît jamais.

## Notes d'implémentation

- La liste des PRs passe par la **search REST** : la search GraphQL time out
  (HTTP 499) sur une org de la taille de ForestAdmin. Les `node_id` renvoyés sont
  directement les ids GraphQL des `PullRequest`, ensuite chargés par lots de 6.
- Le body GraphQL est écrit dans un fichier temporaire : `gh api --input -` ne
  reçoit pas correctement un body piped depuis Node avec `gh <= 2.7`.
- Les reviews demandées **via une équipe** n'apparaissent pas : la search GitHub
  exige `team-review-requested:org/team`, non couvert ici.
- Le thread synthétique de conversation ignore les bots, mais ne sait pas distinguer
  un vrai retour d'un « LGTM 🎉 » : sur tes propres PRs, un dernier commentaire
  élogieux compte comme « à traiter ».
