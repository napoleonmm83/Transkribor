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
export type Project = { name: string; files: ProjectFile[] };
export type JobStatus = { status: 'running' | 'done' | 'error' | 'cancelled'; lines: string[]; kind?: string };
export type StartJob = { job_id: string; started: boolean };
export type Thresholds = { yellow: number; red: number };
export type Turn = { key: string; speaker: string; segments: Segment[] };
export type FilePhase = 'diarize' | 'correct' | 'verify' | 'transcribe';
export type GlobalPhase = 'diarize' | 'prep' | 'glossary';
export type FileState = 'done' | 'skipped' | 'failed';
export type JobPhases = {
  global: GlobalPhase | null;
  active: { base: string; phase: FilePhase } | null;
  perBase: Record<string, FileState>;
};
