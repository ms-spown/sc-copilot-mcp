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
| `ActorState.uec_balance` | `poll.balance.uec` | Solde (masqué par défaut) (`balance`) |
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
| `sc_trade_suggest` | idem | Utilisé seulement par les boutons de commerce du tableau de bord ([barre d'actions](#actions-de-commerce--trouver-la-prochaine-route)) : le planificateur de commerce derrière un limiteur de débit. Claude a pour consigne de ne pas l'appeler ; il utilise `uex_plan_trade` |

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
requête, et garde tout en mémoire uniquement. Les événements n'existent que pendant le temps où le serveur tournait
tandis que le jeu envoyait des trames, et ils sont déduits, non rapportés par le jeu.

## Tableau de bord en direct

Une vue en direct optionnelle du même flux, dessinée dans la conversation. Compacte : le vaisseau, où il se trouve,
trois cadrans (vitesse, hydrogène, santé), les alertes et un verdict en une ligne (« Tout va bien » ou « À surveiller
»). En plein écran : un cockpit, avec les instruments à gauche, le vaisseau au centre et le pilote à droite. C'est
une MCP App : une petite page que ce serveur fournit et que le client affiche à côté du chat.

- **Qui l'affiche.** Claude Desktop est l'hôte que nous avons testé (version Microsoft Store 4.4212.0, serveur
  déclaré dans `claude_desktop_config.json`). **Claude Code et les autres clients en mode texte ne l'affichent pas** :
  pour eux, les trois outils du tableau de bord ne sont pas listés du tout, donc le modèle ne les voit jamais. Le
  serveur ne les liste que lorsque `SC_TELEMETRY=on` ET que le client a déclaré l'extension MCP Apps au démarrage.
  D'autres hôtes qui affichent les MCP Apps peuvent fonctionner ; nous ne les avons pas essayés. La mise en page a été
  itérée dans un vrai navigateur face à un hôte factice (360 à 2000 px, clair et sombre) ; **nous ne l'avons pas vue
  dans Claude Desktop**.
- **Comment l'ouvrir.** Activez la télémétrie (voir plus haut), redémarrez complètement Claude Desktop (quittez-le
  depuis la zone de notification, pas seulement la fenêtre), puis demandez à Claude d'ouvrir le tableau de bord en
  direct. Claude appelle `sc_live_dashboard`, dont le résultat lui dit de ne pas en ouvrir un second tant qu'un est
  ouvert (`hint`). Tant qu'il est ouvert, vous pouvez continuer à parler à Claude : il répond à partir de
  `sc_live_state`, pas à partir de la page.
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
  apparaît alors dans une barre sous l'en-tête, dans les deux modes.
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
- **Confidentialité du solde.** Le solde est masqué dans la page tant que vous ne cliquez pas sur « Afficher le
  solde ». C'est seulement alors que la page le demande au serveur (`include_balance`). Le solde n'est jamais mis
  dans le résumé automatique que la page peut envoyer au modèle, ni dans les messages fixes des boutons, ni sur le
  canal entre tableaux de bord (voir plus bas), avec une exception : le bouton « Route avec mon solde et ce vaisseau »
  l'envoie dans un message, le dit dans le texte, et seulement quand vous l'appuyez.
- **Ce que font les boutons.** « Analyser ma situation », « Route avec mon solde et ce vaisseau » et « Bilan de
  session » publient un court message fixe dans la conversation, comme si vous l'aviez tapé, demandant à Claude
  d'utiliser `sc_live_state` et `sc_live_events` ; une confirmation apparaît à côté des boutons et s'efface seule.
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
quantique complet compris, face à un hôte factice ; ni jeu ni Claude n'interviennent. Paramètres : `t`, `theme`,
`w`, `mode`, `scroll`, `forced`, `cut`, `plan`, `trade` (la carte Commerce avec un journal de commerce inventé : `story`, `estimated`, `unknown`, `partial`, `second`, `none`), `fw` (largeur du cadre en plein écran), `suggest` (ce que répond l'outil de la barre d'actions de commerce, avec des routes inventées et sans UEX : `ok`, `wait`, `error`, `empty`, `nospeed`, `reported`, `slow`), `click` (le libellé d'un bouton à presser) et `refine=1` (ouvre « Affiner »).

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
  par le serveur et dessiné par la page seulement après votre clic sur « Afficher le solde ». Sans lui, le carnet ne
  montre que les étapes et les durées, et la réponse du serveur ne contient aucun de ces chiffres. Rien n'entre dans le
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

- **D'où viennent les transactions.** Du journal de commerce du journal de jeu (`src/providers/gamelog/trade.ts`, celui
  de `sc_trade_journal`) : le tableau de bord n'analyse rien lui-même. Les lectures du carnet (complète, puis seulement
  les octets ajoutés par le jeu) gardent aussi les lignes de commerce, le journal les apparie, et le modèle de commerce
  en prend les transactions : seules les terminées comptent, exactement comme le journal ; les lignes échouées et non
  confirmées (les ambiguës comprises) sont laissées de côté et signalées par une note sur la carte ; un montant dans une
  autre monnaie que l'aUEC n'est jamais ajouté. Le journal nomme les marchandises par un identifiant seulement (les 8
  premiers caractères du GUID du jeu) ; les noms que `sc_trade_journal` trouve dans la liste du wiki ne sont pas
  cherchés ici, donc la carte affiche « marchandise 5c2e9a41 » sauf si le plan nomme la marchandise, et un plan ne peut
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
  frais, net, rythme, projection) est construit par le serveur seulement quand la View a demandé le solde, et dessiné
  seulement après votre clic. Sans lui, la section ne contient que marchandises, lieux, SCU, heures et nombres, rien en
  aUEC. Elle circule sur le canal entre Views sans aucun montant (retiré par l'émetteur puis par le récepteur) et
  n'entre jamais dans le résumé automatique ni dans les messages fixes.
- **Plusieurs trajets.** Un achat après une vente commence un nouveau trajet (deux heures de silence aussi) ; la carte
  montre le dernier et liste les précédents. Le plan s'applique au dernier trajet seulement ; si la marchandise ne
  correspond pas, elle dit que le plan n'est pas vérifié.
- **Barre d'actions.** Juste sous les chiffres principaux se trouve la barre décrite dans la section suivante (elle est
  aussi accessible avant tout trajet ou plan).

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
rend que des routes aller simple), un budget (un nombre : `250000`, `2,5M`), la soute en SCU (préremplie depuis la fiche
du vaisseau, avec sa source), un départ (un terminal, une planète ou un système, résolu par le serveur) et *Proposer la
suite à la fin d'un trajet*. Quand une recherche existe, changer une option la relance seule après un court temps de
calme ; avant le premier clic, rien n'est demandé.

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

