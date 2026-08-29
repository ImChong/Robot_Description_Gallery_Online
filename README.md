# Robot URDF Gallery Online · 机器人 URDF 在线合集

[![Pages](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/pages.yml/badge.svg)](https://imchong.github.io/Robot_URDF_Gallery_Online/)
[![Verify](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/verify.yml/badge.svg)](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在浏览器里加载 **130 个**开源机器人 URDF：拖关节、看碰撞体与惯量，一键下载 URDF、
网格 zip 或可直接 `colcon build` 的 ROS 2 功能包。

在线访问：<https://imchong.github.io/Robot_URDF_Gallery_Online/>

人形 40 · 四足 18 · 机械臂 17 · 灵巧手 23 · 移动操作 12 · 双臂 11 · 双足 9

## 功能

- **查看**：关节滑块、碰撞体、关节轴、惯量。全屏里的关节浮窗默认占画面宽度的三分之一，
  可以拖边框调整；点「演示」就按运动链顺序逐个把关节滑到上下限再放回原位，每个约
  1 秒。上游把一台机器发布成多个 URDF 时（G1 有 21 个）仍然只占一张卡，详情页顶部用
  版本选择器切换。
- **横向对比**（`#compare=1`）：同一类别下选 2~6 台机器并排读整机、分肢与逐关节数据，
  关节按部位或按运动链顺序对齐。只下载 `.urdf`，不下载网格；表格可复制为 Markdown 或
  CSV，地址可分享。
- **预览我自己的 URDF**：本地模型用同一个查看器打开，也能当成对比里的一列。
  **文件只在浏览器里解析，不会上传** —— 本站是纯静态页面，没有可以接收文件的后端。
- **下载**：`.urdf`、URDF + 网格 zip、ROS 2 功能包。

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

手写的只有两个文件：`data/curation.json`（收录哪些机器人）与 `data/visibility.md`
（`[x]` 显示、`[ ]` 隐藏）。其余全部由脚本生成。

```bash
pip install -r scripts/requirements.txt
npm run registry                     # 生成 data/robots.json
npm run thumbs && npm run registry   # 缩略图 + 实测尺寸（顺序不能反）
npm run visibility                   # 刷新 data/visibility.md
npm run smoke -- --all               # 冒烟测试
npm run check:downloads              # 校验下载包
npm run check:compare                # 校验对比页
```

新增机器人：在 `data/curation.json` 的 `robots` 里加一条并写上 `category`，然后跑
`registry → thumbs → registry`。`npm run candidates` 可以列出所有可加载的候选模型。

## 已知限制

- 暂不支持只提供 xacro 的模型（UR 系列、Shadow Hand、Fetch 等）；自己上传时请先
  `xacro robot.urdf.xacro > robot.urdf`。
- jsDelivr 单文件上限 20 MB，个别含超大网格的模型无法收录（Go1、B1、B2-W、PM01）。

## 许可

代码使用 MIT 许可。**每个机器人模型仍适用其上游自己的许可**（详情页有标注），
其中部分为非商业许可，使用前请自行核对。

元数据来自 [robot_descriptions.py](https://github.com/robot-descriptions/robot_descriptions.py)，
3D 加载基于 [three.js](https://threejs.org/) 与
[urdf-loader](https://github.com/gkjohnson/urdf-loaders)。

---

**English** — A browsable 3D gallery of 130 open robot descriptions (humanoids,
quadrupeds, arms, hands) that loads URDFs in the browser, lets you drag joints — or
play every joint in turn out to both its limits and back, a second each — and
overlays collision geometry, joint axes and inertia. A compare page (`#compare=1`) puts
two to six machines of one category side by side as numbers, lining their joints up by
anatomy or by position along the kinematic chain. You can open a description from your
own disk in the same viewer — parsed in the browser, never uploaded — and compare it
against the gallery. Every robot downloads in one click as a `.urdf`, a zip of URDF +
meshes, or a ready-to-build ROS 2 package. No model files are hosted here: entries pin
an upstream repository and commit and stream from jsDelivr. Run it locally with
`npm install && npm run dev`. Code is MIT; each model keeps its own upstream licence,
some non-commercial.
