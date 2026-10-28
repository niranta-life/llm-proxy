# Qualification algorithms

The decision is `qualifyCohort` in `src/inference/qualification.ts`. It reads counts and version fields that a completed evaluation already stored. It does not call `decide()` from the evaluation report. It does not copy `eligible_for_canary`. It imports `wilsonInterval` from `src/inference/evaluation-report.ts` and `inputSizeBand` from `src/inference/sample-selection.ts`.

A refresh loads completed and `completed_partial` runs whose challenger deployment name equals the profile candidate. The select list is run, item, sample metadata, attempt, cost, and judge outcome. It does not select ciphertext, wrapped keys, prompts, or messages.

## Cohort

An item is skipped when the evaluation profile is not approved, the run is not completed, the attempt is not completed, the original attempt is absent, or the challenger deployment name differs.

A remaining item falls into one bucket, in this order:

1. `expired` when `run.updated_at` is older than the profile freshness window.
2. `wrong_task` when the sample task is null or the sample or run task differs from the profile.
3. `output_requirement` when the run profile version differs.
4. `complexity` when complexity is null or differs. A null value is a mismatch.
5. `size` when the input size is null or `inputSizeBand` differs. Bands are `xs`, `s`, `m`, `l`, `xl`, `xxl`, and `unknown`.
6. `capability` when the sample capabilities are null or omit a required capability.
7. `model` when the upstream model or the deployment config version differs.
8. `adapter` when the adapter version differs.
9. `matched`.

Coverage is `matched / (matched + size + complexity)`. The rate is 0 when that denominator is 0. The quotient is rounded to 6 decimal places. Output-requirement and wrong-task items are not in the coverage denominator.

## One status

The first true gate wins. `qualified` has an empty reason list.

1. Any matched item with both a pass and a fail on the challenger is `invalidated` `contradictory_findings`.
2. Any matched item whose forward and reverse judge maps name opposite winners is `invalidated` `judge_order_bias`.
3. Zero matched items is `invalidated` with the first positive mismatch: `expired_evidence`, `wrong_task`, `input_size_mismatch`, `complexity_mismatch`, `model_version_mismatch`, `adapter_version_mismatch`, `capability_mismatch`, `output_requirement_mismatch`. If none of those counts is positive, the status is `inconclusive` `insufficient_samples`.
4. Matched count below `minSamples` is `inconclusive` `insufficient_samples`.
5. Coverage below `minCoverage` is `inconclusive` `request_distribution_gap`.
6. A missing challenger latency or a missing original duration is `inconclusive` `missing_latency`.
7. A cost whose status is not `estimated`, `provisional`, or `reconciled`, or whose amount is null, is `inconclusive` `unknown_cost`. Unknown is not zero. Both sides are required.
8. Zero pass-or-fail results on either side is `inconclusive` `judge_is_not_objective`. A cheap judge win does not qualify.
9. A null Wilson interval is `inconclusive` `invalid_objective_result`.
10. A challenger Wilson lower bound below `objectiveFloor` is `unqualified` `objective_threshold_failed`. This check runs before the width check.
11. A Wilson width above `maxIntervalWidth` is `inconclusive` `uncertainty_too_wide`.
12. A Newcombe difference lower bound at or below the negative margin is `unqualified` `noninferiority_failed`.
13. A judge outcome of `inconclusive`, or `unstable` without order bias, is `inconclusive` `judge_inconclusive`.
14. Otherwise the status is `qualified`.

## Uncertainty

`Z` is 1.96. `round6` is `Math.round(value * 1_000_000) / 1_000_000`.

The Wilson center is `(p + z^2 / (2n)) / (1 + z^2 / n)`. The margin divides `z * sqrt(p(1-p)/n + z^2/(4n^2))` by the same denominator. The lower bound is `round6` of the center minus the margin, floored at 0. The upper bound is `round6` of the center plus the margin, capped at 1.

The difference lower bound uses those already rounded Wilson bounds. `p1` and `p2` are the raw pass rates. `diffLower = round6((p1 - p2) - sqrt((p1 - lower1)^2 + (upper2 - p2)^2))`. The method name is `wilson_95_newcombe`. A raw point estimate is not a qualification.

## Storage

`POST /internal/v1/routing/qualification-profiles` inserts one profile and version 1. `POST /internal/v1/routing/evidence/refresh` inserts one snapshot and one assessment. A later refresh inserts another snapshot. A before-update-or-delete trigger rejects a change. The snapshot stores the profile version id and the source run ids. Chat and `resolveModel` do not call refresh and do not read the snapshot.
