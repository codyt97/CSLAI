#!/usr/bin/env python3
"""Audit that the static presentation payload is aligned with generated data files.

This intentionally uses only the Python standard library so it can run in the
current repo without npm/pip installs.  It validates the embedded DATA object in
public/network-map.html against lib/data/*.json and reports whether the two
uploaded workbook files are present in the checkout for a full source refresh.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "lib" / "data"
HTML_PATH = ROOT / "public" / "network-map.html"
MANIFEST_PATH = DATA_DIR / "sourceManifest.json"

REQUIRED_RECORD_FIELDS = [
    "id", "routeName", "centerNumber", "city", "state", "basePLC", "actualPLC",
    "centerStatus", "weeklyCases", "weeklyMiles", "totalRouteCost", "routeNameMckesson"
]


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def embedded_data() -> dict:
    html = HTML_PATH.read_text(encoding="utf-8")
    marker = "const DATA = "
    start = html.index(marker) + len(marker)
    end_markers = ["\nDATA.dataSources =", "\n\nconst records = DATA.records;", "\nconst records = DATA.records;"]
    end = next((html.index(marker, start) for marker in end_markers if marker in html[start:]), None)
    if end is None:
        raise ValueError("Could not find end of embedded DATA object")
    return json.loads(html[start:end].strip().rstrip(";"))


def workbook_summary(path: Path) -> dict:
    # XLSX files are zip archives.  Read workbook metadata without openpyxl.
    with zipfile.ZipFile(path) as zf:
        workbook_xml = ET.fromstring(zf.read("xl/workbook.xml"))
        ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        sheets = [node.attrib.get("name", "") for node in workbook_xml.findall("main:sheets/main:sheet", ns)]
    return {"file": path.name, "sizeBytes": path.stat().st_size, "sheets": sheets}


def assert_equal(name: str, left, right) -> None:
    if left != right:
        raise AssertionError(f"Embedded DATA.{name} does not match lib/data/{name}.json")


def main() -> int:
    manifest = load_json(MANIFEST_PATH)
    payload = embedded_data()

    for name in ["records", "stats", "plcCoords", "rateTable"]:
        assert_equal(name, payload.get(name), load_json(DATA_DIR / f"{name}.json"))

    records = payload["records"]
    stats = payload["stats"]
    if stats.get("totalCenters") != len(records):
        raise AssertionError(f"stats.totalCenters={stats.get('totalCenters')} but records={len(records)}")

    open_count = sum(1 for r in records if str(r.get("centerStatus", "")).upper() == "OPEN")
    closed_count = sum(1 for r in records if str(r.get("centerStatus", "")).upper() == "CLOSED")
    if stats.get("openCenters") != open_count:
        raise AssertionError(f"stats.openCenters={stats.get('openCenters')} but calculated open centers={open_count}")
    if stats.get("closedCenters") != closed_count:
        raise AssertionError(f"stats.closedCenters={stats.get('closedCenters')} but calculated closed centers={closed_count}")

    missing = []
    for idx, record in enumerate(records):
        for field in REQUIRED_RECORD_FIELDS:
            if field not in record:
                missing.append(f"record[{idx}] {record.get('id', '<no id>')} missing {field}")
    if missing:
        raise AssertionError("\n".join(missing[:20]))

    workbook_reports = []
    for source in manifest["sourceWorkbooks"]:
        path = ROOT / source["fileName"]
        if path.exists():
            workbook_reports.append(workbook_summary(path))
        else:
            workbook_reports.append({"file": source["fileName"], "present": False, "note": "not present in this local checkout"})

    route_names = sorted({r.get("routeNameMckesson") for r in records if r.get("routeNameMckesson") and r.get("routeNameMckesson") != "#N/A"})
    print(json.dumps({
        "status": "ok",
        "records": len(records),
        "openCenters": open_count,
        "closedCenters": closed_count,
        "mckessonRouteGroups": len(route_names),
        "embeddedPayloadMatchesGeneratedJson": True,
        "workbooks": workbook_reports,
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
