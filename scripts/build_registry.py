#!/usr/bin/env python3
"""Generate ``data/robots.json`` — the registry the gallery site reads.

The gallery never vendors robot models. It records, for every entry, the
upstream repository plus the exact commit that ``robot_descriptions.py`` pins,
and serves the URDF and its meshes straight from jsDelivr's GitHub CDN at that
commit. This script turns that upstream metadata into a self-contained registry:

  1. read robot metadata (maker, DOF, tags, license) from ``robot_descriptions``,
     or, for a model it does not ship, from an ``upstream`` block in the curation
  2. static-parse each description module for its repository and URDF path
     (importing the module would clone the whole repository)
  3. download only the URDF file itself and parse joints, links and meshes
  4. resolve every ``package://`` reference to a real path in the repository by
     probing the CDN, so a broken entry fails the build instead of the browser
  5. merge the hand-curated bits from ``data/curation.json``

Usage::

    pip install -r scripts/requirements.txt
    python3 scripts/build_registry.py                 # curated entries
    python3 scripts/build_registry.py --candidates    # report on everything

HTTP responses are cached under ``.cache/`` so re-runs are cheap.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import posixpath
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
CDN = "https://cdn.jsdelivr.net/gh"
UA = {"User-Agent": "robot-urdf-gallery-build"}
# Deliberately no Accept-Encoding header: jsDelivr answers a compression-capable
# client with the compressed Content-Length (a 10.7 MB Collada file reports
# 2.6 MB under brotli), while "identity" makes it omit Content-Length entirely.
# Sending nothing yields the raw file size, which is the number worth recording —
# but it does mean mesh_bytes can differ between environments, so the drift check
# in CI treats it as informational.
MOVING_JOINTS = ("revolute", "continuous", "prismatic", "planar", "floating")


# --------------------------------------------------------------------------- #
# upstream metadata
# --------------------------------------------------------------------------- #


@dataclass
class Upstream:
    """What we know about a robot description before touching the network."""

    key: str
    robot: str
    maker: str | None
    dof: int | None
    tags: list[str]
    formats: list[str]
    license_spdx: str | None
    # Repository-relative path of the licence file, not the package-relative
    # name robot_descriptions records: some repositories keep a single licence
    # at the root rather than one per description package.
    license_path: str | None
    github: str | None
    commit: str | None
    package_path: str
    urdf_path: str | None
    mjcf_path: str | None
    uses_xacro: bool
    # False for entries hand-written in data/curation.json, which have no
    # module in robot_descriptions.py to link to or load through.
    from_descriptions: bool = True


def _join_parts(node: ast.expr, env: dict[str, list[str]]) -> list[str]:
    """Resolve an ``os.path.join(...)`` expression into its literal parts."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.Name):
        return list(env.get(node.id, []))
    if isinstance(node, ast.Call):
        parts: list[str] = []
        for arg in node.args:
            parts.extend(_join_parts(arg, env))
        return parts
    return []


def read_upstream(descriptions_dir: Path) -> list[Upstream]:
    """Collect metadata for every description shipped by robot_descriptions."""
    from robot_descriptions._descriptions import DESCRIPTIONS
    from robot_descriptions._repositories import REPOSITORIES

    out: list[Upstream] = []
    for key, desc in sorted(DESCRIPTIONS.items()):
        module = descriptions_dir / f"{key}.py"
        if not module.exists():
            continue
        source = module.read_text()
        tree = ast.parse(source)

        env: dict[str, list[str]] = {}
        paths: dict[str, str] = {}
        repo_key: str | None = None
        for stmt in tree.body:
            if not (isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)):
                continue
            name = stmt.target.id
            if name == "REPOSITORY_PATH":
                # clone_to_cache("<repository key>", ...) — the repository is
                # the first positional argument.
                if isinstance(stmt.value, ast.Call) and stmt.value.args:
                    first = stmt.value.args[0]
                    if isinstance(first, ast.Constant):
                        repo_key = first.value
                env[name] = []  # repository root == "" relative to the repo
            elif stmt.value is not None:
                env[name] = _join_parts(stmt.value, env)
                paths[name] = "/".join(p for p in env[name] if p)

        repo = REPOSITORIES.get(repo_key) if repo_key else None
        slug = None
        if repo and repo.url.startswith("https://github.com/"):
            slug = repo.url[len("https://github.com/") :].removesuffix(".git")

        out.append(
            Upstream(
                key=key,
                robot=desc.robot,
                maker=desc.maker,
                dof=desc.dof,
                tags=sorted(desc.tags),
                formats=sorted(f.name.lower() for f in desc.formats),
                license_spdx=desc.license_spdx,
                license_path=(
                    posixpath.join(paths.get("PACKAGE_PATH", ""), desc.license_file)
                    if desc.license_file
                    else None
                ),
                github=slug,
                commit=repo.commit if repo else None,
                package_path=paths.get("PACKAGE_PATH", ""),
                urdf_path=paths.get("URDF_PATH"),
                mjcf_path=paths.get("MJCF_PATH"),
                uses_xacro="xacro" in source.lower(),
            )
        )
    return out


