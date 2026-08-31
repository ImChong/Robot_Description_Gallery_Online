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
     probing the CDN — or, where the URDF names a path the repository does not
     have, by the roots and rewrites the entry spells out — so a broken entry
     fails the build instead of the browser
  5. merge the hand-curated bits from ``data/curation.json``

A few models exist nowhere the four steps above can reach: their maker never
published a description repository, or published only xacro, and the one public
copy of the URDF is an archive that re-hosts it. Such an entry carries a
``mirror`` block instead of an ``upstream`` one and is read from that host. Three
things differ, and all three are the mirror's doing rather than a choice:

  * there is no commit to pin, so ``source.commit`` is null and the entry says
    which host it came from instead;
  * an archive served as a single-page app answers a path it does not have with
    200 and an HTML page, so a mirrored file's existence is decided by its
    content type, not its status code (see ``Http.probe``);
  * an archive keeps the meshes it renders and drops the rest, so a mirrored
    entry may reference meshes that are not there. Those are skipped rather than
    failing the build, recorded in ``assets.skip_meshes`` so the viewer and the
    download writers skip them too, and subtracted from what the entry claims:
    a model whose collision meshes are all absent reports no collision geometry
    rather than an empty collision view.

Usage::

    pip install -r scripts/requirements.txt
    python3 scripts/build_registry.py                 # curated entries
    python3 scripts/build_registry.py --candidates    # report on everything

