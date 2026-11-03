# Télémétrie en direct

[English](TELEMETRY.md) · Français

Un moyen optionnel, **désactivé par défaut**, pour sc-copilot-mcp de voir ce que le jeu en cours rapporte sur votre
vaisseau et votre personnage : vitesse, altitude, carburant, alimentation, voyants d'alerte, santé, portefeuille.
Lisez cette page en entier avant de l'activer, en particulier les [Risques](#risques).

## Ce que c'est, et d'où cela vient

Star Citizen 4.10.2 et les versions suivantes contiennent un petit serveur local qui diffuse la télémétrie propre au
jeu. Il est **non documenté par CIG** : ce n'est pas une fonction prise en charge, il est inactif tant qu'une variable
n'est pas définie dans l'environnement du jeu, et il peut changer ou disparaître à n'importe quel patch.

| | |
| --- | --- |
| Adresse | `127.0.0.1:2942`, gRPC sur HTTP/2, sans TLS, sans jeton |
| Service | `sc.game.telemetry.v1.GameTelemetryService`, méthode `TelemetryStream` (flux serveur) |
| Requête | un message vide. C'est la seule chose que ce projet envoie jamais au jeu |
| Cadence | environ 17 trames par seconde une fois votre personnage apparu ; rien dans les menus ni les écrans de chargement |
| Clients | le jeu en accepte plusieurs à la fois |
| Interrupteur côté jeu | `GRPC_CLIENT_SERVER_ENABLED=true` dans l'environnement de `StarCitizen.exe`, hérité du RSI Launcher |
| Preuve qu'il est actif | `Game.log` contient `Service 'sc.game.telemetry.v1.GameTelemetryService' registered` |