# --------------------------------------------------------------------------- #
# cached HTTP
# --------------------------------------------------------------------------- #


class Http:
    """Tiny caching HTTP client: GET bodies on disk, HEAD results in a map."""

    def __init__(self, offline: bool = False) -> None:
        self.offline = offline
        self.head_path = CACHE / "head.json"
        self.body_dir = CACHE / "bodies"
        self.body_dir.mkdir(parents=True, exist_ok=True)
        self.heads: dict[str, list[int]] = {}
        if self.head_path.exists():
            self.heads = json.loads(self.head_path.read_text())
        self._dirty = 0

    def save(self) -> None:
        self.head_path.write_text(json.dumps(self.heads))
        self._dirty = 0

    # A HEAD answers one question: does this path exist at this commit? 200 and
    # 404 answer it for good; a 429, a 5xx or a timeout is the CDN having a
    # moment. Those are retried and never cached, because one cached flake makes
    # a mesh "unresolved" and silently drops the whole robot from the registry on
    # this run and every later one.
    CONCLUSIVE = (200, 404)

    def head(self, url: str, attempts: int = 3) -> tuple[int, int]:
        """Return ``(status, content_length)``; conclusive answers are cached."""
        if url in self.heads:
            status, size = self.heads[url]
            return status, size
        if self.offline:
            return 0, 0
        request = urllib.request.Request(url, method="HEAD", headers=UA)
        for attempt in range(attempts):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    result = (response.status, int(response.headers.get("Content-Length") or 0))
            except urllib.error.HTTPError as exc:
                result = (exc.code, 0)
            except Exception:  # noqa: BLE001 - network flake, treated as "unknown"
                result = (0, 0)
            if result[0] in self.CONCLUSIVE:
                break
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
        if result[0] not in self.CONCLUSIVE:
            return result
        self.heads[url] = list(result)
        self._dirty += 1
        if self._dirty >= 200:
            self.save()
        return result

    def get(self, url: str) -> bytes | None:
        cached = self.body_dir / (
            url.replace("https://", "").replace("/", "_").replace("@", "_at_")
        )
        if cached.exists():
            return cached.read_bytes()
        if self.offline:
            return None
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                data = r.read()
        except Exception:  # noqa: BLE001
            return None
        cached.write_bytes(data)
        return data


# --------------------------------------------------------------------------- #
# URDF inspection
# --------------------------------------------------------------------------- #


@dataclass
class UrdfFacts:
    """Everything we learn by reading the URDF and probing its meshes."""

    ok: bool
    error: str | None = None
    xml_name: str | None = None
    n_links: int = 0
    joint_counts: dict[str, int] = field(default_factory=dict)
    n_moving_joints: int = 0
    mass_kg: float | None = None
    mesh_formats: list[str] = field(default_factory=list)
    mesh_files: int = 0
    mesh_bytes: int = 0
    packages: dict[str, str] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)
    joint_names: list[str] = field(default_factory=list)
    urdf_bytes: int = 0
    has_collision: bool = False
    has_inertia: bool = False


def base_url(up: Upstream) -> str:
    return f"{CDN}/{up.github}@{up.commit}/"


