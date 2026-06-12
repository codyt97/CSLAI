# CSL Plasma AI Route Optimizer API

This project wraps the existing CSL Plasma network HTML app with secure server-side APIs for:

- Geoapify actual truck route mileage
- Excel-derived route group data
- Route-level cost/fuel calculation using Rate Table assumptions
- AI Route Rebuild Agent using OpenAI


## Local data generation

Raw files in `source-data/` are local/private working files and should not be committed. The parser now uses one consolidated Excel workbook plus the two Word route schedule documents:

- `source-data/Data base final RFQ.xlsx`
  - Primary sheet: `Data base RFQ`
  - `Route Name Mckensson` is the current McKesson route grouping.
  - Column O is the Week A pattern and column P is the Week B pattern.
  - Columns Q through W are pickup days across the two-week schedule.
  - Column Z is weight per case.
  - Column AQ is the McKesson billed weekly baseline amount.
  - Valid PLC values are only `Dallas PLC` and `Whitestown PLC`; `#N/A` and blanks are treated as missing/not assigned.
  - Active RFQ baseline rows must be visible/non-hidden Excel rows with `Center Status = OPEN` and an assigned McKesson route.
- `source-data/Week A Schedule based on Routes.docx`
- `source-data/Week B Schedule Based on Routes.docx`

The old five-workbook Excel source layout (`Billing Center FY26.xlsx`, `Plasma Centers cases details.xlsx`, `Plasma Centers Information.xlsx`, `Rate Table.xlsx`, and `Schedule plasma centers.xlsx`) is no longer required by the parser.

To inspect the consolidated workbook and Word schedules without writing generated JSON, run:

```bash
node scripts/build-data.mjs --dry-run
```

To regenerate source-parsed runtime JSON on a local machine that has those Excel/Word files, run:

```bash
node scripts/build-data.mjs
```

The non-dry-run script writes generated runtime artifacts to `lib/data/*.json`, which are the JSON files the app and audit APIs use at runtime. Keep raw `.xlsx`, `.docx`, and `.pdf` files out of git.

## Important calculation rules

- Plasma centers are stops inside route groups, not individual shipments.
- Deadhead from truck origin to first pickup is shown but excluded from cost.
- Chargeable miles start at first pickup and end at destination PLC.
- Collection center routes use 48 ft refrigerated trailers only.
- 70 cases = 1 pallet.
- 48 ft refrigerated trailer max capacity is 24 pallets; >24 is Over Capacity, 21.6-24 is High Utilization, and <12 is Underutilized.
- >11 driver hours is a validation warning.

## API endpoints

- `GET /api/routes`
- `GET /api/routes?routeName=PHILLY`
- `POST /api/geoapify-route`
- `POST /api/calculate-route`
- `POST /api/ai-route-optimizer`

## Notes

If `OPENAI_API_KEY` is missing, the AI endpoint still returns deterministic route-calculator recommendations so the frontend does not break.

If `GEOAPIFY_API_KEY` is missing, actual road routing is unavailable and the calculator uses fallback road-mile estimates.
