"""Aggregate benchmark span timings without exporting paths or diagnostic messages."""
import argparse
import json
import re
from pathlib import Path

import pandas as pd

STAGES = {'decode_image', 'preprocess_image', 'embed_preprocessed_images',
          'save_image_embeddings', 'image_index'}


def seconds(value):
    match = re.fullmatch(r'([\d.]+)(ns|µs|us|ms|s)', value or '')
    if not match:
        raise ValueError('Unsupported span duration format')
    return float(match[1]) * {'ns': 1e-9, 'µs': 1e-6, 'us': 1e-6, 'ms': 1e-3, 's': 1}[match[2]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    rows = []
    placements = []
    compute_placements = []
    incomplete = 0
    for path in args.directory.glob('*-trace-private.jsonl'):
        model = path.name.removesuffix('-trace-private.jsonl')
        current_run = 1
        decoding_started = False
        placement_provider = None
        with path.open(encoding='utf-8') as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    incomplete += 1
                    continue
                span = event.get('span', {})
                fields = event.get('fields', {})
                if event.get('target') == 'ort::logging':
                    placement = re.fullmatch(r'\s*Node\(s\) placed on \[(DmlExecutionProvider|CPUExecutionProvider)\]\. Number of nodes: (\d+)\s*', str(fields.get('message', '')))
                    if placement:
                        placement_provider = placement[1]
                        placements.append(dict(model=model, provider=placement[1], nodes=int(placement[2])))
                    elif placement_provider and 'VerifyEachNodeIsAssignedToAnEp' in str(span.get('location', '')):
                        operation = re.match(r'\s+(MatMul|Gemm|Conv|Attention|MultiHeadAttention|FusedMatMul)\s+\(', str(fields.get('message', '')))
                        if operation:
                            compute_placements.append(dict(model=model, provider=placement_provider, operation=operation[1]))
                stage = span.get('name')
                if stage not in STAGES or fields.get('message') != 'close':
                    continue
                parents = event.get('spans', [])
                run = next((p.get('run') for p in parents if p.get('name') == 'benchmark_run'), None)
                if run is None:
                    # Rayon workers do not inherit the benchmark span. Runs are
                    # sequential and join their workers before image_index closes.
                    if stage == 'decode_image':
                        decoding_started = True
                    if stage not in {'decode_image', 'preprocess_image'} or not decoding_started:
                        continue  # Exclude loading and warmup.
                    run = current_run
                rows.append(dict(model=model, run=int(run), stage=stage,
                    seconds=seconds(fields.get('time.busy')) + seconds(fields.get('time.idle'))))
                if stage == 'image_index':
                    current_run = int(run) + 1
    frame = pd.DataFrame(rows)
    placement_frame = pd.DataFrame(placements)
    placement_frame.to_csv(args.directory / 'node-placement.csv', index=False)
    print(placement_frame.to_string(index=False))
    if compute_placements:
        compute = pd.DataFrame(compute_placements).groupby(['model', 'provider', 'operation']).size().rename('nodes')
        compute.to_csv(args.directory / 'compute-node-placement.csv')
        print(compute.to_string())
    completed = frame[frame.stage == 'image_index'][['model', 'run']].drop_duplicates()
    frame = frame.merge(completed, on=['model', 'run'])
    totals = frame.groupby(['model', 'run', 'stage']).seconds.agg(['sum', 'count', 'median', 'max']).reset_index()
    totals.to_csv(args.directory / 'stage-timings.csv', index=False)
    pivot = totals.pivot(index=['model', 'run'], columns='stage', values='sum').fillna(0)
    pivot['inferencePercent'] = 100 * pivot['embed_preprocessed_images'] / pivot['image_index']
    summary = pivot.groupby('model').median().round(3)
    summary['completedRuns'] = pivot.groupby('model').size()
    summary.to_csv(args.directory / 'stage-summary.csv')
    print(summary.to_string())
    print(f'Incomplete JSON records skipped: {incomplete}')
    print('Stage seconds overlap across threads; do not add them. Inference includes tensor assembly, ORT execution and output processing; it is not a GPU kernel measurement.')


if __name__ == '__main__':
    main()
