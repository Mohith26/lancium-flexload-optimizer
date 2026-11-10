#!/usr/bin/env python3
"""Fetch REAL public ERCOT prices for one load zone and write data/ercot_lz_west_2026.json.

Sources (ERCOT MIS public reports, no login, no API key):
  13060  Historical DAM Load Zone and Hub Prices        (hourly, $/MWh)
  13061  Historical RTM Load Zone and Hub Prices        (15-min, $/MWh; averaged to hourly here)
  13091  Historical DAM Clearing Prices for Capacity    (hourly MCPC, $/MW-h: REGDN, REGUP, RRS, NSPIN, ECRS)

Stdlib only (zipfile + ElementTree). Deterministic: same archive -> same JSON.
Usage: python3 scripts/fetch_ercot.py [--year 2026] [--zone LZ_WEST] [--cache /tmp/ercot]
"""
import argparse, io, json, os, sys, urllib.request, zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId={}"
DL = "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={}"
M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RTC_B_GO_LIVE = "2025-12-05"


def doc_for_year(report_id, year):
    with urllib.request.urlopen(LIST.format(report_id), timeout=60) as r:
        docs = json.load(r)["ListDocsByRptTypeRes"]["DocumentList"]
    docs = docs if isinstance(docs, list) else [docs]
    for d in docs:
        d = d["Document"]
        if d["FriendlyName"].endswith(f"_{year}"):
            return d
    raise SystemExit(f"report {report_id}: no archive for {year}")


def fetch(report_id, year, cache):
    doc = doc_for_year(report_id, year)
    path = os.path.join(cache, f"{report_id}_{year}.zip")
    if not os.path.exists(path):
        print(f"downloading {doc['FriendlyName']} ({int(doc['ContentSize'])/1e6:.1f} MB)", file=sys.stderr)
        urllib.request.urlretrieve(DL.format(doc["DocID"]), path)
    outer = zipfile.ZipFile(path)
    return zipfile.ZipFile(io.BytesIO(outer.read(outer.namelist()[0]))), doc


def rows(xlsx):
    """Yield every row (list of strings) of every worksheet, header rows included."""
    ss = []
    if "xl/sharedStrings.xml" in xlsx.namelist():
        for si in ET.fromstring(xlsx.read("xl/sharedStrings.xml")):
            ss.append("".join(t.text or "" for t in si.iter(M + "t")))
    sheets = sorted((n for n in xlsx.namelist() if n.startswith("xl/worksheets/") and n.endswith(".xml")),
                    key=lambda n: int("".join(c for c in n if c.isdigit()) or 0))
    for name in sheets:
        with xlsx.open(name) as f:
            for _, el in ET.iterparse(f):
                if el.tag != M + "row":
                    continue
                out = []
                for c in el:
                    v = c.find(M + "v")
                    v = v.text if v is not None else ""
                    if c.get("t") == "s":
                        v = ss[int(v)]
                    elif c.get("t") == "inlineStr":
                        v = "".join(t.text or "" for t in c.iter(M + "t"))
                    out.append(v)
                el.clear()
                yield out


def key(date_mdY, hour_ending):
    m, d, y = date_mdY.split("/")
    he = int(str(hour_ending).split(":")[0])
    return f"{y}-{m}-{d}", he


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2026")
    ap.add_argument("--zone", default="LZ_WEST")
    ap.add_argument("--cache", default=os.environ.get("TMPDIR", "/tmp"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "ercot_lz_west_2026.json"))
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)

    dam, dam_doc = fetch(13060, a.year, a.cache)
    da = {}
    for r in rows(dam):
        if len(r) >= 5 and r[3] == a.zone and r[2] == "N":
            da[key(r[0], r[1])] = float(r[4])

    rtm, rtm_doc = fetch(13061, a.year, a.cache)
    rt_acc = defaultdict(list)
    for r in rows(rtm):
        # Delivery Date, Delivery Hour, Delivery Interval, Repeated Hour Flag, SP Name, SP Type, SPP
        # (zones appear twice: type LZ and LZEW; we use LZ)
        if len(r) >= 7 and r[4] == a.zone and r[5] == "LZ" and r[3] == "N":
            rt_acc[key(r[0], r[1])].append(float(r[6]))
    rt = {k: sum(v) / len(v) for k, v in rt_acc.items() if len(v) == 4}

    asx, as_doc = fetch(13091, a.year, a.cache)
    asp, hdr = {}, None
    for r in rows(asx):
        if r and r[0] == "Delivery Date":
            hdr = r
            continue
        if hdr and len(r) >= len(hdr) and r[2] == "N":
            asp[key(r[0], r[1])] = {hdr[i]: float(r[i]) for i in range(3, len(hdr)) if r[i] != ""}

    print(f"hours: da={len(da)} rt={len(rt)} as={len(asp)}", file=sys.stderr)
    keys = sorted(set(da) & set(rt) & set(asp))
    services = ["REGUP", "REGDN", "RRS", "ECRS", "NSPIN"]
    out = {
        "zone": a.zone,
        "year": a.year,
        "rtc_b_go_live": RTC_B_GO_LIVE,
        "sources": {
            "dam_spp": dam_doc["ConstructedName"],
            "rtm_spp": rtm_doc["ConstructedName"],
            "dam_mcpc": as_doc["ConstructedName"],
        },
        "notes": "Hourly. rt = mean of four 15-min RTM settlement point prices for the zone. DST repeated hours dropped. "
                 "All hours are after ERCOT's RTC+B go-live (Dec 5 2025).",
        "fields": ["date", "he", "da", "rt"] + services,
        "rows": [[d, he, da[(d, he)], round(rt[(d, he)], 3)] + [asp[(d, he)].get(s, 0.0) for s in services]
                 for (d, he) in keys],
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {len(keys)} hours {keys[0]} .. {keys[-1]} -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