## Sessions enregistrées

Le tableau de bord fonctionne **par session**, et une session est enregistrée. Une session est une période de jeu :
quand elle a commencé, le solde à son début et à sa dernière observation, les trajets faits et ce qu'ils ont rapporté,
le temps pendant lequel le jeu a été vu en marche. Vous la retrouvez depuis n'importe quelle conversation, après un
plantage du jeu et après un redémarrage du PC.

- **Pourquoi un fichier côté serveur et pas le `localStorage` du navigateur.** Le `localStorage` appartient à une origine
  de page : chaque conversation a la sienne, donc deux conversations ne verraient pas la même session ; l'hôte peut le
  vider à tout moment ; et les outils du modèle ne peuvent pas le lire. Un petit fichier JSON écrit par ce serveur est
  partagé par toutes les conversations et tous les processus du serveur, survit à l'hôte, et il est lu de la même façon
  par les outils et par le tableau de bord. La page ne garde rien dans le stockage du navigateur.
- **Où.** `sessions.json` dans le dossier de données de l'utilisateur (Windows : `%LOCALAPPDATA%\sc-copilot-mcp\data`).
  `SCMCP_SESSIONS_FILE` le déplace ; `SCMCP_DATA_DIR` déplace le dossier.
- **Quand il existe.** Seulement avec `SC_TELEMETRY=on`. Télémétrie désactivée, rien n'est créé, lu ni surveillé.
  `SC_SESSIONS=off` (ou `0`, `false`, `no`) désactive les sessions tout en gardant la télémétrie : aucun fichier n'est
  créé ni lu, et les outils de session et la barre disparaissent.
- **Pour l'effacer.** Arrêtez Claude Desktop (ou mettez `SC_SESSIONS=off`), puis supprimez `sessions.json`. Les fichiers à
  côté (`sessions.json.corrupt-...`, `.bak-...`) sont des copies gardées quand un fichier était illisible ; supprimez-les
  aussi si vous le souhaitez. Le fichier est du JSON simple : vous pouvez le lire.
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
  jeu, et une session vide est renouvelée, jamais empilée).
- **Elle reprend** quand le jeu est revu dans le délai, que le jeu ait été fermé proprement ou non. La coupure est notée :
  `game_closed` si le jeu a écrit sa ligne de fermeture, `unclean` s'il n'y a pas de marqueur de fin (plantage,
  redémarrage du PC, ou serveur arrêté). Rien n'est inventé sur ce qui s'est passé entre-temps.
- **Elle se termine** quand vous la terminez (**Terminer**, ou `sc_session_end` : elle n'est alors pas reprise, et la
  suivante démarre quand le jeu est vu repartir à neuf), quand une nouvelle démarre, ou quand le délai est dépassé
  (close à sa dernière observation).
- Le temps est compté d'après ce qui a été vu : le **temps actif** est le temps où le jeu a été vu en marche ; une
  coupure n'ajoute rien.

### Ce qui est enregistré, ce qu'un plantage fait perdre