HTTP responses are cached under ``.cache/`` so re-runs are cheap.
"""

from __future__ import annotations

import argparse
import ast
import html
import json
import os
import posixpath
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
MENAGERIE = ROOT / "data" / "menagerie.json"
CDN = "https://cdn.jsdelivr.net/gh"
UA = {"User-Agent": "robot-urdf-gallery-online-build"}
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
class Mirror:
    """An archive that re-hosts a URDF its maker never published loadably.

    Not a repository: there is no commit, no tree to browse and no licence file
    to link to, only a base URL and whatever the host says about provenance.
    """

    host: str
    site: str
    base: str
    license_url: str | None = None


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
    # Set for the handful of entries read from a re-hosting archive rather than
    # from a repository at a pinned commit.
    mirror: Mirror | None = None
    # Package roots spelled out in the curation. A repository's roots are found
    # by probing, which works because the paths are the ones the URDF was
    # written against; an archive rearranges them, so it has to be told.
    packages: dict[str, str] | None = None
    # Substring substitutions applied to a resolved mesh path, for an archive
    # that flattened the tree the URDF still refers to.
    mesh_rewrite: list[tuple[str, str]] = field(default_factory=list)


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


def request_url(url: str) -> str:
    """Percent-encode a URL for urllib, which refuses a raw space in a path.

    Only characters that cannot appear unencoded are touched, so every URL the
    repository entries produce comes out of here unchanged; it is the mirrored
    paths, one of which has a directory called ``XHAND1_URDF_ver 1.3``, that
    need it.
    """
    scheme, _, rest = url.partition("://")
    host, _, path = rest.partition("/")
    return f"{scheme}://{host}/{urllib.parse.quote(path, safe='/@:,+&=~$!*();?#[]')}"


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
        return self._ask(url, self._head_once, attempts)

    def probe(self, url: str, attempts: int = 3) -> tuple[int, int]:
        """Same question as :meth:`head`, for a host where a 200 means nothing.

        A single-page app serves its shell for every path it does not
        recognise, so a missing mesh comes back 200 with ``text/html`` and a
        HEAD-and-check-the-status probe declares every mesh present. What tells
        the two apart is the content type. HEAD is no use either — the CDN in
        front of the archive omits Content-Length on a HEAD and reports it on a
        GET — so this opens a GET and never reads the body.
        """
        return self._ask(url, self._probe_once, attempts)

    def _ask(self, url: str, once, attempts: int) -> tuple[int, int]:
        if url in self.heads:
            status, size = self.heads[url]
            return status, size
        if self.offline:
            return 0, 0
        for attempt in range(attempts):
            result = once(url)
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

    @staticmethod
    def _head_once(url: str) -> tuple[int, int]:
        request = urllib.request.Request(request_url(url), method="HEAD", headers=UA)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, int(response.headers.get("Content-Length") or 0)
        except urllib.error.HTTPError as exc:
            return exc.code, 0
        except Exception:  # noqa: BLE001 - network flake, treated as "unknown"
            return 0, 0

    @staticmethod
    def _probe_once(url: str) -> tuple[int, int]:
        request = urllib.request.Request(request_url(url), headers=UA)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                ctype = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if ctype == "text/html":
                    return 404, 0
                return response.status, int(response.headers.get("Content-Length") or 0)
        except urllib.error.HTTPError as exc:
            return exc.code, 0
        except Exception:  # noqa: BLE001
            return 0, 0

    def get(self, url: str) -> bytes | None:
        cached = self.body_dir / (
            url.replace("https://", "").replace("/", "_").replace("@", "_at_").replace(" ", "_")
        )
        if cached.exists():
            return cached.read_bytes()
        if self.offline:
            return None
        try:
            with urllib.request.urlopen(
                urllib.request.Request(request_url(url), headers=UA), timeout=120
            ) as r:
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                data = r.read()
        except Exception:  # noqa: BLE001
            return None
        # Same single-page-app trap as `probe`: a URDF path the archive does not
        # have answers with its shell, and an HTML page parses as neither URDF
        # nor error unless it is refused here.
        if ctype == "text/html" and not url.endswith((".html", ".md")):
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
    link_names: list[str] = field(default_factory=list)
    urdf_bytes: int = 0
    has_collision: bool = False
    has_inertia: bool = False
    # Meshes the URDF references that the host does not have. Only a mirror can
    # end up with any: a repository that is missing one is a broken entry, and
    # they land in `missing` above, which fails the build.
    skipped: list[str] = field(default_factory=list)
    # The same meshes as host-relative paths, which is the form the viewer and
    # the download writers see and can therefore skip.
    skip_paths: list[str] = field(default_factory=list)


def base_url(up: Upstream) -> str:
    if up.mirror:
        return up.mirror.base
    return f"{CDN}/{up.github}@{up.commit}/"


def rewrite_mesh_path(path: str, rules: list[tuple[str, str]]) -> str:
    for old, new in rules:
        path = path.replace(old, new)
    return path


def mesh_rewrite_rules(*blocks: dict[str, Any]) -> list[tuple[str, str]]:
    """Concatenated ``mesh_rewrite`` lists from one or more curation blocks.

    The entry's ``upstream`` (or ``mirror``) block holds the rules every version
    shares; a version may add more of its own — a different directory than the
    ``package://`` lines still name, or a stand-in for one mesh the CDN will not
    serve. The two lists are applied in that order, the same way a single list
    is.
    """
    rules: list[tuple[str, str]] = []
    for block in blocks:
        for rule in block.get("mesh_rewrite") or []:
            rules.append((rule["from"], rule["to"]))
    return rules


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
    if not up.urdf_path or not (up.mirror or (up.github and up.commit)):
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

    # Which geometry a link owns decides what the entry may claim to have: a
    # <collision> whose mesh the host dropped is not collision geometry the
    # viewer can show.
    collision_meshes: set[str] = set()
    collision_primitives = False
    for collision in root.iter("collision"):
        for geometry in collision.iter("geometry"):
            mesh = geometry.find("mesh")
            if mesh is not None and mesh.get("filename"):
                collision_meshes.add(mesh.get("filename"))
            elif len(list(geometry)):
                collision_primitives = True

    facts = UrdfFacts(
        ok=True,
        xml_name=root.get("name"),
        n_links=len(list(root.iter("link"))),
        joint_counts=dict(sorted(joint_counts.items())),
        n_moving_joints=sum(n for t, n in joint_counts.items() if t in MOVING_JOINTS),
        mass_kg=round(mass, 3) if mass > 0 else None,
        urdf_bytes=len(raw),
        has_collision=bool(collision_meshes) or collision_primitives,
        has_inertia=any(True for _ in root.iter("inertia")),
        joint_names=joint_names,
        link_names=[link.get("name") for link in root.iter("link") if link.get("name")],
    )

    meshes = sorted({m.get("filename", "") for m in root.iter("mesh") if m.get("filename")})
    facts.mesh_formats = sorted({posixpath.splitext(m)[1].lower() for m in meshes if m})
    if not verify_meshes:
        facts.mesh_files = len(meshes)
        return facts

    # A repository has to have every mesh its URDF names; a mirror is an archive
    # of someone else's files and keeps only what it renders, so what it does
    # not have is skipped instead of failing the entry.
    tolerate_missing = up.mirror is not None
    exists = http.probe if up.mirror else http.head
    urdf_dir = posixpath.dirname(up.urdf_path)

    def resolve(candidate: str, rel: str) -> tuple[str, int, int]:
        path = posixpath.normpath(posixpath.join(candidate, rel)).lstrip("/")
        path = rewrite_mesh_path(path, up.mesh_rewrite)
        status, size = exists(base_url(up) + path)
        return path, status, size

    kept: list[str] = []
    for mesh in meshes:
        if mesh.startswith(("http://", "https://", "file://")):
            facts.missing.append(mesh)
            continue
        if mesh.startswith("package://"):
            package, _, rel = mesh[len("package://") :].partition("/")
            known = facts.packages.get(package) or (up.packages or {}).get(package)
            candidates = [known] if known is not None else package_candidates(up, package)
            hit = None
            for candidate in candidates:
                path, status, size = resolve(candidate, rel)
                if status == 200:
                    hit = (candidate, path, size)
                    break
            if hit is None:
                (facts.skipped if tolerate_missing else facts.missing).append(mesh)
                if tolerate_missing:
                    # Record the path it would have had, so the browser skips the
                    # same request rather than parsing the fallback page.
                    facts.skip_paths.append(resolve(known if known is not None else "", rel)[0])
                continue
            facts.packages[package] = hit[0]
            facts.mesh_files += 1
            facts.mesh_bytes += hit[2]
            kept.append(mesh)
        else:
            path, status, size = resolve(urdf_dir, mesh)
            if status == 200:
                facts.mesh_files += 1
                facts.mesh_bytes += size
                kept.append(mesh)
            else:
                (facts.skipped if tolerate_missing else facts.missing).append(mesh)
                if tolerate_missing:
                    facts.skip_paths.append(path)

    if facts.skipped:
        # What the entry claims is what survived: the formats still referenced,
        # and collision geometry only if some of it is still there.
        facts.mesh_formats = sorted({posixpath.splitext(m)[1].lower() for m in kept if m})
        facts.has_collision = collision_primitives or any(
            m in collision_meshes for m in kept
        )
        facts.skipped.sort()
        facts.skip_paths = sorted(set(facts.skip_paths))
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


AXIS_LETTERS = ("+x", "-x", "+y", "-y", "+z", "-z")


def loops_problem(loops: Any, facts: UrdfFacts) -> str | None:
    """Reject a closed-loop declaration the viewer could not act on.

    A loop names links and joints that must exist and be spelled the way the
    URDF spells them: a typo here is invisible in the browser, since the viewer
    can only skip a loop it cannot resolve and the legs then come apart exactly
    as they did before anyone wrote the loop down.
    """
    if loops is None:
        return None
    if not isinstance(loops, list) or not loops:
        return f"loops must be a non-empty list, got {loops!r}"
    for i, loop in enumerate(loops):
        where = f"loops[{i}]"
        if not isinstance(loop, dict):
            return f"{where} must be an object, got {loop!r}"
        connect = loop.get("connect")
        if not isinstance(connect, list) or len(connect) != 2:
            return f"{where}.connect must name exactly two points, got {connect!r}"
        for end in connect:
            if not isinstance(end, dict) or end.get("link") not in facts.link_names:
                return f"{where}.connect names unknown link {end!r}"
            point = end.get("point")
            if not isinstance(point, list) or len(point) != 3:
                return f"{where}.connect point must be [x, y, z], got {point!r}"
            if any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in point):
                return f"{where}.connect point must be three numbers, got {point!r}"
        solve = loop.get("solve")
        if not isinstance(solve, list) or not solve:
            return f"{where}.solve must name at least one joint, got {solve!r}"
        unknown = sorted(set(solve) - set(facts.joint_names))
        if unknown:
            return f"{where}.solve names unknown joints {unknown}"
    return None


def preview_frame_problem(frame: Any) -> str | None:
    """Reject a ``preview_frame`` the viewer could not turn into a rotation.

    The two named axes have to be real axes of the model's own frame and lie on
    different lines: two axes on the same line span a plane rather than a frame,
    and the cross product that completes it would come out zero.
    """
    if frame is None:
        return None
    if not isinstance(frame, dict) or set(frame) != {"palm", "fingers"}:
        return f"preview_frame needs exactly a palm and a fingers axis, got {frame!r}"
    bad = [f"{k}={v!r}" for k, v in frame.items() if v not in AXIS_LETTERS]
    if bad:
        return f"preview_frame has non-axis {', '.join(bad)} (expected one of {', '.join(AXIS_LETTERS)})"
    if frame["palm"][1] == frame["fingers"][1]:
        return f"preview_frame palm and fingers are the same axis ({frame['palm']}, {frame['fingers']})"
    return None


def variant_name(spec: dict[str, Any]) -> str:
    """What the version picker on the detail page shows for one version.

    The upstream file's own name, because that is what the repository, the
    README's ``mode_machine`` table and everyone's checkout call it — and
    because a file name is the same in both of the site's languages.
    """
    return spec.get("name") or posixpath.basename(spec["urdf"]).removesuffix(".urdf")


def variant_id(spec: dict[str, Any]) -> str:
    """The slug a version is addressed by, in ``#robot=<id>&v=<variant>``."""
    return spec.get("id") or variant_name(spec).lower()


