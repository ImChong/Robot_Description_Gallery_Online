# Robot Description Gallery Online · 机器人3D模型在线合集

[![Pages](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/pages.yml/badge.svg)](https://imchong.github.io/Robot_URDF_Gallery_Online/)
[![Verify](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/verify.yml/badge.svg)](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

收录 **192 个**开源机器人描述：154 个 URDF 可在站内拖关节、查看碰撞体与惯量，并下载
URDF、网格 zip 或 ROS 2 功能包；纯 MJCF 条目使用 MuJoCo Live 在线预览。

在线访问：<https://imchong.github.io/Robot_Description_Gallery_Online/web/>

人形 54 · 四足 24 · 机械臂 36 · 灵巧手 / 夹爪 29 · 移动操作 19 · 双臂 12 · 双足 11
生物力学 3 · 无人机 2 · 移动底盘 1 · 传感器 1

## 功能

- **浏览**：按类别分区，同一类别内再按厂商分组；支持搜索机器人、厂商与类别。
- **查看**：关节滑块、碰撞体、关节轴、惯量。全屏里的关节浮窗默认占画面宽度的三分之一，
  可以拖边框调整；点「演示」就按运动链顺序逐个把关节滑到上下限再放回原位，每个约
  1 秒。上游把一台机器发布成多个 URDF 时（G1 有 21 个）仍然只占一张卡，详情页顶部用
  版本选择器切换。URDF 写不出闭环，所以 Minitaur 的五连杆腿在别的工具里一动就散架；
  这里照 MJCF `<equality><connect>` 的写法在 `data/curation.json` 里补一条点约束，
  拖电机时用它反解两个膝关节，腿始终是合拢的。
- **横向对比**（`#compare=1`）：同一类别下选 2~6 台机器并排读整机、分肢与逐关节数据（含对应连杆质量），
  关节按部位或按运动链顺序对齐。只下载 `.urdf`，不下载网格；表格可复制为 Markdown 或
  CSV，地址可分享。
- **预览我自己的模型**：本地 URDF、xacro、MuJoCo `.xml` 或 USD（`.usda`、`.usdc`、`.usdz`）
  用同一个查看器打开，也能当成对比里的一列。**文件只在浏览器里解析，不会上传** ——
  本站是纯静态页面，没有可以接收文件的后端。
- **下载**：`.urdf`、URDF + 网格 zip、ROS 2 功能包。
- **MJCF**：读取固定 commit 的 MuJoCo Menagerie 清单；已有 URDF 的 25 台合并到原卡片，
  其余 38 台以 MJCF-only 卡片展示，点击后在 MuJoCo Live 打开固定版本的场景。Shadow Hand
  另提供右手、左手和两套 Plus 共 4 个 URDF/MJCF 版本。

**本仓库不托管任何模型文件。** 绝大多数条目只记录上游仓库 + 固定 commit，访问时从
jsDelivr 的 GitHub CDN 流式加载；少数厂商从未公开可加载模型的机型，条目改为记录转载
它的存档站（这类条目没有可固定的 commit，也可能缺少部分网格）。

## 本地运行

```bash
npm install   # 仅脚本需要；浏览器依赖已提交在 web/vendor/
npm run dev   # http://localhost:8080/web/
```

纯静态 ES module，没有构建步骤：`web/` 就是可发布的产物。push 到 `main` 后由
`.github/workflows/pages.yml` 发布到 GitHub Pages。

## 数据

手写的只有三个文件：`data/curation.json`（URDF 收录）、`data/menagerie.json`（MJCF 清单的
固定版本、分类与去重映射）和 `data/visibility.md`（`[x]` 显示、`[ ]` 隐藏）。其余由脚本生成。

```bash
pip install -r scripts/requirements.txt
npm run registry                     # 生成 data/robots.json
npm run thumbs && npm run registry   # 缩略图 + 实测尺寸（顺序不能反）
npm run visibility                   # 刷新 data/visibility.md
npm run check:visibility             # 校验 visibility 与 robots.json 一致
npm run smoke -- --all               # 冒烟测试
npm run check:downloads              # 校验下载包
npm run check:compare                # 校验对比页
npm run check:custom-local           # 校验本地 URDF/xacro/MJCF/USD 预览
npm run check:custom                 # 校验 GitHub 链接加载
npm run check:custom-url             # 校验自定义 URL 路由
```

新增 URDF：在 `data/curation.json` 的 `robots` 里加一条并写上 `category`，然后跑
`registry → thumbs → registry`。`npm run candidates` 可以列出所有可加载的候选模型。
更新 Menagerie 时修改 `data/menagerie.json` 的固定 commit，并同步去重映射。

## 已知限制

- 暂不支持只提供 xacro 的模型（如 Fetch）；自己上传时请先
  `xacro robot.urdf.xacro > robot.urdf`。厂商只发布 xacro、但有第三方公开了展开后的
  URDF 时收录后者——UR 三台走的就是 example-robot-data 这条路。
- 网格是 Y-up 的 glTF（`obj2gltf` 的默认输出）时每个连杆都会摆错方向，这类模型同样
  暂不收录，Drake 的双臂 iiwa 就是。
- jsDelivr 单文件上限 20 MB，个别含超大网格的模型无法收录（Go1、B1、B2-W）。PM01 Edu
  的躯干 Collada 超过该上限，卡片改用仓库里同名的 OBJ。
- USD 预览支持 `.usda`、`.usdc`、`.usdz`；二进制 `.usd` crate 格式暂不支持。

## 许可

代码使用 MIT 许可。**每个机器人模型仍适用其上游自己的许可**（详情页有标注），
其中部分为非商业许可，使用前请自行核对。

元数据来自 [robot_descriptions.py](https://github.com/robot-descriptions/robot_descriptions.py)，
3D 加载基于 [three.js](https://threejs.org/) 与
[urdf-loader](https://github.com/gkjohnson/urdf-loaders)。

---

**English** — A browsable gallery of 192 open robot descriptions: 154 URDF entries
load in the built-in viewer, while MJCF-only entries open as pinned MuJoCo Live scenes.
The gallery groups robots by category and then by maker. The URDF viewer lets you drag
joints — or play every joint in turn out to both its limits and back, a second each —
and overlays collision geometry, joint axes and inertia. A compare page (`#compare=1`)
puts two to six machines of one category side by side as numbers, lining their joints up
by anatomy or by position along the kinematic chain, including the mass of the child link
each joint moves. A mechanism that closes back on
itself — Minitaur's five-bar legs — is held shut by a point weld the registry states the
way MJCF does, so dragging a motor bends the whole linkage instead of pulling the leg
apart. You can open a description from your own disk — URDF, xacro, MuJoCo XML or USD —
in the same viewer, parsed in the browser and never uploaded, and compare it against the
gallery. Every robot downloads in one click as a `.urdf`, a zip of URDF + meshes, or a
ready-to-build ROS 2 package. The pinned MuJoCo Menagerie manifest is deduplicated
against existing URDF cards. No model files are hosted here: entries pin an upstream
repository and commit and stream from jsDelivr. Run it locally with `npm install &&
npm run dev`. Code is MIT; each model keeps its own upstream licence, some non-commercial.