def package_candidates(up: Upstream, package: str) -> list[str]:
    """Plausible repository roots for a ``package://<package>/`` reference.

    Most descriptions put the ROS package at ``PACKAGE_PATH``, but some URDFs
    reference sibling packages (a robot referring to its gripper, say), so we
    try the neighbourhood of the package directory before the repository root.
    """
    pkg_path = up.package_path
    parent = posixpath.dirname(pkg_path) if pkg_path else ""
    ordered = []
    if pkg_path and posixpath.basename(pkg_path) == package:
        ordered.append(pkg_path)
    ordered += [
        posixpath.join(parent, package) if parent else package,
        pkg_path,
        posixpath.join(pkg_path, package) if pkg_path else package,
        package,
        "",
        posixpath.join(parent, package, package) if parent else package,
    ]
    seen: list[str] = []
    for candidate in ordered:
        if candidate not in seen:
            seen.append(candidate)
    return seen


def inspect_urdf(up: Upstream, http: Http, verify_meshes: bool = True) -> UrdfFacts:
    """Download the URDF, parse it, and check that its meshes are reachable."""
    if not (up.github and up.commit and up.urdf_path):
        return UrdfFacts(ok=False, error="no urdf path")
    raw = http.get(base_url(up) + up.urdf_path)
    if raw is None:
        return UrdfFacts(ok=False, error="urdf fetch failed")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        return UrdfFacts(ok=False, error=f"urdf parse failed: {exc}")
    if root.tag != "robot":
        return UrdfFacts(ok=False, error=f"unexpected root <{root.tag}>")

    joint_counts: dict[str, int] = {}
    joint_names: list[str] = []
    for joint in root.iter("joint"):
        # <joint> also appears inside <transmission>; real joints have a parent.
        if joint.find("parent") is None:
            continue
        jtype = joint.get("type") or "unknown"
        joint_counts[jtype] = joint_counts.get(jtype, 0) + 1
        if joint.get("name"):
            joint_names.append(joint.get("name"))

    mass = 0.0
    for tag in root.iter("mass"):
        try:
            mass += float(tag.get("value", "0"))
        except ValueError:
            pass

    facts = UrdfFacts(
        ok=True,
        xml_name=root.get("name"),
        n_links=len(list(root.iter("link"))),
        joint_counts=dict(sorted(joint_counts.items())),
        n_moving_joints=sum(n for t, n in joint_counts.items() if t in MOVING_JOINTS),
        mass_kg=round(mass, 3) if mass > 0 else None,
        urdf_bytes=len(raw),
        has_collision=any(True for _ in root.iter("collision")),
        has_inertia=any(True for _ in root.iter("inertia")),
        joint_names=joint_names,
    )

    meshes = sorted({m.get("filename", "") for m in root.iter("mesh") if m.get("filename")})
    facts.mesh_formats = sorted({posixpath.splitext(m)[1].lower() for m in meshes if m})
    if not verify_meshes:
        facts.mesh_files = len(meshes)
        return facts

    urdf_dir = posixpath.dirname(up.urdf_path)
    for mesh in meshes:
        if mesh.startswith(("http://", "https://", "file://")):
            facts.missing.append(mesh)
            continue
        if mesh.startswith("package://"):
            package, _, rel = mesh[len("package://") :].partition("/")
            known = facts.packages.get(package)
            candidates = [known] if known is not None else package_candidates(up, package)
            hit = None
            for candidate in candidates:
                path = posixpath.normpath(posixpath.join(candidate, rel)).lstrip("/")
                status, size = http.head(base_url(up) + path)
                if status == 200:
                    hit = (candidate, size)
                    break
            if hit is None:
                facts.missing.append(mesh)
            else:
                facts.packages[package] = hit[0]
                facts.mesh_files += 1
                facts.mesh_bytes += hit[1]
        else:
            path = posixpath.normpath(posixpath.join(urdf_dir, mesh)).lstrip("/")
            status, size = http.head(base_url(up) + path)
            if status == 200:
                facts.mesh_files += 1
                facts.mesh_bytes += size
            else:
                facts.missing.append(mesh)
    return facts


