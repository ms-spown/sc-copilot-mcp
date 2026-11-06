# Utiliser sc-copilot-mcp depuis ChatGPT

[English](CHATGPT.md) · Français

Cette page relie ce serveur à ChatGPT (web ou application) par le **Secure MCP Tunnel** d'OpenAI. ChatGPT n'accepte
qu'une adresse HTTPS publique ou un tunnel ; ce serveur ne parle que par stdio, et cela ne change pas. Le tunnel est
un programme d'OpenAI, `tunnel-client`, qui tourne sur votre PC et démarre ce serveur pour ChatGPT. Une seule
commande, `npm run chatgpt`, le télécharge, le configure et le lance.

> **À lire en premier**
>
> - **Ce qui quitte votre PC.** Tant que le tunnel tourne, ChatGPT (donc OpenAI) peut appeler tous les outils de ce
>   serveur et reçoit toutes les réponses : prix, pages du wiki, votre fichier de flotte, les événements du journal de
>   jeu si vous les avez configurés, et, avec la télémétrie en direct activée, l'état de votre vaisseau et vos sessions
>   enregistrées. **Le solde aUEC est affiché par défaut**, il atteint donc aussi ChatGPT : démarrez avec
>   `--balance hidden` pour garder les montants à l'écart. Voir [Ce qui quitte votre PC](#ce-qui-quitte-votre-pc).
> - **Nouveau et en partie non vérifié.** L'installation, le profil et le démarrage ont été vérifiés sous Windows avec
>   tunnel-client 0.0.19 (détails dans [Ce qui est vérifié](#ce-qui-est-vérifié-et-ce-qui-ne-lest-pas)). Une vraie
>   conversation ChatGPT par un vrai tunnel, et l'affichage du tableau de bord en direct par ChatGPT, ne sont pas
>   encore vérifiés.
> - **Pas à nous.** tunnel-client, ChatGPT et la plateforme OpenAI appartiennent à OpenAI et suivent ses conditions.
>   Ce projet ne dit pas qu'ils sont sûrs ou approuvés pour quoi que ce soit ; il les rend seulement plus simples à
>   installer.

## Ce qu'est le tunnel

- `tunnel-client` est le programme d'OpenAI, libre sous licence Apache-2.0
  ([github.com/openai/tunnel-client](https://github.com/openai/tunnel-client)). Il tourne sur votre PC, ouvre une
  connexion **sortante** vers OpenAI et attend les demandes de ChatGPT. Rien n'est ouvert sur votre box et aucune
  adresse publique n'est créée.
- À chaque appel d'outil, il passe la demande à ce serveur, qu'il a lui-même démarré comme programme enfant (le même
  `dist/index.js` que Claude Desktop lance), et renvoie la réponse à ChatGPT.
- Ce projet ne le fournit pas. `npm run chatgpt -- setup` télécharge l'archive officielle d'une version **épinglée**
  (0.0.19) depuis l'adresse de téléchargement d'OpenAI, vérifie sa taille et son SHA-256 par rapport aux valeurs
  écrites dans ce dépôt, et seulement ensuite la décompresse. Une version plus récente est une modification relue de
  ce dépôt, jamais un « latest » automatique.
- Le serveur lui-même ne change pas : mêmes outils, aucun transport HTTP, aucun nouvel hôte. C'est tunnel-client qui
  parle à OpenAI.

## Ce qui quitte votre PC

- **Les réponses des outils vont à OpenAI.** Tout ce qu'un outil renvoie passe par le tunnel jusqu'à ChatGPT et entre
  dans votre conversation là-bas, selon les conditions et les réglages d'OpenAI, pas ceux de ce projet.
- **Le solde aUEC.** Affiché par défaut, comme dans Claude : le solde et tous les chiffres qui en découlent (résultats
  de session, taux, montants de commerce) atteignent ChatGPT. Pour les garder à l'écart, démarrez le tunnel avec
  `--balance hidden` (cela règle `SC_BALANCE=hidden` pour ce serveur). Le bouton « Masquer le solde » du tableau de
  bord ne le remplace pas ici : il ne protège que le processus serveur du tableau de bord où vous cliquez, et ChatGPT
  n'affiche peut-être pas du tout le tableau de bord.
- **La télémétrie en direct** suit `SC_TELEMETRY` : `--telemetry on` l'allume pour la session, `--telemetry off`
  l'éteint, et sans l'un ni l'autre la valeur déjà présente dans l'environnement de la fenêtre, s'il y en a une, est
  transmise telle quelle. Le côté jeu doit aussi être activé (voir [TELEMETRY.fr.md](TELEMETRY.fr.md), lisez d'abord
  ses risques).
- **Les outils réservés au tableau de bord.** Certains outils n'existent que pour le tableau de bord et portent
  `visibility: ["app"]` (l'hôte ne devrait laisser que le tableau de bord les appeler, pas le modèle), par exemple
  `sc_session_manage`, qui peut supprimer une session enregistrée. ChatGPT ne respecte peut-être pas cette marque :
  son modèle pourrait alors les voir et les appeler. Pour les écarter, démarrez avec `--profiles core,trade,data`
  (ils sont tous dans le profil `local` ; SECURITY.md cite cette limite).
- **La clé d'exécution** (un secret OpenAI, voir plus bas) reste dans un fichier sur votre PC, que cette commande ne
  confie qu'à tunnel-client, par son chemin. Elle n'est jamais affichée, jamais écrite dans le profil ni dans ce dépôt,
  et jamais transmise à ce serveur. Comme tout fichier de votre dossier utilisateur, d'autres programmes de votre
  compte Windows pourraient la lire.
- **Ce que ce serveur envoie sur le réseau ne change pas** : les mêmes sources de données qu'avant, rien d'autre.

## Avant de commencer

- Une installation de ce dépôt qui fonctionne (voir le [README](../README.fr.md#installation)) : Node.js,
  `npm ci --ignore-scripts`, `npm run build`, et votre jeton UEX dans `.env`. Si Claude Desktop lance ce serveur
  depuis le même dossier, quittez-le avant `npm run build`.
- Un compte ChatGPT où le **mode développeur** et les connecteurs personnalisés sont disponibles. Les offres qui le
  proposent changent avec le temps et ne sont pas vérifiées ici : consultez l'aide actuelle d'OpenAI.
- Une organisation sur la plateforme OpenAI (`platform.openai.com`) où vous pouvez créer un tunnel et une clé d'API.
  Le tunnel doit être visible de votre espace de travail ChatGPT.
- Windows 10 ou 11 (x64 ou arm64). Les archives Linux et macOS existent et la commande les prend en charge, mais elles
  ne sont pas testées.

## Étape 1 : le tunnel et la clé d'exécution (plateforme OpenAI)

1. **Un rôle qui peut créer des tunnels.** Sur https://platform.openai.com/settings/organization/people/roles, créez
   un rôle avec Tunnels **Read**, **Manage** et **Use**, et attribuez-le-vous (la documentation d'OpenAI indique que le
   rôle Owner seul ne peut pas créer de tunnels).
2. **Le tunnel.** Sur https://platform.openai.com/settings/organization/tunnels, créez un tunnel et copiez son ID. Il
   ressemble à `tunnel_` suivi de 32 lettres minuscules et chiffres.
3. **La clé d'exécution.** Sur https://platform.openai.com/settings/organization/api-keys, créez une clé, choisissez
   **Restricted** et n'autorisez que Tunnels **Read** et **Use**. Copiez-la (elle n'est affichée qu'une fois).
   N'utilisez jamais une clé d'administration ni une clé qui a toutes les permissions : `npm run chatgpt -- key`
   refuse une clé d'administration.

## Étape 2 : installer le tunnel sur votre PC

Dans un terminal ouvert dans le dossier de ce dépôt (PowerShell convient) :

```powershell
npm run chatgpt -- setup --tunnel-id tunnel_0123456789abcdef0123456789abcdef --dry-run
npm run chatgpt -- setup --tunnel-id tunnel_0123456789abcdef0123456789abcdef
```

Mettez votre propre ID de tunnel. La première ligne montre ce qui serait téléchargé et écrit, sans rien changer ; la
seconde le fait. Notez le `--` après `npm run chatgpt` : sans lui, npm garde les options pour lui (la commande vous le
signale).

Ce que fait `setup` :

- télécharge l'archive de votre système, vérifie sa taille et son SHA-256 (rien n'est décompressé s'ils diffèrent),
  et la décompresse dans `%LOCALAPPDATA%\sc-copilot-mcp\chatgpt\tunnel-client\v0.0.19\` ;
- écrit le profil `profile.yaml` à côté : votre ID de tunnel, le port d'état, l'emplacement du fichier de clé, et la
  commande qui démarre ce serveur (ce Node.js et le `dist/index.js` de ce dossier) ;
- retient tout cela dans `state.json`, pour que `start`, `doctor` et `status` le retrouvent.

Relancez-la quand vous voulez : après avoir déplacé ce dossier, après avoir changé de Node.js, ou avec un autre ID de
tunnel. Elle ne retélécharge pas quand la copie installée est intacte. Le port d'état est `8080` par défaut ; si un
autre programme l'utilise, ajoutez `--port 8090` (n'importe quel port libre de `1024` à `65535`).

## Étape 3 : enregistrer la clé d'exécution

```powershell
npm run chatgpt -- key
```

Collez la clé et appuyez sur Entrée. Rien n'apparaît pendant le collage, pas même des étoiles ; c'est voulu. Vous
pouvez aussi la passer par un tube : `Get-Clipboard | npm run chatgpt -- key`. Ne tapez jamais la clé sur la ligne
de commande elle-même (après `npm run chatgpt`) : npm affiche la ligne de commande et votre shell la garde dans son
historique. La commande la refuse et vous dit de révoquer cette clé.

La clé va dans un seul fichier, `control-plane-api-key`, dans le même dossier. Le profil ne fait que désigner ce
fichier, et tunnel-client le lit au démarrage. Pourquoi un fichier et pas une variable d'environnement : une variable
d'environnement utilisateur est transmise à chaque programme que vous lancez, ce serveur compris ; le fichier n'est
confié qu'à tunnel-client. Comme tout fichier de votre dossier utilisateur, les programmes qui tournent sous votre
compte Windows peuvent quand même le lire. Pour le supprimer : `npm run chatgpt -- key --remove` (et révoquez la clé sur la plateforme
si vous ne l'utilisez plus).

## Étape 4 : démarrer le tunnel

```powershell
npm run chatgpt -- start --balance hidden
```

Gardez cette fenêtre ouverte tant que vous utilisez ChatGPT avec le jeu ; `Ctrl+C` arrête le tunnel (si Windows
demande ensuite s'il faut terminer le programme de commandes, répondez oui). La fenêtre reste silencieuse tant que
tout va bien : seuls les avertissements et les erreurs y apparaissent.

| Option | Ce qu'elle fait |
| --- | --- |
| `--balance hidden` | masque les montants aUEC à ChatGPT pour cette session (`SC_BALANCE=hidden`) ; `--balance shown` les affiche |
| `--telemetry on` | télémétrie en direct pour cette session (`SC_TELEMETRY=on`) ; `--telemetry off` l'éteint |
| `--profiles core,trade` | les profils d'outils que ChatGPT voit (`SCMCP_PROFILES`) ; par défaut `core,trade,data,local`, comme Claude Desktop |
| `--verbose` | le journal d'information de tunnel-client en plus |
| `--dry-run` | montre la commande et les réglages, ne démarre rien |

Les autres réglages de ce serveur (par exemple `SC_INSTALL_DIR` pour le journal de jeu) sont lus dans
l'environnement de la fenêtre : définissez-les dans la même fenêtre PowerShell avant `start`, par exemple
`$env:SC_INSTALL_DIR = "C:\Program Files\Roberts Space Industries\StarCitizen\LIVE"`. tunnel-client transmet son
environnement à ce serveur. Demandez ensuite `sc_data_status` à ChatGPT pour voir ce que le serveur utilise vraiment.

`start` refuse de tourner deux fois pour la même installation (un seul tunnel-client par ID de tunnel, comme OpenAI
l'exige), refuse quand le port d'état est pris, et retire de l'environnement qu'il transmet toute variable que
tunnel-client lirait de lui-même (`CONTROL_PLANE_*`, `OPENAI_*`, `MCP_*`, `LOG_*`, `TRACING_*`, `ALLOW_REMOTE_UI`,
`OPEN_WEB_UI`, `PID_FILE`...). Ainsi une clé ou un réglage resté dans votre environnement ne peut ni passer devant le
profil ni atteindre ce serveur ; la commande nomme ce qu'elle a retiré, jamais les valeurs.

Gardées exprès : les variables de proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`), car certains joueurs ne joignent
internet que par un proxy, et `XDG_CONFIG_HOME`, que ce serveur utilise aussi. Un proxy défini là transporte le trafic
de tunnel-client vers OpenAI, clé d'exécution comprise : n'en laissez jamais un qui pointe vers un outil de débogage.
Toutes les autres variables de la fenêtre (jetons compris) atteignent aussi tunnel-client, car le serveur qu'il démarre
a besoin de l'environnement.

Pour vérifier qu'OpenAI est joint, dans une autre fenêtre :

```powershell
npm run chatgpt -- status
```

`Control-plane poll: PASS` signifie que le tunnel fonctionne vraiment. Une page locale montre aussi l'état du tunnel :
`127.0.0.1:8080/ui` dans votre navigateur (avec votre port si vous l'avez changé).

## Étape 5 : connecter ChatGPT

Pendant que `start` tourne :

1. Ouvrez https://chatgpt.com/#settings/Connectors et activez le **mode développeur** (dans les paramètres avancés).
2. Créez une application (ou « ajouter un serveur MCP personnalisé » ; les intitulés changent de temps en temps).
3. Remplissez le formulaire avec ces valeurs :

```text
Name:            Star Citizen copilot   (au choix)
Connection:      Tunnel                 (choisissez votre tunnel, ou "Enter tunnel ID instead")
Tunnel ID:       tunnel_0123456789abcdef0123456789abcdef   (le vôtre)
Authentication:  No authentication
```

4. Enregistrez. Dans une nouvelle conversation, activez le connecteur et demandez : « Appelle sc_data_status ».

ChatGPT vérifie le tunnel quand vous créez le connecteur : créez-le seulement pendant que le tunnel tourne.

## Au quotidien

- Démarrez le tunnel (`npm run chatgpt -- start --balance hidden`), jouez et parlez à ChatGPT, puis `Ctrl+C`.
- Après une mise à jour de ce dépôt (`git pull`, `npm run build`) : redémarrez le tunnel, puis dans les paramètres du
  connecteur de ChatGPT utilisez **Actualiser** pour que ChatGPT relise la liste des outils.
- Claude Desktop et ChatGPT peuvent servir en même temps : chacun démarre sa propre copie de ce serveur. Le fichier des
  sessions enregistrées est partagé sous un verrou ; le bouton du solde d'un tableau de bord n'agit que sur sa propre
  copie.

## Ce qui est vérifié et ce qui ne l'est pas

Vérifié sous Windows 11 avec tunnel-client 0.0.19, le 2026-11-06, sans vraie clé et avec toutes les routes réseau de
tunnel-client envoyées vers une adresse locale morte :

- `setup` télécharge l'archive officielle, vérifie taille et SHA-256 et la décompresse, dans un dossier utilisateur
  dont le nom contient une espace et des lettres accentuées ;
- la vérification propre à tunnel-client (`npm run chatgpt -- doctor`) accepte le profil écrit par `setup` ;
- `start` lance tunnel-client, qui démarre ce serveur comme enfant et lui transmet son environnement
  (`SC_TELEMETRY` et `SC_BALANCE` mesurés dans l'enfant) ; un second `start` est refusé ; `status` lit la page de
  santé locale.

Non vérifié :

- une vraie conversation dans ChatGPT par un vrai tunnel (il faut un tunnel et une clé ; le mainteneur ne l'avait pas
  fait quand cette page a été écrite) ;
- **l'affichage du tableau de bord en direct par ChatGPT** (la MCP App de ce serveur). La documentation d'OpenAI
  évoque des ressources d'interface, rien de plus précis pour ce genre de page ; les outils qui n'existent que pour le
  tableau de bord peuvent manquer dans ChatGPT, ou être visibles de son modèle (voir
  [Ce qui quitte votre PC](#ce-qui-quitte-votre-pc)) ;
- les offres ChatGPT qui proposent le mode développeur et les tunnels ;
- la façon dont ChatGPT gère beaucoup d'outils à la fois : s'il peine, essayez `--profiles core` ;
- Linux et macOS.

## Dépannage

| Ce que vous voyez | Ce qu'il faut faire |
| --- | --- |
| « npm kept the options for itself » | mettez `--` après `npm run chatgpt` |
| « dist/index.js is missing » | `npm run build` dans ce dossier (quittez d'abord Claude Desktop s'il lance le serveur d'ici), puis `setup` à nouveau |
| « No successful contact with OpenAI yet » dans `status` | attendez quelques secondes ; vérifiez ensuite la clé (Restricted, Tunnels Read + Use), l'ID de tunnel, et votre connexion ou votre proxy ; la fenêtre du tunnel montre l'erreur ; `start --verbose` en montre plus |
| Le tunnel n'est pas proposé dans ChatGPT | le tunnel doit tourner ; votre rôle sur la plateforme doit avoir Tunnels Use ; le tunnel doit appartenir à l'espace de travail de votre compte ChatGPT ; ou utilisez « Enter tunnel ID instead » |
| « Something already listens on 127.0.0.1 » | un autre tunnel ou programme utilise le port : arrêtez-le, ou `npm run chatgpt -- setup --port 8090` |
| « already running » | un tunnel est ouvert dans une autre fenêtre : utilisez-le, ou arrêtez-le avec `Ctrl+C` |
| « changed on disk » ou « not installed » | `npm run chatgpt -- setup` à nouveau |
| ChatGPT montre d'anciens outils | redémarrez le tunnel, puis **Actualisez** le connecteur dans ChatGPT |
| Un problème de chemin dans un profil modifié à la main | tunnel-client mange les barres obliques inverses dans la commande du serveur : gardez des barres obliques et des guillemets, ou laissez `setup` réécrire le profil |

`npm run chatgpt -- doctor` vérifie tout ce que cette commande a installé, puis lance la vérification propre à
tunnel-client. N'activez jamais les options de tunnel-client `--log.http-raw-unsafe` (elle journalise des requêtes
entières, secrets compris) ni `--allow-remote-ui` (elle ouvre la page d'état à votre réseau).

## Le retirer

1. Arrêtez le tunnel (`Ctrl+C`).
2. `npm run chatgpt -- key --remove`, puis supprimez le dossier `%LOCALAPPDATA%\sc-copilot-mcp\chatgpt`.
3. Supprimez le connecteur dans ChatGPT, puis révoquez la clé et supprimez le tunnel sur la plateforme.

Rien d'autre n'a été modifié sur votre PC : aucune variable d'environnement, aucun réglage de Claude Desktop, rien
dans le dossier du jeu.
