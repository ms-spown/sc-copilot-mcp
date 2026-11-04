/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The health strip of the live dashboard View: what is wired, what is missing and the exact fix, plus the legend "Comment
 * lire ce tableau". Shipped inside the page next to viewLogic.ts, with the same rules (serialised with
 * Function.prototype.toString): only function declarations, no imports, no module-level values; text reaches the DOM only
 * through textContent. The server sends codes (health.ts); every sentence and command is written here, in French.
 *
 * Value first: the strip is invisible while nothing needs doing. A missing piece shows as one short block with its fix, a
 * command or a line you can copy (or select, when the host forbids the clipboard). "Tout est branché" is said only on
 * request (the "?" button) and at first open. The legend is shown at first open and stays behind the "?" afterwards; what
 * the View remembers (best effort, this browser only, never needed) goes through api.get / api.set.
 */

export function healthNormalize(raw: any): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const pick = (v: any, list: string[]): string | null => (list.indexOf(v) >= 0 ? v : null);
  const log = pick(raw.log, ["off", "unchecked", "ok", "unreadable"]);
  const registration = pick(raw.registration, ["seen", "not_seen", "unknown"]);
  const sessions = pick(raw.sessions, [
    "on",
    "off",
    "unavailable",
    "needs_telemetry",
    "readonly",
    "degraded",
  ]);
  if (!log || !registration || !sessions) return null;
  const labels = [
    "LIVE/Game.log",
    "PTU/Game.log",
    "EPTU/Game.log",
    "HOTFIX/Game.log",
    "TECH-PREVIEW/Game.log",
    "Game.log",
    "custom",
  ];
  const out: any = { v: 1, log, registration, sessions };
  const via = pick(raw.via, ["install_dir", "log_path"]);
  if (via) out.via = via;
  const label = pick(raw.label, labels);
  if (label) out.label = label;
  if (
    typeof raw.saved_at === "string" &&
    /^\d{4}-\d\d-\d\dT[\d:.]{1,16}Z$/.test(raw.saved_at) &&
    Number.isFinite(Date.parse(raw.saved_at))
  ) {
    out.saved_at = raw.saved_at;
  }
  return out;
}

/**
 * The eight lines of the strip, in order: telemetry, game log, registration, connection, journal, sessions, balance, data.
 * kind: ok (wired), todo (to set up), wait (nothing to do yet), info (optional or a fact). `key` joins lines that share a
 * fix. Pure: `h` is a healthNormalize result, `ctx` = { showBalance, now }.
 */
