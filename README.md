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
                       · 合集网格：按人形 / 四足 / 机械臂…… 分区，标签一点即跳转
                       · 详情页：关节滑块（含限位/速度/力矩）/ 碰撞体 / 关节轴 /
                         坐标系 / 质心 / 惯量
                       · 一键下载：URDF 单文件、URDF + 全部网格的 zip，
                         或可直接 colcon 编译的 ROS 2 功能包
```

列表页按类别分区排列——人形、四足、机械臂、灵巧手、双足、双臂、移动操作，顺序与注册表
一致，每区一个标题和数量。顶部那排类别标签因此不再是筛选器而是跳转导航：点一下滚到对应
分区，读到哪一区就亮到哪一区，地址栏同步为 `#category=quadruped`，分享出去便是一个直达
该分区的链接。搜索仍然是筛选，它在各分区内部生效，并把一个都没命中的分区整块收起。窄屏
上标签条收成一行横向滚动，当前分区的标签会自动滚进视野。

界面配色沿用 [imchong.github.io](https://imchong.github.io/) 的设计语言：Notion 风格
的暖灰、8px 圆角、胶囊标签，深色为默认并可切换浅色（`data-theme`，与那边共用
`cl-theme` / `cl-lang` 两个 localStorage 键名）。详情页的 3D 预览跟着一起切换：背景、
地面网格、灯光、默认材质灰以及碰撞体 / 关节轴 / 质心 / 惯量这些叠加层的配色都各有一
套——浅色影棚下默认材质要更深、轮廓光要收住，否则白色机器人就贴在白底上没影了。切换
是就地重打灯，姿态、视角和已加载的网格都不动。列表页的卡片底色则始终保持深色影棚：
缩略图是离线按深色渲染好的图片，换成浅底会糊成一片。

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

### 决定显示哪些机器人

`data/visibility.md` 是一份带勾选框的清单，注册表里的每个条目一行，写着名称、所属组织
和上游链接：

```markdown
- [x] `g1` **G1** — UNITREE Robotics — [unitreerobotics/unitree_ros · g1_description](…)
- [ ] `h1` **H1** — UNITREE Robotics — [unitreerobotics/unitree_ros · h1_description](…)
```

站点启动时会读这个文件：**`[x]` 的显示，`[ ]` 的不显示。** 想下架一个模型就把方括号里的
`x` 删掉，提交即可——不需要重新生成注册表，也不用改 `data/robots.json`。被隐藏的条目不会
出现在网格、分类计数、搜索结果和详情页的上一个/下一个里，直接访问 `#robot=<id>` 会跳回
合集首页；首页的四个计数也跟着变。

反引号里的 `id` 是站点匹配用的，其余部分只是给人看的。文件读不到时（例如没部署）显示
全部条目，注册表里有、清单里还没有的机器人同样默认显示——两种情况都是宁可多显示，不会
把合集变成空的。

```bash
npm run visibility         # 从 data/robots.json 刷新清单，保留已有勾选状态
npm run check:visibility   # 校验清单是否与注册表同步（CI 会跑）
```

缩略图对全部条目渲染（`thumb.html` 不走这个过滤），所以重新勾上一个机器人不需要重跑
`npm run thumbs`。

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

### 关节限位

详情页的每个关节滑块下面都列出该关节在 URDF 里声明的限制：行程
（`<limit lower/upper>`）、速度上限（`velocity`）与力矩上限（`effort`）。
`continuous` 关节标注为「连续旋转」，带 `<mimic>` 的关节额外显示它跟随哪个关节、
倍率与偏置。

这些数值 urdf-loader 并不提供（它只读 `lower`/`upper`），所以详情页会另外取一次
URDF 原文解析——请求与网格加载并行发出，走的是浏览器缓存里刚下过的那份文件。
数值一律照上游原样显示，包括 `effort="0"` 这种上游没填的情况。没有声明 `<limit>`
的关节不会被卡在 0——滑块退回一个可用行程（转动 ±π，移动 ±0.5 m），否则它根本推不动。

转动关节的读数与行程可以在「关节」面板标题栏的 `deg` / `rad` 开关之间切换，鼠标
悬停在行程上还能看到另一个单位的数值；选择记在 `localStorage` 里（`cl-angle-unit`，
与主题、语言同样处理），换机器人、刷新页面都保留。滑块内部一直是弧度——URDF 声明的
就是弧度，视图也按弧度驱动——切换单位只是换一种写法，不会动到当前姿态，只有方向键
的步进跟着走：角度模式一格 0.1°，弧度模式一格 0.001 rad。移动关节（`prismatic`）
不受影响，始终以米显示；模型若没有转动关节，这个开关不会出现。

### 一键下载

详情页有三个下载按钮，都在浏览器里完成，没有后端：

- **URDF + 网格（zip）**——URDF 原文加它引用的全部网格，文件按上游仓库里的相对路径
  存放，因此把包目录放进 ROS package path 后 `package://` 仍然能解析；附带的
  `NOTICE.txt` 记录来源仓库、commit、许可与包路径映射。
- **ROS 2 功能包（zip）**——同样的内容，外面套上一个能直接 `colcon build` 的
  `ament_cmake` 包（见下）。
- **仅 URDF**——只有那一个 `.urdf` 文件，与上游逐字节一致。

zip 是手写的（store 方式 + CRC-32），所以专门有一个检查脚本把产物解包验证：

```bash
npm run check:downloads              # 每种网格格式组合各取一个最小模型
npm run check:downloads -- --all     # 全部 70 个
```

它会用系统 `unzip -t` 校验每个条目的 CRC、比对条目数与注册表记录的网格数、确认
包内 URDF 与上游逐字节相同，并对 ROS 2 包额外检查：该有的文件都在、launch 文件能被
Python 解析、每个重写过的 `package://` 引用都指向包内真实存在的文件、URDF 相对上游
只有网格路径这一处差异。

### ROS 2 功能包

「ROS 2 功能包」按钮生成的 zip 解压出来就是一个包目录 `<id>_description/`：

```
<id>_description/
├── package.xml              ament_cmake，依赖 robot_state_publisher /
│                            joint_state_publisher_gui / rviz2 / xacro
├── CMakeLists.txt           安装包内实际存在的目录与文件
├── launch/display.launch.py robot_state_publisher + 关节滑块 + RViz 2
├── rviz/display.rviz        RobotModel 绑到 /robot_description，fixed frame
│                            取根连杆，相机按实测高度拉开
├── <上游路径>/xxx.urdf        上游原文，只改了网格路径
├── meshes/…                 全部网格，保持上游的相对布局
└── README.md / NOTICE.txt   构建运行说明（中英）与来源、commit、许可
```

```bash
mkdir -p ~/ros2_ws/src && cp -r <id>_description ~/ros2_ws/src/
cd ~/ros2_ws && colcon build --packages-select <id>_description
source install/setup.bash
ros2 launch <id>_description display.launch.py            # 滑块 + RViz
ros2 launch <id>_description display.launch.py gui:=false # 无滑块窗口
ros2 launch <id>_description display.launch.py rviz:=false
```

拖动 `joint_state_publisher_gui` 的滑块，RViz 里的模型就跟着动——和网页上的关节滑块
是同一件事，只是换到了本地 ROS 2 环境里。面向 Humble 及以上。

URDF 相对上游只有一处改动：网格的 `filename` 属性重写成
`package://<id>_description/…`，这样只装这一个包就能解析。包内文件保持上游的相对
布局（同时被剥掉了 URDF 与全部网格共同的目录前缀），所以原本的相对路径引用也仍然
有效——直接用别的工具打开那个 `.urdf` 同样能加载。

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

新条目默认就是显示的；跑一次 `npm run visibility` 把它写进 `data/visibility.md`，
之后就能随时勾掉。

手写的文件只有两个：`data/curation.json`（收录什么）和 `data/visibility.md` 里的勾选框
（显示什么）；其余全部由流水线生成。

## 仓库结构

```
data/curation.json     手写：收录哪些机器人、归到哪一类、官方链接
data/visibility.md     手写勾选框：哪些条目显示在站点上（行内容由脚本生成）
data/robots.json       生成：完整注册表（站点唯一的数据来源）
data/measured.json     生成：各模型的包围盒尺寸
scripts/build_registry.py   注册表生成与上游校验
scripts/build_visibility.mjs  由注册表刷新 data/visibility.md
scripts/render_thumbnails.mjs / smoke.mjs / check_downloads.mjs
scripts/check_registry.mjs / serve.mjs / vendor.mjs / browser.mjs
web/js/viewer.js       three.js 场景 + URDF 加载 + 各种可视化叠加层
web/js/download.js     一键下载：手写 zip（store + CRC-32）、ROS 2 包与 NOTICE 生成
web/js/theme-init.js   首屏前应用主题，避免闪一下深色
web/js/theme.js        主题状态与切换事件（3D 舞台据此重新打灯）
web/js/gallery.js      卡片网格（按类别分区）、标签跳转与滚动高亮、搜索
web/js/detail.js       详情页：参数表、关节滑块与限位、资源链接、代码片段
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

The gallery is laid out in one section per category — humanoids, quadrupeds, arms, hands
and the rest, in registry order — so the chips above the grid are navigation rather than a
filter: clicking one scrolls to that section, the chip for the section being read lights
up as you scroll, and the address bar follows it (`#category=quadruped` is a link straight
into that band of the page). Search still filters, inside the sections, and folds away any
section it leaves empty.

