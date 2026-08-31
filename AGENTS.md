# AGENTS.md

## 新增或修改 URDF：本地只测当前机型

每次新增或修改一个 URDF（含改 `data/curation.json` 里已有条目的上游、路径或改写规则）时：

- **本地只验证当前这一台**（复用 `.cache/` 里的 HTTP 缓存）。
- **不要**在本地跑全量 `npm run registry`、`npm run smoke -- --all`、`npm run check:downloads`（无 `--robot`）、`npm run check:compare`，以及 `check:custom` / `check:custom-local` / `check:custom-url`。
- 全量重建、漂移对照、全站冒烟、下载包、对比页与自定义预览，一律交给 GitHub Actions 的 `verify.yml`。

一次全量 `registry` 会探测全部网格。某个无关上游短暂 404 时，生成的 `data/robots.json` 会丢掉那些条目；本地用这份文件覆盖提交稿，等于把别人的机型从合集里删掉。

### 本地要做的

1. 在 `data/curation.json` 的 `robots` 里改当前条目（新机型加 `category`）。
2. **只探测这一台**，把结果合并进已提交的 `data/robots.json`，不要用全量重建结果整文件替换。可复用 `.cache/`，或 `python3 scripts/build_registry.py --offline` 只读缓存。需要对照时，把当前 `id` 交给：

   ```bash
   npm run thumbs -- --robot <id>
   npm run smoke -- --robot <id>
   ```

   有多个 `variants` 时，上述命令会覆盖该机型的每一个版本。
3. `npm run thumbs -- --robot <id>` 成功后，把 `data/measured.json` 里该 id（及各 variant id）写回 `data/robots.json` 对应条目的 `measured`。不要为了写回实测再跑一遍全量 `registry`。
4. `npm run visibility` 刷新列表（只改方括号以外的行，勾选状态保留；新 id 默认勾选）。
5. 若新增卡片：同步 `README.md` 里的总数、URDF 数、分类计数。

`node scripts/check_registry.mjs --thumbs` 可以在提交前确认当前 `robots.json` 结构完整、缩略图在。它不联网探测网格。

下载包校验如果也要在本地做，只跑当前机型：`node scripts/check_downloads.mjs --robot <id>`。默认不要跑。

### 交给 GitHub Actions 的

`.github/workflows/verify.yml` 在 PR / `main` 上会：

- 全量 `python3 scripts/build_registry.py` 并与提交的 `robots.json` 做结构对照
- `visibility --check` 与 `check_registry --thumbs`
- 全站 `smoke --all`、下载包、对比页、本地/GitHub 自定义预览

Pages 发布前的 `pages.yml` 只做 `check_registry --thumbs`，不重新探测上游。

## Cursor Cloud specific instructions

Cloud Agent 环境：`npm ci`、`pip install -r scripts/requirements.txt`、Playwright Chromium。站点无构建步骤，`web/` 即产物。

- 本地预览：`npm run dev` → `http://localhost:8080/web/`。
- 改 URDF 时遵守上面的「只测当前机型」：不要在 Cloud Agent 里跑全量 registry / smoke / downloads。CDN 偶发失败会污染 `robots.json`。
- 缩略图与冒烟需要 headless Chromium（SwiftShader）。若未安装：`npx playwright install --with-deps chromium`。
- HTTP 缓存在 `.cache/`（`head.json` 与 `bodies/`），不要提交。
- 不要用 `pkill -f` 杀进程；停服务时用具体 PID。测试用的 dev server 测完保持运行。
