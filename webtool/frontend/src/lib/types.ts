export type Word = { word: string; start: number | null; end: number | null; probability: number };
/** Aeltere edit.json fuehren noch ein `silence` mit; das liest schlicht niemand mehr. */
export type Flags = { hallucination: boolean; low_conf: boolean };
export type Segment = {
  id: number; start: number; end: number; speaker: string;
  raw_text: string; text: string; words: Word[]; flags: Flags; note: string;
};
export type EditDoc = {
  base: string; project: string; audio: string; language: string;
  // summary optional: vor diesem Feature geschriebene edit.json haben den Schluessel nicht.
  human_edited: boolean; context: string; summary?: string; speakers: string[];
  segments: Segment[]; annotations: string[];
  /** Gesetzt, wenn die gespeicherte Fassung nicht lesbar war und der Server das Dokument aus
   *  dem Rohtranskript neu gebaut hat (#197) — der Wert ist der Ausnahmetyp. Reist mit dem
   *  PUT zurueck und loest dort das Beiseitelegen der unlesbaren Datei aus; gespeichert wird
   *  es nie (der Server entfernt es vor dem Schreiben). */
  selbstgeheilt?: string;
  /** Abschnitte der Aufnahme, zu denen es KEIN Segment gibt (#83). Whisper kann ein
   *  30-Sekunden-Fenster ueberspringen, ohne dass irgendetwas im Ergebnis darauf hinweist —
   *  nur die Abdeckung sieht das. Optional: vor diesem Feature geschriebene edit.json haben
   *  den Schluessel nicht. */
  luecken?: Luecke[];
};
export type Luecke = { start: number; end: number; dauer: number };
export type ProjectFile = { base: string; has_audio: boolean; has_raw: boolean; has_edit: boolean; has_md: boolean };
export type ActiveJob = { id: string; kind: string };
/** Nur die Zusammenfassung fuer die Galerie -- die Dateiliste kommt seit Task 3 nur noch
 *  ueber getProjectFiles (GET /api/projects/{project}), nicht mehr mit hier drin. */
export type Project = { name: string; dateien: number; fertig: number; geaendert: number; active_jobs?: ActiveJob[] };
export type JobStatus = { status: 'running' | 'done' | 'error' | 'cancelled'; lines: string[]; kind?: string };
export type StartJob = { job_id: string; started: boolean };
/** `cli`: laeuft ueber ein lokales Programm mit eigener Anmeldung (Claude-Code- oder
 *  ChatGPT-Abo) — dort gibt es kein Key-Feld, ein Modell aber sehr wohl. */
export type ProviderInfo = {
  id: string; label: string; needs_key: boolean; cli: boolean;
  base: string; default_model: string; keys_url: string; hint: string;
};
export type WhisperChoice = { id: string; label: string; hint: string };
/** Sprach-Auswahl pro Projekt (Backend liefert die zur Verfuegung stehenden Ids + Labels). */
export type SprachChoice = { id: string; label: string; hint: string };
export type TiefeChoice = { id: string; label: string };
/** Per-Projekt-Einstellungen: gewaehlte Sprache + Korrekturtiefe, plus die Wahlmoeglichkeiten,
 *  die der Backend anbietet (fuer Select/Dropdown in der Arbeitsflaeche). */
export type ProjectEinstellungen = {
  sprache: string
  korrektur: string
  /** Enthaelt die Aufnahme weitere Sprachen? `sprache` ist dann die ANKERSPRACHE:
   *  dorthin faellt jedes unsicher erkannte 30-s-Fenster zurueck. */
  mehrsprachig: boolean
  sprach_choices: SprachChoice[]
  tiefen: TiefeChoice[]
};
/** Nur die gesetzten Werte (sprache/korrektur/mehrsprachig). Der PUT echo't genau diese drei Felder;
 *  die Wahlmoeglichkeiten (sprach_choices/tiefen) liefert nur der GET. */
export type EinstellungenWerte = { sprache: string; korrektur: string; mehrsprachig: boolean };
/** Der Datei-GET liefert DREI Werte statt einem: `mehrsprachig` ist der effektive (was die
 *  Transkription nimmt), `mehrsprachig_eigen` der Datei-Override (`null` = folgt dem Projekt)
 *  und `mehrsprachig_projekt` der Standard, den sie dann erbt. Aus dem effektiven Wert allein
 *  ist „folgt dem Projekt" nicht von einem gleichlautenden Override zu unterscheiden (#166). */
export type DateiEinstellungen = ProjectEinstellungen & {
  mehrsprachig_eigen: boolean | null
  mehrsprachig_projekt: boolean
};
/** `mehrsprachig: null` heisst AUSDRUECKLICH „Override entfernen" — das Feld wegzulassen laesst
 *  ihn stehen (Partial-Update). Unterschieden wird serverseitig an `model_fields_set`, also an
 *  der Anwesenheit des Schluessels; `JSON.stringify` wirft nur `undefined` weg, `null` bleibt. */
export type DateiEinstellungenPatch =
  Partial<Omit<EinstellungenWerte, 'mehrsprachig'>> & { mehrsprachig?: boolean | null };
