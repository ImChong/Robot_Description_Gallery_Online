# Robot URDF Gallery · 机器人 URDF 合集

[![Verify registry](https://github.com/ImChong/Robot_URDF_Gallery/actions/workflows/verify.yml/badge.svg)](https://github.com/ImChong/Robot_URDF_Gallery/actions/workflows/verify.yml)
[![Deploy to GitHub Pages](https://github.com/ImChong/Robot_URDF_Gallery/actions/workflows/pages.yml/badge.svg)](https://github.com/ImChong/Robot_URDF_Gallery/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个可浏览、可交互的机器人模型合集：人形、四足、机械臂、灵巧手等 **70 个**开源机器人
描述文件，直接在浏览器里加载、拖关节、看碰撞体和惯量。灵感来自
[All Hands Up](https://allhandsup.org/)，但对象从机械手扩展到所有常见机器人。

**核心原则：本仓库不托管任何模型文件。** 每个条目只记录上游仓库 + 固定 commit，
URDF 与网格在访问时从 jsDelivr 的 GitHub CDN 直接流式加载。上游怎么写的，你看到的
就是什么——没有二次转换、没有过期副本。

```
robot_descriptions.py  ──┐
（186 个描述的元数据）     │
                         ├─▶  scripts/build_registry.py  ──▶  data/robots.json
上游 GitHub 仓库 @commit ─┘    · 静态解析描述模块（不 clone）      （70 个条目）
（URDF + 网格，经 CDN）         · 只下载 URDF，解析关节/连杆/质量
                                · 逐个 HEAD 校验每个 package:// 网格
                                          │
                                          ▼
                       web/  三 .js + urdf-loader 的静态站点（无构建步骤）
                       · 合集网格（离线渲染的缩略图）
                       · 详情页：关节滑块 / 碰撞体 / 关节轴 / 坐标系 / 质心 / 惯量
                       · 一键下载：URDF 单文件，或 URDF + 全部网格的 zip
```

界面配色沿用 [imchong.github.io](https://imchong.github.io/) 的设计语言：Notion 风格
的暖灰、8px 圆角、胶囊标签，深色为默认并可切换浅色（`data-theme`，与那边共用
`cl-theme` / `cl-lang` 两个 localStorage 键名）。3D 区域在两种主题下都保持深色影棚——
这里近一半机器人是白色的，放在白底上就看不见了。

## 目前收录

| 类别 | 数量 | 代表机器人 |
| --- | --- | --- |
| 人形 Humanoid | 21 | G1、H1、H1-2、GR-1、N1、Elf2、Booster T1、TALOS、Valkyrie、Atlas、iCub、ergoCub、ToddlerBot |
| 四足 Quadruped | 12 | Go2、B2、A1、Aliengo、ANYmal B/C/D、HyQ、Solo、WL P311 |
| 机械臂 Arm | 16 | Panda、iiwa 14、Kinova Gen2、PiPER、SO-ARM100/101、OpenMANIPULATOR、OMY 系列 |
| 灵巧手 / 夹爪 Hand | 6 | LEAP Hand、Allegro Hand、Ability Hand、Robotiq 2F-85、BarrettHand |
| 双足 Biped | 4 | Cassie、Bolt、Upkie、Rhea |
| 双臂 Dual arm | 5 | YuMi、Baxter、PR2、NEXTAGE、Poppy Torso |
| 移动操作 Mobile | 6 | Stretch RE1、TIAGo、Pepper、RBY1、Ginger、BamBot |

计划中的第一版目标是人形 + 四足 + 机械臂 + 灵巧手四类；由于流水线对每个候选模型都做
了自动校验，另外三类（双足 / 双臂 / 移动操作）也一并纳入，没有额外维护成本。

## 快速开始

```bash
npm install          # three + urdf-loader + playwright（仅开发用）
npm run vendor       # 把浏览器依赖复制到 web/vendor/（已提交，一般无需重跑）
npm run dev          # http://localhost:8080/web/
```

站点是纯静态 ES module，没有打包步骤：`web/` 目录直接就是可发布的产物。

### 重新生成注册表

```bash
pip install -r scripts/requirements.txt
npm run registry                                  # 生成 data/robots.json
python3 scripts/build_registry.py --candidates    # 列出所有可加载的候选模型
```

`--candidates` 会遍历 `robot_descriptions.py` 里全部非 xacro 的 URDF 描述，报告哪些
模型的网格能完整解析（当前 87 个候选中 80 个通过），是挑选新条目的依据。

### 缩略图与冒烟测试

```bash
npm run dev &
npm run thumbs                 # 无头 Chromium 渲染 web/thumbs/<id>.webp
npm run smoke -- --all         # 逐个打开 70 个模型，断言真的渲染出了几何体
```

两个脚本都跑在真实的 WebGL 上下文里，用的是详情页同一份 `viewer.js`。冒烟测试专门盯
两类静默失败：URDF 加载成功但网格 404（场景空的），以及网格加载了却量不出尺寸（变换
被 NaN 污染）——上游改动路径时它会先于访客发现问题。

`npm run thumbs` 还会把每个模型的包围盒尺寸写进 `data/measured.json`，再由
`npm run registry` 合并进注册表，所以卡片和参数表里的"模型高度"来自网格本身，而不是
手抄的产品参数。因此完整的更新顺序是 **thumbs → registry**。

### 一键下载

详情页有两个下载按钮，都在浏览器里完成，没有后端：

- **URDF + 网格（zip）**——URDF 原文加它引用的全部网格，文件按上游仓库里的相对路径
  存放，因此把包目录放进 ROS package path 后 `package://` 仍然能解析；附带的
  `NOTICE.txt` 记录来源仓库、commit、许可与包路径映射。
- **仅 URDF**——只有那一个 `.urdf` 文件，与上游逐字节一致。

zip 是手写的（store 方式 + CRC-32），所以专门有一个检查脚本把产物解包验证：

```bash
npm run check:downloads              # 每种网格格式组合各取一个最小模型
npm run check:downloads -- --all     # 全部 70 个
```

它会用系统 `unzip -t` 校验每个条目的 CRC、比对条目数与注册表记录的网格数，并确认
包内 URDF 与上游逐字节相同。

## 部署到 GitHub Pages

线上地址：<https://imchong.github.io/Robot_URDF_Gallery/>

站点没有构建步骤，两种 Pages 模式都能直接用：

- **GitHub Actions（推荐）**：`.github/workflows/pages.yml` 会在 push 到 `main` 时把
  `index.html` + `web/` + `data/` 打包发布，发布前先跑一遍注册表校验（含缩略图完整性）。
  在 Settings → Pages 里把 Source 选成 **GitHub Actions** 即可。想在合并前预览，可以在
  Actions 页面对任意分支手动触发这个 workflow。
- **Deploy from a branch**：直接选分支 + `/ (root)` 也能用，仓库根目录的 `index.html`
  会跳转到 `./web/`，`.nojekyll` 用来关掉 Jekyll 处理。

根目录的 `index.html` 只是一个跳转页，所以 `/` 和 `/web/` 都能打开。

## 新增一个机器人

1. 在 `robot_descriptions.py` 里找到它的描述键（如 `g1_description`），
   用 `--candidates` 确认网格可解析；
2. 在 `data/curation.json` 的 `robots` 数组里加一条，至少填 `description` 和
   `category`，可选 `name` / `maker` / `dof` / `notes` / `notes_zh` / `links`；
   如果零位姿态不像个能站住的机器人（四足腿伸直、机械臂笔直朝天、Cassie 整个躺平），
   再加一个 `pose`（关节名 → 弧度/米），卡片和详情页都会用它作为初始姿态；
   关节名会在生成注册表时对着 URDF 校验，写错直接报错；
3. `npm run registry && npm run thumbs -- --robot <id> && npm run registry`
   （第二次 `registry` 是为了把刚测出的尺寸并进注册表），最后
   `npm run smoke -- --robot <id>` 确认真的渲染出来了。

`data/curation.json` 是唯一需要手写的文件；其余全部由流水线生成。

## 仓库结构

```
data/curation.json     手写：收录哪些机器人、归到哪一类、官方链接
data/robots.json       生成：完整注册表（站点唯一的数据来源）
data/measured.json     生成：各模型的包围盒尺寸
scripts/build_registry.py   注册表生成与上游校验
scripts/render_thumbnails.mjs / smoke.mjs / check_downloads.mjs
scripts/check_registry.mjs / serve.mjs / vendor.mjs / browser.mjs
web/js/viewer.js       three.js 场景 + URDF 加载 + 各种可视化叠加层
web/js/download.js     一键下载：手写 zip（store + CRC-32）与 NOTICE 生成
web/js/theme-init.js   首屏前应用主题，避免闪一下深色
web/js/gallery.js      卡片网格、类别筛选、搜索
web/js/detail.js       详情页：参数表、关节滑块、资源链接、代码片段
web/js/registry.js     注册表加载与筛选
web/js/i18n.js         中英文界面文案
web/vendor/            已提交的 three.js 与 urdf-loader（无构建步骤）
```

## 注册表字段

`data/robots.json` 中每个条目的关键字段：

| 字段 | 含义 |
| --- | --- |
| `urdf.joints` / `moving_joints` / `links` | 由 URDF 解析得到的关节类型分布与连杆数 |
| `urdf.mass_kg` | 所有连杆质量之和（上游数据，个别模型存在明显笔误，界面按原值显示） |
| `assets.base` | CDN 前缀，含固定 commit |
| `assets.packages` | `package://<名>` → 仓库内目录的映射，逐个 HEAD 校验过 |
| `assets.mesh_bytes` / `mesh_files` | 网格文件的原始体积与个数（CDN 启用压缩后实际传输更小，因此该数值仅供参考，CI 不把它的变化当成失败） |
| `measured.height_m` / `measured.size` | 由渲染器实测的可视网格包围盒（米） |
| `pose` | 可选：卡片渲染与初始视图使用的关节角（关节名会在构建时校验） |
| `source.commit` | `robot_descriptions.py` 固定的上游 commit（少数仓库为 release tag） |

## 已知限制

- **xacro 模型暂不支持。** UR 系列、Shadow Hand、Fetch 等在上游只提供 xacro，需要
  在构建阶段展开后才能进合集（见 Roadmap）。
- 少量上游模型的网格缺失或路径含空格（Go1、iiwa7、mini cheetah、Reachy 等），
  `--candidates` 会把它们标为不可加载。
- 个别模型的 `mass_kg` 明显是上游笔误（例如 BarrettHand 的 264 t）。界面照实显示，
  不做静默修正。

## Roadmap

- 构建阶段展开 xacro，补上 UR / Shadow Hand / Fetch 等常用模型
- MJCF 直接查看（目前只提供 MuJoCo 的下载与代码片段）
- 并排对比两个机器人（尺寸、DOF、质量）
- 上游漂移的定时校验（CI 已就绪，见 `.github/workflows/verify.yml`）

## 致谢与许可

- 元数据来自 [robot_descriptions.py](https://github.com/robot-descriptions/robot_descriptions.py)
  与 [awesome-robot-descriptions](https://github.com/robot-descriptions/awesome-robot-descriptions)
- 3D 加载基于 [three.js](https://threejs.org/) 与
  [urdf-loader](https://github.com/gkjohnson/urdf-loaders)
- 资源经 [jsDelivr](https://www.jsdelivr.com/) 的 GitHub CDN 分发

本仓库的代码使用 MIT 许可（见 `LICENSE`）。**每个机器人模型仍适用其上游自己的许可**
（详情页与注册表都标注了 SPDX 标识与许可文件链接），其中部分为非商业许可，使用前请
自行核对。

---

## English

A browsable 3D gallery of 70 open robot descriptions — humanoids, quadrupeds, arms,
hands — that loads URDFs in the browser, lets you drag joints, and overlays collision
geometry, joint axes, link frames, centres of mass and inertia boxes.

**No model files are hosted here.** Each entry records its upstream repository and the
commit `robot_descriptions.py` pins; the URDF and its meshes stream from jsDelivr's
GitHub CDN at that commit. `scripts/build_registry.py` generates `data/robots.json` by
static-parsing the description modules, downloading only the URDF, and verifying every
`package://` mesh reference with a HEAD request — a broken entry fails the build rather
than the visitor. `data/curation.json` is the only hand-written file.

Each robot can be downloaded in one click, in the browser: the `.urdf` on its own, or a
zip holding the URDF plus every mesh it references at their upstream repository paths
(so `package://` still resolves) with a NOTICE.txt recording the source commit and
licence. Colours follow [imchong.github.io](https://imchong.github.io/) — Notion-ish warm
neutrals, dark by default with a light theme — while the 3D areas stay a dark studio in
both themes, since half of these robots are white.

```bash
npm install && npm run vendor && npm run dev   # → http://localhost:8080/web/
pip install -r scripts/requirements.txt && npm run registry
npm run thumbs && npm run registry             # card images + measured sizes
npm run smoke -- --all && npm run check:downloads
```

Code is MIT; every robot model keeps its own upstream licence, some of which are
non-commercial — check before use.