export function healthRows(L: any, poll: any, h: any, ctx: any): any[] {
  const CMD_ENABLE = "npm run telemetry -- enable";
  const CMD_STATUS = "npm run telemetry -- status";
  const LOG_LINE =
    '"SC_INSTALL_DIR": "C:\\\\Program Files\\\\Roberts Space Industries\\\\StarCitizen\\\\LIVE"';
  const state = poll && typeof poll.state === "string" ? poll.state : "off";
  const launcher =
    "Quitte complètement le RSI Launcher (icône de la barre des tâches comprise), relance-le, puis lance le jeu.";
  const row = (
    id: string,
    kind: string,
    label: string,
    detail: string,
    fix?: any,
    key?: string,
  ) => ({
    id,
    kind,
    label,
    detail,
    fix: fix || null,
    key: key || id,
  });
  const rows: any[] = [];

  // 1. telemetry
  const t = (kind: string, detail: string, fix?: any, key?: string) =>
    rows.push(row("telemetry", kind, "Télémétrie du jeu", detail, fix, key));
  if (state === "off") {
    t("todo", "Désactivée côté serveur : rien n’est lu dans le jeu.", {
      cmd: CMD_ENABLE,
      text: "Dans le dossier du serveur. Cette commande montre ce qui changerait sans rien écrire ; ajoute --apply pour l’appliquer, puis quitte Claude Desktop complètement et relance-le.",
    });
  } else if (state === "game_without_telemetry") {
    t(
      "todo",
      "Le jeu a été lancé sans la télémétrie.",
      { cmd: CMD_STATUS, text: launcher },
      "launcher",
    );
  } else if (state === "incompatible") {
    t("todo", "Format inconnu : un patch du jeu a probablement changé la télémétrie.", {
      text: "Mets le serveur à jour (git pull, puis npm ci --ignore-scripts et npm run build) et signale la version du jeu.",
    });
  } else if (state === "live") {
    t("ok", "Les trames arrivent.");
  } else if (state === "connected") {
    t("wait", "Connectée, pas encore de trame : menus ou chargement.");
  } else {
    t("wait", "En attente du premier signal : menus, chargement ou personnage pas encore apparu.");
  }

  // 2. game log
  const via = h.via === "log_path" ? "SC_GAME_LOG_PATH" : "SC_INSTALL_DIR";
  const where = h.label === "custom" ? "fichier .log personnalisé" : h.label || "Game.log";
  const lg = (kind: string, detail: string, fix?: any) =>
    rows.push(row("log", kind, "Journal du jeu (Game.log)", detail, fix));
  if (h.log === "off") {
    lg(
      "todo",
      "Non configuré. Sans lui : pas d’état de connexion (un renvoi pour inactivité reste invisible), pas de journal de commerce ni de carnet de transport, des chiffres de session moins fiables.",
      {
        cmd: LOG_LINE,
        text: "Dans claude_desktop_config.json, entrée « sc-copilot », bloc « env » : ajoute cette ligne (mets le dossier qui contient ton Game.log, et une virgule si une autre ligne suit), puis quitte Claude Desktop complètement et relance-le. Pour un fichier précis, utilise SC_GAME_LOG_PATH.",
      },
    );
  } else if (h.log === "unchecked") {
    lg("wait", "Configuré (" + via + "), mais pas lu tant que la télémétrie est désactivée.");
  } else if (h.log === "ok") {
    lg("ok", "Lu : " + where + " (réglé par " + via + ").");
  } else {
    lg(
      "todo",
      "Configuré (" +
        where +
        ", réglé par " +
        via +
        ") mais illisible : le fichier n’existe qu’après un premier lancement du jeu, ou le dossier est incorrect.",
      {
        text:
          "Vérifie que " +
          via +
          " désigne le dossier qui contient Game.log (par exemple …\\StarCitizen\\LIVE) dans l’entrée « sc-copilot » de la configuration de Claude Desktop, puis relance Claude Desktop. Diagnostic complet : npm run doctor.",
      },
    );
  }
  const needsLog = h.log !== "ok";
  const logWhy =
    h.log === "unchecked"
      ? "Nécessite la télémétrie."
      : "Nécessite le journal du jeu, voir ci-dessus.";

  // 3. registration line
  const reg = (kind: string, detail: string, fix?: any, key?: string) =>
    rows.push(row("registration", kind, "Ligne d’enregistrement du jeu", detail, fix, key));
  if (h.registration === "seen") {
    reg(
      "ok",
      state === "live" || state === "connected"
        ? "Des trames arrivent : le jeu a été lancé avec la variable de télémétrie."
        : "Vue dans Game.log : le jeu a été lancé avec la variable de télémétrie.",
    );
  } else if (h.registration === "not_seen") {
    reg(
      "todo",
      "Game.log n’a pas la ligne du service de télémétrie : le jeu a été lancé sans GRPC_CLIENT_SERVER_ENABLED.",
      { cmd: CMD_STATUS, text: launcher },
      "launcher",
    );
  } else {
    reg(
      "wait",
      h.log === "ok"
        ? "Se vérifie quand le jeu tourne."
        : "Se vérifie quand le jeu tourne et que Game.log est lu.",
    );
  }

  // 4. connection state (needs the log)
  const conn = poll && poll.connection;
  const connNames: any = {
    online: "en partie",
    menu: "dans les menus",
    disconnected: "déconnecté du serveur",
    closed: "jeu fermé",
    unknown: "aucune ligne de connexion lue pour l’instant",
  };
  if (conn && typeof conn.state === "string" && connNames[conn.state]) {
    rows.push(
      row("connection", "ok", "État de connexion", "Disponible : " + connNames[conn.state] + "."),
    );
  } else {
    rows.push(
      row(
        "connection",
        needsLog ? (h.log === "unchecked" ? "wait" : "todo") : "wait",
        "État de connexion",
        needsLog ? logWhy : "En attente de la première lecture.",
        null,
        needsLog ? "log" : "connection",
      ),
    );
  }

  // 5. trade journal and ledger (need the log)
  const ls = poll && poll.ledger && poll.ledger.status;
  if (ls === "ok") {
    rows.push(
      row(
        "journal",
        "ok",
        "Journal de commerce et carnet de transport",
        "Disponibles : contrats et opérations lus dans Game.log.",
      ),
    );
  } else if (ls === "loading") {
    rows.push(
      row(
        "journal",
        "wait",
        "Journal de commerce et carnet de transport",
        "Lecture du journal en cours.",
      ),
    );
  } else if (ls === "unreadable" && h.log === "ok") {
    rows.push(
      row(
        "journal",
        "todo",
        "Journal de commerce et carnet de transport",
        "Le journal est configuré mais sa lecture échoue : fichier verrouillé ou supprimé ?",
        {
          text: "Relance le jeu pour qu’il recrée Game.log ; si cela dure, vérifie " + via + ".",
        },
      ),
    );
  } else {
    rows.push(
      row(
        "journal",
        needsLog ? (h.log === "unchecked" ? "wait" : "todo") : "wait",
        "Journal de commerce et carnet de transport",
        needsLog ? logWhy : "En attente de la première lecture.",
        null,
        needsLog ? "log" : "journal",
      ),
    );
  }

  // 6. saved sessions
  const saved = h.saved_at
    ? "Dernière écriture : " + L.sessionWhen(h.saved_at, ctx.now) + "."
    : "Rien n’a encore été écrit depuis le démarrage du serveur.";
  const se = (kind: string, detail: string, fix?: any) =>
    rows.push(row("sessions", kind, "Sessions enregistrées", detail, fix));
  if (h.sessions === "on") {
    se("ok", "Activées, dans un fichier local. " + saved);
  } else if (h.sessions === "needs_telemetry") {
    se("info", "Elles n’existent que lorsque la télémétrie est activée : rien n’est enregistré.");
  } else if (h.sessions === "off") {
    se(
      "info",
      "Désactivées (SC_SESSIONS est sur « off »). Rien n’est enregistré entre deux parties.",
      {
        text: "Pour les activer : retire SC_SESSIONS de l’entrée « sc-copilot » (ou donne-lui une autre valeur que off), puis relance Claude Desktop.",
      },
    );
  } else if (h.sessions === "unavailable") {
    se(
      "info",
      "Elles devraient tourner, mais le gestionnaire n’a pas répondu à la dernière lecture : rien d’autre à régler de ton côté pour l’instant.",
    );
  } else if (h.sessions === "readonly") {
    se(
      "todo",
      "Le fichier vient d’une version plus récente du serveur : il n’est pas modifié, les sessions restent en mémoire.",
      {
        text: "Mets le serveur à jour.",
      },
    );
  } else {
    se(
      "todo",
      "La dernière écriture a échoué : les sessions restent en mémoire et la prochaine modification retente. " +
        saved,
      {
        text: "Vérifie l’espace disque et les droits du dossier de données (ou de SCMCP_SESSIONS_FILE).",
      },
    );
  }

  // 7. balance (a fact about this screen, nothing to set up)
  rows.push(
    row(
      "balance",
      "info",
      "Solde",
      (ctx.showBalance ? "Affiché sur cet écran. " : "Masqué. ") +
        "« Afficher le solde » demande ton solde au serveur et l’affiche ici, sur cet écran seulement. Il n’est ni dans le résumé automatique envoyé à Claude, ni partagé entre tableaux ; seul « Route avec mon solde et ce vaisseau » l’envoie à la conversation, quand tu l’appuies. Les sessions enregistrées gardent leurs chiffres dans un fichier local.",
    ),
  );

  // 8. data freshness (not measured here: it needs the sources)
  rows.push(
    row(
      "data",
      "info",
      "Fraîcheur des données",
      "Ce tableau ne mesure pas l’âge des données de marché (UEX) et du jeu (SCMDB) : demande « sc_data_status » à Claude.",
    ),
  );
  return rows;
}