**No model files are hosted here.** Each entry records its upstream repository and the
commit `robot_descriptions.py` pins; the URDF and its meshes stream from jsDelivr's
GitHub CDN at that commit. `scripts/build_registry.py` generates `data/robots.json` by
static-parsing the description modules, downloading only the URDF, and verifying every
`package://` mesh reference with a HEAD request — a broken entry fails the build rather
than the visitor. `data/curation.json` is the only hand-written file — apart from the
checkboxes in `data/visibility.md`, a generated list of every entry (name, organisation,
upstream link) whose `[x]`/`[ ]` boxes decide what the gallery shows. The site reads it at
startup, so hiding a robot is a one-character edit and a commit; a missing file or an
unlisted id shows the robot rather than dropping it.

Each robot can be downloaded in one click, in the browser: the `.urdf` on its own, a zip
holding the URDF plus every mesh it references at their upstream repository paths (so
`package://` still resolves) with a NOTICE.txt recording the source commit and licence,
or a ready-to-build ROS 2 package — `package.xml`, `CMakeLists.txt`, an RViz config and a
`display.launch.py` that starts `robot_state_publisher`, the `joint_state_publisher_gui`
slider window and RViz 2, with the URDF's mesh references rewritten to resolve from that
package alone:

```bash
colcon build --packages-select <id>_description && source install/setup.bash
ros2 launch <id>_description display.launch.py
```

