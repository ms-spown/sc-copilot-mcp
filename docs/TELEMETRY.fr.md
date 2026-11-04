# Télémétrie en direct

[English](TELEMETRY.md) · Français

Un moyen optionnel, **désactivé par défaut**, pour sc-copilot-mcp de voir ce que le jeu en cours rapporte sur votre
vaisseau et votre personnage : vitesse, altitude, carburant, alimentation, voyants d'alerte, santé, portefeuille.
Lisez cette page en entier avant de l'activer, en particulier les [Risques](#risques).

> **À lire en premier**
>
> - **Ce que c'est.** Un moyen optionnel de laisser Claude lire ce que le jeu en cours rapporte sur votre vaisseau et votre personnage (vitesse, carburant, alimentation, santé, portefeuille), grâce à une fonction locale non documentée de Star Citizen. C'est local, en lecture seule, et désactivé par défaut.
> - **Deux interrupteurs, tous deux à vous.** `SC_TELEMETRY=on` dans l'entrée du serveur, et `GRPC_CLIENT_SERVER_ENABLED=true` pour le RSI Launcher ([détails](#deux-interrupteurs-tous-deux-explicites)). Ni l'installation ni une mise à jour n'en règle aucun.
> - **Risques.** CIG ne l'a ni autorisée ni interdite, les conditions de RSI s'appliquent à vous, et le risque est le vôtre : lisez les [Risques](#risques) (vers la fin de cette page) avant de l'activer.
> - **Non vérifié.** Le mainteneur n'a pas encore vu le tableau de bord lui-même dans Claude Desktop (voir [Qui l'affiche](#tableau-de-bord-en-direct)).
> - **L'éteindre.** `npm run telemetry -- disable --apply` (sans `--apply`, `enable` et `disable` sont des simulations qui n'écrivent rien). La commande ne retire que ce que l'outil a défini : une variable que vous avez définie à la main reste, et la commande indique comment la retirer. Redémarrez ensuite Claude Desktop, quittez complètement le RSI Launcher (icône de la zone de notification comprise) et relancez-le. Cela ne supprime pas vos sessions enregistrées.
> - **Ce qui est enregistré, et comment l'effacer.** Les trames et les lignes brutes du journal restent en mémoire et ne sont jamais écrites. La seule exception est le résumé de session : le solde au départ et à la dernière observation ; la version du jeu, les heures (dont la durée pendant laquelle le jeu a été vu en marche) et les coupures ; le dernier lieu et les dernières marchandises nommés par le journal ; votre note ; le nombre de prix refusés ; pertes de vaisseau : heure, modèle, cause, lieu, cargo présumé (SCU et aUEC payés) ; et, pour chaque trajet, son libellé (titre du contrat, lieux, marchandises), la quantité, le coût, le revenu, la marge, les frais, le net et le plan appliqué (profit prévu, quantité, terminaux). Il est gardé dans un fichier local, `sessions.json`, seulement quand la télémétrie est activée ; ce serveur ne l'envoie jamais nulle part, sauf que les outils `sc_session_*` en renvoient des parties à votre client MCP, donc à votre conversation (chiffres d'argent compris, sauf si vous les masquez : « Masquer le solde » dans le tableau de bord ou `SC_BALANCE=hidden` les cache aux outils jusqu'à votre clic sur « Afficher le solde », et `include_balance` à false les cache pour un appel) ; `SC_SESSIONS=off` le désactive ; et supprimer `sessions.json` ainsi que les copies `.bak` et `.corrupt` à côté de lui l'efface. Détails : [Sessions enregistrées](#sessions-enregistrées).

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
  commande indique comment la retirer. Elle ne supprime pas vos sessions enregistrées (`sessions.json`, qui contient
  des soldes) : voir [Sessions enregistrées](#sessions-enregistrées) pour les effacer.
- Les deux commandes sont des simulations tant que vous ne passez pas `--apply`. Redémarrez Claude Desktop après un
  changement de sa configuration.

### Pour un seul lancement (`--session`)

```bash
npm run telemetry -- enable --session --apply
```

Sans `--apply`, c'est une simulation qui n'écrit rien. Avec, la commande crée un petit script de lancement,
`start-rsi-launcher-with-telemetry.cmd`, dans `%APPDATA%\sc-copilot-mcp\` (`disable --apply` le supprime) ; le script
définit la variable uniquement pour le RSI Launcher qu'il démarre. Rien de
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
| Quantique | le voyant QDRV indique que le mode quantique est actif ; un saut est déduit du voyant moteur, de G nul et de l'absence d'atterrissage, et il se termine quand le voyant du moteur quantique s'éteint (mesuré sur un vrai vaisseau ; un vaisseau qui ne rapporte jamais ce voyant retombe sur une règle plus lente) |
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

Ce qui existe dépend de ce que fait le joueur :

| Le joueur est | Données du personnage (santé, faim, soif, rythme cardiaque, atmosphère, solde) | Données de vaisseau (vitesse, altitude, voyants, alimentation, armes) |
| --- | --- | --- |
| Dans les menus ou un écran de chargement | Aucune trame | Non |
| À pied | Oui | Non, c'est normal |
| Assis dans un vaisseau | Oui | Oui, 6 à 9 secondes après s'être assis |
| Dans un véhicule terrestre | Oui | Non, les véhicules terrestres n'en envoient pas |

### Présent mais non vérifié

Oxygène, température corporelle, niveau d'intoxication, radiation, voyants PWR / COOL / MISL, hydrogène bientôt
épuisé, atmosphère irrespirable, état de transformation, réglages de vol liés au boost, phares du vaisseau,
verrouillage des cardans. Ils sont renvoyés sous `unverified` (dans `sc_live_state` et dans le poll du tableau de
bord) ou comme événements et conditions marqués `unverified`, et le tableau de bord étiquette chacun « non vérifié ».
Ne raisonnez pas à partir d'eux. Le tableau de couverture plus bas dit, pour chaque champ du flux, ce qu'il devient.

### Particularités que le serveur gère pour vous

- Un champ que le jeu n'envoie pas est omis, jamais affiché comme 0. Dans une section présente, un nombre manquant
  vaut réellement la valeur par défaut (un vaisseau posé n'envoie pas de `speed` : elle vaut 0).
- Le cap et l'altitude radar sont écartés quand ils ne sont pas valides ; le va-et-vient EVA et à pied est lissé ;
  les voyants d'alerte sont filtrés contre les rebonds ; un nouveau véhicule démarre une base de référence silencieuse,
  de sorte que monter à bord ne produit pas une rafale d'événements.
- Les données du véhicule arrivent 6 à 9 secondes après que vous vous êtes assis.
- La première trame après un changement de siège peut porter des réglages périmés.

## Couverture

Ce que devient chaque champ du flux. `poll.` est la réponse de `sc_live_poll` (ce que reçoit le tableau de bord), `state.` l'état de `sc_live_state`. Les valeurs présentes mais non vérifiées sont sous `unverified` dans le poll et étiquetées comme telles dans la page. Un test (`coverage.test.ts`) échoue quand un champ du schéma n'a pas de ligne ici : un nouveau champ dans un patch force une décision.

131 champs : 104 exposés par le serveur, 27 ignorés volontairement ; 93 affichés par le tableau de bord (les autres sont exposés au modèle seulement, ou ignorés).

| Champ | Serveur | Tableau de bord |
| --- | --- | --- |
| `Availability.enabled` | `poll.ship.flight_modes.coupled.enabled` | Ligne des modes de vol (`modes`) |
| `Availability.active` | `poll.ship.flight_modes.coupled.active` | Ligne des modes de vol (`modes`) |
| `Gauge.current` | `poll.pilot.health.current` | Santé (`health`) |
| `Gauge.max` | `poll.pilot.health.max` | Santé (`health`) |
| `VehicleDoorState.open_state` | `poll.unverified.ship.doors.open_state` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleDoorState.lock_state` | `poll.unverified.ship.doors.lock_state` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleFlightSettings.ifcs_coupled` | `poll.ship.flight_modes.coupled` | Ligne des modes de vol (`modes`) |
| `VehicleFlightSettings.ifcs_esp` | `poll.ship.flight_modes.esp` | Ligne des modes de vol (`modes`) |
| `VehicleFlightSettings.ifcs_gravity_compensation` | `poll.ship.flight_modes.gravity_compensation` | Ligne des modes de vol (`modes`) |
| `VehicleFlightSettings.ifcs_g_safe` | `poll.ship.flight_modes.g_safe` | Ligne des modes de vol (`modes`) |
| `VehicleFlightSettings.ifcs_cruise_mode` | `poll.ship.flight_modes.cruise_mode` | Ligne des modes de vol (`modes`) |
| `VehicleFlightSettings.ifcs_spacebreak_enables_boost` | `poll.unverified.ship.flight_settings.spacebreak_enables_boost` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleFlightSettings.ifcs_speed_limiter` | `poll.ship.flight_modes.speed_limiter` | Ligne des modes de vol (`modes`) |
| `VehicleFlightSettings.ifcs_proximity_assist` | `poll.ship.flight_modes.proximity_assist` | ignoré : Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné. |
| `VehicleFlightSettings.ifcs_proximity_assist_landing` | `poll.ship.flight_modes.proximity_assist_landing` | ignoré : Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné. |
| `VehicleFlightSettings.ifcs_stability` | `poll.ship.flight_modes.stability` | ignoré : Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné. |
| `VehicleFlightSettings.ifcs_core` | `poll.ship.flight_modes.core` | ignoré : Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné. |
| `VehicleFlightSettings.advanced_hud_enabled_scm` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `VehicleFlightSettings.advanced_hud_enabled_nav` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `VehicleFlightSettings.advanced_hud_labels` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `VehicleFlightSettings.course_prediction` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `VehicleFlightSettings.ifcs_wind_compensation` | `poll.ship.flight_modes.wind_compensation` | ignoré : Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné. |
| `VehicleFlightSettings.ifcs_g_safe_disabled_by_boost` | `poll.unverified.ship.flight_settings.g_safe_disabled_by_boost` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleFlightSettings.ifcs_command_behaviour` | `poll.ship.flight_modes.command_behaviour` | ignoré : Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné. |
| `VehicleFlightSettings.flight_light_amplification` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `VehicleFlightState.is_landed` | `poll.ship.landed` | Bandeau d'état du vaisseau (`mode`) |
| `VehicleFlightState.gear` | `poll.ship.gear` | Train et VTOL (`gear`) |
| `VehicleFlightState.vtol` | `poll.ship.vtol` | Train et VTOL (`gear`) |
| `VehicleFlightState.transformation` | `poll.unverified.ship.transformation` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleFlight.state` | `poll.ship.landed` | Bandeau d'état du vaisseau (`mode`) |
| `VehicleFlight.settings` | `poll.ship.flight_modes` | Ligne des modes de vol (`modes`) |
| `VehicleFlight.instruments` | `poll.ship.instruments` | Cadran de vitesse (`speed`) |
| `VehicleFlightInstruments.speed` | `poll.ship.instruments.speed_ms` | Cadran de vitesse (`speed`) |
| `VehicleFlightInstruments.hydrogen_fuel` | `poll.ship.instruments.hydrogen_fuel` | Jauge d'hydrogène et autonomie estimée (`hydrogen`) |
| `VehicleFlightInstruments.quantum_fuel` | `poll.unverified.ship.quantum_fuel` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleFlightInstruments.g_meter` | `poll.ship.instruments.g` | Cadran de force G (`g`) |
| `VehicleFlightInstruments.boost` | `poll.ship.instruments.boost` | Jauge de boost (`boost`) |
| `VehicleFlightInstruments.altitude` | `poll.ship.instruments.altitude_m` | Altitude et altitude radar (`altitude`) |
| `VehicleFlightInstruments.radar_altitude` | `poll.ship.instruments.radar_altitude_m` | Altitude et altitude radar (`altitude`) |
| `VehicleFlightInstruments.vertical_speed_indicator` | `poll.ship.instruments.vertical_speed_ms` | Barre de vitesse verticale (`vspeed`) |
| `VehicleFlightInstruments.atmospheric_density` | `poll.unverified.ship.atmospheric_density` | Densité atmosphérique (`atmosphere`) |
| `VehicleFlightInstruments.heading` | `poll.ship.instruments.heading_deg` | Boussole (`heading`) |
| `VehicleThrusterBoost.engaged` | `poll.ship.instruments.boost.engaged` | Jauge de boost (`boost`) |
| `VehicleThrusterBoost.output` | `poll.ship.instruments.boost.output` | Jauge de boost (`boost`) |
| `VehicleThrusterBoost.reserves` | `poll.ship.instruments.boost.reserves` | Jauge de boost (`boost`) |
| `VehicleThrusterBoost.critical` | `poll.ship.instruments.boost.critical` | Jauge de boost (`boost`) |
| `VehiclePowerState.powerplants` | `poll.ship.power.powerplants` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.engines` | `poll.ship.power.engines` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.weapons` | `poll.ship.power.weapons` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.coolers` | `poll.ship.power.coolers` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.life_support` | `poll.ship.power.life_support` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.gravity_generators` | `poll.ship.power.gravity_generators` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.sensors` | `poll.ship.power.sensors` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.shield_generators` | `poll.ship.power.shield_generators` | Schéma d'alimentation (`power`) |
| `VehiclePowerState.shield_emitters` | `poll.ship.power.shield_emitters` | Schéma d'alimentation (`power`) |
| `VehicleAnnunciator.pwr` | `poll.ship.warning_lights.pwr` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.wpn` | `poll.ship.warning_lights.wpn` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.thr` | `poll.ship.warning_lights.thr` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.shld` | `poll.ship.warning_lights.shld` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.cool` | `poll.ship.warning_lights.cool` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.qdrv` | `poll.ship.warning_lights.qdrv` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.radr` | `poll.ship.warning_lights.radr` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.prox` | `poll.ship.warning_lights.prox` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.hit` | `poll.ship.warning_lights.hit` | Panneau des voyants (`lights`) |
| `VehicleAnnunciator.misl` | `poll.ship.warning_lights.misl` | Panneau des voyants (`lights`) |
| `VehicleState.name` | `poll.ship.name` | Nom et constructeur du vaisseau (`ship`) |
| `VehicleState.class_name` | `poll.ship.class_name` | Nom et constructeur du vaisseau (`ship`) |
| `VehicleState.manufacturer` | `poll.unverified.ship.manufacturer` | ignoré : Le jeu ne remplit jamais le constructeur : le serveur le déduit du préfixe de classe (`ship.manufacturer_derived`) et la vue montre celui-là. |
| `VehicleState.type` | `poll.ship.type` | ignoré : Toujours la même valeur pour les vaisseaux qui envoient des données de véhicule (les véhicules terrestres n'en envoient pas). |
| `VehicleState.lights_enabled` | `poll.unverified.ship.lights_on` | Phares du vaisseau (`headlights`) |
| `VehicleState.doors` | `poll.unverified.ship.doors` | Carte des valeurs non vérifiées (`unverified`) |
| `VehicleState.annunciators` | `poll.ship.warning_lights` | Panneau des voyants (`lights`) |
| `VehicleState.flight` | `poll.ship.instruments` | Cadran de vitesse (`speed`) |
| `VehicleState.power` | `poll.ship.power` | Schéma d'alimentation (`power`) |
| `VehicleFrame.state` | `poll.ship` | Nom et constructeur du vaisseau (`ship`) |
| `WeaponsSettings.fallback_convergence_distance` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.magnified_ui` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.precision_lines` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.staggered_fire` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.use_lag_pips` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.use_single_pips` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.use_fading_pips` | ignoré : Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés. | - |
| `WeaponsSettings.gimbals_locked` | `poll.unverified.weapons.gimbals_locked` | Verrouillage des cardans (`gimbals`) |
| `WeaponState.name` | `poll.weapons.weapons[].name` | Armes du poste (`weapons`) |
| `WeaponState.is_powered` | `poll.weapons.weapons[].powered` | Armes du poste (`weapons`) |
| `WeaponState.ready_to_fire` | `poll.weapons.weapons[].ready` | Armes du poste (`weapons`) |
| `WeaponState.contained_in_preset` | ignoré : Les présélections d'armes ne sont pas dans le flux (test terrain) : non exposées. | - |
| `Countermeasures.type` | `poll.weapons.countermeasures` | Contre-mesures (`cm`) |
| `Countermeasures.amount` | `poll.weapons.countermeasures.decoy` | Contre-mesures (`cm`) |
| `WeaponsFrame.settings` | `poll.unverified.weapons.gimbals_locked` | Verrouillage des cardans (`gimbals`) |
| `WeaponsFrame.preset_index` | ignoré : Les présélections d'armes ne sont pas dans le flux (test terrain) : non exposées. | - |
| `WeaponsFrame.preset_name` | ignoré : Les présélections d'armes ne sont pas dans le flux (test terrain) : non exposées. | - |
| `WeaponsFrame.weapons` | `poll.weapons.weapons` | Armes du poste (`weapons`) |
| `WeaponsFrame.countermeasures` | `poll.weapons.countermeasures` | Contre-mesures (`cm`) |
| `GameEvent.type` | `state.game_events[]` | ignoré : Le jeu n'a envoyé aucun événement exploitable pendant le test terrain ; les noms de la dernière trame restent dans `sc_live_state` et rien n'est construit dessus. |
| `EventsFrame.events` | `state.game_events` | ignoré : Le jeu n'a envoyé aucun événement exploitable pendant le test terrain ; les noms de la dernière trame restent dans `sc_live_state` et rien n'est construit dessus. |
| `AxisFeedback.resistance` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `AxisFeedback.damping` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `FeedbackAxes.x` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `FeedbackAxes.y` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `FeedbackAxes.z` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `ForceFeedbackFrame.angular` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `ForceFeedbackFrame.linear` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `ForceFeedbackFrame.gunfire` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `ForceFeedbackFrame.stick_shaker` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `ActorVitals.health` | `poll.pilot.health` | Santé (`health`) |
| `ActorVitals.oxygen` | `poll.unverified.pilot.oxygen` | Carte des valeurs non vérifiées (`unverified`) |
| `ActorVitals.hunger` | `poll.pilot.hunger` | Faim (`hunger`) |
| `ActorVitals.thirst` | `poll.pilot.thirst` | Soif (`thirst`) |
| `ActorVitals.body_temperature` | `poll.unverified.pilot.body_temperature` | Carte des valeurs non vérifiées (`unverified`) |
| `ActorVitals.heart_rate` | `poll.pilot.heart_rate_bpm` | Rythme cardiaque (`heart`) |
| `ActorVitals.gravity` | `poll.pilot.gravity_g` | Gravité (`gravity`) |
| `ActorVitals.pressure` | `poll.pilot.pressure` | Pression (`pressure`) |
| `ActorVitals.intoxication_level` | `poll.unverified.pilot.intoxication_level` | Carte des valeurs non vérifiées (`unverified`) |
| `ActorEnvironment.external_temperature` | `poll.pilot.outside_temperature_c` | Température extérieure (`temperature`) |
| `ActorEnvironment.ambient_radiation_rate` | `poll.unverified.pilot.ambient_radiation_rate` | Carte des valeurs non vérifiées (`unverified`) |
| `ActorEnvironment.breathable_atmosphere` | `poll.pilot.breathable_atmosphere` | Atmosphère respirable (`air`) |
| `ActorState.locomotion` | `poll.pilot.locomotion` | Position du corps (`locomotion`) |
| `ActorState.crew_role` | `poll.pilot.crew_role` | Rôle et siège (`crew`) |
| `ActorState.seat_name` | `poll.pilot.seat` | Rôle et siège (`crew`) |
| `ActorState.uec_balance` | `poll.balance.uec` | Solde (affiché par défaut, masquable) (`balance`) |
| `ActorFrame.vitals` | `poll.pilot` | Santé (`health`) |
| `ActorFrame.state` | `poll.pilot.locomotion` | Position du corps (`locomotion`) |
| `ActorFrame.environment` | `poll.pilot.outside_temperature_c` | Température extérieure (`temperature`) |
| `TurretFrame.light_amplification` | ignoré : Sièges de tourelle seulement, jamais vérifié, sans utilité sur un tableau de bord. | - |
| `TelemetryStreamResponse.vehicle` | `poll.ship` | Nom et constructeur du vaisseau (`ship`) |
| `TelemetryStreamResponse.weapons` | `poll.weapons` | Armes du poste (`weapons`) |
| `TelemetryStreamResponse.events` | `state.game_events` | ignoré : Le jeu n'a envoyé aucun événement exploitable pendant le test terrain ; les noms de la dernière trame restent dans `sc_live_state` et rien n'est construit dessus. |
| `TelemetryStreamResponse.actor` | `poll.pilot` | Santé (`health`) |
| `TelemetryStreamResponse.force_feedback` | ignoré : Retour de force des manches : absent du flux (test terrain) et sans utilité ici. | - |
| `TelemetryStreamResponse.turret` | ignoré : Sièges de tourelle seulement, jamais vérifié, sans utilité sur un tableau de bord. | - |

## Ce que les outils en font

| Outil | Listé | Rôle |
| --- | --- | --- |
| `sc_live_status` | toujours | L'état du flux, pourquoi, et comment l'activer |
| `sc_live_state` | quand `SC_TELEMETRY=on` | Un instantané avec l'âge de la dernière trame, les conditions du moment et ce qui n'est pas disponible |
| `sc_live_events` | quand `SC_TELEMETRY=on` | Les événements dérivés récents, chacun marqué `confirmed` ou `unverified` |
| `sc_live_dashboard` | quand `SC_TELEMETRY=on` et que le client sait afficher des Views | Ouvre le [tableau de bord en direct](#tableau-de-bord-en-direct) dans la conversation |
| `sc_live_poll`, `sc_live_mark` | idem | Utilisés par le tableau de bord lui-même pour se rafraîchir et poser des repères de session. Claude a pour consigne de ne pas les appeler |
| `sc_trade_suggest` | idem | Utilisé seulement par les boutons de commerce du tableau de bord ([barre d'actions](#actions-de-commerce--trouver-la-prochaine-route)) : le planificateur de commerce, ou une relecture des prix pour le plan en cours ([vérification avant le départ](#avant-de-partir--la-vérification-du-plan-et-le-prix-qui-a-bougé)), derrière un limiteur de débit. Claude a pour consigne de ne pas l'appeler ; il utilise `uex_plan_trade` |

États : `off` (interrupteur serveur non défini), `waiting` (pas de télémétrie pour l'instant : normal dans les menus, pendant un chargement, avant l'apparition du personnage, ou si le jeu a été lancé sans le réglage côté jeu ; ce serveur ne peut pas savoir si le jeu tourne), `game_without_telemetry` (le
jeu tourne, `Game.log` n'a pas de ligne d'enregistrement : relancez le launcher), `connected` (la session HTTP/2 avec le jeu est ouverte, pas encore
de trames), `live`, `incompatible` (le jeu répond sous une forme que nous ne connaissons pas : un patch l'a changée).

**État de connexion (depuis `Game.log`).** Le flux ne dit pas quand le joueur est coupé du jeu : il se tait ou répète
ses dernières valeurs. Quand le journal du jeu est configuré (`SC_INSTALL_DIR` ou `SC_GAME_LOG_PATH`),
`sc_live_status`, `sc_live_state` et le tableau de bord lisent aussi où en est le joueur vis-à-vis des serveurs, à
partir des lignes que le jeu écrit (marqueurs vus dans un vrai journal : deux renvois, le menu et la
reconnexion entre les deux ; chacun est reconnu sur l'étiquette propre de la ligne, donc un mot-marqueur dans un
texte libre ne peut pas forger un état) : serveur rejoint
(`online`), coupé par le serveur (`disconnected`, avec le code du jeu, par exemple 30028 pour l'inactivité), retour
aux menus (`menu`), jeu quitté (`closed`). Quand ce n'est pas `online`, le tableau de bord le dit aussitôt en
rouge, grise toutes les valeurs et n'affiche plus « Aucune alerte », et les outils disent que les dernières valeurs
ne sont pas actuelles. Seuls un état, une heure et un code numérique parviennent aux outils (le texte de raison du jeu reste dans la
page, en simple texte) ; aucun pseudo, aucune adresse, aucun identifiant de session. Un départ volontaire vers le
menu et un changement de serveur ne sont pas encore vérifiés sur un vrai journal. Un `stat` par interrogation, et seuls les octets ajoutés depuis la
dernière lecture sont analysés. Sans journal configuré, rien n'est annoncé, ni dans un sens ni dans l'autre.

Le lecteur démarre à la première requête, se reconnecte avec un délai croissant, s'arrête après cinq minutes sans
requête (avec les sessions enregistrées actives, il est maintenu en vie tant que le jeu tourne et les résumés de session
sont enregistrés : voir [Sessions enregistrées](#sessions-enregistrées)), et garde les trames et les événements en
mémoire uniquement. Les événements n'existent que pendant le temps où le serveur tournait
tandis que le jeu envoyait des trames, et ils sont déduits, non rapportés par le jeu.

## Tableau de bord en direct

Une vue en direct optionnelle du même flux, dessinée dans la conversation. Compacte : le vaisseau, où il se trouve,
trois cadrans (vitesse, hydrogène, santé), les alertes et un verdict en une ligne (« Tout va bien », « À surveiller »
ou le prix refusé au kiosque). En plein écran : un cockpit, avec les instruments à gauche, le vaisseau au centre et le pilote à droite. C'est
une MCP App : une petite page que ce serveur fournit et que le client affiche à côté du chat.

- **Qui l'affiche.** Claude Desktop est l'hôte que nous avons testé (version Microsoft Store 4.4212.0, serveur
  déclaré dans `claude_desktop_config.json`). **Claude Code et les autres clients en mode texte ne l'affichent pas** :
  pour eux, les outils du tableau de bord ne sont pas listés du tout, donc le modèle ne les voit jamais. Le
  serveur ne les liste que lorsque `SC_TELEMETRY=on` ET que le client a déclaré l'extension MCP Apps au démarrage.
  D'autres hôtes qui affichent les MCP Apps peuvent fonctionner ; nous ne les avons pas essayés. La mise en page a été
  itérée dans un vrai navigateur face à un hôte factice (360 à 2000 px, clair et sombre) ; **nous ne l'avons pas vue
  dans Claude Desktop**.
- **Comment l'ouvrir.** Activez la télémétrie (voir plus haut), redémarrez complètement Claude Desktop (quittez-le
  depuis la zone de notification, pas seulement la fenêtre), puis demandez à Claude d'ouvrir le tableau de bord en
  direct. Claude appelle `sc_live_dashboard`, dont le résultat lui dit de ne pas en ouvrir un second tant qu'un est
  ouvert (`hint`). Tant qu'il est ouvert, vous pouvez continuer à parler à Claude : il répond à partir de
  `sc_live_state`, pas à partir de la page.
- **La vue compacte, dans l'ordre de ce qu'un coup d'œil en vol demande.** L'en-tête avec le verdict, puis le refus de
  prix s'il y en a un, les alertes (aucune ligne tant qu'il n'y en a pas : le verdict le dit), les trois cadrans, le
  vaisseau sur une petite ligne, la session sur UNE ligne (« Session 4 · 6 trajets · 1 h 28 min », plus le net par heure
  seulement solde affiché ; un vrai bouton avec `aria-expanded` déplie la carte entière, qui garde **Terminer la session** et **Nouvelle session**
  en boutons secondaires, quand ils changent quelque chose), la ligne du solde à côté, puis la ligne du contrat et « Chercher une route ». Mesuré dans Chrome
  réel sur le vol inventé de l'aperçu, à 560 px : 691 px de haut avant, 326 px maintenant ; à 360 px avec un refus de
  prix 915 px avant, 510 px maintenant. Non vérifié : comment Claude Desktop dimensionne le cadre en ligne.
- **Deux modes.** En ligne : une vue compacte. En plein écran (bouton dans la page) : le cockpit. Le bouton interroge
  l'hôte ; si l'hôte répond avec un autre mode, la page suit ce qu'on lui dit.
- **Ce que montre le cockpit.** Instruments : un cadran de vitesse dont l'échelle est déduite des vitesses vues et le
  dit (le voyage quantique s'affiche « mode quantique » au lieu d'écraser l'échelle), un cadran de force G face au
  maximum que le jeu indique, l'altitude avec l'altitude radar, une barre de vitesse verticale autour de zéro, une
  boussole seulement quand le cap est valide, et des courbes de 60 secondes avec leur minimum et leur maximum.
  Énergie : l'hydrogène avec une autonomie estimée, la réserve et la sortie du boost. Les neuf indicateurs
  d'alimentation en schéma, les modes de vol, les dix voyants en panneau d'annonciateurs (l'état en toutes lettres,
  pas seulement en couleur), les armes de votre siège en une phrase puis une ligne chacune, les contre-mesures face au
  plus haut niveau vu pour ce vaisseau. Pilote : cadrans de santé, faim et soif, rythme cardiaque, gravité,
  température extérieure, atmosphère, position du corps, rôle. Une seule chronologie des événements et de vos repères,
  avec des filtres, une carte de session, le plan de route, et deux lignes repliables : les valeurs non vérifiées et
  ce que le flux ne contient pas. Chaque donnée peut être épinglée (icône d'épingle au survol ou au focus) : elle
  apparaît alors dans une barre sous l'en-tête, dans les deux modes. Les courtes explications d'une étiquette s'atteignent
  aussi au clavier et au toucher, pas seulement au survol : en vue compacte l'âge des données (« Données de ... ») et la
  légende sous le cadran de vitesse (son échelle et sa source), dans les deux vues l'heure d'un prix refusé (le verdict de
  l'en-tête), en plein écran l'étiquette de confiance d'un chiffre calibré. Tab jusqu'à l'étiquette, ou un appui ; Entrée ou Espace ferme la
  bulle si elle est ouverte, l'ouvre et la garde sinon, un appui la garde ouverte, Échap (seulement si une bulle est ouverte), un
  appui ailleurs, un défilement ou un redimensionnement la ferme. Les voyants et les éléments d'alimentation sont nommés en
  entier (« Radar : verrouillage hostile, nominal ») pour un lecteur d'écran et montrent ce nom au survol ou à l'appui ; ils
  ne sont pas des arrêts de tabulation.
- **Un vaisseau éteint.** Quand la centrale est signalée hors service, la page affiche « Vaisseau éteint », des
  tirets à la place des zéros, et n'ajoute rien aux courbes. Rien n'est coloré en rouge simplement parce que c'est
  absent.
- **Alertes du moment (conditions).** `sc_live_poll` (et `sc_live_state`) portent un tableau `conditions` calculé à
  partir de l'état courant, pas de l'historique ; la page l'affiche en puces colorées avec leur durée, avant les
  événements récents : bleu pour l'information, ambre pour l'avertissement, rouge pour le critique. Une condition que
  le test terrain n'a pas confirmée porte « non vérifié ».

  | Condition | Niveau | Quand |
  | --- | --- | --- |
  | `shields_off` | info en mode quantique (`data.quantum`), sinon avertissement | Un indicateur d'alimentation de bouclier (générateurs ou émetteurs) est coupé, la centrale est allumée, le vaisseau n'est pas au sol. Seulement pour un vaisseau vu une fois avec les deux allumés |
  | `shields_down` | critique | Le voyant SHLD est majeur |
  | `powerplant_off` | critique | L'indicateur de centrale est coupé. Les autres conditions d'alimentation (moteurs, boucliers, armes) ne sont alors pas levées |
  | `engines_off` | avertissement (info au sol) | Centrale allumée, moteurs coupés |
  | `engines_damaged` | avertissement | Voyant THR mineur |
  | `weapons_unpowered` | avertissement | Voyant WPN majeur |
  | `hostile_lock` | critique | Voyant RADR majeur |
  | `under_fire`, `proximity` | avertissement | Voyant HIT, voyant PROX (pas train sorti) |
  | `hydrogen_low` | avertissement, non vérifié | Sous 15 pour cent |
  | `boost_critical` | avertissement | Le boost signale critique |
  | `countermeasures_low`, `countermeasures_empty` | avertissement, critique | Mêmes seuils que les événements (trois salves ou moins ; aucune), pour un type vu avec du stock |
  | `health_low`, `down_or_dead` | avertissement, critique | Santé sous 30 pour cent ; santé 0 |
  | `hunger_low`, `thirst_low` | info | Sous 25 pour cent |
  | `not_breathable` | critique, non vérifié | L'atmosphère est signalée non respirable |
  | `in_quantum`, `in_jump` | info | Mode quantique actif ; saut en cours |

  Le cadran de santé suit la même limite que `health_low` : rouge sous 30 pour cent, orange de 30 à moins de 50 pour cent,
  vert à partir de 50 pour cent (un choix, pas une mesure). La bande de santé envoyée au modèle la suit : basse sous 30
  pour cent, moyenne sous 50 pour cent.

  Mesuré sur un vrai Aegis Harbinger (4.10.2) : en mode quantique le voyant SHLD s'éteint et les deux indicateurs
  d'alimentation des boucliers passent à faux, et tout revient à l'arrivée. Les événements `shields_powered_off` et
  `shields_powered_on` (confirmés, avec anti-rebond, silencieux à la référence d'un nouveau vaisseau) le consignent,
  le premier avec le contexte quantique. Un vaisseau jamais vu avec ses boucliers allumés (un vaisseau sans boucliers,
  ou un tableau de bord ouvert alors qu'on est déjà en mode quantique) ne lève rien à leur sujet : ce compromis est
  voulu, pour éviter une fausse alerte permanente.
- **Âge et lacunes.** Chaque carte indique l'âge de sa trame, et tout passe en gris quand le flux n'est pas en
  direct. Rien n'est inventé : un champ manquant s'affiche sous la forme d'un tiret, une santé à 0 se lit « à terre ou
  mort », et une ligne repliable énumère ce que le flux ne contient pas.
- **Les estimations sont signalées.** L'hydrogène restant, la faim et la soif sont des estimations en ligne droite
  sur les dernières minutes, affichées avec leur fenêtre. L'échelle de vitesse est déduite, pas donnée par le jeu. Le
  rythme (aUEC par heure) n'apparaît que lorsque le solde est affiché, à partir de la variation depuis le repère de
  session.
- **Plan de route.** Après `uex_get_trade_routes`, Claude peut passer un `plan` à l'ouverture du tableau de bord :
  marchandise, terminaux d'achat et de vente, SCU, `expected_profit_auec` (le BÉNÉFICE prévu : ventes moins achats
  avant frais, pas un chiffre d'affaires), prix unitaires d'achat et de vente, durée estimée du trajet en minutes,
  une remarque de sécurité, une courte note et jusqu'à 30 prix récents (`price_points`, du plus ancien au plus
  récent, avec `price_points_for` et `price_points_label`) qui dessinent la courbe des cours. Claude remplit les prix
  avec les outils de prix UEX ; la courbe ne vient jamais d'un appel du tableau de bord à UEX. Les textes sont nettoyés et plafonnés (60
  caractères) et affichés en texte brut ; les nombres sont bornés ; moins de deux prix utilisables ne donnent pas de
  courbe. Le plan alimente la carte Commerce ci-dessous. Une route suggérée a la forme d'un plan : la barre d'actions
  (voir Actions de commerce) l'applique en la repassant dans le même nettoyage.
- **Confidentialité du solde.** Le solde est affiché dans la page par défaut (le réglage du serveur depuis la 2.6 ; il démarrait masqué avant). « Masquer le solde » le masque sur cet écran ET pour les outils de Claude : la page le dit au serveur (un clic, envoyé une fois), et dès lors `sc_live_state`, `sc_live_events`, `sc_session_*` et `sc_trade_journal` répondent sans montants, un `include_balance: true` est ignoré (une consigne cachée dans un nom UEX ou une note du journal ne peut pas les dévoiler) et la réponse dit que le joueur les a masqués. « Afficher le solde » le lève ; le dernier clic gagne, quel que soit le tableau de bord, et chaque tableau suit l'état du serveur à sa prochaine interrogation (un nouveau le lit au montage). Le clic n'est gardé que dans la mémoire de CE processus du serveur, jamais dans un fichier : **un redémarrage du serveur l'oublie** (le tableau de bord démarre alors comme la configuration le dit, sauf qu'un tableau qui détient son propre clic « Masquer » le redit au serveur redémarré au lieu d'afficher le solde ; le clic « Afficher le solde » d'un autre tableau est suivi), un autre client ou un autre processus du serveur a sa propre mémoire (Claude Desktop peut en lancer deux), donc un clic ne protège que les outils du même processus, et seul `SC_BALANCE=hidden` couvre durablement tous les clients. Lever le masque demande un jeton que seule la page servie porte (un appelant qui n'a pas lu la page est refusé ; masquer n'en demande aucun). Avec `SC_BALANCE=hidden` dans l'entrée du serveur, le tableau de bord démarre masqué et les outils répondent sans montants, en permanence ; un clic sur « Afficher le solde » le lève pour le processus en cours. L'état masqué reste visible et réversible : la ligne « Solde » affiche « •••••• » avec son bouton. Quel que soit l'état, le solde n'est jamais mis dans le résumé automatique que la page peut envoyer au modèle, ni dans les messages fixes des boutons, ni sur le canal entre tableaux de bord (un tableau qui en suit un autre l'affiche masqué, avec le bouton pour prendre la main), avec une exception : le bouton « Route avec mon solde et ce vaisseau » l'envoie dans un message, le dit dans le texte, et seulement quand vous l'appuyez ; il ne change rien d'autre (ni le choix du serveur, ni l'écran). `include_balance: false` masque un appel. Quand les montants sont affichés, ils atteignent le modèle et votre conversation : c'est votre choix.
- **Bandeau de santé : ce qui est branché, ce qui manque.** Un nouveau joueur qui installe le serveur voit un tableau
  de bord qui en montre silencieusement moins qu'il ne pourrait : sans le journal du jeu, pas d'état de connexion (un
  « renvoyé pour inactivité » reste invisible), pas de journal de commerce, pas de grand livre et des chiffres de session
  plus fragiles ; télémétrie désactivée, rien du tout ; un jeu lancé sans la variable côté jeu n'affiche que « Jeu lancé
  sans télémétrie ». La page le dit maintenant elle-même. Elle est **invisible tant que rien n'est à faire** ; quand
  quelque chose manque, UNE ligne (« 3 réglages à faire », avec un bouton « Voir » qui porte `aria-expanded`) dit combien ;
  dépliée, elle nomme chaque point, dit ce qu'on perd et donne le remède exact, dans une
  boîte que l'on copie avec un bouton (le presse-papiers peut être refusé dans le bac à sable de l'hôte : le texte est
  alors sélectionné et la page dit d'appuyer sur Ctrl+C). Le bouton « ? » de l'en-tête ouvre à tout moment la liste
  complète, avec « Tout est branché » (ou « Rien à régler pour l'instant » quand une ligne attend seulement le jeu) et
  la légende en dessous. Les huit lignes :
  1. **Télémétrie** : son état et, quand elle est désactivée, `npm run telemetry -- enable` (une simulation : ajoutez
     `--apply`).
  2. **Journal du jeu** (`SC_INSTALL_DIR` ou `SC_GAME_LOG_PATH`) : non configuré, configuré mais illisible (le fichier
     n'existe qu'après un premier lancement, ou le dossier est faux), ou lu. La page montre le NOM du réglage et une
     courte étiquette fixe (`LIVE/Game.log`, `Game.log`, `custom`), jamais un chemin et jamais une valeur : le serveur
     construit l'étiquette et la page n'accepte que cette liste. Le remède est la ligne à ajouter à la main dans le
     bloc `env` de l'entrée `sc-copilot` (`npm run install:claude` garde ce bloc tel quel mais n'ajoute pas cette ligne, il n'est donc pas proposé).
  3. **La ligne d'enregistrement** du service de télémétrie dans `Game.log` : vue, non vue (le jeu a été lancé sans
     `GRPC_CLIENT_SERVER_ENABLED` : quittez complètement le RSI Launcher, icône de la zone de notification comprise),
     ou pas encore vérifiable.
  4. **État de connexion** et 5. **journal de commerce et grand livre** : ils ont besoin du journal ; ils renvoient à la
     ligne 2 au lieu de la répéter.
  6. **Sessions enregistrées** : actives (avec l'heure de la dernière écriture de ce processus serveur), désactivées par
     `SC_SESSIONS=off` (un choix délibéré : listé derrière le « ? », pas un rappel), en lecture seule (fichier plus
     récent) ou dégradées (une écriture a échoué, les sessions restent en mémoire).
  7. **Solde** : s'il est affiché ou masqué sur cet écran, ce que font « Masquer le solde » et « Afficher le solde » (le masque couvre aussi les outils de Claude, est collant, et s'oublie au redémarrage du serveur : `SC_BALANCE=hidden` est le moyen permanent), rien dans le résumé automatique ni sur le canal entre tableaux de bord, seul le bouton de route l'envoie (quand vous l'appuyez), et que les sessions enregistrées gardent leurs chiffres dans un fichier local.
  8. **Fraîcheur des données** : non mesurée ici (il faudrait les sources, donc le réseau) ; la ligne renvoie à
     `sc_data_status`.

  Le serveur ajoute à la réponse du poll un petit objet `health` : des codes (`log` : `off`, `unchecked`, `ok`,
  `unreadable` ; `registration` ; `sessions`), le nom du réglage, l'étiquette fixe et l'heure de la dernière écriture. Il
  est construit à partir de ce que le serveur détient déjà (l'état de la télémétrie, l'indice de journal que le service
  garde, la réponse du suivi de connexion, la barre de session) : **aucun nouveau réseau, aucune nouvelle lecture de
  fichier** (télémétrie désactivée, rien n'est lu et le journal est annoncé « non vérifié »), aucun montant, rien qui
  dérive du solde, et il ne participe pas aux empreintes des sections. Chaque phrase et chaque commande est écrite dans
  la page ; la page reconstruit l'objet champ par champ et le rejette en entier si un code `log`, `registration` ou `sessions` est inconnu (un nom de réglage ou une étiquette inconnus est écarté seul). `npm run doctor`
  reste le contrôle approfondi (il lit la config de Claude, la variable utilisateur et le port) ; la page ne le
  duplique pas.
- **Comment lire le tableau de bord (la légende).** Montrée à la première ouverture (dans la vue compacte seulement quand quelque chose est à régler, pour que les cadrans restent en premier) et derrière le « ? » ensuite :
  **Mesuré** (envoyé par le jeu à l'instant), **Calculé** (somme ou différence de valeurs mesurées), **Estimé** (une
  tendance sur les dernières minutes, avec sa fenêtre), **Probable** (déduit d'indices, jamais confirmé par le jeu),
  **Inconnu** (non envoyé par le jeu : un tiret, jamais un zéro inventé). Chaque terme a un glyphe, et chaque état est
  écrit autant que coloré. « Grisé » veut dire que les valeurs ne sont plus à jour, « non vérifié » que le champ n'a
  jamais été vu fonctionner.
- **Ce dont la page se souvient.** Un seul drapeau dans le stockage propre au navigateur, `sc-copilot-help-seen` :
  « la légende a été lue ». C'est au mieux et jamais nécessaire : quand le stockage est indisponible (un bac à sable) la
  page fonctionne pareil, et la légende ne s'ouvre d'elle-même que lorsque quelque chose est à régler (sa fermeture est alors gardée en mémoire pour la session). La page ne stocke rien d'autre que ce drapeau ; ce que le serveur enregistre est décrit dans [Sessions enregistrées](#sessions-enregistrées).
- **Ce que font les boutons.** « Analyser ma situation », « Route avec mon solde et ce vaisseau » et « Bilan de
  session » publient un court message fixe dans la conversation, comme si vous l'aviez tapé, demandant à Claude
  d'utiliser `sc_live_state` et `sc_live_events` ; une confirmation apparaît à côté des boutons et s'efface seule. Le premier bouton suit la
  situation (il s'appelle « Analyser » dans l'en-tête compact) : « Analyser la perte » après la perte d'un vaisseau (demande `sc_session_current` et
  `sc_trade_journal`), « Que faire maintenant ? » après un prix refusé (`sc_trade_journal`, `uex_get_price_history`,
  `uex_get_market_status`), « Debrief du trajet » pendant une demi-heure après la fin d'un trajet (`sc_trade_journal`,
  `sc_session_current`, `uex_get_price_history`), sinon l'analyse simple. Chaque message est un texte fixe : aucun nombre, aucun vaisseau,
  rien venu du journal ni du jeu, jamais un solde. Votre choix est lu au moment du clic :
  montants masqués, chaque appel d'outil du message dit `include_balance false` et le message demande de ne pas inclure le
  solde ; montants affichés, le message ne nomme pas `include_balance` (le serveur applique votre choix, donc les réponses
  portent les montants que le tableau de bord affiche lui-même). Même règle pour « Analyser », « Bilan de session » et les
  trois messages contextuels. Un objet refusé (pas une marchandise) laisse le simple « Analyser ». Le modèle doit dire si un outil
  manque et, pour l'historique des prix, utiliser le terminal de vente nommé par le journal ou par vous, sinon le demander.
  Les repères de session vivent dans la mémoire de ce serveur. Rien dans la page n'envoie quoi que ce soit au jeu.
- **Plusieurs tableaux de bord : les faits.** Chaque tableau de bord est une iframe distincte qui fait ses propres
  appels à `sc_live_poll`, une fois par seconde tant qu'elle est visible. Claude Desktop ne démonte jamais les plus
  anciennes. Côté serveur rien ne se multiplie : une seule réponse est partagée pendant une demi-seconde quel que soit
  le nombre de Views. Mais chaque View ouverte et visible faisait son propre aller-retour avec l'hôte. Mesuré face à
  l'hôte factice, sur une minute, en appels par seconde : 1, 3 et 5 tableaux de bord faisaient 1,00, 3,00 et 5,00
  appels par seconde avant ; ils en font 1,00 quel que soit leur nombre.
- **Plusieurs tableaux de bord : la correction.** Les tableaux de bord d'un même connecteur partagent une origine
  dans Claude Desktop (documenté par Anthropic ; non vérifié par nous), ils s'annoncent donc sur un
  `BroadcastChannel` (pas de réseau : la politique de contenu de la page ne le régit pas). Le plus récent visible est
  le leader et interroge ; les autres cessent d'appeler le serveur, affichent « Remplacé par un tableau de bord plus
  récent » avec un bouton « Reprendre ici », et continuent d'afficher la réponse du leader, partagée environ une fois
  par seconde. Un leader masqué, sorti de l'écran, fermé, ou silencieux depuis 6 secondes cède la place au suivant. Ce
  qui arrive sur le canal est traité comme non fiable : types, bornes et longueurs sont vérifiés, la réponse est
  reconstruite champ par champ, le solde et les événements de portefeuille ne quittent jamais une View, et seul le
  leader envoie un résumé au modèle. Sans `BroadcastChannel`, l'ancien comportement s'applique et un tableau de bord
  absent depuis 30 secondes se retire. Le modèle a aussi pour consigne de ne pas ouvrir un second tableau de bord
  quand un est ouvert.
- **Charge.** La page interroge le serveur environ une fois par seconde tant qu'elle est visible et leader (jamais
  plus de deux fois par seconde), toutes les 5 secondes quand le flux est arrêté ou coupé. Elle ne demande que ce qui
  lui manque : les événements plus récents que le dernier qu'elle détient, les sections dont l'empreinte a changé, et
  une seule fois la liste de ce que le flux ne contient pas. Mesuré sur le vol fictif pendant deux minutes : 3810
  octets par seconde avant, 2185 après. Elle s'arrête quand la fenêtre est masquée ou que la View sort de l'écran, et
  se retire après 30 minutes d'absence jusqu'à ce que vous cliquiez sur « Reprendre ». La fermeture ou le masquage
  définitif retire tous les minuteurs, écouteurs et le canal.
- **Pas de réseau, pas de paquet.** La page est un seul fichier à l'intérieur de ce serveur : pas de CDN, pas de
  police, pas de requête. Elle déclare sa propre politique de contenu restrictive et définit chaque texte avec
  `textContent`.

### Jauges d'après la fiche du vaisseau

Le cadran de vitesse peut être dessiné d'après les vraies limites du vaisseau plutôt que d'après ce qui a été vu
jusqu'ici. Ces limites ne viennent pas du jeu : elles viennent de la page du vaisseau sur le Star Citizen Wiki,
écrite par la communauté et étiquetée « wiki » partout où elle s'affiche.

- **Comment le vaisseau est trouvé.** Le flux donne un nom de classe comme `AEGS_Vanguard_Harbinger`. Le serveur le
  transforme en mots (le fabricant est dérivé du préfixe : Aegis ; le vaisseau est « Vanguard Harbinger ») et
  interroge le wiki, en arrière-plan et une fois par vaisseau et par session, pour les vaisseaux dont le nom
  contient le plus long de ces mots. Si exactement une ligne porte ce nom de classe (`class_name`), c'est le
  vaisseau. Sinon les mots passent par la même correspondance par mots que `sc_fleet_get` et seul un candidat
  unique est accepté. Avec plusieurs candidats rien n'est choisi (`ambiguous`, avec leurs noms) ; sans candidat le
  vaisseau est `unknown`. Un wiki qui ne répond pas donne `error` et il est réinterrogé au plus toutes les cinq
  minutes. Le poll n'attend jamais le wiki : les premières réponses disent `pending`.
- **Ce qui est lu.** Vitesse en mode de croisière standard (SCM) et vitesse maximale, cargaison en SCU, points de
  bouclier et de coque. Une valeur 0 dans la fiche veut dire « non fournie » et n'est jamais utilisée comme limite.
  La fiche arrive avec son âge (quand ce serveur l'a lue), la date de dernière modification par le wiki et la
  version du jeu dont elle porte la marque, quand le wiki les donne. Les chiffres voyagent dans `sc_live_poll` sous
  `specs`, une quatrième section du poll allégé à côté du vaisseau, du pilote et des armes : elle est envoyée une
  fois, puis omise (`unchanged`) tant que son hash (`have.specs`) est celui que la View détient.
- **Ce que le cadran en fait.** L'arc du cadran de vitesse va de 0 à la vitesse maximale de la fiche, avec une marque
  à la vitesse SCM et une au maximum, et la valeur est donnée en part de la vitesse SCM (« 87 % de la vitesse SCM »).
  Sa ligne d'échelle indique « d'après la fiche (wiki) » à la place de l'échelle déduite. Au-dessus de la vitesse
  SCM, il le dit ; au-delà du maximum de la fiche, et pendant un saut quantique, la vitesse sort du cadre et la View
  le dit au lieu de couper l'arc en silence. La carte « Fiche du vaisseau (wiki) » de la vue complète liste chaque
  chiffre avec son âge.
- **Ce qui n'est pas connu.** La capacité du réservoir d'hydrogène n'est pas confirmée dans les données du wiki que
  ce projet lit : elle n'est donc ni affichée ni déduite, et l'autonomie en hydrogène reste l'estimation étiquetée
  par la pente. Le flux n'a pas non plus de niveau de bouclier ni d'état de coque : les points de bouclier et de
  coque de la fiche ne sont qu'une référence, pas une jauge.
- **Quand l'échelle reste observée.** Si la fiche est en attente, inconnue, ambiguë, indisponible, ou ne donne pas
  de vitesse, le cadran garde l'échelle déduite des vitesses vues et une ligne dit pourquoi (« échelle déduite :
  fiche du vaisseau introuvable »). Un vaisseau modifié, une variante ou un correctif peuvent différer du wiki :
  regardez l'âge et la date avant de vous fier à un chiffre.
- **Texte de tiers.** Les noms et versions venant du wiki sont nettoyés et plafonnés sur le serveur, et affichés en
  texte brut. Aucun nouvel hôte n'est contacté : le wiki figure déjà dans la liste des hôtes que ce serveur peut
  joindre.

Le tableau de bord montre ce que montre le flux et hérite de chaque limite et de chaque risque de cette page. Nous
ne prétendons pas qu'il soit approuvé par Cloud Imperium Games.

Un aperçu pour les personnes qui travaillent sur la page : `npm run build`, puis `node scripts/dashboard-preview.mjs`,
puis ouvrez l'adresse locale qu'il affiche (boucle locale, port 4173 par défaut). Il joue un vol fictif, saut
quantique complet compris, face à un hôte factice ; ni jeu ni Claude n'interviennent. La liste qui suit n'est pas complète (`scripts/dashboard-preview.mjs` lit aussi `conn`, `preflight`, `transport`, `sessions`, `health`, `seen`, `help`, `calib`, `specs`, `balance`, `card`, `menu` et `open`) : lisez ce script pour la liste à jour. Paramètres : `t`, `theme`,
`w`, `mode`, `scroll`, `forced`, `cut`, `plan`, `trade` (la carte Commerce avec un journal de commerce inventé : `story`, `estimated`, `unknown`, `partial`, `second`, `none`), `fw` (largeur du cadre en plein écran), `suggest` (ce que répond l'outil de la barre d'actions de commerce, avec des routes inventées et sans UEX : `ok`, `wait`, `error`, `empty`, `nospeed`, `reported`, `slow`), `click` (le libellé d'un bouton à presser) et `refine=1` (ouvre « Affiner »).

### Raccourcis selon le contexte

Une zone « Raccourcis », sous le bandeau du vaisseau, rappelle les actions qui ont du sens à cet instant (train sorti, à
pied, dans un véhicule terrestre...). Elle ne lit que des états que le flux et `Game.log` portent déjà, jamais un
chiffre ni le solde, et elle n'appuie sur rien : c'est un affichage.

- **Quand elle s'affiche.** Seulement quand le flux est vivant, que `Game.log` ne dit pas menu, déconnecté ou fermé, et
  que les valeurs ne sont pas grisées (pas de trames périmées). Sinon elle est masquée. Pour un contexte qu'elle ne sait
  pas nommer, elle n'affiche rien dans la vue compacte et, en plein écran, « Contexte inconnu : aucun rappel pour
  l'instant. »
- **Ce qui déclenche quoi.** Train sorti (`ship.gear` vaut « deployed ») et vaisseau pas posé (`ship.landed` est faux) :
  « Atterrissage automatique », formulé « si la demande est accordée » parce qu'un pad accordé n'est pas dans le flux,
  puis la demande d'atterrissage. Posé : la demande de décollage. Centrale éteinte : Flight Ready. Mode quantique :
  le saut. Verrouillage hostile : leurres et brouillage (une contre-mesure que le flux dit épuisée est omise).
  Boucliers coupés, c'est-à-dire alimentation coupée (en vol seulement, et pas en mode quantique, où ils sont coupés
  exprès) : alimenter les boucliers ; des boucliers simplement tombés n'ont aucun conseil, puisqu'alimenter un
  générateur qui fonctionne ne les ramène pas. À pied ou en
  EVA : la lampe de combinaison, en priorité basse (« si besoin »). Véhicule terrestre (reconnu environ 12 s après
  l'assise) : les phares. Assis sans trame de vaisseau pour l'instant : Flight Ready, « si c'est un vaisseau ».
- **Combien.** Vue compacte : trois au plus, sur une ligne qui passe à la ligne. Plein écran : six au plus. Le reste, la
  phrase sur les touches et le bouton « Il fait sombre » sont derrière UN bouton (`aria-expanded`), le seul arrêt de
  tabulation de la zone tant qu'elle est repliée. Aucune zone « live », rien n'est enregistré. Dans l'ordre « vol » du plein
  écran (section suivante), elle se limite à ce qui a une touche (X, H, J, T) ou une alerte ; le reste est derrière le même
  bouton.
- **Les touches.** La règle : une touche n'est écrite que si au moins deux sources publiques indépendantes la donnent et
  qu'aucune n'en donne une autre. Il reste X (frein spatial), H (leurres), J (brouillage) et T (lampe de combinaison),
  toujours à côté du mot « défaut », avec une info-bulle qui dit de vérifier dans vos propres réglages, et **aucune n'a
  été vérifiée en jeu sur la 4.10**. Toute autre action est affichée SANS touche, exprès : le saut quantique (B est la
  bascule SCM/NAV des modes maîtres ; le saut est un appui long sur le bouton gauche de la souris, qui n'est pas affiché
  non plus), le régulateur de vitesse et le mode découplé (un guide 4.10.2 les inverse par rapport au wiki), Flight Ready
  (un guide 4.10.2 dit Alt droit + R, pas R), le train, l'atterrissage automatique, la demande d'atterrissage, le
  décollage, les phares, la puissance des boucliers et quitter le siège. La table est une donnée, `shortcutsTable()` dans
  `src/dashboard/shortcutsPanel.ts`, une ligne par action avec les lettres des sources derrière sa touche (`src`) ; les
  sources elles-mêmes, leurs dates, la version de la table, la version du jeu, la liste des touches que quelqu'un a vues
  fonctionner en jeu (vide) et la raison pour laquelle chaque action écartée n'a pas de touche sont dans
  `src/dashboard/shortcutsSources.ts`, qui n'est pas livré dans la page. Un test exige deux sources distinctes pour
  chaque touche. Sur un clavier à la disposition AZERTY, les lettres X, H, J et T gardent leur place ; on n'a pas vérifié
  si le jeu suit la disposition ou la position physique.
- **Ce qu'elle ne dit jamais.** Que les phares sont éteints : `ship.lights_on` ne distingue pas « éteint » de « non
  rapporté », donc le rappel des phares ne porte aucun état (« état non lu »). Le mode de vol courant :
  `advanced_hud_enabled_scm` et `advanced_hud_enabled_nav` sont des préférences d'affichage et ne sont pas lus. Qu'il
  fait sombre : rien dans le flux ni dans le journal ne le dit. La lampe de combinaison est listée à pied et en EVA, et
  « Il fait sombre » est un bouton que vous pressez : il met les lumières en tête, et ne vit que dans la mémoire de la
  page (rien n'est enregistré, c'est perdu au rechargement).
- **Pas encore construit.** Vos propres touches (`actionmaps.xml`) et l'état du casque ; voir [ROADMAP.md](ROADMAP.md).

### Ordre des sections en plein écran

Le plein écran a deux ordres de sections, choisis d'après ce que la page sait déjà. Seuls le placement et un pli changent :
aucune section ne change de mots, aucun chiffre n'est ajouté, et le choix du solde est inchangé (les nouveaux mots ne portent
aucun montant).

- **Ordre « vol ».** Le verdict et les alertes, le bandeau du vaisseau, la ligne du trajet en cours (le même texte que la vue
  compacte, seulement pour un trajet ouvert ou partiel et non coupé par une perte de vaisseau), puis les instruments ; viennent
  ensuite les raccourcis (limités comme ci-dessus ; avec un rappel d'ALERTE dedans, une contre-mesure, un verrouillage
  hostile ou des boucliers coupés, la zone se place plutôt entre le bandeau et la ligne du trajet, tout de suite, et
  redescend 3 secondes après la fin de l'alerte), la carte Commerce, la session, la bande d'état, puis le reste. La carte
  Commerce est repliée en une ligne (son étape et sa route, rien d'autre) avec un bouton nommé « Carte Commerce » (le nom ne
  change jamais : `aria-expanded` et `aria-controls` portent l'état)
  tant qu'il ne s'y est rien passé de frais : « frais » veut dire ce que le bouton « Demander à Claude » compte déjà comme un
  événement de commerce (une perte de vaisseau, un prix refusé, un trajet terminé depuis moins d'une demi-heure). Votre pli
  l'emporte et dure jusqu'au changement d'ordre : après un atterrissage et un décollage, la carte est donc de nouveau repliée
  par la règle ; la règle ne replie jamais la carte quand le focus clavier est dedans.
- **Ordre « commerce »** : l'ordre que la page a toujours eu (bandeau, raccourcis, session, carte Commerce, instruments),
  parce que préparer une route est l'objet au sol.
- **Ce qui décide.** Vol : le flux est vivant et la section vaisseau dit qu'il n'est pas posé (en l'air, en mode quantique ou
  en saut). Commerce : posé, à pied, en EVA ou dans un véhicule terrestre. **Inconnu, qui reçoit l'ordre commerce et le dit
  sur le bouton** (« Ordre : auto · contexte inconnu, ordre commerce ») : pas de flux vivant, `Game.log` disant menu,
  déconnecté ou fermé, un vaisseau dont `landed` n'est pas rapporté, un vaisseau éteint, un siège sans vaisseau, ou une
  section vaisseau qui contredit la locomotion du pilote. Le train n'est pas lu : train sorti serait une supposition que vous
  allez vous poser. **Un flux gris n'est pas un changement de situation** : quand les trames sont périmées (environ 5
  secondes) alors qu'un ordre est affiché, cet ordre reste ; seuls menu, déconnecté, fermé et une contradiction ramènent
  la page à l'ordre commerce. **Non vérifié en jeu :** quand le jeu omet `is_landed` (dans un hangar, à une réapparition),
  la section vaisseau peut dire « pas posé » et afficher l'ordre vol alors que vous êtes au sol ; le bouton force l'autre
  ordre.
- **Pas de saut.** Un changement n'est appliqué qu'après 3 secondes de stabilité (un `landed` qui oscille chaque seconde ne
  déplace rien), tout de suite la première fois qu'une situation connue est lue, et jamais tant que le focus clavier est dans
  une section qui bougerait (il attend que le focus parte), et, pour un changement automatique, jamais tant que la page est
  défilée de plus de 200 px (il attend le haut ; l'appui du joueur sur le bouton s'applique toujours). Un changement
  automatique est dit une fois, « Ordre : vol » ou « Ordre : commerce », dans la zone d'état déjà présente de la page (aucune
  zone ajoutée). La vue compacte ne change jamais d'ordre.
- **Le bouton** « Ordre : auto / commerce / vol » de l'en-tête (plein écran seulement) fait tourner auto, commerce, vol et
  s'applique tout de suite. Le choix vit dans la mémoire de la page : ni stockage, ni fichier, aucune nouvelle clé
  `localStorage`.
- **Clavier.** La page déplace les nœuds eux-mêmes (pas de CSS `order`), donc l'ordre de tabulation est l'ordre dessiné ; des
  tests le parcourent pour les deux ordres. Aucune nouvelle zone « live ».

### Carnet de transport

Un panneau du tableau de bord en plein écran (« Carnet de transport ») qui relie le journal de jeu à la variation du
solde mesurée par la télémétrie, pour montrer ce que rapporte réellement un transport. Dans la vue réduite, c'est une
seule ligne tant qu'un contrat est en cours (« Contrat en cours : titre, étape 2/3 »).

- **Il faut le journal de jeu.** Le journal est désactivé par défaut (`SC_INSTALL_DIR` ou `SC_GAME_LOG_PATH`). Sans lui,
  le panneau le dit et renvoie vers `sc_log_status`, qui explique comment l'activer ; rien n'échoue.
- **Ce qu'il sait.** Pour les contrats de la session de jeu en cours : le titre, un identifiant court de mission, la
  date d'acceptation et de fin (terminé, abandonné ou échoué), et pour chaque étape de transport un chargement ou une
  livraison avec son lieu et le nom de la marchandise, dans l'ordre où le jeu les a annoncées. **Réserve :** ces lignes d'étapes existent dans les journaux écrits jusqu'au
  printemps 2025 et sont absentes des 12 journaux de la version 4.10 de l'installation de référence (cause non
  vérifiée) : sur les versions actuelles, attendez-vous aux contrats, à leurs durées et au gain mesuré, mais pas aux
  étapes. La durée est la fin
  moins l'acceptation. Les étapes sont cochées d'après le nombre de notices « Objective Complete » du contrat ; cela
  suppose qu'elles arrivent dans l'ordre des étapes, et le journal ne dit pas quelle étape elles closent : les coches
  sont donc une estimation.
- **Ce qu'il ne sait pas.** La quantité (SCU) et la récompense : le journal de jeu ne contient ni l'une ni l'autre,
  le panneau n'en montre donc aucune. Une étape sans quantité n'en montre pas. Les contrats acceptés lors d'une
  session de jeu précédente ne sont pas dans le journal courant. Seule la fin d'un journal très long est lue, et le
  panneau le dit.
- **Le seul chiffre d'argent est mesuré.** Le gain d'un contrat terminé est le solde après le contrat moins le solde à
  son acceptation, tous deux tirés de l'historique des changements de solde de la télémétrie (gardé en mémoire, 500
  changements au plus, rien n'est écrit). Le solde est lu quelques secondes après la fin (10 s, une hypothèse non
  mesurée avec le vrai jeu) pour compter une récompense versée juste après la notice ; d'ici là le gain est « en
  attente ». Il mêle les achats, les récompenses et les amendes survenus entre-temps : il est donc marqué
  `mesure_brute` avec `mixed_flows_possible: true`, et ce n'est pas un bénéfice net. Si la télémétrie ne tournait pas
  ou avait une coupure à l'un des deux instants, le gain est inconnu (jamais zéro). Quand deux contrats se
  chevauchent, chaque chiffre contient aussi la récompense de l'autre et le signale ; le total compte le
  chevauchement une seule fois. Le rythme (aUEC par heure) demande au moins deux minutes de contrat. L'historique des
  bord doit être ouvert (la télémétrie ne lit que pendant qu'une View interroge) pour que l'historique existe.
- **Prévu et récompense mesurée.** Si Claude a passé un `plan` de route à l'ouverture du tableau de bord, le panneau
  place le profit prévu (avant frais) à côté de la « récompense mesurée » du dernier contrat terminé : c'est la
  variation du solde sur ce contrat, donc la récompense moins ce que le contrat a coûté, pas un bénéfice. Il ne peut
  pas vérifier que ce contrat est la route prévue. Pour le bilan d'un trajet commercial, voir la carte Commerce.
- **Confidentialité du solde.** Tout ce qui dérive du solde (gain, total, rythme, prévu contre réalisé) est construit
  par le serveur et dessiné par la page tant que le solde est affiché (par défaut). Solde masqué (« Masquer le solde », `SC_BALANCE=hidden`), le carnet ne montre que les étapes et les durées, et la réponse du serveur ne contient aucun de ces chiffres. Rien n'entre dans le
  résumé automatique envoyé au modèle ni dans les messages fixes.
- **Charge.** La date de modification du fichier du journal est consultée au plus toutes les 5 secondes, à partir d'une
  interrogation, et rien n'est lu tant que cette date n'a pas changé. La première lecture prend la fin du journal
  (comme les autres outils du journal) ; ensuite seuls les octets ajoutés par le jeu sont lus et analysés (avec un
  court recul pour ne jamais couper deux lignes écrites ensemble). Un fichier plus court, un début différent (une
  nouvelle session de jeu) ou un journal en UTF-16 recommence par une lecture complète. Les lectures sont asynchrones
  et ne posent aucun verrou ; l'analyse est un travail synchrone proportionnel à ce qui a été lu. Une interrogation ne
  l'attend jamais : elle porte le dernier résultat. Le carnet est une section de l'interrogation allégée comme la
  fiche du vaisseau (empreinte, omis tant qu'il ne change pas), et les autres tableaux de bord de la conversation le
  reçoivent par le canal entre Views sans aucun chiffre dérivé du solde.
- **Texte venu du jeu.** Les titres de contrat, les lieux et les marchandises sont nettoyés (caractères invisibles et
  de changement de direction retirés), plafonnés à 80 et 60 caractères, et affichés en texte brut uniquement.

### Carte Commerce

Une carte en haut du tableau de bord plein écran (« Commerce ») qui dit ce qu'un trajet commercial a vraiment rapporté,
et une ligne dans la petite vue. Elle remplace l'ancien bloc « Prévu / Réalisé », qui mettait un BÉNÉFICE prévu à côté
d'une VARIATION du solde : cette variation contient aussi le coût des marchandises, les ventes et les frais, donc les
deux lignes ne parlaient pas de la même chose. Chaque chiffre a désormais un seul sens :

| Chiffre | Sens | Comment on l'obtient |
| --- | --- | --- |
| Bénéfice prévu | Le profit attendu du plan : ventes prévues moins achats prévus, avant frais | Du plan de Claude |
| Chiffre d'affaires | Ce que les ventes ont rapporté (les montants des transactions de vente) | Mesuré (montants du journal) |
| Coût d'achat | Ce que les achats ont coûté (les montants des transactions d'achat) | Mesuré (montants du journal) |
| Marge brute | Revenu des SCU appariés à un achat moins leur coût, appariés premier entré, premier sorti par marchandise exactement comme `sc_trade_journal` (`pairCargoRuns`) ; les SCU invendus et ceux vendus sans achat dans le trajet ne sont pas valorisés. Le chiffre à comparer au bénéfice prévu | Calculé |
| Écart de prix | Marge brute moins bénéfice prévu. Les prix et les quantités le font bouger, et la carte le dit quand la quantité achetée diffère du plan | Calculé |
| Frais | Ce que le service de chargement a pris en plus des prix. Le journal n'a pas de ligne de frais | Mesuré côté par côté contre le solde quand c'est possible ; sinon le total déduit (marge brute moins la variation du solde) seulement si c'est un frais plausible (0 à 50 % du chiffre d'affaires), marqué « estimé » ; sinon inconnu, avec la raison (« le solde a bougé pour une autre raison ») |
| Bénéfice net | La variation du solde sur le trajet : solde après la dernière vente moins solde juste avant le premier achat. Elle contient TOUS les mouvements de ce temps (une récompense, un autre achat), pas seulement le trajet ; la carte dit ce que la marge et les frais n'expliquent pas | Mesuré dans l'historique du solde de la télémétrie (étiquette « variation du solde ») ; inconnu (jamais zéro) si le tableau de bord n'a pas vu le solde avant l'achat |

- **Avant un trajet, et l'avertissement sur le solde.** Tant que rien n'est mesuré (pas encore de trajet, solde masqué, ou
  pas de journal lisible) la carte ne dessine que ce qui existe : la tuile du bénéfice prévu (étiquette « plan »), une
  ligne simple qui dit pourquoi il n'y a pas de bilan (« Journal du jeu non lisible : pas de bilan réel pour ce trajet »,
  qui renvoie à la bande de branchement), et aucune des tuiles vides « — ». Après un trajet, quand le solde a bougé de plus
  que la marge et les frais ne l'expliquent, l'avertissement ambre est SOUS les chiffres et tient en une phrase qui nomme
  ce qui a aussi bougé (« Le solde a aussi bougé de +85 000 aUEC (récompense probable), −9 000 aUEC (coût possible) … :
  ce n'est pas le bénéfice de ce trajet seul. »), avec un bouton « Détail » qui ouvre le bloc « Mouvements du solde », où
  se trouve le compte complet. Aucune donnée nouvelle : la même décomposition, lue autrement.
- **D'où viennent les transactions.** Du journal de commerce du journal de jeu (`src/providers/gamelog/trade.ts`, celui
  de `sc_trade_journal`) : le tableau de bord n'analyse rien lui-même. Les lectures du carnet (complète, puis seulement
  les octets ajoutés par le jeu) gardent aussi les lignes de commerce, le journal les apparie, et le modèle de commerce
  en prend les transactions : seules les terminées comptent, exactement comme le journal ; les lignes échouées et non
  confirmées (les ambiguës comprises) sont laissées de côté et signalées par une note sur la carte ; un montant dans une
  autre monnaie que l'aUEC n'est jamais ajouté. Le journal nomme les marchandises par un identifiant seulement (les 8
  premiers caractères du GUID du jeu) ; les noms que `sc_trade_journal` trouve dans la liste du wiki ne sont pas
  cherchés par le serveur en arrière-plan (une requête pour la liste publique, comparée localement sur le GUID complet,
  au plus toutes les 5 minutes par GUID, jamais attendue par le sondage, seulement avec la télémétrie activée, et pas du
  tout avec `SC_COMMODITY_NAMES=off`) : le trajet porte alors `commodity_name`. Tant
  qu'il est inconnu la carte dit « marchandise inconnue » (l'identifiant n'est jamais affiché) et la ligne compacte d'un
  trajet en cours prend la marchandise du plan, étiquetée « d’après ton plan », et un plan ne peut
  pas être comparé aux marchandises du journal (« supposé »). Sans journal de jeu il n'y a pas de journal de commerce :
  la carte le dit, montre le plan et montre la variation du solde sous son vrai nom (« Variation du solde », avec
  l'avertissement que ce n'est pas un bénéfice). Les tests et l'aperçu font passer des lignes de journal inventées par
  le même analyseur.
- **Comment les frais sont mesurés.** Pour chaque côté, les transactions proches dans le temps sont regroupées ; les
  variations du solde vues dans une fenêtre autour d'elles (2 s avant à 8 s après le groupe, hypothèse non encore
  mesurée avec le vrai jeu) sont additionnées. À l'achat : frais = (baisse du solde) moins prix. À la vente : frais =
  prix moins (hausse du solde). Les frais peuvent être une variation à part un instant plus tard, d'où la somme. Un
  groupe est refusé, jamais deviné, si la fenêtre contient une transaction de l'autre sens, une ligne que le journal n'a pas pu confirmer (elle a peut-être aussi bougé le solde, et le total déduit est alors retenu aussi), un trou dans le flux, plus
  de deux variations du solde par transaction, ou donne des frais invraisemblables (négatifs, ou plus de la moitié du
  prix). « mesuré » : une transaction a été rapprochée ; « mesuré (groupé) » : plusieurs réglées ensemble. Si un côté
  ne se rapproche pas, le total est déduit de la marge et du net et marqué « estimé » ; si le net est inconnu aussi,
  les frais sont inconnus.
- **Bénéfice net = variation du solde.** Le solde juste avant le premier achat est celui d'avant la première baisse du
  solde autour de lui ; le solde final est lu 8 s après la dernière transaction. C'est toute la variation du solde entre
  les deux, qui peut durer des heures : la carte montre `fees.unexplained` (marge brute moins net moins frais) comme « non expliqué » et
  avertit visiblement (mot « Attention ») au-delà de 2 % du chiffre d'affaires, dans tous les chemins des frais
  (mesurés, déduits). Rien n'est construit sur un tel net : ni chiffre par heure ni chiffre du prochain trajet. Un
  trajet en cours (cargaison pas entièrement vendue) n'a pas de net. Les SCU vendus sans avoir été achetés dans le
  trajet (stock antérieur) sont signalés, non valorisés, et empêchent de déduire les frais.
- **Rythme et projection.** La durée va du premier achat à la dernière transaction (deux minutes au moins, trajet
  terminé). Les chiffres par heure reposent sur un cycle : le temps entre le début de ce trajet et celui du précédent
  quand il y en a deux, sinon le trajet plus 10 minutes de chargement, de trajet à vide et d'attente (hypothèse non
  mesurée, dite sur la carte). Net par heure, répétitions par heure et prochain trajet net de frais (bénéfice prévu
  moins le taux de frais observé fois le chiffre d'affaires) sont des estimations. Le chiffre « par 4 heures de jeu »
  (une hypothèse) n'apparaît qu'après deux trajets mesurés. La carte liste les hypothèses : même trajet, mêmes prix et
  même quantité, marchandise toujours disponible, prix qui ne baissent pas quand on vend plus, frais au même taux.
- **Estimé contre mesuré.** Une barre mesurée est pleine et marquée « mesuré » ; une barre estimée est hachurée, a un
  bord en pointillés et le mot « estimé ». La couleur n'est jamais le seul signal.
- **Courbe des cours.** Les prix récents du plan, leur moyenne, le prix visé par le plan et, une fois le solde affiché,
  le prix moyen réellement obtenu par SCU. Le point est le dernier prix. Les relevés sont ceux de Claude, tirés d'UEX,
  et peuvent dater.
- **Confidentialité du solde, plus stricte que le carnet.** Tout montant d'un trajet (chiffre d'affaires, coût, marge,
  frais, net, rythme, projection) est construit par le serveur seulement tant que le solde est affiché, et dessiné seulement alors. Sans lui, la section ne contient que marchandises, lieux, SCU, heures et nombres, rien en
  aUEC. Elle circule sur le canal entre Views sans aucun montant (retiré par l'émetteur puis par le récepteur) et
  n'entre jamais dans le résumé automatique ni dans les messages fixes.
- **Plusieurs trajets.** Un achat après une vente commence un nouveau trajet (deux heures de silence aussi) ; la carte
  montre le dernier et liste les précédents. Le plan s'applique au dernier trajet seulement ; si la marchandise ne
  correspond pas, elle dit que le plan n'est pas vérifié.
- **Barre d'actions.** Juste sous les chiffres principaux se trouve la barre décrite dans la section suivante (elle est
  aussi accessible avant tout trajet ou plan).
- **Où est passé l'argent (« Mouvements du solde »).** Un bloc replié dans les détails de la carte, et les mots de
  l'avertissement « non expliqué » de la carte. Un explicateur pur (`src/dashboard/balanceMovements.ts`) étiquette
  CHAQUE variation du solde de la session de jeu (et, pour un trajet, la fenêtre exacte sur laquelle son net a été lu)
  avec au plus une cause et un degré de certitude honnête. Entrées, toutes déjà là : l'historique du solde de la
  télémétrie (un point par variation, précision d'environ une trame sur l'horloge de ce serveur, 500 variations gardées
  en mémoire : il n'utilise pas les événements agrégés `uec_changed`), les transactions du journal de commerce
  (marchandises et objets de boutique), la fin des contrats, les demandes de réclamation d'assurance, les demandes de
  hangar et `login_completed` (le service du carnet garde ces derniers à part de ses propres événements). Catégories :

  | Catégorie | Sens | Certitude |
  | --- | --- | --- |
  | `explained_by_transaction` | une transaction du journal et la variation du solde concordent (marchandises via la réconciliation du modèle de commerce ; autres lignes par montant exact) | `matched` |
  | `fee_on_transaction` | ce qu'un règlement de marchandise a pris en plus du montant du journal, par groupe : le `clusterFee` du modèle, pas une copie | `measured` (`ambiguous` quand la même fenêtre contient aussi un objet de boutique, une fin de contrat ou un événement d'assurance/hangar) |
  | `item_purchase` | une ligne d'objet de boutique terminée dont le total égale une variation du solde ; appariée AVANT la réconciliation des marchandises, qui ne voit plus que les variations restantes (un objet acheté à côté d'une vente n'est pas absorbé dans ses frais) | `matched` |
  | `probable_contract_reward` | une hausse par ailleurs non expliquée de 3 s avant à 20 s après la fin d'un contrat `completed` ; le montant est celui du solde, le journal n'a aucune ligne de récompense ; la carte dit « Récompense probable de contrat » | `probable` |
  | `probable_insurance_or_hangar_cost` | une baisse par ailleurs non expliquée de 3 s avant à 20 s après une demande de réclamation d'assurance ou une demande de hangar terminée. Le journal n'a aucune ligne sur ce que cela coûte : TOUTE baisse de cette fenêtre (carburant, un achat) convient ; la carte dit « Coût possible (hangar ou assurance) », étiquette « possible », et ne nomme jamais la cause | `probable` (affiché « possible ») |
  | `unexplained` | tout le reste ; raisons `no_cause`, `ambiguous` (deux sortes de cause conviennent : aucune n'est choisie) ou `stream_gap` (la variation chevauche une coupure du flux : ni son heure ni son contenu ne sont connus) | `none` / `ambiguous` |

  Une variation va à une cause au plus (une preuve forte, un montant qui correspond, passe avant la proximité dans le
  temps). Une variation du côté d'une ligne de cargaison dont les frais n'ont pas pu être mesurés, dans la fenêtre de cette
  ligne (une récompense versée juste après une vente fausse le rapprochement), peut être la vente ou la récompense : elle
  est `unexplained` et `ambiguous`, avec les deux causes nommées, jamais comptée comme récompense probable. Les frais
  déduits du solde (`estime` : marge brute moins net, quand le flux était coupé ou la fenêtre illisible) peuvent contenir
  une récompense ou un achat fait ailleurs : la carte le dit, et ils ne servent ni au net prévu, ni au taux reporté au
  trajet suivant, ni au taux de frais de la fiabilité des trajets. **Carburant, réparations, amendes, virements entre joueurs et récompenses sans événement à côté ne laissent
  aucune ligne dans le journal : ils ne peuvent être que « non expliqués »**, et le bloc dit ce que ce pourrait être sans
  en choisir un. Un contrat échoué ou abandonné juste avant une baisse n'ajoute qu'un indice, jamais l'affirmation d'une
  pénalité. Invariant, testé : les montants de toutes les entrées s'additionnent, à l'aUEC près, à la variation du solde
  de la fenêtre ; un règlement qui contient un prix et des frais est UNE variation du solde coupée en deux parts d'une
  seule cause. Les variations non expliquées de même signe distantes de moins d'1 s sont montrées sur une ligne (une chaîne est coupée après 5 s). Le texte de session dit « Rien d’autre n’est resté sans piste », pas que tout est expliqué : une proximité dans le temps est une piste, pas une explication. L'équation affichée utilise les parts de transaction appariées pour que la somme tombe juste (elles égalent la marge brute à 0,1 % près quand elle se boucle, et le texte le dit). Quand les frais sont mesurés dans une fenêtre qui contient aussi une autre cause possible, la tuile et la ligne de la cascade de la carte disent « ambigu », comme le bloc.
  **Décomposition d'un trajet.** Pour un trajet dont le net est mesuré, l'avertissement (affiché quand le net contient
  plus que la marge et les frais n'expliquent) dit : variation = marge brute + frais + objets + récompenses probables +
  coûts probables + non expliqué, la part non expliquée étant nommée. L'équation n'est présentée comme bouclée que si tout
  ce qui a été acheté a été vendu pendant le trajet, sans stock d'avant et si chaque ligne du journal a trouvé sa
  variation du solde ; sinon seules les variations sont additionnées. Le `fees.unexplained` historique garde son signe
  (positif : le solde a plus baissé que la marge ne le dit) ; les parts de la décomposition sont dans le signe du solde.
  **Tolérances, et ce qui est mesuré :** 3 s avant / 20 s après pour récompenses et coûts (les 3 s sont mesurées : sur
  les 95 journaux de l'installation de référence, l'avis « Contract Complete » arrive 0 à 3,1 s après `MissionEnded` ;
  les 20 s sont une hypothèse, le double du délai de stabilisation du carnet), 2 s avant / 8 s après pour les
  transactions (hypothèse du modèle de commerce), montants exacts à plus ou moins le plus grand de 1 aUEC et 0,1 %.
  Mesuré aussi sur ces journaux : aucune des 57 fins de contrat (tous états) trouvées dans des journaux qui
  contiennent aussi des lignes de commerce ne tombe à moins de 30 s d'une ligne de boutique ou de commerce (récompenses et
  ventes ne semblent donc pas se disputer), les achats de marchandise d'un règlement sont espacés d'au moins 10 s
  (compatible avec le groupe de 20 s), seules 12 % des lignes d'objets suivent une autre à
  moins de 4 s, et les demandes de réclamation d'assurance sont surtout isolées (155 des 187 rafales sont une seule
  ligne). Ce qui n'a PAS pu être mesuré : le délai entre une ligne du journal et la variation du solde qu'elle cause
  (le journal n'a pas de solde : il faut une capture des deux en même temps), et ce que coûtent vraiment une assurance
  ou un hangar. Tout montant ici est dérivé du solde : construit seulement tant que le solde est affiché, dessiné seulement alors, retiré par l'émetteur et le récepteur sur le canal entre Views, jamais dans `ui/update-model-context` ni les
  messages fixes. Le bloc liste les 40 mouvements les plus récents (les totaux couvrent tous ; les filtres et
  « Ce trajet seulement » ne voient que ces lignes, et le bloc le dit quand la liste est plus courte que les totaux).
  Rien de tout cela n'est stocké dans le résumé de session.

#### Actions de commerce : trouver la prochaine route

La barre demande au serveur, sans passer par le modèle, les routes qui correspondent à ce que veut le joueur. C'est le
planificateur de `uex_plan_trade` derrière un outil réservé à la page (`sc_trade_suggest`, `visibility: ["app"]`,
listé seulement quand la télémétrie est activée et que le client affiche des Views). Rien n'est demandé avant un clic.

| Bouton | Ce qu'il demande | Ordre des cartes |
| --- | --- | --- |
| **Plus rentable** | `profit_per_hour` | aUEC par heure estimée ; le grand chiffre est le gain par heure |
| **Plus rapide** | `speed` | cycle estimé le plus court ; le grand chiffre est la durée |
| **Plus sûre** | `safety` | le moins de facteurs de risque de l'heuristique du planificateur, puis le gain par heure. Elle ne dit jamais « sûre » |
| **Gros gain** | `profit` | aUEC par trajet, durée mise de côté |

Sous « Affiner » (replié) : *Éviter Pyro*, *Zones d'armistice seulement* (l'indicateur d'armistice d'UEX ; inconnu compte
pour non), *Relevés de joueurs exigés* (`min_reports` 1 : ne garde que les options avec un relevé de joueur à chaque
bout), *Aller-retour seulement* (masque les chaînes ouvertes A>B>C ; ce n'est pas `max_legs`, qui exige un départ et ne
rend que des routes aller simple), un budget (un nombre : `250000`, `2,5M`), la soute (une liste, voir ci-dessous), un
départ (un terminal, une planète ou un système, résolu par le serveur) et *Proposer la suite à la fin d'un trajet*.
Quand une recherche existe, changer une option la relance seule après un court temps de calme ; avant le premier clic,
rien n'est demandé.

- **La soute (« Soute (SCU) »).** Une vraie liste, pas un champ vide, avec une valeur déjà choisie : un clic sur un bouton
  lance donc la recherche tout de suite, sans ouvrir « Affiner ». La valeur par défaut vient de ce que le serveur sait
  déjà, dans cet ordre, et sa source est toujours écrite sous la liste :
  1. la **soute du vaisseau piloté** (sa fiche wiki ; elle n'est pas envoyée, le serveur prend celle du vaisseau et le dit) ;
  2. le **dernier trajet** : le trajet le plus récent du journal de commerce lu (ou des sessions enregistrées), quand il
     s'est terminé il y a moins de 3 jours (« D'après ton dernier trajet : 696 SCU transportés ») ;
  3. sinon la taille **la plus utilisée par les trajets de commerce enregistrés** (la plus récente en cas d'égalité),
     présentée comme une habitude ;
  4. sinon **la seule soute du fichier de flotte** (`sc_fleet_add`), signalée comme faible (rien ne dit qu'elle sert) ;
  5. sinon rien : la liste ne contient que « Choisis ta soute… » et « Autre taille… », et l'état le demande.

  La liste propose chaque taille connue une fois : le vaisseau piloté, les trajets récents (« 696 SCU · dernier trajet il y
  a 2 j », « 120 SCU · 3 trajets, le dernier il y a 5 j ») et les vaisseaux de la flotte (« Nom · 3 200 SCU · dans ta
  flotte »), puis **Autre taille…**, qui montre un champ numérique avec son étiquette. Ce que le joueur choisit ou saisit
  l'emporte sur le vaisseau piloté et sur la valeur par défaut, et la note sous les résultats dit d'où vient la soute
  (« choisie dans ta liste », « d'après ton dernier trajet », « saisie »). Deux choses ne sont PAS affirmées. Les **SCU
  d'un trajet sont la quantité transportée, pas la capacité** : au mieux elle égale la soute, d'où le mot
  « transportés » et la mention que la soute peut être plus grande. Et **le journal du jeu ne nomme pas le vaisseau d'un
  trajet** (la ligne du kiosque ne porte qu'un identifiant d'entité, que ce projet ne garde jamais) : un trajet ne reçoit
  donc jamais de nom de vaisseau depuis l'historique. Un nom à côté d'une taille a trois sens possibles, et l'étiquette
  dit lequel : le vaisseau piloté ; un vaisseau du fichier de flotte ; ou « taille du X » quand X est le seul vaisseau
  auquel UEX donne exactement cette soute (une constatation sur la taille, pas la preuve que X a servi). Il n'y a pas de
  liste de cargos « typiques » : si rien n'est connu, le joueur choisit « Autre taille… ». Les tailles viennent de
  l'action `holds` de `sc_trade_suggest`, réservée à la page (trajets de commerce enregistrés, fichier de flotte, liste
  de vaisseaux d'UEX déjà en cache pour les soutes de la flotte et les noms à taille unique ; aucun calcul de route, aucun
  créneau du limiteur, aucun montant) ; le choix lui-même reste dans la mémoire de la page.

- **Mesuré, estimé, heuristique.** Les prix sont ceux d'UEX, issus de la communauté ; aujourd'hui presque toutes les
  options portent *estimation UEX · aucun relevé de joueur* (UEX ne compte aucun relevé de joueur pour un prix) : la
  barre le dit et propose l'option des relevés. Les durées sont des ESTIMATIONS (vol quantique plus 8 minutes fixes par
  arrêt) ; sans vitesse quantique (pas de fiche du vaisseau), le gain par heure et l'ordre « le plus rapide » sont
  indisponibles et les cartes disent « durée inconnue ». Le carburant n'est pas déduit. Le badge de prudence est
  l'heuristique du planificateur sur les données de lieux d'UEX (armistice, juridiction, système, type de lieu, nombre
  de vols), toujours étiquetée « (heuristique) » ; UEX n'a aucune donnée de piraterie. Les prix de plus de 7 jours sont
  marqués « périmés ». La vitesse quantique du vaisseau vient de l'état du serveur (la fiche wiki du vaisseau piloté,
  puis la même recherche que `uex_plan_trade`), jamais de la page.
- **Cartes.** La première est la tête de liste (grand chiffre, contour) ; les autres sont des lignes discrètes ; les
  chaînes (A>B>C, sans retour chiffré) sont à part et non comparables. Chaque carte a *Appliquer comme plan* (le
  serveur construit le plan à partir de sa propre option, par identifiant : l'aller, le retour nommé dans la note ; la
  carte Commerce suit alors cette route : bénéfice prévu, prix attendus, durée estimée) et *Demander à l'agent* (un
  texte fixe construit depuis la carte, envoyé comme message : la route, les prix, le statut d'estimation, les
  contraintes choisies et la demande de vérifier avec `uex_get_trade_routes` et `uex_plan_trade`).
- **Et ensuite ?** Quand un trajet se termine (il y a moins de 30 minutes), une suggestion est calculée depuis l'endroit
  où il s'est terminé : le terminal de vente du plan en vigueur (les noms de boutique du journal sont des identifiants
  du jeu qu'UEX ne connaît pas : sans plan, rien n'est demandé, appliquez une route comme plan pour obtenir la suite ;
  un terminal inconnu d'UEX échoue en silence), une fois par trajet (le serveur retient le trajet : un tableau de bord remonté ne relance pas la recherche sans
  clic), jamais appliquée toute seule. Elle peut être
  désactivée.
- **Limite de débit.** UEX est un service partagé. Le serveur répond à une question identique depuis une mémoire de 2
  minutes, partage un seul calcul entre des appels identiques simultanés, et sinon ne lance qu'UN nouveau calcul toutes
  les 8 secondes pour toutes les Views : une demande dans l'intervalle reçoit « attends N s » (un état, pas une erreur ;
  une recherche automatique réessaie seule au plus deux fois), et aucun calcul ne démarre tant qu'un autre tourne. Le
  planificateur a sa propre échéance de 20 s, plus courte que l'attente de la page (32 s). Seule la View qui mène appelle le serveur (une View qui suit prend la main quand on
  appuie sur son bouton). Aucun sondage du planificateur.
- **Le solde.** *Budget = mon solde* n'existe que tant que le solde est affiché et seulement si vous le cochez. La page
  envoie alors le nombre comme budget, avec un indicateur privé, dans l'appel d'outil : il passe par l'hôte jusqu'au
  serveur local, qui ne s'en sert que pour dimensionner les quantités (il n'est jamais envoyé à UEX, et ce tableau de
  bord ne l'écrit pas dans la conversation). La réponse ne contient jamais le solde ni le budget ; avec l'indicateur, pas
  de coût, aucune étape ne dit qu'elle est limitée par le budget, et une route appliquée comme plan est marquée privée.
  Les quantités dimensionnées par le budget restent sur votre écran : le message à l'agent ne contient alors ni
  quantité, ni total, ni gain par heure (il dit que le budget est votre solde, non communiqué), rien ne part sur le
  canal entre Views ni dans le résumé automatique, les résultats et un plan privé sont abandonnés quand vous masquez le
  solde, et un plan privé n'arrive dans la session enregistrée que tant que le solde est affiché. Les identifiants des
  options sont aléatoires (128 bits) et valables tant que la réponse est gardée (2 minutes).
- **La soute.** La page n'envoie une soute que si vous en avez tapé une ; sinon le serveur prend celle du vaisseau piloté
  et la réponse dit d'où elle vient.
- **Non vérifié.** La limite de temps de l'hôte pour un appel d'outil (la page attend 32 s), le comportement des
  boutons dans Claude Desktop et la qualité de l'heuristique face à la piraterie réelle.

#### Avant de partir : la vérification du plan, et le prix qui a bougé

Un plan est une estimation faite plus tôt à partir de prix collectés par les joueurs. Deux choses disent au joueur s'il
tient encore.

**La vérification avant le départ.** Sur un plan (une route appliquée depuis la barre, ou un plan passé par Claude), le
bloc « Avant de partir » a un bouton *Vérifier avant de partir*. Il appelle le même outil réservé à la View, action
`preflight`, sans argument : le serveur vérifie le plan QU'IL tient (la View ne peut pas désigner un plan), et la réponse
répète les noms et les prix unitaires du plan pour que la page n'affiche un verdict que pour le plan de sa carte. Le serveur
relit les lignes UEX ACTUELLES de la marchandise du plan à ses deux terminaux avec UNE requête de prix
`GET /commodities_prices?commodity_name=...` (celle de `uex_get_commodity_prices`, donc le cache est partagé) et le
`GET /game_versions` qui dit quelle version du jeu est LIVE (en cache aussi) : deux GET au plus par clic, plus les
nouvelles tentatives habituelles du client sur un 429 ou un 5xx ; un garde refuse un quatrième GET ; aucun nouvel hôte,
jamais de POST. Les lignes sont filtrées localement sur le nom exact de la marchandise, puis sur le terminal : par
identifiant UEX quand le plan a été construit par le planificateur de ce serveur (l'identifiant reste côté serveur avec le
plan, la page ne l'envoie jamais, et il n'est jamais repris d'un plan passé par Claude), sinon par le nom exact (casse,
espaces et apostrophe typographique mis à part ; un nom coupé à 60 caractères correspond par son début ; un nom que deux
terminaux partagent est « ambigu », jamais deviné). Quand un terminal a des lignes de deux versions du jeu, la ligne de la
version LIVE est jugée (pas une ligne plus récente d'une autre version) ; seulement des lignes d'une autre version se dit
« autre version du jeu ».

| Verdict | Quand |
| --- | --- |
| **✓ Toujours valable** | Le seul vert : les DEUX étapes trouvées, récentes (non périmées) ET chacune soutenue par au moins un relevé de joueur, marge en baisse de moins de 15 % |
| **≈ Inchangé · estimation UEX** | Rien n'a bougé, mais au moins un prix est une estimation d'UEX (0 relevé de joueur, ou nombre non donné). Neutre, jamais vert : « Les prix estimés par UEX n'ont pas bougé. Aucun joueur ne confirme ces prix : vérifie au terminal avant d'acheter ». Le plan est fait à partir de la même estimation : « inchangé » prouve peu (sur des données réelles presque chaque côté de prix a 0 relevé, et un `date_modified` récent ne prouve pas un relevé de joueur) |
| **⚠ À surveiller** | Marge en baisse de 15 % à 30 % ; ou une ligne relevée il y a plus de 7 jours, sans date, ou datée de plus d'un jour dans le futur ; ou un stock bas ou presque saturé ; ou un mouvement favorable de 30 % ou plus (un relevé faux est aussi probable qu'une bonne surprise ; la carte dit « Hausse inhabituelle : prix plus favorable que prévu, vérifie qu'il n'a pas changé de produit ou de lot ») |
| **✕ Dérivé** | Marge en baisse de 30 % ou plus, ou qui n'est plus positive ; ou rien à acheter (rupture), plus de demande, ou plus de prix du tout à un terminal |
| **? Impossible de vérifier** | UEX injoignable, copie ancienne du cache (jamais utilisée comme verdict), marchandise ou terminaux du plan introuvables ou trouvés seulement dans une autre version du jeu, plan sans les deux terminaux et les deux prix unitaires. Jamais vert |

Les seuils sont des CHOIX, pas des mesures (`PREFLIGHT_WATCH_MARGIN_LOSS` 0,15, `PREFLIGHT_DRIFTED_MARGIN_LOSS` 0,30,
`PREFLIGHT_STALE_MS` 7 jours dans `src/providers/uex/preflight.ts`) ; ils sont envoyés avec chaque réponse et affichés sur
la carte. La marge est la marge prévue par SCU (prix de vente moins prix d'achat) ; l'effet d'une étape est son mouvement
de prix défavorable (un prix d'achat qui monte, un prix de vente qui baisse) rapporté à cette marge. Le verdict global est
le pire des étapes et de la marge (dérivé, puis inconnu, puis à surveiller, puis inchangé-estimation, puis valable). Chaque étape montre le prix du
plan face au prix actuel et le pourcentage, l'âge de la ligne UEX, le nombre de relevés de joueurs 
(`estimation UEX · aucun relevé de joueur` quand UEX en compte 0 ; un compte absent est « inconnu », jamais 0), l'état du stock ou de la
demande de la même ligne, et la suite à donner : *Tu peux partir*, *Vérifie au terminal avant d'acheter* (*Prix périmé :
...* pour une ligne périmée), *Relance la recherche*, *Réessaie dans un instant*. La réponse ne contient que des prix
unitaires, des marges par SCU et des pourcentages : ni quantité, ni total, ni profit ; un plan dimensionné par le solde et
un plan tapé à la main ont donc la même forme et rien ne dépend de l'affichage du solde. Les phrases sont écrites par le
serveur (`src/dashboard/preflightText.ts`, à partir de codes et de nombres, aucune phrase ne contient de nom) parce que la
page a un budget de taille ; la page les nettoie et les borne à nouveau, les pose avec `textContent`, refuse un verdict
vert qu'aucune étape ne soutient, et ignore une réponse faite pour un autre plan. *Demander à l'agent* poste un texte fixe
(noms réduits à des lettres, chiffres et quelques signes, entre guillemets comme données UEX, prix unitaires, verdict, « Ne
lis pas mon solde »). Même limitation de débit que la recherche (voir Limite de débit) : une vérification identique est
servie depuis la mémoire de 2 minutes, des vérifications identiques simultanées partagent une lecture, une nouvelle lecture
UEX démarre au plus toutes les 8 secondes pour toutes les Views et jamais pendant une recherche (et inversement) ; un échec
compte dans l'intervalle et n'est pas gardé.

Ce qu'elle ne voit pas : un prix que personne n'a relevé depuis le plan paraît « inchangé » même si le prix réel du
terminal a beaucoup bougé, et le cache garde les lignes d'UEX jusqu'à 5 minutes. C'est pourquoi l'âge, le nombre de relevés
et l'état du stock font partie du verdict, pourquoi la carte dit « le prix affiché au terminal prévaut », et pourquoi,
après un refus au terminal (paragraphe suivant), une vérification faite AVANT le refus est contredite par une ligne qui
demande de contrôler le prix sur place.

**Le prix a bougé au terminal.** Le jeu refuse un achat ou une vente dont le prix affiché n'est plus celui du terminal
(`TransactionCostMismatch`). Le journal de commerce (`providers/gamelog/trade.ts`) liste déjà une telle transaction comme
échouée avec cette raison ; rien n'est analysé une seconde fois (`providers/gamelog/priceRefusals.ts` ne fait que lire le
journal). Une ligne d'erreur qui suit plusieurs requêtes du même côté ne peut pas être attribuée à l'une d'elles : elle est
comptée UNE fois, comme un événement ambigu (« une des transactions envoyées à ce moment a été refusée »). Chaque
événement est une heure, un côté (achat ou vente), un genre (cargaison ou objet de boutique) et le degré de certitude du
journal : aucun montant, aucune boutique, aucun objet, aucun identifiant ; il part donc avec ou sans le solde
(`trade.price_refusals`, les 3 plus récents, aussi sur le canal entre Views, reconstruits champ par champ à la
réception). Le tableau de bord affiche, pendant 10 minutes, « Achat refusé : le prix a changé au kiosque. Relis le prix avant de
racheter. » (ou « Vente refusée », ou un objet de boutique), sur la carte de commerce avec le temps écoulé d'abord et l'heure
ensuite, en une ligne juste sous l'en-tête dans la petite vue, ET DANS LE VERDICT de l'en-tête (« Prix changé : achat refusé
· il y a 40 s », ambre, l'heure en infobulle) à la place d'un « Tout va bien » vert (une condition rouge passe toujours
avant). Seule la phrase stable est dans les régions vivantes, pas le temps écoulé ; elle est coupée dès qu'une transaction ultérieure du même côté et du même genre a abouti (`superseded`) ; pour une cargaison il suggère de revérifier le plan (le bouton est mis en avant ; rien n'est
demandé tout seul). La session les compte : `price_refusals` (additif, optionnel, le fichier reste en version 2 et les
anciens fichiers se lisent à 0 ; un repère d'horodatage rend le comptage idempotent) dans le résumé de session,
`sc_session_current`, `sc_session_list` et `sc_session_stats` (un total et par session ; c'est un nombre, donc jamais masqué avec les montants).

Mesuré sur les 95 journaux de l'installation de référence (mars 2025 à novembre 2026, lecture seule, comptes et durées
uniquement) : 81 requêtes de cargaison (39 achats, 42 ventes) et 183 requêtes de boutique ; `TransactionCostMismatch`
est apparu deux fois (un achat de cargaison, un achat en boutique), 162 et 247 ms après la requête, deux jours différents,
tous deux rattachés à leur requête par le journal (échoué, confirmé). Trop peu de cas pour donner un taux. Non vérifié :
le comportement en session réelle, et ce que fait le jeu du prix affiché après un refus.

**Le vaisseau détruit.** Le même emplacement d'alerte montre un vaisseau détruit avec le joueur à bord, pendant 15 minutes sauf si un prix refusé plus récent prend la place (la propriété du vaisseau n'est pas vérifiée ;
la cause n'est nommée que si le journal la dit) (« Vaisseau détruit à 12:12:00, joueur à bord (…) : collision. » puis « Cargo présumé perdu : 640 SCU, 947 857 aUEC payés (prix d'achat,
pas la valeur) (non confirmé). » ; la session enregistrée le garde définitivement). C'est l'événement le plus grave de la page : sa pastille d'en-tête et son encadré
prennent le ton le plus haut d'une échelle (orange : à regarder, un coup ou un prix refusé ; rouge teinté : danger immédiat, boucliers tombés ou verrouillage hostile ; rouge plein : le vaisseau est perdu),
les pastilles d'événements de plus d'une minute deviennent petites et discrètes tant qu'il est là, l'encadré tient en deux lignes (ce qui s'est passé ; le cargo présumé perdu, les aUEC payés
seulement montants affichés), les doutes sont repliés sous « Pourquoi ce n'est pas certain ? » (un élément details natif, accessible au clavier : propriété du vaisseau non vérifiée,
valeur perdue, suite donnée à l’assurance, coût de remplacement et responsable non journalisés, attribution vérifiée sur des journaux de 2025 seulement, type de responsable déduit de la forme d'un nom, achats et ventes
que le journal n'a pas pu confirmer), et « Et maintenant » ne dit que des faits : le trajet interrompu par la perte ne sera pas terminé (dit seulement quand ce trajet est encore le plus récent du journal ; replié en vue compacte), et une nouvelle
session ou un nouveau trajet peut commencer. Le ton fatal ne mène le verdict d'en-tête que 3 minutes, et jamais devant une condition rouge apparue après la perte ; ensuite le verdict reprend l'ordre normal de gravité (la perte y est alors une entrée orange) pendant que l'encadré garde la perte 15 minutes. Les pastilles réduites gardent leur âge et leur mention « non vérifié ». **Aucune réclamation d'assurance n'est affichée, pas même « aucune vue » :** le parseur lit la ligne d'une demande de réclamation
(`insurance_claim_requested`), mais le tableau de bord ne la reçoit que dans l'explicateur de mouvements du solde (construit, et gardé, seulement montants affichés, et jamais comme fait isolé) : « aucune réclamation vue »
serait faux dès que les montants sont masqués. L'afficher demanderait un nouveau champ dans la section commerce ; ce n'est pas fait. Il est lu dans la
ligne `[ActorState] Dead ... destroyed vehicle` de la build 4.10 (l'acteur doit être le joueur, comparé à une empreinte de
son identifiant tirée de la ligne de connexion) et, comme voie héritée qu'aucun journal 4.10 n'exerce, dans les lignes
`Actor Death` et `Vehicle Destruction` de 2025 (`providers/gamelog/shipLossParse.ts`, `shipLoss.ts`). Une collision n'est
donnée comme cause que si un `FatalCollision ... PlayerPilot: 1` du même vaisseau précède d'au plus 1 s ; sinon la cause est
« non journalisée ». Le cargo est une présomption : les achats réussis rattachés au vaisseau par le kiosque de cargaison
(`VehicleCargoDataRequest`) et non vendus, au prix PAYÉ (achats échoués ignorés, non confirmés comptés à part) ; la valeur
perdue, l'assurance et le responsable ne sont pas dans le journal et s'affichent « non journalisés » ; et la chaîne
achat, vaisseau, destruction n'est vérifiée que sur des journaux de 2025 (aucune session 4.10 n'a un achat suivi d'une
perte). Les enregistrements contiennent une heure, un modèle de vaisseau, un code de cause, un type de
responsable, un lieu : ni nom, ni pseudo, ni GUID, ni identifiant brut. Le modèle n'est gardé que s'il commence par un code
de constructeur connu (AEGS, DRAK, MISC, RSI ...), et le lieu que s'il commence par une famille connue de noms de lieux du
jeu (un corps « OOC_ », un point de saut, un système stellaire ou un corps ...) : ce sont des filtres sur la FORME du texte,
pas une liste de lieux ; tout le reste (« Hangar_ » suivi d'un nom, une entité personnalisée) s'affiche « modèle inconnu » ou « lieu inconnu » (après la famille, 6 segments courts au plus, aucun ne commençant par hangar, apartment, home, habitat ou room) ou
est omis. Une courte empreinte de l'identifiant du vaisseau
relie un achat à son vaisseau, en mémoire seulement : elle n'est jamais écrite, envoyée à une View ni exportée. Les SCU
partent avec ou sans le solde (`trade.ship_losses` : le serveur envoie les 5 plus récents, la View garde les 3 plus récents ; aussi sur le canal entre Views) ; les aUEC payés
viennent du solde et sont retenus quand les montants sont masqués. La session garde `ship_losses` (additif, optionnel, le fichier reste en
version 2) : seulement l'heure, le modèle, la cause, le type de responsable, le lieu et le cargo présumé perdu ; le bilan les liste.

## Sessions enregistrées

Le tableau de bord fonctionne **par session**, et une session est enregistrée. Une session est une période de jeu :
quand elle a commencé, le solde à son début et à sa dernière observation, les trajets faits et ce qu'ils ont rapporté,
le temps pendant lequel le jeu a été vu en marche. Vous la retrouvez depuis n'importe quelle conversation, après un
plantage du jeu et après un redémarrage du PC.

- **Pourquoi un fichier côté serveur et pas le `localStorage` du navigateur.** Le `localStorage` appartient à une origine
  de page : chaque conversation a la sienne, donc deux conversations ne verraient pas la même session ; l'hôte peut le
  vider à tout moment ; et les outils du modèle ne peuvent pas le lire. Un petit fichier JSON écrit par ce serveur est
  partagé par toutes les conversations et tous les processus du serveur, survit à l'hôte, et il est lu de la même façon
  par les outils et par le tableau de bord. La page ne garde aucune donnée de session dans le stockage du navigateur : son seul drapeau est `sc-copilot-help-seen` (la légende a été lue).
- **Où.** `sessions.json` dans le dossier de données de l'utilisateur (Windows : `%LOCALAPPDATA%\sc-copilot-mcp\data`).
  `SCMCP_SESSIONS_FILE` le déplace ; `SCMCP_DATA_DIR` déplace le dossier.
- **Quand il existe.** Seulement avec `SC_TELEMETRY=on`. Télémétrie désactivée, rien n'est créé, lu ni surveillé.
  `SC_SESSIONS=off` (ou `0`, `false`, `no`) désactive les sessions tout en gardant la télémétrie : aucun fichier n'est
  créé ni lu, et les outils de session et la barre disparaissent.
- **Pour l'effacer.** Arrêtez Claude Desktop (ou mettez `SC_SESSIONS=off`), puis supprimez `sessions.json`. Les fichiers à
  côté (`sessions.json.v1.bak`, `sessions.json.corrupt-...`, `.bak-...`) sont des copies d'anciens fichiers ou de fichiers
  illisibles et contiennent les mêmes soldes : supprimez-les tous pour effacer les données, ou lancez `npm run sessions -- wipe` (une simulation qui les liste par
  nom ; `--apply` les supprime, dans ce dossier seulement, et respecte `SCMCP_SESSIONS_FILE`). Le fichier est du JSON simple : vous pouvez le lire.
- **Un changement de comportement assumé.** Le solde de départ ne peut pas être retrouvé dans Game.log : pour le capter,
  le serveur doit surveiller dès le lancement du jeu. Avec les sessions actives, un petit gestionnaire garde le lecteur
  de télémétrie en vie **tant que le jeu est supposé tourner** (Game.log a été écrit dans les cinq dernières minutes et
  n'affiche pas la ligne de fermeture), au lieu de l'arrêter cinq minutes après la dernière requête. Quand le jeu est
  parti, il cesse de solliciter le lecteur, qui s'éteint alors comme avant. Sans le journal du jeu (`SC_INSTALL_DIR` ou
  `SC_GAME_LOG_PATH`), le serveur ne **sonde pas** le port sur une minuterie : il n'enregistre que ce qu'un tableau de
  bord ou un outil demande, et le solde de départ est alors « le premier vu ». Tout reste local et sur option.

### Vie d'une session

- **Elle démarre** quand le jeu est vu en marche et qu'il n'y a pas de session, ou que la dernière est silencieuse
  depuis plus de 3 heures (`SC_SESSION_GAP_HOURS`, de 0,25 à 48) ; quand vous appuyez sur **Nouvelle session** (ou
  appelez `sc_session_new`) ; et quand le tableau de bord s'ouvre après une telle coupure (une session vide attend le
  jeu, et une session vide est renouvelée, jamais empilée). Une session où le jeu n'a jamais été vu (ni trajet, ni solde,
  ni temps de jeu) est **vide** : la carte dit « en attente du jeu », elle n'a rien à terminer et « Nouvelle session » ne
  ferait que la recréer, donc ni l'un ni l'autre n'est proposé (`sc_session_end` répond `reason: "empty"` et
  `sc_session_new` répond `started: false`, sans rien changer).