Ce que nous savons du schéma et des particularités du flux vient du travail d'autres personnes, pas du nôtre : le
test de terrain de Mallachi (Diftic) et le projet Wingman AI de ShipBit. Voir les [Remerciements](#remerciements).
Nous n'avons rien extrait du jeu nous-mêmes, et ce dépôt ne contient aucun code d'extraction.

## Deux interrupteurs, tous deux explicites

Rien n'est activé en installant ou en mettant à jour ce serveur. Il vous faut les deux :

1. **Côté serveur** : `SC_TELEMETRY=on` (également acceptés : `1`, `true`, `yes` ; toute autre valeur, ou rien, signifie désactivé) dans l'`env` de l'entrée `sc-copilot` de votre configuration MCP.
2. **Côté jeu** : `GRPC_CLIENT_SERVER_ENABLED=true` dans l'environnement du RSI Launcher, puis quittez le launcher
   **complètement** (y compris depuis la zone de notification de la barre des tâches) et relancez-le, car le jeu hérite de la variable depuis lui.

Sans l'interrupteur 1, le serveur ne charge aucun code gRPC ni HTTP/2 et ne se connecte jamais au port 2942
(`npm run check:telemetry-silence` le démontre sur votre machine). Sans l'interrupteur 2, le jeu n'écoute pas, et
le lecteur attend simplement.

### Une commande (Windows)

```bash
npm run telemetry -- status              # lecture seule : montre les deux interrupteurs et le port
npm run telemetry -- enable              # simulation : montre ce qui changerait
npm run telemetry -- enable --apply      # l'applique
npm run telemetry -- disable --apply     # annule ce que l'outil a fait
```

- `enable --apply` définit la variable **utilisateur** Windows `GRPC_CLIENT_SERVER_ENABLED=true` et ajoute
  `SC_TELEMETRY=on` à l'entrée `sc-copilot` de `claude_desktop_config.json`, en modifiant cette seule clé et en
  conservant une sauvegarde horodatée du fichier. Elle ne remplace jamais le fichier, qui contient vos autres serveurs.
- `disable --apply` ne retire que ce que l'outil a défini. Une variable que vous avez définie à la main reste, et la
  commande indique comment la retirer.
- Les deux commandes sont des simulations tant que vous ne passez pas `--apply`. Redémarrez Claude Desktop après un
  changement de sa configuration.

### Pour un seul lancement (`--session`)

```bash
npm run telemetry -- enable --session
```

Crée un petit script de lancement qui définit la variable uniquement pour le RSI Launcher qu'il démarre. Rien de
permanent n'est défini sur votre compte utilisateur, mais vous devez toujours démarrer le launcher par ce script, et
un launcher déjà ouvert dans la zone de notification le met en échec.

### À la main

- **Windows** : Paramètres > Système > Informations système > Paramètres système avancés > Variables d'environnement >
  ajoutez la variable utilisateur `GRPC_CLIENT_SERVER_ENABLED` = `true`. Ajoutez `"env": { "SC_TELEMETRY": "on" }` à
  l'entrée `sc-copilot`. Quittez et relancez le launcher et Claude Desktop.
- **Linux (Lutris, Steam)** : non testé par nous. Lutris : Configure > System options > Environment variables. Steam :
  options de lancement `GRPC_CLIENT_SERVER_ENABLED=true %command%`. Sous Wine ou Proton, le port du jeu devrait être
  celui de l'hôte, ce que nous n'avons pas vérifié.

## Ce que contient le flux

Le statut dans les tableaux vient du test de terrain publié (jeu 4.10.2 LIVE, octobre 2026) : **fiable** = vu en
train de changer avec des valeurs réelles ; **non vérifié** = présent mais jamais vu en train de changer, ou jamais
testé.

### Fiable

| Donnée | Remarques |
| --- | --- |
| Vitesse, vitesse verticale | m/s |
| Altitude | mètres ; n'a de sens que dans le repère d'une planète. Le jeu envoie 3.4e38 pour « pas de planète » et nous l'écartons |
| Cap | degrés, **uniquement dans le repère d'une planète** et pas pendant un saut quantique (il se fige) |
| Force G | actuelle et maximale |
| Hydrogène, boost | le boost est engagé / puissance / réserves / critique |
| Train d'atterrissage, VTOL | rentré, en sortie, sorti, en rentrée |
| Modes de vol | couplé, ESP, anti-G, limiteur de vitesse, croisière, compensation de gravité, chacun activé et actif |
| Quantique | le voyant QDRV indique que le mode quantique est actif ; un saut est déduit du voyant moteur, de G nul et de l'absence d'atterrissage |
| Alimentation | neuf indicateurs marche/arrêt (générateurs, moteurs, armes, refroidisseurs, support de vie, gravité, capteurs, générateurs de bouclier et émetteurs). Aucune quantité |
| Voyants d'alerte | THR, SHLD, PROX, HIT, RADR, QDRV sont compris ; pour WPN, seul « pas d'alimentation » est utilisé. Un voyant RADR signale un verrouillage hostile |
| Armes par siège | nom, alimentée, prête à tirer |
| Contre-mesures | nombre de leurres et de bruiteurs |
| Vaisseau et siège | nom et identifiant d'instance du vaisseau, nom du siège, rôle d'équipage |
| Pilote | santé, faim, soif, fréquence cardiaque, locomotion (à pied, EVA, assis), gravité, pression, température extérieure, respirable ou non |
| Portefeuille | solde aUEC |

### Absent du flux, ou jamais renseigné

Position et direction de la caméra. Niveau des boucliers, santé de la coque et des composants, chaleur, munitions,
condensateur, répartition de puissance, carburant quantique. Portes, préréglages d'armes, retour de force, missiles.
**Événements de mort** : le jeu n'en envoie aucun, et une santé à 0 veut dire « à terre ou mort » sans moyen de
savoir lequel. Les véhicules terrestres (l'Ursa a été testé) n'envoient aucune donnée de véhicule, seulement le nom
du siège.

### Présent mais non vérifié

Oxygène, température corporelle, niveau d'intoxication, radiation, voyants PWR / COOL / MISL, hydrogène bientôt
épuisé, atmosphère irrespirable. Ils sont renvoyés sous `unverified` ou comme événements marqués `unverified`. Ne
raisonnez pas à partir d'eux.

### Particularités que le serveur gère pour vous

- Un champ que le jeu n'envoie pas est omis, jamais affiché comme 0. Dans une section présente, un nombre manquant
  vaut réellement la valeur par défaut (un vaisseau posé n'envoie pas de `speed` : elle vaut 0).
- Le cap et l'altitude radar sont écartés quand ils ne sont pas valides ; le va-et-vient EVA et à pied est lissé ;
  les voyants d'alerte sont filtrés contre les rebonds ; un nouveau véhicule démarre une base de référence silencieuse,
  de sorte que monter à bord ne produit pas une rafale d'événements.
- Les données du véhicule arrivent 6 à 9 secondes après que vous vous êtes assis.
- La première trame après un changement de siège peut porter des réglages périmés.

## Ce que les outils en font

| Outil | Listé | Rôle |
| --- | --- | --- |
| `sc_live_status` | toujours | L'état du flux, pourquoi, et comment l'activer |
| `sc_live_state` | quand `SC_TELEMETRY=on` | Un instantané avec l'âge de la dernière trame et ce qui n'est pas disponible |
| `sc_live_events` | quand `SC_TELEMETRY=on` | Les événements dérivés récents, chacun marqué `confirmed` ou `unverified` |
| `sc_live_dashboard` | quand `SC_TELEMETRY=on` et que le client sait afficher des Views | Ouvre le [tableau de bord en direct](#tableau-de-bord-en-direct) dans la conversation |
| `sc_live_poll`, `sc_live_mark` | idem | Utilisés par le tableau de bord lui-même pour se rafraîchir et poser des repères de session. Claude a pour consigne de ne pas les appeler |

États : `off` (interrupteur serveur non défini), `waiting` (rien ne répond sur le port), `game_without_telemetry` (le
jeu tourne, `Game.log` n'a pas de ligne d'enregistrement : relancez le launcher), `connected` (port ouvert, pas encore
de trames), `live`, `incompatible` (le jeu répond sous une forme que nous ne connaissons pas : un patch l'a changée).

Le lecteur démarre à la première requête, se reconnecte avec un délai croissant, s'arrête après cinq minutes sans
requête, et garde tout en mémoire uniquement. Les événements n'existent que pendant le temps où le serveur tournait
tandis que le jeu envoyait des trames, et ils sont déduits, non rapportés par le jeu.

## Tableau de bord en direct

Une vue en direct optionnelle du même flux, dessinée dans la conversation : votre vaisseau, la vitesse, l'hydrogène,
la santé et l'état du flux en un coup d'œil, et, en plein écran, les instruments, les voyants d'alerte, les
indicateurs d'alimentation, les armes par siège, les contre-mesures, les constantes vitales, les événements récents
et une chronologie de session. C'est une MCP App : une petite page que ce serveur fournit et que le client affiche à
côté du chat.

- **Qui l'affiche.** Claude Desktop est l'hôte que nous avons testé (version Microsoft Store 4.4212.0, serveur déclaré
  dans `claude_desktop_config.json`). **Claude Code et les autres clients en mode texte ne l'affichent pas** : pour
  eux, les trois outils du tableau de bord ne sont pas listés du tout, donc le modèle ne les voit jamais. Le serveur
  ne les liste que lorsque `SC_TELEMETRY=on` ET que le client a déclaré l'extension MCP Apps au démarrage. D'autres
  hôtes qui affichent les MCP Apps peuvent fonctionner ; nous ne les avons pas essayés.
- **Comment l'ouvrir.** Activez la télémétrie (voir plus haut), redémarrez complètement Claude Desktop (quittez-le
  depuis la zone de notification, pas seulement la fenêtre), puis demandez à Claude d'ouvrir le tableau de bord en
  direct. Claude appelle `sc_live_dashboard`. Tant qu'il est ouvert, vous pouvez continuer à parler à Claude : il
  répond à partir de `sc_live_state`, pas à partir de la page.
- **Deux modes.** En ligne : une vue compacte avec cinq données (vaisseau, vitesse, hydrogène, santé, solde), l'état
  du flux et une bande des alertes récentes. En plein écran (bouton dans la page) : le panneau complet. Le bouton
  interroge l'hôte ; si l'hôte répond avec un autre mode, la page suit ce qu'on lui dit.
- **Âge et lacunes.** Chaque valeur est accompagnée de l'âge de sa trame, et tout passe en gris quand le flux n'est
  pas en direct. Rien n'est inventé : un champ manquant s'affiche sous la forme d'un tiret, une santé à 0 se lit
  « à terre ou mort », et une ligne repliable énumère ce que le flux ne contient pas (cargaison, position, niveau des
  boucliers, coque, chaleur, munitions).
- **Les estimations sont signalées.** L'hydrogène restant, la faim et la soif sont des estimations en ligne droite sur
  les dernières minutes, affichées avec leur fenêtre. Le rythme (aUEC par heure) et le temps de vol viennent de la
  variation du solde et des événements de décollage et d'atterrissage depuis le repère de session. La variation du
  solde mêle achats, récompenses et amendes, et le jeu ne mesure pas la cargaison : c'est la seule mesure d'une
  tournée.
- **Plan de route.** Après `uex_get_trade_routes`, Claude peut passer un `plan` (marchandise, terminaux d'achat et de
  vente, SCU, profit attendu, une courte note) à l'ouverture du tableau de bord. La page montre le profit prévu à
  côté du profit mesuré. Le texte est nettoyé et plafonné (60 caractères) et affiché en texte brut.
- **Confidentialité du solde.** Le solde est masqué dans la page tant que vous ne cliquez pas sur « Afficher le
  solde ». C'est seulement alors que la page le demande au serveur (`include_balance`). Le solde n'est jamais mis
  dans le résumé automatique que la page peut envoyer au modèle, ni dans les messages fixes des boutons, avec une
  exception : le bouton « Route avec mon solde et ce vaisseau » l'envoie dans un message, le dit dans le texte, et
  seulement quand vous l'appuyez.
- **Ce que font les boutons.** « Analyser ma situation », « Route avec mon solde et ce vaisseau » et « Bilan de
  session » publient un court message fixe dans la conversation, comme si vous l'aviez tapé, demandant à Claude
  d'utiliser `sc_live_state` et `sc_live_events`. Les repères de session (début, fin, remise à zéro de la variation
  du solde) vivent dans la mémoire de ce serveur. Rien dans la page n'envoie quoi que ce soit au jeu.
- **Charge.** La page interroge le serveur environ une fois par seconde tant qu'elle est visible (jamais plus de
  deux fois par seconde), toutes les 5 secondes quand le flux est arrêté ou coupé. Elle s'arrête quand la fenêtre est
  masquée ou que la View sort de l'écran, et abandonne définitivement après 30 minutes d'absence jusqu'à ce que vous
  cliquiez sur « Reprendre ». Claude Desktop conserve chaque tableau de bord qu'il a ouvert dans la conversation, il
  peut donc en exister plusieurs : le serveur les sert tous à partir d'une seule lecture, mise en cache pendant une
  demi-seconde.
- **Pas de réseau, pas de paquet.** La page est un seul fichier à l'intérieur de ce serveur : pas de CDN, pas de
  police, pas de requête. Elle déclare sa propre politique de contenu restrictive et définit chaque texte avec
  `textContent`.

Le tableau de bord montre ce que montre le flux et hérite de chaque limite et de chaque risque de cette page. Nous
ne prétendons pas qu'il soit approuvé par Cloud Imperium Games.

Un aperçu pour les personnes qui travaillent sur la page : `npm run build`, puis `node scripts/dashboard-preview.mjs`,
puis ouvrez l'adresse locale qu'il affiche (boucle locale, port 4173 par défaut). Il joue un vol fictif face à un hôte
factice ; ni jeu ni Claude n'interviennent.

## Confidentialité

- Le flux est **non chiffré et lisible par n'importe quel programme de votre PC** tant qu'il est actif. Il est lié à
  la boucle locale, il n'est donc pas joignable depuis le réseau.
- Il contient votre santé, votre vaisseau et votre **solde aUEC**. Il ne contient pas votre position.
- Ce serveur ne journalise jamais les trames, ne les écrit jamais sur disque et ne les envoie jamais sur un réseau.
  Ses diagnostics ne contiennent que des numéros de champs.
- **Les résultats des outils font partie de votre conversation avec Claude**, qui est envoyée à Anthropic. Pour cette
  raison, le solde est retenu sauf si l'outil est appelé avec `include_balance`, et Claude a pour consigne de vous
  demander d'abord. Ce que vous laissez Claude lire est ce qui quitte votre machine.

### Limites face à un programme qui se fait passer pour le jeu

Le port 2942 n'a aucune authentification : n'importe quel programme local peut y répondre. Le lecteur traite donc le
flux comme une entrée non fiable et le borne. Les chiffres sont dans le code (`decode.ts`, `reader.ts`, `service.ts`,
`events.ts`, `tools/telemetry.ts`) et testés avec un faux jeu ; de vraies trames ne sont jamais utilisées.

| Quoi | Limite | Quand elle est dépassée |
| --- | --- | --- |
| Un message | 1 MiB (la longueur déclarée est vérifiée avant d'attendre le corps) | Le flux est signalé `incompatible` |
| Champs lus dans une trame (messages imbriqués compris) | 5 000 | La trame est refusée et comptée dans `frames_rejected` |
| Armes par trame | 64 | Le reste n'est pas décodé ; l'anomalie `WeaponsFrame.weapons: more than 64 entries, the rest ignored` est listée |
| Entrées de contre-mesures par trame | 16 | Idem, avec `WeaponsFrame.countermeasures` |
| Événements du jeu par trame | 32 | Idem, avec `EventsFrame.events` |
| Trames décodées par seconde | Environ 33 (au plus une toutes les 30 ms) | Les trames qui arrivent plus vite sont comptées dans `frames_received`, mais seule la plus récente d'une rafale est décodée, dans le créneau suivant (celles d'entre deux ne sont jamais décodées). Le jeu en envoie environ 17 par seconde, rien ne change donc en usage normal |
| Noms (vaisseau, siège, arme) | 64 caractères parmi `[A-Za-z0-9_.-]` | Remplacés par `(unrecognised name)` |
| Texte conservé dans un événement | 80 caractères par valeur | Coupé |
| Tampon d'événements | 200 événements | Les plus anciens sont supprimés |
| Types de contre-mesures suivis | 8 | Les nouveaux types sont ignorés |
| Une réponse `sc_live_state` / `sc_live_events` | 40 000 caractères de contenu (avant l'enveloppe de provenance) | La liste des armes ou les événements les plus anciens sont coupés, et la réponse le dit |

Une trame qui dépasse un plafond est quand même utilisée pour le reste de son contenu, mais elle compte comme une
mauvaise trame : cinq de suite et l'état devient `incompatible`.

## Risques

Rédigée pour n'être ni alarmiste ni rassurante. Ceci n'est pas un avis juridique.

- **C'est une fonction non documentée.** CIG ne l'a ni annoncée, ni prise en charge, ni documentée. Elle peut changer
  ou être retirée à n'importe quel patch, et cette fonction cesse alors de marcher (l'état devient `incompatible` ou
  `waiting`).
- **CIG ne l'a ni autorisée ni interdite**, à notre connaissance. Nous n'avons trouvé aucune déclaration dans un sens
  ni dans l'autre.
- **Les conditions de RSI s'appliquent à vous.** Lisez les Conditions d'utilisation (Terms of Service) et les règles
  sur les outils tiers et sur les fonctions non documentées ou non approuvées. Nous ne pouvons pas vous dire si elles
  couvrent ce cas.
- **Le jeu peut le voir.** Techniquement, le jeu sait que le réglage est activé et qu'un client est connecté. Nous ne
  savons pas ce qui, le cas échéant, est remonté vers les serveurs de CIG.
- **Aucune sanction trouvée, ce qui n'est pas une garantie.** Au moment de la rédaction, nous n'avons trouvé aucun
  signalement de compte sanctionné pour cela. Cela ne dit rien de l'avenir.
- **Le risque est le vôtre.** Utiliser cette fonction est votre décision et votre responsabilité.
- En cas de doute, demandez au support de RSI avant de l'activer, et laissez-la désactivée jusqu'à ce que vous ayez
  une réponse.

Nous ne prétendons pas qu'elle soit sûre, indétectable ou approuvée par Cloud Imperium Games. Elle n'est rien de tout
cela, pour autant que nous puissions l'établir.

## Dépannage

| Symptôme | Cause probable | Que faire |
| --- | --- | --- |
| `sc_live_status` indique `off` | L'interrupteur serveur n'est pas défini | `npm run telemetry -- enable --apply`, redémarrez Claude Desktop |
| `waiting`, jeu non lancé | Rien à lire | Lancez le jeu |
| `waiting` ou `game_without_telemetry`, jeu lancé | Le jeu a été démarré sans la variable | Quittez complètement le RSI Launcher, icône de la zone de notification comprise, relancez-le, lancez le jeu. Cherchez la ligne « registered » dans `Game.log` |
| `connected` mais aucune donnée | Menus ou chargement | Faites apparaître votre personnage. Les données commencent une fois le personnage créé |
| `live` mais aucune donnée de vaisseau | Vous êtes à pied ou dans un véhicule terrestre | Asseyez-vous dans un vaisseau. Les données du véhicule arrivent 6 à 9 secondes plus tard |
| `incompatible` | Un patch a changé le schéma | Mettez le serveur à jour ; signalez-le avec la version du jeu |
| Port 2942 utilisé par autre chose | Un autre client de télémétrie n'est pas le problème (plusieurs sont permis) ; un autre programme, si | `npm run telemetry -- status` et vos outils habituels pour les ports |

`npm run doctor` indique les deux interrupteurs, si le launcher doit être relancé, et l'état du port.

## Remerciements

- **Mallachi (Diftic)**, Star Citizen Telemetry skill pour Wingman AI et son rapport de test de terrain : la lecture
  du schéma, la liste de ce qui marche et de ce qui ne marche pas, et chacune des particularités ci-dessus. Référence
  en lecture seule, rien n'a été copié : `Diftic/wingman-skills`, branche `feat/sc-telemetry`,
  `sc_telemetry/TELEMETRY_REPORT.md`.
- **ShipBit, Wingman AI** (GPLv3) : `services/sc_telemetry/sc_telemetry.proto`, copié sans modification, avec
  attribution, dans `src/providers/telemetry/`, ainsi que la conception du lecteur et des règles d'événements,
  réécrites ici.
  https://github.com/ShipBit/wingman-ai

Le schéma a été reconstitué par un tiers à partir de données contenues dans le binaire du jeu. Nous n'avons pas
refait ce travail. Voir [THIRD_PARTY.md](../THIRD_PARTY.md).