# --------------------------------------------------------------------------- #
# registry assembly
# --------------------------------------------------------------------------- #


def curated_key(item: dict[str, Any]) -> str:
    """Label a curation entry for error messages and description lookups."""
    return item.get("description") or item.get("id") or "(unnamed entry)"


def curated_id(item: dict[str, Any]) -> str:
    """The gallery id a curation entry will end up with."""
    return item.get("id") or curated_key(item).removesuffix("_description")


def upstream_from_curation(item: dict[str, Any]) -> Upstream:
    """Build an ``Upstream`` from a hand-written ``upstream`` block.

    robot_descriptions.py is the metadata source for most of the registry, but
    it does not ship every model a repository has: unitree_ros, for one, carries
    a dozen robots it has no module for. Such an entry spells its upstream out
    in data/curation.json instead, and from here on is treated like any other —
    same URDF parsing, same mesh probing, same failure modes.
    """
    spec = item["upstream"]
    urdf_path = spec["urdf"]
    return Upstream(
        key=curated_id(item),
        robot=item.get("name") or curated_id(item),
        maker=item.get("maker"),
        dof=item.get("dof"),
        tags=sorted(spec.get("tags") or []),
        formats=sorted(spec.get("formats") or ["urdf"]),
        license_spdx=spec.get("license"),
        license_path=spec.get("license_file"),
        github=spec["github"],
        commit=spec["commit"],
        package_path=spec.get("package") or posixpath.dirname(urdf_path),
        urdf_path=urdf_path,
        mjcf_path=spec.get("mjcf"),
        uses_xacro=False,
        from_descriptions=False,
    )