- **Elle reprend** quand le jeu est revu dans le délai, que le jeu ait été fermé proprement ou non. La coupure est notée :
  `game_closed` si le jeu a écrit sa ligne de fermeture, `unclean` s'il n'y a pas de marqueur de fin (plantage,
  redémarrage du PC, ou serveur arrêté). Rien n'est inventé sur ce qui s'est passé entre-temps.
- **Elle se termine** quand vous la terminez (**Terminer**, ou `sc_session_end` : elle n'est alors pas reprise, et la
  suivante démarre quand le jeu est vu repartir à neuf), quand une nouvelle démarre, ou quand le délai est dépassé
  (close à sa dernière observation). Une session terminée **reste sur la carte**, quel que soit le temps d'attente et le
  nombre d'interrogations du tableau de bord, jusqu'à ce que vous appuyiez sur **Nouvelle session** ou que le jeu montre une
  nouvelle période de jeu (une connexion ou le menu dans Game.log, datés après la fin ; quand Game.log ne dit rien, un solde
  qui apparaît après un silence). Un serveur redémarré qui ne voit son premier solde que tard n'est pas une nouvelle
  période de jeu. Fermer le jeu n'est pas une fin : la session attend et reprend quand le jeu revient dans le délai (la
  carte dit « jeu fermé » entre-temps). Le format du fichier ne change pas (pas de nouvelle valeur pour `end_reason` : un
  ancien serveur le lit toujours). Un ancien serveur (2.7.0) qui écrit le même `sessions.json` ramène de son côté les anciens
  comportements (une session vide supprimée puis recréée par l'interrogation, une session terminée remplacée après le
  délai) ; le format reste compatible. Limite connue : `sc_session_end` et `sc_session_new` agissent sur la DERNIÈRE session
  du serveur et ne prennent pas d'identifiant attendu, donc une confirmation devenue périmée (un autre tableau de bord ou
  le jeu a démarré une session plus récente dans la courte fenêtre entre la question et le clic) pourrait terminer la
  session plus récente ; le message affiché sur la carte nomme la session réellement terminée.
