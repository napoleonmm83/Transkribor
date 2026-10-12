"""Measure correct stdout truncation using real producers and local AI answers.

Run from the repository root. Results and synthetic projects remain under
--output; no project data or provider calls are used.
"""
import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class Tee(io.TextIOBase):
    def __init__(self, stream, log):
        self.stream, self.log = stream, log

    def write(self, text):
        self.log.write(text)
        return self.stream.write(text)

    def flush(self):
        self.log.flush()
        self.stream.flush()


def probe_env(run):
    env = {'TRANSKRIBOR_PROJEKTE': str(run / 'projects'),
           'TRANSKRIBOR_SETTINGS': str(run / 'settings.json'),
           'TRANSKRIBOR_PARALLEL': '1', 'TRANSKRIBOR_DIARIZE': '0',
           'TRANSKRIBOR_YTDLP_UPDATE': '0'}
    os.environ.update(env)
    return env


def child(run, count):
    manifest = json.loads((run / 'probe.json').read_text(encoding='utf-8'))
    if count < 3 or manifest != {'files': count, 'project': 'Probe'}:
        raise ValueError('child requires a matching synthetic probe manifest')
    probe_env(run)  # The child also isolates its root when invoked directly.
    from webtool import correct, paths

    last = f'S{count - 1:04d}'
    # The provider boundary is the same fixture used by test_correct.py.
    def answer(prompt, inputs, output):
        target = Path(output)
        if target.name == '_glossar.json':
            doc = {'proper_nouns': [], 'likely_corrections': []}
        else:
            base = target.name.removesuffix('.correction.json')
            if base == 'S0001':
                raise RuntimeError('synthetic provider failure')
            if base == last:
                (run / 'ready').touch()
                deadline = time.monotonic() + 90
                while not (run / 'release').exists():
                    if time.monotonic() >= deadline:
                        raise TimeoutError('probe release deadline')
                    time.sleep(0.02)
            doc = {'base': base, 'speakers': ['Person'],
                   'segments': [{'id': 0, 'speaker': 'Person', 'text': 'Messung.'}]}
        paths.atomic_write(output, json.dumps(doc, ensure_ascii=False))

    correct._ask_llm = answer
    correct._recording_evidence = lambda *args, **kwargs: ''
    with (run / 'stdout.txt').open('w', encoding='utf-8') as log:
        previous = sys.stdout
        sys.stdout = Tee(previous, log)
        try:
            correct.cmd_run('Probe', force=True, verify=False)
        finally:
            sys.stdout.flush()
            sys.stdout = previous


