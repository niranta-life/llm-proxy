# Performance rig

Back to [README](../README.md)

This tool measures load, latency, and cost on a running proxy. A blind judge scores the answers and does not see which model wrote them. It does not change routing, qualification, the alias `auto`, or the fallback policy. The figures on [Performance](performance.md) stay the results from mock providers. This rig does not change that page.

## Where it fits

Build the project. Then run the command against a local proxy. Plots land under `perf/runs/`.

## Spend caps and call limits

Smoke defaults to a 0.25 USD cap. Scale defaults to a 1.00 USD cap. A value above 2.00 needs `--i-accept-spend`.

Smoke stops each model after this many calls: openai 8, anthropic 8, xai 3. Smoke stops after 1 judge pair.

Scale stops each model after this many calls: openai 500, anthropic 500, xai 50. Scale stops after 6 judge pairs.

The judge model is OpenAI. The judge scores each pair twice and swaps the answer order the second time.

An alias call reserves the highest model reserve until the proxy names the deployment.

## How to run

Build first:

```bash
PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" npx tsc -p tsconfig.json
```

Smoke:

```bash
node dist/perf/cli.js --profile smoke
```

Scale:

```bash
node dist/perf/cli.js --profile scale --max-usd 1
```

Write the plan only:

```bash
node dist/perf/cli.js --profile smoke --skip-live --out perf/runs/plan-check
```

Read a saved run again. This command does not call a model. It reads the time the provider recorded. It reads the saved token estimates. It reads the saved cost. It writes the analysis again. It stops with an error when it cannot read those saved figures. If that read fails, it does not change `attempts.jsonl`.

```bash
node dist/perf/cli.js --analyze-only --out perf/runs/scale-20261031
```

Useful flags:

- `--base-url` defaults to `http://127.0.0.1:8080`. Compose does not publish that port. Pass `--base-url https://127.0.0.1` for the local ingress. Set `NODE_EXTRA_CA_CERTS` to `config/ingress/live/ca.crt`.
- `--tenant-file` defaults to `config/local-tenant.json`
- `--models` defaults to `openai,anthropic,xai`
- `--out` defaults to `perf/runs/<utc-timestamp>`

The tool never prints the tenant secret. Attempt records omit the prompt and the answer.

A live run checks the sample settings before the first model call. Each live call is a stream, so a full sample store is not replaced. A chat that is not a stream can replace a stored sample when the sample store is full. Streaming capture stores samples from streams. The run stops when streaming capture is on. The report records how many samples are stored before the run and after the run.

## Outputs

Each run directory can hold `plan.json`, `attempts.jsonl`, `waves.jsonl`, `summary.json`, `stats.json`, `learning.json` (answer checks), `report.md`, and `analysis.md`. The directory also holds a plot file when a chart has at least one point.

The tool keeps every run directory. It adds one line for the run to `perf/runs/index.jsonl`. `perf/runs/history.md` lists those runs. The tool does not delete an earlier run.

`analysis.md` states the median time to finish. It states how slow the slowest calls were. It states each model's share of the cost. It states the share of xAI thinking tokens. It states the answer checks. It states the change from the previous run of the same profile.

## Related pages

- [README](../README.md)
- [Performance](performance.md)
