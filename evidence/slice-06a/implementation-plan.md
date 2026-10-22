# Request characteristics

Each completed chat stores one feature row. The row describes the task. It does not store the prompt or the completion.

## Classification

The caller may send `task`. The value must be one of `classification`, `extraction`, `summarization`, `reasoning`, `coding`, `translation`, `writing`, `general_qa`, or `unknown`. Any other value is rejected before a provider call. The field is not forwarded.

When `task` is a known category, the source is `caller_hint`. When it is absent, local rules match the message text in a fixed order and the source is `rules`. When nothing matches, the category and the source are both `unknown`. No second model call is made.

## What a row stores

The row stores the category, the source, a local input-token estimate, provider token counts when the provider sent them, message count, instruction presence, requested streaming, structured-output and tool flags, conversation depth, input size, a complexity estimate, the requested model or alias, the selected deployment, the execution status, the latency, a cost reference, and extractor version 1.

Missing provider usage stays null. The cost reference is the attempt id and the cost status already stored for that attempt. Structured output and tool use stay false, because those request fields are still rejected.

The selected deployment is the deployment on the latest attempt. The requested model stays the caller string, including `auto`.

## Persistence

`migrations/017_request_features.sql` adds `request_features`. It does not edit files `001` through `016` and it does not drop a table or a column. The table has forced row-level security and tenant-scoped foreign keys to the chat request and, when present, the cost attempt. The runtime role can select and insert.

The feature write runs after the chat transaction commits. A thrown extractor is logged and does not change the chat result.

## Reads

`GET /internal/v1/request-features` and `GET /internal/v1/request-features/{requestId}` use the same tenant headers as chat. The list page size is at most 50. `category` and `cursor` filter the page. An invalid filter is rejected. The next page compares the cursor row inside the database, so timestamps in the same millisecond stay in order.

The selected deployment is the latest attempt that has a duration. An attempt that was inserted and then abandoned does not hide that row.