/** The lines the strip shows when closed: the things to do, one per shared fix, at most four. */
export function healthTodo(rows: any[]): any[] {
  const seen: any = {};
  const out: any[] = [];
  for (const r of rows) {
    if (r.kind !== "todo" || seen[r.key]) continue;
    seen[r.key] = true;
    out.push(r);
  }
  return out.slice(0, 4);
}

/** Is some line only waiting (the game is not there yet, the first read is pending)? Then "all wired" would say too much. */
export function healthWaiting(rows: any[]): boolean {
  for (const r of rows) if (r.kind === "wait") return true;
  return false;
}

export function healthKindWord(kind: string): string {
  return kind === "ok"
    ? "Branché"
    : kind === "todo"
      ? "À régler"
      : kind === "wait"
        ? "En attente"
        : "Info";
}

/** The legend: [glyph, term, meaning]. The glyph is there so that colour is never the only signal. */
export function healthLegend(): string[][] {
  return [
    ["●", "Mesuré", "valeur envoyée par le jeu à l’instant (vitesse, hydrogène, santé…)."],
    [
      "=",
      "Calculé",
      "somme ou différence de valeurs mesurées (variation du solde depuis le début de la session).",
    ],
    [
      "≈",
      "Estimé",
      "tendance sur les dernières minutes (autonomie en hydrogène, faim, soif) : un ordre de grandeur, la fenêtre est indiquée.",
    ],
    [
      "?",
      "Probable",
      "déduit d’indices, jamais confirmé par le jeu (par exemple l’origine d’un mouvement de solde).",
    ],
    ["—", "Inconnu", "le jeu ne l’envoie pas : un tiret, jamais un zéro inventé."],
  ];
}