def variant_for(
    spec: dict[str, Any],
    up: Upstream,
    facts: UrdfFacts,
    measured: dict[str, Any] | None,
) -> dict[str, Any]:
    """One version of a model, shaped like the entry it lives in.

    Same keys, same meanings — ``urdf`` is what the file says, ``assets`` is
    where the file and its meshes are — so the viewer, the spec table and the
    three download writers can be handed a version without being taught what a
    version is. ``assets.base`` is not repeated: every version of a model is
    read from the one repository at the one pinned commit.
    """
    return {
        "id": variant_id(spec),
        "name": variant_name(spec),
        # Upstream keeps superseded files around for the machines still running
        # them, so a version can be listed and discouraged at the same time.
        "deprecated": bool(spec.get("deprecated")),
        "dof": spec.get("dof") or facts.n_moving_joints,
        "formats": sorted({"urdf", *(["mjcf"] if up.mjcf_path else [])}),
        "notes": spec.get("notes"),
        "notes_zh": spec.get("notes_zh"),
        "measured": measured,
        "mjcf": up.mjcf_path,
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
        "assets": asset_block(up, facts),
    }


def upstream_from_curation(item: dict[str, Any]) -> Upstream:
    """Build an ``Upstream`` from a hand-written ``upstream`` block.

    robot_descriptions.py is the metadata source for most of the registry, but
    it does not ship every model a repository has: unitree_ros, for one, carries
    a dozen robots it has no module for. Such an entry spells its upstream out
    in data/curation.json instead, and from here on is treated like any other —
    same URDF parsing, same mesh probing, same failure modes.
    """
    spec = item["upstream"]
    # A machine with several upstream URDFs lists them all in `variants`, and
    # the first one is what its card and its detail page open on — so the entry
    # need not name that file a second time here.
    first = (item.get("variants") or [{}])[0]
    urdf_path = spec.get("urdf") or first["urdf"]
    if spec.get("package") is not None:
        package_path = spec["package"]
    elif first.get("package") is not None:
        package_path = first["package"]
    else:
        package_path = posixpath.dirname(urdf_path)
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
        # An explicit empty string means the repository root is the package —
        # true of every repository that ships exactly one description. Only an
        # absent key falls back to the directory holding the URDF.
        package_path=package_path,
        urdf_path=urdf_path,
        mjcf_path=spec["mjcf"] if "mjcf" in spec else first.get("mjcf"),
        uses_xacro=False,
        from_descriptions=False,
        # Probing finds the package root for almost every repository, but a URDF
        # can name a path its own tree does not have: a package the repository
        # keeps somewhere the neighbourhood search does not reach, a directory
        # renamed without the `package://` lines following it, or a relative
        # mesh path written for a working directory other than the URDF's own.
        # Then the entry says where the files really are, the same way a mirror
        # does — see mirror_from_curation.
        packages=spec.get("packages") or {},
        mesh_rewrite=mesh_rewrite_rules(spec, first),
    )


