/** Bilingual UI strings. The registry itself stays language-neutral. */

const STRINGS = {
  en: {
    'site.title': 'Robot URDF Gallery',
    'site.tagline': 'Common robot descriptions, in your browser',
    'hero.title': 'Robot URDF Gallery',
    'hero.lede':
      'Browse, inspect and compare open robot descriptions — humanoids, quadrupeds, arms and hands. Every model streams from its upstream repository at a pinned commit; nothing is re-hosted here.',
    'search.placeholder': 'Search robot, maker, category…',
    'stats.robots': 'Robots',
    'stats.makers': 'Makers',
    'stats.joints': 'Moving joints',
    'stats.sources': 'Upstream repos',
    'gallery.empty': 'No robot matches this filter.',
    'filters.all': 'All',
    'detail.back': 'Gallery',
    'panel.specs': 'Specs',
    'panel.joints': 'Joints',
    'panel.resetAll': 'reset all',
    'panel.download': 'Download',
    'dl.bundle': 'URDF + meshes',
    'dl.bundleSub': 'zip, ready to load',
    'dl.urdf': 'URDF only',
    'dl.urdfSub': 'the .urdf file alone',
    'dl.working': 'Preparing…',
    'dl.failed': 'Download failed',
    'theme.toggle': 'Switch theme',
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
  },
  zh: {
    'site.title': '机器人 URDF 画廊',
    'site.tagline': '常用机器人模型，在浏览器里直接看',
    'hero.title': '机器人 URDF 画廊',
    'hero.lede':
      '浏览、查看并对比开源机器人模型——人形、四足、机械臂与灵巧手。每个模型都从上游仓库的固定 commit 直接加载，本站不二次托管任何模型文件。',
    'search.placeholder': '搜索机器人、厂商、类别…',
    'stats.robots': '机器人',
    'stats.makers': '厂商',
    'stats.joints': '可动关节',
    'stats.sources': '上游仓库',
    'gallery.empty': '没有符合条件的机器人。',
    'filters.all': '全部',
    'detail.back': '返回画廊',
    'panel.specs': '参数',
    'panel.joints': '关节',
    'panel.resetAll': '全部复位',
    'panel.download': '下载',
    'dl.bundle': 'URDF + 网格',
    'dl.bundleSub': 'zip，可直接加载',
    'dl.urdf': '仅 URDF',
    'dl.urdfSub': '只有 .urdf 文件',
    'dl.working': '正在准备…',
    'dl.failed': '下载失败',
    'theme.toggle': '切换主题',
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
  },
};

const CATEGORY_LABELS = {
  en: {
    humanoid: 'Humanoid', quadruped: 'Quadruped', arm: 'Arm', hand: 'Hand / Gripper',
    biped: 'Biped', mobile: 'Mobile manipulator', dual_arm: 'Dual arm',
    wheeled: 'Wheeled', drone: 'Drone', educational: 'Educational', end_effector: 'End effector',
  },
  zh: {
    humanoid: '人形', quadruped: '四足', arm: '机械臂', hand: '灵巧手 / 夹爪',
    biped: '双足', mobile: '移动操作', dual_arm: '双臂',
    wheeled: '轮式', drone: '无人机', educational: '教育', end_effector: '末端执行器',
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
}