def entry_for(
    up: Upstream,
    facts: UrdfFacts,
    curated: dict[str, Any],
    measured: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge upstream metadata, parsed URDF facts and curation into one entry."""
    dof = curated.get("dof") or up.dof or facts.n_moving_joints
    return {
        "id": curated.get("id") or up.key.removesuffix("_description"),
        "name": curated.get("name") or up.robot,
        "maker": curated.get("maker") or up.maker,
        "category": curated["category"],
        "tags": up.tags,
        "dof": dof,
        "license": up.license_spdx,
        "formats": up.formats,
        "notes": curated.get("notes"),
        "notes_zh": curated.get("notes_zh"),
        # Optional joint configuration for still frames and the initial view.
        "pose": curated.get("pose"),
        # Bounding box of the loaded visual meshes, measured by the thumbnail
        # renderer (data/measured.json). Only the geometry knows how big a robot
        # really is, and having it here means a card can show the size without
        # downloading the model.
        "measured": measured,
        "urdf": {
            "xml_name": facts.xml_name,
            "links": facts.n_links,
            "joints": facts.joint_counts,
            "moving_joints": facts.n_moving_joints,
            "mass_kg": facts.mass_kg,
            "has_collision": facts.has_collision,
            "has_inertia": facts.has_inertia,
            "bytes": facts.urdf_bytes,
        },
        "assets": {
            "base": base_url(up),
            "urdf": up.urdf_path,
            "packages": {k: v for k, v in sorted(facts.packages.items())},
            "mesh_files": facts.mesh_files,
            "mesh_bytes": facts.mesh_bytes,
            "mesh_formats": facts.mesh_formats,
        },
        "source": {
            # Only entries that come from robot_descriptions.py carry a key the
            # site can link to or load with; hand-written ones leave it null.
            "description": up.key if up.from_descriptions else None,
            "github": up.github,
            "commit": up.commit,
            "repo_url": f"https://github.com/{up.github}",
            "tree_url": f"https://github.com/{up.github}/tree/{up.commit}/{up.package_path}".rstrip("/"),
            "license_url": (
                f"https://github.com/{up.github}/blob/{up.commit}/{up.license_path}"
                if up.license_path
                else None
            ),
            "mjcf": up.mjcf_path,
        },
        "links": curated.get("links", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "data" / "robots.json"))
    parser.add_argument("--curation", default=str(ROOT / "data" / "curation.json"))
    parser.add_argument(
        "--candidates",
        action="store_true",
        help="inspect every non-xacro URDF description and write a report to "
        ".cache/candidates.json instead of building the registry",
    )
    parser.add_argument("--offline", action="store_true", help="use only cached HTTP results")
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args()

    try:
        import robot_descriptions
    except ImportError:
        print("robot_descriptions is required: pip install -r scripts/requirements.txt", file=sys.stderr)
        return 2
    descriptions_dir = Path(robot_descriptions.__file__).parent

    CACHE.mkdir(exist_ok=True)
    upstream = {u.key: u for u in read_upstream(descriptions_dir)}
    http = Http(offline=args.offline)
    print(f"robot_descriptions {robot_descriptions.__version__}: {len(upstream)} descriptions")

    if args.candidates:
        pool = [
            u
            for u in upstream.values()
            if u.urdf_path and not u.uses_xacro and u.github and u.commit
        ]
        print(f"inspecting {len(pool)} loadable URDF candidates ...")
        with ThreadPoolExecutor(args.jobs) as ex:
            results = list(ex.map(lambda u: (u, inspect_urdf(u, http)), pool))
        http.save()
        report = [
            {
                "key": u.key,
                "robot": u.robot,
                "maker": u.maker,
                "tags": u.tags,
                "dof": u.dof,
                "ok": f.ok and not f.missing,
                "error": f.error,
                "missing": f.missing[:3],
                "moving_joints": f.n_moving_joints,
                "links": f.n_links,
                "mass_kg": f.mass_kg,
                "mesh_bytes": f.mesh_bytes,
                "mesh_files": f.mesh_files,
                "mesh_formats": f.mesh_formats,
                "packages": f.packages,
                "github": u.github,
            }
            for u, f in results
        ]
        out = CACHE / "candidates.json"
        out.write_text(json.dumps(report, indent=1, ensure_ascii=False))
        good = [r for r in report if r["ok"]]
        print(f"loadable: {len(good)}/{len(report)} — report written to {out}")
        for r in report:
            if not r["ok"]:
                print(f"  skip {r['key']:36s} {r['error'] or r['missing']}")
        return 0

    curation = json.loads(Path(args.curation).read_text())
    measured_path = ROOT / "data" / "measured.json"
    measured = json.loads(measured_path.read_text()) if measured_path.exists() else {}
    entries: list[dict[str, Any]] = []
    problems: list[str] = []

    def build(item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
        key = curated_key(item)
        if item.get("upstream"):
            try:
                up = upstream_from_curation(item)
            except KeyError as exc:
                return item, None, f"{key}: upstream block is missing {exc}"
        else:
            up = upstream.get(key)
            if up is None:
                return item, None, f"{key}: not in robot_descriptions"
        facts = inspect_urdf(up, http)
        if not facts.ok:
            return item, None, f"{key}: {facts.error}"
        if facts.missing:
            return item, None, f"{key}: {len(facts.missing)} unresolved meshes, e.g. {facts.missing[0]}"
        # A curated pose that names a joint the URDF does not have is a typo
        # that would otherwise fail silently in the browser.
        unknown = sorted(set(item.get("pose") or ()) - set(facts.joint_names))
        if unknown:
            return item, None, f"{key}: pose names unknown joints {unknown}"
        return item, entry_for(up, facts, item, measured.get(curated_id(item))), None

    with ThreadPoolExecutor(args.jobs) as ex:
        for item, entry, problem in ex.map(build, curation["robots"]):
            if problem:
                problems.append(problem)
            if entry:
                entries.append(entry)
    http.save()

    order = {curated_id(item): i for i, item in enumerate(curation["robots"])}
    entries.sort(key=lambda e: order[e["id"]])

    registry = {
        "$schema": "./robots.schema.json",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": f"robot_descriptions {robot_descriptions.__version__}",
        "categories": curation["categories"],
        "robots": entries,
    }
    Path(args.out).write_text(json.dumps(registry, indent=1, ensure_ascii=False) + "\n")

    total = sum(e["assets"]["mesh_bytes"] for e in entries)
    print(f"wrote {args.out}: {len(entries)} robots, {total / 1e6:.0f} MB of upstream meshes")
    for problem in problems:
        print(f"  PROBLEM {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