def mirror_from_curation(item: dict[str, Any]) -> Upstream:
    """Build an ``Upstream`` from a hand-written ``mirror`` block.

    For a model whose maker published no repository the gallery can load — none
    at all, or xacro only — and whose one public copy lives in an archive. The
    entry names the host, the base URL and the package roots the archive
    rearranged the meshes into, because there is nothing to probe them out of.
    """
    spec = item["mirror"]
    first = (item.get("variants") or [{}])[0]
    urdf_path = spec.get("urdf") or first["urdf"]
    if spec.get("package") is not None:
        package_path = spec["package"]
    elif first.get("package") is not None:
        package_path = first["package"]
    else:
        package_path = posixpath.dirname(urdf_path)
    return Upstream(
        key=curated_id(item),
        robot=item.get("name") or curated_id(item),
        maker=item.get("maker"),
        dof=item.get("dof"),
        tags=sorted(spec.get("tags") or []),
        formats=sorted(spec.get("formats") or ["urdf"]),
        license_spdx=spec.get("license"),
        license_path=None,
        github=None,
        commit=None,
        package_path=package_path,
        urdf_path=urdf_path,
        mjcf_path=spec.get("mjcf") or first.get("mjcf"),
        uses_xacro=False,
        from_descriptions=False,
        mirror=Mirror(
            host=spec["host"],
            site=spec["site"],
            base=spec["base"] if spec["base"].endswith("/") else spec["base"] + "/",
            license_url=spec.get("license_url"),
        ),
        packages=spec.get("packages") or {},
        mesh_rewrite=mesh_rewrite_rules(spec, first),
    )


def asset_block(up: Upstream, facts: UrdfFacts) -> dict[str, Any]:
    """Where an entry's files are, and which of them to leave alone.

    ``skip_meshes`` and ``mesh_rewrite`` are only written when they have
    something in them, so the hundred-odd entries read from a repository at a
    pinned commit carry neither.
    """
    block: dict[str, Any] = {
        "urdf": up.urdf_path,
        "packages": {k: v for k, v in sorted(facts.packages.items())},
        "mesh_files": facts.mesh_files,
        "mesh_bytes": facts.mesh_bytes,
        "mesh_formats": facts.mesh_formats,
    }
    if up.mesh_rewrite:
        block["mesh_rewrite"] = [{"from": old, "to": new} for old, new in up.mesh_rewrite]
    if facts.skip_paths:
        block["skip_meshes"] = facts.skip_paths
    return block


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
        # Optional closed kinematic loops, which URDF cannot state: pairs of
        # points that are really one point, and the joints the viewer solves so
        # they stay one. See the note at the top of data/curation.json.
        "loops": curated.get("loops"),
        # Optional pair of model axes that lets the viewer stand every hand up
        # the same way — palm towards world +X, fingers along world +Z.
        "preview_frame": curated.get("preview_frame"),
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
        "assets": {"base": base_url(up), **asset_block(up, facts)},
        "source": {
            # Only entries that come from robot_descriptions.py carry a key the
            # site can link to or load with; hand-written ones leave it null.
            "description": up.key if up.from_descriptions else None,
            # A mirrored entry has no repository and no commit. Everything that
            # would be derived from them is null, and `mirror` says where the
            # files actually came from instead.
            "github": up.github,
            "commit": up.commit,
            "repo_url": f"https://github.com/{up.github}" if up.github else None,
            "tree_url": (
                f"https://github.com/{up.github}/tree/{up.commit}/{up.package_path}".rstrip("/")
                if up.github
                else None
            ),
            "license_url": (
                f"https://github.com/{up.github}/blob/{up.commit}/{up.license_path}"
                if up.github and up.license_path
                else up.mirror.license_url
                if up.mirror
                else None
            ),
            "mirror": (
                {"host": up.mirror.host, "site": up.mirror.site} if up.mirror else None
            ),
            "mjcf": up.mjcf_path,
        },
        "links": curated.get("links", {}),
    }


# --------------------------------------------------------------------------- #
# MJCF-only collection
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# MJCF inspection
# --------------------------------------------------------------------------- #