Enregistré, par session : identifiant et numéro, heures de début et de fin, le solde au début (avec sa fiabilité :
`game_start` quand le serveur a vu le flux commencer, `first_seen` quand il a commencé à surveiller plus tard,
`new_session`, `late`) et à la dernière observation, la version et le canal du jeu, le temps actif, les coupures, la
note que vous avez écrite, et les trajets (heure de fin, un libellé, des marchandises et des lieux nettoyés et bornés,
SCU, coût, revenu, marge brute ou résultat mesuré, profit prévu). **Jamais enregistré :** les trames, les lignes brutes
du journal, votre pseudo, votre identifiant de compte, les adresses IP, les GUID de joueurs ou de sessions du jeu, les
identifiants de mission (la clé d'un trajet est un hachage). Aucune donnée de session n'est jamais envoyée sur un
réseau, et le suivi des sessions ne fait aucune requête vers aucun hôte.

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
que ce modèle les a mesurés ou calculés, et le profit prévu quand le modèle a rattaché le plan à la cargaison). La
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
et les réparations.

### Dans le tableau de bord et dans les outils

- **La barre** en haut du tableau de bord montre la session (numéro, état, depuis quand, temps actif), puis les chiffres
  qui comptent d'abord : solde affiché, le résultat, le rythme par heure, les trajets et le temps ; solde masqué, les
  trajets et le temps. Elle a **Nouvelle session** (deux clics, pour éviter un faux geste), **Sessions** (les sessions
  passées avec leurs chiffres clés, les statistiques entre sessions, une session en détail, et **Terminer la session**).
  Deux tableaux de bord de deux conversations montrent la même session, car elle vient du serveur.
- **À l'ouverture**, le tableau de bord se rattache à la dernière session, sauf coupure de plus que le délai : une
  nouvelle est alors créée.
- **Outils** (profil `local` ; les trois premiers aussi dans `trade`) : `sc_session_current` (la session jusqu'ici, le
  dernier lieu et les dernières marchandises nommés par le journal, les derniers trajets : ce qu'il faut à Claude pour
  vous accompagner et proposer la prochaine route), `sc_session_list`, `sc_session_stats`, `sc_session_new`,
  `sc_session_end`. Les deux derniers n'écrivent que le fichier du serveur. Le prompt `trade_copilot` les enchaîne avec les
  outils de routes UEX.
- **Confidentialité du solde.** Tout chiffre en aUEC (soldes, résultats, chiffre d'affaires, marge brute, rythmes) est
  retenu au modèle sauf appel avec `include_balance` (Claude vous demande d'abord), et n'est dessiné dans le tableau de
  bord, envoyé dans son interrogation et entre tableaux de bord qu'après votre clic sur « Afficher le solde ». Les
  comptes, les durées et les noms de lieux ne sont pas retenus.
- **Non vérifié dans le vrai jeu :** toute la fonction a été construite contre de faux jeux et des journaux inventés. La
  fiabilité du solde de départ, la détection du jeu en marche d'après la date du journal et la reprise après un vrai
  plantage n'ont pas été observées.

## Confidentialité

- Le flux est **non chiffré et lisible par n'importe quel programme de votre PC** tant qu'il est actif. Il est lié à
  la boucle locale, il n'est donc pas joignable depuis le réseau.
- Il contient votre santé, votre vaisseau et votre **solde aUEC**. Il ne contient pas votre position.
- Ce serveur ne journalise jamais les trames, ne les écrit jamais sur disque et ne les envoie jamais sur un réseau.
  Ses diagnostics ne contiennent que des numéros de champs. La seule chose qu'il écrit à partir de ces données est
  votre propre fichier de résumés de sessions (voir [Sessions enregistrées](#sessions-enregistrées)) : des résumés qui
  incluent des soldes, par votre décision explicite, jamais des trames, et aucune donnée de session n'est envoyée sur un réseau.
  `SC_SESSIONS=off` le désactive.
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
| `waiting` | Pas de télémétrie pour l'instant. Ne prouve pas que le jeu est éteint : ce serveur ne peut pas le savoir | Rien à corriger si vous êtes dans les menus ou un chargement. Si vous êtes en jeu, personnage apparu, et que cela reste `waiting`, voir la ligne suivante |
| `waiting` (personnage apparu depuis un moment) ou `game_without_telemetry` | Le jeu a été démarré sans la variable | Quittez complètement le RSI Launcher, icône de la zone de notification comprise, relancez-le, lancez le jeu. Cherchez la ligne « registered » dans `Game.log` |
| `connected` mais aucune donnée | Menus ou chargement | Faites apparaître votre personnage. Les données commencent une fois le personnage créé |
| `live` mais aucune donnée de vaisseau | Vous êtes à pied ou dans un véhicule terrestre. C'est normal | Asseyez-vous dans un vaisseau. Les données du vaisseau arrivent 6 à 9 secondes plus tard |
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
