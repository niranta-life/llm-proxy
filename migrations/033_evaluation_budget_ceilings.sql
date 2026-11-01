-- Raise the evaluation schedule ceilings so one run can hold a qualifying cohort.
-- A perfect cohort needs 73 paired samples before a 0.05 noninferiority margin can pass.
-- This file replaces ceiling checks. It does not drop a column or a table.
-- This file does not edit migrations 001 through 032.
-- The monthly ceiling stays 20. The stored global monthly limit is 2.92.
-- Rollback keeps this file applied. Lowering a ceiling needs a later migration.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE evaluation_controls DROP CONSTRAINT evaluation_controls_daily_check;
ALTER TABLE evaluation_controls
  ADD CONSTRAINT evaluation_controls_daily_check
  CHECK (global_daily_limit > 0 AND global_daily_limit <= 2.92);

ALTER TABLE evaluation_schedules DROP CONSTRAINT evaluation_schedules_daily_check;
ALTER TABLE evaluation_schedules
  ADD CONSTRAINT evaluation_schedules_daily_check
  CHECK (daily_limit > 0 AND daily_limit <= 2.92);

ALTER TABLE evaluation_schedules DROP CONSTRAINT evaluation_schedules_samples_check;
ALTER TABLE evaluation_schedules
  ADD CONSTRAINT evaluation_schedules_samples_check
  CHECK (max_samples BETWEEN 1 AND 73);

ALTER TABLE evaluation_schedules DROP CONSTRAINT evaluation_schedules_calls_check;
ALTER TABLE evaluation_schedules
  ADD CONSTRAINT evaluation_schedules_calls_check
  CHECK (max_challenger_calls BETWEEN 1 AND 292 AND max_judge_calls BETWEEN 0 AND 40);

UPDATE evaluation_controls
SET global_daily_limit = 2.92,
    global_monthly_limit = 2.92,
    updated_at = now()
WHERE singleton;

RESET ROLE;