@dataclass
class MjcfFacts:
    """What reading an MJCF document and probing its assets tells us.

    Deliberately the same shape as :class:`UrdfFacts` where the two answer the
    same question, because the gallery shows one spec table for both.
    """

    ok: bool
    error: str | None = None
    xml_name: str | None = None
    # The file the gallery renders, which is not always the file the entry
    # points at; see :func:`mjcf_model_path`.
    model_path: str = ""
    n_bodies: int = 0
    joint_counts: dict[str, int] = field(default_factory=dict)
    n_moving_joints: int = 0
    mass_kg: float | None = None
    mesh_formats: list[str] = field(default_factory=list)
    mesh_files: int = 0
    mesh_bytes: int = 0
    model_bytes: int = 0
    has_collision: bool = False
    has_inertia: bool = False
    # Assets the document names that the repository does not have. A pinned
    # Menagerie commit should never produce any, so these fail the build.
    missing: list[str] = field(default_factory=list)
    # Assets the repository has and the CDN will not serve: jsDelivr refuses any
    # single file over 20 MB, and four Menagerie models carry one visual mesh
    # past it. Recorded so the viewer and the download writers skip the same
    # files rather than requesting a page that says "File size exceeded".
    skipped: list[str] = field(default_factory=list)


# One MJCF joint is worth this many sliders in the viewer: a hinge or a slide is
# one, a ball joint is re-parameterised as three hinges, and a free base is
# pinned exactly as a URDF root link is and gets none. See web/js/mjcf.js.
MJCF_JOINT_DOF = {"hinge": 1, "slide": 1, "ball": 3, "free": 0}


def mjcf_join(*parts: str) -> str:
    """Join and normalise a repository-relative MJCF path."""
    joined = posixpath.join(*[part for part in parts if part])
    return posixpath.normpath(joined).lstrip("./")


# Where a spliced-in section came from, stamped on it during include expansion.
# MuJoCo writes the same thing onto the ``<include>`` element it leaves behind,
# and for the same reason: see :func:`mjcf_asset_candidates`.
MJCF_SOURCE_DIR = "mjcf-source-dir"


def read_mjcf(base: str, path: str, http: Http, depth: int = 0) -> ET.Element | None:
    """One MJCF document with every ``<include>`` spliced in where it stood.

    MuJoCo resolves an include against the file that wrote it while resolving
    asset directories against the main model file, so the caller keeps the two
    apart: paths returned by this function are repository-relative, and the
    asset directories are joined onto the model file's own directory. Each
    spliced section is stamped with the directory it came out of, which is the
    other half of the answer for an asset path.
    """
    if depth > 8:
        return None
    raw = http.get(base + path)
    if raw is None:
        return None
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return None
    if root.tag != "mujoco":
        return None
    here = posixpath.dirname(path)
    # Materialised before splicing: an `<include>` inside a `<body>` brings a
    # limb, so the children go where the include stood rather than at the top of
    # the document, and the nodes inserted here have no includes left to find.
    for parent in list(root.iter()):
        for index, child in reversed(list(enumerate(parent))):
            if child.tag != "include":
                continue
            parent.remove(child)
            target = child.get("file")
            if not target:
                continue
            at = mjcf_join(here, target)
            included = read_mjcf(base, at, http, depth + 1)
            if included is None:
                continue
            source = posixpath.dirname(at)
            for offset, node in enumerate(list(included)):
                # Only where a deeper include has not already answered: the
                # stamp names the file that wrote the section.
                node.attrib.setdefault(MJCF_SOURCE_DIR, source)
                parent.insert(index + offset, node)
    return root


def mjcf_asset_candidates(
    root: ET.Element, node: ET.Element, model_dir: str, base_dir: str, file: str
) -> list[str]:
    """Where one asset file might be, in the order MuJoCo looks for it.

    The documented rule is the main model file's directory plus ``meshdir`` plus
    the name, but MuJoCo falls back to resolving the name against the directory
    of the included file that declared it, and descriptions rely on it:
    MS-Human-700 writes ``../geometry/sacrum.stl`` from a file two directories
    down, which read against the model's own folder names nothing at all.
    """
    primary = mjcf_join(base_dir, file)
    source = model_dir
    # ElementTree has no parent pointers, so the enclosing stamp is found by
    # walking down from the root to this node once.
    stack = [(root, model_dir)]
    while stack:
        element, inherited = stack.pop()
        here = element.get(MJCF_SOURCE_DIR, inherited)
        if element is node:
            source = here
            break
        stack.extend((child, here) for child in element)
    fallback = mjcf_join(source, file)
    return [primary] if fallback == primary else [primary, fallback]


def mjcf_model_path(base: str, scene_path: str, http: Http) -> str:
    """Which file of a Menagerie directory is the robot.

    A ``scene.xml`` is a robot plus a room: it brings in the description and adds
    a ground plane, a light, a skybox and — for Aloha — the table the arms are
    bolted to. MuJoCo Live is meant to open the room, and the gallery is not: it
    brings its own studio, and a table inside the model's bounding box would be
    measured as part of the robot and cropped into its card.

    A scene reaches its robot one of two ways, and both are read here: the older
    ``<include>``, and MuJoCo 3's ``<asset><model file=…>`` with an ``<attach>``
    in the worldbody. Where exactly one file arrives either way, that file is the
    model. A self-contained scene is its own model, and web/js/mjcf.js drops the
    ground plane and the lights on the way in.
    """
    raw = http.get(base + scene_path)
    if raw is None:
        return scene_path
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return scene_path
    files = [node.get("file") for node in root.iter("include") if node.get("file")]
    if not files:
        files = [
            node.get("file")
            for block in root.iter("asset")
            for node in block
            if node.tag == "model" and node.get("file")
        ]
    if len(files) != 1:
        return scene_path
    return mjcf_join(posixpath.dirname(scene_path), files[0])