def wait_for(predicate, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise TimeoutError('probe did not reach its checkpoint')


def parse(snapshot, full, run, controls):
    payload = run / 'parser-input.json'
    payload.write_text(json.dumps({'job': snapshot, 'full': full, 'controls': controls},
                                  ensure_ascii=False), encoding='utf-8')
    code = """
import fs from 'node:fs';
import {parseJobPhases, warteKarte, schonDurch} from './webtool/frontend/src/lib/jobPhases.ts';
import {ausgang} from './webtool/frontend/src/lib/jobAusgang.ts';
const {job, full, controls} = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
function read(lines) {
  const p = parseJobPhases(job.kind, lines, job.gesehen, job.entfernt,
                           job.eingereiht, job.entfernt_je);
  const waiting = warteKarte(p, job.kind);
  return {verdicts: Object.keys(p.perBase).length,
    controls: Object.fromEntries(controls.map(b => [b, {
      state: p.perBase[b] ?? null, active: p.active[b] ?? null,
      waiting: waiting[b] ?? null, through: schonDurch(p, job.kind, b),
      reached: p.erreicht?.[b] ?? null}])),
    outcome: ausgang({status: job.status, phases: p})};
}
console.log(JSON.stringify({status: job.status, sourceLines: full.length,
  keptLines: job.lines.length, full: read(full), capped: read(job.lines)}));
"""
    node = shutil.which('node')
    if node is None:
        raise RuntimeError('Node.js with Type-Stripping is required')
    # Fixed JS source and argument list; the payload path is generated locally.
    result = subprocess.run(  # noqa: S603
        [node, '--experimental-strip-types', '--input-type=module',
                             '-e', code, str(payload)], cwd=ROOT, capture_output=True,
                            text=True, encoding='utf-8', timeout=30, check=True)
    return json.loads(result.stdout)


def probe(count, output):
    output.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=output))
    tdir = run / 'projects' / 'Probe' / 'transkripte'
    tdir.mkdir(parents=True)
    raw = {'language': 'de', 'segments': [
        {'id': 0, 'start': 0, 'end': 1, 'text': 'Messung.'}]}
    for i in range(count):
        base = f'S{i:04d}'
        (tdir / f'{base}.json').write_text(json.dumps(raw), encoding='utf-8')
        (tdir / f'{base}.raw.txt').write_text('Messung.', encoding='utf-8')
    (run / 'probe.json').write_text(json.dumps({'files': count, 'project': 'Probe'}),
                                     encoding='utf-8')
    env = probe_env(run)
    from webtool import jobs

    controls = ['S0000', 'S0001', f'S{count - 1:04d}']
    jid, started = jobs.start('Probe', [sys.executable, '-u', str(Path(__file__).resolve()),
                                      '--child', str(run), str(count)], cwd=ROOT,
                             kind='correct', env=env)
    if not started:
        raise RuntimeError('fresh probe job was not started')
    try:
        try:
            wait_for(lambda: (run / 'ready').exists())
            snapshot = wait_for(lambda: (r if any('Korrigiere ' + controls[-1] in line
                                                  for line in r['lines']) else None)
                                if (r := jobs.get(jid)) else None)
            if snapshot['status'] != 'running':
                raise RuntimeError('checkpoint is not a running job')
            full = (run / 'stdout.txt').read_text(encoding='utf-8').splitlines()
            running = parse(snapshot, full, run, controls)
            running['disk'] = {b: (tdir / f'{b}.edit.json').exists() for b in controls}
            (run / 'running.json').write_text(json.dumps(snapshot, ensure_ascii=False),
                                              encoding='utf-8')
        finally:
            (run / 'release').touch()
        final = wait_for(lambda: r if (r := jobs.get(jid))['status'] != 'running' else None)
        if final['status'] != 'done' or final['returncode'] != 0:
            raise RuntimeError('synthetic correct job did not complete: ' + final['status'])
        final_full = (run / 'stdout.txt').read_text(encoding='utf-8').splitlines()
        ended = parse(final, final_full, run, controls)
        (run / 'final.json').write_text(json.dumps(final, ensure_ascii=False), encoding='utf-8')
        result = {'files': count, 'cap': jobs.MAX_JOB_LINES, 'artifacts': str(run),
                  'running': running, 'final': ended}
        # These are measurement preconditions, never assertions of the known defect.
        reference = running['full']['controls']
        valid = (reference[controls[0]]['state'] == 'done'
                 and reference[controls[1]]['state'] == 'failed'
                 and reference[controls[-1]]['active'] == {'phase': 'correct'}
                 and running['disk'] == {controls[0]: True, controls[1]: False, controls[-1]: False}
                 and ended['full']['outcome']['art'] == 'teil')
        if not valid:
            raise RuntimeError('measurement controls failed: ' + json.dumps(result))
        (run / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                        encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        (run / 'release').touch()
        remaining = jobs.get(jid)
        if remaining and remaining['status'] == 'running':
            jobs.cancel(jid)



def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--child':
        child(Path(sys.argv[2]), int(sys.argv[3]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--files', type=int, default=2000)
    parser.add_argument('--output', type=Path, default=ROOT / '.tmp-t067-correct')
    args = parser.parse_args()
    if args.files < 3:
        parser.error('--files must be at least 3 for the three controls')
    probe(args.files, args.output.resolve())


if __name__ == '__main__':
    main()