export function healthPanel(doc: any, L: any, api: any): any {
  const MAX = 8;
  const KEY = "sc-copilot-help-seen";
  const el = (tag: string, cls?: string, text?: string): any => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const add = (parent: any, ...kids: any[]): any => {
    for (const k of kids) if (k) parent.appendChild(k);
    return parent;
  };
  const setText = (n: any, text: string) => {
    if (n._t !== text) {
      n._t = text;
      n.textContent = text;
    }
  };
  const setAttr = (n: any, name: string, value: string) => {
    const key = "_a_" + name;
    if (n[key] !== value) {
      n[key] = value;
      n.setAttribute(name, value);
    }
  };
  const show = (n: any, on: boolean) => setAttr(n, "data-hidden", on ? "0" : "1");
  const button = (label: string, onClick: () => void, cls: string): any => {
    const b = el("button", "btn " + cls, label);
    b.setAttribute("type", "button");
    b.addEventListener("click", onClick);
    return b;
  };

  const root = el("section", "hl");
  root.setAttribute("aria-label", "Branchement du tableau de bord");
  const head = el("div", "hl-head");
  const title = el("h2", "hl-title", "");
  const btnClose = button("Compris", () => closeHelp(), "mini");
  const btnLater = button("Plus tard", () => dismiss(), "mini");
  btnLater.setAttribute("aria-label", "Masquer ces rappels pour cette fois");
  add(head, title, btnLater, btnClose);
  const list = el("ul", "hl-list");
  const items: any[] = [];
  for (let i = 0; i < MAX; i++) {
    const li = el("li", "hl-item");
    li.tag = el("span", "hl-tag", "");
    li.name = el("strong", "hl-name", "");
    li.text = el("span", "hl-text", "");
    li.fix = el("div", "hl-fix");
    li.fixText = el("p", "hl-fix-text", "");
    li.cmdRow = el("div", "hl-cmd-row");
    li.cmd = el("code", "hl-cmd", "");
    li.copy = button("Copier", () => copyOf(li), "mini");
    add(li.cmdRow, li.cmd, li.copy);
    add(li.fix, li.fixText, li.cmdRow);
    const line = el("div", "hl-line");
    add(line, li.tag, li.name, li.text);
    add(li, line, li.fix);
    items.push(li);
    add(list, li);
  }
  const legend = el("div", "hl-legend");
  add(legend, el("h3", "hl-sub", "Comment lire ce tableau"));
  const dl = el("dl", "hl-terms");
  for (const t of L.healthLegend()) {
    const d = el("div", "hl-term");
    add(d, el("dt", "hl-glyph", t[0] + " " + t[1]), el("dd", "hl-mean", t[2]));
    add(dl, d);
  }
  add(legend, dl);
  add(
    legend,
    el(
      "p",
      "hl-note",
      "Grisé : les valeurs ne sont plus à jour (flux coupé, menus, déconnexion). « non vérifié » : présent dans le flux, jamais vu fonctionner en conditions réelles.",
    ),
    el(
      "p",
      "hl-note",
      "La couleur n’est jamais le seul signal : chaque état est aussi écrit en toutes lettres.",
    ),
  );
  add(root, head, list, legend);

  // The "?" button lives in the header: the same control opens and closes this block.
  const help = button("?", () => toggle(), "small quiet");
  help.setAttribute("aria-label", "Branchement du tableau et comment le lire");
  help.setAttribute("aria-expanded", "false");

  const st: any = { open: false, decided: false, dismissed: false, last: null, rows: [] };

  function remember() {
    if (api.set) api.set(KEY, "1");
  }
  /** The pressed button hides itself with the block: the focus goes to the "?" so that the keyboard is not lost. */
  function refocus() {
    if (help.focus) help.focus();
  }
  function closeHelp() {
    st.open = false;
    remember();
    paint();
    refocus();
  }
  function dismiss() {
    st.dismissed = true;
    paint();
    refocus();
  }
  function toggle() {
    if (st.open) closeHelp();
    else {
      st.open = true;
      st.dismissed = false;
      paint();
    }
  }
  function copyOf(li: any) {
    const text = li._cmd;
    if (!text) return;
    api.copy(text, li.cmd).then((ok: boolean) => {
      setText(li.copy, ok ? "Copié" : "Ctrl+C");
      api.say(
        ok
          ? "Copié dans le presse-papiers."
          : "Copie impossible ici : le texte est sélectionné, fais Ctrl+C.",
      );
      api.later(() => setText(li.copy, "Copier"), 4000);
    });
  }

  function paint() {
    const data = st.last;
    show(help, !!data);
    if (!data) {
      show(root, false);
      return;
    }
    const todo = L.healthTodo(data.rows);
    const open = st.open;
    show(root, open || (todo.length > 0 && !st.dismissed));
    setAttr(help, "aria-expanded", open ? "true" : "false");
    setText(
      title,
      open
        ? todo.length === 0
          ? L.healthWaiting(data.rows)
            ? "Rien à régler pour l’instant"
            : "Tout est branché"
          : todo.length === 1
            ? "1 point à régler"
            : todo.length + " points à régler"
        : todo.length === 1
          ? "À régler pour tout voir"
          : "À régler pour tout voir (" + todo.length + ")",
    );
    show(btnClose, open);
    show(btnLater, !open);
    show(legend, open);
    for (let i = 0; i < MAX; i++) {
      const li = items[i];
      const r = open ? data.rows[i] : todo[i];
      show(li, !!r);
      if (!r) continue;
      setAttr(li, "data-kind", r.kind);
      setText(li.tag, L.healthKindWord(r.kind));
      setText(li.name, r.label);
      setText(li.text, r.detail);
      const fix = r.fix && (open || r.kind === "todo") ? r.fix : null;
      show(li.fix, !!fix);
      setText(li.fixText, fix ? fix.text || "" : "");
      show(li.fixText, !!(fix && fix.text));
      li._cmd = fix && fix.cmd ? fix.cmd : "";
      setText(li.cmd, li._cmd);
      show(li.cmdRow, !!li._cmd);
    }
  }

  return {
    root,
    help,
    /** Whether the block carries the fix of the telemetry line (the stream notice then leaves its own command out). */
    ownsTelemetryFix(): boolean {
      return (
        !!st.last && st.last.rows.length > 0 && st.last.rows[0].kind === "todo" && !st.dismissed
      );
    },
    render(poll: any, ctx: any) {
      const h = poll ? L.healthNormalize(poll.health) : null;
      if (!h || ctx.link === "init") {
        st.last = null;
        paint();
        return;
      }
      st.last = { rows: L.healthRows(L, poll, h, ctx) };
      if (!st.decided) {
        // First open: the legend is shown only if the storage answers and the flag is not set. Where the storage is
        // unavailable nothing can be remembered, so it opens only for something to set up; the choice then lives in memory.
        st.decided = true;
        const seen = api.get ? api.get(KEY) : undefined;
        st.open = seen === undefined ? L.healthTodo(st.last.rows).length > 0 : seen !== "1";
      }
      paint();
    },
  };
}

/** Everything above that the page needs, in the order it is serialised. */
export const HEALTH_VIEW_FUNCTIONS = [
  healthNormalize,
  healthRows,
  healthTodo,
  healthWaiting,
  healthKindWord,
  healthLegend,
  healthPanel,
];