def inspect_mjcf(base: str, scene_path: str, http: Http) -> MjcfFacts:
    """Read an MJCF model and check that every mesh and texture it names is there."""
    model_path = mjcf_model_path(base, scene_path, http)
    root = read_mjcf(base, model_path, http)
    if root is None:
        return MjcfFacts(ok=False, error=f"mjcf read failed: {model_path}")

    compiler: dict[str, str] = {}
    for block in root.iter("compiler"):
        compiler.update(block.attrib)
    model_dir = posixpath.dirname(model_path)
    asset_dir = compiler.get("assetdir", "")
    mesh_dir = mjcf_join(model_dir, compiler.get("meshdir", asset_dir))
    texture_dir = mjcf_join(model_dir, compiler.get("texturedir", asset_dir))

    # Only `<asset>` children: `<mesh>` also appears inside `<default>`, where it
    # carries a scale for a class rather than a file of its own.
    assets: list[tuple[str, list[str]]] = []
    for block in root.iter("asset"):
        for node in block:
            if node.tag == "mesh" and node.get("file"):
                where = mesh_dir
            elif node.tag == "texture" and node.get("file") and node.get("type") != "skybox":
                where = texture_dir
            else:
                continue
            assets.append(
                (node.tag, mjcf_asset_candidates(root, node, model_dir, where, node.get("file")))
            )

    joint_counts: dict[str, int] = {}
    for body in root.iter("body"):
        for node in body:
            if node.tag == "freejoint":
                joint_counts["free"] = joint_counts.get("free", 0) + 1
            elif node.tag == "joint":
                jtype = node.get("type") or "hinge"
                joint_counts[jtype] = joint_counts.get(jtype, 0) + 1

    mass = 0.0
    has_inertia = False
    for inertial in root.iter("inertial"):
        has_inertia = True
        try:
            mass += float(inertial.get("mass", "0"))
        except ValueError:
            pass

    # Group numbers are labels rather than a fixed visual/collision threshold:
    # Menagerie commonly uses 2/3, while MS-Human-700 uses 0/1 for its bone
    # meshes and capsule contact shapes. The browser picks the primary visual
    # group from the effective body geoms; this build-time bit only needs to say
    # whether the document declares more than one group at all. Asked of both
    # body geoms and defaults so an inherited group still counts.
    def group_of(node: ET.Element) -> int:
        try:
            return int(node.get("group") or 0)
        except ValueError:
            return 0

    has_collision = len({group_of(geom) for geom in root.iter("geom")}) > 1

    facts = MjcfFacts(
        ok=True,
        xml_name=root.get("model"),
        model_path=model_path,
        # MuJoCo counts the world as body 0, and so does this: it is the frame
        # the description hangs off, exactly as a URDF's root link is.
        n_bodies=len(list(root.iter("body"))) + 1,
        joint_counts=dict(sorted(joint_counts.items())),
        n_moving_joints=sum(
            n * MJCF_JOINT_DOF.get(jtype, 1) for jtype, n in joint_counts.items()
        ),
        mass_kg=round(mass, 3) if mass > 0 else None,
        model_bytes=len(http.get(base + model_path) or b""),
        has_collision=has_collision,
        has_inertia=has_inertia,
    )

    def resolve(candidates: list[str]) -> tuple[str, int, int]:
        """The first candidate the CDN answers for, its size, and its status.

        A 403 is jsDelivr's way of saying the file is there and over its 20 MB
        per-file limit, which is a different problem from a path that names
        nothing: the first is a mesh to skip, the second a broken entry.
        """
        refused = ""
        for candidate in candidates:
            status, size = http.head(base + candidate, attempts=5)
            if status == 200:
                return candidate, size, 200
            if status == 403 and not refused:
                refused = candidate
        return (refused, 0, 403) if refused else ("", 0, 404)

    seen: set[str] = set()
    formats: set[str] = set()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(resolve, [candidates for _, candidates in assets]))
    for (kind, candidates), (path, size, status) in zip(assets, results):
        if status == 403:
            facts.skipped.append(path)
            continue
        if status != 200:
            facts.missing.append(candidates[0])
            continue
        if path in seen:
            continue
        seen.add(path)
        facts.mesh_files += 1
        facts.mesh_bytes += size
        # A texture is an asset the download has to carry but not a mesh format:
        # the spec row reads "48 × stl", and a .png in that list says nothing.
        if kind == "mesh":
            formats.add(posixpath.splitext(path)[1].lower())
    facts.mesh_formats = sorted(formats)
    facts.skipped.sort()
    return facts


MENAGERIE_ROW = re.compile(
    r"^\| <a href='(?P<live>[^']+)'[^>]*><img src='(?P<thumb>[^']+)'[^>]*></a> "
    r"\| (?P<name>[^|]+?) \| (?P<dof>\d+) \| "
    r"\[(?P<license>[^]]+)\]\((?P<license_path>[^)]+)\) \|$"
)
MENAGERIE_SECTION = re.compile(r"^\*\*(?P<name>.+)\.\*\*$")
MENAGERIE_MODEL = re.compile(r"/main/(?P<directory>[^/]+)/(?P<scene>[^?]+)$")