Every joint slider on the detail page also carries the limits its URDF declares — travel,
velocity and effort — read from the raw XML, since urdf-loader only exposes
`lower`/`upper`. A `deg` / `rad` switch in the panel header re-labels the rotational
readouts and travel in either unit, and is remembered across robots and reloads; the
sliders themselves stay in radians, so switching never moves the robot.

Colours follow [imchong.github.io](https://imchong.github.io/) — Notion-ish warm
neutrals, dark by default with a light theme. The detail page's 3D preview switches with
it: backdrop, floor grid, lighting, the default material grey and every overlay colour
have a palette per theme, because the neon cyan and green that carry a dark stage go
pastel on a bright one, and a pale robot needs a darker default grey to keep its edges.
The switch relights the scene in place — pose, camera and loaded meshes all stay put.
Gallery cards keep the dark studio in both themes: their thumbnails are rendered offline
against the dark palette, and half of these robots are white.

```bash
npm install && npm run vendor && npm run dev   # → http://localhost:8080/web/
pip install -r scripts/requirements.txt && npm run registry
npm run thumbs && npm run registry             # card images + measured sizes
npm run visibility                             # refresh data/visibility.md
npm run smoke -- --all && npm run check:downloads
```

Code is MIT; every robot model keeps its own upstream licence, some of which are
non-commercial — check before use.