- Le temps est compté d'après ce qui a été vu : le **temps actif** est le temps où le jeu a été vu en marche ; une
  coupure n'ajoute rien.

### Ce qui est enregistré, ce qu'un plantage fait perdre

Enregistré, par session : identifiant et numéro, heures de début et de fin, le solde au début (avec sa fiabilité :
`game_start` quand le serveur a vu le flux commencer, `first_seen` quand il a commencé à surveiller plus tard,
`new_session`, `late`) et à la dernière observation, la version et le canal du jeu, le temps actif, les coupures, la
note que vous avez écrite, et les trajets (heure de fin, un libellé, des marchandises et des lieux nettoyés et bornés,
SCU, coût, revenu, marge brute ou résultat mesuré, profit prévu). **Jamais enregistré :** les trames, les lignes brutes
du journal, votre pseudo, votre identifiant de compte, les adresses IP, les GUID de joueurs ou de sessions du jeu, les
identifiants de mission (la clé d'un trajet est un hachage). Ce serveur n'envoie jamais de donnée de session sur un
réseau, et le suivi des sessions ne fait aucune requête vers aucun hôte (ce que vous laissez Claude lire par les outils `sc_session_*` fait partie de votre conversation).

Chaque changement est écrit aussitôt (un trajet, un solde de départ, une nouvelle session, une coupure) ; la seule chose
limitée est l'horloge « vu pour la dernière fois », écrite au plus toutes les 15 secondes. Un plantage ou une coupure de
courant fait donc perdre **au plus les 15 dernières secondes d'horloge**, jamais un trajet déjà écrit. L'écriture passe
par un fichier temporaire, forcé sur le disque, puis renommé sur le fichier sous un verrou : le fichier est toujours
l'ancienne version ou la nouvelle. Deux processus du serveur (Claude Desktop peut en lancer deux) lisent le fichier le plus
récent sous le verrou et y ajoutent : aucun trajet n'est perdu et le temps n'est pas compté deux fois. Un fichier vide,
qui n'est pas du JSON, trop gros ou d'une autre forme est **mis de côté** (renommé `sessions.json.corrupt-<time>` ; seules les trois
copies les plus récentes sont gardées, les plus anciennes sont supprimées) et le serveur repart propre ; un fichier d'une **version plus récente** n'est jamais écrit (les
sessions vivent alors en mémoire seulement et la réponse le dit). La taille est bornée EN OCTETS : le fichier est gardé sous
environ 3 Mo (le lecteur en accepte jusqu'à 16, donc un fichier écrit par le serveur est toujours relu) ; quand une écriture
le dépasserait, les **sessions les plus anciennes sont abandonnées** et comptées (`history_trimmed` dans
`sc_session_stats`), la plus récente jamais ; il y a aussi au plus 200 sessions et 500 trajets par session. Le fichier est
créé pour le propriétaire seul (mode 0600 ; sous Windows, l'ACL de votre dossier de profil s'applique, c'est elle qui le
protège). Si le disque refuse une écriture (disque plein, par exemple), le contenu reste en mémoire et remplace l'ancien
fichier tant qu'aucune écriture ne réussit ; `sc_session_new` et `sc_session_end` le disent alors (`persistence`). Le
verrou est rafraîchi tant qu'il est tenu, retiré seulement par son propriétaire, et un verrou laissé par un plantage est
repris après 5 secondes (un changement attend jusqu'à 8 s) ; les fichiers temporaires orphelins de plus d'une minute sont
balayés. Avant « Nouvelle session », « Terminer » et un arrêt propre, le serveur relit le journal du jeu aussitôt pour
garder le dernier trajet (un trajet dont le résultat se règle encore est gardé avec un résultat inconnu). Un verrou mort est repris par un
seul processus à la fois (par un fichier de reprise, sans vérification sur un chemin avant d'agir dessus) : plusieurs vrais
processus démarrant ensemble sur un verrou mort ne perdent rien. Une cargaison de la carte de commerce qui grandit après
son enregistrement (une vente tardive) remplace son trajet, elle n'est jamais enregistrée deux fois.

### Trajets, résultats et statistiques

Un trajet est un **contrat terminé** du carnet de transport (son résultat est la variation du solde mesurée autour de
lui, et reste inconnu si deux contrats se chevauchaient ou si le solde n'a pas été vu) ou une **cargaison
terminée** de la carte de commerce (son modèle, `src/dashboard/tradeRun.ts`, est l'unique appariement des achats et des
ventes du journal ; le trajet garde son coût, son chiffre d'affaires, sa **marge brute**, ses frais et son **net**, tels
que ce modèle les a mesurés ou calculés, et le profit prévu quand le plan a été rattaché à la cargaison, par le nom de la marchandise ou par les prix : voir Fiabilité des routes). La
variation du solde d'un contrat qui chevauche une cargaison est écartée des totaux (elle contient déjà les ventes de la
cargaison), et la session montre le net mesuré et la marge brute séparément. Un trajet n'est enregistré qu'une fois son résultat réglé et n'est jamais recalculé ensuite.

Les chiffres par session : trajets, temps actif, trajets par heure, minutes par trajet (estimation), résultat (sur UNE
base : la somme du résultat de chaque trajet, qui est son net quand le modèle de commerce en a mesuré ou calculé un et sinon
la marge brute de sa cargaison, sinon la variation du solde, et cela dit lequel ; le net mesuré et la marge brute sont
montrés à part, et la variation du solde d'un contrat qui chevauchait une cargaison est écartée pour que les ventes de la
cargaison soient comptées une fois), résultat par heure (à partir de 10
minutes de temps actif), meilleur trajet, et efficacité face au plan quand Claude en a passé un avec le tableau de bord.
Entre sessions : totaux, moyenne par heure, tendance (les dernières sessions face aux précédentes, seuil de 10 %),
meilleure et moins bonne session, meilleurs trajets et marchandises quand ils sont connus. Un chiffre qu'on ne peut pas
établir vaut `null`, jamais zéro. Ce sont tous des mesures brutes : le solde bouge aussi avec les achats, les amendes
et les réparations. Chaque session compte aussi les transactions que le jeu a refusées parce que le prix avait bougé (`price_refusals`, un nombre : ce n'est pas un montant en aUEC, il est donc donné même quand les montants sont masqués ; voir [la vérification avant le départ](#avant-de-partir--la-vérification-du-plan-et-le-prix-qui-a-bougé)).

### Fiabilité des routes (calibration)

Les prix d'UEX sont des estimations de la communauté, et pour la plupart des routes personne ne les a relevés
récemment : le profit du planificateur est donc une conjecture. Vos propres trajets enregistrés sont une preuve. Pour
chaque cargaison terminée qui porte un profit prévu, le serveur compare ce que le plan promettait et ce que vous avez
vraiment obtenu (`src/providers/sessions/calibration.ts`, un module pur).

- **Ce qui est comparé.** La marge brute réalisée sur le profit prévu (une marge avant frais, donc comparable) ; le net sur
  le profit prévu, seulement pour une cargaison dont le net est bien le sien (le net et les frais sont connus, le modèle de
  commerce n'a pas signalé le net comme douteux, et ce que la marge et les frais laissent inexpliqué de la variation du solde
  vaut au plus 2 % du chiffre d'affaires : un achat fait ailleurs ou une récompense est écarté et compté dans
  `net_excluded`, et un ancien trajet sans cette information est écarté aussi) ; et les frais sur le chiffre d'affaires. Le
  plan est d'abord ramené à la quantité réellement transportée quand la quantité du plan est connue et diffère de plus de
  2 % (une soute à moitié pleine n'est pas un mauvais prix) ; une cargaison qui a transporté moins d'un quart ou plus de
  quatre fois la quantité prévue est écartée. Un plan inférieur à 1 000 aUEC, ou aux frais de la cargaison, est ignoré (un
  ratio sur quelques aUEC n'est que du bruit), et un ratio qui n'est pas au-dessus de zéro ou qui dépasse 500 % est affiché « écart très élevé », jamais
  comme un pourcentage. Le ratio typique est groupé (somme du réalisé sur somme du prévu), avec à côté la médiane, le
  minimum et le maximum des ratios par cargaison. Ce n'est pas l'efficacité des sessions (`money.plan.efficiency`) : celle-ci
  est le résultat mesuré (net, sinon marge brute) sur le plan tel que prévu, alors que la calibration compare la marge
  brute au plan remis à l'échelle de la quantité transportée, donc les deux peuvent différer volontairement.
- **Groupes et cargaisons retenues.** Par marchandise (nom exact une fois les accents repliés et mis en minuscules, jamais
  un préfixe, jamais le chiffre d'une autre marchandise) et, quand la cargaison porte les deux terminaux du plan, par
  route. Un groupe de marchandise réunit toutes ses routes ; le groupe de la route est préféré quand il a 2 cargaisons ou
  plus. Ne comptent que les cargaisons des 60 derniers jours, de la ligne de patch actuelle (les deux premiers nombres de la
  version du jeu, par exemple 4.10 : une cargaison d'une autre ligne de patch est écartée, une cargaison de version
  inconnue est gardée et comptée, et si la version actuelle est inconnue rien n'est écarté pour son patch), et seulement
  les 8 dernières d'un groupe. Ce qui a été écarté, et pourquoi, est compté dans la réponse de l'outil. La ligne de la carte
  ne parle que du premier tronçon d'une route, et le dit sur une carte à deux tronçons.
- **Comment un plan est rattaché à une cargaison.** Un plan appliqué marque une cargaison : la première qui se termine après
  lui, ou, quand plusieurs conviennent dans le même relevé, la plus proche du plan. Le journal nomme les marchandises par
  un identifiant, pas par un nom : en pratique chaque plan est donc rattaché à sa cargaison par les prix (`plan_link`) : prix
  moyens d'achat et de vente de la cargaison chacun à moins de 15 % de ceux du plan, une quantité achetée à moins d'un
  facteur 2,5 de celle du plan (les deux doivent être connues), et une marge unitaire réalisée positive et comprise entre la
  moitié et le double de celle du plan. Une cargaison qui échoue à un test n'est pas rattachée, et le plan reste libre pour
  la bonne cargaison. Ces seuils sont des choix, pas des mesures. C'est une ressemblance, pas une preuve : le groupe porte
  `goods_unverified`, la ligne dit « similaires (marchandise non vérifiée) » au lieu de « de cette marchandise », l'explication
  « lien par prix » est dans le repli « Comment lire ça », et la confiance n'est jamais `high`, avec la raison dans le titre de l'étiquette. Les
  chiffres de session comptent aussi ces trajets (`price_linked_trips` dans `money.plan`, dans les meilleures marchandises et
  routes), et leur libellé se termine par « (lien par prix) ». Pour avoir deux cargaisons d'une route, appliquez son plan
  deux fois. **Biais de sélection :** comme une cargaison doit avoir une marge unitaire entre la moitié et le double de celle
  du plan pour être rattachée, une cargaison qui rend 30 % du plan n'est jamais rattachée ni comptée : les ratios des cargaisons
  rattachées par les prix (tous les plans réels aujourd'hui) sont censurés à environ 50 % à 200 % (un lien par le nom n'aurait pas cette borne), donc la calibration ne peut pas montrer qu'une route rend vraiment 20 % du plan (de
  telles cargaisons sont simplement absentes). Quand la confiance est tenue à `medium` pour cette raison, la carte le dit
  dans le repli « Comment lire ça » sous la ligne (du texte écrit, à un clic), pas seulement dans l'infobulle.
- **Confiance** (`none`, `low`, `medium`, `high`). `none` sous 2 cargaisons : aucun chiffre, seulement le nombre. `low` avec
  2 ou 3 cargaisons, un écart supérieur à 0,6 (maximum moins minimum des ratios par cargaison, en points du plan) ou une
  dernière cargaison de plus de 21 jours. `medium` avec 4 à 7 cargaisons. `high` seulement avec 8 cargaisons, un écart d'au
  plus 0,3, des cargaisons récentes et des marchandises rattachées par le nom. Elle dit combien s'appuyer sur le chiffre ;
  ce n'est pas une probabilité.
- **L'attente.** « Net attendu ≈ profit prévu × ratio typique (n trajets) » : le profit prévu fois le ratio net typique
  quand au moins 2 cargaisons ont leur propre net, sinon fois le ratio brut typique moins le taux de frais habituel sur le
  chiffre d'affaires du plan. Une ESTIMATION, toujours avec son nombre de cargaisons et sa confiance ; elle n'affirme
  aucune cause (un ratio sous 100 % peut venir des prix, de la quantité ou d'une vente lente).
- **Où cela s'affiche.** `sc_session_stats` (section `route_reliability`, pas avec `include_balance` à false) ; une ligne
  sous chaque route suggérée de la barre d'actions : trois valeurs côte à côte, seulement quand il y a des données et que le
  solde est affiché. ESTIMÉ (étiquette « ESTIMATION ») : le gain du planificateur par trajet et par heure, d'après les prix
  UEX. MESURÉ : la moyenne de tes propres trajets de cette route ou de cette marchandise (la marge brute réalisée moyenne, ou
  le net moyen quand le ratio utilisé est le net) avec leur nombre et la moyenne à laquelle ils étaient prévus. RÉALISÉ ÷
  PRÉVU : le même ratio que la tuile ci-dessous (le ratio net, sinon le ratio brut moins les frais habituels), avec une petite
  barre sur une échelle de 0 à 200 %, l'étiquette « estimé · N trajets · confiance ... » (son infobulle explique la
  confiance) et ce qu'il donne : « Si tu refais ce trajet ≈ X aUEC (prévu Y × Z %) ». **Règles.** Sous 3 trajets derrière le
  chiffre utilisé, la carte donne leur nombre et rien d'autre (ni ratio, ni chiffre appliqué, ni étiquette ; la tuile « Si tu refais ce trajet » suit la même règle : aucun coefficient sous 3 trajets ; les
  outils gardent leur minimum de 2 trajets). Le ratio s'applique au profit du PREMIER tronçon seulement, ce que « Appliquer
  comme plan » enregistre et donc ce à quoi les trajets ont été comparés : une carte à deux tronçons dit « Si tu refais le 1er
  tronçon » et ne donne aucun chiffre d'aller-retour ; un chiffre par heure n'est appliqué qu'à une carte d'un seul tronçon,
  comme le trajet appliqué sur le cycle estimé. Sur la base brute, la phrase écrit la vraie décomposition (« prévu × ratio,
  moins les frais habituels ≈ F »). La cellule « mesuré » compte les trajets sur lesquels porte sa moyenne (tous sur la base
  brute, ceux du net sur la base nette) ; sur une carte à deux tronçons, elle et le ratio disent « 1er tronçon » à côté du
  total. Un ratio qui n'est pas au-dessus de zéro ou qui dépasse 500 % est écrit « écart très élevé », pas affiché, et rien
  ne lui est appliqué ; quand rien n'est appliqué, la phrase donne la seule vraie raison (trop peu de trajets avec frais
  connus, un net trop éloigné du plan, pas de chiffre d'affaires prévu). La moyenne réalisée sur la moyenne prévue donne le ratio ; ce n'est PAS le mesuré divisé par
  l'estimation d'aujourd'hui (le repli le dit). Le repli « Comment lire ça » dit aussi que les cargaisons rattachées par les prix sont censurées à
  environ 50 % à 200 % et qu'un lien par le nom n'a pas cette borne (voir le biais de sélection ci-dessus). Le bloc n'existe que tant que le solde est affiché et il est vidé, pas
  seulement caché, quand on le masque de nouveau. La tuile « Si tu refais ce
  trajet » de la carte de commerce, qui préfère le chiffre calibré quand le plan en cours a un groupe de 3 cargaisons ou
  plus ; une phrase dans les instructions du serveur et dans le prompt `trade_copilot` pour que Claude la cite avec son
  nombre de cargaisons.
- **Confidentialité.** Un ratio fois le plan révèle le résultat réalisé : la section n'existe que là où le solde est
  affiché. Elle est absente de l'outil avec `include_balance` à false (ou sous `SC_BALANCE=hidden`), de l'interrogation du tableau de bord (donc de son empreinte) d'une vue qui a masqué le solde, du canal entre vues, de `ui/update-model-context` et du message de
  « Demander à l'agent ». La vue l'ignore tant que le solde est masqué, même si un serveur l'avait envoyée.
- **Enregistré (version 2 du fichier).** Pour un trajet de commerce : la quantité du plan, les deux terminaux du plan (noms
  UEX : ceux du plan, pas des lieux observés), `plan_link`, comment les frais ont été obtenus (`fees_method`), et ce que le
  solde contient en plus de la cargaison (`unexplained_auec`, `net_doubtful` : tous viennent du solde et sont retenus comme
  l'argent, et un trajet dont le net est `net_doubtful` n'est pas comparé à son plan dans l'efficacité de la session). Un
  serveur redémarré ne remplace jamais un trajet de commerce enregistré par une version qui a perdu un chiffre que
  l'enregistré avait mesuré ; quand le trajet a aussi grandi (une vente tardive), le net et les frais mesurés sont gardés,
  `figures_from_before` vaut vrai et le net est `net_doubtful` (il ne couvre plus tout le trajet). Jamais de trames, de lignes brutes, de pseudo ni d'identifiants. Un fichier de version 1 est lu tel quel (les nouveaux
  champs sont inconnus : ces trajets comptent par marchandise, sans mise à l'échelle et sans net) ; le numéro de format a
  bougé pour qu'un ancien build laisse un fichier de version 2 tranquille : il l'ouvre en lecture seule, en mémoire, avec un
  avis, et les données ne sont pas perdues. Avant la première écriture dans le nouveau format, le serveur copie une fois le
  fichier de version 1 vers `sessions.json.v1.bak` et n'écrase ni ne supprime jamais cette copie.
- **Non vérifié.** Rien n'a été observé avec le vrai jeu. Les seuils (60 jours, 8 cargaisons, 21 jours, 15 %, 2,5, la bande
  de marge, 1 000 aUEC, les bornes de confiance) sont notre choix, pas une mesure.

### Dans le tableau de bord et dans les outils

- **La barre** en haut du tableau de bord montre la session (numéro, état, depuis quand, temps actif), puis les chiffres
  qui comptent d'abord : solde affiché, le résultat, le rythme par heure, les trajets et le temps ; solde masqué, les
  trajets et le temps. Dans la vue compacte elle tient sur une ligne (un bouton la déplie) qui dit aussi l'état
  (« en attente du jeu », « terminée à 16:10 »). La carte a cinq états : **aucune session** (« Démarrer une session »),
  **en attente du jeu** (une session vide : aucun chiffre, aucun tiret, aucun bouton, et une ligne dit pourquoi), **en cours**
  (ou « inactive » après un long silence), **terminée** (« terminée à 16:10 », comment, son résultat, et « Nouvelle
  session » comme bouton principal) et, dans le menu **Sessions**, la liste des sessions passées avec l'état de chacune (en
  cours, en attente du jeu, terminée : à la main, remplacée par une nouvelle session, ou par une longue inactivité) et une
  session en détail. **Terminer la session** et **Nouvelle session** sont sur la carte, et seulement quand elles changent
  quelque chose. Une session qui contient quelque chose pose une question, **en ligne à côté du bouton**, avec un bouton
  Annuler et sans minuterie (une question devenue fausse, parce qu'un autre tableau de bord ou le jeu a changé la session,
  est retirée et le dit) ; une action qui ne ferme rien se fait tout de suite. Le résultat s'écrit sous la carte (une
  région vivante, donc annoncée par un lecteur d'écran) et y reste jusqu'à ce qu'une session plus récente soit sur la
  carte ; il ne contient jamais de montant. Deux tableaux de bord de deux conversations montrent la même session, car elle
  vient du serveur.
- **À l'ouverture**, le tableau de bord se rattache à la dernière session, sauf si elle est ouverte et qu'il y a eu une
  coupure de plus que le délai : une nouvelle (vide) est alors créée. Une session que vous avez terminée n'est jamais
  remplacée dans votre dos.
- **Outils** (profil `local` ; les trois premiers aussi dans `trade`) : `sc_session_current` (la session jusqu'ici, le
  dernier lieu et les dernières marchandises nommés par le journal, les derniers trajets : ce qu'il faut à Claude pour
  vous accompagner et proposer la prochaine route), `sc_session_list`, `sc_session_stats`, `sc_session_new`,
  `sc_session_end`, `sc_session_debrief` (le bilan, voir plus bas) et `sc_session_export` (l'appel propre au tableau de bord pour le bilan entier ; pas pour le modèle). `sc_session_new` et `sc_session_end` n'écrivent que le
  fichier du serveur. Le prompt `trade_copilot` enchaîne les autres avec les outils de routes UEX.
- **Le bilan de session.** Pour SORTIR une session du serveur (la partager avec un équipage ou une org, garder un journal,
  coller les trajets dans un tableur) : dans le menu des sessions, ouvrez une session et appuyez sur **Copier le bilan** (le texte
  va dans le presse-papiers ; si l'hôte refuse le presse-papiers, il s'affiche sélectionné, faites Ctrl+C) ou, quand la page
  sait faire un fichier, **Télécharger .md**, **Télécharger .csv** ou **Télécharger .csv (Excel FR)** (l'hôte peut bloquer un
  téléchargement : la copie marche toujours). Le tableau de bord reçoit la session ENTIÈRE par son propre outil
  `sc_session_export` (réservé à l'application, non listé au modèle). Claude peut produire un bilan avec `sc_session_debrief`,
  volontairement petit car un résultat d'outil fait partie de la conversation : Markdown par défaut (environ 28 000 caractères
  au plus, 20 lignes de tableau par session, les trajets plus anciens coupés avec leur nombre et un renvoi au tableau de bord),
  un CSV seulement sur demande (`format` csv, 100 lignes au plus), jamais les deux ; `id` pour une session passée ou `last`
  pour les N dernières, jusqu'à 10. `last` saute les sessions vides, comme les statistiques, et une session qui ne contient
  qu'un solde de départ compte comme non vide : solde masqué, le choix des sessions retenues par `last` peut donc dépendre de
  données de solde (seulement le choix des sessions ; aucun montant n'est montré).
  Le Markdown (en français, heures en UTC, sans horloge ni réglage régional : la même session donne le même texte) contient :
  l'en-tête (début, fin, durée, temps de jeu, version et canal du jeu, les coupures et leur cause : jeu fermé normalement ou
  sans marqueur de fin), les chiffres clés (trajets, par heure, marge brute, frais, meilleur trajet, efficacité face au plan,
  fiabilité des routes avec son nombre de trajets, sa confiance et la mise en garde « marchandise non vérifiée (lien par
  prix) »), le tableau des trajets (heure, libellé et route, SCU, coût, revenu, marge brute, frais, net, chacun étiqueté
  *mesuré*, *calculé*, *estimé* ou *inconnu*), ce qui n'est pas expliqué, et un pied de page qui dit ce qui est mesuré et ce
  qui est estimé, et que les prix UEX sont collaboratifs. Le CSV ne contient que les trajets, avec des noms de colonnes en
  anglais (`session,ended_at,kind,label,commodity,buy_terminal,sell_terminal,scu`, puis, avec les montants,
  `cost_auec,revenue_auec,gross_margin_auec,fees_auec,fees_method,net_auec,net_method,counted,planned_profit_auec,plan_link`),
  des fins de ligne CRLF et une cellule vide pour ce qui est inconnu (jamais 0). `counted` vaut `yes` seulement pour un trajet qui
  a un résultat (le Markdown dit *inconnu* pour les autres). **Séparateur.** Virgule par défaut ; **Excel en français attend le
  point-virgule** : utilisez **Télécharger .csv (Excel FR)** (ou `csv_delimiter` ";") : le fichier s'ouvre en colonnes, avec une
  virgule décimale. **Formules.** Une cellule de texte qui commence par `=`, `+`, `-` ou `@` est précédée d'une apostrophe, et chaque `;`,
  `,`, tabulation ou `|` qui en précède un à l'intérieur reçoit une apostrophe juste après (un lecteur qui coupe la cellule
  là ne trouve aucune formule), et une cellule qui contient une virgule, un
  point-virgule, un guillemet ou un saut de ligne est entre guillemets. Cela arrête l'injection de formule usuelle dans Excel et
  LibreOffice ; c'est une atténuation, pas une promesse pour tous les programmes qui ouvrent un CSV : relisez un fichier reçu
  d'un autre avant de l'ouvrir, comme n'importe quel tableur.
  **Confidentialité.** Tout chiffre en aUEC vient du solde : le bilan n'en contient que si le solde est affiché (choix du
  tableau de bord) sauf si `include_balance` est à false (ou si le serveur démarre masqué et que l'appel ne dit pas true). Sinon c'est le bilan sans montants (comptes, durées, SCU, libellés), qui
  dit que les montants sont retenus ; le meilleur trajet, l'efficacité face au plan, la fiabilité des routes et les méthodes des
  trajets sont retenus avec eux. Le solde de départ et celui du dernier relevé n'apparaissent jamais, même avec les montants,
  sauf si vous activez aussi **Soldes de départ et final** (`include_start_balance` ; à chaque usage, jamais retenu, ignoré quand les montants sont masqués) ; ce qui peut apparaître, montants affichés, c'est leur écart (la variation du solde sur la session,
  dans la section « pas expliqué »). Le serveur n'enregistre aucun pseudo, identifiant de compte, adresse, GUID, ligne brute du
  journal ni chemin, mais les libellés des trajets et votre note sont vos mots et ceux du jeu : ils sont nettoyés à nouveau,
  bornés et échappés (ni HTML, ni lien, ni tableau cassé), **mais pas contrôlés sur ce qu'ils disent** : relisez le bilan avant
  de le partager (le tableau de bord le dit dans tous les états). Une longue session reste bornée : le tableau du fichier garde
  jusqu'à 500 trajets, le CSV jusqu'à 500 lignes. Le texte est construit à la demande, gardé dans la page le temps de le
  regarder, et retiré de la page (son texte, pas seulement masqué) quand vous masquez le solde, quittez la session, fermez le
  menu ou que la page disparaît ; il n'est jamais enregistré ni envoyé ailleurs par le serveur.
- **Confidentialité du solde.** Tout chiffre en aUEC (soldes, résultats, chiffre d'affaires, marge brute, rythmes) est donné au modèle par défaut et dessiné dans le tableau de bord. Il est retenu au modèle, et au tableau de bord, à son interrogation et aux appels de session qu'il fait, tant que le choix du joueur est « masqué » (« Masquer le solde » ou `SC_BALANCE=hidden`, voir la confidentialité du tableau de bord), quoi que dise `include_balance` ; `include_balance: false` masque un appel. Il ne circule jamais entre tableaux de bord. Les comptes, les durées et les noms de lieux ne sont jamais retenus.
- **Non vérifié dans le vrai jeu :** toute la fonction a été construite contre de faux jeux et des journaux inventés. La
  fiabilité du solde de départ, la détection du jeu en marche d'après la date du journal et la reprise après un vrai
  plantage n'ont pas été observées.

## Confidentialité

- Le flux est **non chiffré et lisible par n'importe quel programme de votre PC** tant qu'il est actif. Il est lié à
  la boucle locale, il n'est donc pas joignable depuis le réseau.
- Il contient votre santé, votre vaisseau et votre **solde aUEC**. Il ne contient pas votre position.
- Ce serveur ne journalise jamais les trames, ne les écrit jamais sur disque et ne les envoie jamais sur un réseau.
  Ses diagnostics ne contiennent que des numéros de champs. Les trames et les lignes brutes du journal restent en mémoire et ne sont jamais écrites. La seule exception est le résumé de session : le solde au départ et à la dernière observation ; la version du jeu, les heures (dont la durée pendant laquelle le jeu a été vu en marche) et les coupures ; le dernier lieu et les dernières marchandises nommés par le journal ; votre note ; le nombre de prix refusés ; pertes de vaisseau : heure, modèle, cause, lieu, cargo présumé (SCU et aUEC payés) ; et, pour chaque trajet, son libellé (titre du contrat, lieux, marchandises), la quantité, le coût, le revenu, la marge, les frais, le net et le plan appliqué (profit prévu, quantité, terminaux). Il est gardé dans un fichier local, `sessions.json`, seulement quand la télémétrie est activée ; ce serveur ne l'envoie jamais nulle part, sauf que les outils `sc_session_*` en renvoient des parties à votre client MCP, donc à votre conversation (chiffres d'argent compris, sauf si vous les masquez : « Masquer le solde » dans le tableau de bord ou `SC_BALANCE=hidden` les cache aux outils jusqu'à votre clic sur « Afficher le solde », et `include_balance` à false les cache pour un appel) ; `SC_SESSIONS=off` le désactive ; et supprimer `sessions.json` ainsi que les copies `.bak` et `.corrupt` à côté de lui l'efface. Les résumés incluent des soldes, par votre décision explicite, et ce serveur ne fait aucune requête réseau pour eux (voir [Sessions enregistrées](#sessions-enregistrées)).
- **Les résultats des outils font partie de votre conversation avec Claude**, qui est envoyée à Anthropic. Le solde est donné par défaut, pour que Claude puisse aider sur vos trajets ; masquez-le avec « Masquer le solde » du tableau de bord (collant, gardé dans la mémoire de ce processus du serveur jusqu'à son redémarrage, et qui ne protège que les outils de ce processus) ou `SC_BALANCE=hidden` (permanent, tous les clients) si vous préférez ne pas le partager. Ce que Claude lit, montants compris, est ce qui quitte votre machine ; le serveur lui-même n'envoie rien sur un réseau.

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
| `waiting` | Pas de télémétrie pour l'instant. Ne prouve pas que le jeu est éteint : ce serveur ne peut pas le savoir | Rien à corriger si vous êtes dans les menus ou un chargement. Si vous êtes en jeu, personnage apparu, et que cela reste `waiting`, voir la ligne suivante |
| `waiting` (personnage apparu depuis un moment) ou `game_without_telemetry` | Le jeu a été démarré sans la variable | Quittez complètement le RSI Launcher, icône de la zone de notification comprise, relancez-le, lancez le jeu. Cherchez la ligne « registered » dans `Game.log` |
| `connected` mais aucune donnée | Menus ou chargement | Faites apparaître votre personnage. Les données commencent une fois le personnage créé |
| `live` mais aucune donnée de vaisseau | Vous êtes à pied ou dans un véhicule terrestre. C'est normal | Asseyez-vous dans un vaisseau. Les données du vaisseau arrivent 6 à 9 secondes plus tard |
| `incompatible` | Un patch a changé le schéma | Mettez le serveur à jour ; signalez-le avec la version du jeu |
| Port 2942 utilisé par autre chose | Un autre client de télémétrie n'est pas le problème (plusieurs sont permis) ; un autre programme, si | `npm run telemetry -- status` et vos outils habituels pour les ports |

Le bandeau de santé du tableau de bord (voir [Tableau de bord en direct](#tableau-de-bord-en-direct)) liste ce qui
manque avec son remède :

| Ce que dit le bandeau | Que faire |
| --- | --- |
| « Télémétrie du jeu : Désactivée côté serveur » | `npm run telemetry -- enable`, puis ajoutez `--apply` et redémarrez Claude Desktop |
| « Journal du jeu (Game.log) : Non configuré » | Ajoutez `SC_INSTALL_DIR` (le dossier qui contient `Game.log`) au bloc `env` de l'entrée `sc-copilot`, redémarrez Claude Desktop. Sans lui : pas d'état de connexion, pas de journal de commerce, pas de grand livre |
| « Journal du jeu : illisible » | `Game.log` n'existe qu'après un premier lancement du jeu ; sinon corrigez le dossier. `npm run doctor` pour le contrôle complet |
| « Télémétrie du jeu : Le jeu a été lancé sans la télémétrie » | Quittez complètement le RSI Launcher (icône de la zone de notification comprise), relancez-le, lancez le jeu. `npm run telemetry -- status` montre les deux interrupteurs |
| « Sessions enregistrées : À régler » | Lecture seule : mettez le serveur à jour. Écriture échouée : libérez de l'espace disque ou corrigez les droits du dossier de données (ou `SCMCP_SESSIONS_FILE`) |

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
