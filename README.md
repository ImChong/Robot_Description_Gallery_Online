# Robot URDF Gallery Online · 机器人 URDF 在线合集

[![Verify](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/verify.yml/badge.svg)](https://github.com/ImChong/Robot_URDF_Gallery_Online/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在浏览器里加载 **99 个**开源机器人 URDF：拖关节、看碰撞体与惯量，一键下载 URDF、
网格 zip 或可直接 `colcon build` 的 ROS 2 功能包。

首页开头还有「预览我自己的 URDF」：把自己的模型目录（或几个文件）交给同一个查看器，
关节滑块、碰撞体、惯量一样能用，**还能拉进横向对比里跟同类机器逐关节比**。
**文件只在浏览器里解析，不会上传到任何服务器** —— 本站是纯静态页面，也没有可以
接收文件的后端。

还有「横向对比」：同一类别下选 2~6 台机器，把它们当成数据并排读。见下文。

在线访问：<https://imchong.github.io/Robot_URDF_Gallery_Online/>

人形 33 · 四足 18 · 机械臂 17 · 灵巧手 23 · 移动操作 9 · 双臂 9 · 双足 4

**本仓库不托管任何模型文件。** 绝大多数条目只记录上游仓库 + 固定 commit，URDF 与网格
访问时从 jsDelivr 的 GitHub CDN 流式加载。少数厂商完全没有公开可加载模型的（或只发布
xacro），条目改为记录转载它的存档站 —— 见下文「镜像条目」。

## 横向对比

`#compare=1` 是合集之外的另一个页面：同一类别下选 2~6 个模型（首页 hero 里的
「横向对比」按钮，或任意详情页右上角的「加入对比」），它们的 URDF 会在浏览器里被
当作数据重新解析一遍 —— **只下载 .urdf，不下载网格**，所以对比六台机器比打开其中
一台还快。三张表：

- **整机对比**：自由度与关节类型、连杆数、URDF 质量、实测高度与包围盒、力矩上限
  合计与峰值、速度峰值、`effort × velocity` 给出的功率上限、力矩密度、总行程、
  腿部/手臂质量占比、肢体长度与站姿宽度、以及「模型完整度」一组 —— 有多少连杆声明了
  质量与惯量、多少关节没写限位、左右镜像关节的限位是否一致。
- **分肢对比**：每条腿/每条臂（灵巧手则是每根手指）的关节数、力矩合计、零位下的
  长度与承载质量。
- **逐关节对比**：每一行是一个关节位置，列出各机器对应关节的限位、最大速度、
  最大力矩或功率上限，限位还会画在一条共享刻度的横条上。一条运动链 —— 一根手指、
  一条臂、一条腿 —— 是从**根关节一路读到末端关节**的：行号写作「根关节 / 第 2 关节
  / …… / 末端关节」，谁的链先到头，就在那一格标上「末端」。

难点在于「哪个关节对哪个关节」：上游把左膝叫 `left_knee_joint`、`LeftKneePitch`、
`l_leg_kny`、`leg_left_4_joint` 或 `FL_calf_joint`，按字符串是对不齐的。所以有两种
对齐方式，页面上可以随时切换：

- **按部位**（`web/js/joint-align.js`）：按「左右 + 部位 + 转轴」归位。部位取自
  名字里的词，转轴优先取名字、名字没写就用关节自己的轴向量，左右同理 —— 名字没写就
  看它挂在身体的哪一半。像 `leg_left_1..6` 这种只有编号的，就按腿的通常构型推断
  （髋 3 个、膝 1 个、踝 2 个），并在格子里标上 `~`。人形/四足/双足/双臂目前基本
  都能 100% 归位。
- **按运动链顺序**：一条链的第 N 个关节，对上另一台机器同一条链的第 N 个关节。
  链与链之间，能认出是什么的就按它是什么配对（左臂对左臂、拇指对拇指），认不出的
  就按声明顺序配对 —— 机械臂用的正是后者，上游本来就只给它们编号
  （`joint_1`…`joint_6`），部位无从谈起，页面会自动选它。

**手指按链读**。一只手的每根手指本身就是一条链，所以两种方式下手都是一根一根手指
读的：拇指、食指、中指、无名指、小指，每根从根关节排到末端关节。这样一来，指节叫
`mcp/pip/dip`、叫 `q1/q2`、叫 `12/13/14` 的三只手仍然能逐关节对上。哪条链是哪根
手指：名字里写了就用名字，没写就看手掌的形状 —— 四根手指的根关节排成一条线，拇指
的不在这条线上，去掉谁能让剩下的最直，谁就是拇指，剩下的沿这条线从离拇指最近的一头
数过去。夹爪那种左右对称、去掉谁都一样的，就不猜了，按顺序叫「手指 1、手指 2」。
Allegro 的 `joint_0`…`joint_15`、Dex5-1 的 `Roll_21R`、Dex2-5 的 `right_31_joint`
都是这样归位的，并在格子里标上 `~`。

无论哪种方式，格子里都会同时显示原始关节名，归不了位的关节列在表格下方，不会被
悄悄丢掉。表格可以复制成 Markdown 或下载 CSV；`#compare=1&cat=humanoid&ids=g1,h1`
这样的地址可以直接分享，`ids` 里用 `g1.g1_23dof` 还能指定具体版本。

**你自己的文件也能当一列。** 用「预览我自己的 URDF」打开的模型，会出现在选择器
最前面（`ids` 里叫 `__local__`），它的详情页右上角也有「加入对比」。它不归任何
类别 —— 想知道它更像什么，往往正是打开它的原因 —— 所以它出现在每个类别下，并按
当前对比的类别去读：放进人形对比里就按人形归位，换成灵巧手就按手指从根关节读到
末端关节，换类别时它会留在选中状态。文件仍然只在这个标签页里：URDF 从选择器已经
做好的 blob 解析，不发一个请求出去，因此**分享出去的链接里不会有这一列**，页面会
在选择器下方直说这一点；刷新之后同样如此，那一列会被安静丢掉而不是报错。

**网格一起给的话，「实测高度」和「包围盒」也会有。** 这两个数没有任何 URDF 写得出来
—— 合集里的是 `npm run thumbs` 在构建时把每台机器渲染一遍量出来的，而你的文件没人
渲染过，所以由预览页在网格加载完之后当场量：同一个零位姿态、同一种读法，因此和旁边
几列直接可比（`check:compare` 里有一条用例，就是把合集里某台机器的网格当成上传文件
交给页面，断言量出来的高度和构建时记下的一致）。只在它引用的网格全都找齐时才量 ——
缺一半网格只能量到半个机器人，那还不如空着。只给一个 `.urdf`、不给网格，这两行就仍然
是「—」。

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
npm run check:compare           # 对比页：关节对齐的不变式 + 页面真的画出来了
```

新增机器人：在 `data/curation.json` 的 `robots` 里加一条（填 `description` 键，或
`robot_descriptions.py` 没有收录时手写 `upstream`），加上 `category`，然后跑
`registry → thumbs → registry`。用 `npm run candidates` 可以列出所有可加载的候选模型。

**同一机型的多个 URDF 不各占一张卡片**：上游常把一台机器发布成一个目录的 URDF
（G1 有 21 个，按 `mode_machine` 与手部配置区分）。这种条目在 `variants` 里逐个列出
文件，合集里仍然只有一张卡，详情页顶部多一个版本选择器 —— 选中的版本决定整页内容，
包括渲染、关节树和三种下载。版本的 id 与标签取自文件名本身，列在最前面的就是卡片和
详情页默认打开的那个；上游把每个版本各放进一个包时（TRON 2 有 16 个，每个文件都叫
`robot.urdf`，每个都写着同一个 `bipedal_robot` 包），版本自己写 `name`、`id` 与
`package`。

**包根是探测出来的**：`package://` 引用的根目录由构建脚本在包目录附近逐个试出来，
绝大多数仓库到此为止。试不出来的时候 —— 包不在这一带、目录改了名但 `package://`
没跟着改、相对路径是按另一个工作目录写的 —— `upstream.packages` 直接写明某个包名对应
仓库里的哪个目录，`upstream.mesh_rewrite` 给出一组 `{from, to}` 替换，作用在解析出来的
路径上。两个键与镜像条目用的是同一套；它们都不凭空造文件：改写后的路径照样要探测，
网格对不上的条目仍然会让构建失败。

### 镜像条目

少数机型的厂商从没公开过本站能加载的模型 —— 没有仓库，或者只发布 xacro —— 而它唯一
公开的 URDF 在一个转载它的存档站上。这种条目写 `mirror` 而不是 `upstream`，填存档站
的名字、页面、基址，以及存档站重新摆放网格后的 `packages` 映射（仓库条目的包路径是
探测出来的，存档站的必须写明）。相比仓库条目有三点不同，都是存档站带来的，不是选择：

- **没有可固定的 commit**，`source.commit` 为 null，详情页改为标注「转载自」哪个站，
  CI 的漂移比对对这些条目无从比较。
- **存在性按 content-type 判定**：单页应用形式的存档站对不存在的路径也返回 200 + 一个
  HTML 页面，光看状态码会把每个网格都当成存在。`Http.probe` 因此发 GET 只读响应头。
- **存档站只保留自己要渲染的网格**，所以条目可能引用一些它没有的文件。这些网格会被
  跳过而不是让构建失败：记进 `assets.skip_meshes` 让查看器和下载器一并跳过，并从条目
  声明里扣除 —— 碰撞网格全缺失的模型会如实报告「没有碰撞体」，而不是给一个空的碰撞
  视图。`assets.mesh_rewrite` 则用来还原被压平的网格目录。

## 已知限制

- 暂不支持只提供 xacro 的模型（UR 系列、Shadow Hand、Fetch 等）；自己上传时也一样，
  请先 `xacro robot.urdf.xacro > robot.urdf` 再选择展开后的文件。少数这类模型通过上面的
  镜像条目收录了展开后的 URDF。
- jsDelivr 单文件上限 20 MB，个别含超大网格的模型（Go1、B1、B2-W）无法收录。
- 镜像条目的 ROS 2 下载包会删掉引用缺失网格的 `<visual>`/`<collision>` 元素，否则
  RViz 根本加载不了；zip 包里的 URDF 保持上游原样，缺口写在 `NOTICE.txt` 里。

## 许可

代码使用 MIT 许可。**每个机器人模型仍适用其上游自己的许可**（详情页有标注），
其中部分为非商业许可，使用前请自行核对。

元数据来自 [robot_descriptions.py](https://github.com/robot-descriptions/robot_descriptions.py)，
3D 加载基于 [three.js](https://threejs.org/) 与
[urdf-loader](https://github.com/gkjohnson/urdf-loaders)。

---

**English** — A browsable 3D gallery of 99 open robot descriptions (humanoids,
quadrupeds, arms, hands) that loads URDFs in the browser, lets you drag joints, and
overlays collision geometry, joint axes and inertia. A compare page (`#compare=1`)
puts two to six machines of one category side by side as numbers — joint limits,
speed and torque limits, mass, height, what the actuators add up to and how complete
the description is — lining their joints up either by anatomy (side, body part and
axis, read from the joint names and from the axis vectors where the names do not say)
or by position along the kinematic chain, whichever suits the selection. A chain — a
finger, an arm, a leg — is read from the joint it starts at to the joint it ends at,
and a hand is read finger by finger: which chain is the thumb comes from the names
where upstream wrote them and from the shape of the palm where it did not, so hands
that number their knuckles differently still line up knuckle for knuckle. Only the
`.urdf` files are fetched for it, never the meshes. A machine upstream publishes as
several URDFs — the Unitree G1 ships 21 — is one card, with a version picker on its
detail page that swaps the whole page between them. No model files are hosted here:
almost every entry pins an upstream repository and commit, and streams from jsDelivr's
GitHub CDN; a handful whose maker published no loadable description stream from an
archive that re-hosts them, which has no revision to pin and may have dropped meshes
the URDF still names — those are skipped, and the entry reports what is left rather
than an empty collision view. Every robot downloads in one click as a `.urdf`, a zip of URDF + meshes, or a
ready-to-build ROS 2 package. Run it locally with `npm install && npm run dev`. Code is
MIT; each model keeps its own upstream licence, some non-commercial. A "Preview your own
URDF" button at the top of the gallery opens the same viewer on a description from your own
disk — parsed in the browser, never uploaded anywhere — and that model can be one of the
compared columns too, read as whichever kind of machine the comparison is of. Hand it the
meshes as well and the stage measures the height and bounding box no URDF declares, the
same way and at the same pose the build measures the gallery's.
