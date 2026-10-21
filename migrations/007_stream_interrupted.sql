-- Allow a shutdown to record an interrupted stream.
-- Existing rows stay unchanged. This file does not drop a column.
-- This file returns to the migrator before the version row is recorded.

SET LOCAL ROLE llm_owner;

ALTER TABLE model_attempts DROP CONSTRAINT model_attempts_stream_status_check;

ALTER TABLE model_attempts
  ADD CONSTRAINT model_attempts_stream_status_check CHECK (
    stream_status IS NULL
    OR stream_status IN (
      'connecting',
      'streaming',
      'completed',
      'client_aborted',
      'provider_failed',
      'timed_out',
      'stream_truncated',
      'slow_consumer',
      'interrupted'
    )
  );

RESET ROLE;