def add_menagerie(
    entries: list[dict[str, Any]], http: Http, config_path: Path = MENAGERIE
) -> list[str]:
    """Merge the pinned MuJoCo Menagerie manifest into the gallery.

    A model already represented by a URDF is not another card: its existing
    entry gains a pinned Menagerie scene and a link to MuJoCo Live. A model that
    has no URDF card becomes a card of its own, rendered on the gallery's stage
    from its MuJoCo XML the same way a URDF is — so its assets are read and
    probed here exactly as a URDF's meshes are. Menagerie's own README is the
    source of names, DoFs, licences, scene paths and preview images;
    ``data/menagerie.json`` only owns the gallery-specific deduplication,
    category and maker decisions.
    """
    if not config_path.exists():
        return []
    config = json.loads(config_path.read_text())
    github = config["github"]
    commit = config["commit"]
    base = f"{CDN}/{github}@{commit}/"
    raw = http.get(base + config.get("readme", "README.md"))
    if raw is None:
        return ["MuJoCo Menagerie: README fetch failed"]

    section: str | None = None
    models: list[dict[str, Any]] = []
    for line in raw.decode("utf-8").splitlines():
        heading = MENAGERIE_SECTION.match(line)
        if heading:
            section = heading.group("name")
            continue
        row = MENAGERIE_ROW.match(line)
        if not row:
            continue
        live_match = MENAGERIE_MODEL.search(row.group("live"))
        if not live_match:
            continue
        models.append(
            {
                **row.groupdict(),
                **live_match.groupdict(),
                "section": section,
                "name": html.unescape(row.group("name").strip()),
                "dof": int(row.group("dof")),
            }
        )

    problems: list[str] = []
    by_id = {entry["id"]: entry for entry in entries}
    merge_into = config.get("merge_into") or {}
    id_overrides = config.get("id_overrides") or {}
    makers = config.get("maker_by_directory") or {}
    categories = config.get("section_categories") or {}
    seen_keys: set[str] = set()

    for model in models:
        key = f"{model['directory']}/{model['scene']}"
        seen_keys.add(key)
        category = categories.get(model["section"])
        if not category:
            problems.append(f"MuJoCo Menagerie · {key}: unknown section {model['section']!r}")
            continue
        scene_path = key
        thumb_path = model["thumb"]
        scene_status, _ = http.head(base + scene_path)
        thumb_status, _ = http.head(base + thumb_path)
        if scene_status != 200:
            problems.append(f"MuJoCo Menagerie · {key}: scene returned HTTP {scene_status}")
            continue
        if thumb_status != 200:
            problems.append(f"MuJoCo Menagerie · {key}: thumbnail returned HTTP {thumb_status}")
            continue

        live = model["live"].replace(f"github:{github}/main/", f"github:{github}/{commit}/")
        external = {
            "github": github,
            "commit": commit,
            "path": scene_path,
            "url": base + scene_path,
            "live_url": live,
            "tree_url": f"https://github.com/{github}/tree/{commit}/{model['directory']}",
        }
        target_id = merge_into.get(key)
        if target_id:
            target = by_id.get(target_id)
            if target is None:
                problems.append(f"MuJoCo Menagerie · {key}: merge target {target_id!r} is missing")
                continue
            target["formats"] = sorted({*target.get("formats", []), "mjcf"})
            target["source"]["mjcf_external"] = external
            target.setdefault("links", {})["menagerie"] = external["tree_url"]
            continue

        robot_id = id_overrides.get(key) or model["directory"]
        if robot_id in by_id:
            problems.append(f"MuJoCo Menagerie · {key}: id {robot_id!r} duplicates a URDF card")
            continue
        facts = inspect_mjcf(base, scene_path, http)
        if not facts.ok:
            problems.append(f"MuJoCo Menagerie · {key}: {facts.error}")
            continue
        if facts.missing:
            problems.append(
                f"MuJoCo Menagerie · {key}: {len(facts.missing)} asset(s) missing at this commit "
                f"({', '.join(facts.missing[:3])})"
            )
            continue
        license_path = model["license_path"]
        entry = {
            "id": robot_id,
            "name": model["name"],
            "maker": makers.get(model["directory"]) or "MuJoCo Menagerie contributors",
            "category": category,
            "tags": ["mjcf"],
            "dof": model["dof"],
            "license": model["license"],
            "formats": ["mjcf"],
            "notes": "MJCF-only model from MuJoCo Menagerie, rendered here from its MuJoCo XML. The detail page links to the pinned scene in MuJoCo Live.",
            "notes_zh": "来自 MuJoCo Menagerie 的纯 MJCF 模型，直接由 MuJoCo XML 在站内渲染；详情页可跳转到 MuJoCo Live 打开固定版本的场景。",
            "measured": None,
            "mjcf": {
                "xml_name": facts.xml_name,
                "links": facts.n_bodies,
                "joints": facts.joint_counts,
                "moving_joints": facts.n_moving_joints,
                "mass_kg": facts.mass_kg,
                "has_collision": facts.has_collision,
                "has_inertia": facts.has_inertia,
                # What the single-file download hands over, which is the scene;
                # the file the stage renders is usually a different one.
                "bytes": len(http.get(base + scene_path) or b""),
                "model_bytes": facts.model_bytes,
            },
            "assets": {
                "base": base,
                # The scene is what MuJoCo Live opens and what the download
                # button hands over; the model is the file the stage renders.
                "mjcf": scene_path,
                "mjcf_model": facts.model_path,
                "packages": {},
                "mesh_files": facts.mesh_files,
                "mesh_bytes": facts.mesh_bytes,
                "mesh_formats": facts.mesh_formats,
                **({"skip_meshes": facts.skipped} if facts.skipped else {}),
                # Menagerie's own preview image, kept as a fallback for a card
                # whose thumbnail has not been rendered yet.
                "upstream_thumbnail": base + thumb_path,
            },
            "source": {
                "description": None,
                "github": github,
                "commit": commit,
                "repo_url": f"https://github.com/{github}",
                "tree_url": external["tree_url"],
                "license_url": base + license_path,
                "mirror": None,
                "mjcf": scene_path,
                "mjcf_external": external,
            },
            "links": {"menagerie": external["tree_url"]},
        }
        entries.append(entry)
        by_id[robot_id] = entry

    stale = sorted((set(merge_into) | set(id_overrides)) - seen_keys)
    for key in stale:
        problems.append(f"MuJoCo Menagerie: configured key {key!r} is not in the pinned README")
    print(
        f"MuJoCo Menagerie {commit[:10]}: {len(models)} models, "
        f"{sum(1 for key in seen_keys if key in merge_into)} merged with URDF cards, "
        f"{sum(1 for entry in entries if entry['formats'] == ['mjcf'])} MJCF-only"
    )
    return problems


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
        if item.get("upstream") and item.get("mirror"):
            return item, None, f"{key}: has both an upstream and a mirror block"
        if item.get("mirror"):
            try:
                up = mirror_from_curation(item)
            except KeyError as exc:
                return item, None, f"{key}: mirror block is missing {exc}"
        elif item.get("upstream"):
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
        problem = preview_frame_problem(item.get("preview_frame"))
        if problem:
            return item, None, f"{key}: {problem}"
        problem = loops_problem(item.get("loops"), facts)
        if problem:
            return item, None, f"{key}: {problem}"
        entry = entry_for(up, facts, item, measured.get(curated_id(item)))

        # One machine, several upstream URDFs — the G1 ships twenty-two of them
        # — is one card with a version picker on its detail page, not twenty-two
        # cards. Every version is parsed and mesh-probed exactly like the entry's
        # own file, so a version whose meshes moved fails the build too.
        specs = item.get("variants") or []
        seen: set[str] = set()
        variants = []
        for spec in specs:
            vid = variant_id(spec)
            if vid in seen:
                return item, None, f"{key}: two versions both called {vid}"
            seen.add(vid)
            # Upstream may keep each configuration of a machine in a package of
            # its own — TRON2 ships sixteen, one per leg and arm combination,
            # every one of them naming the same `bipedal_robot` package — so a
            # version can say which directory its own `package://` lines mean.
            vup = replace(
                up,
                urdf_path=spec["urdf"],
                mjcf_path=spec.get("mjcf"),
                package_path=spec["package"] if "package" in spec else up.package_path,
                # Shared rules from the entry, then this version's own — the
                # default version's extras are already on `up`, so this matches
                # it and the already-read check below reuses that parse.
                mesh_rewrite=mesh_rewrite_rules(
                    item.get("upstream") or item.get("mirror") or {}, spec
                ),
            )
            # The default version has already been read; the rest are new files.
            # Same file read against another package root is another reading.
            already_read = (
                vup.urdf_path == up.urdf_path
                and vup.package_path == up.package_path
                and vup.mesh_rewrite == up.mesh_rewrite
            )
            vfacts = facts if already_read else inspect_urdf(vup, http)
            if not vfacts.ok:
                return item, None, f"{key} · {vid}: {vfacts.error}"
            if vfacts.missing:
                return item, None, (
                    f"{key} · {vid}: {len(vfacts.missing)} unresolved meshes, "
                    f"e.g. {vfacts.missing[0]}"
                )
            variants.append(variant_for(spec, vup, vfacts, measured.get(vid)))
        if variants:
            entry["variants"] = variants
            # The card stands for the machine rather than for one of its files,
            # so it says MJCF when any version of it has one.
            entry["formats"] = sorted({f for v in variants for f in v["formats"]})
        return item, entry, None

    with ThreadPoolExecutor(args.jobs) as ex:
        for item, entry, problem in ex.map(build, curation["robots"]):
            if problem:
                problems.append(problem)
            if entry:
                entries.append(entry)
    http.save()

    order = {curated_id(item): i for i, item in enumerate(curation["robots"])}
    entries.sort(key=lambda e: order[e["id"]])
    problems.extend(add_menagerie(entries, http))
    http.save()

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
    mirrored = [e for e in entries if e["source"]["mirror"]]
    if mirrored:
        print(f"  {len(mirrored)} entries read from a mirror rather than a pinned commit:")
        for entry in mirrored:
            skipped = len(entry["assets"].get("skip_meshes") or [])
            note = f", {skipped} mesh(es) the host does not have — skipped" if skipped else ""
            if skipped and not entry["urdf"]["has_collision"]:
                note += ", no collision geometry left"
            print(f"    {entry['id']:22s} {entry['source']['mirror']['host']}{note}")
    for problem in problems:
        print(f"  PROBLEM {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
