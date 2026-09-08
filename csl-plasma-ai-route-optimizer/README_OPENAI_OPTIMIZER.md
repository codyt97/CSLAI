# OpenAI Network Optimizer

This branch changes the route-optimization workflow so that OpenAI is used as a network-design engine rather than presenting deterministic fallback logic as AI optimization.

## Modes

- **PLC fixed:** keeps each center's current `Actual PLC` unchanged while allowing OpenAI to rebuild route groups and stop sequence.
- **PLC flexible:** allows OpenAI to choose `Dallas PLC` or `Whitestown PLC` as the proposal PLC while rebuilding route groups and stop sequence.

## Source and validation

The optimizer uses the workbook-derived current McKesson network already embedded in the application. It preserves center frequency, A/B schedule, pickup day, pickup hours, cases, liters, and pallets. OpenAI assigns every center exactly once. The backend rejects missing, duplicate, unknown-center, invalid-sequence, or fixed-PLC violations.

OpenAI is not allowed to invent route miles or savings. After an AI proposal passes coverage validation, the backend calculates the proposed route paths and cost estimate. Geoapify road routing is used when `GEOAPIFY_API_KEY` is configured; otherwise the result is explicitly identified as a fallback distance calculation.

If `OPENAI_API_KEY` is missing or the API request fails, the response is marked **NOT OPTIMIZED**. There is no deterministic fallback labeled as AI.

## UI

The root page now exposes an **OpenAI Optimizer** button. The `/openai-optimizer` page lets the user run both modes side by side for the full network, one selected McKesson route, or relay/PLC-mismatch routes. Accepted proposals can be exported to CSV using a column layout modeled on the RFQ `Master Data for suppliers` sheet.
