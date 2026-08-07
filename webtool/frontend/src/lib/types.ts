export type Word = { word: string; start: number | null; end: number | null; probability: number };
export type Flags = { hallucination: boolean; silence: boolean; low_conf: boolean };
export type Segment = {
  id: number; start: number; end: number; speaker: string;
  raw_text: string; text: string; words: Word[]; flags: Flags; note: string;
};
export type EditDoc = {
  base: string; project: string; audio: string; language: string;
  human_edited: boolean; context: string; speakers: string[];
  segments: Segment[]; annotations: string[];
};
export type ProjectFile = { base: string; has_audio: boolean; has_raw: boolean; has_edit: boolean; has_md: boolean };
export type ActiveJob = { id: string; kind: string };
/** Mehrere, weil Transkription und Korrektur eines Projekts gleichzeitig laufen duerfen. */
export type Project = { name: string; files: ProjectFile[]; active_jobs?: ActiveJob[] };
export type JobStatus = { status: 'running' | 'done' | 'error' | 'cancelled'; lines: string[]; kind?: string };
export type StartJob = { job_id: string; started: boolean };
export type Thresholds = { yellow: number; red: number };
export type ProviderInfo = {
  id: string; label: string; needs_key: boolean;
  base: string; default_model: string; keys_url: string; hint: string;
};
/** `has_key` statt des Keys: der Schluessel verlaesst den Server nie. */
export type Settings = {
  provider: string; model: string; base_url: string; has_key: boolean;
  has_hf_token: boolean; providers: ProviderInfo[]; env_key: string;
};
export type ModelInfo = { id: string; label: string };
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
