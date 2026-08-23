/** Bilingual UI strings. The registry itself stays language-neutral. */

const STRINGS = {
  en: {
    'hero.title': 'Robot URDF Gallery',
    'hero.lede':
      'Browse, inspect and compare open robot descriptions — humanoids, quadrupeds, arms and hands. Every model streams from its upstream repository at a pinned commit; nothing is re-hosted here.',
    'search.placeholder': 'Search robot, maker, category…',
    'stats.robots': 'Robots',
    'stats.makers': 'Makers',
    'stats.categories': 'Categories',
    'stats.repos': 'Upstream repos',
    'gallery.empty': 'No robot matches this filter.',

    // Previewing a URDF off your own disk. Every one of these strings is on a
    // screen whose whole point is that nothing is being uploaded, so the
    // promise is repeated wherever a file is about to be handed over.
    'custom.cta': 'Preview your own URDF',
    'custom.heroNote':
      'Read in your browser — your files never leave this device and are not uploaded to any server.',
    'custom.title': 'Preview your own URDF',
    'custom.privacy':
      'Your files stay on this device. They are parsed in the browser and never uploaded: this site is a static page with no server to send them to.',
    'custom.drop': 'Drop a .urdf here, along with the meshes it references',
    'custom.or': 'or',
    'custom.pickFiles': 'Choose files…',
    'custom.pickFolder': 'Choose a folder…',
    'custom.hint':
      'STL, Collada, OBJ and glTF meshes. Both package:// and relative paths are matched against the files you picked, so the description folder is usually the right thing to hand over.',
    'custom.whichUrdf': 'Description',
    'custom.preview': 'Preview',
    'custom.cancel': 'Cancel',
    'custom.close': 'Close',
    'custom.again': 'Open again:',
    'custom.picked': 'Files picked: {files} · {size}',
    'custom.meshes': 'Referenced meshes found: {found} / {total}',
    'custom.missing': '{n} referenced meshes are not among the files you picked — the model will load without them.',
    'custom.missing1': 'One referenced mesh is not among the files you picked — the model will load without it.',
    'custom.noUrdf': 'No .urdf file among the ones you picked.',
    'custom.badXml': 'This file is not valid XML.',
    'custom.noRobot': 'This file has no <robot> element at its root.',
    'custom.xacro':
      'This is a xacro template rather than a plain URDF. Expand it first — xacro robot.urdf.xacro > robot.urdf — and pick the result.',
    'custom.tooMany': 'More than {n} files: pick the description folder rather than a whole workspace.',
    'custom.readFailed': 'Could not read those files.',
    'custom.localOnly': 'Local file · read in your browser, never uploaded',
    'panel.localFiles': 'Local files',
    'local.urdfFile': 'URDF',
    'local.meshes': 'Meshes',
    'local.picked': 'Picked',
    'local.missing': '{n} referenced meshes were not found',
    'local.missing1': 'One referenced mesh was not found',
    'filters.all': 'All',
    'filters.aria': 'Jump to a category',
    'filters.allTitle': 'Back to the top of the gallery',
    'filters.jump': 'Jump to {label}',
    'detail.back': 'Gallery',
    'panel.specs': 'Specs',
    'panel.resetAll': 'reset all',
    'joints.unit': 'Angle unit',
    'joints.unitDeg': 'Show angles in degrees',
    'joints.unitRad': 'Show angles in radians',
    'panel.tree': 'Joint tree',
    'panel.pose': 'Joint tree & pose',
    'pose.inFullscreen': 'The joint tree and the sliders that move the robot live in fullscreen, where the chain has the height to be read and the render has the room to show what a joint does.',
    'pose.enter': 'Open fullscreen',
    'tree.summary': '{links} links · {joints} joints',
    'tree.expandAll': 'expand all',
    'tree.collapseAll': 'collapse all',
    'tree.hint': 'Hover a row to light that link up on the stage; click to keep it lit. Drag the slider under a joint to move it.',
    'tree.root': 'root',
    'tree.noMesh': 'no geometry of its own',
    'tree.none': 'This description is a single link with no joints.',
    'tree.aria': 'Kinematic tree',
    'jt.revolute': 'revolute',
    'jt.continuous': 'continuous',
    'jt.prismatic': 'prismatic',
    'jt.fixed': 'fixed',
    'jt.floating': 'floating',
    'jt.planar': 'planar',
    'panel.download': 'Download',
    'dl.bundle': 'URDF + meshes',
    'dl.bundleSub': 'zip, ready to load',
    'dl.ros2': 'ROS 2 package',
    'dl.ros2Sub': 'colcon build · RViz + joint sliders',
    'dl.urdf': 'URDF only',
    'dl.urdfSub': 'the .urdf file alone',
    'dl.working': 'Preparing…',
    'dl.failed': 'Download failed',
    'theme.toggle': 'Switch theme',
    'panel.resize': 'Drag to resize · double-click to reset',
    'panel.resizeTree': 'Joint tree panel width',
    'panel.resources': 'Resources',
    'panel.reuse': 'Use this model',
    'panel.copy': 'copy',
    'panel.copied': 'copied',
    'viewer.loading': 'Loading model…',
    'viewer.hint': 'Drag to orbit · scroll to zoom · right-drag to pan',
    'viewer.resetPose': 'Reset pose',
    'viewer.autoRotate': 'Auto rotate',
    'viewer.fitView': 'Fit view',
    'viewer.snapshot': 'Save PNG',
    'viewer.fullscreen': 'Fullscreen',
    'viewer.exitFullscreen': 'Exit fullscreen',
    'viewer.failed': 'Could not load this model',
    'overlay.visual': 'Visual',
    'overlay.collision': 'Collision',
    'overlay.frames': 'Frames',
    'overlay.axes': 'Joint axes',
    'overlay.com': 'CoM',
    'overlay.inertia': 'Inertia',
    'spec.maker': 'Maker',
    'spec.category': 'Category',
    'spec.dof': 'DOF',
    'spec.joints': 'Joints',
    'spec.links': 'Links',
    'spec.mass': 'URDF mass',
    'spec.height': 'Model height',
    'spec.formats': 'Formats',
    'spec.license': 'Licence',
    'spec.assets': 'Mesh assets',
    'spec.commit': 'Pinned commit',
    'spec.tags': 'Tags',
    'res.repo': 'Upstream repository',
    'res.tree': 'Description folder',
    'res.urdf': 'URDF file',
    'res.mjcf': 'MJCF (MuJoCo)',
    'res.license': 'Licence file',
    'res.official': 'Official product page',
    'res.docs': 'Documentation',
    'res.paper': 'Paper',
    'res.descriptions': 'robot_descriptions entry',
    'unit.dof': 'DOF',
    'joints.none': 'This description has no movable joints.',
    'mass.fromUrdf': 'sum of link masses',
    'mass.suspect': 'Implausible value, shown exactly as the upstream URDF declares it.',
    'height.measured': 'measured from meshes',
    'limit.range': 'range',
    'limit.velocity': 'max vel',
    'limit.effort': 'max eff',
    'limit.mimic': 'mimic',
    'limit.rangeFull': 'Travel, from <limit lower/upper>',
    'limit.velocityFull': 'Velocity limit, from <limit velocity>',
    'limit.effortFull': 'Effort limit, from <limit effort>',
    'limit.mimicFull': 'Follows another joint: value = multiplier × source + offset',
    'limit.mimicDriven':
      'Driven by the joint it follows — value = multiplier × source + offset, so it has no slider of its own',
    'limit.continuous': 'continuous',
    'limit.none': 'no <limit> declared',
  },
  zh: {
    'hero.title': '机器人 URDF 合集',
    'hero.lede':
      '浏览、查看并对比开源机器人模型——人形、四足、机械臂与灵巧手。每个模型都从上游仓库的固定 commit 直接加载，本站不二次托管任何模型文件。',
    'search.placeholder': '搜索机器人、厂商、类别…',
    'stats.robots': '机器人',
    'stats.makers': '厂商',
    'stats.categories': '类别',
    'stats.repos': '上游仓库',
    'gallery.empty': '没有符合条件的机器人。',

    'custom.cta': '预览我自己的 URDF',
    'custom.heroNote': '在浏览器里本地解析 —— 文件不会离开这台设备，也不会上传到任何服务器。',
    'custom.title': '预览我自己的 URDF',
    'custom.privacy':
      '文件只留在这台设备上：全部在浏览器里解析，不会上传到任何服务器 —— 本站是纯静态页面，根本没有可以接收文件的后端。',
    'custom.drop': '把 .urdf 和它引用的网格文件拖到这里',
    'custom.or': '或者',
    'custom.pickFiles': '选择文件…',
    'custom.pickFolder': '选择文件夹…',
    'custom.hint':
      '支持 STL、Collada、OBJ 与 glTF 网格。package:// 与相对路径都会在你选中的文件里就近匹配，所以直接把整个模型目录交过来通常最省事。',
    'custom.whichUrdf': '模型文件',
    'custom.preview': '预览',
    'custom.cancel': '取消',
    'custom.close': '关闭',
    'custom.again': '再次打开：',
    'custom.picked': '已选择文件：{files} 个 · {size}',
    'custom.meshes': '引用的网格已找到：{found} / {total}',
    'custom.missing': '有 {n} 个引用到的网格不在你选中的文件里，模型会缺少这些部件。',
    'custom.missing1': '有 1 个引用到的网格不在你选中的文件里，模型会缺少这个部件。',
    'custom.noUrdf': '选中的文件里没有 .urdf 文件。',
    'custom.badXml': '这个文件不是合法的 XML。',
    'custom.noRobot': '这个文件的根节点不是 <robot>。',
    'custom.xacro':
      '这是 xacro 模板，不是展开后的 URDF。请先展开 —— xacro robot.urdf.xacro > robot.urdf —— 再选择生成的文件。',
    'custom.tooMany': '文件超过 {n} 个：请选择模型自己的目录，而不是整个工作空间。',
    'custom.readFailed': '读取这些文件失败。',
    'custom.localOnly': '本地文件 · 在浏览器里解析，未上传',
    'panel.localFiles': '本地文件',
    'local.urdfFile': 'URDF',
    'local.meshes': '网格',
    'local.picked': '已选择',
    'local.missing': '有 {n} 个引用到的网格没有找到',
    'local.missing1': '有 1 个引用到的网格没有找到',
    'filters.all': '全部',
    'filters.aria': '跳转到分区',
    'filters.allTitle': '回到合集顶部',
    'filters.jump': '跳转到{label}分区',
    'detail.back': '返回合集',
    'panel.specs': '参数',
    'panel.resetAll': '全部复位',
    'joints.unit': '角度单位',
    'joints.unitDeg': '以角度（°）显示',
    'joints.unitRad': '以弧度（rad）显示',
    'panel.tree': '关节树',
    'panel.pose': '关节树与姿态',
    'pose.inFullscreen': '关节树和摆姿态的滑块都在全屏预览里 —— 那里有足够的高度看完整条运动链，也有足够的画面看清每个关节的动作。',
    'pose.enter': '进入全屏预览',
    'tree.summary': '{links} 个连杆 · {joints} 个关节',
    'tree.expandAll': '全部展开',
    'tree.collapseAll': '全部收起',
    'tree.hint': '悬停高亮舞台上对应的连杆；点击固定高亮。拖动关节下方的滑块即可摆姿态。',
    'tree.root': '根连杆',
    'tree.noMesh': '本身没有几何体',
    'tree.none': '该模型只有一个连杆，没有关节。',
    'tree.aria': '运动学树',
    'jt.revolute': '旋转',
    'jt.continuous': '连续旋转',
    'jt.prismatic': '平移',
    'jt.fixed': '固定',
    'jt.floating': '浮动',
    'jt.planar': '平面',
    'panel.download': '下载',
    'dl.bundle': 'URDF + 网格',
    'dl.bundleSub': 'zip，可直接加载',
    'dl.ros2': 'ROS 2 功能包',
    'dl.ros2Sub': 'colcon 编译 · RViz + 关节滑块',
    'dl.urdf': '仅 URDF',
    'dl.urdfSub': '只有 .urdf 文件',
    'dl.working': '正在准备…',
    'dl.failed': '下载失败',
    'theme.toggle': '切换主题',
    'panel.resize': '拖动调整宽度 · 双击复位',
    'panel.resizeTree': '关节树面板宽度',
    'panel.resources': '资源链接',
    'panel.reuse': '如何使用',
    'panel.copy': '复制',
    'panel.copied': '已复制',
    'viewer.loading': '正在加载模型…',
    'viewer.hint': '拖拽旋转 · 滚轮缩放 · 右键平移',
    'viewer.resetPose': '姿态复位',
    'viewer.autoRotate': '自动旋转',
    'viewer.fitView': '适应视图',
    'viewer.snapshot': '保存 PNG',
    'viewer.fullscreen': '全屏预览',
    'viewer.exitFullscreen': '退出全屏',
    'viewer.failed': '模型加载失败',
    'overlay.visual': '视觉网格',
    'overlay.collision': '碰撞体',
    'overlay.frames': '连杆坐标系',
    'overlay.axes': '关节轴',
    'overlay.com': '质心',
    'overlay.inertia': '惯量',
    'spec.maker': '厂商',
    'spec.category': '类别',
    'spec.dof': '自由度',
    'spec.joints': '关节',
    'spec.links': '连杆',
    'spec.mass': 'URDF 质量',
    'spec.height': '模型高度',
    'spec.formats': '格式',
    'spec.license': '许可',
    'spec.assets': '网格资源',
    'spec.commit': '固定 commit',
    'spec.tags': '标签',
    'res.repo': '上游仓库',
    'res.tree': '模型目录',
    'res.urdf': 'URDF 文件',
    'res.mjcf': 'MJCF（MuJoCo）',
    'res.license': '许可文件',
    'res.official': '官方产品页',
    'res.docs': '文档',
    'res.paper': '论文',
    'res.descriptions': 'robot_descriptions 条目',
    'unit.dof': '自由度',
    'joints.none': '该模型没有可动关节。',
    'mass.fromUrdf': '连杆质量之和',
    'mass.suspect': '该数值明显有误，此处照上游 URDF 原样显示。',
    'height.measured': '由网格包围盒测得',
    'limit.range': '范围',
    'limit.velocity': '最大速度',
    'limit.effort': '最大力矩',
    'limit.mimic': '跟随',
    'limit.rangeFull': '关节行程，来自 <limit lower/upper>',
    'limit.velocityFull': '速度限制，来自 <limit velocity>',
    'limit.effortFull': '力矩限制，来自 <limit effort>',
    'limit.mimicFull': '跟随另一个关节：数值 = 倍率 × 源关节 + 偏置',
    'limit.mimicDriven': '由所跟随的关节驱动：数值 = 倍率 × 源关节 + 偏置，因此没有自己的滑块',
    'limit.continuous': '连续旋转',
    'limit.none': '未声明 <limit>',
  },
};

