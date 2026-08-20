# Robot URDF Gallery · 机器人 URDF 合集

[![Verify](https://github.com/ImChong/Robot_URDF_Gallery/actions/workflows/verify.yml/badge.svg)](https://github.com/ImChong/Robot_URDF_Gallery/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在浏览器里加载 **90 个**开源机器人 URDF：拖关节、看碰撞体与惯量，一键下载 URDF、
网格 zip 或可直接 `colcon build` 的 ROS 2 功能包。

在线访问：<https://imchong.github.io/Robot_URDF_Gallery/>

人形 29 · 机械臂 17 · 四足 16 · 灵巧手 10 · 双臂 7 · 移动操作 7 · 双足 4

**本仓库不托管任何模型文件。** 每个条目只记录上游仓库 + 固定 commit，URDF 与网格
访问时从 jsDelivr 的 GitHub CDN 流式加载。

## 本地运行

```bash
npm install   # 仅脚本需要；浏览器依赖已提交在 web/vendor/
npm run dev   # http://localhost:8080/web/
```

纯静态 ES module，没有构建步骤：`web/` 就是可发布的产物。push 到 `main` 后由
`.github/workflows/pages.yml` 发布到 GitHub Pages。

## 数据

手写的只有两个文件：`data/curation.json`（收录哪些机器人）与 `data/visibility.md`
（勾选框决定显示哪些，`[x]` 显示、`[ ]` 隐藏）。其余全部由脚本生成。

```bash
pip install -r scripts/requirements.txt
npm run registry                # 生成 data/robots.json（解析 URDF、校验网格）
npm run thumbs && npm run registry   # 缩略图 + 实测尺寸（顺序不能反）
npm run visibility              # 刷新 data/visibility.md
npm run smoke -- --all          # 冒烟测试：确认真的渲染出了几何体
npm run check:downloads         # 校验下载包
```

新增机器人：在 `data/curation.json` 的 `robots` 里加一条（填 `description` 键，或
`robot_descriptions.py` 没有收录时手写 `upstream`），加上 `category`，然后跑
`registry → thumbs → registry`。用 `npm run candidates` 可以列出所有可加载的候选模型。

## 已知限制

- 暂不支持只提供 xacro 的模型（UR 系列、Shadow Hand、Fetch 等）。
- jsDelivr 单文件上限 20 MB，个别含超大网格的模型（Go1、B1、B2-W）无法收录。

## 许可

代码使用 MIT 许可。**每个机器人模型仍适用其上游自己的许可**（详情页有标注），
其中部分为非商业许可，使用前请自行核对。

元数据来自 [robot_descriptions.py](https://github.com/robot-descriptions/robot_descriptions.py)，
3D 加载基于 [three.js](https://threejs.org/) 与
[urdf-loader](https://github.com/gkjohnson/urdf-loaders)。

---

**English** — A browsable 3D gallery of 90 open robot descriptions (humanoids,
quadrupeds, arms, hands) that loads URDFs in the browser, lets you drag joints, and
overlays collision geometry, joint axes and inertia. No model files are hosted here:
each entry pins an upstream repository and commit, and streams from jsDelivr's GitHub
CDN. Every robot downloads in one click as a `.urdf`, a zip of URDF + meshes, or a
ready-to-build ROS 2 package. Run it locally with `npm install && npm run dev`. Code is
MIT; each model keeps its own upstream licence, some non-commercial.
