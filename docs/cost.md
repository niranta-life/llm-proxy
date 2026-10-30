# Cost

Back to [README](../README.md)

[llm-proxy](../README.md) records a cost for each attempt. You supply the price. The proxy does not embed a public price list, and it does not take a payment. A missing price does not change the chat completion. A cost recording error does not change it either.

Currency is USD. A rate is a decimal. A later price does not change an amount that is already stored.

## Where it fits

This page covers step 7. See the [request path](architecture.md#request-path).

## How an amount is classed

- A verified price with complete usage is `estimated`.
- An unverified price is provisional.
- Partial usage is provisional.
- Missing usage is unknown, and the amount is null. A missing count is not stored as zero.

Anthropic and Vertex bill the split token counts. They do not also bill the summed prompt count. OpenAI bills the prompt count and the completion count when no cache count is stored.

A cache rate is billed only when that count is stored. A thinking rate is billed the same way. An absent count is not zero and is not a missing category. A stored cache count with no cache rate stays provisional. A DGX allocated operating cost stays apart from an external provider charge.

A priced success stores cost status `estimated`. A failure after the request was sent, with no usage, is an uncertain expense. The amount stays null. A timeout is not recorded as a zero-cost call.

`GET /internal/v1/metrics/costs` keeps estimated, provisional, reconciled, and unknown amounts apart. See [Metrics](metrics.md). Budget reservations use these amounts. See [Limits and budgets](limits.md).

## Commands

```bash
docker compose run --rm app node dist/cli.js register-price \
  --provider openai \
  --upstream-model gpt-4o-mini \
  --effective-at 2026-01-01T00:00:00Z \
  --source operator \
  --status verified \
  --input-rate 0.000001 \
  --output-rate 0.000002
```

The command can also take `--location`, `--service-tier`, `--serving-provider`, `--cache-read-rate`, `--cache-write-rate`, `--thinking-rate`, `--request-fee`, and `--allocated-rate`. `--status` is `verified` or `unverified`.

```bash
docker compose run --rm app node dist/cli.js set-deployment-service-tier \
  --tenant-id <tenant-id> --deployment primary --service-tier batch
docker compose run --rm app node dist/cli.js reconcile-attempt-cost \
  --tenant-id <tenant-id> --attempt-id <attempt-id>
```

`--service-tier none` clears the tier. Reconcile keeps the stored amount and the stored price version.

## Evaluation schedule

A schedule reserves `0.01` USD for each selected sample before the worker calls the provider. The tenant daily limit and the global daily limit are at most `1`. The tenant monthly limit and the global monthly limit are at most `20`. The per-run maximum cannot exceed the daily limit. The global sums use `evaluation_global_reserved`. Two ticks take the control lock before they insert a reservation.

A cancelled run, a duration cancel, and a killed run leave the reservation `reserved`. The amount is not refunded. A second tick on the same UTC day does not reserve again when a run already exists for that day. A manual run can reserve again when budget remains.

The per-run judge ceiling stays 1 USD. The schedule can also cap judge calls for the day. A pinned rubric counts two judge calls for each selected sample. When those calls do not fit, the tick skips and records `judge_budget_exhausted`. It does not call the judge.

The operator decision and the report have no prompt and no completion text. A schedule tick does not change a price row, an alias, or a fallback policy.

## Related

- [Limits and budgets](limits.md)
- [Evaluation](architecture.md#evaluation)
- [Metrics](metrics.md)
- [Retry](retry.md)
