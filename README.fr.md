# sc-copilot-mcp

[![CI](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

[English](README.md) · Français

Un serveur local en **lecture seule** basé sur le [Model Context Protocol](https://modelcontextprotocol.io) qui
transforme Claude en copilote Star Citizen : marché et routes commerciales, vaisseaux, missions, artisanat
(crafting), minage, patch en cours, derniers événements enregistrés par votre jeu et gestion de votre flotte.

Il tourne sur votre PC via stdio. Il ne touche pas au jeu : il ne lit jamais la mémoire du jeu, n'envoie aucune
touche, n'automatise rien et n'écrit jamais dans le dossier du jeu. Le seul fichier du jeu qu'il peut lire est le
`Game.log` que vous lui indiquez explicitement, et uniquement si vous le faites.

> Fork de [voidput/SCMCP](https://github.com/voidput/SCMCP) v1.5.0, durci et étendu (voir [CHANGELOG](CHANGELOG.md)).
> Le fichier `LICENSE` en amont est en GPLv3 alors que son `package.json` et son README mentionnaient ISC ; ce fork est
> traité comme GPLv3 (voir [THIRD_PARTY.md](THIRD_PARTY.md)). Rien n'est publié sur npm ou Docker Hub depuis ce dépôt :
> l'image `voidput/scmcp` appartient à l'auteur d'origine.

## Ce que vous pouvez demander

| Besoin | Exemples | Outils principaux |
| --- | --- | --- |
| Commerce | « Meilleur transport depuis ArcCorp pour mon C2 ? » | `uex_get_trade_routes`, `uex_get_commodity_prices` |
| Vaisseaux | « Cutlass Black ou Freelancer ? Où l'acheter ? » | `scw_get_ship_comparison`, `scw_get_vehicle`, `uex_get_ship_prices` |
| Missions | « Quelles missions donnent un plan à Pyro ? » | `scmdb_search_missions`, `scmdb_search_crafting` |
| Minage | « Où est la Quantainium et quel laser la supporte ? » | `scmdb_search_mining` |
| Patchs | « Qu'est-ce qui a changé dans la dernière mise à jour ? » | `sc_patch_notes`, `scmdb_changes` |
| Votre jeu | « Que suis-je en train de faire ? Bilan de ma dernière session. » | `sc_log_context`, `sc_log_sessions` |
| Votre flotte | « Lequel de mes vaisseaux porte 300 SCU ? » | `sc_fleet_get` |
| Votre vaisseau, en direct (désactivé par défaut) | « Mon train d'atterrissage est-il sorti ? Combien d'hydrogène reste-t-il ? » | `sc_live_status`, `sc_live_state`, `sc_live_dashboard` |
| Fraîcheur | « Ces données sont-elles à jour ? » | `sc_data_status` |

Cinq prompts prêts à l'emploi les enchaînent pour vous (voir [Prompts](#prompts)). Toutes les capacités, avec leur
source, leur fraîcheur, leurs limites et leurs prérequis : **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** (en anglais).

## Ce que vous obtenez

Chaque réponse indique d'où proviennent les données. Les résultats d'outils ont la forme `{ provenance, data }` :

| Champ `provenance`        | Signification                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`, `kind`          | Quelle source, et s'il s'agit de `datamined`, `crowdsourced`, `editorial`, `local_log`, `user` ou `computed`                                                        |
| `channel`, `game_version` | `live`, `ptu` ou `unknown` (jamais deviné), ainsi que le numéro de build lorsque la source le fournit                                                               |
| `fetched_at`, `cache_age` | Date de récupération des données par ce serveur et ancienneté de cette récupération (un hit de cache garde la date d'origine)                                       |
| `data_age`, `data_date`   | Ancienneté des DONNÉES, d'après les dates fournies par la source (dates des lignes UEX, date du canal SCMDB) ; `null` si aucune, `data_age_note` en donne la raison |
| `trust`                   | `untrusted_text` pour le texte rédigé par des joueurs ou éditeurs web : nettoyé, raccourci, à lire comme donnée et jamais comme consigne |
| `stale`, `stale_reason`   | Présents uniquement lorsque la requête en direct a échoué et que la dernière copie valide en cache a été servie                          |

`sc_data_status` affiche la version servie par chaque source, son ancienneté, les écarts entre sources (par exemple
les builds LIVE `12881860` et `12913470`) et celles qui sont indisponibles. Une source en panne est signalée avec son
erreur, jamais masquée par une réponse vide. Un jeton refusé (HTTP 401/403) n'est jamais caché derrière des données en
cache.

## Installation

Vous avez besoin de Node.js 20.19+ (ou 22.13+, ou 24+) et de Git.

```bash
git clone https://github.com/ms-spown/sc-copilot-mcp.git
cd sc-copilot-mcp
npm ci --ignore-scripts      # toujours --ignore-scripts : aucune dépendance n'a besoin de script d'installation
npm run build
```

1. **Jeton UEX.** Créez-en un sur <https://uexcorp.space/api/apps>, copiez `.env.example` vers `.env` dans ce dossier,
   puis collez-le après `UEXTOKEN=`. Le serveur lit uniquement ce fichier `.env`, jamais celui du répertoire courant.
   Sans jeton, les points d'accès publics d'UEX répondent quand même ; le jeton sert uniquement à votre propre quota.
   Utilisez la clé de _lecture_. N'utilisez jamais la clé de soumission distincte d'UEX : ce serveur ne dispose d'aucun
   outil d'écriture vers UEX.
2. **Claude Desktop.** L'installateur fusionne une seule entrée dans votre configuration sans toucher au reste :

   ```bash
   npm run install:claude -- --install-dir "C:\path\to\StarCitizen\LIVE"   # simulation (dry run) : affiche l'entrée sans rien écrire
   npm run install:claude -- --install-dir "C:\path\to\StarCitizen\LIVE" --apply
   ```

   `--apply` sauvegarde d'abord `claude_desktop_config.json` vers un fichier horodaté `.bak-…`, puis ajoute ou met à
   jour uniquement `mcpServers["sc-copilot"]`. Vos autres serveurs ne sont ni affichés ni modifiés, et aucun secret n'y
   est inscrit. Omettez `--install-dir` pour laisser la lecture du journal de jeu désactivée. Redémarrez Claude Desktop
   ensuite. Sur macOS ou Linux, passez `--config <path>`, ou ajoutez la même entrée manuellement :

   ```json
   {
     "mcpServers": {
       "sc-copilot": {
         "command": "node",
         "args": ["/path/to/sc-copilot-mcp/dist/index.js"],
         "env": { "SCMCP_PROFILES": "core,trade,data,local" }
       }
     }
   }
   ```

3. **Vérification.** `npm run doctor` vérifie votre installation (Node, compilation, jeton, configuration Claude,
   journal de jeu, fichier de flotte) et explique comment corriger chaque problème ; rien n'est envoyé sur le réseau et
   aucun secret n'est affiché. `npm run check:sources` interroge chaque source de données sur sa version et vérifie les
   fichiers et champs attendus par les outils. Dans Claude, demandez `sc_data_status`.

## Outils (48)

Claude en voit 43 par défaut : `sc_live_state`, `sc_live_events`, `sc_live_dashboard`, `sc_live_poll` et
`sc_live_mark` ne sont listés que lorsque la télémétrie en direct est activée (les trois derniers exigent aussi un
client capable de les afficher, comme Claude Desktop).

Référence complète des paramètres : **[docs/TOOLS.md](docs/TOOLS.md)** (générée depuis le code). Par thème :

| Thème                                            | Outils                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fraîcheur**                                    | `sc_data_status` : version du jeu par source, ancienneté, écarts entre sources et sources indisponibles                                                                                                                                                                                                                                                                                                                       |
| **Commerce** (UEX)                               | `uex_get_trade_routes` (adapté à votre vaisseau ou à votre soute, profit calculé pour la cargaison qui rentre, relevés joueurs derrière chaque prix), `uex_get_commodity_prices`, `uex_get_commodity_averages`, `uex_get_commodity_ranking`, `uex_get_commodities`, `uex_get_terminals`, `uex_get_terminal_inventory`, `uex_search_marketplace`, `uex_get_ship_prices`, `uex_get_game_versions`, `scw_search_ships_by_vendor` |
| **Vaisseaux et objets** (Wiki)                   | `scw_get_vehicle`, `scw_get_item`, `scw_get_ship_comparison`, `scw_list_vehicles`, `scw_list_items`, `scw_get_filters`, `scw_search`, `scw_snapshot_save`, `scw_snapshot_list`, `scw_snapshot_diff`, `sc_get_vocabulary`                                                                                                                                                                                                      |
| **Missions, artisanat, minage** (SCMDB)          | `scmdb_search_missions`, `scmdb_search_crafting`, `scmdb_search_mining`, `scmdb_changes`                                                                                                                                                                                                                                                                                                                                      |
| **Patchs et lore**                               | `sc_patch_notes` (notes d'une mise à jour, par section ou mot-clé), `sct_search`, `sct_get_article`, `sc_list_builds`, `sc_diff_versions`                                                                                                                                                                                                                                                                                     |
| **Votre journal de jeu** (désactivé par défaut)  | `sc_log_context` (ce que vous faites actuellement), `sc_log_recent_events`, `sc_log_sessions`, `sc_log_status`                                                                                                                                                                                                                                                                                                                |
| **Télémétrie en direct** (désactivée par défaut) | `sc_live_status` (toujours listé : l'état et comment l'activer), `sc_live_state`, `sc_live_events` (listés seulement avec `SC_TELEMETRY=on`), `sc_live_dashboard`, `sc_live_poll`, `sc_live_mark` (le tableau de bord en direct, dans Claude Desktop uniquement)                                                                                                                                                                                                                                                                                  |
| **Votre flotte**                                 | `sc_fleet_get`, `sc_fleet_upsert`, `sc_fleet_remove`                                                                                                                                                                                                                                                                                                                                                                          |
| **Vos propres fichiers de données**              | `sc_local_datasets`, `sc_search_local`, `sc_read_local_collection`                                                                                                                                                                                                                                                                                                                                                            |

### Profils

`SCMCP_PROFILES` sélectionne les outils exposés (séparés par des virgules ; non défini = tout exposer). `sc_data_status`
est toujours inclus. `SCMCP_TOOLS` (liste explicite de noms) l'emporte sur les profils ; un nom inconnu arrête le
serveur au démarrage au lieu d'exposer une liste vide. Ce filtrage sert à la rapidité, pas à la sécurité : un outil non
listé reste appelable.

| Profil    | Outils | Usage                                                                                             |
| --------- | ------ | ------------------------------------------------------------------------------------------------- |
| **core**  | 14     | Le copilote au quotidien : statut, vaisseaux, bases du commerce, missions, notes de patch, flotte |
| **trade** | 12     | La boîte à outils complète du marché UEX                                                          |
| **data**  | 16     | Données de référence, artisanat, minage, historique des patchs, navigation sur le wiki            |
| **local** | 11     | Votre journal de jeu, votre flotte, vos propres fichiers de données                               |

Le choix des profils et instructions recommandées est détaillé dans
[docs/USING_WITH_CLAUDE.fr.md](docs/USING_WITH_CLAUDE.fr.md) ; la description de chaque outil précise ce qu'il renvoie
et ses limites.

## Prompts

Le serveur propose également des prompts prêts à l'emploi (dans Claude Desktop, ils apparaissent comme modèles
sélectionnables), chacun enchaînant les bons outils dans le bon ordre et demandant à Claude d'indiquer la fraîcheur des
données :

| Prompt            | Fonction                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `haul_plan`       | Les 3 meilleures routes commerciales pour l'un de vos vaisseaux, avec les risques (peu de relevés, données anciennes, profit suspect, cargaison illégale) |
| `patch_briefing`  | Ce que la dernière mise à jour a changé et ce que cela implique pour vous et votre flotte                                                                 |
| `session_debrief` | Ce que vous avez fait lors de votre dernière session d'après votre journal de jeu, et quoi faire ensuite                                                  |
| `mining_prep`     | Les statistiques et gisements d'un minerai, le bon laser et les bons modules, et où le vendre                                                             |
| `mission_hunt`    | Missions par lieu, faction, récompense ou plan (blueprint), et quel vaisseau de votre flotte convient                                                     |

## Configuration

| Variable                                                         | Rôle                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UEXTOKEN`                                                       | Jeton bearer UEX dans `.env`. Envoyé uniquement aux hôtes UEX                                                                                                                              |
| `SCMCP_PROFILES`, `SCMCP_TOOLS`                                  | Quels outils exposer (voir ci-dessus)                                                                                                                                                      |
| `SC_INSTALL_DIR`                                                 | Dossier d'un canal tel que `…\StarCitizen\LIVE` : active `sc_log_*` sur son `Game.log`. Désactivé si non défini                                                                            |
| `SC_TELEMETRY`                                                   | `on` active la télémétrie en direct optionnelle, côté serveur. Désactivée si absente (voir plus bas)                                                            |
| `SC_GAME_LOG_PATH`                                               | Un fichier `.log` précis à la place (seuls les fichiers `.log` sont acceptés)                                                                                                              |
| `SCMCP_FLEET_FILE`                                               | Fichier de flotte (par défaut `%APPDATA%\sc-copilot-mcp\fleet.json`)                                                                                                                       |
| `SCMCP_CACHE_DIR`, `SCMCP_DATA_DIR`, `SCMCP_CONFIG_DIR`          | Dossiers de cache (réponses HTTP, dumps, SCMDB), de données (snapshots wiki) et de configuration. Par utilisateur par défaut (`%LOCALAPPDATA%` / `%APPDATA%` sous Windows, XDG sous Linux) |
| `SCMCP_UEX_BASE_URL`, `SCMCP_SCW_BASE_URL`, `SCMCP_SCT_BASE_URL` | Remplace une URL de base d'API. Doit être en https sur un hôte autorisé, sinon le serveur refuse de démarrer                                                                               |
| `SCMCP_SCMDB_REPO`, `SCMCP_DATA_REPO`, `SCMCP_DATA_REPO_PATH`    | Dépôts d'où sont lus SCMDB et les dumps de patch                                                                                                                                           |
| `SCMCP_GITHUB_TOKEN`                                             | Optionnel, augmente la limite de requêtes GitHub. Dédié : un `GITHUB_TOKEN` ambiant n'est jamais utilisé                                                                                   |
| `SCMCP_GAME_DATA_DIR`                                            | Dossier contenant les fichiers `game-*.json` dont vous disposez déjà, pour `sc_*_local` (voir limites)                                                                                     |

## Le journal de jeu

Désactivé tant que `SC_INSTALL_DIR` ou `SC_GAME_LOG_PATH` n'est pas défini. Lecture seule, sans verrouillage (le jeu
continue d'écrire), sans code réseau, et aucune donnée personnelle capturée (aucun pseudonyme, identifiant de compte ni
chemin personnel dans les réponses).

Événements pris en charge, observés dans de vrais journaux entre les patchs 4.0 et 4.10 : démarrage et arrêt de
session, connexion, changements de juridiction et de zone (armistice, espace surveillé, propriété privée), contrats
acceptés, terminés, échoués ou abandonnés (suivis via leur identifiant de mission), objectifs, enlèvements et livraisons
de fret, plans (blueprints) reçus, achats en boutique, déclarations d'assurance, demandes et files d'attente de hangar,
vaisseau dont vous avez rejoint ou quitté le canal de communication, et transits par points de saut entre systèmes.
`sc_log_context` résume ces événements en « ce que je fais maintenant », et `sc_log_sessions` sous forme de tableau de
vos sessions récentes.

**Absent du journal, donc jamais rapporté :** voyage quantique ordinaire, combats et éliminations, solde du
portefeuille, position exacte, décès. Chaque champ de contexte correspond à « la dernière fois où le jeu l'a écrit »,
et non à une lecture temps réel. Les lignes inconnues sont ignorées et comptabilisées. CIG ne garantit pas la stabilité
du format ; `npm run check:sources` vérifie que l'en-tête se parse toujours.

## Télémétrie en direct (optionnelle, désactivée par défaut)

Le jeu contient un serveur de télémétrie local non documenté. Si vous le choisissez, ce serveur peut le lire pour que
Claude réponde sur votre vaisseau et votre personnage à l'instant : vitesse, altitude, hydrogène, train
d'atterrissage, alimentation, voyants, santé, faim, soif.

- **Désactivée tant que vous n'activez pas deux choses :** `SC_TELEMETRY=on` dans l'entrée du serveur, et
  `GRPC_CLIENT_SERVER_ENABLED=true` dans l'environnement du RSI Launcher. Rien n'est réglé par l'installation ni par
  une mise à jour. Sans le premier, aucune connexion n'est jamais tentée.
- **Une commande :** `npm run telemetry -- status` montre les deux interrupteurs sans rien changer.
  `npm run telemetry -- enable` est une simulation, `npm run telemetry -- enable --apply` l'exécute et
  `npm run telemetry -- disable --apply` annule ce qu'elle a réglé. Quittez ensuite complètement le RSI Launcher
  (icône de la barre des tâches comprise) et relancez-le.
- **Ce qu'elle ne fait jamais :** parler à autre chose que `127.0.0.1:2942`, envoyer au jeu autre chose qu'une requête
  vide, ni journaliser, stocker ou envoyer les trames. Tout reste en mémoire.
- **Ce qu'elle ne voit pas :** position, valeur des boucliers, coque, chaleur, munitions, répartition de puissance ou
  carburant quantique. Une santé à 0 veut dire à terre ou mort. Le solde aUEC n'est pas transmis à Claude sans votre
  accord (`include_balance`).
- **Un tableau de bord en direct (optionnel).** Avec la télémétrie activée, Claude Desktop peut afficher un tableau
  de bord en direct dans la conversation (`sc_live_dashboard`) : le vaisseau, trois cadrans, les alertes du moment (boucliers
  coupés en mode quantique, énergie perdue, verrouillage hostile...) et un verdict en une ligne en vue compacte ; un
  cockpit avec cadrans, boussole, schéma d'alimentation, voyants, armes, constantes du pilote et une seule
  chronologie en plein écran. Seul le tableau de bord le plus récent interroge les données ; les plus anciens le
  suivent. Chaque valeur indique son âge, rien n'est inventé, le solde aUEC reste masqué tant que vous ne cliquez pas,
  et rien n'est envoyé au jeu. Claude Code
  ne l'affiche pas. Voir [docs/TELEMETRY.fr.md](docs/TELEMETRY.fr.md#tableau-de-bord-en-direct).
- **Lisez d'abord les risques.** C'est une fonction non documentée du jeu. À notre connaissance, CIG ne l'a ni
  autorisée ni interdite, les conditions de RSI s'appliquent à vous, et le risque est le vôtre. Tout est dans
  [docs/TELEMETRY.fr.md](docs/TELEMETRY.fr.md).

## Limites à connaître

- **Les prix participatifs peuvent être erronés.** Lisez `data_age` (`null` signifie qu'UEX n'a fourni aucune date) et le `updated_at` de chaque ligne, et vérifiez la
  cohérence d'une route avant de décoller avec 696 SCU.
- **L'historique des patchs est succinct.** Le dépôt de dumps ne conserve actuellement que deux builds non étiquetés, de
  sorte que `sc_diff_versions` a peu d'éléments à comparer. `scmdb_changes` est l'outil recommandé pour savoir « ce qui
  a changé ».
- **Le PTU est étiqueté, jamais mélangé.** SCMDB dispose des données PTU ; UEX et le wiki n'en ont pas.
- **Les sources se mettent à jour à des rythmes différents.** Les builds peuvent diverger pendant quelques heures ou
  quelques jours ; `sc_data_status` le signale.
- **`sc_*_local` lit uniquement les fichiers dont vous disposez déjà** dans `SCMCP_GAME_DATA_DIR`. Ce projet n'extrait
  aucun fichier du jeu et ne documente pas comment le faire ; la sûreté d'une telle extraction vis-à-vis de votre
  compte n'est pas vérifiée (voir [SECURITY.md](SECURITY.md)).
- **La télémétrie en direct n'est pas un tableau de bord complet.** Ni position, ni boucliers, ni coque, ni chaleur,
  ni munitions ; les véhicules terrestres n'envoient rien et les événements sont déduits (voir
  [docs/TELEMETRY.fr.md](docs/TELEMETRY.fr.md)).
- La recherche de noms sur le wiki est stricte ; l'outil de flotte effectue une correspondance par mots et propose des
  candidats en cas d'ambiguïté.

## Documentation

- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) : tout ce que le serveur sait faire, par besoin
- [docs/TOOLS.md](docs/TOOLS.md) : chaque outil et chaque paramètre (généré)
- [docs/TELEMETRY.fr.md](docs/TELEMETRY.fr.md) : la télémétrie en direct optionnelle, ses données et ses risques
- [docs/USING_WITH_CLAUDE.fr.md](docs/USING_WITH_CLAUDE.fr.md) : le bloc à coller dans un projet Claude
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [docs/ADDING_A_TOOL.md](docs/ADDING_A_TOOL.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) et [SECURITY.md](SECURITY.md)

## Dépannage

Consultez [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Premières étapes : `npm run doctor`, puis
`npm run check:sources`.

## Développement

```bash
npm ci --ignore-scripts && npm run lint && npm test && npm run build && npm run audit:prod
```

Voir [CONTRIBUTING.md](CONTRIBUTING.md), y compris la procédure lors d'un nouveau patch. Modèle de sécurité :
[SECURITY.md](SECURITY.md).

## Crédits et mentions légales

Voir [NOTICE](NOTICE) et [THIRD_PARTY.md](THIRD_PARTY.md). Données issues de [UEX Corp](https://uexcorp.space/), du
[Star Citizen Wiki](https://star-citizen.wiki/), de [Star Citizen Tools](https://starcitizen.tools/), de
[SCMDB](https://github.com/KrovaxCode/SCMDB_DATA) et du dépôt communautaire de dumps ; merci à chacun d'entre eux.

<p align="center">
  <a href="https://uexcorp.space/"><img src="image.png" alt="Powered by UEX" height="30"></a>
</p>

<p align="center">
  Ceci est un projet de fans Star Citizen non officiel, non approuvé par ni affilié au groupe de sociétés Cloud
  Imperium ou Roberts Space Industries. Tous les contenus et éléments du jeu sont la propriété de Cloud Imperium Rights
  LLC et Cloud Imperium Rights Ltd. Star Citizen&reg;, Squadron 42&reg;, Roberts Space Industries&reg; et Cloud
  Imperium&reg; sont des marques déposées de Cloud Imperium Rights LLC. Tous droits réservés.
</p>
