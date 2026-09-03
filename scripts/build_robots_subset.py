#!/usr/bin/env python3
"""Build registry entries for specific robot ids and merge into data/robots.json."""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_registry as br  # noqa: E402


def build_item(item: dict, measured: dict) -> tuple[dict | None, str | None]:
    key = br.curated_key(item)
    if item.get("mirror"):
        up = br.mirror_from_curation(item)
    elif item.get("upstream"):
        up = br.upstream_from_curation(item)
    else:
        return None, f"{key}: not an upstream/mirror entry"

    http = br.Http(offline=False)
    if up.urdf_path is None:
        return None, f"{key}: no URDF path"

    facts = br.inspect_urdf(up, http)
    if not facts.ok:
        return None, f"{key}: {facts.error}"
    if facts.missing:
        return None, f"{key}: {len(facts.missing)} unresolved meshes, e.g. {facts.missing[0]}"

    unknown = sorted(set(item.get("pose") or ()) - set(facts.joint_names))
    if unknown:
        return None, f"{key}: pose names unknown joints {unknown}"
    problem = br.preview_frame_problem(item.get("preview_frame"))
    if problem:
        return None, f"{key}: {problem}"
    problem = br.loops_problem(item.get("loops"), facts)
    if problem:
        return None, f"{key}: {problem}"

    entry = br.entry_for(up, facts, item, measured.get(br.curated_id(item)))

    specs = item.get("variants") or []
    seen: set[str] = set()
    variants = []
    for spec in specs:
        vid = br.variant_id(spec)
        if vid in seen:
            return None, f"{key}: two versions both called {vid}"
        seen.add(vid)
        vup = replace(
            up,
            urdf_path=spec["urdf"],
            mjcf_path=spec.get("mjcf"),
            package_path=spec["package"] if "package" in spec else up.package_path,
            commit=spec["commit"] if spec.get("commit") else up.commit,
            mesh_rewrite=br.mesh_rewrite_rules(
                item.get("upstream") or item.get("mirror") or {}, spec
            ),
        )
        already_read = (
            vup.urdf_path == up.urdf_path
            and vup.package_path == up.package_path
            and vup.mesh_rewrite == up.mesh_rewrite
            and vup.commit == up.commit
        )
        vfacts = facts if already_read else br.inspect_urdf(vup, http)
        if not vfacts.ok:
            return None, f"{key} · {vid}: {vfacts.error}"
        if vfacts.missing:
            return None, (
                f"{key} · {vid}: {len(vfacts.missing)} unresolved meshes, e.g. {vfacts.missing[0]}"
            )
        variants.append(br.variant_for(spec, vup, vfacts, measured.get(vid)))

    if variants:
        entry["variants"] = variants
        entry["formats"] = sorted({f for v in variants for f in v["formats"]})

    http.save()
    return entry, None


def refresh_mjcf_entry(entry: dict, measured: dict) -> tuple[dict | None, str | None]:
    """Re-probe a pinned MJCF-only card (Menagerie and similar) and rewrite assets."""
    rid = entry["id"]
    src = entry.get("source") or {}
    assets = entry.get("assets") or {}
    github = src.get("github")
    commit = src.get("commit")
    scene = assets.get("mjcf")
    if not (github and commit and scene):
        return None, f"{rid}: not a pinned MJCF entry"
    if entry.get("urdf"):
        return None, f"{rid}: has a URDF card; refresh it via curation instead"

    base = f"{br.CDN}/{github}@{commit}/"
    http = br.Http(offline=False)
    facts = br.inspect_mjcf(base, scene, http)
    if not facts.ok:
        return None, f"{rid}: {facts.error}"
    if facts.missing:
        return None, f"{rid}: {len(facts.missing)} unresolved assets, e.g. {facts.missing[0]}"

    assets["mesh_files"] = facts.mesh_files
    assets["mesh_bytes"] = facts.mesh_bytes
    assets["mesh_formats"] = facts.mesh_formats
    assets["mjcf_model"] = facts.model_path
    if facts.skipped:
        assets["skip_meshes"] = facts.skipped
    else:
        assets.pop("skip_meshes", None)
    if facts.alt:
        assets["mesh_alt"] = facts.alt
    else:
        assets.pop("mesh_alt", None)
    entry["assets"] = assets
    if facts.model_bytes:
        entry.setdefault("mjcf", {})["model_bytes"] = facts.model_bytes
    if measured.get(rid):
        entry["measured"] = measured[rid]
    http.save()
    return entry, None


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: build_robots_subset.py <id> [<id> ...]", file=sys.stderr)
        return 2

    ids = list(dict.fromkeys(sys.argv[1:]))
    wanted = set(ids)
    curation = json.loads((ROOT / "data" / "curation.json").read_text())
    measured_path = ROOT / "data" / "measured.json"
    measured = json.loads(measured_path.read_text()) if measured_path.exists() else {}

    items = [item for item in curation["robots"] if br.curated_id(item) in wanted]
    curated_ids = {br.curated_id(item) for item in items}

    registry_path = ROOT / "data" / "robots.json"
    registry = json.loads(registry_path.read_text())
    by_id = {entry["id"]: entry for entry in registry["robots"]}

    leftover = [rid for rid in ids if rid not in curated_ids]
    unknown = [
        rid
        for rid in leftover
        if rid not in by_id or not by_id[rid].get("mjcf") or by_id[rid].get("urdf")
    ]
    if unknown:
        print(f"unknown ids: {sorted(unknown)}", file=sys.stderr)
        return 2

    problems: list[str] = []
    built = 0
    for item in items:
        entry, problem = build_item(item, measured)
        if problem:
            problems.append(problem)
        elif entry:
            by_id[entry["id"]] = entry
            built += 1
            print(f"built {entry['id']}")

    for rid in leftover:
        entry, problem = refresh_mjcf_entry(by_id[rid], measured)
        if problem:
            problems.append(problem)
        elif entry:
            by_id[entry["id"]] = entry
            built += 1
            print(f"refreshed {entry['id']}")

    if problems:
        for problem in problems:
            print(f"PROBLEM {problem}", file=sys.stderr)
        return 1

    order = {br.curated_id(item): i for i, item in enumerate(curation["robots"])}
    existing = {entry["id"]: i for i, entry in enumerate(registry["robots"])}
    registry["robots"] = sorted(
        by_id.values(),
        key=lambda e: (order.get(e["id"], 10**9), existing.get(e["id"], 10**9)),
    )
    registry["generated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    registry_path.write_text(json.dumps(registry, indent=1, ensure_ascii=False) + "\n")
    print(f"merged {built} entries into {registry_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
