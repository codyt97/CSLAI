# CSL Plasma AI Route Optimizer API

This project wraps the existing CSL Plasma network HTML app with secure server-side APIs for:

- Geoapify actual truck route mileage
- Excel-derived route group data
- Route-level cost/fuel calculation using Rate Table assumptions
- AI Route Rebuild Agent using OpenAI


## Local data generation

Raw files in `source-data/` are local/private working files and should not be committed. To regenerate source-parsed runtime JSON on a local machine that has those Excel/Word files, run:

```bash
node scripts/build-data.mjs
```

The script writes the generated runtime artifacts to `lib/data/*.json`, which are the JSON files the app and audit APIs use at runtime. Keep raw `.xlsx`, `.docx`, and `.pdf` files out of git.

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