const CATEGORY_LABELS = {
  en: {
    humanoid: 'Humanoid', quadruped: 'Quadruped', arm: 'Arm', hand: 'Hand / Gripper',
    biped: 'Biped', mobile: 'Mobile manipulator', dual_arm: 'Dual arm',
    wheeled: 'Wheeled', drone: 'Drone', educational: 'Educational', end_effector: 'End effector',
    custom: 'Your own file',
  },
  zh: {
    humanoid: '人形', quadruped: '四足', arm: '机械臂', hand: '灵巧手 / 夹爪',
    biped: '双足', mobile: '移动操作', dual_arm: '双臂',
    wheeled: '轮式', drone: '无人机', educational: '教育', end_effector: '末端执行器',
    custom: '你自己的文件',
  },
};

export const LANGS = ['zh', 'en'];

let current = 'zh';

export function detectLang() {
  const stored = localStorage.getItem('cl-lang');
  if (stored && LANGS.includes(stored)) return stored;
  const nav = (navigator.languages || [navigator.language || 'en']).join(',');
  return /\bzh\b|zh-/i.test(nav) ? 'zh' : 'en';
}

export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : 'en';
  localStorage.setItem('cl-lang', current);
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  return current;
}

export function lang() {
  return current;
}

export function t(key) {
  return STRINGS[current][key] ?? STRINGS.en[key] ?? key;
}

/** Category label, falling back to the registry's own label for unknown ids. */
export function categoryLabel(id, registryCategories = []) {
  const dict = CATEGORY_LABELS[current] || CATEGORY_LABELS.en;
  if (dict[id]) return dict[id];
  const found = registryCategories.find((c) => c.id === id);
  if (found) return current === 'zh' ? found.label_zh || found.label : found.label;
  return id;
}

/** Swap all `data-i18n*` marked nodes into the active language. */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    // Keep inline markup (links) when the translation has no markup of its own.
    if (el.children.length && el.querySelector('a')) continue;
    el.textContent = t(key);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
}