// `device` gilt der torch-Welt (Sprechertrennung, kann "mps"), `asr` der Transkription
// (faster-whisper/CTranslate2, nur "cuda"/"cpu"). Auf einem Mac laufen die beiden ausein-
// ander — deshalb zwei Felder statt einem.
// `asr` ist "cuda" | "cpu" | "metal"; "metal" heisst, dass whisper.cpp rechnet
// (Apple Silicon). `asr_engine` nennt sie beim Namen — fuers Protokoll und fuer
// Fehlerberichte, in denen "warum ist das langsam" die haeufigste Frage ist.
export type Hardware = { device: string; name: string; torch_ok: boolean; asr: string;
                         asr_engine?: string };
/** `has_key` statt des Keys: der Schluessel verlaesst den Server nie. */
export type Settings = {
  provider: string; model: string; base_url: string; has_key: boolean;
  providers: ProviderInfo[]; env_key: string;
  whisper_model: string; whisper_lang: string; whisper_choices: WhisperChoice[];
  ai_ready: boolean; ai_reason: string;
  /** Der GESPEICHERTE Schalter ("1"/"0"). Was tatsächlich gilt, steht in `ytdlp.auto` —
   *  eine gesetzte Umgebungsvariable überstimmt die Datei. */
  ytdlp_auto: string;
  ytdlp: YtdlpStand;
  /** Pfad einer beiseitegelegten, nicht mehr lesbaren Einstellungsdatei — sonst "".
   *  Der Server ersetzt so eine Datei nicht mehr stillschweigend durch Standardwerte
   *  (#192); dort steht unter Umstaenden noch der alte API-Key. */
  kaputt: string;
};
/** `version` ist null, wenn yt-dlp gar nicht installiert ist; `geprueft` leer, solange nie
 *  aktualisiert wurde. `auto` ist der WIRKSAME Schalter, `env` sagt, ob
 *  TRANSKRIBOR_YTDLP_UPDATE ihn überstimmt — beides vom Server, damit das Frontend es nicht
 *  aus zwei Antworten zusammenreimen muss.
 *
 *  `unlesbar` trennt zwei Zustände, die beide `version: null` liefern: wirklich nicht
 *  installiert (dann steht der URL-Import nicht zur Verfügung) gegen "Metadaten nicht
 *  lesbar" — dort läuft der Import weiter, nur die Selbstaktualisierung ist ausgesetzt
 *  (#189). Ohne das Feld behauptete die Seite das Gegenteil dessen, was der Nutzer tun kann. */
/** `laeuft`/`ergebnis` gehören zum Knopf „Jetzt aktualisieren" (#174): der POST kehrt sofort
 *  zurück, pip läuft im Hintergrund weiter. `ergebnis` ist `''`, solange nichts gelaufen ist
 *  oder gerade etwas läuft — sonst `'ok'` bzw. `'fehler'`. Beide sind **Pflichtfelder**: der
 *  Server schickt sie immer, und optional wären sie eine Einladung, den Ausgang eines
 *  Fehlschlags zu vergessen — also genau der stille Ausfall, den der Umbau vermeiden soll. */
export type YtdlpStand = { version: string | null; unlesbar: boolean; geprueft: string; auto: boolean; env: boolean; laeuft: boolean; ergebnis: string };
export type ModelInfo = { id: string; label: string };
/** Anmeldezustand einer Abo-CLI. `unterstuetzt: false` heisst: der Anbieter kennt so etwas
 *  nicht — bei den API-Anbietern IST der Key die Anmeldung. */
export type AuthStatus = { unterstuetzt: boolean; angemeldet: boolean; detail: string };
/** Laufender Anmeldevorgang. `braucht_code`: Claude gibt eine URL aus und WARTET auf einen
 *  Code; Codex zeigt URL und Code an und pollt selbst. */
export type LoginState = {
  laeuft: boolean; provider?: string; url?: string; code?: string;
  braucht_code?: boolean; fertig?: boolean; ok?: boolean; fehler?: string; ausgabe?: string;
};
export type Turn = { key: string; speaker: string; segments: Segment[] };
export type FilePhase = 'diarize' | 'correct' | 'verify' | 'transcribe';
export type GlobalPhase = 'diarize' | 'prep' | 'glossary' | 'download';
export type FileState = 'done' | 'skipped' | 'failed';
export type FileWork = { phase: FilePhase; pct?: number; detail?: string };
export type JobPhases = {
  global: GlobalPhase | null;
  /** Basisname -> was daran gerade laeuft. Mehrere Eintraege, weil correct parallel arbeitet. */
  active: Record<string, FileWork>;
  perBase: Record<string, FileState>;
};
/** Update-Zustand aus Electron. `version` ist immer die LAUFENDE App-Version. */
export type UpdateZustand =
  | { version: string; art: 'unbekannt' | 'prueft' | 'aktuell' }
  | { version: string; art: 'verfuegbar'; neue: string; groesse: number | null }
  /** Mac: Update erkannt, aber Auto-Update ohne Notarisierung nicht moeglich -> manueller Download. */
  | { version: string; art: 'verfuegbar_manuell'; neue: string; groesse: number | null }
  | { version: string; art: 'laedt'; prozent: number; geladen: number; gesamt: number; tempo: number }
  | { version: string; art: 'bereit'; neue: string }
  | { version: string; art: 'fehler'; text: string }
  /** `grund` ist ein Code, kein Satz — der deutsche Text steht in SettingsPage.tsx. */
  | { version: string; art: 'nicht_moeglich'; grund: 'entwicklung' | 'kein-appimage' };
